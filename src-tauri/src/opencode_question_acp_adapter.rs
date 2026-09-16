use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

pub const OPENCODE_QUESTION_ACP_ADAPTER_ARGUMENT: &str =
    "--farfold-opencode-question-acp-adapter-v1";

const MAX_FRAME: usize = 1024 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone)]
struct Peer {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl Peer {
    fn stdout() -> Self {
        Self {
            writer: Arc::new(Mutex::new(Box::new(std::io::stdout()))),
        }
    }

    fn write(&self, envelope: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(envelope).map_err(|error| error.to_string())?;
        if line.len() > MAX_FRAME {
            return Err("ACP adapter frame exceeds size limit".to_string());
        }
        line.push(b'\n');
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "ACP adapter stdout is unavailable".to_string())?;
        writer.write_all(&line).map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
    }

    fn respond(&self, id: Value, result: Value) {
        let _ = self.write(&json!({"jsonrpc":"2.0","id":id,"result":result}));
    }

    fn error(&self, id: Value, message: impl Into<String>) {
        let _ = self.write(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": -32000, "message": message.into()}
        }));
    }
}

struct NativeServer {
    base: String,
    workspace: PathBuf,
    child: Child,
}

struct AdapterState {
    opencode: Option<NativeServer>,
    pending_reverse: HashMap<String, mpsc::SyncSender<Result<Value, String>>>,
    projections: HashMap<String, SessionProjection>,
    configs: HashMap<String, SessionConfig>,
    active_sessions: HashSet<String>,
    form_elicitation: bool,
}

impl AdapterState {
    fn ensure_opencode(&mut self) -> Result<&NativeServer, String> {
        if self.opencode.is_none() {
            self.opencode = Some(start_opencode_serve()?);
        }
        Ok(self.opencode.as_ref().expect("server just started"))
    }
}

#[derive(Default)]
struct SessionProjection {
    text_prefixes: HashMap<String, String>,
    tool_snapshots: HashMap<String, String>,
    replayed_history: bool,
}

