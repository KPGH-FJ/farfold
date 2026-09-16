use crate::{
    host_store::{
        HostStore,
        session_binding_index::{NativeSessionRegistrationInput, register_native_session},
    },
    opencode_protocol::read_session,
    opencode_runtime::{OpenCodeRuntime, connection},
    runtime_registry::{OPENCODE_RUNTIME, RuntimeBinding},
};

pub(crate) fn remember_active_binding(
    runtime: &OpenCodeRuntime,
    host: &HostStore,
    native_session_id: &str,
) -> Result<(), String> {
    remember_active_binding_with_runtime(runtime, host, OPENCODE_RUNTIME, native_session_id)
}

pub(crate) fn remember_active_binding_with_runtime(
    runtime: &OpenCodeRuntime,
    host: &HostStore,
    binding: impl Into<RuntimeBinding>,
    native_session_id: &str,
) -> Result<(), String> {
    let native_session_id = native_session_id.trim();
    let connection = connection(runtime)?;
    let native = read_session(&connection, native_session_id)?;
    let directory = connection.project_path.clone();
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
    register_native_session(
        host,
        binding,
        NativeSessionRegistrationInput {
            native_session_id,
            working_copy_path: &directory,
            title,
            created_at,
            updated_at,
        },
    )?;
    Ok(())
}
