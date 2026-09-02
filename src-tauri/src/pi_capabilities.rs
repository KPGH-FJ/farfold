use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

struct RunningBridge {
    child: Child,
    stdin: ChildStdin,
}

pub struct PiCapabilities {
    process: Mutex<Option<RunningBridge>>,
    events: Arc<Mutex<VecDeque<Value>>>,
}

impl Default for PiCapabilities {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            events: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
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
        .map(|parent| parent.join("pi-capabilities"));
    if let Some(path) = bundled.filter(|path| path.is_file()) {
        return Ok(path);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries/pi-capabilities-aarch64-apple-darwin");
    development
        .is_file()
        .then_some(development)
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

    let mut child = Command::new(bridge_path()?)
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
    let mut bytes = serde_json::to_vec(&command)
        .map_err(|error| format!("Cannot encode Pi capability command: {error}"))?;
    bytes.push(b'\n');
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
    use super::CapabilityCommand;
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
    }

    #[test]
    fn connection_probe_names_the_provider_without_runtime_policy() {
        let command: CapabilityCommand = serde_json::from_value(json!({
            "type": "test_connection",
            "id": "probe-1",
            "providerId": "anthropic"
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(command).unwrap(),
            json!({
                "type": "test_connection",
                "id": "probe-1",
                "providerId": "anthropic"
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