pub fn run_opencode_question_acp_adapter() -> Result<(), String> {
    crate::transport_security::ensure_rustls_crypto_provider();
    let peer = Peer::stdout();
    let state = Arc::new(Mutex::new(AdapterState {
        opencode: None,
        pending_reverse: HashMap::new(),
        projections: HashMap::new(),
        configs: HashMap::new(),
        active_sessions: HashSet::new(),
        form_elicitation: false,
    }));
    let (messages, receiver) = mpsc::sync_channel::<Value>(64);
    thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                break;
            };
            if line.len() > MAX_FRAME {
                break;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                break;
            };
            if messages.send(value).is_err() {
                break;
            }
        }
    });

    while let Ok(message) = receiver.recv() {
        let method = message.get("method").and_then(Value::as_str);
        if method.is_none() {
            dispatch_reverse_response(&state, &message);
            continue;
        }
        let id = message.get("id").cloned();
        match method.unwrap_or_default() {
            "initialize" => {
                if let Some(id) = id {
                    if let Ok(mut guard) = state.lock() {
                        guard.form_elicitation = message
                            .pointer("/params/clientCapabilities/elicitation/form")
                            .is_some_and(Value::is_object);
                    }
                    peer.respond(
                        id,
                        json!({
                            "protocolVersion": 1,
                            "agentInfo": {
                                "name": "Farfold OpenCode Question ACP Adapter",
                                "version": crate::opencode_acp::OPENCODE_ACP_VERSION_FOR_ADAPTER,
                            },
                            "agentCapabilities": {
                                "loadSession": true,
                                "farfoldOpenCodeQuestionBridge": true
                            }
                        }),
                    );
                }
            }
            "initialized" => {}
            "session/new" => match create_session(&state) {
                Ok((session_id, config_options)) => {
                    if let Some(id) = id {
                        peer.respond(
                            id,
                            json!({"sessionId": session_id, "configOptions": config_options}),
                        );
                    }
                }
                Err(error) => {
                    if let Some(id) = id {
                        peer.error(id, error);
                    }
                }
            },
            "session/load" => {
                let session_id = message
                    .pointer("/params/sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                match load_session(&peer, &state, &session_id) {
                    Ok(config_options) => {
                        if let Some(id) = id {
                            peer.respond(
                                id,
                                json!({"sessionId": session_id, "configOptions": config_options}),
                            );
                        }
                    }
                    Err(error) => {
                        if let Some(id) = id {
                            peer.error(id, error);
                        }
                    }
                }
            }
            "session/close" => {
                if let Some(id) = id {
                    let session_id = message
                        .pointer("/params/sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let result = state
                        .lock()
                        .map_err(|_| "Adapter state unavailable")
                        .and_then(|mut guard| {
                            if guard.active_sessions.contains(session_id) {
                                return Err("Cannot close an active session");
                            }
                            if guard.configs.remove(session_id).is_none() {
                                return Err("Session is not loaded");
                            }
                            guard.projections.remove(session_id);
                            Ok(())
                        });
                    match result {
                        Ok(()) => peer.respond(id, json!({})),
                        Err(error) => peer.error(id, error),
                    }
                }
            }
            "session/prompt" => {
                if let Some(id) = id {
                    let session_id = message
                        .pointer("/params/sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let accepted = state
                        .lock()
                        .map(|mut guard| {
                            guard.configs.contains_key(session_id)
                                && guard.active_sessions.insert(session_id.to_string())
                        })
                        .unwrap_or(false);
                    if !accepted {
                        peer.error(id, "Session is not loaded or already has an active prompt");
                        continue;
                    }
                    let peer = peer.clone();
                    let state = state.clone();
                    thread::spawn(move || handle_prompt(peer, state, id, message));
                }
            }
            "session/set_config_option" | "session/set_mode" | "session/set_model" => {
                if let Some(id) = id {
                    match set_session_config(&state, &message) {
                        Ok(options) => peer.respond(id, json!({"configOptions": options})),
                        Err(error) => peer.error(id, error),
                    }
                }
            }
            "session/cancel" => {
                let session_id = message
                    .pointer("/params/sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let result = cancel_session(&state, &session_id);
                if let Some(id) = id {
                    match result {
                        Ok(()) => peer.respond(id, json!({})),
                        Err(error) => peer.error(id, error),
                    }
                }
            }
            _ => {
                if let Some(id) = id {
                    peer.error(id, "Unsupported ACP method");
                }
            }
        }
    }
    if let Ok(mut state) = state.lock()
        && let Some(mut opencode) = state.opencode.take()
    {
        let _ = opencode.child.kill();
        let _ = opencode.child.wait();
    }
    Ok(())
}

fn dispatch_reverse_response(state: &Arc<Mutex<AdapterState>>, message: &Value) {
    let Some(id) = message.get("id") else {
        return;
    };
    let key = json_rpc_id_key(id);
    let sender = state
        .lock()
        .ok()
        .and_then(|mut state| state.pending_reverse.remove(&key));
    if let Some(sender) = sender {
        let response = match (message.get("result"), message.get("error")) {
            (Some(result), None) => Ok(result.clone()),
            (None, Some(_)) => Err(
                "ACP client returned an interaction error; no native answer was submitted"
                    .to_string(),
            ),
            _ => Err(
                "ACP client interaction response is invalid; no native answer was submitted"
                    .to_string(),
            ),
        };
        let _ = sender.send(response);
    }
}

fn create_session(state: &Arc<Mutex<AdapterState>>) -> Result<(String, Value), String> {
    let mut guard = state
        .lock()
        .map_err(|_| "OpenCode adapter state is unavailable".to_string())?;
    let opencode = guard.ensure_opencode()?;
    let response = request_json(
        &opencode.base,
        "POST",
        "/session",
        Some(&opencode.workspace),
        Some(json!({})),
    )?;
    let session_id = response
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "OpenCode did not return a native session id".to_string())?;
    let config = SessionConfig::load(opencode, &response, &[])?;
    let options = config.options();
    guard.configs.insert(session_id.clone(), config);
    Ok((session_id, options))
}

fn load_session(
    peer: &Peer,
    state: &Arc<Mutex<AdapterState>>,
    session_id: &str,
) -> Result<Value, String> {
    let mut guard = state
        .lock()
        .map_err(|_| "OpenCode adapter state is unavailable".to_string())?;
    if guard.active_sessions.contains(session_id) {
        return Err("Cannot load history while this session has an active prompt".into());
    }
    let opencode = guard.ensure_opencode()?;
    let path = format!("/session/{session_id}");
    let session = request_json(
        &opencode.base,
        "GET",
        &path,
        Some(&opencode.workspace),
        None,
    )?;
    let messages = session_messages(&opencode.base, &opencode.workspace, session_id)?;
    let pending_question =
        native_request(&opencode.base, &opencode.workspace, session_id, "/question")?;
    let unavailable_questions = unavailable_question_tools(&messages, pending_question.as_ref());
    let config = SessionConfig::load(opencode, &session, &messages)?;
    let options = guard
        .configs
        .entry(session_id.to_string())
        .or_insert(config)
        .options();
    let projection = guard.projections.entry(session_id.to_string()).or_default();
    if !projection.replayed_history {
        emit_message_updates(peer, session_id, &messages, projection)?;
        projection.replayed_history = true;
    }
    if !unavailable_questions.is_empty() {
        peer.write(
            &json!({"jsonrpc":"2.0","method":"_farfold/session_recovery","params":{
                "sessionId":session_id,"unavailableQuestions":unavailable_questions,
                "reason":"native_question_no_longer_pending"
            }}),
        )?;
    }
    Ok(options)
}

fn unavailable_question_tools(messages: &[Value], pending: Option<&Value>) -> Vec<Value> {
    messages.iter().flat_map(|message| message["parts"].as_array().into_iter().flatten())
        .filter(|part| part["type"] == "tool" && part["tool"] == "question")
        .filter(|part| part["state"]["status"] == "running" || part["state"]["status"] == "pending"
            || part.pointer("/state/metadata/interrupted") == Some(&Value::Bool(true)))
        .filter(|part| !pending.is_some_and(|question| question.pointer("/tool/callID").is_some_and(|call| Some(call) == part.get("callID"))))
        .map(|part| json!({"nativePartId":part["id"],"nativeCallId":part["callID"],"nativeState":part["state"]["status"]}))
        .collect()
}

fn cancel_session(state: &Arc<Mutex<AdapterState>>, session_id: &str) -> Result<(), String> {
    let guard = state
        .lock()
        .map_err(|_| "OpenCode adapter state is unavailable".to_string())?;
    let Some(opencode) = guard.opencode.as_ref() else {
        return Ok(());
    };
    let path = format!("/session/{session_id}/abort");
    request_json(
        &opencode.base,
        "POST",
        &path,
        Some(&opencode.workspace),
        None,
    )
    .map(|_| ())
}

fn handle_prompt(peer: Peer, state: Arc<Mutex<AdapterState>>, id: Value, message: Value) {
    let result = handle_prompt_result(peer.clone(), state.clone(), &message);
    if let Ok(mut guard) = state.lock() {
        guard.active_sessions.remove(
            message
                .pointer("/params/sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
    }
    match result {
        Ok(response) if response.get("farfoldNativeFailure").is_some() => {
            let _ = peer.write(&json!({"jsonrpc":"2.0","id":id,"error":{
                "code":-32000,"message":"Native OpenCode request failed","data":response
            }}));
        }
        Ok(response) => peer.respond(id, response),
        Err(error) => {
            let _ = peer.write(&json!({"jsonrpc":"2.0","id":id,"error":{
                "code":-32000,"message":error,"data":{"farfoldOutcomeUnknown":true}
            }}));
        }
    }
}

fn handle_prompt_result(
    peer: Peer,
    state: Arc<Mutex<AdapterState>>,
    message: &Value,
) -> Result<Value, String> {
    let session_id = message
        .pointer("/params/sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "session/prompt missing sessionId".to_string())?
        .to_string();
    let parts = prompt_parts(message)?;
    let (base, workspace) = {
        let mut guard = state
            .lock()
            .map_err(|_| "OpenCode adapter state is unavailable".to_string())?;
        let opencode = guard.ensure_opencode()?;
        (opencode.base.clone(), opencode.workspace.clone())
    };
    let history = session_messages(&base, &workspace, &session_id)?;
    let body = state
        .lock()
        .map_err(|_| "Adapter state unavailable")?
        .configs
        .get(&session_id)
        .ok_or("Session configuration unavailable")?
        .prompt_body(parts);
    let previous_ids: HashSet<String> = history
        .iter()
        .filter_map(|message| {
            message
                .pointer("/info/id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let (completed, completion) = mpsc::sync_channel(1);
    let request_base = base.clone();
    let request_workspace = workspace.clone();
    let path = format!("/session/{session_id}/message");
    thread::spawn(move || {
        let result = request_json_timeout(
            &request_base,
            "POST",
            &path,
            Some(&request_workspace),
            Some(body),
            None,
        );
        let _ = completed.send(result);
    });
    let mut permission_cancelled = false;
    loop {
        if let Some(question) = native_request(&base, &workspace, &session_id, "/question")? {
            if !state
                .lock()
                .map_err(|_| "Adapter state unavailable")?
                .form_elicitation
            {
                return Err("ACP client did not advertise form elicitation; native question remains unanswered".into());
            }
            let request_id = format!(
                "elicitation-{}",
                question
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            );
            let result = reverse_request(
                &peer,
                &state,
                &request_id,
                "elicitation/create",
                form_elicitation_params(&session_id, &question),
            )?;
            if let Some(result) = result {
                respond_to_question(&base, &workspace, &question, &result)?;
            }
            continue;
        }
        if let Some(permission) = native_request(&base, &workspace, &session_id, "/permission")? {
            let request_id = format!(
                "permission-{}",
                permission
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            );
            let result = reverse_request(
                &peer,
                &state,
                &request_id,
                "session/request_permission",
                permission_params(&session_id, &permission),
            )?;
            let Some(result) = result else { continue };
            let cancelled =
                result.pointer("/outcome/outcome").and_then(Value::as_str) == Some("cancelled");
            respond_to_permission(&base, &workspace, &session_id, &permission, &result)?;
            if cancelled {
                cancel_session(&state, &session_id)?;
                permission_cancelled = true;
            }
            continue;
        }
        let messages = session_messages(&base, &workspace, &session_id)?;
        project_messages(&peer, &state, &session_id, &messages)?;
        if let Ok(result) = completion.try_recv() {
            let response = result?;
            let messages = session_messages(&base, &workspace, &session_id)?;
            let _ = project_messages(&peer, &state, &session_id, &messages)?;
            if let Some(failure) =
                native_prompt_failure(&response, &session_id, &previous_ids, &messages)?
            {
                return Ok(failure);
            }
            let reason = prompt_stop_reason(&response, &session_id, &previous_ids, &messages)?;
            project_messages(&peer, &state, &session_id, std::slice::from_ref(&response))?;
            let reason = if permission_cancelled {
                "cancelled"
            } else {
                reason
            };
            let mut result = json!({"stopReason":reason});
            if reason != "cancelled"
                && let Some(receipt) = native_provider_receipt(&response)
            {
                result["_meta"] = json!({"farfoldNativeProviderRequest":receipt});
            }
            return Ok(result);
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn native_provider_receipt(response: &Value) -> Option<Value> {
    let info = &response["info"];
    let provider = info["providerID"].as_str()?;
    let model = info["modelID"].as_str()?;
    Some(json!({
        "sessionId": info["sessionID"].as_str()?,
        "assistantMessageId": info["id"].as_str()?,
        "userMessageId": info["parentID"].as_str()?,
        "runtimeProviderId": provider,
        "runtimeModelId": format!("{provider}/{model}"),
        "completedAt": info.pointer("/time/completed")?.as_u64()?
    }))
}

fn prompt_stop_reason(
    response: &Value,
    session_id: &str,
    previous_ids: &HashSet<String>,
    messages: &[Value],
) -> Result<&'static str, String> {
    verify_prompt_parent(response, session_id, previous_ids, messages)?;
    let info = &response["info"];
    if let Some(error) = info.get("error").filter(|error| !error.is_null()) {
        if error["name"] == "MessageAbortedError" {
            return Ok("cancelled");
        }
        return Err("OpenCode prompt failed; native Session retained".into());
    }
    if info
        .pointer("/time/completed")
        .and_then(Value::as_u64)
        .is_none()
    {
        return Err("OpenCode prompt response has no native assistant completion".into());
    }
    match info["finish"].as_str() {
        Some("length") => Ok("max_tokens"),
        Some("stop") => Ok("end_turn"),
        // Only the synchronous native result may terminate after a rejected tool.
        Some("tool-calls") if native_tools_settled(response) => Ok("end_turn"),
        other => Err(format!(
            "OpenCode prompt returned an unconfirmed finish reason: {other:?}"
        )),
    }
}

fn verify_prompt_parent(
    response: &Value,
    session_id: &str,
    previous_ids: &HashSet<String>,
    messages: &[Value],
) -> Result<(), String> {
    let info = &response["info"];
    let parent = info["parentID"].as_str().unwrap_or_default();
    if info["role"] != "assistant"
        || info["sessionID"] != session_id
        || previous_ids.contains(parent)
        || !messages
            .iter()
            .any(|message| message["info"]["id"] == parent && message["info"]["role"] == "user")
    {
        return Err(
            "OpenCode prompt response is not associated with this prompt's native user message"
                .into(),
        );
    }
    Ok(())
}

fn native_tools_settled(response: &Value) -> bool {
    response["parts"].as_array().is_some_and(|parts| {
        parts.iter().any(|part| part["type"] == "tool")
            && parts
                .iter()
                .filter(|part| part["type"] == "tool")
                .all(|part| {
                    matches!(
                        part["state"]["status"].as_str(),
                        Some("completed" | "error")
                    )
                })
    })
}

fn native_prompt_failure(
    response: &Value,
    session_id: &str,
    previous_ids: &HashSet<String>,
    messages: &[Value],
) -> Result<Option<Value>, String> {
    let Some(kind @ ("APIError" | "ProviderAuthError" | "ContextOverflowError")) =
        response.pointer("/info/error/name").and_then(Value::as_str)
    else {
        return Ok(None);
    };
    verify_prompt_parent(response, session_id, previous_ids, messages)?;
    if response["parts"].as_array().is_none_or(|parts| {
        parts.iter().any(|part| {
            part["type"] == "tool"
                && !matches!(
                    part["state"]["status"].as_str(),
                    Some("completed" | "error")
                )
        })
    }) {
        return Err("Native failed prompt still has unsettled tools".into());
    }
    let receipt = native_provider_receipt(response)
        .ok_or("Native failed prompt has no completed Provider receipt")?;
    // Never include native error messages, HTTP bodies or headers in the client receipt.
    Ok(Some(
        json!({"farfoldNativeFailure":kind,"_meta":{"farfoldNativeProviderRequest":receipt}}),
    ))
}

fn project_messages(
    peer: &Peer,
    state: &Arc<Mutex<AdapterState>>,
    session_id: &str,
    messages: &[Value],
) -> Result<bool, String> {
    let mut guard = state
        .lock()
        .map_err(|_| "OpenCode adapter state is unavailable".to_string())?;
    let projection = guard.projections.entry(session_id.to_string()).or_default();
    emit_message_updates(peer, session_id, messages, projection)
}

fn emit_message_updates(
    peer: &Peer,
    session_id: &str,
    messages: &[Value],
    projection: &mut SessionProjection,
) -> Result<bool, String> {
    let mut emitted = false;
    for (message_index, message) in messages.iter().enumerate() {
        let info = message.get("info").unwrap_or(message);
        let role = info.get("role").and_then(Value::as_str).unwrap_or_default();
        let message_id = info
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("opencode-message-{message_index}"));
        let parts = message
            .get("parts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (part_index, part) in parts.iter().enumerate() {
            if part.get("type").and_then(Value::as_str) == Some("tool") {
                if emit_tool_update(peer, session_id, &message_id, part, projection)? {
                    emitted = true;
                }
                continue;
            }
            if part.get("type").and_then(Value::as_str) != Some("text") {
                continue;
            }
            let Some(text) = part.get("text").and_then(Value::as_str) else {
                continue;
            };
            if text.is_empty() {
                continue;
            }
            let key = format!(
                "{}:{}",
                message_id,
                part.get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| part_index.to_string())
            );
            let previous = projection.text_prefixes.entry(key).or_default();
            let delta = text
                .strip_prefix(previous.as_str())
                .filter(|delta| !delta.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if previous == text {
                        String::new()
                    } else {
                        text.to_string()
                    }
                });
            if delta.is_empty() {
                continue;
            }
            *previous = text.to_string();
            let session_update = match role {
                "user" => "user_message_chunk",
                "assistant" => "agent_message_chunk",
                _ => continue,
            };
            peer.write(&json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": session_update,
                        "messageId": message_id,
                        "content": {"type": "text", "text": delta}
                    }
                }
            }))?;
            emitted = true;
        }
    }
    Ok(emitted)
}

fn emit_tool_update(
    peer: &Peer,
    session_id: &str,
    message_id: &str,
    part: &Value,
    projection: &mut SessionProjection,
) -> Result<bool, String> {
    let tool_call_id = part
        .get("id")
        .or_else(|| part.get("callID"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{message_id}-tool"));
    let snapshot = serde_json::to_string(part).map_err(|error| error.to_string())?;
    if projection.tool_snapshots.get(&tool_call_id) == Some(&snapshot) {
        return Ok(false);
    }
    let first = !projection.tool_snapshots.contains_key(&tool_call_id);
    projection
        .tool_snapshots
        .insert(tool_call_id.clone(), snapshot);
    let state = part.get("state").unwrap_or(&Value::Null);
    let status = match state.get("status").and_then(Value::as_str) {
        Some("completed") => "completed",
        Some("error") => "failed",
        Some("running") => "in_progress",
        _ => "pending",
    };
    let output = state
        .get("output")
        .or_else(|| state.get("error"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let content = if output.is_empty() {
        json!([])
    } else {
        json!([{"type":"content","content":{"type":"text","text":output}}])
    };
    peer.write(&json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": if first { "tool_call" } else { "tool_call_update" },
                "toolCallId": tool_call_id,
                "title": state.get("title").and_then(Value::as_str)
                    .or_else(|| part.get("tool").and_then(Value::as_str))
                    .unwrap_or("OpenCode tool"),
                "name": part.get("tool").and_then(Value::as_str).unwrap_or("tool"),
                "status": status,
                "content": content,
                "rawInput": state.get("input").cloned().unwrap_or(Value::Null),
                "rawOutput": state.get("output").cloned().unwrap_or(Value::Null),
                "_meta": {"farfoldOpenCodeMessageId": message_id}
            }
        }
    }))?;
    Ok(true)
}

fn prompt_parts(message: &Value) -> Result<Value, String> {
    let prompt = message
        .pointer("/params/prompt")
        .and_then(Value::as_array)
        .ok_or_else(|| "session/prompt missing prompt text".to_string())?;
    let mut parts = Vec::new();
    for item in prompt {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("text");
        if item_type != "text" {
            return Err(format!(
                "OpenCode question adapter does not yet support ACP prompt block type {item_type}"
            ));
        }
        let text = item
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| "ACP text prompt block missing text".to_string())?;
        parts.push(json!({"type":"text","text":text}));
    }
    if parts.is_empty() {
        return Err("session/prompt has no text blocks".to_string());
    }
    Ok(Value::Array(parts))
}

fn reverse_request(
    peer: &Peer,
    state: &Arc<Mutex<AdapterState>>,
    request_id: &str,
    method: &str,
    params: Value,
) -> Result<Option<Value>, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    {
        let mut guard = state
            .lock()
            .map_err(|_| "OpenCode adapter state is unavailable".to_string())?;
        guard.pending_reverse.insert(request_id.to_string(), sender);
    }
    let result = (|| {
        peer.write(&json!({"jsonrpc":"2.0","id":request_id,"method":method,"params":params}))?;
        loop {
            match receiver.recv_timeout(Duration::from_secs(1)) {
                Ok(value) => return value.map(Some),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            // Human input has no deadline. Native cancellation still invalidates
            // the request, so a stopped turn cannot remain blocked on this channel.
            let (base, workspace) = {
                let guard = state.lock().map_err(|_| "Adapter state unavailable")?;
                let Some(server) = guard.opencode.as_ref() else {
                    return Ok(None);
                };
                (server.base.clone(), server.workspace.clone())
            };
            let session_id = params["sessionId"]
                .as_str()
                .ok_or("Missing interaction session")?;
            let path = if method == "elicitation/create" {
                "/question"
            } else {
                "/permission"
            };
            let pending = native_request(&base, &workspace, session_id, path)?;
            let expected = request_id
                .split_once('-')
                .map(|(_, id)| id)
                .unwrap_or_default();
            if pending.as_ref().and_then(|value| value["id"].as_str()) != Some(expected) {
                return Ok(None);
            }
        }
    })();
    if let Ok(mut guard) = state.lock() {
        guard.pending_reverse.remove(request_id);
    }
    result
}

fn respond_to_question(
    base: &str,
    workspace: &PathBuf,
    question: &Value,
    result: &Value,
) -> Result<(), String> {
    let question_id = question
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "OpenCode question is missing id".to_string())?;
    let action = result
        .get("action")
        .or_else(|| result.get("outcome"))
        .and_then(Value::as_str)
        .ok_or("ACP question response is missing its action")?;
    if action == "accept" {
        let answers = question_answers(question, &result["content"])?;
        let path = format!("/question/{question_id}/reply");
        request_json(
            base,
            "POST",
            &path,
            Some(workspace),
            Some(json!({"answers":answers})),
        )
        .map(|_| ())
    } else if action == "decline" || action == "cancel" {
        let path = format!("/question/{question_id}/reject");
        request_json(base, "POST", &path, Some(workspace), None).map(|_| ())
    } else {
        Err("ACP question response action is unsupported".to_string())
    }
}

