use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

const MAX_CAPABILITY_COMMAND_BYTES: usize = 1024 * 1024;

struct RunningBridge {
    child: Child,
    stdin: ChildStdin,
}

pub struct PiCapabilities {
    process: Mutex<Option<RunningBridge>>,
    events: Arc<Mutex<VecDeque<Value>>>,
    #[cfg(test)]
    agent_dir: Option<PathBuf>,
}

impl Default for PiCapabilities {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            events: Arc::new(Mutex::new(VecDeque::new())),
            #[cfg(test)]
            agent_dir: None,
        }
    }
}

#[cfg(test)]
impl PiCapabilities {
    pub(crate) fn with_agent_dir_for_test(agent_dir: PathBuf) -> Self {
        Self {
            process: Mutex::new(None),
            events: Arc::new(Mutex::new(VecDeque::new())),
            agent_dir: Some(agent_dir),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum CapabilityCommand {
    Snapshot {
        id: String,
        #[serde(rename = "projectPath")]
        project_path: Option<String>,
    },
    Refresh {
        id: String,
        #[serde(rename = "projectPath")]
        project_path: Option<String>,
    },
    Login {
        id: String,
        #[serde(rename = "providerId")]
        provider_id: String,
        #[serde(rename = "authType")]
        auth_type: String,
    },
    LoginApiKey {
        id: String,
        #[serde(rename = "providerId")]
        provider_id: String,
        #[serde(rename = "apiKey")]
        api_key: String,
    },
    AuthResponse {
        id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "promptId")]
        prompt_id: String,
        value: String,
    },
    AuthCancel {
        id: String,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    TestConnection {
        id: String,
        #[serde(rename = "providerId")]
        provider_id: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    UpsertCustomProvider {
        id: String,
        #[serde(rename = "providerId")]
        provider_id: String,
        #[serde(rename = "providerName")]
        provider_name: String,
        #[serde(rename = "baseUrl")]
        base_url: String,
        api: String,
        #[serde(rename = "modelId")]
        model_id: String,
        #[serde(rename = "modelName")]
        model_name: String,
        #[serde(rename = "contextWindow")]
        context_window: u64,
        #[serde(rename = "maxTokens")]
        max_tokens: u64,
        reasoning: bool,
        #[serde(rename = "imageInput")]
        image_input: bool,
        #[serde(rename = "localKeyless")]
        local_keyless: bool,
        #[serde(rename = "supportsDeveloperRole")]
        supports_developer_role: bool,
        #[serde(rename = "supportsReasoningEffort")]
        supports_reasoning_effort: bool,
        #[serde(rename = "projectPath")]
        project_path: Option<String>,
    },
    Logout {
        id: String,
        #[serde(rename = "providerId")]
        provider_id: String,
    },
    SetDefaults {
        id: String,
        #[serde(rename = "providerId")]
        provider_id: String,
        #[serde(rename = "modelId")]
        model_id: String,
        #[serde(rename = "thinkingLevel")]
        thinking_level: Option<String>,
        #[serde(rename = "projectPath")]
        project_path: Option<String>,
    },
}

fn bridge_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Cannot locate Farfold executable: {error}"))?;
    let bundled = executable
        .parent()
        .and_then(std::path::Path::parent)
        .map(|contents| contents.join("Resources/farfold-runtime/pi-capability-wrapper.sh"));
    if let Some(path) = bundled.filter(|path| path.is_file()) {
        return Ok(path);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|root| root.join("scripts/pi-capability-wrapper.sh"));
    development
        .filter(|path| path.is_file())
        .ok_or_else(|| "Cannot locate bundled Pi capability bridge".to_string())
}

fn push_event(events: &Arc<Mutex<VecDeque<Value>>>, event: Value) {
    if let Ok(mut queue) = events.lock() {
        queue.push_back(event);
        while queue.len() > 1_000 {
            queue.pop_front();
        }
    }
}

fn encoded_command(command: &CapabilityCommand) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(command)
        .map_err(|error| format!("Cannot encode Pi capability command: {error}"))?;
    if bytes.len() > MAX_CAPABILITY_COMMAND_BYTES {
        return Err(format!(
            "Pi capability command exceeds the {MAX_CAPABILITY_COMMAND_BYTES}-byte limit"
        ));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

fn start_process(capabilities: &PiCapabilities) -> Result<(), String> {
    let mut process = capabilities
        .process
        .lock()
        .map_err(|_| "Pi capability bridge state is unavailable".to_string())?;
    if let Some(running) = process.as_mut() {
        match running
            .child
            .try_wait()
            .map_err(|error| format!("Cannot inspect Pi capability bridge: {error}"))?
        {
            None => return Ok(()),
            Some(_) => {
                *process = None;
            }
        }
    }

    let mut command = Command::new("/bin/bash");
    command.arg(bridge_path()?);
    #[cfg(test)]
    if let Some(agent_dir) = &capabilities.agent_dir {
        command.env("FARFOLD_PI_AGENT_DIR", agent_dir);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot start Pi capability bridge: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Pi capability bridge stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Pi capability bridge stdout is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Pi capability bridge stderr is unavailable".to_string())?;

    let stdout_events = Arc::clone(&capabilities.events);
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if line.trim().is_empty() => {}
                Ok(line) => match serde_json::from_str::<Value>(&line) {
                    Ok(event) => push_event(&stdout_events, event),
                    Err(_) => push_event(
                        &stdout_events,
                        json!({
                            "type": "bridge_error",
                            "error": "Pi capability bridge returned invalid JSONL"
                        }),
                    ),
                },
                Err(_) => break,
            }
        }
        push_event(
            &stdout_events,
            json!({ "type": "bridge_lifecycle", "state": "closed" }),
        );
    });

