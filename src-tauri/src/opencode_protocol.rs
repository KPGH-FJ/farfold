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
use crate::runtime_registry::OPENCODE_RUNTIME;

const OPENCODE_USERNAME: &str = "farfold";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RECONNECT_DELAY: Duration = Duration::from_millis(500);
const MAX_SSE_EVENT_BYTES: usize = 1024 * 1024;

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

fn change_auth(
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
            app.state::<crate::turn_coordinator::TurnCoordinator>()
                .require_runtime_idle(
                    OPENCODE_RUNTIME.product_id,
                    OPENCODE_RUNTIME.installation_id,
                )?;
            change_auth(&connection(&app.state::<OpenCodeRuntime>())?, input)
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

fn provider_snapshot(value: &Value) -> OpenCodeProviderSnapshot {
    let connected_provider_ids = value
        .get("connected")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut models = Vec::new();
    for provider in value
        .get("all")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(provider_id) = provider.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !connected_provider_ids
            .iter()
            .any(|connected| connected == provider_id)
        {
            continue;
        }
        for (model_id, model) in provider
            .get("models")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
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
    OpenCodeProviderSnapshot {
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
    }
}

fn fetch_provider_snapshot(
    connection: &OpenCodeConnection,
) -> Result<OpenCodeProviderSnapshot, String> {
    let client = client(Some(REQUEST_TIMEOUT))?;
    let response = request(&client, connection, Method::GET, "/provider")
        .send()
        .map_err(|error| format!("Cannot query OpenCode Providers: {error}"))?;
    Ok(provider_snapshot(&checked_json(
        response,
        "Provider query",
    )?))
}

pub(crate) fn create_session(
    connection: &OpenCodeConnection,
    title: Option<String>,
) -> Result<Value, String> {
    let client = client(Some(REQUEST_TIMEOUT))?;
    let body = title
        .filter(|title| !title.trim().is_empty())
        .map(|title| json!({ "title": title.trim() }))
        .unwrap_or_else(|| json!({}));
    let response = request(&client, connection, Method::POST, "/session")
        .json(&body)
        .send()
        .map_err(|error| format!("Cannot create OpenCode Session: {error}"))?;
    checked_json(response, "Session create")
}

pub(crate) fn list_sessions(connection: &OpenCodeConnection) -> Result<Vec<Value>, String> {
    let client = client(Some(REQUEST_TIMEOUT))?;
    let response = request(&client, connection, Method::GET, "/session")
        .send()
        .map_err(|error| format!("Cannot list OpenCode Sessions: {error}"))?;
    serde_json::from_value(checked_json(response, "Session list")?)
        .map_err(|error| format!("OpenCode Session list was not an array: {error}"))
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

pub(crate) fn prompt_text(
    connection: &OpenCodeConnection,
    session_id: &str,
    provider_id: &str,
    model_id: &str,
    text: &str,
    system: Option<&str>,
) -> Result<(), String> {
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
    .send()
    .map_err(|error| format!("Cannot send OpenCode prompt: {error}"))?;
    if response.status() != StatusCode::NO_CONTENT {
        return Err(format!(
            "OpenCode prompt returned HTTP {}",
            response.status()
        ));
    }
    Ok(())
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
    generation: u64,
    data: &str,
) {
    match serde_json::from_str::<Value>(data) {
        Ok(payload) => push_event(
            events,
            router,
            json!({ "generation": generation, "kind": "sse", "payload": payload }),
        ),
        Err(error) => push_event(
            events,
            router,
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
    generation: u64,
    byte_count_at_least: usize,
) {
    push_event(
        events,
        router,
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
                push_oversized_sse_event(events, router, connection.generation, data_byte_count);
                return Ok(());
            }
            data.push(value.to_string());
        } else if line.is_empty() && !data.is_empty() {
            push_sse_data(events, router, connection.generation, &data.join("\n"));
            data.clear();
            data_byte_count = 0;
        }
    }
    if !data.is_empty() {
        push_sse_data(events, router, connection.generation, &data.join("\n"));
    }
    Ok(())
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
                push_event(
                    &events,
                    router.as_ref(),
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
pub fn opencode_provider_snapshot(
    runtime: State<'_, OpenCodeRuntime>,
) -> Result<OpenCodeProviderSnapshot, String> {
    fetch_provider_snapshot(&connection(&runtime)?)
}

#[tauri::command]
pub fn opencode_session_list(runtime: State<'_, OpenCodeRuntime>) -> Result<Vec<Value>, String> {
    let connection = connection(&runtime)?;
    list_sessions(&connection)
}

#[tauri::command]
pub fn opencode_session_messages(
    runtime: State<'_, OpenCodeRuntime>,
    session_id: String,
    limit: Option<u32>,
) -> Result<Vec<Value>, String> {
    let connection = connection(&runtime)?;
    let session_id = validated_native_id(session_id, "ses", "Session ID")?;
    session_messages(&connection, &session_id, limit)
}

#[tauri::command]
pub fn opencode_permission_respond(
    runtime: State<'_, OpenCodeRuntime>,
    interactions: State<'_, InteractionRegistry>,
    input: OpenCodePermissionResponseInput,
) -> Result<Value, String> {
    let connection = connection(&runtime)?;
    let session_id = validated_native_id(input.session_id, "ses", "Session ID")?;
    let permission_id = validated_native_id(input.permission_id, "per", "Permission ID")?;
    let client = client(Some(REQUEST_TIMEOUT))?;
    interactions.begin_response(
        OPENCODE_RUNTIME,
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
        OPENCODE_RUNTIME,
        connection.generation,
        &permission_id,
        result.is_ok(),
    )?;
    result
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
    fn provider_readiness_uses_only_connected_provider_models() {
        let snapshot = provider_snapshot(&json!({
            "connected": ["opencode"],
            "all": [
                { "id": "unused", "models": { "ignored": { "name": "Ignored" } } },
                { "id": "opencode", "models": {
                    "big-pickle": { "name": "Big Pickle", "status": "active" }
                } }
            ]
        }));
        assert_eq!(snapshot.provider, "ready");
        assert_eq!(snapshot.model, "ready");
        assert_eq!(snapshot.account, "unknown");
        assert_eq!(snapshot.models.len(), 1);
        assert_eq!(snapshot.models[0].model_id, "big-pickle");
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
        push_sse_data(&events, Some(&router), 9, &source.to_string());
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
