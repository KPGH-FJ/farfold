//! Tauri commands for the session layer (see `session.rs` for the
//! `AcpManager` implementation and wire types).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::delivery_flow::Wake;
use super::delivery_observation::DeliveryChannel;
use super::mutation::DeleteFailure;
use agent_client_protocol::schema::v1::ContentBlock;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager as _};

use crate::acp_client::manager::{AcpManager, require_agent_row, validate_cwd, validate_cwd_async};
pub use crate::acp_client::pump::ProcessEndedReceipt;
use crate::acp_client::pump::{FailedWorkCloseReceipt, SessionSink, StoppedToolCloseReceipt};
use crate::acp_client::session::{InteractionReply, SessionListEntry, SessionOpenResult};
use crate::acp_client::session_index::{
    iso8601_millis, parse_config_map, same_dir, touch_session_row,
};
use crate::lifemodel;
use crate::logging;
use crate::meta_store::{LocalSessionDeleteError, MetaStore, SessionRow};

/// Open (or resume) a session. `channel` receives every event for this
/// session: raw `session/update` params, `permissionRequest`, `turnEnd`,
/// `connectionLost`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn session_open(
    app: AppHandle,
    window: tauri::Window,
    agent_id: String,
    cwd: String,
    native_session_id: Option<String>,
    config_options: Option<Value>,
    service: Option<crate::credentials::ServiceSelection>,
    open_token: String,
    channel: Channel<Wake>,
    process_ended_channel: Channel<ProcessEndedReceipt>,
    admission_channel: Channel<super::history_admission_commands::HistoryAdmissionPhase>,
) -> Result<SessionOpenResult, String> {
    // An empty native id means "create", never "load".
    let native_session_id = native_session_id.filter(|id| !id.is_empty());
    let resumed = native_session_id.is_some();
    let manager = app.state::<AcpManager>();
    let store = app.state::<MetaStore>();
    // One authoritative cold admission, before any browser transport or
    // process preparation. The admitted-open method must never enqueue again.
    let request = native_session_id
        .as_ref()
        .map(|_| {
            super::history_admission_commands::HistoryRequest::from_window(
                &manager,
                &window,
                &open_token,
                &agent_id,
                admission_channel,
            )
        })
        .transpose()?;
    let mut preparation = request.as_ref().map(|request| {
        super::history_admission_commands::HistoryPreparation::new(request.progress.clone())
    });
    let row = require_agent_row(&app, &agent_id).await?;
    let cwd = validate_cwd_async(&cwd).await?;
    let config = parse_config_map(config_options)?;
    let channel = DeliveryChannel::new(&manager, &window, &agent_id, &open_token, channel)?;
    let delivery_failed = Arc::new(AtomicBool::new(false));
    let delivery_state = delivery_failed.clone();
    let event_channel = channel.clone();
    let events: SessionSink = Arc::new(move |value| {
        if event_channel.send(value).is_err() {
            delivery_state.store(true, Ordering::SeqCst);
        }
    });
    // The connected tool starts without page permission. Preview opens use the
    // separate discovery path and do not receive this transient transport.
    use super::transient_mcp::McpUnavailable;
    let (history, (mcp, browser_unavailable)) = manager
        .prepare_history_open(
            &row,
            &cwd,
            native_session_id.as_deref(),
            &config,
            &store,
            service.as_ref(),
            request,
            || {
                if let Some(preparation) = &mut preparation {
                    preparation.ready();
                }
                if super::browser_capability::eligible(&row) {
                    match super::browser_capability::prepare(
                        &app,
                        &app.state::<crate::browser_sharing::BrowserSharing>(),
                        &row,
                        &cwd,
                    ) {
                        Ok(mcp) => (Some(mcp), None),
                        Err(_) => {
                            logging::warn(
                                "acp_client",
                                format_args!("browser tool preparation unavailable"),
                            );
                            (None, Some(McpUnavailable::PreparationFailed))
                        }
                    }
                } else {
                    (None, Some(McpUnavailable::SourceNotReviewed))
                }
            },
        )
        .await?;
    let open = || async {
        manager
            .open_session_admitted_with_mcp(
                &row,
                &cwd,
                native_session_id.clone(),
                config,
                events,
                &store,
                service,
                mcp,
                browser_unavailable,
                history,
                Some(open_token.clone()),
            )
            .await
    };
    let outcome = if resumed {
        open().await
    } else {
        crate::work_policy::admit(&store, &agent_id, &cwd, open).await
    };
    let opened = match outcome {
        Ok(opened) => opened,
        Err(error) => {
            logging::warn(
                "acp_client",
                format_args!(
                    "session_open failed: {agent_id} on {} (native: {:?}): {error}",
                    cwd.display(),
                    native_session_id
                ),
            );
            return Err(error);
        }
    };
    logging::info(
        "acp_client",
        format_args!(
            "session_open: {agent_id} on {} → {} (resumed: {resumed})",
            cwd.display(),
            opened.session_id
        ),
    );
    let connection = manager.session_connection(&agent_id, &cwd, &opened.session_id)?;
    {
        // Drain-before-register => failed open, never a usable unobservable route.
        // Register-before-drain => one sink held by that exact SessionEntry.
        let mut entries = connection.sessions.lock().map_err(|_| "无法读取对话状态")?;
        let entry = entries
            .get_mut(&opened.session_id)
            .ok_or("Agent 连接已结束，请重试")?;
        entry.observe_process_end(
            &opened.connection_id,
            Arc::new(move |receipt| {
                let _ = process_ended_channel.send(receipt);
            }),
        )?;
    }
    let session_operations = super::session_fork::capabilities(&connection, &opened.session_id);
    let workspace_access = super::workspace_access::capability(&connection);
    let identity_read = super::identity_read::capability(&connection);
    let session_tool_inventory =
        super::session_tools::opened_capability(&connection, &opened.session_id, &opened.response);
    let source = connection.service;
    let cwd_string = cwd.to_string_lossy().into_owned();
    if resumed {
        if delivery_failed.load(Ordering::SeqCst) {
            return Err("未能完整读取对话内容，请重试".into());
        }
        channel
            .send(serde_json::json!({"kind":"session_history_complete", "openToken":open_token}))
            .map_err(|_| "未能完整读取对话内容，请重试")?;
    }
    Ok(SessionOpenResult {
        history_empty_confirmed: opened.history_empty_confirmed,
        identity_read,
        session_tool_inventory,
        workspace_access,
        session_operations,
        connection_id: opened.connection_id,
        service: source.as_ref().map(|s| s.identity.clone()),
        service_model_value: source.as_ref().map(|s| s.model_id.clone()),
        service_context: source.map(|s| s.revision),
        native_session_id: opened.session_id,
        cwd: cwd_string,
        config_options: opened.config_options.unwrap_or(Value::Null),
        config_options_modern: opened.config_options_modern,
        config_check: opened.config_check,
        permission_config_id: opened.permission_config_id,
        permission_state: opened.permission_state,
        permission_effect: opened.permission_effect,
        modes: (!opened.config_options_modern)
            .then(|| opened.response.get("modes").cloned())
            .flatten(),
        models: opened.response.get("models").cloned(),
        meta: opened.response.get("_meta").cloned(),
        resumed,
        warnings: opened.warnings,
    })
}

