//! Farfold-owned Codex App Server connection, native sessions and private
//! account control. Runtime notifications use the shared Host event channel.
use crate::{
    codex_installation::verified_command,
    codex_transport::{CodexTransport, DispatchError},
    host_ids::{AdapterId, ConnectionId, InstallationId, RuntimeProductId, derived_host_id},
    host_store::{
        HostStore, provider_projection::TurnProviderBindingAuthority,
        system_installation::SystemInstallation,
    },
    runtime_event_router::RuntimeEventRouter,
    runtime_registry::RuntimeBinding,
    runtime_supervisor::{RuntimeAdapter, RuntimeSupervisor, supervised_start, supervised_stop},
    turn_coordinator::{TurnAdmissionRequest, TurnCoordinator},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum CodexAccount {
    #[serde(rename = "apiKey")]
    ApiKey,
    #[serde(rename = "chatgpt", rename_all = "camelCase")]
    Chatgpt {
        email: Option<String>,
        plan_type: String,
    },
    #[serde(other)]
    Unsupported,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
    account: Option<CodexAccount>,
    requires_openai_auth: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginPhase {
    Waiting,
    Confirming,
    Failed,
    Canceled,
    Unknown,
}

struct PendingLogin {
    id: String,
    phase: LoginPhase,
}

struct Connection {
    generation: u64,
    binding: RuntimeBinding,
    transport: CodexTransport,
    state_directory: PathBuf,
    control: Mutex<AccountControl>,
    session: Mutex<Option<crate::codex_sessions::NativeSession>>,
    turn: Mutex<Option<crate::codex_turns::ActiveTurn>>,
    coordinator: TurnCoordinator,
    router: RuntimeEventRouter,
}

#[derive(Default)]
struct AccountControl {
    account: Option<AccountSnapshot>,
    login: Option<PendingLogin>,
    diagnostics: Vec<Value>,
    dropped_events: u64,
    account_revision: u64,
    // Bounded and reduced to non-secret fields. A completion can arrive before
    // the login/start response has supplied the pending login identity.
    login_completions: VecDeque<(String, Option<bool>)>,
}

#[derive(Default)]
pub struct CodexRuntime {
    next_generation: AtomicU64,
    // One control connection per private environment. Registration relocation,
    // connect, authentication changes and stop use this same operation gate.
    operation: Mutex<()>,
    connection: Mutex<Option<Arc<Connection>>>,
    shutdown_error: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConnectionStatus {
    generation: Option<u64>,
    pub(crate) installation_id: Option<InstallationId>,
    connection_id: Option<ConnectionId>,
    pub(crate) process_running: bool,
    initialized: bool,
    state_directory: Option<PathBuf>,
    account: Option<AccountSnapshot>,
    login_phase: Option<LoginPhase>,
    diagnostic_count: usize,
    diagnostic_methods: Vec<String>,
    dropped_events: u64,
    error: Option<String>,
}

fn private_directory(path: &Path) -> Result<(), String> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("无法创建 Codex 专属状态目录".into()),
    }
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(path)
        .map_err(|_| "Codex 状态目录不是普通目录或无法打开")?;
    let meta = directory
        .metadata()
        .map_err(|_| "无法检查 Codex 状态目录")?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
        return Err("Codex 专属目录不是当前用户所有的普通目录".into());
    }
    directory
        .set_permissions(fs::Permissions::from_mode(0o700))
        .map_err(|_| "无法保护 Codex 状态目录".into())
}

fn secure_auth_file(directory: &Path) -> Result<(), String> {
    let path = directory.join("auth.json");
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("无法检查 Codex 认证文件权限".into()),
    };
    let meta = file.metadata().map_err(|_| "无法检查 Codex 认证文件")?;
    if !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::geteuid() } {
        return Err("Codex 认证文件必须是当前用户所有的独立普通文件".into());
    }
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "无法保护 Codex 认证文件".into())
}

pub(crate) fn binding(entry: &SystemInstallation) -> Result<RuntimeBinding, String> {
    Ok(RuntimeBinding {
        product_id: RuntimeProductId::parse("codex").map_err(|e| e.to_string())?,
        installation_id: entry.installation_id.clone(),
        runtime_build_id: entry.runtime_build_id.clone(),
        adapter_id: AdapterId::parse("codex-app-server").map_err(|e| e.to_string())?,
        connection_id: ConnectionId::parse(derived_host_id(
            "connection",
            &[entry.installation_id.as_str(), "farfold-owned-stdio"],
        ))
        .map_err(|e| e.to_string())?,
    })
}

impl AccountControl {
    fn apply_login_completions(&mut self) {
        let Some(login) = &mut self.login else {
            return;
        };
        if !matches!(login.phase, LoginPhase::Waiting | LoginPhase::Confirming) {
            return;
        }
        if let Some(index) = self
            .login_completions
            .iter()
            .position(|(id, _)| *id == login.id)
        {
            let (_, success) = self
                .login_completions
                .remove(index)
                .expect("matched completion");
            login.phase = match success {
                Some(true) => LoginPhase::Confirming,
                Some(false) => LoginPhase::Failed,
                None => LoginPhase::Unknown,
            };
        }
    }
}

impl Connection {
    fn start_events(self: &Arc<Self>, router: RuntimeEventRouter) -> Result<(), String> {
        let connection = Arc::downgrade(self);
        self.transport
            .consume_events(move |events, dropped, failure| {
                let Some(c) = connection.upgrade() else {
                    return Ok(());
                };
                c.receive_events(&router, events, dropped, failure)
            })
    }

    fn receive_events(
        &self,
        router: &RuntimeEventRouter,
        events: Vec<Value>,
        dropped: u64,
        failure: Option<String>,
    ) -> Result<(), String> {
        if dropped > 0 || failure.is_some() {
            let mut turn = self.turn.lock().map_err(|_| "Codex 任务状态不可用")?;
            if let Some(turn) = turn.as_mut() {
                turn.unknown = true;
                self.coordinator.mark_submission_unknown(&turn.host_id)?;
                self.turn_state(turn, "unknown")?;
            }
        }
        if dropped > 0 {
            let mut state = self.control.lock().map_err(|_| "Codex 账号状态不可用")?;
            state.dropped_events = state.dropped_events.saturating_add(dropped);
            state.account = None;
            state.account_revision = state.account_revision.saturating_add(1);
            if let Some(login) = &mut state.login {
                login.phase = LoginPhase::Unknown;
            }
            drop(state);
            router.route(self.binding.clone(), json!({"generation":self.generation,"kind":"transport_gap","payload":{"dropped":dropped}}))?;
        }
        for event in events {
            let method = event["method"].as_str().unwrap_or("");
            if method.starts_with("account/") {
                let mut state = self.control.lock().map_err(|_| "Codex 账号状态不可用")?;
                match method {
                    "account/login/completed" => {
                        if let Some(id) = event["params"]["loginId"]
                            .as_str()
                            .filter(|id| !id.is_empty() && id.len() <= 128)
                        {
                            if state.login_completions.len() == 8 {
                                state.login_completions.pop_front();
                            }
                            state
                                .login_completions
                                .push_back((id.to_owned(), event["params"]["success"].as_bool()));
                            state.apply_login_completions();
                        }
                    }
                    "account/updated" => {
                        state.account = None;
                        state.account_revision = state.account_revision.saturating_add(1);
                    }
                    _ => {}
                }
                // Authentication, including unrecognized future account events,
                // never enters the public raw event ring or diagnostics.
                continue;
            }
            {
                let mut state = self.control.lock().map_err(|_| "Codex 账号状态不可用")?;
                if state.diagnostics.len() >= 16 {
                    state.diagnostics.remove(0);
                }
                // Keep only method names here; the shared ring owns raw native data.
                state.diagnostics.push(json!({"method":method}));
            }
            {
                let mut turn = self.turn.lock().map_err(|_| "Codex 任务状态不可用")?;
                if let Some(turn) = turn.as_mut() {
                    turn.observe(&event);
                }
                if event.get("id").is_some() && crate::codex_interactions::supported(method) {
                    if let Some(active) = turn.as_mut() {
                        if active.native_id.is_none()
                            && active.thread_id.as_str()
                                == event["params"]["threadId"].as_str().unwrap_or("")
                        {
                            if active.early_interactions.len() >= 32 {
                                return Err("Codex 早到交互超过限制".into());
                            }
                            active.early_interactions.push(event.clone());
                        } else {
                            self.publish_interaction(active, event.clone())?;
                        }
                    } else {
                        self.transport.invalidate_interactions(
                            event["params"]["threadId"].as_str().unwrap_or(""),
                            event["params"]["turnId"].as_str().unwrap_or(""),
                        )?;
                    }
                }
                self.settle_observed(&mut turn)?;
            }
            router.route(
                self.binding.clone(),
                json!({"generation":self.generation,"kind":"codex_rpc","payload":event}),
            )?;
        }
        if let Some(message) = failure {
            router.route(self.binding.clone(), json!({"generation":self.generation,"kind":"transport_error","payload":{"message":message}}))?;
        }
        Ok(())
    }

