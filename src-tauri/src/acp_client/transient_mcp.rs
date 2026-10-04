//! An in-memory MCP offer owned by one session opening and its live route.
//!
//! This owns no page grant and stores no configuration. The browser owner is
//! responsible for the final output gate and for reporting asynchronous stop
//! completion separately. A connected MCP tool is not permission to read a page.
use agent_client_protocol::schema::v1::{McpServer, McpServerStdio};
use std::fmt;
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// Why this exact route did not receive Farfold's temporary browser tool.
/// This is short-lived route metadata, never a persisted approval/config record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpUnavailable {
    SourceNotReviewed,
    UnsafeLogging,
    LaunchUnconfirmed,
    InlineMcpConflict,
    PreparationFailed,
    NotEnabledForConversation,
}

impl McpUnavailable {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::SourceNotReviewed => "source_not_reviewed",
            Self::UnsafeLogging => "unsafe_logging",
            Self::LaunchUnconfirmed => "launch_unconfirmed",
            Self::InlineMcpConflict => "inline_mcp_conflict",
            Self::PreparationFailed => "preparation_failed",
            Self::NotEnabledForConversation => "not_enabled_for_conversation",
        }
    }
}

pub(crate) fn launch_rejection(
    launch: Option<super::browser_capability::LaunchKind>,
    facts: Option<super::process::McpSpawnFacts>,
) -> Option<McpUnavailable> {
    use super::browser_capability::LaunchKind;
    let Some(launch) = launch else {
        return Some(McpUnavailable::SourceNotReviewed);
    };
    // APP_SERVER_LOGS and CODEX_CONFIG are reviewed Node behaviors.
    // The already supported binary keeps its existing provenance boundary.
    if matches!(launch, LaunchKind::Binary) {
        return None;
    }
    let Some(facts) = facts else {
        return Some(McpUnavailable::LaunchUnconfirmed);
    };
    if !facts.logs_safe {
        return Some(McpUnavailable::UnsafeLogging);
    }
    match facts.inline_mcp_safe {
        Some(true) => {}
        Some(false) => return Some(McpUnavailable::InlineMcpConflict),
        None => return Some(McpUnavailable::LaunchUnconfirmed),
    }
    None
}

/// Implementations must not block, acquire ACP route locks, or wait for cleanup.
/// `revoke` synchronously closes further page observation/admission and schedules
/// final output shutdown. Returning does NOT acknowledge the helper stdout barrier.
pub(crate) trait SessionMcpOwner: Send + Sync {
    /// Bind the actual returned ID in memory. This must not grant page access.
    fn bind_session(&self, native_session_id: &str) -> Result<(), String>;
    fn revoke(&self);
}

struct OwnerState {
    owner: Arc<dyn SessionMcpOwner>,
    revoked: AtomicBool,
}

impl OwnerState {
    fn revoke(&self) {
        if !self.revoked.swap(true, Ordering::AcqRel) {
            self.owner.revoke();
        }
    }
}

/// One-shot opening extension. Never derive Debug, Clone, Serialize or Deserialize:
/// the standard MCP env may carry a short-lived permission credential.
pub(crate) struct TransientMcpOpen {
    server: Box<McpServerStdio>,
    state: Arc<OwnerState>,
    attached: bool,
    opening_armed: bool,
}

impl fmt::Debug for TransientMcpOpen {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TransientMcpOpen([redacted])")
    }
}

impl TransientMcpOpen {
    pub(crate) fn new(server: McpServerStdio, owner: Arc<dyn SessionMcpOwner>) -> Self {
        Self {
            server: Box::new(server),
            state: Arc::new(OwnerState {
                owner,
                revoked: AtomicBool::new(false),
            }),
            attached: false,
            opening_armed: true,
        }
    }

    /// Only the protocol-request builder consumes this ephemeral representation.
    pub(crate) fn servers(&self) -> Vec<McpServer> {
        vec![McpServer::Stdio((*self.server).clone())]
    }

