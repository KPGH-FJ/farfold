use reqwest::{Method, StatusCode, blocking::Client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    thread,
    time::Duration,
};
use tauri::{Manager, State};

use crate::interaction_registry::InteractionRegistry;
use crate::opencode_runtime::{
    OpenCodeConnection, OpenCodeRuntime, SharedEvents, connection, push_event,
};
use crate::runtime_event_router::RuntimeEventRouter;

const OPENCODE_USERNAME: &str = "farfold";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RECONNECT_DELAY: Duration = Duration::from_millis(500);
const MAX_SSE_EVENT_BYTES: usize = 1024 * 1024;
const MODEL_SELECTION_METADATA_KEY: &str = "ai.farfold.model-selection";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeModelSelection {
    provider_id: String,
    model_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeModelTarget {
    farfold_session_id: crate::host_ids::FarfoldSessionId,
    native_session_id: crate::host_ids::NativeSessionId,
}

fn stored_model_selection(native: &Value) -> Result<Option<OpenCodeModelSelection>, String> {
    let Some(metadata) = native.get("metadata") else {
        return Ok(None);
    };
    let metadata = metadata
        .as_object()
        .ok_or("OpenCode Session metadata is invalid")?;
    let Some(saved) = metadata.get(MODEL_SELECTION_METADATA_KEY) else {
        return Ok(None);
    };
    if saved.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("OpenCode saved model selection has an unsupported format".into());
    }
    let model: OpenCodeModelSelection =
        serde_json::from_value(saved.get("model").cloned().unwrap_or(Value::Null))
            .map_err(|_| "OpenCode saved model selection is invalid".to_string())?;
    validate_model_selection(&model)?;
    Ok(Some(model))
}

fn validate_model_selection(model: &OpenCodeModelSelection) -> Result<(), String> {
    if model.provider_id.is_empty()
        || model.provider_id.len() > 256
        || model.model_id.is_empty()
        || model.model_id.len() > 512
        || model.provider_id.chars().any(char::is_control)
        || model.model_id.chars().any(char::is_control)
    {
        return Err("OpenCode model selection is invalid".into());
    }
    Ok(())
}

fn model_selection_metadata(
    native: &Value,
    model: &OpenCodeModelSelection,
) -> Result<Value, String> {
    validate_model_selection(model)?;
    let mut metadata = match native.get("metadata") {
        None => serde_json::Map::new(),
        Some(value) => value
            .as_object()
            .cloned()
            .ok_or("OpenCode Session metadata is invalid")?,
    };
    metadata.insert(
        MODEL_SELECTION_METADATA_KEY.into(),
        json!({"version":1,"model":model}),
    );
    Ok(Value::Object(metadata))
}

fn save_model_selection(
    connection: &OpenCodeConnection,
    session_id: &str,
    model: &OpenCodeModelSelection,
) -> Result<OpenCodeModelSelection, String> {
    validate_model_selection(model)?;
    if !fetch_provider_snapshot(connection)?
        .models
        .iter()
        .any(|candidate| {
            candidate.provider_id == model.provider_id && candidate.model_id == model.model_id
        })
    {
        return Err("所选 OpenCode 模型不在当前原生目录中，未更换模型。".into());
    }
    let native = read_session(connection, session_id)?;
    let metadata = model_selection_metadata(&native, model)?;
    let response = request(
        &client(Some(REQUEST_TIMEOUT))?,
        connection,
        Method::PATCH,
        &format!("/session/{session_id}"),
    )
    .json(&json!({"metadata":metadata}))
    .send()
    .map_err(|_| "OpenCode 模型选择的保存结果未知，请重新打开对话核对。".to_string())?;
    let updated = checked_json(response, "Session model selection")?;
    validate_session_identity(&updated, session_id, &connection.project_path)?;
    if updated.get("metadata") != Some(&metadata)
        || stored_model_selection(&updated)?.as_ref() != Some(model)
    {
        return Err("OpenCode 未确认保存的模型选择，请重新打开对话核对。".into());
    }
    Ok(model.clone())
}

fn model_target_connection(
    app: &tauri::AppHandle,
    input: &OpenCodeModelTarget,
) -> Result<OpenCodeConnection, String> {
    let store = app.state::<crate::host_store::HostStore>();
    let target = crate::turn_coordinator::require_opencode_target(
        &store,
        &input.farfold_session_id,
        &input.native_session_id,
    )?;
    let runtime = app.state::<OpenCodeRuntime>();
    let connection = connection(&runtime)?;
    if connection.runtime.product_id != target.runtime_product_id
        || connection.runtime.installation_id != target.installation_id
        || connection.runtime.connection_id != target.connection_id
    {
        return Err("OpenCode started from a different Runtime connection".into());
    }
    if connection.project_path != target.working_copy_path {
        return Err("OpenCode started in a different Working Copy".into());
    }
    Ok(connection)
}

#[tauri::command]
pub async fn host_opencode_model_selection(
    app: tauri::AppHandle,
    input: OpenCodeModelTarget,
) -> Result<Option<OpenCodeModelSelection>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::session_controller::HostSessionController>()
            .exclusive(|| {
                let connection = model_target_connection(&app, &input)?;
                stored_model_selection(&read_session(
                    &connection,
                    input.native_session_id.as_str(),
                )?)
            })
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[tauri::command]
pub async fn host_opencode_model_select(
    app: tauri::AppHandle,
    input: OpenCodeModelTarget,
    model: OpenCodeModelSelection,
) -> Result<OpenCodeModelSelection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::session_controller::HostSessionController>()
            .exclusive(|| {
                let connection = model_target_connection(&app, &input)?;
                app.state::<crate::turn_coordinator::TurnCoordinator>()
                    .require_runtime_idle(
                        connection.runtime.product_id.as_str(),
                        connection.runtime.installation_id.as_str(),
                    )?;
                if session_busy(&connection, input.native_session_id.as_str())? {
                    return Err("OpenCode 会话仍在执行，请等待完成后选择模型。".into());
                }
                save_model_selection(&connection, input.native_session_id.as_str(), &model)
            })
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeAuthProvider {
    id: String,
    name: String,
    connected: bool,
}