    let stderr_events = Arc::clone(&capabilities.events);
    thread::spawn(move || {
        let mut reported = false;
        for line in BufReader::new(stderr).lines() {
            if line.is_ok() && !reported {
                reported = true;
                push_event(
                    &stderr_events,
                    json!({
                        "type": "bridge_error",
                        "error": "Pi capability bridge reported an internal diagnostic"
                    }),
                );
            }
        }
    });

    *process = Some(RunningBridge { child, stdin });
    Ok(())
}

pub fn stop_process(capabilities: &PiCapabilities) -> Result<(), String> {
    let mut process = capabilities
        .process
        .lock()
        .map_err(|_| "Pi capability bridge state is unavailable".to_string())?;
    if let Some(mut running) = process.take()
        && running
            .child
            .try_wait()
            .map_err(|error| format!("Cannot inspect Pi capability bridge: {error}"))?
            .is_none()
    {
        running
            .child
            .kill()
            .map_err(|error| format!("Cannot stop Pi capability bridge: {error}"))?;
        running
            .child
            .wait()
            .map_err(|error| format!("Cannot reap Pi capability bridge: {error}"))?;
    }
    Ok(())
}

fn send_command_and_wait(
    capabilities: &PiCapabilities,
    command: CapabilityCommand,
    id: &str,
    timeout: Duration,
    failure_message: &str,
) -> Result<Value, String> {
    start_process(capabilities)?;
    {
        let mut process = capabilities
            .process
            .lock()
            .map_err(|_| "Pi capability bridge state is unavailable".to_string())?;
        let running = process
            .as_mut()
            .ok_or_else(|| "Pi capability bridge is not running".to_string())?;
        let bytes = encoded_command(&command)?;
        running
            .stdin
            .write_all(&bytes)
            .map_err(|error| format!("Cannot send Pi capability command: {error}"))?;
        running
            .stdin
            .flush()
            .map_err(|error| format!("Cannot flush Pi capability command: {error}"))?;
    }
    let deadline = Instant::now() + timeout;
    loop {
        {
            let mut events = capabilities
                .events
                .lock()
                .map_err(|_| "Pi capability event queue is unavailable".to_string())?;
            if let Some(index) = events.iter().position(|event| {
                event.get("type").and_then(Value::as_str) == Some("response")
                    && event.get("id").and_then(Value::as_str) == Some(id)
            }) {
                let event = events
                    .remove(index)
                    .ok_or("Pi capability response disappeared")?;
                if event.get("success").and_then(Value::as_bool) == Some(true) {
                    return Ok(event.get("data").cloned().unwrap_or(Value::Null));
                }
                return Err(event
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or(failure_message)
                    .to_string());
            }
        }
        if Instant::now() >= deadline {
            return Err(format!("{failure_message} timed out"));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PiCustomProviderUpsertInput {
    pub(crate) provider_id: String,
    pub(crate) provider_name: String,
    pub(crate) base_url: String,
    pub(crate) api: String,
    pub(crate) model_id: String,
    pub(crate) model_name: String,
    pub(crate) context_window: u64,
    pub(crate) max_tokens: u64,
    pub(crate) reasoning: bool,
    pub(crate) image_input: bool,
    pub(crate) local_keyless: bool,
    pub(crate) supports_developer_role: bool,
    pub(crate) supports_reasoning_effort: bool,
    pub(crate) project_path: Option<String>,
}

pub(crate) fn upsert_custom_provider_and_wait(
    capabilities: &PiCapabilities,
    input: PiCustomProviderUpsertInput,
) -> Result<Value, String> {
    let id = format!("managed-provider-upsert-{}", std::process::id());
    let command = CapabilityCommand::UpsertCustomProvider {
        id: id.clone(),
        provider_id: input.provider_id,
        provider_name: input.provider_name,
        base_url: input.base_url,
        api: input.api,
        model_id: input.model_id,
        model_name: input.model_name,
        context_window: input.context_window,
        max_tokens: input.max_tokens,
        reasoning: input.reasoning,
        image_input: input.image_input,
        local_keyless: input.local_keyless,
        supports_developer_role: input.supports_developer_role,
        supports_reasoning_effort: input.supports_reasoning_effort,
        project_path: input.project_path,
    };
    send_command_and_wait(
        capabilities,
        command,
        &id,
        Duration::from_secs(45),
        "Pi managed Provider definition update failed",
    )
    .map(|_| json!(null))
}

pub(crate) fn login_api_key_and_wait(
    capabilities: &PiCapabilities,
    provider_id: String,
    api_key: String,
) -> Result<(), String> {
    let id = format!("managed-provider-login-{}", std::process::id());
    let command = CapabilityCommand::LoginApiKey {
        id: id.clone(),
        provider_id,
        api_key,
    };
    send_command_and_wait(
        capabilities,
        command,
        &id,
        Duration::from_secs(45),
        "Pi managed Provider login failed",
    )
    .map(|_| ())
}

#[cfg(test)]
pub(crate) fn test_connection_and_wait(
    capabilities: &PiCapabilities,
    provider_id: String,
    model_id: String,
) -> Result<Value, String> {
    let id = format!("managed-provider-probe-{}", std::process::id());
    let command = CapabilityCommand::TestConnection {
        id: id.clone(),
        provider_id,
        model_id,
    };
    send_command_and_wait(
        capabilities,
        command,
        &id,
        Duration::from_secs(45),
        "Pi managed Provider probe failed",
    )
}

#[tauri::command]
pub fn pi_capabilities_start(capabilities: State<'_, PiCapabilities>) -> Result<(), String> {
    start_process(&capabilities)
}

#[tauri::command]
pub fn pi_capabilities_send(
    capabilities: State<'_, PiCapabilities>,
    command: CapabilityCommand,
) -> Result<(), String> {
    start_process(&capabilities)?;
    let mut process = capabilities
        .process
        .lock()
        .map_err(|_| "Pi capability bridge state is unavailable".to_string())?;
    let running = process
        .as_mut()
        .ok_or_else(|| "Pi capability bridge is not running".to_string())?;
    let bytes = encoded_command(&command)?;
    running
        .stdin
        .write_all(&bytes)
        .map_err(|error| format!("Cannot send Pi capability command: {error}"))?;
    running
        .stdin
        .flush()
        .map_err(|error| format!("Cannot flush Pi capability command: {error}"))
}

#[tauri::command]
pub fn pi_capabilities_poll(capabilities: State<'_, PiCapabilities>) -> Result<Vec<Value>, String> {
    let mut events = capabilities
        .events
        .lock()
        .map_err(|_| "Pi capability event queue is unavailable".to_string())?;
    Ok(events.drain(..).collect())
}

#[cfg(test)]
mod tests {
    use super::{CapabilityCommand, MAX_CAPABILITY_COMMAND_BYTES, encoded_command};
    use serde_json::json;

    #[test]
    fn capability_commands_use_the_bridge_jsonl_contract() {
        let command: CapabilityCommand = serde_json::from_value(json!({
            "type": "login",
            "id": "login-1",
            "providerId": "anthropic",
            "authType": "oauth"
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(command).unwrap(),
            json!({
                "type": "login",
                "id": "login-1",
                "providerId": "anthropic",
                "authType": "oauth"
            })
        );
    }

    #[test]
    fn auth_response_serialization_preserves_but_does_not_inspect_the_secret() {
        let command: CapabilityCommand = serde_json::from_value(json!({
            "type": "auth_response",
            "id": "answer-1",
            "requestId": "login-1",
            "promptId": "prompt-1",
            "value": "secret-value"
        }))
        .unwrap();
        assert!(matches!(command, CapabilityCommand::AuthResponse { .. }));
        let command: CapabilityCommand = serde_json::from_value(json!({
            "type": "login_api_key",
            "id": "login-2",
            "providerId": "managed-openai",
            "apiKey": "secret-value"
        }))
        .unwrap();
        assert!(matches!(command, CapabilityCommand::LoginApiKey { .. }));
    }

    #[test]
    fn capability_boundary_rejects_unknown_fields_and_oversized_secrets() {
        let unknown = serde_json::from_value::<CapabilityCommand>(json!({
            "type": "auth_response",
            "id": "answer-1",
            "requestId": "login-1",
            "promptId": "prompt-1",
            "value": "secret-value",
            "system": "attacker-controlled"
        }))
        .unwrap_err();
        assert!(unknown.to_string().contains("unknown field"));

        let oversized = CapabilityCommand::AuthResponse {
            id: "answer-1".to_string(),
            request_id: "login-1".to_string(),
            prompt_id: "prompt-1".to_string(),
            value: "x".repeat(MAX_CAPABILITY_COMMAND_BYTES),
        };
        assert!(encoded_command(&oversized).unwrap_err().contains("exceeds"));
    }

    #[test]
    fn connection_probe_requires_the_explicit_provider_and_model() {
        let command: CapabilityCommand = serde_json::from_value(json!({
            "type": "test_connection",
            "id": "probe-1",
            "providerId": "anthropic",
            "modelId": "selected-model"
        }))
        .unwrap();
        assert!(
            serde_json::from_value::<CapabilityCommand>(json!({
                "type": "test_connection", "id": "probe-old", "providerId": "anthropic"
            }))
            .is_err()
        );
        assert_eq!(
            serde_json::to_value(command).unwrap(),
            json!({
                "type": "test_connection",
                "id": "probe-1",
                "providerId": "anthropic",
            "modelId": "selected-model"
            })
        );
    }

    #[test]
    fn custom_provider_command_is_a_typed_models_json_boundary() {
        let command: CapabilityCommand = serde_json::from_value(json!({
            "type": "upsert_custom_provider",
            "id": "custom-1",
            "providerId": "local-openai",
            "providerName": "Local OpenAI",
            "baseUrl": "http://localhost:11434/v1",
            "api": "openai-completions",
            "modelId": "qwen-test",
            "modelName": "Qwen Test",
            "contextWindow": 128000,
            "maxTokens": 8192,
            "reasoning": false,
            "imageInput": false,
            "localKeyless": true,
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": false,
            "projectPath": null
        }))
        .unwrap();
        assert!(matches!(
            command,
            CapabilityCommand::UpsertCustomProvider { .. }
        ));
    }
}