    pub(crate) fn bind_route(&mut self, session_id: &str) -> Result<SessionMcpLease, String> {
        if self.attached || session_id.is_empty() || self.state.revoked.load(Ordering::Acquire) {
            return Err(safe_open_error());
        }
        self.state
            .owner
            .bind_session(session_id)
            .map_err(|_| safe_open_error())?;
        self.attached = true;
        Ok(SessionMcpLease {
            state: self.state.clone(),
        })
    }

    /// Opening is now owned by the registered route/OpenDelivery. A cancelled
    /// readiness future never reaches here, so its still-armed guard revokes.
    pub(crate) fn finish_opening(mut self) {
        if self.attached {
            self.opening_armed = false;
        }
    }
}

impl Drop for TransientMcpOpen {
    fn drop(&mut self) {
        if self.opening_armed {
            self.state.revoke();
        }
    }
}

/// Lives in SessionEntry. Removing/dropping/abandoning that exact route revokes
/// even if another reference to the backend owner survives elsewhere.
pub(crate) struct SessionMcpLease {
    state: Arc<OwnerState>,
}

impl fmt::Debug for SessionMcpLease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SessionMcpLease([redacted])")
    }
}

impl Drop for SessionMcpLease {
    fn drop(&mut self) {
        self.state.revoke();
    }
}

pub(crate) fn safe_open_error() -> String {
    "暂时无法连接网页工具，请重试".to_string()
}