// Never derive Debug or Serialize for credential-bearing input.
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OpenCodeAuthChangeInput {
    SaveApiKey {
        provider_id: String,
        api_key: String,
    },
    Remove {
        provider_id: String,
    },
}

fn auth_provider_id(id: &str) -> Result<&str, String> {
    if id.is_empty()
        || id.len() > 200
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid OpenCode Provider ID".to_string());
    }
    Ok(id)
}

fn auth_providers(value: &Value) -> Vec<OpenCodeAuthProvider> {
    let connected = value.get("connected").and_then(Value::as_array);
    let mut providers = value
        .get("all")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|provider| {
            let id = auth_provider_id(provider.get("id")?.as_str()?).ok()?;
            Some(OpenCodeAuthProvider {
                id: id.to_string(),
                name: provider
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                connected: connected
                    .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id))),
            })
        })
        .collect::<Vec<_>>();
    providers.sort_by(|a, b| a.name.cmp(&b.name));
    providers
}

fn fetch_auth_providers(
    connection: &OpenCodeConnection,
) -> Result<Vec<OpenCodeAuthProvider>, String> {
    let response = request(
        &client(Some(REQUEST_TIMEOUT))?,
        connection,
        Method::GET,
        "/provider",
    )
    .send()
    .map_err(|_| "Cannot query OpenCode Providers".to_string())?;
    Ok(auth_providers(&checked_json(response, "Provider query")?))
}

pub(crate) fn change_auth(
    connection: &OpenCodeConnection,
    input: OpenCodeAuthChangeInput,
) -> Result<(), String> {
    let (provider_id, key) = match &input {
        OpenCodeAuthChangeInput::SaveApiKey {
            provider_id,
            api_key,
        } => {
            if api_key.trim().is_empty() || api_key.len() > 16_384 {
                return Err("OpenCode API key is empty or too long".to_string());
            }
            (provider_id, Some(api_key.trim()))
        }
        OpenCodeAuthChangeInput::Remove { provider_id } => (provider_id, None),
    };
    let id = auth_provider_id(provider_id)?;
    if !fetch_auth_providers(connection)?
        .iter()
        .any(|provider| provider.id == id)
    {
        return Err("OpenCode Provider is not in the current catalog".to_string());
    }
    let request = request(
        &client(Some(REQUEST_TIMEOUT))?,
        connection,
        if key.is_some() {
            Method::PUT
        } else {
            Method::DELETE
        },
        &format!("/auth/{id}"),
    );
    let request = if let Some(key) = key {
        request.json(&json!({"type": "api", "key": key}))
    } else {
        request
    };
    let response = request
        .send()
        .map_err(|_| "Cannot update OpenCode credential".to_string())?;
    // Do not return server error bodies: a Provider may echo submitted credentials.
    if !response.status().is_success() {
        return Err(format!(
            "OpenCode credential update returned HTTP {}",
            response.status()
        ));
    }
    if response.json::<bool>().ok() != Some(true) {
        return Err("OpenCode did not confirm the credential change".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn opencode_auth_providers(
    runtime: State<'_, OpenCodeRuntime>,
) -> Result<Vec<OpenCodeAuthProvider>, String> {
    let connection = connection(&runtime)?;
    tauri::async_runtime::spawn_blocking(move || fetch_auth_providers(&connection))
        .await
        .map_err(|_| "OpenCode Provider query was interrupted".to_string())?
}

#[tauri::command]
pub async fn opencode_auth_change(
    app: tauri::AppHandle,
    input: OpenCodeAuthChangeInput,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<crate::session_controller::HostSessionController>();
        controller.exclusive(|| {
            let connection = connection(&app.state::<OpenCodeRuntime>())?;
            app.state::<crate::turn_coordinator::TurnCoordinator>()
                .require_runtime_idle(
                    connection.runtime.product_id.as_str(),
                    connection.runtime.installation_id.as_str(),
                )?;
            change_auth(&connection, input)
        })
    })
    .await
    .map_err(|_| "OpenCode credential update was interrupted".to_string())?
}

enum BoundedSseLine {
    Eof,
    Line(String),
    Oversized { byte_count_at_least: usize },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeProviderModel {
    provider_id: String,
    model_id: String,
    name: String,
    status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeProviderSnapshot {
    connected_provider_ids: Vec<String>,
    models: Vec<OpenCodeProviderModel>,
    provider: &'static str,
    model: &'static str,
    account: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ProviderReadiness {
    pub(crate) provider: &'static str,
    pub(crate) model: &'static str,
    pub(crate) account: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodePermissionResponseInput {
    session_id: String,
    permission_id: String,
    response: OpenCodePermissionDecision,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OpenCodePermissionDecision {
    Once,
    Always,
    Reject,
}

impl OpenCodePermissionDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::Reject => "reject",
        }
    }
}

fn client(timeout: Option<Duration>) -> Result<Client, String> {
    crate::transport_security::ensure_rustls_crypto_provider();
    let mut builder = Client::builder().connect_timeout(Duration::from_secs(2));
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    builder
        .build()
        .map_err(|error| format!("Cannot create OpenCode HTTP client: {error}"))
}

fn request(
    client: &Client,
    connection: &OpenCodeConnection,
    method: Method,
    path: &str,
) -> reqwest::blocking::RequestBuilder {
    client
        .request(method, format!("{}{path}", connection.endpoint))
        .basic_auth(OPENCODE_USERNAME, Some(&connection.password))
        .query(&[(
            "directory",
            connection.project_path.to_string_lossy().as_ref(),
        )])
}

fn checked_json(response: reqwest::blocking::Response, operation: &str) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("OpenCode {operation} returned HTTP {status}"));
    }
    response
        .json()
        .map_err(|error| format!("OpenCode {operation} returned invalid JSON: {error}"))
}