/// Send a prompt; resolves once the request is sent. Turn completion arrives
/// on the session channel as `{kind:"turnEnd"}`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptAdmission {
    status: &'static str,
    reason: Option<&'static str>,
}

fn prompt_failure_admission(error: &str) -> PromptAdmission {
    let reason = match error {
        "WORK_DISABLED" => "work_disabled",
        "FAILED: PROMPT_QUEUE_FULL" => "send_wait_limit",
        "FAILED: PROMPT_QUEUE_PAYLOAD" => "send_wait_payload",
        "FAILED: PROMPT_QUEUE_CANCELLED" => "send_wait_cancelled",
        "FAILED: PROMPT_QUEUE_TIMEOUT" => "send_wait_timeout",
        "FAILED: PROMPT_QUEUE_UNAVAILABLE" => "unavailable",
        "UNAVAILABLE" | "FAILED: SESSION_UNAVAILABLE" => "unavailable",
        "FAILED:PROMPT_EMBEDDED_CONTEXT_UNKNOWN" => "embedded_context_unknown",
        "FAILED:PROMPT_EMBEDDED_CONTEXT_UNSUPPORTED" => "embedded_context_unsupported",
        "FAILED:PROMPT_AUDIO_UNKNOWN" => "audio_unknown",
        "FAILED:PROMPT_AUDIO_UNSUPPORTED" => "audio_unsupported",
        "FAILED:PROMPT_AUDIO_LIMIT" => "audio_limit",
        "FAILED:PROMPT_AUDIO_DURATION_LIMIT" => "audio_duration_limit",
        "FAILED:PROMPT_AUDIO_FORMAT_UNSUPPORTED" => "audio_format_unsupported",
        "FAILED:PROMPT_AUDIO_INVALID" => "audio_invalid",
        "FAILED: PROMPT_PERMISSION_SCOPE_UNVERIFIED" => "permission_scope_unverified",
        "FAILED: SERVICE_UNAVAILABLE" => "service_unavailable",
        error if error.starts_with("FAILED: CONFIG_") => {
            if error.contains("RECORD_FAILED") {
                "config_record_failed"
            } else if error.contains("CONFIRMATION_REQUIRED") {
                "config_confirmation_required"
            } else {
                "config_blocked"
            }
        }
        // `FAILED:` is a known pre-wire rejection, not an unknown outcome.
        error if error.starts_with("FAILED:") => "failed",
        _ => {
            return PromptAdmission {
                status: "unknown",
                reason: Some("uncertain"),
            };
        }
    };
    PromptAdmission {
        status: "rejected",
        reason: Some(reason),
    }
}