fn question_field(index: usize) -> String {
    if index == 0 {
        "choice".to_string()
    } else {
        format!("choice{index}")
    }
}

fn question_answers(question: &Value, content: &Value) -> Result<Vec<Vec<String>>, String> {
    let questions = question["questions"]
        .as_array()
        .ok_or("Missing native questions")?;
    questions
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let key = question_field(index);
            let multiple = item["multiple"] == true;
            let mut values: Vec<String> = match content.get(&key) {
                Some(Value::String(value)) if !multiple => vec![value.clone()],
                Some(Value::Array(values)) if multiple => values
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_string)
                            .ok_or("Invalid selection")
                    })
                    .collect::<Result<_, _>>()?,
                None | Some(Value::Null) => Vec::new(),
                _ => return Err("Invalid native question response shape".to_string()),
            };
            let options = item["options"].as_array().ok_or("Missing native options")?;
            if values.iter().any(|value| {
                !options
                    .iter()
                    .any(|option| option["label"].as_str() == Some(value))
            }) {
                return Err("Question response contains an unavailable option".to_string());
            }
            if let Some(custom) = content
                .get(format!("{key}_other"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                if item["custom"] == false {
                    return Err("Custom answers are disabled for this question".to_string());
                }
                if !multiple {
                    values.clear();
                }
                values.push(custom.to_string());
            }
            let mut seen = HashSet::new();
            values.retain(|value| seen.insert(value.clone()));
            if values.is_empty() {
                return Err("A native question has no answer".to_string());
            }
            Ok(values)
        })
        .collect()
}

