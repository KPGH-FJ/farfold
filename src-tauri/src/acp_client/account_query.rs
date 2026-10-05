//! Read-only official account supplements. Never use authenticate as a query,
//! expose a raw result, or confuse local credentials with service entitlement.
use agent_client_protocol::{Agent, ConnectionTo, UntypedMessage};
use serde_json::{Value, json};
use std::time::Duration;

use super::account_status::{AccountIdentity, AccountKind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccountQuery {
    Kimchi,
    Vibe,
    CodeBuddy,
}

impl AccountQuery {
    pub(crate) fn declared(handshake: &Value, supplement: Option<Self>) -> Option<Self> {
        // A declared push owns its own ordering; don't replace it with a query.
        if super::account_status::accepts(handshake, "_auth/status_update") {
            return None;
        }
        if handshake
            .pointer("/agentCapabilities/_meta/kimchi.dev/auth_status")
            .and_then(Value::as_bool)
            == Some(true)
        {
            return Some(Self::Kimchi);
        }
        supplement
    }

    pub(crate) fn method(self) -> &'static str {
        match self {
            Self::Kimchi => "_kimchi.dev/auth_status",
            // Python ACP 0.11 adds '_' to an extension handler's method name.
            Self::Vibe => "_auth/status",
            Self::CodeBuddy => "_codebuddy.ai/getUserInfo",
        }
    }

    pub(crate) fn parse(self, reply: &Value) -> Option<AccountIdentity> {
        if serde_json::to_vec(reply).ok()?.len() > 16 * 1024 {
            return None;
        }
        let local = |present| {
            AccountIdentity::kind(if present {
                AccountKind::Credential
            } else {
                AccountKind::MissingCredential
            })
        };
        match self {
            Self::Kimchi => Some(local(reply.get("authenticated")?.as_bool()?)),
            Self::Vibe => {
                let authenticated = reply.get("authenticated")?.as_bool()?;
                match reply.get("authState")?.as_str()? {
                    "auth_not_required" if authenticated => {
                        Some(AccountIdentity::kind(AccountKind::NotRequired))
                    }
                    "signed_out"
                        if !authenticated
                            && reply.get("signOutAvailable").and_then(Value::as_bool)
                                != Some(true) =>
                    {
                        Some(local(false))
                    }
                    "os_keyring"
                    | "vibe_home_env_file"
                    | "process_env"
                    | "unsupported_provider"
                        if authenticated =>
                    {
                        let mut identity = local(true);
                        identity.logout_available =
                            matches!(
                                reply.get("authState").and_then(Value::as_str),
                                Some("os_keyring" | "vibe_home_env_file")
                            ) && reply.get("signOutAvailable").and_then(Value::as_bool)
                                == Some(true);
                        Some(identity)
                    }
                    _ => None,
                }
            }
            Self::CodeBuddy => {
                let object = reply.as_object()?;
                let Some(user) = object.get("userInfo").filter(|v| !v.is_null()) else {
                    return Some(local(false));
                };
                let user = user.as_object()?;
                let display_name = ["userNickname", "userName", "userId"]
                    .iter()
                    .filter_map(|field| user.get(*field).and_then(Value::as_str))
                    .find(|value| {
                        !value.trim().is_empty()
                            && value.len() <= 256
                            && !value.chars().any(char::is_control)
                    })
                    .map(str::to_owned);
                let mut identity = local(true);
                identity.display_name = display_name;
                // userInfo contains token/accessToken. Only the typed whitelist
                // above leaves this function; enterprise and other extras don't.
                Some(identity)
            }
        }
    }

    pub(crate) async fn read(self, cx: &ConnectionTo<Agent>) -> Option<AccountIdentity> {
        let request = UntypedMessage::new(self.method(), json!({})).ok()?;
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            cx.send_request_to(Agent, request).block_task(),
        )
        .await
        .ok()?
        .ok()?;
        self.parse(&result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declaration_is_exact_and_push_prevents_query_override() {
        let h = json!({"agentCapabilities":{"_meta":{"kimchi.dev":{"auth_status":true}}}});
        assert_eq!(AccountQuery::declared(&h, None), Some(AccountQuery::Kimchi));
        for declaration in [json!("true"), json!({}), Value::Null] {
            let h =
                json!({"agentCapabilities":{"_meta":{"kimchi.dev":{"auth_status":declaration}}}});
            assert_eq!(AccountQuery::declared(&h, None), None);
        }
        assert_eq!(
            AccountQuery::declared(
                &json!({"agentCapabilities":{"_meta":{"authStatus":{}}}}),
                Some(AccountQuery::CodeBuddy)
            ),
            None
        );
    }

    #[test]
    fn credential_presence_is_distinct_from_verified_login() {
        for present in [false, true] {
            let identity = AccountQuery::Kimchi
                .parse(&json!({"authenticated":present,"token":"fixture-secret"}))
                .unwrap();
            assert_eq!(
                identity.kind,
                if present {
                    AccountKind::Credential
                } else {
                    AccountKind::MissingCredential
                }
            );
            assert_eq!(identity.email, None);
        }
        assert!(
            AccountQuery::Kimchi
                .parse(&json!({"authenticated":"true"}))
                .is_none()
        );
    }

    #[test]
    fn unknown_or_contradictory_vibe_state_is_unknown() {
        for state in ["future", "signed_out", "os_keyring"] {
            let valid = state == "os_keyring";
            assert_eq!(
                AccountQuery::Vibe
                    .parse(&json!({"authenticated":true,"authState":state}))
                    .is_some(),
                valid
            );
        }
        assert_eq!(
            AccountQuery::Vibe
                .parse(&json!({"authenticated":true,"authState":"auth_not_required"}))
                .unwrap()
                .kind,
            AccountKind::NotRequired
        );
        assert!(
            AccountQuery::Vibe
                .parse(&json!({"authenticated":false,"authState":"process_env"}))
                .is_none()
        );
    }

    #[test]
    fn vibe_logout_permission_requires_exact_owned_source_and_boolean_opt_in() {
        for state in [
            "os_keyring",
            "vibe_home_env_file",
            "process_env",
            "unsupported_provider",
            "auth_not_required",
        ] {
            for available in [json!(true), json!(false), json!("true"), Value::Null] {
                let identity = AccountQuery::Vibe.parse(&json!({"authenticated":true,"authState":state,"signOutAvailable":available})).unwrap();
                assert_eq!(
                    identity.logout_available,
                    matches!(state, "os_keyring" | "vibe_home_env_file") && available == true
                );
                assert!(
                    serde_json::to_value(identity)
                        .unwrap()
                        .get("logoutAvailable")
                        .is_none()
                );
            }
        }
        assert!(
            AccountQuery::Vibe
                .parse(
                    &json!({"authenticated":false,"authState":"signed_out","signOutAvailable":true})
                )
                .is_none()
        );
    }

    #[test]
    fn codebuddy_secrets_and_arbitrary_fields_never_leave_parser() {
        let reply = json!({"userInfo":{"userName":"user@example.test","token":"fixture-secret","accessToken":"fixture-secret","enterprise":"fixture-secret"},"token":"fixture-secret"});
        let safe = serde_json::to_value(AccountQuery::CodeBuddy.parse(&reply).unwrap()).unwrap();
        assert_eq!(
            safe,
            json!({"kind":"credential","displayName":"user@example.test"})
        );
        assert_eq!(
            AccountQuery::CodeBuddy.parse(&json!({})).unwrap().kind,
            AccountKind::MissingCredential
        );
        assert!(
            AccountQuery::CodeBuddy
                .parse(&json!({"userInfo":"fixture-secret"}))
                .is_none()
        );
        assert!(
            AccountQuery::CodeBuddy
                .parse(&json!({"userInfo":{},"data":"x".repeat(17000)}))
                .is_none()
        );
    }
}