// OpenCode 1.15.13 config.providers returns the same Provider.Service.list entries
// identified as connected by provider.list, without serializing its full ModelsDev catalog.
fn provider_snapshot(value: &Value) -> Result<OpenCodeProviderSnapshot, String> {
    let providers = value
        .get("providers")
        .and_then(Value::as_array)
        .ok_or("OpenCode configured Provider directory is invalid")?;
    let mut connected_provider_ids = Vec::with_capacity(providers.len());
    let mut models = Vec::new();
    for provider in providers {
        let provider_id = provider
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("OpenCode configured Provider has no identity")?;
        let native_models = provider
            .get("models")
            .and_then(Value::as_object)
            .ok_or("OpenCode configured Provider has no model directory")?;
        connected_provider_ids.push(provider_id.to_string());
        for (model_id, model) in native_models {
            models.push(OpenCodeProviderModel {
                provider_id: provider_id.to_string(),
                model_id: model_id.clone(),
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(model_id)
                    .to_string(),
                status: model
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
            });
        }
    }
    Ok(OpenCodeProviderSnapshot {
        provider: if connected_provider_ids.is_empty() {
            "not_ready"
        } else {
            "ready"
        },
        model: if models.is_empty() {
            "not_ready"
        } else {
            "ready"
        },
        account: "unknown",
        connected_provider_ids,
        models,
    })
}

fn fetch_provider_snapshot(
    connection: &OpenCodeConnection,
) -> Result<OpenCodeProviderSnapshot, String> {
    let client = client(Some(REQUEST_TIMEOUT))?;
    let response = request(&client, connection, Method::GET, "/config/providers")
        .send()
        .map_err(|error| format!("Cannot query OpenCode Providers: {error}"))?;
    provider_snapshot(&checked_json(response, "Provider query")?)
}

#[cfg(test)]
pub(crate) fn create_lifecycle_test_session(
    connection: &OpenCodeConnection,
) -> Result<Value, String> {
    let client = client(Some(REQUEST_TIMEOUT))?;
    let response = request(&client, connection, Method::POST, "/session")
        .json(&json!({"title": "Farfold lifecycle test"}))
        .send()
        .map_err(|error| format!("Cannot prepare OpenCode test Session: {error}"))?;
    checked_json(response, "Test Session create")
}

/// Read a bound identity through the native per-session endpoint. A paged discovery
/// list cannot prove that an older Session is missing.
pub(crate) fn read_session(
    connection: &OpenCodeConnection,
    session_id: &str,
) -> Result<Value, String> {
    if !valid_native_id(session_id, "ses") {
        return Err("Invalid OpenCode Session ID".into());
    }
    let response = request(
        &client(Some(REQUEST_TIMEOUT))?,
        connection,
        Method::GET,
        &format!("/session/{session_id}"),
    )
    .send()
    .map_err(|error| format!("Cannot read OpenCode Session: {error}"))?;
    let native = checked_json(response, "Session read")?;
    validate_session_identity(&native, session_id, &connection.project_path)?;
    Ok(native)
}

fn validate_session_identity(
    native: &Value,
    session_id: &str,
    project_path: &std::path::Path,
) -> Result<(), String> {
    if native.get("id").and_then(Value::as_str) != Some(session_id) {
        return Err("OpenCode returned a different native Session ID".into());
    }
    let directory = native
        .get("directory")
        .and_then(Value::as_str)
        .ok_or("OpenCode native Session has no Project directory")?;
    let directory = std::path::Path::new(directory)
        .canonicalize()
        .map_err(|error| format!("Cannot resolve OpenCode native Session Project: {error}"))?;
    if directory != project_path {
        return Err("OpenCode native Session belongs to a different Working Copy".into());
    }
    Ok(())
}

pub(crate) fn session_busy(
    connection: &OpenCodeConnection,
    session_id: &str,
) -> Result<bool, String> {
    if !valid_native_id(session_id, "ses") {
        return Err("Invalid OpenCode Session ID".into());
    }
    let client = client(Some(REQUEST_TIMEOUT))?;
    let response = request(&client, connection, Method::GET, "/session/status")
        .send()
        .map_err(|_| "Cannot read OpenCode Session status".to_string())?;
    parse_session_busy(&checked_json(response, "Session status")?, session_id)
}

fn parse_session_busy(value: &Value, session_id: &str) -> Result<bool, String> {
    let statuses = value
        .as_object()
        .ok_or("OpenCode status was not an object")?;
    match statuses.get(session_id) {
        None => Ok(false), // Pinned SessionStatus.list omits idle sessions.
        Some(status) => match status.get("type").and_then(Value::as_str) {
            Some("busy" | "retry") => Ok(true),
            Some("idle") => Ok(false),
            _ => Err("Unrecognized OpenCode Session status".into()),
        },
    }
}

