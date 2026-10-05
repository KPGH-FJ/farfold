//! Agent-reported identity, kept only for this live connection. Never a login
//! response, request entitlement check, credential cache or diagnostic payload.
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    Account,
    ApiKey,
    Gateway,
    External,
    None,
    Credential,
    MissingCredential,
    NotRequired,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    /// Local execution permission from a reviewed status query, not identity.
    /// Never persisted or serialized; auth_methods exposes the generic action.
    #[serde(skip)]
    pub(crate) logout_available: bool,
    pub(crate) kind: AccountKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) display_name: Option<String>,
}

impl AccountIdentity {
    pub(crate) fn kind(kind: AccountKind) -> Self {
        Self {
            logout_available: false,
            kind,
            email: None,
            plan: None,
            display_name: None,
        }
    }
}

/// The capability is a declaration, not an identity. Unknown notifications and
/// undeclared payloads cannot establish an account for this connection.
pub(crate) fn accepts(handshake: &Value, method: &str) -> bool {
    method == "_auth/status_update"
        && handshake
            .pointer("/agentCapabilities/_meta/authStatus")
            .is_some_and(Value::is_object)
}

#[cfg(test)]
pub(crate) fn observe(handshake: &Value, method: &str, params: &Value) -> Option<AccountIdentity> {
    if !accepts(handshake, method) {
        return None;
    }
    parse(params)
}

pub(crate) fn parse(params: &Value) -> Option<AccountIdentity> {
    let status = params.get("authStatus")?.as_object()?;
    let kind = match status.get("kind")?.as_str()? {
        "account" => AccountKind::Account,
        "api_key" => AccountKind::ApiKey,
        "gateway" => AccountKind::Gateway,
        "external" => AccountKind::External,
        "none" => AccountKind::None,
        _ => return None,
    };
    // Display only bounded identity fields with explicit syntax. Arbitrary
    // label/detail/vendor, tokens and future extras are deliberately discarded.
    let account = (kind == AccountKind::Account)
        .then(|| status.get("account").and_then(Value::as_object))
        .flatten();
    let email = account
        .and_then(|a| a.get("email"))
        .and_then(Value::as_str)
        .filter(|s| {
            s.len() <= 254
                && s.matches('@').count() == 1
                && !s.starts_with('@')
                && !s.ends_with('@')
                && !s.chars().any(|c| c.is_control() || c.is_whitespace())
        })
        .map(str::to_owned);
    let plan = account
        .and_then(|a| a.get("plan"))
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b' '))
        })
        .map(str::to_owned);
    Some(AccountIdentity {
        logout_available: false,
        kind,
        email,
        plan,
        display_name: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn declared() -> Value {
        json!({"agentCapabilities":{"_meta":{"authStatus":{}}}})
    }

    #[test]
    fn declaration_and_method_must_match() {
        let params =
            json!({"authStatus":{"kind":"account","account":{"email":"user@example.test"}}});
        assert!(observe(&json!({}), "_auth/status_update", &params).is_none());
        assert!(observe(&declared(), "auth_status", &params).is_none());
        assert!(
            observe(
                &declared(),
                "_auth/status_update",
                &json!({"authStatus":{"kind":"future"}})
            )
            .is_none()
        );
    }
    #[test]
    fn discards_secret_and_arbitrary_fields() {
        let params = json!({"authStatus":{"kind":"account","label":"fixture-secret", "detail":"fixture-secret", "token":"fixture-secret", "vendor":{"secret":"fixture-secret"},"account":{"email":"user@example.test","plan":"pro","organization":"fixture-secret","token":"fixture-secret"}}});
        let identity = observe(&declared(), "_auth/status_update", &params).unwrap();
        assert_eq!(
            serde_json::to_value(identity).unwrap(),
            json!({"kind":"account","email":"user@example.test","plan":"pro"})
        );
    }
    #[test]
    fn non_account_status_never_keeps_previous_identity() {
        for kind in ["none", "api_key", "gateway", "external"] {
            let params = json!({"authStatus":{"kind":kind,"account":{"email":"old@example.test","plan":"pro"}}});
            assert_eq!(
                serde_json::to_value(observe(&declared(), "_auth/status_update", &params).unwrap())
                    .unwrap(),
                json!({"kind":kind})
            );
        }
    }
    #[test]
    fn invalid_identity_fields_are_not_forwarded() {
        let params = json!({"authStatus":{"kind":"account","account":{"email":"user@example.test\nsecret","plan":"<script>"}}});
        assert_eq!(
            serde_json::to_value(observe(&declared(), "_auth/status_update", &params).unwrap())
                .unwrap(),
            json!({"kind":"account"})
        );
    }
}