    fn reply_interaction(
        &self,
        target: &crate::host_store::session_open::SessionOpenTarget,
        generation: u64,
        interaction_id: &str,
        reply: crate::codex_interactions::CodexInteractionReply,
        registry: &crate::interaction_registry::InteractionRegistry,
    ) -> Result<(), String> {
        verify_turn_target(self, target, generation)?;
        let request = registry.codex_request(
            &self.binding,
            self.generation,
            interaction_id,
            target.native_session_id.as_str(),
        )?;
        let response = request.response(reply)?;
        let mut active = self.turn.lock().map_err(|_| "Codex 任务状态不可用")?;
        let turn = active
            .as_mut()
            .filter(|t| t.accepts_interaction(&request.thread_id, &request.turn_id))
            .ok_or("Codex 交互对应轮次已结束、停止或结果未知")?;
        registry.begin_response(
            self.binding.clone(),
            self.generation,
            &request.key,
            Some(&request.thread_id),
        )?;
        // stdin delivery has no response ack. Keep responding until the native
        // serverRequest/resolved (or terminal/connection invalidation) arrives.
        let result = self.transport.respond(
            &crate::codex_interactions::request_key(&request.native_request["id"])?,
            &request.thread_id,
            &request.turn_id,
            response,
        );
        if let Err(error) = result {
            turn.unknown = true;
            self.coordinator.mark_submission_unknown(&turn.host_id)?;
            self.turn_state(turn, "unknown")?;
            return Err(error.to_string());
        }
        self.router.route(self.binding.clone(), json!({"generation":self.generation,"kind":"codex_interaction_reply_sent","payload":{"interactionId":request.key}}))?;
        Ok(())
    }

    fn publish_interaction(
        &self,
        turn: &crate::codex_turns::ActiveTurn,
        event: Value,
    ) -> Result<(), String> {
        let request = crate::codex_interactions::CodexInteraction::parse(event.clone())?;
        if !turn.accepts_interaction(&request.thread_id, &request.turn_id) {
            self.transport
                .invalidate_interactions(&request.thread_id, &request.turn_id)?;
            return Ok(());
        }
        self.router.route(
            self.binding.clone(),
            json!({"generation":self.generation,"kind":"codex_interaction","payload":event}),
        )?;
        Ok(())
    }

    fn submit(
        &self,
        target: crate::host_store::session_open::SessionOpenTarget,
        generation: u64,
        text: String,
        mode: CodexMode,
    ) -> Result<CodexSubmission, String> {
        if text.trim().is_empty() || text.len() > 512 * 1024 {
            return Err("Codex 输入不能为空且最多 512 KiB".into());
        }
        verify_turn_target(self, &target, generation)?;
        self.coordinator
            .require_runtime_idle("codex", self.binding.installation_id.as_str())?;
        let collaboration_mode = {
            let session = self.session.lock().map_err(|_| "Codex 会话状态不可用")?;
            let session = session.as_ref().ok_or("请先打开 Codex 会话")?;
            json!({"mode":mode,"settings":{"model":session.model,"reasoning_effort":session.reasoning_effort,"developer_instructions":null}})
        };
        // The approved experimental exception is Plan-mode questions. Explicit
        // Default restores normal work after a Plan turn, preserving the model.
        if mode == CodexMode::Plan {
            let presets = self
                .transport
                .request("collaborationMode/list", json!({}))?;
            if !presets["data"]
                .as_array()
                .is_some_and(|modes| modes.iter().any(|p| p["mode"] == "plan"))
            {
                return Err("此 Codex 连接未提供原生 Plan 模式".into());
            }
        }
        let started_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "系统时间不可用")?
            .as_millis() as u64;
        let host = self
            .coordinator
            .admit(TurnAdmissionRequest {
                farfold_session_id: target.farfold_session_id,
                working_copy_id: target.working_copy_id,
                runtime_product_id: target.runtime_product_id,
                installation_id: target.installation_id,
                runtime_connection_id: target.connection_id,
                native_session_id: target.native_session_id.clone(),
                runtime_generation: self.generation,
                started_at,
                provider_connection_id: None,
                provider_config_version_id: None,
                runtime_provider_id: None,
                runtime_model_id: None,
                provider_binding_authority: TurnProviderBindingAuthority::CurrentAppliedProjection,
            })
            .map_err(|e| e.to_string())?;
        *self.turn.lock().map_err(|_| "Codex 任务状态不可用")? =
            Some(crate::codex_turns::ActiveTurn::new(
                host.id().clone(),
                target.native_session_id.clone(),
            ));
        {
            let active = self.turn.lock().map_err(|_| "Codex 任务状态不可用")?;
            if let Some(turn) = active.as_ref() {
                self.turn_state(turn, "submitting")?;
            }
        }
        let result = self.transport.dispatch("turn/start", json!({"threadId":target.native_session_id,"input":[{"type":"text","text":text,"text_elements":[]}],"clientUserMessageId":host.id(),"collaborationMode":collaboration_mode}));
        let mut active = self.turn.lock().map_err(|_| "Codex 任务状态不可用")?;
        let Some(turn) = active.as_mut().filter(|t| &t.host_id == host.id()) else {
            return Ok(CodexSubmission::Unknown {
                detail: "Codex 连接或任务在发送期间停止；请核对原生历史，输入未自动重发".into(),
            });
        };
        match result {
            Err(error @ (DispatchError::NotSent(_) | DispatchError::Rejected { .. })) => {
                self.coordinator.cancel_submission(host.id())?;
                self.turn_state(turn, "rejected")?;
                *active = None;
                Err(error.to_string())
            }
            Err(error @ DispatchError::Unknown(_)) => {
                turn.unknown = true;
                self.coordinator.mark_submission_unknown(host.id())?;
                self.turn_state(turn, "unknown")?;
                Ok(CodexSubmission::Unknown {
                    detail: error.to_string(),
                })
            }
            Ok(response) => {
                if let Err(detail) = turn.bind(&response) {
                    turn.unknown = true;
                    self.coordinator.mark_submission_unknown(host.id())?;
                    self.turn_state(turn, "unknown")?;
                    return Ok(CodexSubmission::Unknown { detail });
                }
                let native_turn_id = turn.native_id.clone().expect("validated native response");
                self.coordinator
                    .observe_codex_turn(&turn.host_id, self.generation)?;
                self.turn_state(turn, "executing")?;
                for event in std::mem::take(&mut turn.early_interactions) {
                    self.publish_interaction(turn, event)?;
                }
                self.settle_observed(&mut active)?;
                Ok(CodexSubmission::Accepted {
                    host_turn_id: host.id().clone(),
                    native_turn_id,
                })
            }
        }
    }

    fn turn_state(&self, turn: &crate::codex_turns::ActiveTurn, phase: &str) -> Result<(), String> {
        self.router.route(self.binding.clone(), json!({"generation":self.generation,"kind":"codex_turn_state","payload":{
            "nativeSessionId":turn.thread_id,"nativeTurnId":turn.native_id,"hostTurnId":turn.host_id,"phase":phase
        }}))?;
        Ok(())
    }

    fn settle_observed(
        &self,
        active: &mut Option<crate::codex_turns::ActiveTurn>,
    ) -> Result<(), String> {
        let Some(turn) = active.as_ref() else {
            return Ok(());
        };
        if let Some(reason) = turn.settled_reason() {
            self.coordinator
                .settle_codex_turn(&turn.host_id, self.generation, reason)?;
            self.turn_state(turn, reason)?;
            *active = None;
        } else if turn.outcome_unknown() {
            self.coordinator.mark_submission_unknown(&turn.host_id)?;
            self.turn_state(turn, "unknown")?;
        }
        Ok(())
    }

    fn refresh(&self) -> Result<(), String> {
        let mut state = self.control.lock().map_err(|_| "Codex 账号状态不可用")?;
        state.apply_login_completions();
        state.account = None;
        let revision = state.account_revision;
        drop(state);
        let response = self
            .transport
            .request("account/read", json!({"refreshToken":false}));
        let account: AccountSnapshot =
            serde_json::from_value(response?).map_err(|_| "Codex 账号响应与固定协议不符")?;
        secure_auth_file(&self.state_directory)?;
        let mut state = self.control.lock().map_err(|_| "Codex 账号状态不可用")?;
        state.apply_login_completions();
        if state.account_revision != revision {
            return Ok(());
        }
        if account.account.is_some()
            && state
                .login
                .as_ref()
                .is_some_and(|l| l.phase == LoginPhase::Confirming)
        {
            state.login = None;
        }
        state.account = Some(account);
        Ok(())
    }
}