fn respond_to_permission(
    base: &str,
    workspace: &PathBuf,
    session_id: &str,
    permission: &Value,
    result: &Value,
) -> Result<(), String> {
    let permission_id = permission
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "OpenCode permission is missing id".to_string())?;
    let response = permission_response(result)?;
    let path = format!("/session/{session_id}/permissions/{permission_id}");
    request_json(
        base,
        "POST",
        &path,
        Some(workspace),
        Some(json!({"response":response})),
    )
    .map(|_| ())
}

fn permission_response(result: &Value) -> Result<&'static str, String> {
    match result.pointer("/outcome/outcome").and_then(Value::as_str) {
        Some("cancelled") => Ok("reject"),
        Some("selected") => match result.pointer("/outcome/optionId").and_then(Value::as_str) {
            Some("once" | "allow-once") => Ok("once"),
            Some("always" | "allow-always") => Ok("always"),
            Some("reject") => Ok("reject"),
            _ => Err("ACP permission response has an unknown option".into()),
        },
        _ => Err("ACP permission response has no valid outcome".into()),
    }
}

fn native_request(
    base: &str,
    workspace: &PathBuf,
    session_id: &str,
    path: &str,
) -> Result<Option<Value>, String> {
    let response = request_json(base, "GET", path, Some(workspace), None)?;
    let items = response
        .as_array()
        .cloned()
        .or_else(|| response.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    Ok(items.into_iter().find(|item| {
        item.get("sessionID")
            .or_else(|| item.get("sessionId"))
            .and_then(Value::as_str)
            == Some(session_id)
    }))
}

fn session_messages(
    base: &str,
    workspace: &PathBuf,
    session_id: &str,
) -> Result<Vec<Value>, String> {
    let path = format!("/session/{session_id}/message");
    let response = request_json(base, "GET", &path, Some(workspace), None)?;
    response
        .as_array()
        .cloned()
        .ok_or_else(|| "OpenCode Session messages were not an array".to_string())
}

fn form_elicitation_params(session_id: &str, question: &Value) -> Value {
    let native_question_id = question
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let questions = question
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    for (index, item) in questions.iter().enumerate() {
        let key = question_field(index);
        let options: Vec<Value> = item["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|option| option.get("label").cloned())
            .collect();
        let multiple = item["multiple"] == true;
        let custom = item["custom"] != false;
        let mut field = if multiple {
            json!({"type":"array","items":{"type":"string","enum":options}})
        } else {
            json!({"type":"string","enum":options})
        };
        field["title"] = item["question"].clone();
        field["_meta"] = json!({"farfoldQuestionOptions":item["options"],"farfoldCustomField":if custom { Some(format!("{key}_other")) } else { None }});
        properties.insert(key.clone(), field);
        if custom {
            properties.insert(
                format!("{key}_other"),
                json!({"type":"string","title":"其他回答","_meta":{"farfoldCustomFor":key}}),
            );
        } else {
            required.push(key);
        }
    }
    let message = questions
        .first()
        .and_then(|item| item["question"].as_str())
        .unwrap_or("OpenCode needs input");
    json!({
        "sessionId": session_id,
        "mode": "form",
        "message": message,
        "requestedSchema": {
            "type": "object",
            "properties": properties,
            "required": required
        },
        "_meta": {"farfoldNativeQuestionId": native_question_id}
    })
}

fn permission_params(session_id: &str, permission: &Value) -> Value {
    let tool_call = json!({
        "toolCallId":permission.pointer("/tool/callID").or_else(|| permission.get("id")),
        "title":permission.get("permission").and_then(Value::as_str).unwrap_or("OpenCode tool"),
        "rawInput":permission.get("metadata"),
        "_meta":{"farfoldPermissionPatterns":permission.get("patterns")}
    });
    json!({
        "sessionId": session_id,
        "requestId": permission.get("id").cloned().unwrap_or(Value::Null),
        "toolCall": tool_call,
        "options": [
            {"optionId":"once","name":"Allow once","kind":"allow_once"},
            {"optionId":"always","name":"Always allow","kind":"allow_always"},
            {"optionId":"reject","name":"Reject","kind":"reject_once"}
        ],
        "nativeEnvelope": permission
    })
}

#[derive(Clone)]
struct SessionConfig {
    models: Vec<Value>,
    modes: Vec<Value>,
    variants: HashMap<String, Vec<String>>,
    model: String,
    mode: String,
    variant: Option<String>,
}

impl SessionConfig {
    fn load(server: &NativeServer, session: &Value, messages: &[Value]) -> Result<Self, String> {
        let providers = request_json(
            &server.base,
            "GET",
            "/config/providers",
            Some(&server.workspace),
            None,
        )?;
        let agents = request_json(&server.base, "GET", "/agent", Some(&server.workspace), None)?;
        let config = request_json(
            &server.base,
            "GET",
            "/config",
            Some(&server.workspace),
            None,
        )?;
        Self::from_native(&providers, &agents, &config, session, messages)
    }

    fn from_native(
        providers: &Value,
        agents: &Value,
        config: &Value,
        session: &Value,
        messages: &[Value],
    ) -> Result<Self, String> {
        let mut models = Vec::new();
        let mut variants = HashMap::new();
        for provider in providers["providers"].as_array().into_iter().flatten() {
            let Some(provider_id) = provider["id"].as_str() else {
                continue;
            };
            for (model_id, model) in provider["models"].as_object().into_iter().flatten() {
                let value = format!("{provider_id}/{model_id}");
                models.push(json!({"value":value, "name":format!("{} / {}", provider["name"].as_str().unwrap_or(provider_id), model["name"].as_str().unwrap_or(model_id))}));
                variants.insert(
                    value,
                    model["variants"]
                        .as_object()
                        .map(|map| map.keys().cloned().collect())
                        .unwrap_or_default(),
                );
            }
        }
        let modes: Vec<Value> = agents
            .as_array()
            .into_iter()
            .flatten()
            .filter(|agent| agent["hidden"] != true && agent["mode"] != "subagent")
            .filter_map(|agent| {
                agent["name"]
                    .as_str()
                    .map(|name| json!({"value":name,"name":name}))
            })
            .collect();
        let user = messages
            .iter()
            .rev()
            .find(|message| message["info"]["role"] == "user")
            .map(|message| &message["info"]);
        let saved_model = user
            .map(|info| &info["model"])
            .filter(|model| model.is_object())
            .unwrap_or(&session["model"]);
        let saved_key = saved_model["providerID"]
            .as_str()
            .zip(
                saved_model["modelID"]
                    .as_str()
                    .or_else(|| saved_model["id"].as_str()),
            )
            .map(|(provider, model)| format!("{provider}/{model}"));
        let model = saved_key
            .or_else(|| config["model"].as_str().map(str::to_string))
            .or_else(|| {
                providers["default"].as_object().and_then(|map| {
                    map.iter().find_map(|(provider, model)| {
                        model.as_str().map(|model| format!("{provider}/{model}"))
                    })
                })
            })
            .ok_or("OpenCode has no configured default model")?;
        let mode = user
            .and_then(|info| info["agent"].as_str())
            .or_else(|| session["agent"].as_str())
            .or_else(|| config["default_agent"].as_str())
            .or_else(|| modes.first().and_then(|mode| mode["value"].as_str()))
            .ok_or("OpenCode has no primary agent")?
            .to_string();
        let variant = user
            .and_then(|info| info["variant"].as_str())
            .or_else(|| saved_model["variant"].as_str())
            .map(str::to_string);
        let mut result = Self {
            models,
            modes,
            variants,
            model,
            mode,
            variant,
        };
        if !result
            .models
            .iter()
            .any(|item| item["value"] == result.model)
            || !result.modes.iter().any(|item| item["value"] == result.mode)
        {
            return Err("Saved OpenCode model or mode is unavailable; configuration was not silently replaced".into());
        }
        result.normalize_variant();
        Ok(result)
    }

    fn normalize_variant(&mut self) {
        let variants = self
            .variants
            .get(&self.model)
            .map(Vec::as_slice)
            .unwrap_or_default();
        if !self
            .variant
            .as_ref()
            .is_some_and(|value| variants.contains(value))
        {
            self.variant = variants
                .iter()
                .find(|value| value.as_str() == "default")
                .or_else(|| variants.first())
                .cloned();
        }
    }

    fn options(&self) -> Value {
        let mut options = vec![
            json!({"id":"model","name":"Model","category":"model","type":"select","currentValue":self.model,"options":self.models}),
            json!({"id":"mode","name":"Session Mode","category":"mode","type":"select","currentValue":self.mode,"options":self.modes}),
        ];
        if let Some(variant) = &self.variant {
            let variants = self.variants.get(&self.model).cloned().unwrap_or_default();
            options.push(json!({"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":variant,"options":variants.iter().map(|value| json!({"value":value,"name":value})).collect::<Vec<_>>()}));
        }
        json!(options)
    }

    fn set(&mut self, id: &str, value: &str) -> Result<(), String> {
        let options = self.options();
        let valid = options
            .as_array()
            .into_iter()
            .flatten()
            .find(|item| item["id"] == id)
            .is_some_and(|item| {
                item["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|option| option["value"] == value)
            });
        if !valid {
            return Err("OpenCode configuration value is not in the native catalog".into());
        }
        match id {
            "model" => {
                self.model = value.to_string();
                self.variant = None;
                self.normalize_variant();
            }
            "mode" => self.mode = value.to_string(),
            "effort" => self.variant = Some(value.to_string()),
            _ => return Err("Unsupported OpenCode configuration option".into()),
        }
        Ok(())
    }

    fn prompt_body(&self, parts: Value) -> Value {
        let (provider, model) = self
            .model
            .split_once('/')
            .expect("catalog model has a provider");
        let mut body = json!({"parts":parts,"model":{"providerID":provider,"modelID":model},"agent":self.mode});
        if let Some(variant) = &self.variant {
            body["variant"] = json!(variant);
        }
        body
    }
}

fn set_session_config(state: &Arc<Mutex<AdapterState>>, message: &Value) -> Result<Value, String> {
    let params = &message["params"];
    let session_id = params["sessionId"].as_str().ok_or("Missing sessionId")?;
    let mut guard = state.lock().map_err(|_| "Adapter state unavailable")?;
    if guard.active_sessions.contains(session_id) {
        return Err("Cannot change configuration during a prompt".into());
    }
    let config = guard
        .configs
        .get_mut(session_id)
        .ok_or("Session is not loaded")?;
    let (id, value) = match message["method"].as_str() {
        Some("session/set_mode") => ("mode", &params["modeId"]),
        Some("session/set_model") => ("model", &params["modelId"]),
        _ => (
            params["configId"].as_str().ok_or("Missing configId")?,
            &params["value"],
        ),
    };
    config.set(
        id,
        value
            .as_str()
            .ok_or("Configuration value must be a string")?,
    )?;
    Ok(config.options())
}

fn start_opencode_serve() -> Result<NativeServer, String> {
    let binary = std::env::var_os("FARFOLD_OPENCODE_BINARY")
        .map(PathBuf::from)
        .ok_or_else(|| "FARFOLD_OPENCODE_BINARY is required".to_string())?;
    let workspace = std::env::var_os("FARFOLD_OPENCODE_CWD")
        .map(PathBuf::from)
        .ok_or_else(|| "FARFOLD_OPENCODE_CWD is required".to_string())?;
    write_fixture_provider_config_if_requested()?;
    let mut child = Command::new(binary)
        .arg("serve")
        .arg("--pure")
        .arg("--hostname")
        .arg("127.0.0.1")
        .arg("--port")
        .arg("0")
        .current_dir(&workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to start OpenCode serve: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "OpenCode serve stdout is unavailable".to_string())?;
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(index) = line.find("http://127.0.0.1:") {
                let base = line[index..]
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_string();
                let _ = sender.send(base);
                break;
            }
        }
    });
    let base = match receiver.recv_timeout(Duration::from_secs(15)) {
        Ok(base) => base,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("OpenCode serve did not report its local endpoint".to_string());
        }
    };
    Ok(NativeServer {
        base,
        workspace,
        child,
    })
}

