use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::{
    host_store::{
        HostStore,
        session_binding_index::{ManagedSessionRegistrationInput, register_managed_session},
    },
    opencode_protocol::list_sessions,
    opencode_runtime::{OpenCodeRuntime, connection},
    runtime_registry::OPENCODE_RUNTIME,
};

fn valid_native_session_id(value: &str) -> bool {
    value.starts_with("ses_")
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(crate) fn remember_active_binding(
    app: &AppHandle,
    runtime: &OpenCodeRuntime,
    host: &HostStore,
    native_session_id: &str,
) -> Result<(), String> {
    let native_session_id = native_session_id.trim();
    if !valid_native_session_id(native_session_id) {
        return Err("OpenCode native Session ID is invalid".to_string());
    }
    let connection = connection(runtime)?;
    let native = list_sessions(&connection)?
        .into_iter()
        .find(|session| {
            session.get("id").and_then(serde_json::Value::as_str) == Some(native_session_id)
        })
        .ok_or_else(|| {
            "OpenCode native Session is not available from the active connection".to_string()
        })?;
    let directory = native
        .get("directory")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "OpenCode native Session has no Project directory".to_string())?;
    let directory = PathBuf::from(directory)
        .canonicalize()
        .map_err(|error| format!("Cannot resolve OpenCode native Session Project: {error}"))?;
    if directory != connection.project_path {
        return Err("OpenCode native Session belongs to a different active Project".to_string());
    }
    let title = native
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("OpenCode Session");
    let title = if title.trim().is_empty() {
        "OpenCode Session"
    } else {
        title.trim()
    };
    let time = native
        .get("time")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "OpenCode native Session has no timestamps".to_string())?;
    let created_at = time
        .get("created")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "OpenCode native Session creation time is invalid".to_string())?;
    let updated_at = time
        .get("updated")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "OpenCode native Session update time is invalid".to_string())?;
    register_managed_session(
        host,
        OPENCODE_RUNTIME,
        ManagedSessionRegistrationInput {
            native_session_id,
            working_copy_path: &directory,
            title,
            created_at,
            updated_at,
        },
    )?;
    let profile_path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Farfold data directory: {error}"))?;
    crate::host_store::legacy::finalize_opencode_bindings_if_bound(host, &profile_path)?;
    Ok(())
}