impl CodexRuntime {
    pub(crate) fn session_connection(&self, expected: &RuntimeBinding) -> Result<u64, String> {
        let c = self.current()?.ok_or("请先连接此会话登记的 Codex 程序")?;
        if c.binding != *expected || c.transport.failure().is_some() || !c.transport.is_running()? {
            return Err("Codex 会话所需连接未就绪或身份不匹配".into());
        }
        Ok(c.generation)
    }

    pub(crate) fn open_native_session(
        &self,
        expected: &RuntimeBinding,
        cwd: &Path,
        native_id: Option<&crate::host_ids::NativeSessionId>,
        selection: Option<(&str, &str)>,
    ) -> Result<(u64, crate::codex_sessions::NativeSession), String> {
        let _operation = self.operation()?;
        let generation = self.session_connection(expected)?;
        let c = self.current()?.ok_or("Codex 连接已退出")?;
        // Clear the previous active projection before asking the native runtime
        // to switch; a failed resume cannot leave another thread sendable.
        *c.session.lock().map_err(|_| "Codex 会话状态不可用")? = None;
        let mut params = json!({"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"workspace-write"});
        let expected_model = if let Some((id, effort)) = selection {
            let models = crate::codex_models::read_catalog(|cursor| {
                c.transport.request(
                    "model/list",
                    json!({"cursor":cursor,"limit":50,"includeHidden":false}),
                )
            })?;
            let model = models
                .into_iter()
                .find(|m| m.id == id && !m.hidden)
                .ok_or("所选 Codex 模型不在当前原生目录中；不会自动替换")?;
            if !model
                .supported_reasoning_efforts
                .iter()
                .any(|o| o.reasoning_effort == effort)
            {
                return Err("所选推理选项不在当前模型目录中".into());
            }
            params["model"] = json!(model.model);
            params["config"] = json!({"model_reasoning_effort":effort});
            Some((model.model, effort.to_owned()))
        } else {
            None
        };
        let method = if let Some(id) = native_id {
            // Read before resume, so a cwd override cannot mask a mismatched
            // stored thread. Never pass model/config overrides on resume.
            let stored = c
                .transport
                .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                .map_err(|error| {
                    format!(
                        "无法读取绑定的 Codex 原生线程。会话与草稿保留，未创建替代线程。{error}"
                    )
                })?;
            let thread: crate::codex_sessions::NativeThread =
                serde_json::from_value(stored["thread"].clone())
                    .map_err(|_| "Codex 未返回可核对的原生线程")?;
            thread.verify(cwd, Some(id))?;
            if selection.is_some() {
                return Err("续接不能改写原生模型选择".into());
            }
            params["threadId"] = json!(id);
            "thread/resume"
        } else {
            if selection.is_none() {
                return Err("新建 Codex 会话必须明确选择模型和推理选项".into());
            }
            params["cwd"] = json!(cwd);
            params["ephemeral"] = json!(false);
            "thread/start"
        };
        let session = crate::codex_sessions::read_session(
            c.transport.request(method, params)?,
            cwd,
            native_id,
        )?;
        if expected_model.is_some_and(|(model, effort)| {
            session.model != model || session.reasoning_effort.as_deref() != Some(effort.as_str())
        }) {
            return Err("Codex 返回的模型或推理选项与选择不符；不会自动接受替代配置".into());
        }
        if c.transport.failure().is_some() || self.session_connection(expected)? != generation {
            return Err("Codex 连接已变化，原生会话结果未知".into());
        }
        *c.session.lock().map_err(|_| "Codex 会话状态不可用")? = Some(session.clone());
        c.router.route(
            c.binding.clone(),
            json!({
                "generation": generation, "kind": "codex_session_opened",
                "payload": {"nativeSessionId": session.thread.id}
            }),
        )?;
        Ok((generation, session))
    }

    fn current(&self) -> Result<Option<Arc<Connection>>, String> {
        self.connection
            .lock()
            .map(|current| current.clone())
            .map_err(|_| "Codex 连接状态不可用".into())
    }

    pub(crate) fn operation(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.operation
            .try_lock()
            .map_err(|_| "Codex 正在处理另一项连接操作，请稍后重试".into())
    }

    pub(crate) fn require_installation_stopped(&self, id: &InstallationId) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "Codex 连接状态不可用")?;
        if connection
            .as_ref()
            .is_some_and(|c| &c.binding.installation_id == id)
        {
            return Err("请先停止此 Codex 连接，再继续操作".into());
        }
        Ok(())
    }

    pub(crate) fn is_stopped(&self) -> Result<bool, String> {
        Ok(self
            .connection
            .lock()
            .map_err(|_| "Codex 连接状态不可用")?
            .is_none())
    }

    pub(crate) fn with_stopped<T>(
        &self,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _operation = self.operation()?;
        if !self.is_stopped()? {
            return Err("请先停止 Codex 连接，再进行数据恢复".into());
        }
        action()
    }

    fn running(&self) -> Result<bool, String> {
        self.connection
            .lock()
            .map_err(|_| "Codex 连接状态不可用")?
            .as_ref()
            .map_or(Ok(false), |c| c.transport.is_running())
    }

    pub(crate) fn status(&self) -> Result<CodexConnectionStatus, String> {
        let connection = self.current()?;
        let c = connection.as_ref();
        let control = c
            .map(|c| c.control.lock().map_err(|_| "Codex 账号状态不可用"))
            .transpose()?;
        let state = control.as_deref();
        let running = c.map_or(Ok(false), |c| c.transport.is_running())?;
        let error = c
            .and_then(|c| c.transport.failure())
            .or_else(|| self.shutdown_error.lock().ok().and_then(|e| e.clone()));
        let initialized = running && error.is_none();
        Ok(CodexConnectionStatus {
            generation: c.map(|c| c.generation),
            installation_id: c.map(|c| c.binding.installation_id.clone()),
            connection_id: c.map(|c| c.binding.connection_id.clone()),
            state_directory: c.map(|c| c.state_directory.clone()),
            process_running: running,
            initialized,
            account: state
                .filter(|_| initialized)
                .and_then(|s| s.account.clone()),
            login_phase: state.and_then(|s| {
                s.login.as_ref().map(|l| {
                    if initialized {
                        l.phase
                    } else {
                        LoginPhase::Unknown
                    }
                })
            }),
            diagnostic_count: state.map_or(0, |s| s.diagnostics.len()),
            diagnostic_methods: state.map_or_else(Vec::new, |s| {
                s.diagnostics
                    .iter()
                    .filter_map(|event| {
                        event["method"]
                            .as_str()
                            .map(|name| name.chars().take(160).collect())
                    })
                    .collect()
            }),
            dropped_events: state.map_or(0, |s| s.dropped_events),
            error,
        })
    }