#[cfg(test)]
#[test]
fn permission_scope_rejection_is_definite_only_with_pre_dispatch_failure_prefix() {
    let rejected = serde_json::to_value(prompt_failure_admission(
        "FAILED: PROMPT_PERMISSION_SCOPE_UNVERIFIED",
    ))
    .unwrap();
    assert_eq!(
        rejected,
        serde_json::json!({"status":"rejected","reason":"permission_scope_unverified"})
    );
    for unknown in [
        "PROMPT_PERMISSION_SCOPE_UNVERIFIED",
        "lost reply",
        "timeout",
    ] {
        let unknown = serde_json::to_value(prompt_failure_admission(unknown)).unwrap();
        assert_eq!(
            unknown,
            serde_json::json!({"status":"unknown","reason":"uncertain"})
        );
    }
}

#[cfg(test)]
#[test]
fn send_wait_timeout_serialization_requires_exact_unsent_native_code() {
    assert_eq!(
        serde_json::to_value(prompt_failure_admission("FAILED: PROMPT_QUEUE_TIMEOUT")).unwrap(),
        serde_json::json!({"status":"rejected","reason":"send_wait_timeout"})
    );
    assert_eq!(
        serde_json::to_value(prompt_failure_admission("FAILED: PROMPT_QUEUE_CANCELLED")).unwrap(),
        serde_json::json!({"status":"rejected","reason":"send_wait_cancelled"})
    );
    for error in [
        "PROMPT_QUEUE_TIMEOUT",
        "session prompt deadline elapsed",
        "lost reply",
        "cancel unconfirmed",
    ] {
        assert_eq!(
            serde_json::to_value(prompt_failure_admission(error)).unwrap(),
            serde_json::json!({"status":"unknown","reason":"uncertain"})
        );
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn session_prompt(
    app: AppHandle,
    window: tauri::Window,
    agent_id: String,
    cwd: String,
    session_id: String,
    content: Value,
    connection_id: Option<String>,
    expected_current: Value,
    prompt_token: String,
    admission_channel: Channel<super::active_prompt::Progress>,
) -> Result<PromptAdmission, String> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    let cwd = validate_cwd_async(&cwd).await?;
    let blocks: Vec<ContentBlock> = serde_json::from_value(content)
        .map_err(|error| format!("invalid prompt content: {error}"))?;
    if blocks.is_empty() {
        return Err("prompt content is empty".to_string());
    }
    // LifeModel seam (D8): approved canonical context prepends the
    // prompt. Empty while injection is unimplemented → no-op.
    let store = app.state::<MetaStore>();
    let context_agent = agent_id.clone();
    let mut prompt = store
        .run(move |s| Ok(lifemodel::context_blocks_for_prompt(s, &context_agent)))
        .await?;
    prompt.extend(blocks);
    let manager = app.state::<AcpManager>();
    let owner = manager
        .prompt_admission
        .owner(&window, &prompt_token, &agent_id)
        .map_err(super::active_prompt::failure)?;
    let outcome = match connection_id {
        None => Err("FAILED: SESSION_UNAVAILABLE".into()),
        Some(connection_id) => {
            manager
                .admit_prompt(super::active_prompt::Input {
                    agent: &agent_id,
                    cwd: &cwd,
                    session: &session_id,
                    blocks: prompt,
                    store: &store,
                    request: super::active_prompt::Request {
                        owner,
                        connection_id,
                        expected_current,
                        deadline,
                        progress: Arc::new(move |progress| {
                            admission_channel
                                .send(progress)
                                .map_err(|_| "无法确认发送等待状态".into())
                        }),
                    },
                })
                .await
        }
    };
    match outcome {
        Ok(()) => {
            // Metadata failure cannot turn an accepted message into a retry.
            let _ = store
                .run(move |store| {
                    touch_session_row(
                        store,
                        &agent_id,
                        &cwd.to_string_lossy(),
                        &session_id,
                        None,
                        None,
                    )
                })
                .await;
            Ok(PromptAdmission {
                status: "accepted",
                reason: None,
            })
        }
        Err(error) => Ok(prompt_failure_admission(&error)),
    }
}

#[cfg(test)]
mod prompt_context_admission_tests {
    use super::*;

    #[test]
    fn exact_unsent_reasons_and_existing_rejections_keep_their_public_classification() {
        for (error, reason) in [
            ("FAILED:PROMPT_AUDIO_UNKNOWN", "audio_unknown"),
            ("FAILED:PROMPT_AUDIO_UNSUPPORTED", "audio_unsupported"),
            ("FAILED:PROMPT_AUDIO_LIMIT", "audio_limit"),
            ("FAILED:PROMPT_AUDIO_DURATION_LIMIT", "audio_duration_limit"),
            (
                "FAILED:PROMPT_AUDIO_FORMAT_UNSUPPORTED",
                "audio_format_unsupported",
            ),
            ("FAILED:PROMPT_AUDIO_INVALID", "audio_invalid"),
            (
                "FAILED:PROMPT_EMBEDDED_CONTEXT_UNKNOWN",
                "embedded_context_unknown",
            ),
            (
                "FAILED:PROMPT_EMBEDDED_CONTEXT_UNSUPPORTED",
                "embedded_context_unsupported",
            ),
            ("WORK_DISABLED", "work_disabled"),
            ("UNAVAILABLE", "unavailable"),
            ("FAILED: SESSION_UNAVAILABLE", "unavailable"),
            ("FAILED: SERVICE_UNAVAILABLE", "service_unavailable"),
            ("FAILED: CONFIG_RECORD_FAILED", "config_record_failed"),
            (
                "FAILED: CONFIG_CONFIRMATION_REQUIRED",
                "config_confirmation_required",
            ),
            ("FAILED: CONFIG_BLOCKED", "config_blocked"),
            ("FAILED: session is closed", "failed"),
        ] {
            assert_eq!(
                serde_json::to_value(prompt_failure_admission(error)).unwrap(),
                serde_json::json!({"status":"rejected","reason":reason})
            );
        }
        for error in [
            "session prompt deadline elapsed",
            "session prompt channel closed",
            "PROMPT_EMBEDDED_CONTEXT_UNKNOWN",
        ] {
            assert_eq!(
                serde_json::to_value(prompt_failure_admission(error)).unwrap(),
                serde_json::json!({"status":"unknown","reason":"uncertain"})
            );
        }
    }
}

/// `session/set_mode` for agents that expose `modes` outside
/// `configOptions` (the frontend routes the synthetic `mode` option here).
#[tauri::command]
pub async fn session_set_mode(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    mode_id: String,
) -> Result<(), String> {
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .session_set_mode(&agent_id, &cwd, &session_id, &mode_id)
        .await
}

/// A capability-reported task only; no command/PID fallback.
#[tauri::command]
pub async fn session_stop_task(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
    task_id: String,
) -> Result<Value, String> {
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .session_stop_task(&agent_id, &cwd, &session_id, &connection_id, &task_id)
        .await
}

/// `session/cancel` for a running turn.
#[tauri::command]
pub async fn session_cancel(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
) -> Result<(), String> {
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .session_cancel(&agent_id, &cwd, &session_id)
        .await
}

/// `session/set_config_option`; returns full options and their confirmed check.
#[tauri::command]
pub async fn session_set_config(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    config_id: String,
    value: Value,
) -> Result<Value, String> {
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .session_set_config(&agent_id, &cwd, &session_id, &config_id, value)
        .await
}

#[tauri::command]
pub async fn session_confirm_config(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    displayed: Value,
    connection_id: Option<String>,
    restore_selection: Option<Value>,
) -> Result<Value, String> {
    let cwd = validate_cwd_async(&cwd).await.map_err(|error| {
        super::restore_confirmation::Code::CwdInvalid
            .for_restore(restore_selection.is_some(), error)
    })?;
    app.state::<AcpManager>()
        .confirm_config_selection(
            &agent_id,
            &cwd,
            &session_id,
            displayed,
            connection_id,
            restore_selection,
        )
        .await
}

/// Answer a `session/request_permission` shown via the session channel.
#[tauri::command]
pub fn session_permission_respond(
    app: AppHandle,
    request_id: String,
    option_id: Option<String>,
    session_id: Option<String>,
    request_owner: Option<Value>,
) -> Result<InteractionReply, String> {
    app.state::<AcpManager>().permission_respond_owned(
        &request_id,
        option_id.as_deref(),
        session_id.as_deref(),
        request_owner.as_ref(),
    )
}

/// Answer a pending `elicitation/create` (form mode): `accept` with
/// `content` values, `decline`, or `cancel`.
#[tauri::command]
pub fn session_elicitation_respond(
    app: AppHandle,
    request_id: String,
    session_id: Option<String>,
    request_owner: Option<Value>,
    action: String,
    content: Option<Value>,
) -> Result<InteractionReply, String> {
    let manager = app.state::<AcpManager>();
    if request_owner.is_none()
        && let Some(session_id) = session_id.as_deref()
    {
        return manager.elicitation_respond(&request_id, session_id, &action, content);
    }
    super::elicitation::respond(
        &manager.pending_elicitations,
        &request_id,
        session_id.as_deref(),
        request_owner.as_ref(),
        &action,
        content,
    )
}

/// Agent-side `session/list` merged with Farfold's session index rows for
/// this `(agent_id, cwd)`. Agent-reported entries win on `source: "agent"`;
/// Farfold-only rows keep `source: "farfold"`.
#[tauri::command]
pub async fn session_list(
    app: AppHandle,
    agent_id: String,
    cwd: String,
) -> Result<Vec<SessionListEntry>, String> {
    let cwd = validate_cwd_async(&cwd).await?;
    let cwd_string = cwd.to_string_lossy().into_owned();
    let manager = app.state::<AcpManager>();
    let store = app.state::<MetaStore>();
    // A remote failure must not hide the local index: fall back to
    // Farfold rows only (the protocol tap keeps the wire evidence).
    let remote = manager
        .agent_session_list(&agent_id, &cwd)
        .await
        .unwrap_or_default();
    let list_agent = agent_id.clone();
    let list_cwd = cwd_string.clone();
    let (rows, dismissed) = store
        .run(move |store| {
            Ok((
                store.list_sessions_for(&list_agent, &list_cwd)?,
                store.list_dismissed().unwrap_or_default(),
            ))
        })
        .await?;
    let mut meta_by_native: HashMap<String, &SessionRow> = rows
        .iter()
        .filter_map(|row| row.native_session_id.clone().map(|id| (id, row)))
        .collect();
    let mut entries = Vec::new();
    for info in &remote {
        let Some(native) = info.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        let info_cwd = info
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or(&cwd_string);
        if !same_dir(info_cwd, &cwd) {
            continue;
        }
        // Tombstoned sessions (discarded drafts, deletes) must not
        // reappear from the agent-side list.
        if dismissed.contains(&MetaStore::dismissed_id(&agent_id, &cwd_string, native)) {
            continue;
        }
        let meta = meta_by_native.remove(native);
        entries.push(SessionListEntry {
            id: meta.map(|row| row.id.clone()),
            native_session_id: native.to_string(),
            title: info
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| meta.and_then(|row| row.title.clone())),
            updated_at: info
                .get("updatedAt")
                .and_then(Value::as_str)
                .and_then(iso8601_millis)
                .or_else(|| meta.map(|row| row.updated_at)),
            source: "agent".to_string(),
            pinned: meta.is_some_and(|row| row.pinned),
            archived: meta.is_some_and(|row| row.archived),
        });
    }
    for row in meta_by_native.into_values() {
        let Some(native) = row.native_session_id.clone() else {
            continue;
        };
        entries.push(SessionListEntry {
            id: Some(row.id.clone()),
            native_session_id: native,
            title: row.title.clone(),
            updated_at: Some(row.updated_at),
            source: "farfold".to_string(),
            pinned: row.pinned,
            archived: row.archived,
        });
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
    Ok(entries)
}

/// Retain an uncertain remote close until the Agent confirms or the connection ends.
#[tauri::command]
pub async fn session_close(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    allow_already_closed: Option<bool>,
) -> Result<(), String> {
    let cwd = validate_cwd_async(&cwd).await?;
    let manager = app.state::<AcpManager>();
    if allow_already_closed.unwrap_or(false) {
        manager
            .close_session_for_auth(&agent_id, &cwd, &session_id)
            .await
    } else {
        manager.close_session(&agent_id, &cwd, &session_id).await
    }
}

/// Read the owning pump's current proof without requesting Agent work.
#[tauri::command]
pub async fn session_check_unapproved_stopped_close(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
) -> Result<Option<StoppedToolCloseReceipt>, String> {
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .check_unapproved_stopped_close(&agent_id, &cwd, &session_id, &connection_id)
        .await
}

/// Close only the exact session, tool and stop shown for explicit review.
#[tauri::command]
pub async fn session_close_unapproved_stopped(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
    tool_call_id: String,
    proof_id: String,
) -> Result<StoppedToolCloseReceipt, String> {
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .close_unapproved_stopped(
            &agent_id,
            &cwd,
            &session_id,
            &connection_id,
            tool_call_id,
            proof_id,
        )
        .await
}

/// Read whether a matched failed request can safely end its one local connection.
#[tauri::command]
pub async fn prepare_failed_work_close(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
) -> Result<Option<FailedWorkCloseReceipt>, String> {
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .prepare_failed_work_close(&agent_id, &cwd, &session_id, &connection_id)
        .await
}

/// The reply confirms local process exit only. The earlier result is unknown.
#[tauri::command]
pub async fn close_failed_work(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
    proof_id: String,
) -> Result<FailedWorkCloseReceipt, String> {
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .close_failed_work(&agent_id, &cwd, &session_id, &connection_id, proof_id)
        .await
}

/// Explicitly recheck a configuration without closing or deleting the Agent's
/// conversation. The pump must confirm this route is idle before detaching.
#[tauri::command]
pub async fn session_detach_for_config_check(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    allow_already_detached: Option<bool>,
) -> Result<(), String> {
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .detach_session_for_config_check(
            &agent_id,
            &cwd,
            &session_id,
            allow_already_detached.unwrap_or(false),
        )
        .await
}

/// Upsert the session index row (called after open/prompt; `title` may be
/// the first message's first 40 chars, supplied by the caller).
#[tauri::command]
pub fn session_touch(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    title: Option<String>,
    config_options: Option<Value>,
) -> Result<SessionRow, String> {
    let cwd = validate_cwd(&cwd)?;
    let store = app.state::<MetaStore>();
    touch_session_row(
        &store,
        &agent_id,
        &cwd.to_string_lossy(),
        &session_id,
        title.as_deref(),
        config_options,
    )
}

/// Rename a session index row (row id = `agent:cwd:nativeSessionId`).
#[tauri::command]
pub fn session_meta_rename(
    app: AppHandle,
    session_id: String,
    title: String,
) -> Result<SessionRow, String> {
    let store = app.state::<MetaStore>();
    store.edit_session_metadata(&session_id, Some(&title), None)
}

/// Pin/unpin a session index row.
#[tauri::command]
pub fn session_meta_pin(
    app: AppHandle,
    session_id: String,
    pinned: bool,
) -> Result<SessionRow, String> {
    let store = app.state::<MetaStore>();
    store.edit_session_metadata(&session_id, None, Some(pinned))
}

/// Archive/unarchive a session index row.
#[tauri::command]
pub async fn session_meta_archive(
    app: AppHandle,
    session_id: String,
    archived: bool,
    expected_cwd: Option<String>,
) -> Result<SessionRow, String> {
    app.state::<AcpManager>()
        .archive_session_checked(
            &app.state::<MetaStore>(),
            session_id,
            archived,
            expected_cwd,
        )
        .await
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionDeleteAgentResult {
    Deleted,
    Unsupported,
    Unconfirmed,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum SessionDeleteFailure {
    LocalNotRemoved {
        agent: Option<SessionDeleteAgentResult>,
        #[serde(
            rename = "connectionClosed",
            skip_serializing_if = "delete_connection_open"
        )]
        connection_closed: bool,
    },
    LocalRemovalUnknown {
        agent: SessionDeleteAgentResult,
        #[serde(
            rename = "connectionClosed",
            skip_serializing_if = "delete_connection_open"
        )]
        connection_closed: bool,
    },
}

