//! Explicit history discovery and admission. Only Farfold index metadata is
//! persisted; transcript previews use the existing session_open event channel.

use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Window};

use super::manager::{AcpManager, require_agent_row, validate_cwd_async};
use super::session_index::iso8601_millis;
use crate::meta_store::{AgentRow, MetaStore, SessionRow};

static NEXT_PREVIEW: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    #[serde(flatten)]
    pub session: super::session::SessionOpenResult,
    pub preview_token: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn session_import_preview(
    app: AppHandle,
    window: Window,
    agent_id: String,
    cwd: String,
    session_id: String,
    open_token: String,
    admission_channel: Channel<super::history_admission_commands::HistoryAdmissionPhase>,
    channel: Channel<Value>,
) -> Result<ImportPreview, String> {
    let manager = app.state::<AcpManager>();
    let store = app.state::<MetaStore>();
    let mut request = super::history_admission_commands::HistoryRequest::from_window(
        &manager,
        &window,
        &open_token,
        &agent_id,
        admission_channel,
    )?;
    let mut preparation =
        super::history_admission_commands::HistoryPreparation::new(request.progress.clone());
    if session_id.is_empty() {
        return Err("请选择需要查看的对话".into());
    }
    let row = require_agent_row(&app, &agent_id).await?;
    let cwd = validate_cwd_async(&cwd).await?;
    let token = NEXT_PREVIEW.fetch_add(1, Ordering::Relaxed).to_string();
    request.preparation_bytes =
        std::mem::size_of::<Channel<Value>>() + std::mem::size_of::<String>() + token.len();
    let history = manager
        .admit_cold_history(&row, &cwd, &session_id, &[], &store, None, request)
        .await?;
    preparation.ready();
    open_import_preview(
        &manager,
        &store,
        &row,
        &cwd,
        session_id,
        token,
        channel,
        Some(history),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn open_import_preview(
    manager: &AcpManager,
    store: &MetaStore,
    row: &AgentRow,
    cwd: &Path,
    session_id: String,
    token: String,
    channel: Channel<Value>,
    history: Option<super::history_admission::Permit>,
) -> Result<ImportPreview, String> {
    let delivery_failed = Arc::new(AtomicBool::new(false));
    let failed = delivery_failed.clone();
    let replay_channel = channel.clone();
    let events: super::pump::SessionSink = Arc::new(move |value| {
        if replay_channel.send(value).is_err() {
            failed.store(true, Ordering::SeqCst);
        }
    });
    let opened = manager
        .open_session_owned(
            row,
            cwd,
            Some(session_id),
            vec![],
            events,
            store,
            None,
            Some(token.clone()),
            history,
        )
        .await?;
    let connection = manager.session_connection(&row.id, cwd, &opened.session_id);
    let session_operations = connection
        .as_ref()
        .map(|c| super::session_fork::capabilities(c, &opened.session_id))
        .unwrap_or_default();
    let failed = delivery_failed.load(Ordering::SeqCst) || connection.is_err();
    let source = connection.ok().and_then(|connection| connection.service);
    let preview = ImportPreview {
        preview_token: token.clone(),
        session: super::session::SessionOpenResult {
            session_operations,
            connection_id: opened.connection_id,
            service: source.as_ref().map(|source| source.identity.clone()),
            service_context: source.map(|source| source.revision),
            native_session_id: opened.session_id,
            cwd: cwd.to_string_lossy().into_owned(),
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
            resumed: true,
            warnings: opened.warnings,
        },
    };
    // The pump has drained the load replay into this sink before returning.
    // IPC invoke and Channel callbacks are independent; only an ordered
    // marker on this same Channel proves the renderer consumed that replay.
    if !failed
        && channel
            .send(serde_json::json!({
                "kind": "history_preview_complete",
                "previewToken": token,
            }))
            .is_ok()
    {
        return Ok(preview);
    }
    if discard_unpublished_preview(
        manager,
        &row.id,
        cwd,
        &preview.session.native_session_id,
        &preview.preview_token,
    )
    .is_ok()
    {
        Err("未能完整读取对话，请重试".into())
    } else {
        // Never lose cleanup ownership if rollback itself failed. Without
        // the marker the frontend keeps this token as an incomplete preview.
        Ok(preview)
    }
}

/// Roll back only our not-yet-published, read-only preview. Like an abandoned
/// open operation, this releases its local route and pending forms without
/// closing Agent history or disrupting another conversation's connection.
pub(crate) fn discard_unpublished_preview(
    manager: &AcpManager,
    agent_id: &str,
    cwd: &Path,
    session_id: &str,
    token: &str,
) -> Result<(), String> {
    let _opening = manager
        .opening_sessions
        .reserve(agent_id, cwd, session_id)?;
    let Some(owner) = manager.session_owner(agent_id, cwd, session_id)? else {
        return Ok(());
    };
    let mut sessions = owner.sessions.lock().map_err(|_| "无法读取对话状态")?;
    let Some(entry) = sessions.get(session_id) else {
        return Ok(());
    };
    if entry.preview_token.as_deref() != Some(token) {
        return Err("此预览已结束，请重新打开".into());
    }
    if let Some(entry) = sessions.remove(session_id) {
        let _ = entry.control.send(super::pump::SessionControl::Shutdown);
    }
    Ok(())
}

#[tauri::command]
pub async fn session_import_close(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    preview_token: String,
) -> Result<(), String> {
    // The preview returned a canonical path. Cleanup must remain possible if
    // that folder was removed while the preview was visible.
    let cwd = PathBuf::from(cwd);
    if !cwd.is_absolute() {
        return Err("对话文件夹位置无效".into());
    }
    app.state::<AcpManager>()
        .close_session_owned(&agent_id, &cwd, &session_id, Some(&preview_token))
        .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSession {
    pub native_session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub updated_at: Option<i64>,
    /// Protocol declaration only. Preview must still successfully load history.
    pub can_load: bool,
    pub location_available: bool,
    pub already_added_id: Option<String>,
    pub is_open: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryPage {
    pub status: &'static str,
    pub sessions: Vec<DiscoveredSession>,
    pub next_cursor: Option<String>,
}

fn decode_page(
    response: Value,
    can_load: bool,
    cursor: Option<&str>,
) -> Result<DiscoveryPage, String> {
    let next_cursor = response
        .get("nextCursor")
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or("Agent 返回的翻页信息无效，请重新查找")
        })
        .transpose()?
        .filter(|value| !value.is_empty());
    if next_cursor
        .as_deref()
        .is_some_and(|next| Some(next) == cursor)
    {
        return Err("Agent 返回了重复的翻页结果，请重新查找".into());
    }
    let rows = response
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or("Agent 未返回有效的对话列表，请重试")?;
    let mut seen = std::collections::HashSet::new();
    let mut sessions = Vec::new();
    for row in rows {
        let id = row
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or("Agent 返回的对话信息不完整，请重新查找")?;
        let cwd = row
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|value| Path::new(value).is_absolute())
            .ok_or("Agent 未提供对话的有效文件位置，请重新查找")?;
        if !seen.insert(id) {
            continue;
        }
        sessions.push(DiscoveredSession {
            native_session_id: id.into(),
            cwd: cwd.into(),
            title: row.get("title").and_then(Value::as_str).map(str::to_string),
            updated_at: row
                .get("updatedAt")
                .and_then(Value::as_str)
                .and_then(iso8601_millis),
            can_load,
            location_available: false,
            already_added_id: None,
            is_open: false,
        });
    }
    Ok(DiscoveryPage {
        status: "supported",
        sessions,
        next_cursor,
    })
}

#[tauri::command]
pub async fn session_discover(
    app: AppHandle,
    agent_id: String,
    connection_cwd: Option<String>,
    cwd: Option<String>,
    cursor: Option<String>,
) -> Result<DiscoveryPage, String> {
    let row = require_agent_row(&app, &agent_id).await?;
    let connection_cwd = match connection_cwd {
        Some(cwd) => cwd,
        None => crate::conversation_directory::app_default_working_directory(app.clone()).await?,
    };
    let connection_cwd = validate_cwd_async(&connection_cwd).await?;
    let filter = cwd.map(PathBuf::from);
    if filter.as_ref().is_some_and(|cwd| !cwd.is_absolute()) {
        return Err("请选择完整的文件夹位置".into());
    }
    let manager = app.state::<AcpManager>();
    let store = app.state::<MetaStore>();
    manager.connect(&row, &connection_cwd, &store).await?;
    let response = manager
        .discover_session_page(
            &agent_id,
            &connection_cwd,
            filter.as_deref(),
            cursor.clone(),
        )
        .await?;
    let Some((response, can_load)) = response else {
        return Ok(DiscoveryPage {
            status: "unsupported",
            sessions: vec![],
            next_cursor: None,
        });
    };
    let mut page = decode_page(response, can_load, cursor.as_deref())?;
    let list_agent = agent_id.clone();
    page = store
        .run(move |store| {
            let existing = store.list_sessions()?;
            for entry in &mut page.sessions {
                let path = Path::new(&entry.cwd);
                entry.location_available = path.is_dir();
                if entry.location_available
                    && let Ok(path) = path.canonicalize()
                {
                    entry.cwd = path.to_string_lossy().into_owned();
                }
                // Agent ids identify its own history, independently of the current
                // directory, title or ordering reported by a later query.
                entry.already_added_id = existing
                    .iter()
                    .find(|row| {
                        row.agent_id == list_agent
                            && row.native_session_id.as_deref()
                                == Some(entry.native_session_id.as_str())
                    })
                    .map(|row| row.id.clone());
            }
            Ok(page)
        })
        .await?;
    for entry in &mut page.sessions {
        if entry.location_available {
            entry.is_open = manager
                .session_owner(&agent_id, Path::new(&entry.cwd), &entry.native_session_id)?
                .is_some();
        }
    }
    Ok(page)
}

/// Called only after a successful session_open preview. It does not copy
/// history or claim that the restored model is the original selected model.
#[tauri::command]
pub async fn session_import_commit(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    preview_token: String,
    title: Option<String>,
) -> Result<SessionRow, String> {
    let cwd = validate_cwd_async(&cwd).await?;
    let manager = app.state::<AcpManager>();
    let _opening = manager
        .opening_sessions
        .reserve(&agent_id, &cwd, &session_id)?;
    let connection = manager.session_connection(&agent_id, &cwd, &session_id)?;
    if connection
        .sessions
        .lock()
        .map_err(|_| "无法读取对话状态")?
        .get(&session_id)
        .is_none_or(|entry| entry.preview_token.as_deref() != Some(preview_token.as_str()))
    {
        return Err("此预览已结束，请重新打开后再加入".into());
    }
    app.state::<MetaStore>()
        .run(move |store| {
            store.import_session(
                &agent_id,
                &cwd.to_string_lossy(),
                &session_id,
                title.as_deref(),
            )
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn discovery_keeps_missing_locations_and_original_identity() {
        let page = decode_page(json!({"sessions":[
            {"sessionId":"one","cwd":"/missing/location","title":"Original","updatedAt":"2026-09-24T12:00:00Z"},
            {"sessionId":"one","cwd":"/another/location","title":"Duplicate"}
        ],"nextCursor":"opaque-next"}), true, None).unwrap();
        assert_eq!(page.status, "supported");
        assert_eq!(page.sessions.len(), 1);
        assert_eq!(page.sessions[0].cwd, "/missing/location");
        assert_eq!(page.sessions[0].title.as_deref(), Some("Original"));
        assert!(!page.sessions[0].location_available);
        assert_eq!(page.next_cursor.as_deref(), Some("opaque-next"));
    }

    #[test]
    fn malformed_or_repeated_page_never_becomes_empty_success() {
        for response in [
            json!({}),
            json!({"sessions":null}),
            json!({"sessions":[{"sessionId":"s"}]}),
            json!({"sessions":[{"sessionId":"s","cwd":"relative"}]}),
            json!({"sessions":[],"nextCursor":"same"}),
        ] {
            assert!(decode_page(response, false, Some("same")).is_err());
        }
        let empty = decode_page(json!({"sessions":[]}), false, None).unwrap();
        assert_eq!(empty.status, "supported");
        assert!(empty.sessions.is_empty());
    }
}
