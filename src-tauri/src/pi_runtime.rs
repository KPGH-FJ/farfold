use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    ShellExt,
    process::{CommandChild, CommandEvent},
};

const PI_EVENT: &str = "farfold://pi-event";

struct RunningPi {
    child: CommandChild,
    generation: u64,
    project_path: PathBuf,
    session_dir: PathBuf,
}

#[derive(Default)]
pub struct PiRuntime {
    process: Mutex<Option<RunningPi>>,
    generation: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    running: bool,
    project_path: Option<String>,
    session_dir: Option<String>,
    generation: u64,
}

fn status(runtime: &PiRuntime) -> Result<RuntimeStatus, String> {
    let process = runtime
        .process
        .lock()
        .map_err(|_| "Pi runtime state is unavailable".to_string())?;

    Ok(match process.as_ref() {
        Some(running) => RuntimeStatus {
            running: true,
            project_path: Some(running.project_path.to_string_lossy().into_owned()),
            session_dir: Some(running.session_dir.to_string_lossy().into_owned()),
            generation: running.generation,
        },
        None => RuntimeStatus {
            running: false,
            project_path: None,
            session_dir: None,
            generation: runtime.generation.load(Ordering::SeqCst),
        },
    })
}

fn prepare_directory(path: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Cannot create {}: {error}", path.display()))?;
    path.canonicalize()
        .map_err(|error| format!("Cannot resolve {}: {error}", path.display()))
}

fn emit(app: &AppHandle, kind: &str, payload: Value) {
    let _ = app.emit(PI_EVENT, json!({ "kind": kind, "payload": payload }));
}

fn parse_protocol_line(mut line: &[u8]) -> Result<Value, serde_json::Error> {
    while line
        .last()
        .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
    {
        line = &line[..line.len() - 1];
    }
    serde_json::from_slice(line)
}

fn emit_protocol_line(app: &AppHandle, line: &[u8]) {
    match parse_protocol_line(line) {
        Ok(payload) => emit(app, "rpc", payload),
        Err(error) => emit(
            app,
            "protocol_error",
            json!({
                "line": String::from_utf8_lossy(line),
                "error": error.to_string(),
            }),
        ),
    }
}

fn watch_process(
    app: AppHandle,
    mut receiver: tauri::async_runtime::Receiver<CommandEvent>,
    generation: u64,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[farfold] received {} Pi stdout bytes", bytes.len());
                    emit_protocol_line(&app, &bytes);
                }
                CommandEvent::Stderr(bytes) => {
                    emit(&app, "stderr", json!(String::from_utf8_lossy(&bytes)));
                }
                CommandEvent::Error(error) => emit(
                    &app,
                    "lifecycle",
                    json!({ "state": "error", "detail": error }),
                ),
                CommandEvent::Terminated(payload) => {
                    emit(
                        &app,
                        "lifecycle",
                        json!({ "state": "terminated", "detail": payload }),
                    );
                    if let Ok(mut process) = app.state::<PiRuntime>().process.lock()
                        && process
                            .as_ref()
                            .is_some_and(|running| running.generation == generation)
                    {
                        *process = None;
                    }
                }
                _ => {}
            }
        }
    });
}

#[tauri::command]
pub fn pi_runtime_start(
    app: AppHandle,
    runtime: State<'_, PiRuntime>,
    project_path: Option<String>,
) -> Result<RuntimeStatus, String> {
    {
        let process = runtime
            .process
            .lock()
            .map_err(|_| "Pi runtime state is unavailable".to_string())?;
        if process.is_some() {
            return status(&runtime);
        }
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Farfold data directory: {error}"))?;
    let default_project = app_data.join("workspace");
    let project = match project_path {
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_dir() {
                return Err(format!("Project is not a directory: {}", path.display()));
            }
            path.canonicalize()
                .map_err(|error| format!("Cannot resolve Project: {error}"))?
        }
        None => prepare_directory(&default_project)?,
    };
    let session_dir = prepare_directory(&app_data.join("sessions"))?;
    let session_arg = session_dir.to_string_lossy().into_owned();

    let command = app
        .shell()
        .sidecar("pi")
        .map_err(|error| format!("Cannot prepare Pi sidecar: {error}"))?
        .args(["--mode", "rpc", "--session-dir", &session_arg])
        .current_dir(&project);
    let (receiver, child) = command
        .spawn()
        .map_err(|error| format!("Cannot start Pi sidecar: {error}"))?;

    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut process = runtime
            .process
            .lock()
            .map_err(|_| "Pi runtime state is unavailable".to_string())?;
        *process = Some(RunningPi {
            child,
            generation,
            project_path: project.clone(),
            session_dir: session_dir.clone(),
        });
    }
    watch_process(app.clone(), receiver, generation);
    emit(
        &app,
        "lifecycle",
        json!({ "state": "started", "projectPath": project, "sessionDir": session_dir }),
    );
    status(&runtime)
}

#[tauri::command]
pub fn pi_runtime_send(runtime: State<'_, PiRuntime>, command: Value) -> Result<(), String> {
    if !command.is_object() {
        return Err("Pi RPC command must be a JSON object".to_string());
    }
    let mut bytes = serde_json::to_vec(&command)
        .map_err(|error| format!("Cannot encode Pi RPC command: {error}"))?;
    bytes.push(b'\n');
    #[cfg(debug_assertions)]
    let command_type = command
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    #[cfg(debug_assertions)]
    eprintln!(
        "[farfold] sending Pi RPC command {command_type} ({} bytes)",
        bytes.len()
    );

    let mut process = runtime
        .process
        .lock()
        .map_err(|_| "Pi runtime state is unavailable".to_string())?;
    let running = process
        .as_mut()
        .ok_or_else(|| "Pi is not running".to_string())?;
    running
        .child
        .write(&bytes)
        .map_err(|error| format!("Cannot write to Pi: {error}"))
}

#[tauri::command]
pub fn pi_runtime_stop(runtime: State<'_, PiRuntime>) -> Result<RuntimeStatus, String> {
    let running = runtime
        .process
        .lock()
        .map_err(|_| "Pi runtime state is unavailable".to_string())?
        .take();
    if let Some(running) = running {
        running
            .child
            .kill()
            .map_err(|error| format!("Cannot stop Pi: {error}"))?;
    }
    status(&runtime)
}

#[tauri::command]
pub fn pi_runtime_status(runtime: State<'_, PiRuntime>) -> Result<RuntimeStatus, String> {
    status(&runtime)
}

#[cfg(test)]
mod tests {
    use super::parse_protocol_line;

    #[test]
    fn protocol_line_accepts_unicode_and_crlf() {
        let value =
            parse_protocol_line("{\"type\":\"event\",\"text\":\"你好 world\"}\r\n".as_bytes())
                .expect("valid Pi RPC line");
        assert_eq!(value["text"], "你好 world");
    }
}
