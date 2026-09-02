use reqwest::{Method, StatusCode, blocking::Client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    thread,
    time::Duration,
};
use tauri::State;

use crate::interaction_registry::InteractionRegistry;
use crate::opencode_runtime::{
    OpenCodeConnection, OpenCodeRuntime, SharedEvents, connection, push_event,
};
use crate::runtime_event_router::RuntimeEventRouter;
use crate::runtime_registry::OPENCODE_RUNTIME;

const OPENCODE_USERNAME: &str = "farfold";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RECONNECT_DELAY: Duration = Duration::from_millis(500);

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
#[serde(rename_all = "camelCase")]
pub struct OpenCodePromptInput {
    session_id: String,
    provider_id: String,
    model_id: String,
    text: String,
    system: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    for line in BufReader::new(response).lines() {
        if connection
            .generation_clock
            .load(std::sync::atomic::Ordering::SeqCst)
            != connection.generation
        {
            return Ok(());
        }
        let line = line.map_err(|error| format!("Cannot read OpenCode SSE: {error}"))?;
        if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start().to_string());
        } else if line.is_empty() && !data.is_empty() {
            push_sse_data(events, router, connection.generation, &data.join("\n"));
            data.clear();
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
pub fn opencode_session_create(
    runtime: State<'_, OpenCodeRuntime>,
    title: Option<String>,
) -> Result<Value, String> {
    let connection = connection(&runtime)?;
    create_session(&connection, title)
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
pub fn opencode_prompt_async(
    runtime: State<'_, OpenCodeRuntime>,
    input: OpenCodePromptInput,
) -> Result<(), String> {
    let connection = connection(&runtime)?;
    let session_id = validated_native_id(input.session_id, "ses", "Session ID")?;
    prompt_text(
        &connection,
        &session_id,
        &input.provider_id,
        &input.model_id,
        &input.text,
        input.system.as_deref(),
    )
}

#[tauri::command]
pub fn opencode_session_abort(
    runtime: State<'_, OpenCodeRuntime>,
    session_id: String,
) -> Result<bool, String> {
    let connection = connection(&runtime)?;
    let session_id = validated_native_id(session_id, "ses", "Session ID")?;
    abort_session(&connection, &session_id)
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
    use super::{prompt_body, provider_snapshot, push_sse_data, valid_native_id};
    use serde_json::json;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

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
