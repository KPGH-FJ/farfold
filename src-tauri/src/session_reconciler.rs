use serde::Serialize;
use serde_json::Value;
use std::{sync::atomic::Ordering, time::Duration};
use tauri::State;

use crate::{
    live_session_projection::LiveSessionProjection,
    opencode_protocol,
    opencode_runtime::{self, OpenCodeRuntime},
    pi_runtime::{PiCommand, PiRuntime, correlated_request, next_request_id, running_generation},
    runtime_registry::{ManagedRuntimeDefinition, OPENCODE_RUNTIME, PI_RUNTIME, RuntimeIdentity},
};

const PI_RECONCILIATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReconciliationSnapshot {
    runtime: RuntimeIdentity,
    runtime_build_id: &'static str,
    connection_id: &'static str,
    runtime_generation: u64,
    native_session_id: String,
    message_count: usize,
    activity: &'static str,
    confidence: &'static str,
    evidence: Vec<&'static str>,
}

struct PiOfficialSnapshot {
    session_id: String,
    message_count: usize,
    is_streaming: bool,
}

fn response_data<'a>(response: &'a Value, command: &str) -> Result<&'a Value, String> {
    response
        .get("data")
        .ok_or_else(|| format!("Pi RPC {command} response omitted data"))
}

fn pi_session_id(state: &Value) -> Result<&str, String> {
    let session_id = state
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
        .ok_or_else(|| "Pi get_state returned an invalid native Session ID".to_string())?;
    Ok(session_id)
}

fn validated_pi_snapshot(
    before_response: &Value,
    messages_response: &Value,
    after_response: &Value,
) -> Result<PiOfficialSnapshot, String> {
    let before = response_data(before_response, "get_state")?;
    let messages = response_data(messages_response, "get_messages")?
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Pi get_messages response omitted the messages array".to_string())?;
    let after = response_data(after_response, "get_state")?;
    let before_session_id = pi_session_id(before)?;
    let after_session_id = pi_session_id(after)?;
    if before_session_id != after_session_id {
        return Err("Pi changed native Session during reconciliation".to_string());
    }
    let reported_count = after
        .get("messageCount")
        .and_then(Value::as_u64)
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| "Pi get_state returned an invalid messageCount".to_string())?;
    if reported_count != messages.len() {
        return Err(format!(
            "Pi changed messages during reconciliation: state reported {reported_count}, snapshot contained {}",
            messages.len()
        ));
    }
    let is_streaming = after
        .get("isStreaming")
        .and_then(Value::as_bool)
        .ok_or_else(|| "Pi get_state response omitted isStreaming".to_string())?;
    Ok(PiOfficialSnapshot {
        session_id: after_session_id.to_string(),
        message_count: messages.len(),
        is_streaming,
    })
}

fn reconciliation_snapshot(
    definition: ManagedRuntimeDefinition,
    generation: u64,
    native_session_id: String,
    message_count: usize,
    activity: &'static str,
    evidence: Vec<&'static str>,
) -> RuntimeReconciliationSnapshot {
    RuntimeReconciliationSnapshot {
        runtime: definition.identity(),
        runtime_build_id: definition.runtime_build_id,
        connection_id: definition.default_connection_id,
        runtime_generation: generation,
        native_session_id,
        message_count,
        activity,
        confidence: "current",
        evidence,
    }
}

fn pi_request(runtime: &PiRuntime, command: PiCommand) -> Result<Value, String> {
    correlated_request(runtime, command, PI_RECONCILIATION_TIMEOUT)
}

#[tauri::command]
pub fn reconcile_pi_session(
    runtime: State<'_, PiRuntime>,
    projection: State<'_, LiveSessionProjection>,
) -> Result<RuntimeReconciliationSnapshot, String> {
    let generation = running_generation(&runtime)?;
    let before = pi_request(
        &runtime,
        PiCommand::GetState {
            id: Some(next_request_id(&runtime, "reconcile-state-before")),
        },
    )?;
    let messages = pi_request(
        &runtime,
        PiCommand::GetMessages {
            id: Some(next_request_id(&runtime, "reconcile-messages")),
        },
    )?;
    let after = pi_request(
        &runtime,
        PiCommand::GetState {
            id: Some(next_request_id(&runtime, "reconcile-state-after")),
        },
    )?;
    if running_generation(&runtime)? != generation {
        return Err("Pi Runtime generation changed during reconciliation".to_string());
    }
    let snapshot = validated_pi_snapshot(&before, &messages, &after)?;
    projection.mark_reconciled(PI_RUNTIME, generation, Some(snapshot.is_streaming))?;
    Ok(reconciliation_snapshot(
        PI_RUNTIME,
        generation,
        snapshot.session_id,
        snapshot.message_count,
        if snapshot.is_streaming {
            "working"
        } else {
            "idle"
        },
        vec![
            "pi.rpc.get_state.before",
            "pi.rpc.get_messages",
            "pi.rpc.get_state.after",
        ],
    ))
}

fn contains_opencode_session(sessions: &[Value], session_id: &str) -> bool {
    sessions
        .iter()
        .any(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
}

#[tauri::command]
pub fn reconcile_opencode_session(
    runtime: State<'_, OpenCodeRuntime>,
    projection: State<'_, LiveSessionProjection>,
    session_id: String,
) -> Result<RuntimeReconciliationSnapshot, String> {
    let connection = opencode_runtime::connection(&runtime)?;
    let sessions = opencode_protocol::list_sessions(&connection)?;
    if !contains_opencode_session(&sessions, &session_id) {
        return Err("OpenCode Session is not present in the official Session list".to_string());
    }
    let messages = opencode_protocol::session_messages(&connection, &session_id, None)?;
    if connection.generation_clock.load(Ordering::SeqCst) != connection.generation {
        return Err("OpenCode Runtime generation changed during reconciliation".to_string());
    }
    projection.mark_reconciled(OPENCODE_RUNTIME, connection.generation, None)?;
    Ok(reconciliation_snapshot(
        OPENCODE_RUNTIME,
        connection.generation,
        session_id,
        messages.len(),
        "preserved",
        vec![
            "opencode.http.session.list",
            "opencode.http.session.messages",
        ],
    ))
}

#[cfg(test)]
mod tests {
    use super::{contains_opencode_session, validated_pi_snapshot};
    use serde_json::json;

    #[test]
    fn pi_snapshot_requires_a_stable_session_and_exact_message_count() {
        let before = json!({ "data": { "sessionId": "session-1" } });
        let messages = json!({ "data": { "messages": [{}, {}] } });
        let after = json!({
            "data": { "sessionId": "session-1", "messageCount": 2, "isStreaming": false }
        });
        let snapshot = validated_pi_snapshot(&before, &messages, &after).unwrap();
        assert_eq!(snapshot.session_id, "session-1");
        assert_eq!(snapshot.message_count, 2);
        assert!(!snapshot.is_streaming);

        let changed = json!({
            "data": { "sessionId": "session-2", "messageCount": 2, "isStreaming": false }
        });
        assert!(validated_pi_snapshot(&before, &messages, &changed).is_err());
        let torn = json!({
            "data": { "sessionId": "session-1", "messageCount": 3, "isStreaming": false }
        });
        assert!(validated_pi_snapshot(&before, &messages, &torn).is_err());
    }

    #[test]
    fn opencode_reconciliation_requires_the_exact_native_session_id() {
        let sessions = vec![json!({ "id": "ses_exact" }), json!({ "id": "ses_other" })];
        assert!(contains_opencode_session(&sessions, "ses_exact"));
        assert!(!contains_opencode_session(&sessions, "ses"));
    }
}