fn write_fixture_provider_config_if_requested() -> Result<(), String> {
    let Some(endpoint) = std::env::var_os("FARFOLD_OPENCODE_FIXTURE_PROVIDER_ENDPOINT") else {
        return Ok(());
    };
    let Some(config_dir) = std::env::var_os("OPENCODE_CONFIG_DIR") else {
        return Ok(());
    };
    let config_dir = PathBuf::from(config_dir);
    std::fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    let config = json!({
        "model": "farfold-spike/spike-model",
        "provider": {
            "farfold-spike": {
                "name": "Farfold Question Spike",
                "npm": "@ai-sdk/openai-compatible",
                "options": {
                    "baseURL": endpoint.to_string_lossy(),
                    "apiKey": "local-fixture-placeholder"
                },
                "models": {
                    "spike-model": {
                        "name": "spike-model",
                        "limit": {"context": 200000, "output": 16000}
                    },
                    "spike-model-two": {
                        "name": "spike-model-two",
                        "limit": {"context": 200000, "output": 16000},
                        "variants": {"low": {}, "high": {}}
                    }
                }
            }
        }
    });
    std::fs::write(
        config_dir.join("opencode.json"),
        serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn request_json(
    base: &str,
    method: &str,
    path: &str,
    directory: Option<&PathBuf>,
    body: Option<Value>,
) -> Result<Value, String> {
    request_json_timeout(
        base,
        method,
        path,
        directory,
        body,
        Some(Duration::from_secs(30)),
    )
}

fn request_json_timeout(
    base: &str,
    method: &str,
    path: &str,
    directory: Option<&PathBuf>,
    body: Option<Value>,
    timeout: Option<Duration>,
) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;
    let mut url = reqwest::Url::parse(base).map_err(|error| error.to_string())?;
    url.set_path(path);
    if let Some(directory) = directory {
        url.query_pairs_mut()
            .append_pair("directory", &directory.to_string_lossy());
    }
    let request = match method {
        "GET" => client.get(url),
        "POST" => client.post(url),
        _ => return Err("Unsupported OpenCode HTTP method".to_string()),
    };
    let request = if let Some(body) = body {
        request.json(&body)
    } else {
        request
    };
    let response = request.send().map_err(|error| error.to_string())?;
    let status = response.status();
    let text = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "OpenCode HTTP {method} {path} failed with {status}: {}",
            text.chars().take(500).collect::<String>()
        ));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn json_rpc_id_key(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::time::Instant;

    #[derive(Clone)]
    struct CaptureWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for CaptureWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.bytes.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn capture_peer() -> (Peer, Arc<Mutex<Vec<u8>>>) {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let writer = CaptureWriter {
            bytes: bytes.clone(),
        };
        (
            Peer {
                writer: Arc::new(Mutex::new(Box::new(writer))),
            },
            bytes,
        )
    }

    fn captured_json(bytes: &Arc<Mutex<Vec<u8>>>) -> Vec<Value> {
        let text = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
        text.lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect()
    }

    #[test]
    fn interaction_wait_cleans_up_on_response_and_server_loss() {
        let state = Arc::new(Mutex::new(AdapterState {
            opencode: None,
            pending_reverse: HashMap::new(),
            projections: HashMap::new(),
            configs: HashMap::new(),
            active_sessions: HashSet::new(),
            form_elicitation: true,
        }));
        let (peer, bytes) = capture_peer();
        let worker_state = state.clone();
        let worker = thread::spawn(move || {
            reverse_request(
                &peer,
                &worker_state,
                "elicitation-que_test",
                "elicitation/create",
                json!({"sessionId":"ses_test"}),
            )
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while captured_json(&bytes).is_empty() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        dispatch_reverse_response(
            &state,
            &json!({"id":"elicitation-que_test","result":{"action":"accept","content":{"choice":"yes"}}}),
        );
        assert_eq!(worker.join().unwrap().unwrap().unwrap()["action"], "accept");
        assert!(state.lock().unwrap().pending_reverse.is_empty());
        let (peer, _) = capture_peer();
        assert!(
            reverse_request(
                &peer,
                &state,
                "elicitation-que_lost",
                "elicitation/create",
                json!({"sessionId":"ses_test"})
            )
            .unwrap()
            .is_none()
        );
        assert!(state.lock().unwrap().pending_reverse.is_empty());
    }

    #[test]
    fn prompt_parts_preserves_all_text_blocks() {
        let message = json!({
            "params": {
                "prompt": [
                    {"type": "text", "text": "first"},
                    {"type": "text", "text": "second"}
                ]
            }
        });

        assert_eq!(
            prompt_parts(&message).unwrap(),
            json!([
                {"type": "text", "text": "first"},
                {"type": "text", "text": "second"}
            ])
        );
    }

    #[test]
    fn question_form_preserves_all_questions_multiple_and_custom_answers() {
        let question = json!({"id":"que_form","questions":[
            {"question":"First","options":[{"label":"A","description":"Alpha"},{"label":"B","description":"Beta"}]},
            {"question":"Second","multiple":true,"custom":false,"options":[{"label":"C"},{"label":"D"}]}
        ]});
        let schema = form_elicitation_params("ses_test", &question);
        assert_eq!(
            schema["requestedSchema"]["properties"]["choice"]["enum"],
            json!(["A", "B"])
        );
        assert_eq!(
            schema["requestedSchema"]["properties"]["choice_other"]["type"],
            "string"
        );
        assert_eq!(
            schema["requestedSchema"]["properties"]["choice1"]["type"],
            "array"
        );
        assert!(
            schema["requestedSchema"]["properties"]
                .get("choice1_other")
                .is_none()
        );
        assert_eq!(
            question_answers(&question, &json!({"choice":"A","choice1":["C","D"]})).unwrap(),
            vec![vec!["A"], vec!["C", "D"]]
        );
        assert_eq!(
            question_answers(&question, &json!({"choice_other":"Custom","choice1":["C"]})).unwrap(),
            vec![vec!["Custom"], vec!["C"]]
        );
        assert!(question_answers(&question, &json!({"choice":"A"})).is_err());
        assert!(question_answers(&question, &json!({"choice":"Missing","choice1":["C"]})).is_err());
        assert!(
            question_answers(
                &question,
                &json!({"choice":"A","choice1":["C"],"choice1_other":"Forbidden"})
            )
            .is_err()
        );
    }

    #[test]
    fn client_error_is_not_a_native_question_cancel() {
        let state = Arc::new(Mutex::new(AdapterState {
            opencode: None,
            pending_reverse: HashMap::new(),
            projections: HashMap::new(),
            configs: HashMap::new(),
            active_sessions: HashSet::new(),
            form_elicitation: true,
        }));
        let (sender, receiver) = mpsc::sync_channel(1);
        state
            .lock()
            .unwrap()
            .pending_reverse
            .insert("question-error".into(), sender);
        dispatch_reverse_response(
            &state,
            &json!({"id":"question-error","error":{"code":-32603,"message":"Client failed"}}),
        );
        assert!(
            receiver
                .recv()
                .unwrap()
                .unwrap_err()
                .contains("no native answer was submitted")
        );
        let error = respond_to_question(
            "http://127.0.0.1:1",
            &PathBuf::from("/tmp"),
            &json!({"id":"que_test"}),
            &Value::Null,
        )
        .unwrap_err();
        assert!(error.contains("missing its action"));
    }

    fn test_config() -> SessionConfig {
        SessionConfig::from_native(
            &json!({"providers":[{"id":"fixture","models":{
                "one":{"name":"One"}, "two":{"name":"Two","variants":{"low":{},"high":{}}}
            }}]}),
            &json!([{"name":"build","mode":"primary"},{"name":"plan","mode":"primary"},{"name":"hidden","hidden":true}]),
            &json!({"model":"fixture/one","default_agent":"build"}), &json!({}), &[],
        ).unwrap()
    }

    #[test]
    fn configuration_selection_changes_next_native_request_and_rejects_unknown_values() {
        let mut config = test_config();
        config.set("model", "fixture/two").unwrap();
        config.set("mode", "plan").unwrap();
        config.set("effort", "high").unwrap();
        assert_eq!(
            config.prompt_body(json!([])),
            json!({"parts":[],"model":{"providerID":"fixture","modelID":"two"},"agent":"plan","variant":"high"})
        );
        assert!(config.set("mode", "hidden").is_err());
        assert!(config.set("model", "fixture/missing").is_err());
        config.set("model", "fixture/one").unwrap();
        assert!(config.prompt_body(json!([])).get("variant").is_none());
    }

    #[test]
    fn delayed_prompt_with_old_history_waits_for_its_native_response() {
        crate::transport_security::ensure_rustls_crypto_provider();
        use std::{
            net::TcpListener,
            sync::atomic::{AtomicBool, Ordering},
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stopping = Arc::new(AtomicBool::new(false));
        let submitted = Arc::new(AtomicBool::new(false));
        let request_body = Arc::new(Mutex::new(Value::Null));
        let old = json!({"info":{"id":"msg_old","role":"assistant","sessionID":"ses_test","parentID":"msg_old_user","finish":"stop","time":{"completed":1}},"parts":[{"id":"prt_old","type":"text","text":"old answer"}]});
        let user = json!({"info":{"id":"msg_new_user","role":"user","sessionID":"ses_test"},"parts":[{"id":"prt_user","type":"text","text":"new prompt"}]});
        let answer = json!({"info":{"id":"msg_new_assistant","role":"assistant","sessionID":"ses_test","parentID":"msg_new_user","providerID":"fixture","modelID":"two","finish":"stop","time":{"completed":2}},"parts":[{"id":"prt_answer","type":"text","text":"new answer"}]});
        let stop = stopping.clone();
        let submitted_server = submitted.clone();
        let body_capture = request_body.clone();
        let server = thread::spawn(move || {
            let mut workers = Vec::new();
            while !stop.load(Ordering::SeqCst) {
                let Ok((stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                let submitted = submitted_server.clone();
                let body_capture = body_capture.clone();
                let old = old.clone();
                let user = user.clone();
                let answer = answer.clone();
                workers.push(thread::spawn(move || {
                    use std::io::Read;
                    let mut reader = BufReader::new(stream);
                    let mut first = String::new(); reader.read_line(&mut first).unwrap();
                    let mut length = 0;
                    loop {
                        let mut line = String::new(); reader.read_line(&mut line).unwrap();
                        if line == "\r\n" { break; }
                        if let Some(value) = line.to_lowercase().strip_prefix("content-length:") { length = value.trim().parse().unwrap(); }
                    }
                    let response = if first.starts_with("POST ") {
                        let mut bytes = vec![0; length]; reader.read_exact(&mut bytes).unwrap();
                        *body_capture.lock().unwrap() = serde_json::from_slice(&bytes).unwrap();
                        submitted.store(true, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(500));
                        answer
                    } else if first.contains("/message") {
                        if submitted.load(Ordering::SeqCst) { json!([old, user]) } else { json!([old]) }
                    } else if first.contains("/status") { json!({}) } else { json!([]) };
                    let body = response.to_string();
                    write!(reader.get_mut(), "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                }));
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        let mut config = test_config();
        config.set("model", "fixture/two").unwrap();
        config.set("mode", "plan").unwrap();
        config.set("effort", "high").unwrap();
        let mut child = Command::new("/usr/bin/true").spawn().unwrap();
        child.wait().unwrap();
        let state = Arc::new(Mutex::new(AdapterState {
            opencode: Some(NativeServer {
                base,
                workspace: PathBuf::from("/tmp"),
                child,
            }),
            pending_reverse: HashMap::new(),
            projections: HashMap::new(),
            configs: HashMap::from([("ses_test".into(), config)]),
            active_sessions: HashSet::new(),
            form_elicitation: true,
        }));
        let (peer, bytes) = capture_peer();
        let started = Instant::now();
        let result = handle_prompt_result(
            peer,
            state,
            &json!({"params":{"sessionId":"ses_test","prompt":[{"type":"text","text":"new prompt"}]}}),
        );
        stopping.store(true, Ordering::SeqCst);
        server.join().unwrap();
        let result = result.unwrap();
        assert_eq!(result["stopReason"], "end_turn");
        assert_eq!(
            result["_meta"]["farfoldNativeProviderRequest"]["runtimeModelId"],
            "fixture/two"
        );
        assert_eq!(
            result["_meta"]["farfoldNativeProviderRequest"]["userMessageId"],
            "msg_new_user"
        );
        assert!(started.elapsed() >= Duration::from_millis(500));
        let updates = captured_json(&bytes);
        let users: Vec<_> = updates
            .iter()
            .filter(|event| event["params"]["update"]["sessionUpdate"] == "user_message_chunk")
            .collect();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0]["params"]["update"]["messageId"], "msg_new_user");
        assert_eq!(request_body.lock().unwrap()["model"]["modelID"], "two");
        assert_eq!(request_body.lock().unwrap()["agent"], "plan");
        assert_eq!(request_body.lock().unwrap()["variant"], "high");
    }

    #[test]
    fn terminal_response_rejects_old_parent_and_preserves_native_failure() {
        let mut response = json!({"info":{"role":"assistant","sessionID":"ses_test","parentID":"msg_user","finish":"stop","time":{"completed":1}}});
        let messages = vec![json!({"info":{"role":"user","id":"msg_user"}})];
        assert!(
            prompt_stop_reason(
                &response,
                "ses_test",
                &HashSet::from(["msg_user".into()]),
                &messages
            )
            .is_err()
        );
        response["info"]["error"] = json!({"name":"APIError","data":{"message":"failed"}});
        assert!(
            prompt_stop_reason(&response, "ses_test", &HashSet::new(), &messages)
                .unwrap_err()
                .contains("failed")
        );
        response["info"]["error"]["name"] = json!("MessageAbortedError");
        assert_eq!(
            prompt_stop_reason(&response, "ses_test", &HashSet::new(), &messages).unwrap(),
            "cancelled"
        );
    }

    #[test]
    fn native_failure_receipt_is_completed_current_and_redacted() {
        let mut response = json!({"info":{"id":"msg_answer","role":"assistant","sessionID":"ses_test","parentID":"msg_user","providerID":"public","modelID":"test","time":{"completed":1},"error":{"name":"APIError","data":{"message":"secret-body","headers":{"Authorization":"secret-header"}}}},"parts":[]});
        let messages = vec![json!({"info":{"role":"user","id":"msg_user"}})];
        let failure = native_prompt_failure(&response, "ses_test", &HashSet::new(), &messages)
            .unwrap()
            .unwrap();
        assert_eq!(failure["farfoldNativeFailure"], "APIError");
        assert!(!failure.to_string().contains("secret"));
        assert!(
            native_prompt_failure(
                &response,
                "ses_test",
                &HashSet::from(["msg_user".into()]),
                &messages
            )
            .is_err()
        );
        response["parts"] = json!([{"type":"tool","state":{"status":"running"}}]);
        assert!(native_prompt_failure(&response, "ses_test", &HashSet::new(), &messages).is_err());
        response["parts"] = json!([]);
        response["info"]["time"] = json!({});
        assert!(native_prompt_failure(&response, "ses_test", &HashSet::new(), &messages).is_err());
        response["info"]["error"]["name"] = json!("UnknownError");
        assert!(
            native_prompt_failure(&response, "ses_test", &HashSet::new(), &messages)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn native_rejected_tool_prompt_is_terminal_but_unsettled_tools_are_not() {
        let mut response = json!({"info":{"role":"assistant","sessionID":"ses_test","parentID":"msg_user","finish":"tool-calls","time":{"completed":1}},"parts":[{"type":"tool","state":{"status":"error","error":"The user rejected permission to use this specific tool call."}}]});
        let messages = vec![json!({"info":{"role":"user","id":"msg_user"}})];
        assert_eq!(
            prompt_stop_reason(&response, "ses_test", &HashSet::new(), &messages).unwrap(),
            "end_turn"
        );
        response["parts"][0]["state"]["status"] = json!("running");
        assert!(prompt_stop_reason(&response, "ses_test", &HashSet::new(), &messages).is_err());
        response["parts"] = json!([]);
        assert!(prompt_stop_reason(&response, "ses_test", &HashSet::new(), &messages).is_err());
    }

    #[test]
    fn malformed_permission_reply_is_not_a_native_rejection() {
        for value in [
            Value::Null,
            json!({}),
            json!({"outcome":{"outcome":"selected","optionId":"missing"}}),
        ] {
            assert!(permission_response(&value).is_err());
        }
        assert_eq!(
            permission_response(&json!({"outcome":{"outcome":"selected","optionId":"reject"}}))
                .unwrap(),
            "reject"
        );
        assert_eq!(
            permission_response(&json!({"outcome":{"outcome":"cancelled"}})).unwrap(),
            "reject"
        );
    }

    #[test]
    fn recovery_identifies_unavailable_question_without_recreating_native_request() {
        let history = vec![json!({"parts":[
            {"id":"prt_old","callID":"call_old","type":"tool","tool":"question","state":{"status":"running"}},
            {"id":"prt_done","callID":"call_done","type":"tool","tool":"question","state":{"status":"completed"}},
            {"id":"prt_current","callID":"call_current","type":"tool","tool":"question","state":{"status":"running"}}
        ]})];
        let pending = json!({"tool":{"callID":"call_current"}});
        let unavailable = unavailable_question_tools(&history, Some(&pending));
        assert_eq!(unavailable.len(), 1);
        assert_eq!(unavailable[0]["nativePartId"], "prt_old");
        assert_eq!(unavailable_question_tools(&history, None).len(), 2);
    }

    #[test]
    fn tool_first_event_and_running_update_follow_acp_status_contract() {
        let (peer, bytes) = capture_peer();
        let mut projection = SessionProjection::default();
        let mut part =
            json!({"id":"prt_tool","type":"tool","tool":"bash","state":{"status":"pending"}});
        emit_tool_update(&peer, "ses_test", "msg_test", &part, &mut projection).unwrap();
        part["state"]["status"] = json!("running");
        emit_tool_update(&peer, "ses_test", "msg_test", &part, &mut projection).unwrap();
        part["state"]["status"] = json!("completed");
        emit_tool_update(&peer, "ses_test", "msg_test", &part, &mut projection).unwrap();
        let events = captured_json(&bytes);
        assert_eq!(events[0]["params"]["update"]["sessionUpdate"], "tool_call");
        assert_eq!(
            events[1]["params"]["update"]["sessionUpdate"],
            "tool_call_update"
        );
        assert_eq!(events[1]["params"]["update"]["status"], "in_progress");
        assert_eq!(events[2]["params"]["update"]["status"], "completed");
    }

    #[test]
    fn prompt_parts_rejects_non_text_blocks() {
        let message = json!({
            "params": {
                "prompt": [
                    {"type": "text", "text": "hello"},
                    {"type": "image", "url": "file:///tmp/image.png"}
                ]
            }
        });

        let error = prompt_parts(&message).unwrap_err();
        assert!(error.contains("does not yet support ACP prompt block type image"));
    }

    #[test]
    fn message_projection_emits_text_and_tool_updates_without_duplicates() {
        let (peer, bytes) = capture_peer();
        let mut projection = SessionProjection::default();
        let messages = vec![
            json!({
                "info": {"id": "msg_user", "role": "user"},
                "parts": [{"id": "part_user", "type": "text", "text": "hello"}]
            }),
            json!({
                "info": {"id": "msg_agent", "role": "assistant"},
                "parts": [
                    {"id": "part_text", "type": "text", "text": "answer"},
                    {"id": "part_tool", "type": "tool", "tool": "bash", "state": {
                        "status": "completed",
                        "title": "Run bash",
                        "input": {"cmd": "printf ok"},
                        "output": "ok"
                    }}
                ]
            }),
        ];

        assert!(emit_message_updates(&peer, "ses_test", &messages, &mut projection).unwrap());
        assert!(!emit_message_updates(&peer, "ses_test", &messages, &mut projection).unwrap());

        let updates = captured_json(&bytes);
        assert_eq!(updates.len(), 3);
        assert_eq!(updates[0]["method"], "session/update");
        assert_eq!(
            updates[0]["params"]["update"]["sessionUpdate"],
            "user_message_chunk"
        );
        assert_eq!(updates[0]["params"]["update"]["content"]["text"], "hello");
        assert_eq!(
            updates[1]["params"]["update"]["sessionUpdate"],
            "agent_message_chunk"
        );
        assert_eq!(updates[1]["params"]["update"]["content"]["text"], "answer");
        assert_eq!(updates[2]["params"]["update"]["sessionUpdate"], "tool_call");
        assert_eq!(updates[2]["params"]["update"]["toolCallId"], "part_tool");
        assert_eq!(updates[2]["params"]["update"]["status"], "completed");
        assert_eq!(
            updates[2]["params"]["update"]["content"][0]["content"]["text"],
            "ok"
        );
    }

    #[test]
    fn message_projection_emits_only_text_delta_when_part_grows() {
        let (peer, bytes) = capture_peer();
        let mut projection = SessionProjection::default();
        let first = vec![json!({
            "info": {"id": "msg_agent", "role": "assistant"},
            "parts": [{"id": "part_text", "type": "text", "text": "ans"}]
        })];
        let second = vec![json!({
            "info": {"id": "msg_agent", "role": "assistant"},
            "parts": [{"id": "part_text", "type": "text", "text": "answer"}]
        })];

        assert!(emit_message_updates(&peer, "ses_test", &first, &mut projection).unwrap());
        assert!(emit_message_updates(&peer, "ses_test", &second, &mut projection).unwrap());

        let updates = captured_json(&bytes);
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0]["params"]["update"]["content"]["text"], "ans");
        assert_eq!(updates[1]["params"]["update"]["content"]["text"], "wer");
    }
}
