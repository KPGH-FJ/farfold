use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::atomic::Ordering, time::Duration};
use tauri::Manager;

use crate::{
    host_ids::{FarfoldSessionId, NativeSessionId},
    host_store::HostStore,
    interaction_registry::InteractionRegistry,
    live_session_projection::LiveSessionProjection,
    opencode_protocol,
    opencode_runtime::{self, OpenCodeRuntime},
    pi_runtime::{PiCommand, PiRuntime, correlated_request, next_request_id, running_generation},
    runtime_event_router::RuntimeEventRouter,
    runtime_registry::{
        ManagedRuntimeDefinition, OPENCODE_RUNTIME_PRODUCT_ID, PI_RUNTIME, RuntimeBinding,
        RuntimeIdentity,
    },
    session_controller::{HostSessionController, require_openable},
    turn_coordinator::TurnCoordinator,
};

const PI_RECONCILIATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReconciliationSnapshot {
    runtime: RuntimeIdentity,
    runtime_build_id: String,
    connection_id: String,
    runtime_generation: u64,
    native_session_id: String,
    message_count: usize,
    activity: &'static str,
    confidence: &'static str,
    evidence: Vec<&'static str>,
}

impl RuntimeReconciliationSnapshot {
    fn for_binding(
        binding: RuntimeBinding,
        runtime_generation: u64,
        native_session_id: String,
        message_count: usize,
        activity: &'static str,
        confidence: &'static str,
        evidence: Vec<&'static str>,
    ) -> Self {
        Self {
            runtime: binding.identity(),
            runtime_build_id: binding.runtime_build_id.as_str().to_owned(),
            connection_id: binding.connection_id.as_str().to_owned(),
            runtime_generation,
            native_session_id,
            message_count,
            activity,
            confidence,
            evidence,
        }
    }
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
        runtime_build_id: definition.runtime_build_id.to_string(),
        connection_id: definition.default_connection_id.to_string(),
        runtime_generation: generation,
        native_session_id,
        message_count,
        activity,
        confidence: if activity == "unknown" {
            "reconciliation_required"
        } else {
            "current"
        },
        evidence,
    }
}

fn pi_request(runtime: &PiRuntime, command: PiCommand) -> Result<Value, String> {
    correlated_request(runtime, command, PI_RECONCILIATION_TIMEOUT)
}

#[tauri::command]
pub async fn reconcile_pi_session(
    app: tauri::AppHandle,
) -> Result<RuntimeReconciliationSnapshot, String> {
    // RPC waits must not block the macOS event loop while native startup and
    // frontend event delivery are in progress. Match the OpenCode boundary.
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<PiRuntime>();
        let projection = app.state::<LiveSessionProjection>();
        reconcile_pi_snapshot(&runtime, &projection)
    })
    .await
    .map_err(|error| format!("Pi reconciliation worker failed: {error}"))?
}

fn reconcile_pi_snapshot(
    runtime: &PiRuntime,
    projection: &LiveSessionProjection,
) -> Result<RuntimeReconciliationSnapshot, String> {
    let generation = running_generation(runtime)?;
    let before = pi_request(
        runtime,
        PiCommand::GetState {
            id: Some(next_request_id(runtime, "reconcile-state-before")),
        },
    )?;
    let messages = pi_request(
        runtime,
        PiCommand::GetMessages {
            id: Some(next_request_id(runtime, "reconcile-messages")),
        },
    )?;
    let after = pi_request(
        runtime,
        PiCommand::GetState {
            id: Some(next_request_id(runtime, "reconcile-state-after")),
        },
    )?;
    if running_generation(runtime)? != generation {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeReconcileInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
}

#[tauri::command]
pub async fn reconcile_opencode_session(
    app: tauri::AppHandle,
    input: OpenCodeReconcileInput,
) -> Result<RuntimeReconciliationSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let turns = app.state::<TurnCoordinator>();
        let runtime = app.state::<OpenCodeRuntime>();
        let projection = app.state::<LiveSessionProjection>();
        let store = app.state::<HostStore>();
        let (connection, before, session_id) = controller.inspect(|| {
            let target = store.session_open_target(&input.farfold_session_id)?;
            require_openable(&target)?;
            if target.runtime_product_id.as_str() != OPENCODE_RUNTIME_PRODUCT_ID
                || target.native_session_id != input.native_session_id
            {
                return Err(
                    "OpenCode reconciliation does not match the persistent Host binding".into(),
                );
            }
            let session_id = input.native_session_id.as_str().to_string();
            let connection = opencode_runtime::connection(&runtime)?;
            if connection.runtime.product_id != target.runtime_product_id
                || connection.runtime.installation_id != target.installation_id
                || connection.runtime.connection_id != target.connection_id
            {
                return Err("OpenCode reconciliation Runtime connection changed".into());
            }
            if connection.project_path != target.working_copy_path {
                return Err("OpenCode reconciliation Working Copy changed".into());
            }
            let before = turns.opencode_active_turn(&session_id, connection.generation)?;
            Ok((connection, before, session_id))
        })?;
        opencode_protocol::read_session(&connection, &session_id)?;
        let messages = opencode_protocol::session_messages(&connection, &session_id, None)?;
        let busy = opencode_protocol::session_busy(&connection, &session_id)?;
        controller.exclusive(|| {
            if connection.generation_clock.load(Ordering::SeqCst) != connection.generation {
                return Err("OpenCode Runtime generation changed during reconciliation".to_string());
            }
            let activity = turns.reconcile_opencode_activity(
                before.as_ref(),
                &session_id,
                connection.generation,
                busy,
            )?;
            if activity == "idle" {
                app.state::<InteractionRegistry>()
                    .reconcile_opencode_idle(connection.generation, &session_id)?;
            }
            if activity != "unknown" {
                projection.mark_reconciled(
                    connection.runtime.clone(),
                    connection.generation,
                    None,
                )?;
            }
            app.state::<RuntimeEventRouter>().publish_state()?;
            Ok(RuntimeReconciliationSnapshot::for_binding(
                connection.runtime,
                connection.generation,
                session_id,
                messages.len(),
                activity,
                if activity == "unknown" {
                    "reconciliation_required"
                } else {
                    "current"
                },
                vec![
                    "opencode.http.session.get",
                    "opencode.http.session.messages",
                    "opencode.http.session.status",
                ],
            ))
        })
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[cfg(test)]
mod tests {
    use super::validated_pi_snapshot;
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
}
