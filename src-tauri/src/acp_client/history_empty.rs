//! A current official count can distinguish an empty conversation from omitted
//! replay. It is a read on the original connection, never a persisted history.
use super::{operations::Operation, pump::SessionOps};
use agent_client_protocol::{Agent, ConnectionTo};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const METHOD: &str = "_goose/unstable/session/info";
const BUDGET: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
pub(crate) struct Evidence(Arc<AtomicBool>);
impl Evidence {
    pub(crate) fn observe(&self, value: &Value) {
        let contradictory = if let Some(update) = value.get("update") {
            let metadata = matches!(
                update.get("sessionUpdate").and_then(Value::as_str),
                Some("config_option_update" | "current_mode_update" | "available_commands_update")
            ) || (update["sessionUpdate"] == "usage_update"
                && super::live_status::session_usage::standard(update));
            !metadata
        } else {
            matches!(
                value.get("kind").and_then(Value::as_str),
                Some(
                    "notification"
                        | "permissionRequest"
                        | "elicitation"
                        | "elicitationUnavailable"
                        | "turnEnd"
                        | "connectionLost"
                )
            ) && !(value["kind"] == "notification"
                && value.pointer("/presentation/kind").and_then(Value::as_str)
                    == Some("sessionUsage"))
        };
        if contradictory {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    pub(crate) fn eligible(&self) -> bool {
        !self.0.load(Ordering::SeqCst)
    }
}

fn confirmed(value: &Value, id: &str, cwd: &Path) -> bool {
    let Some(session) = value.get("session").and_then(Value::as_object) else {
        return false;
    };
    session.get("sessionId").and_then(Value::as_str) == Some(id)
        && session.get("cwd").and_then(Value::as_str) == cwd.to_str()
        && session
            .get("_meta")
            .and_then(|v| v.get("messageCount"))
            .and_then(Value::as_u64)
            == Some(0)
}

pub(crate) async fn read(
    cx: &ConnectionTo<Agent>,
    ops: &SessionOps,
    operation: &Operation,
    id: &str,
    cwd: &Path,
) -> bool {
    // This existing gate denotes the reviewed official Goose launch shape;
    // it is never inferred from response metadata, version or binary identity.
    if !ops.live_status_enabled || !operation.interested() {
        return false;
    }
    let Ok(lease) = ops.life.operation(format!("history-info:{id}")) else {
        return false;
    };
    let Ok((wire, witnessed)) = ops
        .session_tools
        .send_raw(cx, METHOD, json!({"sessionId":id}))
    else {
        return false;
    };
    let life = ops.life.clone();
    let availability = ops.session_tools.clone();
    let operation = operation.clone();
    let (id, cwd) = (id.to_owned(), cwd.to_path_buf());
    let (send, receive) = tokio::sync::oneshot::channel();
    super::manager::runtime().spawn(async move {
        let reply = super::operations::until_owner_ended(&life, wire).await;
        let matched = witnessed.load(Ordering::SeqCst);
        let empty = matched
            && operation.interested()
            && life.state.load(Ordering::SeqCst) == super::lifecycle::READY
            && matches!(reply, Some(Ok(ref value)) if confirmed(value, &id, &cwd));
        let _ = send.send(empty);
        // Local EOF/decoding is not a matched official reply. Retain the one
        // read owner to real process end; a UI deadline never repeats it.
        if !matched && !life.finished() {
            life.terminated().await;
        }
        availability.clear(&witnessed);
        drop(lease);
    });
    tokio::time::timeout(BUDGET, receive)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(false)
}
