//! Tauri commands for the session layer (see `session.rs` for the
//! `AcpManager` implementation and wire types).

use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::schema::v1::ContentBlock;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager as _};

use crate::acp_client::manager::{AcpManager, require_agent_row, validate_cwd, validate_cwd_async};
use crate::acp_client::pump::SessionSink;
use crate::acp_client::session::{SessionListEntry, SessionOpenResult};
use crate::acp_client::session_index::{
    iso8601_millis, now_millis, parse_config_map, same_dir, touch_session_row,
};
use crate::lifemodel;
use crate::logging;
use crate::meta_store::{MetaStore, SessionRow};

/// Open (or resume) a session. `channel` receives every event for this
/// session: raw `session/update` params, `permissionRequest`, `turnEnd`,
/// `connectionLost`.
#[tauri::command]
pub async fn session_open(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    native_session_id: Option<String>,
    config_options: Option<Value>,
    channel: Channel<Value>,
) -> Result<SessionOpenResult, String> {
    let row = require_agent_row(&app, &agent_id).await?;
    let cwd = validate_cwd_async(&cwd).await?;
    let config = parse_config_map(config_options)?;
    // An empty native id means "create", never "load".
    let native_session_id = native_session_id.filter(|id| !id.is_empty());
    let resumed = native_session_id.is_some();
    let events: SessionSink = Arc::new(move |value| {
        let _ = channel.send(value);
    });
    let manager = app.state::<AcpManager>();
    let store = app.state::<MetaStore>();
    let open = || async {
        manager
            .open_session(
                &row,
                &cwd,
                native_session_id.clone(),
                config.clone(),
                events,
                &store,
            )
            .await
    };
    let outcome = if resumed {
        open().await
    } else {
        crate::work_policy::admit(&store, &agent_id, &cwd, open).await
    };
    // Opening a conversation may establish the connection without going
    // through the settings command. Publish that same connection state,
    // even when the following history load failed.
    if let Ok(statuses) = manager.status(&agent_id) {
        for status in statuses
            .into_iter()
            .filter(|status| same_dir(&status.cwd, &cwd))
        {
            crate::ui_transport::emit_event(&app, "agent:status", &status);
        }
    }
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
    let cwd_string = cwd.to_string_lossy().into_owned();
    Ok(SessionOpenResult {
        native_session_id: opened.session_id,
        cwd: cwd_string,
        config_options: opened.config_options.unwrap_or(Value::Null),
        config_check: opened.config_check,
        modes: opened.response.get("modes").cloned(),
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

#[tauri::command]
pub async fn session_prompt(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    content: Value,
) -> Result<PromptAdmission, String> {
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
    let outcome = crate::work_policy::admit(&store, &agent_id, &cwd, || async {
        manager
            .live_connection(&agent_id, &cwd)
            .map_err(|_| "UNAVAILABLE".to_string())?;
        manager
            .session_prompt(&agent_id, &cwd, &session_id, prompt)
            .await
    })
    .await;
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
        Err(error) if error == "WORK_DISABLED" => Ok(PromptAdmission {
            status: "rejected",
            reason: Some("work_disabled"),
        }),
        Err(error) if error == "UNAVAILABLE" => Ok(PromptAdmission {
            status: "rejected",
            reason: Some("unavailable"),
        }),
        Err(error) if error.starts_with("FAILED: CONFIG_") => Ok(PromptAdmission {
            status: "rejected",
            reason: Some(if error.contains("RECORD_FAILED") {
                "config_record_failed"
            } else if error.contains("CONFIRMATION_REQUIRED") {
                "config_confirmation_required"
            } else {
                "config_blocked"
            }),
        }),
        // `FAILED:` = provably never sent (see `session_prompt`).
        Err(error) if error.starts_with("FAILED:") => Ok(PromptAdmission {
            status: "rejected",
            reason: Some("failed"),
        }),
        Err(_) => Ok(PromptAdmission {
            status: "unknown",
            reason: Some("uncertain"),
        }),
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

/// `session/set_config_option`; returns the session's full configOptions.
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
) -> Result<Value, String> {
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .confirm_config(&agent_id, &cwd, &session_id, displayed)
        .await
}

/// Answer a `session/request_permission` shown via the session channel.
#[tauri::command]
pub fn session_permission_respond(
    app: AppHandle,
    request_id: String,
    option_id: String,
    session_id: String,
) -> Result<(), String> {
    app.state::<AcpManager>()
        .permission_respond(&request_id, &option_id, &session_id)
}

/// Answer a pending `elicitation/create` (form mode): `accept` with
/// `content` values, `decline`, or `cancel`.
#[tauri::command]
pub fn session_elicitation_respond(
    app: AppHandle,
    request_id: String,
    action: String,
    content: Option<Value>,
) -> Result<(), String> {
    app.state::<AcpManager>()
        .elicitation_respond(&request_id, &action, content)
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

/// `session/close` when supported; always unregisters the session locally.
#[tauri::command]
pub async fn session_close(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
) -> Result<(), String> {
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .close_session(&agent_id, &cwd, &session_id)
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
    let mut row = store
        .get_session(&session_id)?
        .ok_or_else(|| format!("session row {session_id} not found"))?;
    row.title = Some(title);
    row.updated_at = now_millis();
    store.upsert_session(&row)?;
    Ok(row)
}

/// Pin/unpin a session index row.
#[tauri::command]
pub fn session_meta_pin(
    app: AppHandle,
    session_id: String,
    pinned: bool,
) -> Result<SessionRow, String> {
    let store = app.state::<MetaStore>();
    let mut row = store
        .get_session(&session_id)?
        .ok_or_else(|| format!("session row {session_id} not found"))?;
    row.pinned = pinned;
    row.updated_at = now_millis();
    store.upsert_session(&row)?;
    Ok(row)
}

/// Archive/unarchive a session index row.
#[tauri::command]
pub fn session_meta_archive(
    app: AppHandle,
    session_id: String,
    archived: bool,
) -> Result<SessionRow, String> {
    let store = app.state::<MetaStore>();
    let mut row = store
        .get_session(&session_id)?
        .ok_or_else(|| format!("session row {session_id} not found"))?;
    row.archived = archived;
    row.updated_at = now_millis();
    store.upsert_session(&row)?;
    Ok(row)
}

/// Delete a session: `session/delete` on the agent when advertised, remove
/// the index row, and always write a tombstone so agents without a delete
/// capability cannot resurrect it through `session/list`.
///
/// `native_session_id` is passed explicitly so callers can also delete
/// agent-side sessions that have no index row.
#[tauri::command]
pub async fn session_delete(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    native_session_id: String,
) -> Result<(), String> {
    let cwd = validate_cwd_async(&cwd).await?;
    let cwd_string = cwd.to_string_lossy().into_owned();
    let row_id = MetaStore::dismissed_id(&agent_id, &cwd_string, &native_session_id);
    let manager = app.state::<AcpManager>();
    match manager
        .delete_session(&agent_id, &cwd, &native_session_id)
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            logging::info(
                "acp_client",
                format_args!(
                    "session_delete: {agent_id} lacks session/delete; tombstone only ({row_id})"
                ),
            );
        }
        Err(error) => {
            // Best-effort: the tombstone still prevents resurrection;
            // surface the failure in the log, not as a hard error.
            logging::warn(
                "acp_client",
                format_args!("session_delete remote failed ({row_id}): {error}"),
            );
        }
    }
    let store = app.state::<MetaStore>();
    store
        .run(move |store| {
            let _ = store.remove_session(&row_id);
            store.dismiss_session(&row_id)
        })
        .await
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
