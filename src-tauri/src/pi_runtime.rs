use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};

use crate::runtime_registry::{PI_RUNTIME, verify_managed_installation};

struct RunningPi {
    child: Child,
    generation: u64,
    project_path: PathBuf,
    session_dir: PathBuf,
}

enum RuntimeLifecycle {
    Stopped,
    Starting {
        generation: u64,
    },
    Running(RunningPi),
    Stopping {
        generation: u64,
        project_path: PathBuf,
        session_dir: PathBuf,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimePhase {
    Stopped,
    Starting,
    Running,
    Stopping,
}

pub struct PiRuntime {
    lifecycle: Mutex<RuntimeLifecycle>,
    generation: AtomicU64,
    saved_session: Mutex<Option<SavedSession>>,
    events: Mutex<VecDeque<Value>>,
}

impl Default for PiRuntime {
    fn default() -> Self {
        Self {
            lifecycle: Mutex::new(RuntimeLifecycle::Stopped),
            generation: AtomicU64::new(0),
            saved_session: Mutex::new(None),
            events: Mutex::new(VecDeque::new()),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SavedSession {
    project_path: PathBuf,
    session_file: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    project_path: Option<String>,
    session_file: Option<String>,
    resume_previous: bool,
    project_trust: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PiCommand {
    Prompt {
        id: Option<String>,
        message: String,
    },
    Steer {
        id: Option<String>,
        message: String,
    },
    FollowUp {
        id: Option<String>,
        message: String,
    },
    Abort {
        id: Option<String>,
    },
    NewSession {
        id: Option<String>,
    },
    GetState {
        id: Option<String>,
    },
    GetMessages {
        id: Option<String>,
    },
    GetEntries {
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        since: Option<String>,
    },
    GetAvailableModels {
        id: Option<String>,
    },
    GetAvailableThinkingLevels {
        id: Option<String>,
    },
    GetCommands {
        id: Option<String>,
    },
    GetSessionStats {
        id: Option<String>,
    },
    SetSessionName {
        id: Option<String>,
        name: String,
    },
    SetModel {
        id: Option<String>,
        provider: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    SetThinkingLevel {
        id: Option<String>,
        level: String,
    },
    SwitchSession {
        id: Option<String>,
        #[serde(rename = "sessionPath")]
        session_path: String,
    },
    ExtensionUiResponse {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        confirmed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cancelled: Option<bool>,
    },
}

impl PiCommand {
    fn kind(&self) -> &'static str {
        match self {
            Self::Prompt { .. } => "prompt",
            Self::Steer { .. } => "steer",
            Self::FollowUp { .. } => "follow_up",
            Self::Abort { .. } => "abort",
            Self::NewSession { .. } => "new_session",
            Self::GetState { .. } => "get_state",
            Self::GetMessages { .. } => "get_messages",
            Self::GetEntries { .. } => "get_entries",
            Self::GetAvailableModels { .. } => "get_available_models",
            Self::GetAvailableThinkingLevels { .. } => "get_available_thinking_levels",
            Self::GetCommands { .. } => "get_commands",
            Self::GetSessionStats { .. } => "get_session_stats",
            Self::SetSessionName { .. } => "set_session_name",
            Self::SetModel { .. } => "set_model",
            Self::SetThinkingLevel { .. } => "set_thinking_level",
            Self::SwitchSession { .. } => "switch_session",
            Self::ExtensionUiResponse { .. } => "extension_ui_response",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    state: RuntimePhase,
    running: bool,
    project_path: Option<String>,
    session_dir: Option<String>,
    generation: u64,
    saved_project_path: Option<String>,
    saved_session_file: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    session_file: String,
    session_id: String,
    project_path: String,
    title: String,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectResource {
    kind: String,
    entries: usize,
    sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReadiness {
    project_path: String,
    context_files: Vec<String>,
    protected_resources: Vec<ProjectResource>,
}

fn status(runtime: &PiRuntime) -> Result<RuntimeStatus, String> {
    let lifecycle = runtime
        .lifecycle
        .lock()
        .map_err(|_| "Pi runtime state is unavailable".to_string())?;

    let saved = runtime
        .saved_session
        .lock()
        .map_err(|_| "Pi saved-session state is unavailable".to_string())?
        .clone();

    let saved_project_path = saved
        .as_ref()
        .map(|session| session.project_path.to_string_lossy().into_owned());
    let saved_session_file = saved
        .as_ref()
        .map(|session| session.session_file.to_string_lossy().into_owned());

    Ok(match &*lifecycle {
        RuntimeLifecycle::Running(running) => RuntimeStatus {
            state: RuntimePhase::Running,
            running: true,
            project_path: Some(running.project_path.to_string_lossy().into_owned()),
            session_dir: Some(running.session_dir.to_string_lossy().into_owned()),
            generation: running.generation,
            saved_project_path,
            saved_session_file,
        },
        RuntimeLifecycle::Starting { generation } => RuntimeStatus {
            state: RuntimePhase::Starting,
            running: false,
            project_path: None,
            session_dir: None,
            generation: *generation,
            saved_project_path,
            saved_session_file,
        },
        RuntimeLifecycle::Stopping {
            generation,
            project_path,
            session_dir,
        } => RuntimeStatus {
            state: RuntimePhase::Stopping,
            running: false,
            project_path: Some(project_path.to_string_lossy().into_owned()),
            session_dir: Some(session_dir.to_string_lossy().into_owned()),
            generation: *generation,
            saved_project_path,
            saved_session_file,
        },
        RuntimeLifecycle::Stopped => RuntimeStatus {
            state: RuntimePhase::Stopped,
            running: false,
            project_path: None,
            session_dir: None,
            generation: runtime.generation.load(Ordering::SeqCst),
            saved_project_path,
            saved_session_file,
        },
    })
}

pub(crate) fn is_running(runtime: &PiRuntime) -> Result<bool, String> {
    status(runtime).map(|status| status.running)
}

fn begin_start(lifecycle: &mut RuntimeLifecycle, generation: u64) -> Result<u64, String> {
    match lifecycle {
        RuntimeLifecycle::Stopped => {
            *lifecycle = RuntimeLifecycle::Starting { generation };
            Ok(generation)
        }
        RuntimeLifecycle::Starting { .. } => Err("Pi is already starting".to_string()),
        RuntimeLifecycle::Running(_) => Err("Pi is already running".to_string()),
        RuntimeLifecycle::Stopping { .. } => Err("Pi is still stopping".to_string()),
    }
}

fn saved_session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Farfold data directory: {error}"))?
        .join("last-pi-session.json"))
}

fn validated_saved_session(candidate: SavedSession, session_dir: &Path) -> Option<SavedSession> {
    let project_path = candidate.project_path.canonicalize().ok()?;
    let session_dir = session_dir.canonicalize().ok()?;
    let session_file = candidate.session_file.canonicalize().ok()?;
    (project_path.is_dir()
        && session_file.is_file()
        && session_file.starts_with(&session_dir)
        && session_file.extension().is_some_and(|ext| ext == "jsonl"))
    .then_some(SavedSession {
        project_path,
        session_file,
    })
}

fn quarantine_corrupt_file(path: &Path) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let quarantine = path.with_file_name(format!("last-pi-session.corrupt-{timestamp}.json"));
    if let Err(error) = fs::rename(path, &quarantine) {
        eprintln!(
            "[farfold] cannot quarantine corrupt saved Session {}: {error}",
            path.display()
        );
    }
}

fn atomic_write(path: &Path, body: &[u8]) -> Result<(), String> {
    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    let parent = path
        .parent()
        .ok_or_else(|| "Farfold saved-session path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create Farfold data directory: {error}"))?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("last-pi-session.json");
    let temporary = parent.join(format!(
        ".{file_name}.tmp-{}-{sequence}",
        std::process::id()
    ));
    let write_result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("Cannot create temporary Pi session pointer: {error}"))?;
        file.write_all(body)
            .map_err(|error| format!("Cannot write Pi session pointer: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Cannot sync Pi session pointer: {error}"))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("Cannot replace Pi session pointer: {error}"))?;
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn load_saved_session(app: &AppHandle, runtime: &PiRuntime) -> Result<(), String> {
    let mut saved = runtime
        .saved_session
        .lock()
        .map_err(|_| "Pi saved-session state is unavailable".to_string())?;
    if saved.is_some() {
        return Ok(());
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Farfold data directory: {error}"))?;
    let session_dir = prepare_directory(&app_data.join("sessions"))?;
    let path = app_data.join("last-pi-session.json");
    if !path.exists() {
        return Ok(());
    }
    let contents =
        fs::read(&path).map_err(|error| format!("Cannot read saved Pi session: {error}"))?;
    let candidate = match serde_json::from_slice::<SavedSession>(&contents) {
        Ok(candidate) => candidate,
        Err(error) => {
            eprintln!(
                "[farfold] ignoring corrupt saved Session {}: {error}",
                path.display()
            );
            quarantine_corrupt_file(&path);
            return Ok(());
        }
    };
    if let Some(candidate) = validated_saved_session(candidate, &session_dir) {
        *saved = Some(candidate);
    }
    Ok(())
}

fn save_session(app: &AppHandle, runtime: &PiRuntime, session: SavedSession) -> Result<(), String> {
    let path = saved_session_path(app)?;
    let body = serde_json::to_vec_pretty(&session)
        .map_err(|error| format!("Cannot encode saved Pi session: {error}"))?;
    atomic_write(&path, &body)?;
    *runtime
        .saved_session
        .lock()
        .map_err(|_| "Pi saved-session state is unavailable".to_string())? = Some(session);
    Ok(())
}

fn prepare_directory(path: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Cannot create {}: {error}", path.display()))?;
    path.canonicalize()
        .map_err(|error| format!("Cannot resolve {}: {error}", path.display()))
}

fn text_content(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                (part.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| part.get("text").and_then(Value::as_str))
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

fn session_display_title(value: &str) -> String {
    let mut without_skill_blocks = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.to_ascii_lowercase().find("<skill") {
        without_skill_blocks.push_str(&remaining[..start]);
        let after_start = &remaining[start..];
        let Some(end) = after_start.to_ascii_lowercase().find("</skill>") else {
            remaining = "";
            break;
        };
        remaining = &after_start[end + "</skill>".len()..];
    }
    without_skill_blocks.push_str(remaining);

    let mut without_tags = String::new();
    let mut in_tag = false;
    let mut fenced = false;
    for line in without_skill_blocks.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        for character in line.chars() {
            match character {
                '<' => in_tag = true,
                '>' if in_tag => {
                    in_tag = false;
                    without_tags.push(' ');
                }
                _ if !in_tag => without_tags.push(character),
                _ => {}
            }
        }
        without_tags.push(' ');
    }
    let clean = strip_markdown_local_links(&without_tags)
        .split_whitespace()
        .filter(|token| !is_local_path_token(token))
        .collect::<Vec<_>>()
        .join(" ");
    if clean.is_empty() {
        return "新对话".to_string();
    }
    const MAX_CHARS: usize = 34;
    let truncated = clean.chars().take(MAX_CHARS).collect::<String>();
    if clean.chars().count() > MAX_CHARS {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn manual_session_display_title(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return "新对话".to_string();
    }
    const MAX_CHARS: usize = 34;
    let truncated = compact.chars().take(MAX_CHARS).collect::<String>();
    if compact.chars().count() > MAX_CHARS {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn is_local_path_token(value: &str) -> bool {
    let token = value.trim_matches(|character| {
        matches!(
            character,
            '(' | '[' | '{' | '"' | '\'' | '`' | ')' | ']' | '}' | ',' | ';' | ':' | '.'
        )
    });
    token.starts_with('/')
        || token.starts_with("~/")
        || token.to_ascii_lowercase().starts_with("file://")
}

fn strip_markdown_local_links(value: &str) -> String {
    let mut result = String::new();
    let mut remaining = value;
    while let Some(label_end) = remaining.find("](") {
        let Some(label_start) = remaining[..label_end].rfind('[') else {
            let split = label_end + 2;
            result.push_str(&remaining[..split]);
            remaining = &remaining[split..];
            continue;
        };
        let destination = &remaining[label_end + 2..];
        let Some(destination_end) = destination.find(')') else {
            break;
        };
        if is_local_path_token(&destination[..destination_end]) {
            result.push_str(&remaining[..label_start]);
            result.push_str(&remaining[label_start + 1..label_end]);
            remaining = &destination[destination_end + 1..];
        } else {
            let split = label_end + 2;
            result.push_str(&remaining[..split]);
            remaining = &remaining[split..];
        }
    }
    result.push_str(remaining);
    result
}

fn count_directory_entries(path: &Path, directories_only: bool) -> usize {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| !directories_only || kind.is_dir())
                .unwrap_or(false)
        })
        .count()
}

fn project_source(depth: usize, name: &str) -> String {
    format!("{}{}", "../".repeat(depth), name)
}

fn project_readiness(path: &Path) -> Result<ProjectReadiness, String> {
    let project = path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Project: {error}"))?;
    if !project.is_dir() {
        return Err(format!("Project is not a directory: {}", project.display()));
    }

    let mut context_files = Vec::new();
    let mut agent_skill_sources = Vec::new();
    let mut agent_skill_entries = 0;
    for (depth, directory) in project.ancestors().enumerate() {
        if directory.join("AGENTS.override.md").is_file() {
            context_files.push(project_source(depth, "AGENTS.override.md"));
        } else {
            for name in ["AGENTS.md", "CLAUDE.md"] {
                if directory.join(name).is_file() {
                    context_files.push(project_source(depth, name));
                }
            }
        }

        let agent_skills = directory.join(".agents/skills");
        if agent_skills.is_dir() {
            agent_skill_entries += count_directory_entries(&agent_skills, true);
            agent_skill_sources.push(project_source(depth, ".agents/skills"));
        }
    }
    context_files.reverse();

    let mut protected_resources = Vec::new();
    for (kind, name, directories_only) in [
        ("settings", ".pi/settings.json", false),
        ("skill", ".pi/skills", true),
        ("extension", ".pi/extensions", false),
        ("prompt", ".pi/prompts", false),
        ("theme", ".pi/themes", false),
        ("system", ".pi/SYSTEM.md", false),
        ("append-system", ".pi/APPEND_SYSTEM.md", false),
    ] {
        let candidate = project.join(name);
        let entries = if candidate.is_file() {
            Some(1)
        } else if candidate.is_dir() {
            Some(count_directory_entries(&candidate, directories_only))
        } else {
            None
        };
        if let Some(entries) = entries {
            protected_resources.push(ProjectResource {
                kind: kind.to_string(),
                entries,
                sources: vec![name.to_string()],
            });
        }
    }
    if !agent_skill_sources.is_empty() {
        protected_resources.push(ProjectResource {
            kind: "agent-skill".to_string(),
            entries: agent_skill_entries,
            sources: agent_skill_sources,
        });
    }
    Ok(ProjectReadiness {
        project_path: project.to_string_lossy().into_owned(),
        context_files,
        protected_resources,
    })
}

fn summarize_session(path: &Path) -> Result<SessionSummary, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Cannot open Pi session {}: {error}", path.display()))?;
    let mut session_id = String::new();
    let mut project_path = String::new();
    let mut first_prompt = String::new();
    let mut session_name = String::new();

    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match entry.get("type").and_then(Value::as_str) {
            Some("session") => {
                session_id = entry
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                project_path = entry
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
            Some("session_info") => {
                if let Some(name) = entry.get("name").and_then(Value::as_str) {
                    session_name = name.trim().to_string();
                }
            }
            Some("message")
                if first_prompt.is_empty()
                    && entry.pointer("/message/role").and_then(Value::as_str) == Some("user") =>
            {
                first_prompt = entry
                    .pointer("/message/content")
                    .map(text_content)
                    .unwrap_or_default();
            }
            _ => {}
        }
    }

    if session_id.is_empty() || project_path.is_empty() {
        return Err(format!(
            "Pi session header is incomplete: {}",
            path.display()
        ));
    }
    let updated_at = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    let title = if session_name.is_empty() {
        session_display_title(&first_prompt)
    } else {
        manual_session_display_title(&session_name)
    };

    Ok(SessionSummary {
        session_file: path.to_string_lossy().into_owned(),
        session_id,
        project_path,
        title,
        updated_at,
    })
}

fn validate_session_file(session_dir: &Path, candidate: &Path) -> Result<PathBuf, String> {
    if !candidate.is_file() || candidate.extension().is_none_or(|ext| ext != "jsonl") {
        return Err("Pi session file is not a readable JSONL file".to_string());
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Pi session file: {error}"))?;
    if !canonical.starts_with(session_dir) {
        return Err("Pi session file is outside Farfold session storage".to_string());
    }
    Ok(canonical)
}

fn event_envelope(generation: u64, kind: &str, payload: Value) -> Value {
    json!({ "generation": generation, "kind": kind, "payload": payload })
}

fn emit(app: &AppHandle, generation: u64, kind: &str, payload: Value) {
    if std::env::var_os("FARFOLD_RPC_DIAGNOSTICS").is_some() {
        let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("-");
        let command = payload
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("-");
        eprintln!("[farfold-rpc] emit kind={kind} type={payload_type} command={command}");
    }
    let runtime = app.state::<PiRuntime>();
    if generation != runtime.generation.load(Ordering::SeqCst) {
        return;
    }
    let event = event_envelope(generation, kind, payload);
    if let Ok(mut events) = runtime.events.lock() {
        if events.len() == 512 {
            events.pop_front();
        }
        events.push_back(event.clone());
    }
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

fn emit_protocol_line(app: &AppHandle, generation: u64, line: &[u8]) {
    match parse_protocol_line(line) {
        Ok(payload) => emit(app, generation, "rpc", payload),
        Err(error) => emit(
            app,
            generation,
            "protocol_error",
            json!({
                "line": String::from_utf8_lossy(line),
                "error": error.to_string(),
            }),
        ),
    }
}

#[derive(Default)]
struct JsonlBuffer {
    bytes: Vec<u8>,
}

impl JsonlBuffer {
    fn push(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.bytes.extend_from_slice(bytes);
        let mut lines = Vec::new();
        let mut start = 0;
        for index in 0..self.bytes.len() {
            if self.bytes[index] == b'\n' {
                lines.push(self.bytes[start..=index].to_vec());
                start = index + 1;
            }
        }
        if start > 0 {
            self.bytes.drain(..start);
        }
        lines
    }

    fn finish(&mut self) -> Option<Vec<u8>> {
        (!self.bytes.is_empty()).then(|| std::mem::take(&mut self.bytes))
    }
}

fn watch_process(app: AppHandle, stdout: ChildStdout, stderr: ChildStderr, generation: u64) {
    thread::spawn({
        let app = app.clone();
        move || {
            if std::env::var_os("FARFOLD_RPC_DIAGNOSTICS").is_some() {
                eprintln!("[farfold-rpc] stdout reader started generation={generation}");
            }
            let mut protocol_buffer = JsonlBuffer::default();
            let mut reader = BufReader::new(stdout);
            let mut bytes = [0_u8; 8192];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(count) => {
                        for line in protocol_buffer.push(&bytes[..count]) {
                            emit_protocol_line(&app, generation, &line);
                        }
                    }
                    Err(error) => {
                        emit(
                            &app,
                            generation,
                            "lifecycle",
                            json!({ "state": "error", "detail": error.to_string() }),
                        );
                        break;
                    }
                }
            }
            if let Some(incomplete_line) = protocol_buffer.finish() {
                emit(
                    &app,
                    generation,
                    "protocol_error",
                    json!({ "line": String::from_utf8_lossy(&incomplete_line), "error": "Pi stdout ended with an incomplete JSONL record" }),
                );
            }
            watch_child_exit(app, generation);
        }
    });
    thread::spawn({
        let app = app.clone();
        move || {
            let mut reader = BufReader::new(stderr);
            let mut bytes = [0_u8; 4096];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(count) => emit(
                        &app,
                        generation,
                        "stderr",
                        json!(String::from_utf8_lossy(&bytes[..count])),
                    ),
                    Err(error) => {
                        emit(
                            &app,
                            generation,
                            "lifecycle",
                            json!({ "state": "error", "detail": error.to_string() }),
                        );
                        break;
                    }
                }
            }
        }
    });
}

fn watch_child_exit(app: AppHandle, generation: u64) {
    loop {
        let exit = {
            let runtime = app.state::<PiRuntime>();
            let mut lifecycle = match runtime.lifecycle.lock() {
                Ok(lifecycle) => lifecycle,
                Err(_) => return,
            };
            match &mut *lifecycle {
                RuntimeLifecycle::Running(running) if running.generation == generation => {
                    match running.child.try_wait() {
                        Ok(Some(status)) => {
                            *lifecycle = RuntimeLifecycle::Stopped;
                            Some(Ok(status))
                        }
                        Ok(None) => None,
                        Err(error) => {
                            *lifecycle = RuntimeLifecycle::Stopped;
                            Some(Err(error.to_string()))
                        }
                    }
                }
                _ => return,
            }
        };
        match exit {
            Some(Ok(status)) => {
                emit(
                    &app,
                    generation,
                    "lifecycle",
                    json!({
                        "state": "terminated",
                        "reason": "exited",
                        "success": status.success(),
                        "code": status.code(),
                    }),
                );
                return;
            }
            Some(Err(detail)) => {
                emit(
                    &app,
                    generation,
                    "lifecycle",
                    json!({ "state": "terminated", "reason": "error", "detail": detail }),
                );
                return;
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn pi_sidecar_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Cannot locate Farfold executable: {error}"))?;
    let bundled = executable.parent().map(|parent| parent.join("pi"));
    if let Some(path) = bundled.filter(|path| path.is_file()) {
        return Ok(path);
    }
    let development =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/pi-aarch64-apple-darwin");
    development
        .is_file()
        .then_some(development)
        .ok_or_else(|| "Cannot locate bundled Pi sidecar".to_string())
}

fn lifemodel_extension_path(app: &AppHandle) -> Option<PathBuf> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|directory| directory.join("farfold-runtime/lifemodel-context.ts"));
    if let Some(path) = bundled.filter(|path| path.is_file()) {
        return Some(path);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources/farfold-runtime/lifemodel-context.ts");
    development.is_file().then_some(development)
}

fn reset_start(runtime: &PiRuntime, generation: u64) {
    if let Ok(mut lifecycle) = runtime.lifecycle.lock()
        && matches!(
            &*lifecycle,
            RuntimeLifecycle::Starting {
                generation: current
            } if *current == generation
        )
    {
        *lifecycle = RuntimeLifecycle::Stopped;
    }
}

fn terminate_child(child: &mut Child) -> Result<(), String> {
    match child
        .try_wait()
        .map_err(|error| format!("Cannot inspect Pi process: {error}"))?
    {
        Some(_) => Ok(()),
        None => {
            child
                .kill()
                .map_err(|error| format!("Cannot stop Pi: {error}"))?;
            child
                .wait()
                .map(|_| ())
                .map_err(|error| format!("Cannot reap Pi process: {error}"))
        }
    }
}

pub fn pi_runtime_start(
    app: AppHandle,
    runtime: State<'_, PiRuntime>,
    options: StartOptions,
) -> Result<RuntimeStatus, String> {
    let StartOptions {
        project_path,
        session_file,
        resume_previous,
        project_trust,
    } = options;
    load_saved_session(&app, &runtime)?;
    let generation = {
        let mut lifecycle = runtime
            .lifecycle
            .lock()
            .map_err(|_| "Pi runtime state is unavailable".to_string())?;
        if matches!(&*lifecycle, RuntimeLifecycle::Running(_)) {
            drop(lifecycle);
            return status(&runtime);
        }
        let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
        begin_start(&mut lifecycle, generation)?
    };
    if let Ok(mut events) = runtime.events.lock() {
        events.clear();
    }

    let prepared = (|| -> Result<_, String> {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Cannot resolve Farfold data directory: {error}"))?;
        let saved = runtime
            .saved_session
            .lock()
            .map_err(|_| "Pi saved-session state is unavailable".to_string())?
            .clone();
        let default_project = app_data.join("workspace");
        let session_dir = prepare_directory(&app_data.join("sessions"))?;
        let explicit_session = session_file
            .as_deref()
            .map(Path::new)
            .map(|path| validate_session_file(&session_dir, path))
            .transpose()?;
        let explicit_summary = explicit_session
            .as_deref()
            .map(summarize_session)
            .transpose()?;
        let project = match (project_path, explicit_summary.as_ref()) {
            (Some(path), Some(summary)) => {
                let requested = PathBuf::from(path)
                    .canonicalize()
                    .map_err(|error| format!("Cannot resolve Project: {error}"))?;
                let session_project = PathBuf::from(&summary.project_path)
                    .canonicalize()
                    .map_err(|error| format!("Cannot resolve saved Session Project: {error}"))?;
                if requested != session_project {
                    return Err("A Pi Session cannot be moved to a different Project".to_string());
                }
                requested
            }
            (None, Some(summary)) => PathBuf::from(&summary.project_path)
                .canonicalize()
                .map_err(|error| format!("Cannot resolve saved Session Project: {error}"))?,
            (Some(path), None) => {
                let path = PathBuf::from(path);
                if !path.is_dir() {
                    return Err(format!("Project is not a directory: {}", path.display()));
                }
                path.canonicalize()
                    .map_err(|error| format!("Cannot resolve Project: {error}"))?
            }
            (None, None) if resume_previous => saved
                .as_ref()
                .filter(|session| session.project_path.is_dir())
                .map(|session| session.project_path.clone())
                .unwrap_or(prepare_directory(&default_project)?),
            (None, None) => prepare_directory(&default_project)?,
        };
        let session_arg = session_dir.to_string_lossy().into_owned();
        let resume_file = explicit_session.or_else(|| {
            saved
                .filter(|session| {
                    resume_previous
                        && session.project_path == project
                        && session.session_file.is_file()
                })
                .map(|session| session.session_file)
        });
        verify_managed_installation(&app, PI_RUNTIME)?;
        let mut command = Command::new(pi_sidecar_path()?);
        command.args(["--mode", "rpc", "--session-dir", &session_arg]);
        if let Some(extension) = lifemodel_extension_path(&app) {
            command.arg("--extension").arg(extension);
        }
        if let Some(session_file) = &resume_file {
            let session_arg = session_file.to_string_lossy().into_owned();
            command.args(["--session", &session_arg]);
        }
        match project_trust.as_deref() {
            None | Some("saved") => {}
            Some("approve") => {
                command.arg("--approve");
            }
            Some("ignore") => {
                command.arg("--no-approve");
            }
            Some(value) => return Err(format!("Unknown Pi project trust choice: {value}")),
        }
        command
            .current_dir(&project)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start Pi sidecar: {error}"))?;
        let bootstrap = (|| -> Result<_, String> {
            for command in [
                PiCommand::GetState {
                    id: Some(format!("bootstrap-{generation}-state")),
                },
                PiCommand::GetAvailableModels {
                    id: Some(format!("bootstrap-{generation}-models")),
                },
                PiCommand::GetAvailableThinkingLevels {
                    id: Some(format!("bootstrap-{generation}-thinking-levels")),
                },
                PiCommand::GetMessages {
                    id: Some(format!("bootstrap-{generation}-messages")),
                },
                PiCommand::GetCommands {
                    id: Some(format!("bootstrap-{generation}-commands")),
                },
                PiCommand::GetSessionStats {
                    id: Some(format!("bootstrap-{generation}-stats")),
                },
            ] {
                let mut bytes = serde_json::to_vec(&command)
                    .map_err(|error| format!("Cannot encode Pi bootstrap command: {error}"))?;
                bytes.push(b'\n');
                use std::io::Write;
                child
                    .stdin
                    .as_mut()
                    .ok_or_else(|| "Pi stdin is unavailable".to_string())?
                    .write_all(&bytes)
                    .map_err(|error| format!("Cannot bootstrap Pi: {error}"))?;
                if std::env::var_os("FARFOLD_RPC_DIAGNOSTICS").is_some() {
                    eprintln!(
                        "[farfold-rpc] bootstrap wrote command={} generation={generation}",
                        command.kind()
                    );
                }
            }
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| "Cannot capture Pi stdout".to_string())?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| "Cannot capture Pi stderr".to_string())?;
            Ok((stdout, stderr))
        })();
        match bootstrap {
            Ok((stdout, stderr)) => Ok((child, stdout, stderr, project, session_dir)),
            Err(error) => {
                let cleanup = terminate_child(&mut child).err();
                Err(match cleanup {
                    Some(cleanup) => format!("{error}; {cleanup}"),
                    None => error,
                })
            }
        }
    })();

    let (child, stdout, stderr, project, session_dir) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            reset_start(&runtime, generation);
            return Err(error);
        }
    };
    let mut child = Some(child);
    let registered = {
        let mut lifecycle = runtime
            .lifecycle
            .lock()
            .map_err(|_| "Pi runtime state is unavailable".to_string())?;
        if matches!(
            &*lifecycle,
            RuntimeLifecycle::Starting {
                generation: current
            } if *current == generation
        ) {
            *lifecycle = RuntimeLifecycle::Running(RunningPi {
                child: child.take().expect("prepared Pi child is available"),
                generation,
                project_path: project.clone(),
                session_dir: session_dir.clone(),
            });
            true
        } else {
            false
        }
    };
    if !registered {
        terminate_child(
            child
                .as_mut()
                .expect("cancelled Pi child remains available"),
        )?;
        return Err("Pi start was cancelled".to_string());
    }
    watch_process(app.clone(), stdout, stderr, generation);
    emit(
        &app,
        generation,
        "lifecycle",
        json!({ "state": "started", "projectPath": project, "sessionDir": session_dir }),
    );
    status(&runtime)
}

pub fn pi_runtime_send(runtime: State<'_, PiRuntime>, command: PiCommand) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&command)
        .map_err(|error| format!("Cannot encode Pi RPC command: {error}"))?;
    bytes.push(b'\n');
    let command_type = command.kind();
    #[cfg(debug_assertions)]
    eprintln!(
        "[farfold] sending Pi RPC command {command_type} ({} bytes)",
        bytes.len()
    );

    let mut lifecycle = runtime
        .lifecycle
        .lock()
        .map_err(|_| "Pi runtime state is unavailable".to_string())?;
    let RuntimeLifecycle::Running(running) = &mut *lifecycle else {
        return Err("Pi is not running".to_string());
    };
    use std::io::Write;
    running
        .child
        .stdin
        .as_mut()
        .ok_or_else(|| "Pi stdin is unavailable".to_string())?
        .write_all(&bytes)
        .map_err(|error| format!("Cannot write to Pi: {error}"))?;
    if std::env::var_os("FARFOLD_RPC_DIAGNOSTICS").is_some() {
        eprintln!("[farfold-rpc] wrote command={command_type}");
    }
    Ok(())
}

pub fn pi_runtime_stop(
    app: AppHandle,
    runtime: State<'_, PiRuntime>,
) -> Result<RuntimeStatus, String> {
    stop_process(&runtime, Some(&app))?;
    status(&runtime)
}

pub(crate) fn stop_process(runtime: &PiRuntime, app: Option<&AppHandle>) -> Result<(), String> {
    enum StopTarget {
        Running(RunningPi, u64),
        Starting(u64),
        None,
    }

    let target = {
        let mut lifecycle = runtime
            .lifecycle
            .lock()
            .map_err(|_| "Pi runtime state is unavailable".to_string())?;
        match std::mem::replace(&mut *lifecycle, RuntimeLifecycle::Stopped) {
            RuntimeLifecycle::Running(running) => {
                let stop_generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
                *lifecycle = RuntimeLifecycle::Stopping {
                    generation: stop_generation,
                    project_path: running.project_path.clone(),
                    session_dir: running.session_dir.clone(),
                };
                StopTarget::Running(running, stop_generation)
            }
            RuntimeLifecycle::Starting { .. } => {
                let stop_generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
                StopTarget::Starting(stop_generation)
            }
            current @ RuntimeLifecycle::Stopping { .. } => {
                *lifecycle = current;
                StopTarget::None
            }
            RuntimeLifecycle::Stopped => StopTarget::None,
        }
    };

    let generation = match target {
        StopTarget::Running(mut running, stop_generation) => {
            let result = terminate_child(&mut running.child);
            if let Ok(mut lifecycle) = runtime.lifecycle.lock()
                && matches!(
                    &*lifecycle,
                    RuntimeLifecycle::Stopping {
                        generation: current,
                        ..
                    } if *current == stop_generation
                )
            {
                *lifecycle = RuntimeLifecycle::Stopped;
            }
            result?;
            Some(stop_generation)
        }
        StopTarget::Starting(generation) => Some(generation),
        StopTarget::None => None,
    };
    if let (Some(app), Some(generation)) = (app, generation) {
        emit(
            app,
            generation,
            "lifecycle",
            json!({ "state": "terminated", "reason": "stopped", "success": true }),
        );
    }
    Ok(())
}

pub fn pi_runtime_status(
    app: AppHandle,
    runtime: State<'_, PiRuntime>,
) -> Result<RuntimeStatus, String> {
    load_saved_session(&app, &runtime)?;
    status(&runtime)
}

pub fn pi_runtime_list_sessions(app: AppHandle) -> Result<Vec<SessionSummary>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Farfold data directory: {error}"))?;
    let session_dir = prepare_directory(&app_data.join("sessions"))?;
    let mut sessions = fs::read_dir(&session_dir)
        .map_err(|error| format!("Cannot read Farfold session storage: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|path| summarize_session(&path).ok())
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(sessions)
}

pub fn pi_runtime_project_readiness(project_path: String) -> Result<ProjectReadiness, String> {
    project_readiness(Path::new(&project_path))
}

pub fn pi_runtime_remember_session(
    app: AppHandle,
    runtime: State<'_, PiRuntime>,
    session_file: String,
) -> Result<bool, String> {
    let session_path = PathBuf::from(session_file);
    if !session_path.is_file() {
        return Ok(false);
    }
    let candidate = session_path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Pi session file: {error}"))?;
    let lifecycle = runtime
        .lifecycle
        .lock()
        .map_err(|_| "Pi runtime state is unavailable".to_string())?;
    let RuntimeLifecycle::Running(running) = &*lifecycle else {
        return Err("Pi is not running".to_string());
    };
    if !candidate.starts_with(&running.session_dir)
        || candidate.extension().is_none_or(|ext| ext != "jsonl")
    {
        return Err("Pi reported a session file outside Farfold session storage".to_string());
    }
    let session = SavedSession {
        project_path: running.project_path.clone(),
        session_file: candidate,
    };
    drop(lifecycle);
    if runtime
        .saved_session
        .lock()
        .map_err(|_| "Pi saved-session state is unavailable".to_string())?
        .as_ref()
        == Some(&session)
    {
        return Ok(false);
    }
    save_session(&app, &runtime, session)?;
    Ok(true)
}

pub fn pi_runtime_poll_events(runtime: State<'_, PiRuntime>) -> Result<Vec<Value>, String> {
    let mut events = runtime
        .events
        .lock()
        .map_err(|_| "Pi event queue is unavailable".to_string())?;
    let drained = events.drain(..).collect::<Vec<_>>();
    if std::env::var_os("FARFOLD_RPC_DIAGNOSTICS").is_some() && !drained.is_empty() {
        eprintln!("[farfold-rpc] poll drained={}", drained.len());
    }
    Ok(drained)
}

#[cfg(test)]
mod tests {
    use super::{
        JsonlBuffer, PiCommand, RuntimeLifecycle, RuntimePhase, SavedSession, atomic_write,
        begin_start, event_envelope, parse_protocol_line, project_readiness, session_display_title,
        summarize_session, terminate_child, validated_saved_session,
    };
    use serde_json::json;
    use std::{fs, path::PathBuf, process::Command};

    #[test]
    fn protocol_line_accepts_unicode_and_crlf() {
        let value =
            parse_protocol_line("{\"type\":\"event\",\"text\":\"你好 world\"}\r\n".as_bytes())
                .expect("valid Pi RPC line");
        assert_eq!(value["text"], "你好 world");
    }

    #[test]
    fn jsonl_buffer_preserves_unicode_separators_and_waits_for_lf() {
        let mut buffer = JsonlBuffer::default();
        assert!(buffer.push(b"{\"text\":\"").is_empty());
        assert!(buffer.push("你好 world\"}".as_bytes()).is_empty());
        let lines = buffer.push(b"\n{\"type\":\"next\"}\r\n");
        assert_eq!(lines.len(), 2);
        assert_eq!(
            parse_protocol_line(&lines[0]).unwrap()["text"],
            "你好 world"
        );
        assert_eq!(parse_protocol_line(&lines[1]).unwrap()["type"], "next");
    }

    #[test]
    fn lifecycle_rejects_a_second_start_while_starting() {
        let mut lifecycle = RuntimeLifecycle::Stopped;
        assert_eq!(begin_start(&mut lifecycle, 7).unwrap(), 7);
        assert!(matches!(
            lifecycle,
            RuntimeLifecycle::Starting { generation: 7 }
        ));
        assert!(begin_start(&mut lifecycle, 8).is_err());
    }

    #[test]
    fn every_event_carries_its_runtime_generation() {
        let event = event_envelope(11, "lifecycle", json!({ "state": "started" }));
        assert_eq!(event["generation"], 11);
        assert_eq!(event["kind"], "lifecycle");
        assert_eq!(event["payload"]["state"], "started");
    }

    #[test]
    fn runtime_phase_serializes_for_the_frontend() {
        assert_eq!(
            serde_json::to_value(RuntimePhase::Starting).unwrap(),
            "starting"
        );
        assert_eq!(
            serde_json::to_value(RuntimePhase::Stopping).unwrap(),
            "stopping"
        );
    }

    fn test_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "farfold-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn saved_session_must_belong_to_farfold_session_storage() {
        let root = test_directory("saved-session-boundary");
        let project = root.join("project");
        let session_dir = root.join("sessions");
        let outside = root.join("outside.jsonl");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(&outside, "{}\n").unwrap();
        let saved = SavedSession {
            project_path: project,
            session_file: outside,
        };

        assert!(validated_saved_session(saved, &session_dir).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saved_session_pointer_is_replaced_atomically() {
        let root = test_directory("atomic-session-pointer");
        let path = root.join("last-pi-session.json");
        atomic_write(&path, br#"{\"version\":1}"#).unwrap();
        atomic_write(&path, br#"{\"version\":2}"#).unwrap();

        assert_eq!(fs::read(&path).unwrap(), br#"{\"version\":2}"#);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_readiness_separates_context_files_from_protected_resources() {
        let root = test_directory("project-readiness");
        fs::write(root.join("AGENTS.md"), "read this").unwrap();
        fs::create_dir_all(root.join(".pi/skills/release-check")).unwrap();
        fs::create_dir_all(root.join(".pi/extensions")).unwrap();
        fs::write(root.join(".pi/extensions/status.ts"), "export {};").unwrap();

        let readiness = project_readiness(&root).unwrap();
        assert_eq!(readiness.context_files, vec!["AGENTS.md"]);
        assert_eq!(
            readiness.protected_resources,
            vec![
                super::ProjectResource {
                    kind: "skill".to_string(),
                    entries: 1,
                    sources: vec![".pi/skills".to_string()],
                },
                super::ProjectResource {
                    kind: "extension".to_string(),
                    entries: 1,
                    sources: vec![".pi/extensions".to_string()],
                },
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_readiness_matches_pi_project_context_and_direct_resources() {
        let root = test_directory("project-readiness-ancestors");
        let project = root.join("nested/project");
        fs::create_dir_all(project.join(".pi/themes")).unwrap();
        fs::create_dir_all(root.join(".agents/skills/parent-skill")).unwrap();
        fs::write(root.join("AGENTS.md"), "parent instructions").unwrap();
        fs::write(project.join("AGENTS.override.md"), "project instructions").unwrap();
        fs::write(project.join(".pi/SYSTEM.md"), "replace system").unwrap();
        fs::write(project.join(".pi/APPEND_SYSTEM.md"), "append system").unwrap();
        fs::write(project.join(".pi/themes/dark.json"), "{}").unwrap();

        let readiness = project_readiness(&project).unwrap();
        assert!(
            readiness
                .context_files
                .contains(&"../../AGENTS.md".to_string())
        );
        assert!(
            readiness
                .context_files
                .contains(&"AGENTS.override.md".to_string())
        );
        assert_eq!(
            readiness.protected_resources,
            vec![
                super::ProjectResource {
                    kind: "theme".to_string(),
                    entries: 1,
                    sources: vec![".pi/themes".to_string()],
                },
                super::ProjectResource {
                    kind: "system".to_string(),
                    entries: 1,
                    sources: vec![".pi/SYSTEM.md".to_string()],
                },
                super::ProjectResource {
                    kind: "append-system".to_string(),
                    entries: 1,
                    sources: vec![".pi/APPEND_SYSTEM.md".to_string()],
                },
                super::ProjectResource {
                    kind: "agent-skill".to_string(),
                    entries: 1,
                    sources: vec!["../../.agents/skills".to_string()],
                },
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_titles_exclude_skill_directives_and_paths() {
        assert_eq!(
            session_display_title(
                "<skill name=\"gate0\">hidden</skill>\n请修改 /tmp/project/check.txt 并验证"
            ),
            "请修改 并验证"
        );
        assert_eq!(
            session_display_title(
                "请检查 [配置](file:///Users/tw/private.json) 和 (file:///tmp/output.md)"
            ),
            "请检查 配置 和"
        );
        assert_eq!(session_display_title("```\nprivate\n```"), "新对话");
    }

    #[test]
    fn saved_manual_session_names_preserve_user_paths() {
        let root = test_directory("manual-session-title");
        let session = root.join("session.jsonl");
        fs::write(
            &session,
            concat!(
                "{\"type\":\"session\",\"id\":\"session-1\",\"cwd\":\"/tmp/project\"}\n",
                "{\"type\":\"session_info\",\"name\":\"修复 /docs 登录问题\"}\n"
            ),
        )
        .unwrap();

        assert_eq!(
            summarize_session(&session).unwrap().title,
            "修复 /docs 登录问题"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stopping_a_child_also_reaps_it() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .unwrap();
        terminate_child(&mut child).unwrap();

        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn rpc_boundary_rejects_commands_outside_gate_zero() {
        assert!(
            serde_json::from_value::<PiCommand>(json!({ "type": "delete_everything" })).is_err()
        );
        let command = serde_json::from_value::<PiCommand>(json!({
            "type": "set_model",
            "id": "req-1",
            "provider": "openai",
            "modelId": "gpt-test"
        }))
        .unwrap();
        assert_eq!(command.kind(), "set_model");
        let command = serde_json::from_value::<PiCommand>(json!({
            "type": "set_session_name",
            "id": "req-2",
            "name": "修复登录"
        }))
        .unwrap();
        assert_eq!(command.kind(), "set_session_name");
    }
}