    fn connect(
        &self,
        app: &AppHandle,
        entry: SystemInstallation,
    ) -> Result<CodexConnectionStatus, String> {
        let current = self.current()?;
        if current.is_some() {
            return Err("请先停止现有 Codex 连接；不会自动切换安装".into());
        }
        let base = app
            .path()
            .app_data_dir()
            .map_err(|_| "无法定位应用专属目录")?;
        let directory = base.join("codex");
        let control = base.join("codex-control");
        private_directory(&directory)?;
        private_directory(&control)?;
        secure_auth_file(&directory)?;
        let directory = directory
            .canonicalize()
            .map_err(|_| "无法核对 Codex 状态目录")?;
        let mut command = crate::performance_trace::measure(
            app,
            crate::performance_trace::Operation::CodexInstallation,
            || verified_command(&entry.inspection),
        )?;
        command
            .arg("app-server")
            .arg("--listen")
            .arg("stdio://")
            .args([
                "-c",
                "cli_auth_credentials_store=\"file\"",
                "-c",
                "approval_policy=\"on-request\"",
                "-c",
                "sandbox_mode=\"workspace-write\"",
                "-c",
                "features.default_mode_request_user_input=false",
            ])
            .env_clear()
            .env(
                "HOME",
                app.path().home_dir().map_err(|_| "无法定位用户目录")?,
            )
            .env("CODEX_HOME", &directory)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .current_dir(&control);
        // Preserve explicit network routing, not ambient Provider keys, login
        // issuer overrides, CODEX_HOME, model overrides, or shell startup state.
        for name in [
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "https_proxy",
            "http_proxy",
            "all_proxy",
            "no_proxy",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let transport = CodexTransport::spawn(&mut command)?;
        let initialized = crate::performance_trace::measure(
            app,
            crate::performance_trace::Operation::CodexInitialize,
            || {
                transport.request("initialize",json!({
            "clientInfo":{"name":"farfold","title":"Farfold","version":env!("CARGO_PKG_VERSION")},
            "capabilities":{"experimentalApi":true}
        }))
            },
        )?;
        if initialized["codexHome"].as_str() != directory.to_str()
            || initialized["platformOs"] != "macos"
            || initialized["platformFamily"] != "unix"
            || !initialized["userAgent"].is_string()
        {
            return Err("Codex 初始化身份或专属目录不匹配，连接已关闭".into());
        }
        transport.notify("initialized", json!({}))?;
        let connection = Arc::new(Connection {
            generation: self.next_generation.fetch_add(1, Ordering::Relaxed) + 1,
            binding: binding(&entry)?,
            transport,
            state_directory: directory,
            control: Mutex::new(AccountControl::default()),
            session: Mutex::new(None),
            turn: Mutex::new(None),
            coordinator: app.state::<TurnCoordinator>().inner().clone(),
            router: app.state::<RuntimeEventRouter>().inner().clone(),
        });
        connection.router.route(
            connection.binding.clone(),
            json!({
                "generation": connection.generation, "kind": "lifecycle",
                "payload": {"state": "initialized"}
            }),
        )?;
        connection.start_events(app.state::<RuntimeEventRouter>().inner().clone())?;
        // Connection readiness and account-read success are separate states.
        let refresh_error = crate::performance_trace::measure(
            app,
            crate::performance_trace::Operation::CodexAccountRead,
            || connection.refresh(),
        )
        .err();
        *self.connection.lock().map_err(|_| "Codex 连接状态不可用")? = Some(connection);
        *self
            .shutdown_error
            .lock()
            .map_err(|_| "Codex 退出状态不可用")? = None;
        let mut status = self.status()?;
        if let Some(error) = refresh_error {
            status.error = Some(error);
        }
        Ok(status)
    }

    pub(crate) fn stop(&self) -> Result<(), String> {
        let connection = self.current()?;
        let result = connection.as_ref().map_or(Ok(()), |c| c.transport.stop());
        if let Some(c) = &connection {
            let mut active = c.turn.lock().map_err(|_| "Codex 任务状态不可用")?;
            if let Some(turn) = active.as_ref() {
                if result.is_ok() {
                    c.coordinator.settle_codex_turn(
                        &turn.host_id,
                        c.generation,
                        "owned_runtime_stopped",
                    )?;
                    c.turn_state(turn, "interrupted")?;
                    *active = None;
                } else {
                    c.coordinator.mark_submission_unknown(&turn.host_id)?;
                    c.turn_state(turn, "unknown")?;
                }
            }
            c.router.route(
                c.binding.clone(),
                json!({
                    "generation": c.generation, "kind": "lifecycle",
                    "payload": {"state": if result.is_ok() { "terminated" } else { "error" }}
                }),
            )?;
        }
        // Maintenance and status observers must still see the owned connection
        // throughout EOF shutdown, until process exit has actually been checked.
        let mut current = self.connection.lock().map_err(|_| "Codex 连接状态不可用")?;
        if current
            .as_ref()
            .zip(connection.as_ref())
            .is_some_and(|(active, stopped)| Arc::ptr_eq(active, stopped))
        {
            current.take();
        }
        *self
            .shutdown_error
            .lock()
            .map_err(|_| "Codex 退出状态不可用")? = result.as_ref().err().cloned();
        result
    }
}

struct CodexAdapter<'a> {
    runtime: &'a CodexRuntime,
    binding: RuntimeBinding,
}
impl RuntimeAdapter for CodexAdapter<'_> {
    type StartOptions = SystemInstallation;
    type Status = CodexConnectionStatus;
    fn definition(&self) -> RuntimeBinding {
        self.binding.clone()
    }
    fn is_running(&self) -> Result<bool, String> {
        self.runtime.running()
    }
    fn start(&self, app: &AppHandle, options: Self::StartOptions) -> Result<Self::Status, String> {
        self.runtime.connect(app, options)
    }
    fn stop(&self, _: &AppHandle) -> Result<Self::Status, String> {
        self.runtime.stop()?;
        self.runtime.status()
    }
    fn status(&self, _: &AppHandle) -> Result<Self::Status, String> {
        self.runtime.status()
    }
    fn status_is_running(status: &Self::Status) -> bool {
        status.process_running
    }
}

pub(crate) fn start_registered_connection(
    app: &AppHandle,
    installation_id: InstallationId,
) -> Result<CodexConnectionStatus, String> {
    let profile = app.path().app_data_dir().map_err(|_| "无法定位应用目录")?;
    if crate::host_store::portable_import_activation::has_pending_storage_activation(&profile) {
        return Err("已有待激活的数据恢复，请重启完成恢复后再连接 Codex".into());
    }
    let runtime = app.state::<CodexRuntime>();
    let _operation = runtime.operation()?;
    // Guard before supervised_start's idempotent running path: another
    // installation can never return the first connection as its own.
    if let Some(c) = runtime
        .connection
        .lock()
        .map_err(|_| "Codex 连接状态不可用")?
        .as_ref()
        && c.binding.installation_id != installation_id
    {
        return Err("请先停止现有 Codex 连接，再选择另一安装".into());
    }
    let entry = app
        .state::<HostStore>()
        .system_installations()?
        .into_iter()
        .find(|i| i.installation_id == installation_id)
        .ok_or("找不到已登记的 Codex 程序")?;
    let adapter = CodexAdapter {
        runtime: &runtime,
        binding: binding(&entry)?,
    };
    supervised_start(app, &app.state::<RuntimeSupervisor>(), &adapter, entry)
}

#[tauri::command]
pub async fn codex_connection_start(
    app: AppHandle,
    installation_id: InstallationId,
) -> Result<CodexConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::session_controller::HostSessionController>()
            .exclusive(|| start_registered_connection(&app, installation_id))
    })
    .await
    .map_err(|_| "Codex 连接操作被中断".to_string())?
}

#[tauri::command]
pub async fn codex_connection_stop(
    app: AppHandle,
    installation_id: InstallationId,
    generation: u64,
) -> Result<CodexConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<CodexRuntime>();
        let Some(connection) = runtime.current()? else {
            return runtime.status();
        };
        if connection.binding.installation_id != installation_id
            || connection.generation != generation
        {
            return Err("停止请求属于已失效的 Codex 连接".into());
        }
        // Closing our input also resolves pending control waiters. Do this
        // before waiting for the mutation gate, so Stop does not wait 15s for
        // a stalled account request. Retain the connection until process exit.
        connection.transport.begin_stop()?;
        let _operation = runtime
            .operation
            .lock()
            .map_err(|_| "Codex 操作状态不可用")?;
        if !runtime
            .current()?
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &connection))
        {
            return Err("停止请求属于已失效的 Codex 连接".into());
        }
        supervised_stop(
            &app,
            &app.state::<RuntimeSupervisor>(),
            &CodexAdapter {
                runtime: &runtime,
                binding: connection.binding.clone(),
            },
        )
    })
    .await
    .map_err(|_| "停止 Codex 操作被中断".to_string())?
}

#[tauri::command]
pub async fn codex_connection_status(
    app: AppHandle,
    refresh_account: bool,
) -> Result<CodexConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<CodexRuntime>();
        if refresh_account {
            let _operation = runtime.operation()?;
            if let Some(c) = runtime.current()? {
                c.refresh()?;
            }
        }
        runtime.status()
    })
    .await
    .map_err(|_| "读取 Codex 状态被中断".to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelCatalog {
    installation_id: InstallationId,
    generation: u64,
    models: Vec<crate::codex_models::CodexModel>,
}

#[tauri::command]
pub async fn codex_model_catalog(
    app: AppHandle,
    installation_id: InstallationId,
    generation: u64,
) -> Result<CodexModelCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<CodexRuntime>();
        let _operation = runtime.operation()?;
        let c = runtime.current()?.ok_or("请先连接 Codex")?;
        if c.binding.installation_id != installation_id || c.generation != generation {
            return Err("模型目录请求属于已失效的 Codex 连接".into());
        }
        let models = crate::codex_models::read_catalog(|cursor| {
            c.transport.request(
                "model/list",
                json!({"cursor":cursor,"limit":50,"includeHidden":false}),
            )
        })?;
        if c.transport.failure().is_some()
            || !runtime
                .current()?
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &c))
        {
            return Err("Codex 连接已变化，模型目录结果失效".into());
        }
        Ok(CodexModelCatalog {
            installation_id,
            generation,
            models,
        })
    })
    .await
    .map_err(|_| "模型目录读取被中断".to_string())?
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AccountAction {
    BrowserLogin,
    ApiKey { key: String },
    CancelLogin,
    Logout,
}