/// Keep the existing raw request/response path while validating the added
/// transport shape through the official protocol type, not hand-written JSON.
pub(crate) fn session_params(
    cwd: &Path,
    native_session_id: Option<&str>,
    mcp: Option<&TransientMcpOpen>,
) -> serde_json::Value {
    let servers = mcp.map(TransientMcpOpen::servers).unwrap_or_default();
    let mut params = serde_json::json!({"cwd": cwd, "mcpServers": servers});
    if let Some(session_id) = native_session_id {
        params["sessionId"] = serde_json::Value::String(session_id.into());
    }
    params
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::EnvVariable;
    use std::sync::{Mutex, atomic::AtomicUsize};

    const FAKE_SECRET: &str = "synthetic-capability-only-for-this-test";

    #[derive(Default)]
    struct Witness {
        sessions: Mutex<Vec<String>>,
        revokes: AtomicUsize,
        fail_bind: AtomicBool,
    }
    impl SessionMcpOwner for Witness {
        fn bind_session(&self, id: &str) -> Result<(), String> {
            if self.fail_bind.load(Ordering::Acquire) {
                return Err(FAKE_SECRET.to_string());
            }
            self.sessions.lock().unwrap().push(id.into());
            Ok(())
        }
        fn revoke(&self) {
            self.revokes.fetch_add(1, Ordering::AcqRel);
        }
    }
    fn offer(witness: Arc<Witness>) -> TransientMcpOpen {
        TransientMcpOpen::new(
            McpServerStdio::new("farfold-browser", "/controlled/bridge")
                .args(vec!["--stdio".into()])
                .env(vec![EnvVariable::new("FARFOLD_TEST_CAP", FAKE_SECRET)]),
            witness,
        )
    }
    #[test]
    fn typed_stdio_serializes_only_standard_request_fields() {
        let owner = Arc::new(Witness::default());
        let open = offer(owner);
        let value = serde_json::to_value(open.servers()).unwrap();
        assert_eq!(
            value,
            serde_json::json!([{
                "name":"farfold-browser", "command":"/controlled/bridge",
                "args":["--stdio"], "env":[{"name":"FARFOLD_TEST_CAP", "value":FAKE_SECRET}]
            }])
        );
        assert!(!format!("{open:?}").contains(FAKE_SECRET));
        assert!(!format!("{open:?}").contains("/controlled/bridge"));
    }
    #[test]
    fn queued_request_drop_revokes_without_a_route() {
        let owner = Arc::new(Witness::default());
        drop(offer(owner.clone()));
        assert_eq!(owner.revokes.load(Ordering::Acquire), 1);
        assert!(owner.sessions.lock().unwrap().is_empty());
    }
    #[test]
    fn success_keeps_owner_until_exact_route_drops() {
        let owner = Arc::new(Witness::default());
        let mut open = offer(owner.clone());
        let route = open.bind_route("actual-session").unwrap();
        open.finish_opening();
        assert_eq!(owner.revokes.load(Ordering::Acquire), 0);
        assert_eq!(*owner.sessions.lock().unwrap(), ["actual-session"]);
        drop(route);
        assert_eq!(owner.revokes.load(Ordering::Acquire), 1);
    }
    #[test]
    fn cancelled_readiness_revokes_even_while_route_still_exists() {
        let owner = Arc::new(Witness::default());
        let mut open = offer(owner.clone());
        let route = open.bind_route("opening-session").unwrap();
        drop(open);
        assert_eq!(owner.revokes.load(Ordering::Acquire), 1);
        drop(route);
        assert_eq!(owner.revokes.load(Ordering::Acquire), 1);
    }
    #[test]
    fn route_destruction_during_opening_revokes_once() {
        let owner = Arc::new(Witness::default());
        let mut open = offer(owner.clone());
        let route = open.bind_route("session").unwrap();
        drop(route);
        drop(open);
        assert_eq!(owner.revokes.load(Ordering::Acquire), 1);
    }
    #[test]
    fn failed_bind_redacts_owner_error_and_revokes_on_open_drop() {
        let owner = Arc::new(Witness::default());
        owner.fail_bind.store(true, Ordering::Release);
        let mut open = offer(owner.clone());
        assert_eq!(open.bind_route("session").unwrap_err(), safe_open_error());
        drop(open);
        assert_eq!(owner.revokes.load(Ordering::Acquire), 1);
    }
    #[test]
    fn one_offer_cannot_bind_two_session_routes() {
        let owner = Arc::new(Witness::default());
        let mut open = offer(owner.clone());
        let route = open.bind_route("one").unwrap();
        assert!(open.bind_route("two").is_err());
        open.finish_opening();
        drop(route);
        assert_eq!(*owner.sessions.lock().unwrap(), ["one"]);
        assert_eq!(owner.revokes.load(Ordering::Acquire), 1);
    }
    #[test]
    fn two_sessions_do_not_release_each_others_owner() {
        let a = Arc::new(Witness::default());
        let b = Arc::new(Witness::default());
        let mut one = offer(a.clone());
        let mut two = offer(b.clone());
        let one_route = one.bind_route("one").unwrap();
        let two_route = two.bind_route("two").unwrap();
        one.finish_opening();
        two.finish_opening();
        drop(one_route);
        assert_eq!(a.revokes.load(Ordering::Acquire), 1);
        assert_eq!(b.revokes.load(Ordering::Acquire), 0);
        drop(two_route);
        assert_eq!(b.revokes.load(Ordering::Acquire), 1);
    }

    #[test]
    fn ordinary_new_and_load_keep_empty_mcp_list() {
        assert_eq!(
            session_params(Path::new("/fixture"), None, None),
            serde_json::json!({"cwd":"/fixture", "mcpServers":[]})
        );
        assert_eq!(
            session_params(Path::new("/fixture"), Some("existing"), None),
            serde_json::json!({"cwd":"/fixture", "sessionId":"existing", "mcpServers":[]})
        );
    }

    #[test]
    fn explicit_new_and_load_use_same_typed_transport_without_persisted_config() {
        let owner = Arc::new(Witness::default());
        let open = offer(owner.clone());
        let new = session_params(Path::new("/fixture"), None, Some(&open));
        let load = session_params(Path::new("/fixture"), Some("original"), Some(&open));
        assert_eq!(new["mcpServers"], load["mcpServers"]);
        assert!(new.get("sessionId").is_none());
        assert_eq!(load["sessionId"], "original");
        assert_eq!(new["mcpServers"][0]["env"][0]["value"], FAKE_SECRET);
        assert!(owner.sessions.lock().unwrap().is_empty());
        assert_eq!(owner.revokes.load(Ordering::Acquire), 0);
    }
}