pub(crate) fn session_messages(
    connection: &OpenCodeConnection,
    session_id: &str,
    limit: Option<u32>,
) -> Result<Vec<Value>, String> {
    if !valid_native_id(session_id, "ses") {
        return Err("OpenCode returned an invalid Session ID".to_string());
    }
    let client = client(Some(REQUEST_TIMEOUT))?;
    let mut outgoing = request(
        &client,
        connection,
        Method::GET,
        &format!("/session/{session_id}/message"),
    );
    if let Some(limit) = limit {
        outgoing = outgoing.query(&[("limit", limit.min(1_000))]);
    }
    let response = outgoing
        .send()
        .map_err(|error| format!("Cannot read OpenCode Session messages: {error}"))?;
    serde_json::from_value(checked_json(response, "Session messages")?)
        .map_err(|error| format!("OpenCode Session messages were not an array: {error}"))
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PromptDispatch {
    Accepted,
    Unknown(String),
}

pub(crate) fn prompt_text(
    connection: &OpenCodeConnection,
    session_id: &str,
    provider_id: &str,
    model_id: &str,
    text: &str,
    system: Option<&str>,
) -> Result<PromptDispatch, String> {
    if !valid_native_id(session_id, "ses") {
        return Err("OpenCode returned an invalid Session ID".to_string());
    }
    if provider_id.trim().is_empty() || model_id.trim().is_empty() {
        return Err("OpenCode prompt requires a Provider and model".to_string());
    }
    if text.is_empty() {
        return Err("OpenCode prompt cannot be empty".to_string());
    }
    if system.is_some_and(|value| value.trim().is_empty() || value.chars().count() > 8_000) {
        return Err("OpenCode system input must contain between 1 and 8000 characters".to_string());
    }
    let client = client(Some(REQUEST_TIMEOUT))?;
    let body = prompt_body(provider_id, model_id, text, system);
    let response = request(
        &client,
        connection,
        Method::POST,
        &format!("/session/{session_id}/prompt_async"),
    )
    .json(&body)
    .send();
    match response {
        Ok(response) if response.status() == StatusCode::NO_CONTENT => Ok(PromptDispatch::Accepted),
        // These statuses reject the request before the pinned prompt_async handler starts it.
        Ok(response) if matches!(response.status().as_u16(), 400 | 401 | 403 | 404 | 422) => Err(
            format!("OpenCode prompt rejected with HTTP {}", response.status()),
        ),
        Ok(response) => Ok(PromptDispatch::Unknown(format!(
            "OpenCode 提交返回 HTTP {}，是否已接收尚未确认。",
            response.status()
        ))),
        Err(_) => Ok(PromptDispatch::Unknown(
            "OpenCode 提交响应丢失，是否已接收尚未确认。".to_string(),
        )),
    }
}

fn prompt_body(provider_id: &str, model_id: &str, text: &str, system: Option<&str>) -> Value {
    let mut body = json!({
        "model": {
            "providerID": provider_id,
            "modelID": model_id,
        },
        "parts": [{ "type": "text", "text": text }],
    });
    if let Some(system) = system {
        body["system"] = json!(system);
    }
    body
}

pub(crate) fn abort_session(
    connection: &OpenCodeConnection,
    session_id: &str,
) -> Result<bool, String> {
    if !valid_native_id(session_id, "ses") {
        return Err("OpenCode returned an invalid Session ID".to_string());
    }
    let client = client(Some(REQUEST_TIMEOUT))?;
    let response = request(
        &client,
        connection,
        Method::POST,
        &format!("/session/{session_id}/abort"),
    )
    .send()
    .map_err(|error| format!("Cannot abort OpenCode Session: {error}"))?;
    serde_json::from_value(checked_json(response, "Session abort")?)
        .map_err(|error| format!("OpenCode Session abort did not return a boolean: {error}"))
}

pub(crate) fn provider_readiness(
    connection: OpenCodeConnection,
) -> Result<ProviderReadiness, String> {
    let snapshot = fetch_provider_snapshot(&connection)?;
    Ok(ProviderReadiness {
        provider: snapshot.provider,
        model: snapshot.model,
        account: snapshot.account,
    })
}

fn valid_native_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validated_native_id(value: String, prefix: &str, label: &str) -> Result<String, String> {
    if valid_native_id(&value, prefix) {
        Ok(value)
    } else {
        Err(format!("OpenCode returned an invalid {label}"))
    }
}

fn push_sse_data(
    events: &SharedEvents,
    router: Option<&RuntimeEventRouter>,
    connection: &OpenCodeConnection,
    generation: u64,
    data: &str,
) {
    match serde_json::from_str::<Value>(data) {
        Ok(payload) => push_event(
            events,
            router,
            &connection.runtime,
            json!({ "generation": generation, "kind": "sse", "payload": payload }),
        ),
        Err(error) => push_event(
            events,
            router,
            &connection.runtime,
            json!({
                "generation": generation,
                "kind": "protocol_error",
                "payload": { "error": error.to_string(), "data": data }
            }),
        ),
    }
}

fn read_bounded_sse_line<R: BufRead>(reader: &mut R) -> Result<BoundedSseLine, String> {
    let mut bytes = Vec::new();
    let read = std::io::Read::take(reader, (MAX_SSE_EVENT_BYTES + 2) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| format!("Cannot read OpenCode SSE: {error}"))?;
    if read == 0 {
        return Ok(BoundedSseLine::Eof);
    }
    while bytes
        .last()
        .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
    {
        bytes.pop();
    }
    if bytes.len() > MAX_SSE_EVENT_BYTES {
        return Ok(BoundedSseLine::Oversized {
            byte_count_at_least: bytes.len(),
        });
    }
    String::from_utf8(bytes)
        .map(BoundedSseLine::Line)
        .map_err(|_| "OpenCode SSE contained invalid UTF-8".to_string())
}

fn push_oversized_sse_event(
    events: &SharedEvents,
    router: Option<&RuntimeEventRouter>,
    connection: &OpenCodeConnection,
    generation: u64,
    byte_count_at_least: usize,
) {
    push_event(
        events,
        router,
        &connection.runtime,
        json!({
            "generation": generation,
            "kind": "oversized_event",
            "payload": {
                "byteLengthAtLeast": byte_count_at_least,
                "reason": "sse_event_exceeds_host_limit"
            }
        }),
    );
}

fn stream_once(
    connection: &OpenCodeConnection,
    events: &SharedEvents,
    router: Option<&RuntimeEventRouter>,
) -> Result<(), String> {
    let client = client(None)?;
    let response = client
        .get(format!("{}/global/event", connection.endpoint))
        .basic_auth(OPENCODE_USERNAME, Some(&connection.password))
        .send()
        .map_err(|error| format!("Cannot connect to OpenCode SSE: {error}"))?;
    if response.status() != StatusCode::OK {
        return Err(format!("OpenCode SSE returned HTTP {}", response.status()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type.starts_with("text/event-stream") {
        return Err(format!(
            "OpenCode SSE returned unexpected content type {content_type}"
        ));
    }
    let mut data = Vec::new();
    let mut data_byte_count = 0_usize;
    let mut reader = BufReader::new(response);
    loop {
        if connection
            .generation_clock
            .load(std::sync::atomic::Ordering::SeqCst)
            != connection.generation
        {
            return Ok(());
        }
        let line = match read_bounded_sse_line(&mut reader)? {
            BoundedSseLine::Eof => break,
            BoundedSseLine::Line(line) => line,
            BoundedSseLine::Oversized {
                byte_count_at_least,
            } => {
                push_oversized_sse_event(
                    events,
                    router,
                    connection,
                    connection.generation,
                    byte_count_at_least,
                );
                return Ok(());
            }
        };
        if let Some(value) = line.strip_prefix("data:") {
            let value = value.trim_start();
            let separator_bytes = usize::from(!data.is_empty());
            data_byte_count = data_byte_count
                .saturating_add(separator_bytes)
                .saturating_add(value.len());
            if data_byte_count > MAX_SSE_EVENT_BYTES {
                push_oversized_sse_event(
                    events,
                    router,
                    connection,
                    connection.generation,
                    data_byte_count,
                );
                return Ok(());
            }
            data.push(value.to_string());
        } else if line.is_empty() && !data.is_empty() {
            push_sse_data(
                events,
                router,
                connection,
                connection.generation,
                &data.join("\n"),
            );
            data.clear();
            data_byte_count = 0;
        }
    }
    if !data.is_empty() {
        push_sse_data(
            events,
            router,
            connection,
            connection.generation,
            &data.join("\n"),
        );
    }
    Err("OpenCode event stream ended; native state must be reconciled".to_string())
}

pub(crate) fn start_event_stream(
    connection: OpenCodeConnection,
    events: SharedEvents,
    router: Option<RuntimeEventRouter>,
) {
    thread::spawn(move || {
        while connection
            .generation_clock
            .load(std::sync::atomic::Ordering::SeqCst)
            == connection.generation
        {
            if let Err(error) = stream_once(&connection, &events, router.as_ref()) {
                if connection
                    .generation_clock
                    .load(std::sync::atomic::Ordering::SeqCst)
                    != connection.generation
                {
                    break;
                }
                push_event(
                    &events,
                    router.as_ref(),
                    &connection.runtime,
                    json!({
                        "generation": connection.generation,
                        "kind": "transport_error",
                        "payload": { "error": error }
                    }),
                );
            }
            if connection
                .generation_clock
                .load(std::sync::atomic::Ordering::SeqCst)
                != connection.generation
            {
                break;
            }
            thread::sleep(RECONNECT_DELAY);
        }
    });
}

#[tauri::command]
pub async fn opencode_provider_snapshot(
    app: tauri::AppHandle,
) -> Result<OpenCodeProviderSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<OpenCodeRuntime>();
        crate::performance_trace::measure(
            &app,
            crate::performance_trace::Operation::OpenCodeProviders,
            || fetch_provider_snapshot(&connection(&runtime)?),
        )
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[tauri::command]
pub async fn opencode_session_messages(
    app: tauri::AppHandle,
    session_id: String,
    limit: Option<u32>,
) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<OpenCodeRuntime>();
        let connection = connection(&runtime)?;
        let session_id = validated_native_id(session_id, "ses", "Session ID")?;
        crate::performance_trace::measure(
            &app,
            crate::performance_trace::Operation::OpenCodeHistory,
            || session_messages(&connection, &session_id, limit),
        )
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[tauri::command]
pub async fn opencode_permission_respond(
    app: tauri::AppHandle,
    input: OpenCodePermissionResponseInput,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<OpenCodeRuntime>();
        let interactions = app.state::<InteractionRegistry>();
        let connection = connection(&runtime)?;
        let session_id = validated_native_id(input.session_id, "ses", "Session ID")?;
        let permission_id = validated_native_id(input.permission_id, "per", "Permission ID")?;
        let client = client(Some(REQUEST_TIMEOUT))?;
        interactions.begin_response(
            connection.runtime.clone(),
            connection.generation,
            &permission_id,
            Some(&session_id),
        )?;
        let result = request(
            &client,
            &connection,
            Method::POST,
            &format!("/session/{session_id}/permissions/{permission_id}"),
        )
        .json(&json!({ "response": input.response.as_str() }))
        .send()
        .map_err(|error| format!("Cannot answer OpenCode permission request: {error}"))
        .and_then(|response| {
            if response.status() == StatusCode::NO_CONTENT {
                Ok(Value::Null)
            } else {
                checked_json(response, "Permission response")
            }
        });
        interactions.finish_response(
            connection.runtime,
            connection.generation,
            &permission_id,
            result.is_ok(),
        )?;
        result
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        BoundedSseLine, MAX_SSE_EVENT_BYTES, client, prompt_body, provider_snapshot, push_sse_data,
        read_bounded_sse_line, valid_native_id,
    };
    use serde_json::json;
    use std::{
        collections::VecDeque,
        io::Cursor,
        sync::{Arc, Mutex},
        time::Duration,
    };

    #[test]
    fn model_selection_preserves_unrelated_metadata_and_rejects_corrupt_saved_choices() {
        let model = super::OpenCodeModelSelection {
            provider_id: "zai".into(),
            model_id: "glm-4.5-air".into(),
        };
        let native = json!({"metadata":{"other-client":{"keep":[1,2]}, "note":"unchanged"}});
        let metadata = super::model_selection_metadata(&native, &model).unwrap();
        assert_eq!(metadata["other-client"], native["metadata"]["other-client"]);
        assert_eq!(metadata["note"], "unchanged");
        assert_eq!(
            super::stored_model_selection(&json!({"metadata":metadata})).unwrap(),
            Some(model)
        );
        assert_eq!(super::stored_model_selection(&native).unwrap(), None);
        for invalid in [
            json!({"version":2,"model":{"providerId":"zai","modelId":"new-model"}}),
            json!({"version":1,"model":{"providerId":"zai","modelId":""}}),
            json!({"version":1}),
        ] {
            assert!(
                super::stored_model_selection(
                    &json!({"metadata":{super::MODEL_SELECTION_METADATA_KEY:invalid}})
                )
                .is_err()
            );
        }
        assert!(
            super::model_selection_metadata(
                &json!({"metadata":[]}),
                &super::OpenCodeModelSelection {
                    provider_id: "zai".into(),
                    model_id: "air".into()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn model_selection_boundary_does_not_accept_arbitrary_native_metadata_or_commands() {
        for extra in ["metadata", "directory", "command"] {
            let mut input = json!({"farfoldSessionId":"session-1","nativeSessionId":"ses_1"});
            input[extra] = json!("unexpected");
            assert!(serde_json::from_value::<super::OpenCodeModelTarget>(input).is_err());
        }
        assert!(
            serde_json::from_value::<super::OpenCodeModelSelection>(
                json!({"providerId":"zai","modelId":"air","permission":"allow"})
            )
            .is_err()
        );
    }

    #[test]
    fn model_choice_is_written_only_through_native_session_metadata_with_catalog_and_identity_checks()
     {
        use std::io::{BufRead, BufReader, Read, Write};
        let project = tempfile::tempdir().unwrap();
        let project_path = project.path().canonicalize().unwrap();
        let native =
            json!({"id":"ses_model", "directory":project_path, "metadata":{"unrelated":"keep"}});
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for index in 0..3 {
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "missing native model request"
                            );
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let response=match index {
                    0=> {assert!(first.starts_with("GET /config/providers?"));json!({"providers":[{"id":"zai","models":{"air":{"id":"air","name":"Air"}}}]})},
                    1=> {assert!(first.starts_with("GET /session/ses_model?"));native.clone()},
                    _=> {
                        assert!(first.starts_with("PATCH /session/ses_model?"));
                        let body:serde_json::Value=serde_json::from_slice(&body).unwrap();
                        assert_eq!(body.as_object().unwrap().len(),1);
                        assert_eq!(body["metadata"]["unrelated"],"keep");
                        assert_eq!(body["metadata"][super::MODEL_SELECTION_METADATA_KEY]["model"],json!({"providerId":"zai","modelId":"air"}));
                        let mut updated=native.clone();updated["metadata"]=body["metadata"].clone();updated
                    }
                }.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
        });
        let connection = crate::opencode_runtime::OpenCodeConnection {
            runtime: crate::runtime_registry::RuntimeBinding::from(
                crate::runtime_registry::OPENCODE_RUNTIME,
            ),
            endpoint,
            password: "test".into(),
            project_path,
            generation: 1,
            generation_clock: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        };
        let model = super::OpenCodeModelSelection {
            provider_id: "zai".into(),
            model_id: "air".into(),
        };
        let result = super::save_model_selection(&connection, "ses_model", &model);
        server.join().unwrap();
        assert_eq!(result.unwrap(), model);
    }

    #[test]
    fn bound_session_read_does_not_depend_on_discovery_list_membership() {
        use std::io::{BufRead, BufReader, Write};
        let project = tempfile::tempdir().unwrap();
        let project_path = project.path().canonicalize().unwrap();
        let native = json!({"id":"ses_old", "directory":project_path, "futureField":{"kept":true}});
        let expected = native.clone();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            // This old bound Session is absent from the current discovery page.
            let body = if first.starts_with("GET /session/ses_old?") {
                native.to_string()
            } else {
                "[]".to_string()
            };
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            first
        });
        let connection = crate::opencode_runtime::OpenCodeConnection {
            runtime: crate::runtime_registry::RuntimeBinding::from(
                crate::runtime_registry::OPENCODE_RUNTIME,
            ),
            endpoint,
            password: "test".into(),
            project_path,
            generation: 1,
            generation_clock: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        };
        let result = super::read_session(&connection, "ses_old");
        let request = server.join().unwrap();
        assert_eq!(result.unwrap(), expected);
        assert!(request.starts_with("GET /session/ses_old?directory="));
    }

    #[test]
    fn bound_session_identity_rejects_wrong_id_directory_and_missing_metadata() {
        let project = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let cwd = project.path().canonicalize().unwrap();
        for invalid in [
            json!({"id":"ses_other","directory":cwd}),
            json!({"id":"ses_old","directory":other.path()}),
            json!({"id":"ses_old"}),
            json!({"id":"ses_old","directory":project.path().join("missing")}),
            json!([]),
        ] {
            assert!(super::validate_session_identity(&invalid, "ses_old", &cwd).is_err());
        }
        let alias = project.path().join("alias");
        std::os::unix::fs::symlink(&cwd, &alias).unwrap();
        assert!(
            super::validate_session_identity(
                &json!({"id":"ses_old","directory":alias}),
                "ses_old",
                &cwd
            )
            .is_ok()
        );
    }

    #[test]
    fn bound_session_read_preserves_not_found_without_list_or_create_fallback() {
        use std::io::{BufRead, BufReader, Write};
        let project = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut first = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut first)
                .unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            first
        });
        let connection = crate::opencode_runtime::OpenCodeConnection {
            runtime: crate::runtime_registry::RuntimeBinding::from(
                crate::runtime_registry::OPENCODE_RUNTIME,
            ),
            endpoint,
            password: "test".into(),
            project_path: project.path().canonicalize().unwrap(),
            generation: 1,
            generation_clock: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        };
        let result = super::read_session(&connection, "ses_missing");
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /session/ses_missing?"));
        assert_eq!(
            result.unwrap_err(),
            "OpenCode Session read returned HTTP 404 Not Found"
        );
        for invalid in ["../session", "ses_old?directory=other", "ses_old/path"] {
            assert_eq!(
                super::read_session(&connection, invalid).unwrap_err(),
                "Invalid OpenCode Session ID"
            );
        }
    }

    #[test]
    fn prompt_response_loss_after_body_receipt_is_unknown_not_rejected() {
        use std::io::{BufRead, BufReader, Read};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            assert!(first.starts_with("POST /session/ses_fixture/prompt_async?"));
            let mut length = 0;
            loop {
                let mut line = String::new();
                assert!(
                    reader.read_line(&mut line).unwrap() > 0,
                    "request ended before headers"
                );
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap()["parts"][0]["text"],
                "keep this draft"
            );
            // Server consumed the request; intentionally close without its HTTP acknowledgement.
        });
        let connection = crate::opencode_runtime::OpenCodeConnection {
            runtime: crate::runtime_registry::RuntimeBinding::from(
                crate::runtime_registry::OPENCODE_RUNTIME,
            ),
            endpoint,
            password: "test".into(),
            project_path: "/tmp".into(),
            generation: 1,
            generation_clock: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        };
        let result = super::prompt_text(
            &connection,
            "ses_fixture",
            "test",
            "test",
            "keep this draft",
            None,
        );
        server.join().unwrap();
        assert!(matches!(result, Ok(super::PromptDispatch::Unknown(_))));
    }

    #[test]
    fn official_status_omits_idle_but_malformed_status_is_not_idle() {
        assert_eq!(super::parse_session_busy(&json!({}), "ses_1"), Ok(false));
        assert_eq!(
            super::parse_session_busy(&json!({"ses_1":{"type":"retry"}}), "ses_1"),
            Ok(true)
        );
        assert_eq!(
            super::parse_session_busy(&json!({"ses_other":{"type":"busy"}}), "ses_1"),
            Ok(false)
        );
        assert!(super::parse_session_busy(&json!([]), "ses_1").is_err());
        assert!(super::parse_session_busy(&json!({"ses_1":{"type":"future"}}), "ses_1").is_err());
    }

    #[test]
    fn auth_input_rejects_path_injection_and_empty_keys_before_network_access() {
        for id in [
            "",
            "../config",
            "openrouter?key=x",
            "openrouter/auth",
            "openrouter%2fconfig",
        ] {
            assert!(super::auth_provider_id(id).is_err());
        }
        let providers = super::auth_providers(&json!({
            "connected": ["openrouter"],
            "all": [{"id":"openrouter","name":"OpenRouter","secret":"not-projected"},{"id":"../config"}]
        }));
        assert_eq!(providers.len(), 1);
        assert!(providers[0].connected);
        assert!(
            !serde_json::to_string(&providers)
                .unwrap()
                .contains("not-projected")
        );
        let connection = crate::opencode_runtime::OpenCodeConnection {
            runtime: crate::runtime_registry::RuntimeBinding::from(
                crate::runtime_registry::OPENCODE_RUNTIME,
            ),
            endpoint: "http://127.0.0.1:1".to_string(),
            password: "fixture".to_string(),
            project_path: std::path::PathBuf::from("/tmp"),
            generation: 1,
            generation_clock: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        };
        assert!(
            super::change_auth(
                &connection,
                super::OpenCodeAuthChangeInput::SaveApiKey {
                    provider_id: "openrouter".to_string(),
                    api_key: "  ".to_string(),
                }
            )
            .unwrap_err()
            .contains("empty")
        );
    }

    #[test]
    fn auth_changes_use_official_methods_and_do_not_echo_server_errors() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;
        for (status, remove) in [(200, false), (400, false), (200, true), (400, true)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                for index in 0..2 {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut reader = BufReader::new(&mut stream);
                    let mut request_line = String::new();
                    reader.read_line(&mut request_line).unwrap();
                    let mut length = 0;
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" {
                            break;
                        }
                        if let Some(value) =
                            line.to_ascii_lowercase().strip_prefix("content-length:")
                        {
                            length = value.trim().parse::<usize>().unwrap();
                        }
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    let (code, response) = if index == 0 {
                        assert!(request_line.starts_with("GET /provider?"));
                        (200, r#"{"all":[{"id":"openrouter"}],"connected":[]}"#)
                    } else {
                        if remove {
                            assert!(request_line.starts_with("DELETE /auth/openrouter?"));
                            assert!(body.is_empty());
                        } else {
                            assert!(request_line.starts_with("PUT /auth/openrouter?"));
                            assert_eq!(
                                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                                json!({"type":"api","key":"fixture-secret"})
                            );
                        }
                        (
                            status,
                            if status == 200 {
                                "true"
                            } else {
                                r#"{"error":"fixture-secret"}"#
                            },
                        )
                    };
                    write!(stream, "HTTP/1.1 {code} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
                }
            });
            let connection = crate::opencode_runtime::OpenCodeConnection {
                runtime: crate::runtime_registry::RuntimeBinding::from(
                    crate::runtime_registry::OPENCODE_RUNTIME,
                ),
                endpoint,
                password: "local-test".into(),
                project_path: "/tmp".into(),
                generation: 1,
                generation_clock: Arc::new(std::sync::atomic::AtomicU64::new(1)),
            };
            let result = super::change_auth(
                &connection,
                if remove {
                    super::OpenCodeAuthChangeInput::Remove {
                        provider_id: "openrouter".into(),
                    }
                } else {
                    super::OpenCodeAuthChangeInput::SaveApiKey {
                        provider_id: "openrouter".into(),
                        api_key: "fixture-secret".into(),
                    }
                },
            );
            server.join().unwrap();
            if status == 200 {
                assert!(result.is_ok());
            } else {
                let error = result.unwrap_err();
                assert!(error.contains("400"));
                assert!(!error.contains("fixture-secret"));
            }
        }
    }

    #[test]
    fn auth_change_requires_an_explicit_action_and_rejects_ambiguous_deletion() {
        use super::OpenCodeAuthChangeInput;
        assert!(
            serde_json::from_value::<OpenCodeAuthChangeInput>(
                json!({"providerId":"openrouter","apiKey":"fixture"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<OpenCodeAuthChangeInput>(
                json!({"action":"remove","providerId":"openrouter","apiKey":"fixture"})
            )
            .is_err()
        );
        assert!(matches!(
            serde_json::from_value::<OpenCodeAuthChangeInput>(
                json!({"action":"remove","providerId":"openrouter"})
            )
            .unwrap(),
            OpenCodeAuthChangeInput::Remove { .. }
        ));
    }

    #[test]
    fn provider_readiness_uses_the_native_configured_directory() {
        let snapshot = provider_snapshot(&json!({
            "providers": [{ "id": "zai", "models": {
                "glm-4.5-air": { "name": "GLM-4.5-Air", "status": "active" }
            }}],
            "default": {"zai":"some-other-model"}
        }))
        .unwrap();
        assert_eq!(snapshot.provider, "ready");
        assert_eq!(snapshot.model, "ready");
        assert_eq!(snapshot.account, "unknown");
        assert_eq!(snapshot.connected_provider_ids, ["zai"]);
        assert_eq!(snapshot.models.len(), 1);
        assert_eq!(snapshot.models[0].model_id, "glm-4.5-air");
    }

    #[test]
    fn malformed_configured_directory_is_not_reported_as_unconfigured() {
        for invalid in [
            json!({}),
            json!({"providers":null}),
            json!({"all":[],"connected":[]}),
            json!({"providers":[{"models":{}}]}),
            json!({"providers":[{"id":"zai"}]}),
        ] {
            assert!(provider_snapshot(&invalid).is_err());
        }
        let empty = provider_snapshot(&json!({"providers":[],"default":{}})).unwrap();
        assert_eq!(empty.provider, "not_ready");
        assert_eq!(empty.model, "not_ready");
        assert_eq!(empty.account, "unknown");
    }

    #[test]
    fn provider_read_uses_the_configured_native_endpoint() {
        use std::io::{BufRead, BufReader, Write};
        let project = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            let body = if first.starts_with("GET /config/providers?") {
                r#"{"providers":[{"id":"zai","models":{"glm-4.5-air":{"name":"GLM-4.5-Air"}}}],"default":{"zai":"different"}}"#
            } else {
                r#"{"all":[],"connected":[]}"#
            };
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            first
        });
        let connection = crate::opencode_runtime::OpenCodeConnection {
            runtime: crate::runtime_registry::RuntimeBinding::from(
                crate::runtime_registry::OPENCODE_RUNTIME,
            ),
            endpoint,
            password: "test".into(),
            project_path: project.path().canonicalize().unwrap(),
            generation: 1,
            generation_clock: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        };
        let result = super::fetch_provider_snapshot(&connection);
        let request = server.join().unwrap();
        let snapshot = result.unwrap();
        assert!(request.starts_with("GET /config/providers?directory="));
        assert_eq!(snapshot.models[0].model_id, "glm-4.5-air");
    }

    #[test]
    fn opencode_http_client_has_a_configured_crypto_provider() {
        client(Some(Duration::from_millis(50)))
            .expect("OpenCode HTTP client must not depend on an unselected rustls provider");
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn sse_reader_bounds_allocation_before_json_parsing() {
        let source = vec![b'x'; MAX_SSE_EVENT_BYTES + 128];
        let mut reader = Cursor::new(source);
        let line = read_bounded_sse_line(&mut reader).unwrap();
        assert!(matches!(line, BoundedSseLine::Oversized { .. }));
        assert_eq!(reader.position(), (MAX_SSE_EVENT_BYTES + 2) as u64);
    }

    #[test]
    fn native_ids_cannot_escape_the_official_path_segment() {
        assert!(valid_native_id("ses_abc-123", "ses"));
        assert!(valid_native_id("per_abc123", "per"));
        assert!(!valid_native_id("ses_abc/../../provider", "ses"));
        assert!(!valid_native_id("wrong_abc", "ses"));
    }

    #[test]
    fn sse_queue_preserves_unknown_payloads_losslessly() {
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let router = crate::runtime_event_router::RuntimeEventRouter::default();
        let source = json!({
            "directory": "/tmp/project",
            "payload": { "type": "future.event", "properties": { "opaque": 7 } }
        });
        let connection = crate::opencode_runtime::OpenCodeConnection {
            runtime: crate::runtime_registry::RuntimeBinding::from(
                crate::runtime_registry::OPENCODE_RUNTIME,
            ),
            endpoint: "http://127.0.0.1:1".into(),
            password: "test".into(),
            project_path: std::env::temp_dir(),
            generation: 9,
            generation_clock: Arc::new(std::sync::atomic::AtomicU64::new(9)),
        };
        push_sse_data(&events, Some(&router), &connection, 9, &source.to_string());
        let event = events.lock().unwrap().pop_front().unwrap();
        assert_eq!(event["generation"], 9);
        assert_eq!(event["kind"], "sse");
        assert_eq!(event["payload"], source);
        let shadow = serde_json::to_value(router.snapshot(None, None).unwrap()).unwrap();
        assert_eq!(shadow["events"][0]["nativeEnvelope"], event);
    }

    #[test]
    fn prompt_body_scopes_lifemodel_context_to_one_system_input() {
        let body = prompt_body(
            "zhipuai",
            "glm-5.3-flash",
            "请继续。",
            Some("Farfold LifeModel context for this turn only:\n- [preference] 先给结论"),
        );
        assert_eq!(
            body["system"],
            "Farfold LifeModel context for this turn only:\n- [preference] 先给结论"
        );
        assert_eq!(body["parts"][0]["text"], "请继续。");
        assert_eq!(
            prompt_body("zhipuai", "glm-5.3-flash", "普通消息", None).get("system"),
            None
        );
    }
}