fn validated_auth_url(value: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Codex 登录地址无效")?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("auth.openai.com" | "chatgpt.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("Codex 未返回支持的官方登录地址".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn codex_account_action(
    app: AppHandle,
    installation_id: InstallationId,
    action: AccountAction,
    generation: u64,
) -> Result<CodexConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<CodexRuntime>();
        let _operation = runtime.operation()?;
        let c = runtime.current()?.ok_or("请先连接 Codex")?;
        if c.binding.installation_id != installation_id || c.generation != generation {
            return Err("账号操作与当前 Codex 安装不匹配".into());
        }
        if !c.transport.is_running()? || c.transport.failure().is_some() {
            return Err("Codex 连接已失效，请重新连接".into());
        }
        c.coordinator
            .require_runtime_idle("codex", c.binding.installation_id.as_str())?;
        let mut state = c.control.lock().map_err(|_| "Codex 账号状态不可用")?;
        match action {
            AccountAction::BrowserLogin => {
                if state.login.as_ref().is_some_and(|l| {
                    matches!(
                        l.phase,
                        LoginPhase::Waiting | LoginPhase::Confirming | LoginPhase::Unknown
                    )
                }) {
                    return Err("已有待处理登录，请先取消或停止连接".into());
                }
                state.login_completions.clear();
                state.login = Some(PendingLogin {
                    id: String::new(),
                    phase: LoginPhase::Unknown,
                });
                state.account = None;
                drop(state);
                let reply = c
                    .transport
                    .request("account/login/start", json!({"type":"chatgpt"}))?;
                let id = reply["loginId"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 128)
                    .ok_or("Codex 登录响应缺少身份")?
                    .to_owned();
                c.control.lock().map_err(|_| "Codex 账号状态不可用")?.login = Some(PendingLogin {
                    id,
                    phase: LoginPhase::Waiting,
                });
                let url = reply["authUrl"].as_str().ok_or("Codex 登录响应缺少地址")?;
                if reply["type"] != "chatgpt" {
                    return Err("Codex 返回了其他登录方式".into());
                }
                validated_auth_url(url)?;
                app.opener()
                    .open_url(url, None::<String>)
                    .map_err(|_| "无法打开浏览器；可取消后重新发起登录")?;
            }
            AccountAction::ApiKey { key } => {
                if key.trim().is_empty() || key.len() > 8192 || key.chars().any(char::is_control) {
                    return Err("API key 格式无效".into());
                }
                if state.login.as_ref().is_some_and(|l| {
                    matches!(
                        l.phase,
                        LoginPhase::Waiting | LoginPhase::Confirming | LoginPhase::Unknown
                    )
                }) {
                    return Err("请先取消正在进行的浏览器登录".into());
                }
                state.account = None;
                state.login = Some(PendingLogin {
                    id: String::new(),
                    phase: LoginPhase::Unknown,
                });
                drop(state);
                let reply = c
                    .transport
                    .request("account/login/start", json!({"type":"apiKey","apiKey":key}))?;
                if reply["type"] != "apiKey" {
                    return Err("Codex 未确认 API key 配置".into());
                }
                c.control.lock().map_err(|_| "Codex 账号状态不可用")?.login = None;
                c.refresh()?;
            }
            AccountAction::CancelLogin => {
                let login = state.login.as_mut().ok_or("没有待取消的登录")?;
                if login.id.is_empty() {
                    return Err("登录请求结果未知；请停止此连接后再重新发起".into());
                }
                login.phase = LoginPhase::Unknown;
                let login_id = login.id.clone();
                drop(state);
                let reply = c
                    .transport
                    .request("account/login/cancel", json!({"loginId":login_id}))?;
                if let Some(login) =
                    &mut c.control.lock().map_err(|_| "Codex 账号状态不可用")?.login
                {
                    login.phase = match reply["status"].as_str() {
                        Some("canceled") => LoginPhase::Canceled,
                        _ => LoginPhase::Unknown,
                    };
                }
                c.refresh()?;
            }
            AccountAction::Logout => {
                // Native logout invalidates the pending login and its later replies.
                state.account = None;
                drop(state);
                c.transport.request("account/logout", json!({}))?;
                c.control.lock().map_err(|_| "Codex 账号状态不可用")?.login = None;
                c.refresh()?;
            }
        }
        secure_auth_file(&c.state_directory)?;
        if !runtime
            .current()?
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &c))
        {
            return Err("Codex 连接已变化，请重新核对账号状态".into());
        }
        runtime.status()
    })
    .await
    .map_err(|_| "Codex 账号操作被中断".to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexTurnInput {
    farfold_session_id: crate::host_ids::FarfoldSessionId,
    native_session_id: crate::host_ids::NativeSessionId,
    generation: u64,
    text: String,
    mode: CodexMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexMode {
    Default,
    Plan,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexInterruptInput {
    farfold_session_id: crate::host_ids::FarfoldSessionId,
    native_session_id: crate::host_ids::NativeSessionId,
    generation: u64,
    expected_turn_id: crate::host_ids::NativeTurnId,
}

#[derive(Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CodexSubmission {
    Accepted {
        host_turn_id: crate::host_ids::HostTurnId,
        native_turn_id: crate::host_ids::NativeTurnId,
    },
    Unknown {
        detail: String,
    },
}

fn verify_turn_target(
    c: &Connection,
    target: &crate::host_store::session_open::SessionOpenTarget,
    generation: u64,
) -> Result<(), String> {
    crate::session_controller::require_openable(target)?;
    if target.codex_binding().as_ref() != Some(&c.binding)
        || c.generation != generation
        || c.transport.failure().is_some()
        || !c.transport.is_running()?
    {
        return Err("Codex 任务与当前连接、构建或代际不匹配".into());
    }
    let session = c.session.lock().map_err(|_| "Codex 会话状态不可用")?;
    if !session.as_ref().is_some_and(|s| {
        s.thread.id == target.native_session_id && s.cwd == target.working_copy_path
    }) {
        return Err("请先打开并核对这条 Codex 原生会话".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn host_codex_turn_submit(
    app: AppHandle,
    input: CodexTurnInput,
) -> Result<CodexSubmission, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::session_controller::HostSessionController>()
            .exclusive(|| {
                let target = app
                    .state::<HostStore>()
                    .session_open_target(&input.farfold_session_id)?;
                if target.native_session_id != input.native_session_id {
                    return Err("Host 与 Codex 原生会话身份不匹配".into());
                }
                let runtime = app.state::<CodexRuntime>();
                let _operation = runtime.operation()?;
                let c = runtime.current()?.ok_or("请先连接 Codex")?;
                c.submit(target, input.generation, input.text, input.mode)
            })
    })
    .await
    .map_err(|_| "Codex 发送操作被中断；结果需核对".to_string())?
}

#[tauri::command]
pub async fn host_codex_turn_interrupt(
    app: AppHandle,
    input: CodexInterruptInput,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = app
            .state::<HostStore>()
            .session_open_target(&input.farfold_session_id)?;
        if target.native_session_id != input.native_session_id {
            return Err("Host 与 Codex 原生会话身份不匹配".into());
        }
        let runtime = app.state::<CodexRuntime>();
        let c = runtime
            .current()?
            .ok_or("Codex 连接已退出，任务结果需核对")?;
        verify_turn_target(&c, &target, input.generation)?;
        {
            let mut active = c.turn.lock().map_err(|_| "Codex 任务状态不可用")?;
            if !active.as_ref().is_some_and(|t| {
                t.thread_id == input.native_session_id
                    && t.native_id.as_ref() == Some(&input.expected_turn_id)
            }) {
                return Err("停止请求对应的 Codex 原生轮次不再活动或尚未确认".into());
            }
            c.coordinator.request_abort(&input.farfold_session_id)?;
            if let Some(turn) = active.as_mut() {
                turn.stopping = true;
                c.transport.invalidate_interactions(input.native_session_id.as_str(), input.expected_turn_id.as_str())?;
                c.router.route(c.binding.clone(), json!({"generation":c.generation,"kind":"codex_interactions_invalidated","payload":{}}))?;
                c.turn_state(turn, "stopping")?;
            }
        }
        let response = c.transport.dispatch(
            "turn/interrupt",
            json!({"threadId":input.native_session_id,"turnId":input.expected_turn_id}),
        );
        match response {
            Ok(value) if value.as_object().is_some_and(|o| o.is_empty()) => Ok(()),
            other => {
                let mut active = c.turn.lock().map_err(|_| "Codex 任务状态不可用")?;
                if let Some(turn) = active
                    .as_mut()
                    .filter(|t| t.native_id.as_ref() == Some(&input.expected_turn_id))
                {
                    turn.unknown = true;
                    c.coordinator.mark_submission_unknown(&turn.host_id)?;
                    c.turn_state(turn, "unknown")?;
                }
                Err(other.err().map_or_else(
                    || "Codex 未确认停止请求；操作结果未知".into(),
                    |e| e.to_string(),
                ))
            }
        }
    })
    .await
    .map_err(|_| "Codex 停止请求被中断；结果需核对".to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexSteerInput {
    farfold_session_id: crate::host_ids::FarfoldSessionId,
    native_session_id: crate::host_ids::NativeSessionId,
    generation: u64,
    expected_turn_id: crate::host_ids::NativeTurnId,
    text: String,
}

#[tauri::command]
pub async fn host_codex_turn_steer(
    app: AppHandle,
    input: CodexSteerInput,
) -> Result<CodexSubmission, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if input.text.trim().is_empty() || input.text.len() > 512 * 1024 {
            return Err("Codex 转向输入为空或超过限制".into());
        }
        let target = app
            .state::<HostStore>()
            .session_open_target(&input.farfold_session_id)?;
        if target.native_session_id != input.native_session_id {
            return Err("Host 与 Codex 原生会话身份不匹配".into());
        }
        let c = app
            .state::<CodexRuntime>()
            .current()?
            .ok_or("Codex 连接已退出")?;
        verify_turn_target(&c, &target, input.generation)?;
        let host_turn_id = {
            let active = c.turn.lock().map_err(|_| "Codex 任务状态不可用")?;
            active
                .as_ref()
                .filter(|t| {
                    t.accepts_interaction(
                        input.native_session_id.as_str(),
                        input.expected_turn_id.as_str(),
                    )
                })
                .ok_or("Codex 原生轮次已结束、停止或结果未知，不能转向")?
                .host_id
                .clone()
        };
        let result = c.transport.dispatch(
            "turn/steer",
            json!({"threadId":input.native_session_id,"expectedTurnId":input.expected_turn_id,
            "input":[{"type":"text","text":input.text,"text_elements":[]}]}),
        );
        match result {
            Ok(reply) if reply["turnId"].as_str() == Some(input.expected_turn_id.as_str()) => {
                Ok(CodexSubmission::Accepted {
                    host_turn_id,
                    native_turn_id: input.expected_turn_id,
                })
            }
            Err(error @ (DispatchError::NotSent(_) | DispatchError::Rejected { .. })) => {
                Err(error.to_string())
            }
            other => {
                let mut active = c.turn.lock().map_err(|_| "Codex 任务状态不可用")?;
                if let Some(t) = active.as_mut().filter(|t| t.host_id == host_turn_id) {
                    t.unknown = true;
                    c.coordinator.mark_submission_unknown(&host_turn_id)?;
                    c.turn_state(t, "unknown")?;
                }
                Ok(CodexSubmission::Unknown {
                    detail: other.err().map_or_else(
                        || "Codex 转向结果未确认；输入保留且不自动重发".into(),
                        |e| e.to_string(),
                    ),
                })
            }
        }
    })
    .await
    .map_err(|_| "Codex 转向操作被中断；结果需核对".to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexReplyInput {
    farfold_session_id: crate::host_ids::FarfoldSessionId,
    native_session_id: crate::host_ids::NativeSessionId,
    generation: u64,
    interaction_id: String,
    reply: crate::codex_interactions::CodexInteractionReply,
}

#[tauri::command]
pub async fn host_codex_interaction_reply(
    app: AppHandle,
    input: CodexReplyInput,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = app
            .state::<HostStore>()
            .session_open_target(&input.farfold_session_id)?;
        if target.native_session_id != input.native_session_id {
            return Err("Host 与 Codex 原生会话身份不匹配".into());
        }
        let c = app
            .state::<CodexRuntime>()
            .current()?
            .ok_or("Codex 连接已退出")?;
        c.reply_interaction(
            &target,
            input.generation,
            &input.interaction_id,
            input.reply,
            &app.state::<crate::interaction_registry::InteractionRegistry>(),
        )
    })
    .await
    .map_err(|_| "Codex 交互回复被中断；结果需核对".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_submission_uses_shared_admission_and_retains_background_occupation() {
        use crate::{host_ids::*, host_store::session_open::SessionOpenTarget};
        use std::{
            thread,
            time::{Duration, Instant},
        };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let script = root.join("server.py");
        fs::write(&script,r#"
import json,sys,pathlib
count=0
for line in sys.stdin:
 r=json.loads(line);count+=1
 if 'method' not in r:
  assert r['id']==77 and r['result']=={'decision':'accept'}
  with open(sys.argv[1], 'a') as f:f.write('approval-replied\n')
  print(json.dumps({'method':'serverRequest/resolved','params':{'threadId':tid,'requestId':77}}),flush=True)
  print(json.dumps({'method':'turn/completed','params':{'threadId':tid,'turn':{'id':turn,'status':'completed','items':[]}}}),flush=True)
  continue
 mode=r['params']['input'][0]['text'];tid=r['params']['threadId'];turn='turn-'+str(count)
 with open(sys.argv[1], 'a') as f:f.write(mode+'\n')
 if mode=='reject':
  print(json.dumps({'id':r['id'],'error':{'code':-32600,'message':'fixture rejected'}}),flush=True);continue
 print(json.dumps({'method':'turn/started','params':{'threadId':tid,'turn':{'id':turn,'status':'inProgress','items':[]}}}),flush=True)
 if mode=='approval':
  print(json.dumps({'id':77,'method':'item/commandExecution/requestApproval','params':{'threadId':tid,'turnId':turn,'itemId':'cmd','command':'echo fixture','availableDecisions':['accept','cancel']}}),flush=True)
  print(json.dumps({'id':r['id'],'result':{'turn':{'id':turn,'status':'inProgress','items':[]}}}),flush=True)
  continue
 if mode=='background':print(json.dumps({'method':'item/started','params':{'threadId':tid,'turnId':turn,'item':{'id':'cmd','type':'commandExecution','processId':'123','exitCode':None}}}),flush=True)
 print(json.dumps({'method':'turn/completed','params':{'threadId':tid,'turn':{'id':turn,'status':'interrupted' if mode=='background' else 'completed','items':[]}}}),flush=True)
 print(json.dumps({'id':r['id'],'result':{'turn':{'id':turn,'status':'inProgress','items':[]}}}),flush=True)
"#).unwrap();
        let marker = root.join("received");
        let transport = CodexTransport::spawn(
            std::process::Command::new("/usr/bin/python3")
                .arg(&script)
                .arg(&marker),
        )
        .unwrap();
        let binding = RuntimeBinding {
            product_id: RuntimeProductId::parse("codex").unwrap(),
            installation_id: InstallationId::parse("install").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("build").unwrap(),
            adapter_id: AdapterId::parse("codex-app-server").unwrap(),
            connection_id: ConnectionId::parse("connection").unwrap(),
        };
        let target = SessionOpenTarget {
            farfold_session_id: FarfoldSessionId::parse("host-session").unwrap(),
            runtime_product_id: binding.product_id.clone(),
            installation_id: binding.installation_id.clone(),
            runtime_build_id: binding.runtime_build_id.clone(),
            adapter_id: binding.adapter_id.clone(),
            connection_id: binding.connection_id.clone(),
            working_copy_id: WorkingCopyId::parse("copy").unwrap(),
            working_copy_path: root.clone(),
            native_session_id: NativeSessionId::parse("thread").unwrap(),
            title: "test".into(),
            archived_at: None,
            locator_kind: None,
            locator_value: None,
            registered_system_binding: Some(binding.clone()),
        };
        let session = crate::codex_sessions::read_session(json!({"thread":{"id":"thread","sessionId":"tree","cwd":root,"cliVersion":"0.143.0","createdAt":1,"updatedAt":1,"ephemeral":false,"modelProvider":"openai","preview":"","source":"appServer","status":{"type":"idle"},"turns":[]},"model":"fixture-model","modelProvider":"openai","reasoningEffort":"medium","cwd":root,"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}}), &root, Some(&target.native_session_id)).unwrap();
        let coordinator = TurnCoordinator::default();
        let registry = crate::interaction_registry::InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(64, None, Some(registry.clone()));
        let c = Arc::new(Connection {
            generation: 2,
            binding,
            transport,
            state_directory: root.clone(),
            control: Mutex::new(AccountControl::default()),
            session: Mutex::new(Some(session)),
            turn: Mutex::new(None),
            coordinator: coordinator.clone(),
            router: router.clone(),
        });
        c.start_events(router).unwrap();
        assert!(
            c.submit(
                target.clone(),
                1,
                "wrong-generation".into(),
                CodexMode::Default
            )
            .is_err()
        );
        let mut wrong = target.clone();
        wrong.native_session_id = NativeSessionId::parse("other-thread").unwrap();
        assert!(
            c.submit(wrong, 2, "wrong-thread".into(), CodexMode::Default)
                .is_err()
        );
        assert!(!marker.exists());
        assert!(
            c.submit(target.clone(), 2, "reject".into(), CodexMode::Default)
                .is_err()
        );
        assert_eq!(coordinator.snapshot().unwrap().active_turn_count(), 0);
        assert!(matches!(
            c.submit(target.clone(), 2, "complete".into(), CodexMode::Default),
            Ok(CodexSubmission::Accepted { .. })
        ));
        let until = Instant::now() + Duration::from_secs(2);
        while coordinator.snapshot().unwrap().active_turn_count() > 0 && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(coordinator.snapshot().unwrap().active_turn_count(), 0);
        assert!(matches!(
            c.submit(target.clone(), 2, "approval".into(), CodexMode::Default),
            Ok(CodexSubmission::Accepted { .. })
        ));
        let until = Instant::now() + Duration::from_secs(2);
        while registry.snapshots().unwrap().is_empty() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        let key = registry
            .snapshots()
            .unwrap()
            .first()
            .and_then(|snapshot| {
                serde_json::to_value(snapshot).unwrap()["interactionId"]
                    .as_str()
                    .map(str::to_owned)
            })
            .unwrap();
        let decision = || crate::codex_interactions::CodexInteractionReply::Decision {
            decision: json!("accept"),
        };
        assert_eq!(
            serde_json::to_value(coordinator.snapshot().unwrap()).unwrap()["activeTurns"][0]["runtimeObserved"],
            true,
            "validated native turn is observed while approval remains pending"
        );
        assert!(
            c.reply_interaction(&target, 1, &key, decision(), &registry)
                .is_err()
        );
        assert!(
            c.reply_interaction(
                &target,
                2,
                &key,
                crate::codex_interactions::CodexInteractionReply::Decision {
                    decision: json!("decline")
                },
                &registry
            )
            .is_err()
        );
        c.reply_interaction(&target, 2, &key, decision(), &registry)
            .unwrap();
        assert!(
            c.reply_interaction(&target, 2, &key, decision(), &registry)
                .is_err()
        );
        let until = Instant::now() + Duration::from_secs(2);
        while coordinator.snapshot().unwrap().active_turn_count() > 0 && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(registry.snapshots().unwrap().is_empty());
        assert_eq!(coordinator.snapshot().unwrap().active_turn_count(), 0);
        assert!(matches!(
            c.submit(target.clone(), 2, "background".into(), CodexMode::Default),
            Ok(CodexSubmission::Accepted { .. })
        ));
        let until = Instant::now() + Duration::from_secs(2);
        while !c
            .turn
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|t| t.outcome_unknown())
            && Instant::now() < until
        {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(coordinator.snapshot().unwrap().active_turn_count(), 1);
        assert!(c.turn.lock().unwrap().as_ref().unwrap().outcome_unknown());
        assert!(
            c.submit(target, 2, "must-not-send".into(), CodexMode::Default)
                .is_err()
        );
        let peer_request = |session: &str, copy: &str| TurnAdmissionRequest {
            farfold_session_id: FarfoldSessionId::parse(session).unwrap(),
            working_copy_id: WorkingCopyId::parse(copy).unwrap(),
            runtime_product_id: RuntimeProductId::parse("pi").unwrap(),
            installation_id: InstallationId::parse("bundled-pi").unwrap(),
            runtime_connection_id: ConnectionId::parse("pi-local-native-config-v1").unwrap(),
            native_session_id: NativeSessionId::parse(format!("native-{session}")).unwrap(),
            runtime_generation: 1,
            started_at: 1,
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
            provider_binding_authority: TurnProviderBindingAuthority::CurrentAppliedProjection,
        };
        assert!(coordinator.admit(peer_request("conflict", "copy")).is_err());
        let peer = coordinator
            .admit(peer_request("peer", "independent-copy"))
            .unwrap();
        assert!(
            coordinator
                .admit(peer_request("third", "third-copy"))
                .is_err()
        );
        coordinator.cancel_submission(peer.id()).unwrap();
        assert_eq!(
            fs::read_to_string(marker).unwrap(),
            "reject\ncomplete\napproval\napproval-replied\nbackground\n"
        );
        let runtime = CodexRuntime::default();
        *runtime.connection.lock().unwrap() = Some(c);
        runtime.stop().unwrap();
        assert_eq!(coordinator.snapshot().unwrap().active_turn_count(), 0);
    }

    #[test]
    fn account_notifications_remain_private_and_early_login_completion_is_correlated() {
        let temp = tempfile::tempdir().unwrap();
        let transport = CodexTransport::spawn(
            std::process::Command::new("/usr/bin/python3")
                .arg("-c")
                .arg("import sys;sys.stdin.read()"),
        )
        .unwrap();
        let connection = Connection {
            generation: 7,
            binding: RuntimeBinding {
                product_id: RuntimeProductId::parse("codex").unwrap(),
                installation_id: InstallationId::parse("system-installation-test").unwrap(),
                runtime_build_id: crate::host_ids::RuntimeBuildId::parse("build-test").unwrap(),
                adapter_id: AdapterId::parse("codex-app-server").unwrap(),
                connection_id: ConnectionId::parse("connection-test").unwrap(),
            },
            transport,
            state_directory: temp.path().to_path_buf(),
            control: Mutex::new(AccountControl::default()),
            session: Mutex::new(None),
            turn: Mutex::new(None),
            coordinator: TurnCoordinator::default(),
            router: RuntimeEventRouter::default(),
        };
        let router = RuntimeEventRouter::default();
        let native = json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"原生答复"},"future":"retained"});
        connection.receive_events(&router, vec![
            json!({"method":"account/login/completed","params":{"loginId":"login-1","success":true,"extra":"secret-fixture"}}),
            json!({"method":"account/future","params":{"token":"secret-fixture"}}),
            native.clone(),
        ], 0, None).unwrap();
        let batch = serde_json::to_value(router.snapshot(None, None).unwrap()).unwrap();
        assert_eq!(batch["events"].as_array().unwrap().len(), 1);
        assert_eq!(batch["events"][0]["nativeEnvelope"]["payload"], native);
        assert_eq!(batch["events"][0]["runtimeGeneration"], 7);
        assert_eq!(batch["events"][0]["connectionId"], "connection-test");
        assert!(!batch.to_string().contains("secret-fixture"));
        let mut state = connection.control.lock().unwrap();
        assert_eq!(state.login_completions.len(), 1);
        state.login = Some(PendingLogin {
            id: "other-login".into(),
            phase: LoginPhase::Waiting,
        });
        state.apply_login_completions();
        assert!(state.login.as_ref().unwrap().phase == LoginPhase::Waiting);
        state.login = Some(PendingLogin {
            id: "login-1".into(),
            phase: LoginPhase::Waiting,
        });
        state.apply_login_completions();
        assert!(state.login.as_ref().unwrap().phase == LoginPhase::Confirming);
        assert!(state.login_completions.is_empty());
        // A callback does not establish a readable account or usable quota.
        assert!(state.account.is_none());
        drop(state);
        connection
            .receive_events(&router, vec![], 3, Some("connection lost".into()))
            .unwrap();
        let batch = serde_json::to_value(router.snapshot(None, None).unwrap()).unwrap();
        assert_eq!(batch["events"][1]["kind"], "transport_gap");
        assert_eq!(batch["events"][2]["kind"], "transport_error");
        assert!(
            connection
                .control
                .lock()
                .unwrap()
                .login
                .as_ref()
                .unwrap()
                .phase
                == LoginPhase::Unknown
        );
        connection.transport.stop().unwrap();
    }

    #[test]
    fn maintenance_remains_blocked_until_owned_process_exit_is_observed() {
        use std::{
            process::Command,
            thread,
            time::{Duration, Instant},
        };
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("eof-observed");
        let transport=CodexTransport::spawn(Command::new("/usr/bin/python3").arg("-c")
            .arg("import sys,time,pathlib;sys.stdin.read();pathlib.Path(sys.argv[1]).touch();time.sleep(1)")
            .arg(&marker)).unwrap();
        let runtime = Arc::new(CodexRuntime::default());
        *runtime.connection.lock().unwrap() = Some(Arc::new(Connection {
            generation: 1,
            binding: crate::runtime_registry::PI_RUNTIME.into(),
            transport,
            state_directory: temp.path().to_path_buf(),
            control: Mutex::new(AccountControl::default()),
            session: Mutex::new(None),
            turn: Mutex::new(None),
            coordinator: TurnCoordinator::default(),
            router: RuntimeEventRouter::default(),
        }));
        let stopping = runtime.clone();
        let worker = thread::spawn(move || stopping.stop());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let maintenance_blocked = runtime.with_stopped(|| Ok(())).is_err();
        let snapshot = runtime.status().unwrap();
        worker.join().unwrap().unwrap();
        assert!(
            maintenance_blocked,
            "closing stdin is not confirmed process exit"
        );
        assert!(snapshot.process_running);
        assert!(!snapshot.initialized);
        assert!(runtime.with_stopped(|| Ok(())).is_ok());
    }

    #[test]
    fn account_wait_does_not_block_connection_observation() {
        use std::{
            process::Command,
            sync::{Arc, mpsc},
            thread,
            time::{Duration, Instant},
        };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let marker = root.join("received");
        let release = root.join("release");
        let script = root.join("server.py");
        fs::write(&script,r#"
import json,sys,time,pathlib
root=pathlib.Path(sys.argv[1])
for line in sys.stdin:
    request=json.loads(line)
    (root/'received').touch()
    end=time.monotonic()+3
    while not (root/'release').exists() and time.monotonic()<end:time.sleep(.01)
    print(json.dumps({'id':request['id'],'result':{'account':None,'requiresOpenaiAuth':True}}),flush=True)
"#).unwrap();
        let transport =
            CodexTransport::spawn(Command::new("/usr/bin/python3").arg(script).arg(&root)).unwrap();
        let runtime = Arc::new(CodexRuntime::default());
        *runtime.connection.lock().unwrap() = Some(Arc::new(Connection {
            generation: 1,
            binding: crate::runtime_registry::PI_RUNTIME.into(),
            transport,
            state_directory: root.clone(),
            control: Mutex::new(AccountControl::default()),
            session: Mutex::new(None),
            turn: Mutex::new(None),
            coordinator: TurnCoordinator::default(),
            router: RuntimeEventRouter::default(),
        }));
        let worker = runtime.clone();
        let (read_tx, read_rx) = mpsc::sync_channel(1);
        let reading = thread::spawn(move || {
            let _ = read_tx.send(worker.current().unwrap().unwrap().refresh());
        });
        let until = Instant::now() + Duration::from_secs(2);
        while !marker.exists() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        let observer = runtime.clone();
        let (tx, rx) = mpsc::sync_channel(1);
        let observing = thread::spawn(move || {
            let _ = tx.send(observer.status().map(|s| s.initialized));
        });
        let observed = rx.recv_timeout(Duration::from_millis(250));
        runtime
            .current()
            .unwrap()
            .unwrap()
            .transport
            .begin_stop()
            .unwrap();
        let interrupted = read_rx.recv_timeout(Duration::from_millis(250));
        fs::write(&release, b"release").unwrap();
        reading.join().unwrap();
        observing.join().unwrap();
        runtime.stop().unwrap();
        assert!(observed.is_ok(), "account/read blocked a Host status query");
        assert!(
            matches!(interrupted, Ok(Err(_))),
            "closing input did not release the pending account waiter"
        );
    }

    #[test]
    #[ignore = "requires an explicitly selected pinned official Codex installation; uses no real credentials or Provider tasks"]
    fn pinned_native_control_roundtrip_in_empty_private_environment() {
        let selected = std::env::var_os("FARFOLD_CODEX_INSTALLATION_TEST_PATH")
            .expect("explicit official installation");
        let inspection = crate::codex_installation::inspect(PathBuf::from(selected)).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let directory = root.join("codex");
        private_directory(&directory).unwrap();
        let mut command = verified_command(&inspection).unwrap();
        command
            .args([
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "cli_auth_credentials_store=\"file\"",
            ])
            .env_clear()
            .env("HOME", &root)
            .env("CODEX_HOME", &directory)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .current_dir(&root);
        let transport = CodexTransport::spawn(&mut command).unwrap();
        let initialized=transport.request("initialize",json!({"clientInfo":{"name":"farfold_control_test","version":"0.1.6"},"capabilities":{"experimentalApi":false}})).unwrap();
        assert_eq!(initialized["codexHome"], directory.to_str().unwrap());
        assert_eq!(initialized["platformOs"], "macos");
        transport.notify("initialized", json!({})).unwrap();
        let first: AccountSnapshot = serde_json::from_value(
            transport
                .request("account/read", json!({"refreshToken":false}))
                .unwrap(),
        )
        .unwrap();
        assert!(first.account.is_none());
        assert!(first.requires_openai_auth);
        let reply = transport
            .request(
                "account/login/start",
                json!({"type":"apiKey","apiKey":"sk-farfold-test-invalid-no-provider-request"}),
            )
            .unwrap();
        assert_eq!(reply["type"], "apiKey");
        secure_auth_file(&directory).unwrap();
        let account: AccountSnapshot = serde_json::from_value(
            transport
                .request("account/read", json!({"refreshToken":false}))
                .unwrap(),
        )
        .unwrap();
        assert!(matches!(account.account, Some(CodexAccount::ApiKey)));
        let started = transport.request("thread/start", json!({
            "cwd":root,"model":"gpt-5.5","config":{"model_reasoning_effort":"medium"},
            "approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"workspace-write","ephemeral":false
        })).unwrap();
        let native = crate::codex_sessions::read_session(started, &root, None).unwrap();
        assert_eq!(native.model, "gpt-5.5");
        assert_eq!(native.reasoning_effort.as_deref(), Some("medium"));
        assert!(native.thread.turns.is_empty());
        transport.request("account/logout", json!({})).unwrap();
        let last: AccountSnapshot = serde_json::from_value(
            transport
                .request("account/read", json!({"refreshToken":false}))
                .unwrap(),
        )
        .unwrap();
        assert!(last.account.is_none());
        transport.stop().unwrap();
        assert!(!transport.is_running().unwrap());
    }
    #[test]
    fn private_auth_rejects_links_and_protects_only_owned_files() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("codex");
        private_directory(&state).unwrap();
        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o777,
            0o700
        );
        secure_auth_file(&state).unwrap();
        let auth = state.join("auth.json");
        fs::write(&auth, b"fixture").unwrap();
        secure_auth_file(&state).unwrap();
        assert_eq!(
            fs::metadata(&auth).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let outside = temp.path().join("outside");
        fs::rename(&auth, &outside).unwrap();
        std::os::unix::fs::symlink(&outside, &auth).unwrap();
        assert!(secure_auth_file(&state).is_err());
        fs::remove_file(&auth).unwrap();
        fs::hard_link(&outside, &auth).unwrap();
        assert!(secure_auth_file(&state).is_err());
    }
    #[test]
    fn account_presence_and_official_login_address_have_explicit_boundaries() {
        let missing: AccountSnapshot =
            serde_json::from_value(json!({"account":null,"requiresOpenaiAuth":true})).unwrap();
        assert!(missing.account.is_none());
        assert!(
            serde_json::from_value::<AccountSnapshot>(json!({"account":{"type":"apiKey"}}))
                .is_err()
        );
        assert!(validated_auth_url("https://auth.openai.com/oauth/authorize?fixture=1").is_ok());
        for url in [
            "http://auth.openai.com/oauth/authorize",
            "https://auth.openai.com.evil.test/",
            "https://user@auth.openai.com/",
            "https://example.org/",
        ] {
            assert!(validated_auth_url(url).is_err());
        }
    }
}