fn delete_connection_open(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
#[test]
fn session_delete_reports_the_agent_result_separately_from_local_failure() {
    use serde_json::json;

    for (agent, wire) in [
        (SessionDeleteAgentResult::Deleted, "deleted"),
        (SessionDeleteAgentResult::Unsupported, "unsupported"),
        (SessionDeleteAgentResult::Unconfirmed, "unconfirmed"),
    ] {
        assert_eq!(serde_json::to_value(agent).unwrap(), json!(wire));
        assert_eq!(
            serde_json::to_value(SessionDeleteFailure::LocalNotRemoved {
                agent: Some(agent),
                connection_closed: false
            })
            .unwrap(),
            json!({"code":"localNotRemoved","agent":wire})
        );
        assert_eq!(
            serde_json::to_value(SessionDeleteFailure::LocalRemovalUnknown {
                agent,
                connection_closed: false
            })
            .unwrap(),
            json!({"code":"localRemovalUnknown","agent":wire})
        );
    }
    assert_eq!(
        serde_json::to_value(SessionDeleteFailure::LocalNotRemoved {
            agent: None,
            connection_closed: false
        })
        .unwrap(),
        json!({"code":"localNotRemoved","agent":null})
    );
    assert_eq!(
        serde_json::to_value(SessionDeleteFailure::LocalNotRemoved {
            agent: Some(SessionDeleteAgentResult::Deleted),
            connection_closed: true,
        })
        .unwrap(),
        json!({"code":"localNotRemoved","agent":"deleted","connectionClosed":true})
    );
}

/// Request official Agent deletion and commit the local removal and history
/// filter together. A local failure retains the distinct Agent-side result.
///
/// `native_session_id` is passed explicitly so callers can also delete
/// agent-side sessions that have no index row. The returned value reports the
/// agent-side outcome so the UI can state residue honestly:
/// `"deleted"`, `"unsupported"` (no remote deletion requested), or
/// `"unconfirmed"` (the Agent-side result could not be confirmed).
#[tauri::command]
pub async fn session_delete(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    native_session_id: String,
) -> Result<SessionDeleteAgentResult, SessionDeleteFailure> {
    let cwd =
        validate_cwd_async(&cwd)
            .await
            .map_err(|_| SessionDeleteFailure::LocalNotRemoved {
                agent: None,
                connection_closed: false,
            })?;
    delete_session_in_scope(
        &app.state::<AcpManager>(),
        &app.state::<MetaStore>(),
        &agent_id,
        &cwd,
        &native_session_id,
    )
    .await
}

pub(super) async fn delete_session_in_scope(
    manager: &AcpManager,
    store: &MetaStore,
    agent_id: &str,
    cwd: &std::path::Path,
    native_session_id: &str,
) -> Result<SessionDeleteAgentResult, SessionDeleteFailure> {
    let cwd_string = cwd.to_string_lossy().into_owned();
    let row_id = MetaStore::dismissed_id(agent_id, &cwd_string, native_session_id);
    let guarded_id = row_id.clone();
    if store
        .run(move |store| store.require_delete_ready(&guarded_id))
        .await
        .is_err()
    {
        return Err(SessionDeleteFailure::LocalNotRemoved {
            agent: None,
            connection_closed: false,
        });
    }
    let attempt = manager
        .close_and_delete_session(agent_id, cwd, native_session_id, store)
        .await;
    let connection_closed = attempt.connection_closed;
    let remote = match attempt.result {
        Ok(true) => SessionDeleteAgentResult::Deleted,
        Ok(false) => SessionDeleteAgentResult::Unsupported,
        Err(DeleteFailure::NotDispatched) => {
            return Err(SessionDeleteFailure::LocalNotRemoved {
                agent: None,
                connection_closed,
            });
        }
        Err(DeleteFailure::Unconfirmed(error)) => {
            logging::warn(
                "acp_client",
                format_args!("session_delete remote failed ({row_id}): {error}"),
            );
            if !connection_closed {
                return Err(SessionDeleteFailure::LocalNotRemoved {
                    agent: Some(SessionDeleteAgentResult::Unconfirmed),
                    connection_closed,
                });
            }
            SessionDeleteAgentResult::Unconfirmed
        }
    };
    match store
        .run(move |store| Ok(store.remove_and_dismiss_session(&row_id)))
        .await
    {
        Ok(Ok(())) => Ok(remote),
        Ok(Err(LocalSessionDeleteError::NotRemoved)) => {
            Err(SessionDeleteFailure::LocalNotRemoved {
                agent: Some(remote),
                connection_closed,
            })
        }
        Ok(Err(LocalSessionDeleteError::Unknown)) | Err(_) => {
            Err(SessionDeleteFailure::LocalRemovalUnknown {
                agent: remote,
                connection_closed,
            })
        }
    }
}

/// Tombstone an agent-side session so `session/list` stops surfacing it
/// (discarded unprompted drafts). Does not touch the index.
#[tauri::command]
pub fn session_dismiss(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    native_session_id: String,
) -> Result<(), String> {
    let cwd = validate_cwd(&cwd)?;
    app.state::<MetaStore>()
        .dismiss_session(&MetaStore::dismissed_id(
            &agent_id,
            &cwd.to_string_lossy(),
            &native_session_id,
        ))
}

/// Every meta_store session row, newest first (sidebar session flow).
#[tauri::command]
pub fn session_index_list(app: AppHandle) -> Result<Vec<SessionRow>, String> {
    app.state::<MetaStore>().list_sessions()
}
