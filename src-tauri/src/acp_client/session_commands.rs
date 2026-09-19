//! Tauri commands for the session layer (see `session.rs` for the
//! `AcpManager` implementation and wire types).

use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::schema::v1::ContentBlock;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager as _};

use crate::acp_client::manager::{AcpManager, require_agent_row, validate_cwd};
use crate::acp_client::pump::SessionSink;
use crate::acp_client::session::{SessionListEntry, SessionOpenResult};
use crate::acp_client::session_index::{
    iso8601_millis, now_millis, parse_config_map, same_dir, touch_session_row,
};
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
    tauri::async_runtime::spawn_blocking(move || {
        let row = require_agent_row(&app, &agent_id)?;
        let cwd = validate_cwd(&cwd)?;
        let config = parse_config_map(config_options)?;
        // An empty native id means "create", never "load".
        let native_session_id = native_session_id.filter(|id| !id.is_empty());
        let resumed = native_session_id.is_some();
        let events: SessionSink = Arc::new(move |value| {
            let _ = channel.send(value);
        });
        let manager = app.state::<AcpManager>();
        let store = app.state::<MetaStore>();
        let opened = manager.open_session(
            &row,
            &cwd,
            native_session_id,
            config.clone(),
            events,
            &store,
        )?;
        let cwd_string = cwd.to_string_lossy().into_owned();
        let config_map = if config.is_empty() {
            None
        } else {
            Some(Value::Object(config.into_iter().collect()))
        };
        touch_session_row(
            &store,
            &agent_id,
            &cwd_string,
            &opened.session_id,
            None,
            config_map,
        )?;
        Ok(SessionOpenResult {
            native_session_id: opened.session_id,
            config_options: opened.config_options.unwrap_or(Value::Null),
            modes: opened.response.get("modes").cloned(),
            models: opened.response.get("models").cloned(),
            meta: opened.response.get("_meta").cloned(),
            resumed,
            warnings: opened.warnings,
        })
    })
    .await
    .map_err(|error| format!("session_open failed: {error}"))?
}

/// Send a prompt; resolves once the request is sent. Turn completion arrives
/// on the session channel as `{kind:"turnEnd"}`.
#[tauri::command]
pub async fn session_prompt(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    content: Value,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = validate_cwd(&cwd)?;
        let blocks: Vec<ContentBlock> = serde_json::from_value(content)
            .map_err(|error| format!("invalid prompt content: {error}"))?;
        if blocks.is_empty() {
            return Err("prompt content is empty".to_string());
        }
        app.state::<AcpManager>()
            .session_prompt(&agent_id, &cwd, &session_id, blocks)?;
        let store = app.state::<MetaStore>();
        touch_session_row(
            &store,
            &agent_id,
            &cwd.to_string_lossy(),
            &session_id,
            None,
            None,
        )?;
        Ok(())
    })
    .await
    .map_err(|error| format!("session_prompt failed: {error}"))?
}

/// `session/cancel` for a running turn.
#[tauri::command]
pub async fn session_cancel(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = validate_cwd(&cwd)?;
        app.state::<AcpManager>()
            .session_cancel(&agent_id, &cwd, &session_id)
    })
    .await
    .map_err(|error| format!("session_cancel failed: {error}"))?
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
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = validate_cwd(&cwd)?;
        app.state::<AcpManager>().session_set_config(
            &agent_id,
            &cwd,
            &session_id,
            &config_id,
            value,
        )
    })
    .await
    .map_err(|error| format!("session_set_config failed: {error}"))?
}

/// Answer a `session/request_permission` shown via the session channel.
#[tauri::command]
pub fn session_permission_respond(
    app: AppHandle,
    request_id: String,
    option_id: String,
) -> Result<(), String> {
    app.state::<AcpManager>()
        .permission_respond(&request_id, &option_id)
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

/// Artifacts (fileDiff/terminal) produced for a session by fs/terminal
/// client-capability work. Memory-only; empty for a dead connection.
#[tauri::command]
pub async fn session_artifacts(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = validate_cwd(&cwd)?;
        app.state::<AcpManager>()
            .session_artifacts(&agent_id, &cwd, &session_id)
    })
    .await
    .map_err(|error| format!("session_artifacts failed: {error}"))?
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
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = validate_cwd(&cwd)?;
        let cwd_string = cwd.to_string_lossy().into_owned();
        let manager = app.state::<AcpManager>();
        let store = app.state::<MetaStore>();
        // A remote failure must not hide the local index: fall back to
        // Farfold rows only (the protocol tap keeps the wire evidence).
        let remote = manager
            .agent_session_list(&agent_id, &cwd)
            .unwrap_or_default();
        let rows = store.list_sessions_for(&agent_id, &cwd_string)?;

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
    })
    .await
    .map_err(|error| format!("session_list failed: {error}"))?
}

/// `session/close` when supported; always unregisters the session locally.
#[tauri::command]
pub async fn session_close(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = validate_cwd(&cwd)?;
        app.state::<AcpManager>()
            .close_session(&agent_id, &cwd, &session_id)
    })
    .await
    .map_err(|error| format!("session_close failed: {error}"))?
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

/// Delete a session index row (Farfold-side only).
#[tauri::command]
pub fn session_meta_delete(app: AppHandle, session_id: String) -> Result<bool, String> {
    app.state::<MetaStore>().remove_session(&session_id)
}

/// Every meta_store session row, newest first (sidebar session flow).
#[tauri::command]
pub fn session_index_list(app: AppHandle) -> Result<Vec<SessionRow>, String> {
    app.state::<MetaStore>().list_sessions()
}
