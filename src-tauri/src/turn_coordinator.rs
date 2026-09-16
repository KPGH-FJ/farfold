use crate::host_ids::{
    ConnectionId, FarfoldSessionId, HostTurnId, InstallationId, NativeSessionId,
    ProviderConfigVersionId, ProviderConnectionId, RuntimeProductId, WorkingCopyId,
};
use crate::{
    host_store::{
        HostStore,
        provider_projection::{
            ProviderActiveTaskPolicy, ProviderApplyState, ProviderRequestState, ProviderSaveState,
            ProviderTargetProjectionInput, TurnProviderBindingAuthority, TurnProviderBindingInput,
        },
        session_open::SessionOpenTarget,
        turn_changes::{TurnChangeCaptureInput, begin_capture, cancel_capture, finish_capture},
    },
    lifemodel,
    opencode_protocol::{PromptDispatch, abort_session, prompt_text},
    opencode_runtime::{OpenCodeRuntime, connection},
    pi_runtime::{self, PiCommand, PiRuntime},
    runtime_event_router::RoutedRuntimeEvent,
    runtime_registry::{OPENCODE_RUNTIME, OPENCODE_RUNTIME_PRODUCT_ID, PI_RUNTIME_PRODUCT_ID},
    session_controller::{
        HostSessionController, require_active_pi_target, require_openable, require_session_target,
        verify_opencode_target, verify_pi_target,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fmt,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

pub const MAX_ACTIVE_TURNS: usize = 2;
const MAX_USER_PROMPT_BYTES: usize = 1024 * 1024;
const MAX_PROVIDER_ID_BYTES: usize = 256;
const MAX_MODEL_ID_BYTES: usize = 512;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveHostTurn {
    turn_id: HostTurnId,
    farfold_session_id: FarfoldSessionId,
    working_copy_id: WorkingCopyId,
    runtime_product_id: RuntimeProductId,
    installation_id: InstallationId,
    runtime_connection_id: ConnectionId,
    native_session_id: NativeSessionId,
    runtime_generation: u64,
    started_at: u64,
    runtime_observed: bool,
    outcome_unknown: bool,
    provider_connection_id: Option<ProviderConnectionId>,
    provider_config_version_id: Option<ProviderConfigVersionId>,
    runtime_provider_id: Option<String>,
    runtime_model_id: Option<String>,
    provider_binding_authority: TurnProviderBindingAuthority,
    #[serde(skip)]
    pi_prompt_request_id: Option<String>,
    abort_requested: bool,
}

impl ActiveHostTurn {
    pub(crate) fn id(&self) -> &HostTurnId {
        &self.turn_id
    }
}

#[derive(Debug, Clone)]
pub(crate) struct TurnAdmissionRequest {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) working_copy_id: WorkingCopyId,
    pub(crate) runtime_product_id: RuntimeProductId,
    pub(crate) installation_id: InstallationId,
    pub(crate) runtime_connection_id: ConnectionId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) runtime_generation: u64,
    pub(crate) started_at: u64,
    pub(crate) provider_connection_id: Option<ProviderConnectionId>,
    pub(crate) provider_config_version_id: Option<ProviderConfigVersionId>,
    pub(crate) runtime_provider_id: Option<String>,
    pub(crate) runtime_model_id: Option<String>,
    pub(crate) provider_binding_authority: TurnProviderBindingAuthority,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnAdmissionBlocker {
    HostMaintenance,
    RuntimeProviderConfigurationBusy,
    SessionBusy,
    WorkingCopyOccupied,
    ApplicationLimitReached,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnAdmissionRejection {
    blockers: Vec<TurnAdmissionBlocker>,
    conflicting_turn_ids: Vec<HostTurnId>,
    conflicting_sessions: Vec<TurnAdmissionConflict>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TurnAdmissionConflict {
    farfold_session_id: FarfoldSessionId,
    runtime_product_id: RuntimeProductId,
    installation_id: InstallationId,
    title: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnCoordinatorSnapshot {
    capacity: usize,
    active_turns: Vec<ActiveHostTurn>,
    maintenance_active: bool,
    provider_apply_active: bool,
}

impl TurnCoordinatorSnapshot {
    pub(crate) fn active_turn_count(&self) -> usize {
        self.active_turns.len()
    }
}

fn validate_provider_application_token(token: &str) -> Result<(), String> {
    if !token.is_empty()
        && token.len() <= 120
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Ok(());
    }
    Err("Provider configuration operation id is invalid".to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostOpenCodeTurnSubmitInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    provider_id: String,
    model_id: String,
    provider_connection_id: Option<ProviderConnectionId>,
    provider_config_version_id: Option<ProviderConfigVersionId>,
    text: String,
    life_model_manifest_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostOpenCodeTurnAbortInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostOpenCodeAcpTurnSubmitInput {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) text: String,
    pub(crate) provider_connection_id: Option<ProviderConnectionId>,
    pub(crate) provider_config_version_id: Option<ProviderConfigVersionId>,
    pub(crate) runtime_provider_id: Option<String>,
    pub(crate) runtime_model_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostOpenCodeAcpTurnAbortInput {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native_session_id: NativeSessionId,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostPiAcpTurnSubmitInput {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) runtime_generation: u64,
    pub(crate) text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostPiAcpTurnAbortInput {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) runtime_generation: u64,
    pub(crate) turn_id: HostTurnId,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostPiAcpInterventionInput {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) runtime_generation: u64,
    pub(crate) turn_id: HostTurnId,
    pub(crate) kind: crate::pi_acp::PiAcpInterventionKind,
    pub(crate) message: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum HostPiAcpInterventionOutcome {
    Queued {
        delivery: crate::pi_acp::PiAcpInterventionKind,
    },
    Unknown {
        detail: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostPiTurnSubmitInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    life_model_manifest_id: Option<String>,
    provider_connection_id: Option<ProviderConnectionId>,
    provider_config_version_id: Option<ProviderConfigVersionId>,
    runtime_provider_id: Option<String>,
    runtime_model_id: Option<String>,
    command: PiCommand,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostPiTurnAbortInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    command: PiCommand,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostTurnSubmission {
    pub(crate) turn_id: HostTurnId,
    pub(crate) accepted_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum HostNativeTurnSubmission {
    Accepted { submission: HostTurnSubmission },
    Cancelled { detail: String },
    Failed { detail: String },
    Unknown { detail: String },
}

pub type HostOpenCodeTurnSubmission = HostNativeTurnSubmission;

struct TurnCoordinatorState {
    next_turn_sequence: u64,
    active_turns: Vec<ActiveHostTurn>,
    maintenance_token: Option<String>,
    provider_applications: Vec<ProviderApplicationReservation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderApplicationReservation {
    token: String,
    runtime_product_id: RuntimeProductId,
    installation_id: InstallationId,
    runtime_connection_id: ConnectionId,
}

#[derive(Clone)]
pub struct TurnCoordinator {
    capacity: usize,
    state: Arc<Mutex<TurnCoordinatorState>>,
    change_store: Arc<Mutex<Option<HostStore>>>,
}

impl Default for TurnCoordinator {
    fn default() -> Self {
        Self::with_capacity(MAX_ACTIVE_TURNS)
    }
}

impl TurnAdmissionBlocker {
    fn explanation(self) -> &'static str {
        match self {
            Self::HostMaintenance => "应用正在执行维护操作。请等待维护完成后重试。",
            Self::RuntimeProviderConfigurationBusy => {
                "当前 Runtime 正在应用模型服务配置。请等待配置完成后重试。"
            }
            Self::SessionBusy => "当前对话已有任务正在运行。请先停止或等待该任务完成后重试。",
            Self::WorkingCopyOccupied => {
                "这个工作目录已有任务正在运行。请先停止或等待该任务完成后重试，或选择独立的工作副本。"
            }
            Self::ApplicationLimitReached => {
                "同时运行的任务已达到上限。请先停止或等待其中一项完成后重试。"
            }
        }
    }
}

impl fmt::Display for TurnAdmissionRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, blocker) in self.blockers.iter().enumerate() {
            if index > 0 {
                write!(formatter, " ")?;
            }
            write!(formatter, "{}", blocker.explanation())?;
        }
        if !self.conflicting_sessions.is_empty() {
            write!(formatter, " 相关运行对话：")?;
            for (index, session) in self.conflicting_sessions.iter().enumerate() {
                if index > 0 {
                    write!(formatter, "、")?;
                }
                let runtime = match session.runtime_product_id.as_str() {
                    "pi" => "Pi",
                    "opencode" => "OpenCode",
                    other => other,
                };
                match &session.title {
                    Some(title) => write!(formatter, "{runtime}「{title}」")?,
                    None => write!(formatter, "{runtime} 对话（标题暂不可读取）")?,
                }
            }
            write!(formatter, "。")?;
        }
        Ok(())
    }
}

fn admission_conflicts(
    turns: Vec<ActiveHostTurn>,
    title_for: impl Fn(&FarfoldSessionId) -> Option<String>,
) -> Vec<TurnAdmissionConflict> {
    let mut conflicts = Vec::new();
    for turn in turns {
        if conflicts.iter().any(|existing: &TurnAdmissionConflict| {
            existing.farfold_session_id == turn.farfold_session_id
        }) {
            continue;
        }
        let title = title_for(&turn.farfold_session_id);
        conflicts.push(TurnAdmissionConflict {
            farfold_session_id: turn.farfold_session_id,
            runtime_product_id: turn.runtime_product_id,
            installation_id: turn.installation_id,
            title,
        });
    }
    conflicts
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn validate_opencode_submission(input: &HostOpenCodeTurnSubmitInput) -> Result<(), String> {
    if input.text.len() > MAX_USER_PROMPT_BYTES {
        return Err(format!(
            "OpenCode prompt exceeds the {MAX_USER_PROMPT_BYTES}-byte limit"
        ));
    }
    for (label, value, limit) in [
        (
            "Provider ID",
            input.provider_id.as_str(),
            MAX_PROVIDER_ID_BYTES,
        ),
        ("model ID", input.model_id.as_str(), MAX_MODEL_ID_BYTES),
    ] {
        if value.trim().is_empty() || value.len() > limit || value.contains('\0') {
            return Err(format!("OpenCode {label} is invalid"));
        }
    }
    Ok(())
}

fn provider_binding(
    provider_connection_id: Option<ProviderConnectionId>,
    provider_config_version_id: Option<ProviderConfigVersionId>,
    runtime_provider_id: Option<String>,
    runtime_model_id: Option<String>,
) -> Result<
    Option<(
        ProviderConnectionId,
        ProviderConfigVersionId,
        String,
        String,
    )>,
    String,
> {
    match (
        provider_connection_id,
        provider_config_version_id,
        runtime_provider_id,
        runtime_model_id,
    ) {
        (Some(connection_id), Some(version_id), Some(provider_id), Some(model_id)) => {
            Ok(Some((connection_id, version_id, provider_id, model_id)))
        }
        (None, None, None, None) => Ok(None),
        _ => Err(
            "Provider connection, config version, Runtime provider, and Runtime model must be supplied together"
                .to_string(),
        ),
    }
}

fn persist_provider_turn_binding(store: &HostStore, turn: &ActiveHostTurn) -> Result<(), String> {
    let Some(provider_connection_id) = &turn.provider_connection_id else {
        return Ok(());
    };
    let Some(provider_config_version_id) = &turn.provider_config_version_id else {
        return Err("Host Turn is missing its Provider config version".to_string());
    };
    let Some(runtime_provider_id) = &turn.runtime_provider_id else {
        return Err("Host Turn is missing its Runtime Provider ID".to_string());
    };
    let Some(runtime_model_id) = &turn.runtime_model_id else {
        return Err("Host Turn is missing its Runtime model ID".to_string());
    };
    store.bind_turn_provider_config(
        &TurnProviderBindingInput {
            host_turn_id: turn.turn_id.clone(),
            provider_connection_id: provider_connection_id.clone(),
            provider_config_version_id: provider_config_version_id.clone(),
            runtime_product_id: turn.runtime_product_id.clone(),
            installation_id: turn.installation_id.clone(),
            runtime_connection_id: turn.runtime_connection_id.clone(),
            runtime_provider_id: runtime_provider_id.clone(),
            runtime_model_id: runtime_model_id.clone(),
        },
        turn.provider_binding_authority,
    )
}

fn persist_pi_model_source(
    store: &HostStore,
    target: &SessionOpenTarget,
    turn: &ActiveHostTurn,
    observation: &crate::pi_acp::PiPromptModelObservation,
) -> Result<(), String> {
    observation.verify_target(target, turn.runtime_generation)?;
    if observation.observed_at() > turn.started_at {
        return Err("Pi 模型观察晚于本轮接纳；不能回填任务来源".into());
    }
    match observation.source() {
        crate::pi_acp::PiModelSource::ManagedVersion { binding } => {
            if turn.provider_connection_id.as_ref() != Some(&binding.provider_connection_id)
                || turn.provider_config_version_id.as_ref()
                    != Some(&binding.provider_config_version_id)
                || turn.runtime_provider_id.as_ref() != Some(&binding.runtime_provider_id)
                || turn.runtime_model_id.as_ref() != Some(&binding.runtime_model_id)
            {
                return Err("Pi 本轮托管来源与已接纳版本不一致".into());
            }
            persist_provider_turn_binding(store, turn)
        }
        crate::pi_acp::PiModelSource::NativeObservation {
            runtime_provider_id,
            runtime_model_id,
            native_model_id,
        } => {
            if turn.provider_connection_id.is_some()
                || turn.provider_config_version_id.is_some()
                || turn.runtime_provider_id.is_some()
                || turn.runtime_model_id.is_some()
            {
                return Err("Pi 原生观察不能附带托管版本或复用旧绑定".into());
            }
            if turn.farfold_session_id != target.farfold_session_id
                || turn.native_session_id != target.native_session_id
                || turn.runtime_connection_id != target.connection_id
                || turn.installation_id != target.installation_id
                || turn.runtime_product_id != target.runtime_product_id
            {
                return Err("Pi 原生观察与本轮原会话身份不一致".into());
            }
            store.bind_native_turn_model_observation(
                &crate::host_store::provider_projection::NativeTurnModelObservationInput {
                    host_turn_id: turn.turn_id.clone(),
                    farfold_session_id: turn.farfold_session_id.clone(),
                    native_session_id: turn.native_session_id.clone(),
                    runtime: target.binding(),
                    runtime_generation: turn.runtime_generation,
                    runtime_provider_id: runtime_provider_id.clone(),
                    runtime_model_id: runtime_model_id.clone(),
                    native_model_id: native_model_id.clone(),
                    observed_at: observation.observed_at(),
                },
            )
        }
    }
}

fn rejection_with_injection_cleanup(
    store: &HostStore,
    target: &SessionOpenTarget,
    manifest_id: Option<&str>,
    failure_reason: &str,
    error: String,
) -> String {
    match lifemodel::fail_prepared_injection_for_target(store, target, manifest_id, failure_reason)
    {
        Ok(()) => error,
        Err(cleanup) => {
            format!("{error}; LifeModel Injection Manifest rejection also failed: {cleanup}")
        }
    }
}

impl TurnCoordinator {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            state: Arc::new(Mutex::new(TurnCoordinatorState {
                next_turn_sequence: 0,
                active_turns: Vec::with_capacity(capacity.max(1)),
                maintenance_token: None,
                provider_applications: Vec::new(),
            })),
            change_store: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn attach_host_store(&self, store: HostStore) -> Result<(), String> {
        let mut change_store = self
            .change_store
            .lock()
            .map_err(|_| "Turn Changes storage state is unavailable".to_string())?;
        if change_store.is_some() {
            return Err("Turn Changes storage is already attached".to_string());
        }
        *change_store = Some(store);
        Ok(())
    }

    fn host_store(&self) -> Result<Option<HostStore>, String> {
        self.change_store
            .lock()
            .map(|store| store.clone())
            .map_err(|_| "Turn Changes storage state is unavailable".to_string())
    }

    pub(crate) fn admit(
        &self,
        request: TurnAdmissionRequest,
    ) -> Result<ActiveHostTurn, TurnAdmissionRejection> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let session_conflicts = state
            .active_turns
            .iter()
            .filter(|turn| turn.farfold_session_id == request.farfold_session_id)
            .collect::<Vec<_>>();
        let working_copy_conflicts = state
            .active_turns
            .iter()
            .filter(|turn| turn.working_copy_id == request.working_copy_id)
            .collect::<Vec<_>>();
        let mut blockers = Vec::new();
        if state.maintenance_token.is_some() {
            blockers.push(TurnAdmissionBlocker::HostMaintenance);
        }
        if state.provider_applications.iter().any(|application| {
            application.runtime_product_id == request.runtime_product_id
                && application.installation_id == request.installation_id
        }) {
            blockers.push(TurnAdmissionBlocker::RuntimeProviderConfigurationBusy);
        }
        if !session_conflicts.is_empty() {
            blockers.push(TurnAdmissionBlocker::SessionBusy);
        }
        if !working_copy_conflicts.is_empty() {
            blockers.push(TurnAdmissionBlocker::WorkingCopyOccupied);
        }
        if state.active_turns.len() >= self.capacity {
            blockers.push(TurnAdmissionBlocker::ApplicationLimitReached);
        }
        if !blockers.is_empty() {
            let mut conflicting_turn_ids = session_conflicts
                .into_iter()
                .chain(working_copy_conflicts)
                .map(|turn| turn.turn_id.clone())
                .collect::<Vec<_>>();
            conflicting_turn_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
            conflicting_turn_ids.dedup();
            let relevant_turns = state
                .active_turns
                .iter()
                .filter(|turn| {
                    blockers.contains(&TurnAdmissionBlocker::ApplicationLimitReached)
                        || conflicting_turn_ids.contains(&turn.turn_id)
                })
                .cloned()
                .collect();
            // Capture identities at rejection; resolve only their Host-owned titles after
            // releasing the admission mutex. UI text never guesses which task owns a path.
            drop(state);
            let store = self.host_store().ok().flatten();
            let conflicting_sessions = admission_conflicts(relevant_turns, |id| {
                store
                    .as_ref()?
                    .session_open_target(id)
                    .ok()
                    .map(|target| target.title)
            });
            return Err(TurnAdmissionRejection {
                blockers,
                conflicting_turn_ids,
                conflicting_sessions,
            });
        }

        state.next_turn_sequence = state.next_turn_sequence.saturating_add(1);
        let mut id_bytes = [0_u8; 16];
        let encoded_id = if getrandom::fill(&mut id_bytes).is_ok() {
            format!(
                "turn-{}",
                id_bytes
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            )
        } else {
            format!(
                "turn-{}-{}-{}",
                request.started_at,
                std::process::id(),
                state.next_turn_sequence
            )
        };
        let turn = ActiveHostTurn {
            turn_id: HostTurnId::parse(encoded_id).expect("generated Host Turn IDs are valid"),
            farfold_session_id: request.farfold_session_id,
            working_copy_id: request.working_copy_id,
            runtime_product_id: request.runtime_product_id,
            installation_id: request.installation_id,
            runtime_connection_id: request.runtime_connection_id,
            native_session_id: request.native_session_id,
            runtime_generation: request.runtime_generation,
            started_at: request.started_at,
            runtime_observed: false,
            outcome_unknown: false,
            provider_connection_id: request.provider_connection_id,
            provider_config_version_id: request.provider_config_version_id,
            runtime_provider_id: request.runtime_provider_id,
            runtime_model_id: request.runtime_model_id,
            provider_binding_authority: request.provider_binding_authority,
            pi_prompt_request_id: None,
            abort_requested: false,
        };
        state.active_turns.push(turn.clone());
        drop(state);
        if let Some(store) = self.host_store().ok().flatten() {
            let capture = TurnChangeCaptureInput {
                turn_id: turn.turn_id.clone(),
                farfold_session_id: turn.farfold_session_id.clone(),
                working_copy_id: turn.working_copy_id.clone(),
                runtime_product_id: turn.runtime_product_id.clone(),
                started_at: i64::try_from(turn.started_at).unwrap_or(i64::MAX),
            };
            if let Err(error) = begin_capture(&store, &capture) {
                eprintln!("[farfold] cannot begin Turn Changes capture: {error}");
            }
        }
        Ok(turn)
    }

    pub(crate) fn begin_maintenance(&self, token: &str) -> Result<(), String> {
        if token.len() != 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Host maintenance token is invalid".to_string());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        if !state.active_turns.is_empty() {
            return Err("Host maintenance requires every Turn to be settled".to_string());
        }
        match state.maintenance_token.as_deref() {
            Some(existing) if existing == token => Ok(()),
            Some(_) => Err("A different Host maintenance operation is active".to_string()),
            None => {
                state.maintenance_token = Some(token.to_string());
                Ok(())
            }
        }
    }

    pub(crate) fn end_maintenance(&self, token: &str) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        match state.maintenance_token.as_deref() {
            Some(existing) if existing == token => {
                state.maintenance_token = None;
                Ok(())
            }
            Some(_) => Err("Host maintenance token does not match".to_string()),
            None => Ok(()),
        }
    }

    pub(crate) fn begin_provider_application(
        &self,
        token: &str,
        runtime_product_id: RuntimeProductId,
        installation_id: InstallationId,
        runtime_connection_id: ConnectionId,
    ) -> Result<(), String> {
        validate_provider_application_token(token)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        if state.active_turns.iter().any(|turn| {
            turn.runtime_product_id == runtime_product_id && turn.installation_id == installation_id
        }) {
            return Err("Runtime has an active Turn during Provider configuration".to_string());
        }
        if state
            .provider_applications
            .iter()
            .any(|application| application.token == token)
        {
            return Err(
                "Runtime Provider configuration operation id is already active".to_string(),
            );
        }
        if state.provider_applications.iter().any(|application| {
            application.runtime_product_id == runtime_product_id
                && application.installation_id == installation_id
        }) {
            return Err(
                "Runtime Provider configuration is already active for this installation"
                    .to_string(),
            );
        }
        state
            .provider_applications
            .push(ProviderApplicationReservation {
                token: token.to_string(),
                runtime_product_id,
                installation_id,
                runtime_connection_id,
            });
        Ok(())
    }

    pub(crate) fn end_provider_application(&self, token: &str) -> Result<(), String> {
        validate_provider_application_token(token)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        state
            .provider_applications
            .retain(|application| application.token != token);
        Ok(())
    }

    pub(crate) fn observe_codex_turn(
        &self,
        id: &HostTurnId,
        generation: u64,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable")?;
        let turn = state
            .active_turns
            .iter_mut()
            .find(|turn| {
                &turn.turn_id == id
                    && turn.runtime_generation == generation
                    && turn.runtime_product_id.as_str() == "codex"
            })
            .ok_or("Codex native observation has no matching Host reservation")?;
        // A verified native Turn exists. This neither settles the task nor
        // clears uncertainty already established by a transport failure.
        turn.runtime_observed = true;
        Ok(())
    }

    /// Adapter-confirmed terminal state. Native turn identities and background
    /// execution checks remain inside the adapter; no command acknowledgement
    /// may call this method.
    pub(crate) fn settle_codex_turn(
        &self,
        id: &HostTurnId,
        generation: u64,
        reason: &str,
    ) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable")?;
        let matches = state.active_turns.iter().any(|t| {
            &t.turn_id == id
                && t.runtime_generation == generation
                && t.runtime_product_id.as_str() == "codex"
        });
        drop(state);
        if !matches {
            return Ok(());
        }
        if let Some(store) = self.host_store()? {
            finish_capture(&store, id, reason)?;
        }
        self.finish(id, Some(generation))?;
        Ok(())
    }

    pub(crate) fn cancel_submission(&self, turn_id: &HostTurnId) -> Result<bool, String> {
        let removed = self.finish(turn_id, None)?;
        if removed && let Some(store) = self.host_store()? {
            if let Err(error) = cancel_capture(&store, turn_id) {
                eprintln!("[farfold] cannot cancel Turn Changes capture: {error}");
            }
            if let Err(error) =
                lifemodel::finish_injection_for_turn(&store, turn_id, "submission_cancelled")
            {
                eprintln!("[farfold] cannot cancel LifeModel injection: {error}");
            }
        }
        Ok(removed)
    }

    fn bind_pi_prompt(&self, turn_id: &HostTurnId, request_id: &str) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        let turn = state
            .active_turns
            .iter_mut()
            .find(|turn| turn.turn_id == *turn_id)
            .ok_or_else(|| "Pi prompt reservation is no longer active".to_string())?;
        turn.pi_prompt_request_id = Some(request_id.to_string());
        Ok(())
    }

    pub(crate) fn unobserved_pi_prompt(
        &self,
        generation: u64,
        request_id: &str,
    ) -> Result<Option<ActiveHostTurn>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        Ok(state
            .active_turns
            .iter()
            .find(|turn| {
                turn.runtime_product_id.as_str() == PI_RUNTIME_PRODUCT_ID
                    && turn.runtime_generation == generation
                    && !turn.runtime_observed
                    && turn.pi_prompt_request_id.as_deref() == Some(request_id)
            })
            .cloned())
    }

    pub(crate) fn settle_handled_pi_prompt(
        &self,
        generation: u64,
        request_id: &str,
        native: &Value,
        clear_unused_context: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        // A successful prompt response is only preflight acknowledgement. It is
        // terminal only when the official native state confirms no run or queue.
        let Some(turn) = self.unobserved_pi_prompt(generation, request_id)? else {
            return Ok(false);
        };
        if native.get("sessionId").and_then(Value::as_str) != Some(turn.native_session_id.as_str())
            || native.get("isStreaming").and_then(Value::as_bool) != Some(false)
            || native.get("isCompacting").and_then(Value::as_bool) != Some(false)
            || native.get("pendingMessageCount").and_then(Value::as_u64) != Some(0)
        {
            return Ok(false);
        }
        clear_unused_context()?;
        if let Some(store) = self.host_store()? {
            finish_capture(&store, &turn.turn_id, "command_completed")?;
            lifemodel::finish_injection_for_turn(&store, &turn.turn_id, "command_completed")?;
        }
        self.finish(&turn.turn_id, Some(generation))
    }

    pub(crate) fn finish(
        &self,
        turn_id: &HostTurnId,
        runtime_generation: Option<u64>,
    ) -> Result<bool, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        let Some(index) = state.active_turns.iter().position(|turn| {
            turn.turn_id == *turn_id
                && runtime_generation.is_none_or(|generation| turn.runtime_generation == generation)
        }) else {
            return Ok(false);
        };
        state.active_turns.remove(index);
        Ok(true)
    }

    pub(crate) fn request_abort(
        &self,
        farfold_session_id: &FarfoldSessionId,
    ) -> Result<Option<ActiveHostTurn>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        let Some(turn) = state
            .active_turns
            .iter_mut()
            .find(|turn| turn.farfold_session_id == *farfold_session_id)
        else {
            return Ok(None);
        };
        turn.abort_requested = true;
        Ok(Some(turn.clone()))
    }

    pub(crate) fn active_for_session(
        &self,
        farfold_session_id: &FarfoldSessionId,
    ) -> Result<Option<ActiveHostTurn>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        Ok(state
            .active_turns
            .iter()
            .find(|turn| turn.farfold_session_id == *farfold_session_id)
            .cloned())
    }

    fn clear_abort_request(&self, turn_id: &HostTurnId) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        if let Some(turn) = state
            .active_turns
            .iter_mut()
            .find(|turn| turn.turn_id == *turn_id)
        {
            turn.abort_requested = false;
        }
        Ok(())
    }

    fn finish_matching(
        &self,
        event: &RoutedRuntimeEvent,
        native_session_id: Option<&str>,
        require_runtime_observed: bool,
        terminal_reason: &str,
    ) -> Result<usize, String> {
        let Some(generation) = event.runtime_generation() else {
            return Ok(0);
        };
        let state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        let completed = state
            .active_turns
            .iter()
            .filter(|turn| {
                turn.runtime_product_id.as_str() == event.runtime().product_id
                    && turn.installation_id.as_str() == event.runtime().installation_id
                    && turn.runtime_generation == generation
                    && native_session_id
                        .is_none_or(|native| turn.native_session_id.as_str() == native)
                    && (!require_runtime_observed || turn.runtime_observed)
                    && !(turn.runtime_product_id.as_str() == OPENCODE_RUNTIME_PRODUCT_ID
                        && turn.abort_requested)
            })
            .cloned()
            .collect::<Vec<_>>();
        drop(state);
        let store = self.host_store()?;
        for turn in &completed {
            if let Some(store) = &store {
                if let Err(error) = finish_capture(store, &turn.turn_id, terminal_reason) {
                    eprintln!("[farfold] cannot finish Turn Changes capture: {error}");
                }
                if let Err(error) =
                    lifemodel::finish_injection_for_turn(store, &turn.turn_id, terminal_reason)
                {
                    eprintln!("[farfold] cannot finish LifeModel injection: {error}");
                }
            }
            self.finish(&turn.turn_id, Some(generation))?;
        }
        Ok(completed.len())
    }

    fn cancel_matching(
        &self,
        event: &RoutedRuntimeEvent,
        native_session_id: Option<&str>,
    ) -> Result<usize, String> {
        let Some(generation) = event.runtime_generation() else {
            return Ok(0);
        };
        let state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        let cancelled = state
            .active_turns
            .iter()
            .filter(|turn| {
                turn.runtime_product_id.as_str() == event.runtime().product_id
                    && turn.installation_id.as_str() == event.runtime().installation_id
                    && turn.runtime_generation == generation
                    && native_session_id
                        .is_none_or(|native| turn.native_session_id.as_str() == native)
            })
            .map(|turn| turn.turn_id.clone())
            .collect::<Vec<_>>();
        drop(state);
        for turn_id in &cancelled {
            self.cancel_submission(turn_id)?;
        }
        Ok(cancelled.len())
    }

    fn mark_matching_observed(
        &self,
        event: &RoutedRuntimeEvent,
        native_session_id: Option<&str>,
    ) -> Result<(), String> {
        let Some(generation) = event.runtime_generation() else {
            return Ok(());
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        let observed = state
            .active_turns
            .iter_mut()
            .filter(|turn| {
                turn.runtime_product_id.as_str() == event.runtime().product_id
                    && turn.installation_id.as_str() == event.runtime().installation_id
                    && turn.runtime_generation == generation
                    && native_session_id
                        .is_none_or(|native| turn.native_session_id.as_str() == native)
            })
            .map(|turn| {
                turn.runtime_observed = true;
                if !turn.abort_requested {
                    turn.outcome_unknown = false;
                }
                turn.turn_id.clone()
            })
            .collect::<Vec<_>>();
        drop(state);
        if let Some(store) = self.host_store()? {
            for turn_id in observed {
                if let Err(error) = lifemodel::mark_injection_submission_accepted(&store, &turn_id)
                {
                    eprintln!("[farfold] cannot accept LifeModel injection submission: {error}");
                }
            }
        }
        Ok(())
    }

    fn clear_matching_abort_request(&self, event: &RoutedRuntimeEvent) -> Result<(), String> {
        let Some(generation) = event.runtime_generation() else {
            return Ok(());
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        for turn in state.active_turns.iter_mut().filter(|turn| {
            turn.runtime_product_id.as_str() == event.runtime().product_id
                && turn.installation_id.as_str() == event.runtime().installation_id
                && turn.runtime_generation == generation
        }) {
            turn.abort_requested = false;
        }
        Ok(())
    }

    pub(crate) fn apply(&self, event: &RoutedRuntimeEvent) -> Result<(), String> {
        let lifecycle_failed = event.kind() == "lifecycle"
            && matches!(
                event
                    .native_envelope()
                    .pointer("/payload/state")
                    .and_then(Value::as_str),
                Some("terminated" | "error")
            );
        if (event.runtime().product_id == OPENCODE_RUNTIME_PRODUCT_ID
            && matches!(event.kind(), "protocol_error" | "transport_error"))
            || (event.runtime().product_id == PI_RUNTIME_PRODUCT_ID
                && event.runtime().adapter_id == crate::pi_acp_interactions::PI_ACP_ADAPTER_ID
                && (lifecycle_failed
                    || matches!(event.kind(), "protocol_error" | "transport_error")))
            || (event.runtime().product_id == "codex"
                && (lifecycle_failed
                    || matches!(
                        event.kind(),
                        "protocol_error" | "transport_error" | "transport_gap"
                    )))
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Turn coordinator is unavailable")?;
            for turn in state.active_turns.iter_mut().filter(|turn| {
                turn.installation_id.as_str() == event.runtime().installation_id
                    && Some(turn.runtime_generation) == event.runtime_generation()
            }) {
                turn.outcome_unknown = true;
            }
            return Ok(());
        }
        if lifecycle_failed || matches!(event.kind(), "protocol_error" | "transport_error") {
            self.finish_matching(event, None, false, "runtime_failure")?;
            return Ok(());
        }

        match event.runtime().product_id.as_str() {
            PI_RUNTIME_PRODUCT_ID => {
                if event.kind() == "rpc" {
                    let payload = event.native_envelope().get("payload");
                    match payload
                        .and_then(|value| value.get("type"))
                        .and_then(Value::as_str)
                    {
                        Some("agent_start") => self.mark_matching_observed(event, None)?,
                        Some("agent_settled") => {
                            self.finish_matching(event, None, true, "completed")?;
                        }
                        Some("response")
                            if payload
                                .and_then(|value| value.get("success"))
                                .and_then(Value::as_bool)
                                == Some(false) =>
                        {
                            match payload
                                .and_then(|value| value.get("command"))
                                .and_then(Value::as_str)
                            {
                                Some("prompt") => {
                                    self.cancel_matching(event, None)?;
                                }
                                Some("abort") => self.clear_matching_abort_request(event)?,
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
            }
            OPENCODE_RUNTIME_PRODUCT_ID if event.kind() == "sse" => {
                let outer = event.native_envelope().get("payload");
                let native = outer.and_then(|payload| payload.get("payload").or(Some(payload)));
                let event_type = native
                    .and_then(|payload| payload.get("type"))
                    .and_then(Value::as_str);
                let properties = native.and_then(|payload| payload.get("properties"));
                let native_session_id = properties
                    .and_then(|value| value.get("sessionID"))
                    .and_then(Value::as_str);
                let status = properties
                    .and_then(|value| value.pointer("/status/type"))
                    .and_then(Value::as_str);
                if let Some(native_session_id) = native_session_id {
                    match (event_type, status) {
                        (Some("session.status"), Some("busy" | "retry")) => {
                            self.mark_matching_observed(event, Some(native_session_id))?;
                        }
                        (Some("session.status"), Some("idle")) | (Some("session.idle"), _) => {
                            self.finish_matching(
                                event,
                                Some(native_session_id),
                                true,
                                "completed",
                            )?;
                        }
                        // OpenCode also emits session.error for recoverable input
                        // reads. Only native activity can release this admission.
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(crate) fn mark_submission_unknown(&self, turn_id: &HostTurnId) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable")?;
        if let Some(turn) = state
            .active_turns
            .iter_mut()
            .find(|turn| turn.turn_id == *turn_id)
        {
            turn.outcome_unknown = true;
        }
        Ok(())
    }

    pub(crate) fn opencode_active_turn(
        &self,
        native_id: &str,
        generation: u64,
    ) -> Result<Option<ActiveHostTurn>, String> {
        Ok(self.snapshot()?.active_turns.into_iter().find(|turn| {
            turn.runtime_product_id.as_str() == OPENCODE_RUNTIME_PRODUCT_ID
                && turn.native_session_id.as_str() == native_id
                && turn.runtime_generation == generation
        }))
    }

    fn settle_verified_turn(&self, turn: &ActiveHostTurn, reason: &str) -> Result<(), String> {
        if let Some(store) = self.host_store()? {
            finish_capture(&store, &turn.turn_id, reason)?;
            lifemodel::finish_injection_for_turn(&store, &turn.turn_id, reason)?;
        }
        self.finish(&turn.turn_id, Some(turn.runtime_generation))?;
        Ok(())
    }

    // Caller reacquires the Host controller lock after the official status read.
    // Compare its prior turn token before applying idle: an unobserved HTTP request
    // may still be queued, and a newer task must not be settled by an older read.
    pub(crate) fn reconcile_opencode_activity(
        &self,
        before: Option<&ActiveHostTurn>,
        native_id: &str,
        generation: u64,
        busy: bool,
    ) -> Result<&'static str, String> {
        let current = self.opencode_active_turn(native_id, generation)?;
        if before.map(|turn| &turn.turn_id) != current.as_ref().map(|turn| &turn.turn_id) {
            return if current.is_none() {
                Ok("idle")
            } else {
                Err("OpenCode task changed during native status reconciliation".into())
            };
        }
        if current.as_ref().is_some_and(|turn| turn.abort_requested) {
            return Ok("unknown");
        }
        if !busy && let Some(turn) = before.filter(|turn| turn.runtime_observed) {
            self.settle_verified_turn(turn, "reconciled_idle")?;
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable")?;
        let active = state.active_turns.iter_mut().find(|turn| {
            turn.runtime_product_id.as_str() == OPENCODE_RUNTIME_PRODUCT_ID
                && turn.native_session_id.as_str() == native_id
                && turn.runtime_generation == generation
        });
        if let Some(turn) = active {
            turn.outcome_unknown = !busy;
            if busy {
                turn.runtime_observed = true;
                turn.outcome_unknown = false;
            }
            return Ok(if busy { "working" } else { "unknown" });
        }
        Ok(if busy { "working" } else { "idle" })
    }

    pub(crate) fn require_opencode_recovery(
        &self,
        session_id: &FarfoldSessionId,
        native_id: &NativeSessionId,
        generation: u64,
        turn_id: &HostTurnId,
    ) -> Result<ActiveHostTurn, String> {
        self.opencode_active_turn(native_id.as_str(), generation)?
            .filter(|turn| turn.farfold_session_id == *session_id && turn.turn_id == *turn_id)
            .ok_or_else(|| "恢复请求已失效或不属于当前 OpenCode 任务。".to_string())
    }

    pub(crate) fn require_bound_recovery(
        &self,
        target: &SessionOpenTarget,
        generation: u64,
        turn_id: &HostTurnId,
    ) -> Result<ActiveHostTurn, String> {
        self.active_for_session(&target.farfold_session_id)?
            .filter(|turn| {
                turn.turn_id == *turn_id
                    && turn.runtime_generation == generation
                    && turn.runtime_product_id == target.runtime_product_id
                    && turn.installation_id == target.installation_id
                    && turn.runtime_connection_id == target.connection_id
                    && turn.native_session_id == target.native_session_id
            })
            .ok_or_else(|| "恢复请求不属于当前绑定的 Host 任务".into())
    }

    pub(crate) fn finish_bound_recovery(&self, turn: &ActiveHostTurn) -> Result<(), String> {
        self.settle_verified_turn(turn, "runtime_terminated_result_unknown")
    }

    pub(crate) fn finish_opencode_recovery(&self, turn: &ActiveHostTurn) -> Result<(), String> {
        self.settle_verified_turn(turn, "runtime_terminated_result_unknown")
    }

    pub(crate) fn snapshot(&self) -> Result<TurnCoordinatorSnapshot, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        Ok(TurnCoordinatorSnapshot {
            capacity: self.capacity,
            active_turns: state.active_turns.clone(),
            maintenance_active: state.maintenance_token.is_some(),
            provider_apply_active: !state.provider_applications.is_empty(),
        })
    }

    // The application is exiting. Let each native Runtime cancel its tools
    // before its server process is terminated. This does not mark a Turn as
    // completed: only the existing native events can establish its outcome.
    pub(crate) fn abort_for_shutdown(&self, pi: &PiRuntime, opencode: &OpenCodeRuntime) {
        let Ok(snapshot) = self.snapshot() else {
            return;
        };
        for turn in snapshot.active_turns {
            let result = (|| -> Result<(), String> {
                match turn.runtime_product_id.as_str() {
                    PI_RUNTIME_PRODUCT_ID => {
                        let native = pi_runtime::active_host_state(pi)?;
                        if pi_runtime::running_generation(pi)? != turn.runtime_generation
                            || native.get("sessionId").and_then(Value::as_str)
                                != Some(turn.native_session_id.as_str())
                        {
                            return Err("Pi shutdown binding changed".to_string());
                        }
                        self.request_abort(&turn.farfold_session_id)?;
                        pi_runtime::correlated_request(
                            pi,
                            PiCommand::Abort {
                                id: Some(pi_runtime::next_request_id(pi, "shutdown-abort")),
                            },
                            std::time::Duration::from_secs(5),
                        )?;
                    }
                    OPENCODE_RUNTIME_PRODUCT_ID => {
                        let connection = connection(opencode)?;
                        if connection.generation != turn.runtime_generation {
                            return Err("OpenCode shutdown generation changed".to_string());
                        }
                        self.request_abort(&turn.farfold_session_id)?;
                        if !abort_session(&connection, turn.native_session_id.as_str())? {
                            return Err("OpenCode did not confirm shutdown abort".to_string());
                        }
                    }
                    _ => return Err("Unknown shutdown Runtime".to_string()),
                }
                Ok(())
            })();
            if let Err(error) = result {
                eprintln!("[farfold] native shutdown abort failed: {error}");
            }
        }
    }

    pub(crate) fn require_runtime_idle(
        &self,
        runtime_product_id: &str,
        installation_id: &str,
    ) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        let active_ids = state
            .active_turns
            .iter()
            .filter(|turn| {
                turn.runtime_product_id.as_str() == runtime_product_id
                    && turn.installation_id.as_str() == installation_id
            })
            .map(|turn| turn.turn_id.as_str())
            .collect::<Vec<_>>();
        if active_ids.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Cannot stop Runtime while Host Turns are active: {}",
                active_ids.join(",")
            ))
        }
    }

    pub(crate) fn require_working_copy_idle(
        &self,
        working_copy_id: &WorkingCopyId,
    ) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        let active_ids = state
            .active_turns
            .iter()
            .filter(|turn| turn.working_copy_id == *working_copy_id)
            .map(|turn| turn.turn_id.as_str())
            .collect::<Vec<_>>();
        if active_ids.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Working Copy is occupied by active Host Turns: {}",
                active_ids.join(",")
            ))
        }
    }

    pub(crate) fn has_active_session(
        &self,
        farfold_session_id: &FarfoldSessionId,
    ) -> Result<bool, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        Ok(state
            .active_turns
            .iter()
            .any(|turn| turn.farfold_session_id == *farfold_session_id))
    }
}

pub(crate) fn require_opencode_target(
    store: &HostStore,
    input_session_id: &FarfoldSessionId,
    input_native_session_id: &NativeSessionId,
) -> Result<crate::host_store::session_open::SessionOpenTarget, String> {
    let target = store.session_open_target(input_session_id)?;
    require_openable(&target)?;
    if target.definition() != Some(OPENCODE_RUNTIME) {
        return Err("Farfold Session is not bound to the current OpenCode Adapter".to_string());
    }
    if target.native_session_id != *input_native_session_id {
        return Err("OpenCode native Session does not match the Host binding".to_string());
    }
    Ok(target)
}

fn require_opencode_acp_target(
    store: &HostStore,
    input_session_id: &FarfoldSessionId,
    input_native_session_id: &NativeSessionId,
) -> Result<crate::host_store::session_open::SessionOpenTarget, String> {
    let target = store.session_open_target(input_session_id)?;
    if !crate::opencode_acp::is_acp_binding(&target.binding()) {
        return Err("Farfold Session is not bound to the OpenCode ACP Adapter".to_string());
    }
    require_session_target(
        target
            .blockers()
            .into_iter()
            .filter(|blocker| {
                *blocker
                    != crate::host_store::session_open::SessionOpenBlocker::RuntimeBuildNotCurrent
            })
            .collect(),
    )?;
    if target.native_session_id != *input_native_session_id {
        return Err("OpenCode ACP native Session does not match the Host binding".to_string());
    }
    Ok(target)
}

fn require_pi_target(
    store: &HostStore,
    input_session_id: &FarfoldSessionId,
    input_native_session_id: &NativeSessionId,
) -> Result<crate::host_store::session_open::SessionOpenTarget, String> {
    let target = store.session_open_target(input_session_id)?;
    require_active_pi_target(&target)?;
    if target.native_session_id != *input_native_session_id {
        return Err("Pi native Session does not match the Host binding".to_string());
    }
    Ok(target)
}

#[tauri::command]
pub async fn host_opencode_acp_turn_submit(
    app: tauri::AppHandle,
    input: HostOpenCodeAcpTurnSubmitInput,
) -> Result<HostOpenCodeTurnSubmission, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let store = app.state::<HostStore>();
        let runtime = app.state::<crate::opencode_acp::OpenCodeAcpRuntime>();
        let coordinator = app.state::<TurnCoordinator>();
        host_opencode_acp_turn_submit_blocking(&controller, &store, &runtime, &coordinator, input)
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

fn acp_provider_verification(
    turn: &ActiveHostTurn,
    result: &Value,
) -> Result<Option<ProviderTargetProjectionInput>, String> {
    let (Some(provider_connection_id), Some(config_version_id), Some(provider), Some(model)) = (
        &turn.provider_connection_id,
        &turn.provider_config_version_id,
        &turn.runtime_provider_id,
        &turn.runtime_model_id,
    ) else {
        return Ok(None);
    };
    let Some(receipt) = result.pointer("/_meta/farfoldNativeProviderRequest") else {
        return Ok(None);
    };
    if receipt["sessionId"].as_str() != Some(turn.native_session_id.as_str())
        || receipt["runtimeProviderId"].as_str() != Some(provider.as_str())
        || receipt["runtimeModelId"].as_str() != Some(model.as_str())
        || receipt["completedAt"]
            .as_u64()
            .is_none_or(|time| time < turn.started_at)
        || !["assistantMessageId", "userMessageId"].iter().all(|key| {
            receipt[key]
                .as_str()
                .is_some_and(|id| id.starts_with("msg_") && id.len() <= 200)
        })
    {
        return Err("Native Provider receipt does not match this managed Turn".into());
    }
    Ok(Some(ProviderTargetProjectionInput {
        provider_connection_id: provider_connection_id.clone(),
        config_version_id: config_version_id.clone(),
        runtime_product_id: turn.runtime_product_id.clone(),
        installation_id: turn.installation_id.clone(),
        runtime_connection_id: turn.runtime_connection_id.clone(),
        runtime_provider_id: provider.clone(),
        runtime_model_id: model.clone(),
        save_state: ProviderSaveState::Saved,
        apply_state: ProviderApplyState::Applied,
        request_state: if result.get("farfoldNativeFailure").is_some() {
            ProviderRequestState::VerifiedFailure
        } else {
            ProviderRequestState::VerifiedSuccess
        },
        request_verified_version_id: Some(config_version_id.clone()),
        active_task_policy: ProviderActiveTaskPolicy::CurrentTaskKeepsBoundConfig,
        detail: Some(
            if result.get("farfoldNativeFailure").is_some() {
                "Fixed OpenCode native prompt confirmed failure for this Turn's Provider and model"
            } else {
                "Fixed OpenCode native prompt response confirmed this Turn's Provider and model"
            }
            .into(),
        ),
    }))
}

fn record_acp_provider_verification(
    store: &HostStore,
    turn: &ActiveHostTurn,
    result: &Value,
) -> Result<(), String> {
    if let Some(input) = acp_provider_verification(turn, result)? {
        record_current_provider_verification(store, &input)?;
    }
    Ok(())
}

fn record_current_provider_verification(
    store: &HostStore,
    input: &ProviderTargetProjectionInput,
) -> Result<(), String> {
    store
        .record_provider_request_verification_if_current(input)
        .map(|_| ())
}

fn pi_provider_verification(
    turn: &ActiveHostTurn,
    source: &crate::pi_acp::PiModelSource,
    response: &Result<Value, crate::acp_transport::AcpDispatchError>,
) -> Result<Option<ProviderTargetProjectionInput>, String> {
    let (provider, model, managed) = match source {
        crate::pi_acp::PiModelSource::ManagedVersion { binding } => {
            if turn.provider_connection_id.as_ref() != Some(&binding.provider_connection_id)
                || turn.provider_config_version_id.as_ref()
                    != Some(&binding.provider_config_version_id)
                || turn.runtime_provider_id.as_ref() != Some(&binding.runtime_provider_id)
                || turn.runtime_model_id.as_ref() != Some(&binding.runtime_model_id)
            {
                return Err("Pi 回执的托管来源与本轮接纳版本不一致".into());
            }
            (
                &binding.runtime_provider_id,
                &binding.runtime_model_id,
                Some(binding),
            )
        }
        crate::pi_acp::PiModelSource::NativeObservation {
            runtime_provider_id,
            runtime_model_id,
            native_model_id,
        } => {
            if turn.provider_connection_id.is_some()
                || turn.provider_config_version_id.is_some()
                || turn.runtime_provider_id.is_some()
                || turn.runtime_model_id.is_some()
                || runtime_provider_id.is_empty()
                || runtime_provider_id.len() > 200
                || runtime_provider_id.contains('/')
                || runtime_provider_id.starts_with("farfold-managed-")
                || native_model_id.is_empty()
                || runtime_model_id.len() > 512
                || *runtime_model_id != format!("{runtime_provider_id}/{native_model_id}")
            {
                return Err("Pi 原生回执来源无效或混入托管版本".into());
            }
            (runtime_provider_id, runtime_model_id, None)
        }
    };
    let Some(receipt) = crate::pi_acp::provider_request_receipt(response)? else {
        return Ok(None);
    };
    if receipt.host_turn_id != turn.turn_id
        || receipt.session_id != turn.native_session_id
        || receipt.runtime_provider_id != *provider
        || receipt.runtime_model_id != *model
        || receipt.native_timestamp < turn.started_at
    {
        return Err("Pi 原生 Provider 回执不属于本轮绑定的会话、模型或时间范围".into());
    }
    // A matching native result proves this observation's model, not a shared managed credential/version.
    let Some(binding) = managed else {
        return Ok(None);
    };
    let provider_connection_id = &binding.provider_connection_id;
    let config_version_id = &binding.provider_config_version_id;
    let failed = receipt.native_stop_reason == "error";
    Ok(Some(ProviderTargetProjectionInput {
        provider_connection_id: provider_connection_id.clone(), config_version_id: config_version_id.clone(),
        runtime_product_id: turn.runtime_product_id.clone(), installation_id: turn.installation_id.clone(),
        runtime_connection_id: turn.runtime_connection_id.clone(), runtime_provider_id: provider.clone(), runtime_model_id: model.clone(),
        save_state: ProviderSaveState::Saved, apply_state: ProviderApplyState::Applied,
        request_state: if failed { ProviderRequestState::VerifiedFailure } else { ProviderRequestState::VerifiedSuccess },
        request_verified_version_id: Some(config_version_id.clone()),
        active_task_policy: ProviderActiveTaskPolicy::CurrentTaskKeepsBoundConfig,
        detail: Some(if failed { "Fixed Pi native assistant result confirmed failure for this Turn's Provider and model" } else { "Fixed Pi native assistant result confirmed this Turn's Provider and model" }.into()),
    }))
}

pub(crate) fn host_opencode_acp_turn_submit_blocking(
    controller: &HostSessionController,
    store: &HostStore,
    runtime: &crate::opencode_acp::OpenCodeAcpRuntime,
    coordinator: &TurnCoordinator,
    input: HostOpenCodeAcpTurnSubmitInput,
) -> Result<HostOpenCodeTurnSubmission, String> {
    if input.text.len() > MAX_USER_PROMPT_BYTES {
        return Err(format!(
            "OpenCode ACP prompt exceeds the {MAX_USER_PROMPT_BYTES}-byte limit"
        ));
    }
    if input.text.trim().is_empty() {
        return Err("OpenCode ACP prompt cannot be empty".to_string());
    }
    let frontend_provider_claim = provider_binding(
        input.provider_connection_id.clone(),
        input.provider_config_version_id.clone(),
        input.runtime_provider_id.clone(),
        input.runtime_model_id.clone(),
    )?;
    let turn = controller.exclusive(|| {
        let target = require_opencode_acp_target(
            store,
            &input.farfold_session_id,
            &input.native_session_id,
        )?;
        let binding = target.binding();
        let (generation, managed_provider) =
            crate::opencode_acp::verify_active_session_with_managed_provider(
                runtime,
                &binding,
                &target.working_copy_path,
                &target.native_session_id,
            )?;
        let accepted_at = now_millis();
        let provider = managed_provider.map(|provider| {
            (
                provider.provider_connection_id,
                provider.provider_config_version_id,
                provider.runtime_provider_id,
                provider.runtime_model_id,
            )
        });
        match (&frontend_provider_claim, &provider) {
            (Some(claim), Some(active)) if claim != active => {
                return Err(
                    "OpenCode ACP Provider receipt does not match the active managed Runtime Session"
                        .to_string(),
                );
            }
            (Some(_), None) => {
                return Err(
                    "OpenCode ACP Provider receipt requires an active managed Runtime Session"
                        .to_string(),
                );
            }
            _ => {}
        }
        coordinator
            .admit(TurnAdmissionRequest {
                farfold_session_id: target.farfold_session_id.clone(),
                working_copy_id: target.working_copy_id.clone(),
                runtime_product_id: target.runtime_product_id.clone(),
                installation_id: target.installation_id.clone(),
                runtime_connection_id: target.connection_id.clone(),
                native_session_id: target.native_session_id.clone(),
                runtime_generation: generation,
                started_at: accepted_at,
                provider_connection_id: provider
                    .as_ref()
                    .map(|(connection_id, _, _, _)| connection_id.clone()),
                provider_config_version_id: provider
                    .as_ref()
                    .map(|(_, version_id, _, _)| version_id.clone()),
                runtime_provider_id: provider
                    .as_ref()
                    .map(|(_, _, provider_id, _)| provider_id.clone()),
                runtime_model_id: provider
                    .as_ref()
                    .map(|(_, _, _, model_id)| model_id.clone()),
                provider_binding_authority:
                    TurnProviderBindingAuthority::ActiveRuntimeSessionBinding,
            })
            .map_err(|rejection| rejection.to_string())
            .and_then(|turn| {
                if let Err(error) = persist_provider_turn_binding(store, &turn) {
                    let _ = coordinator.cancel_submission(&turn.turn_id);
                    return Err(error);
                }
                Ok((
                    turn,
                    accepted_at,
                    target.binding(),
                    target.working_copy_path.clone(),
                ))
            })
    })?;
    let (turn, accepted_at, binding, working_copy_path) = turn;
    let submitted = crate::opencode_acp::prompt_text(runtime, &turn.native_session_id, &input.text);
    match submitted {
        Ok(result) => {
            if result.get("stopReason").and_then(serde_json::Value::as_str) == Some("cancelled") {
                match crate::opencode_acp::verify_completed_session(
                    runtime,
                    &binding,
                    &working_copy_path,
                    &turn.native_session_id,
                ) {
                    Ok(current) if current == turn.runtime_generation => {
                        if let Err(detail) = coordinator.settle_verified_turn(&turn, "cancelled") {
                            coordinator.mark_submission_unknown(&turn.turn_id)?;
                            return Ok(HostOpenCodeTurnSubmission::Unknown { detail });
                        }
                    }
                    _ => {
                        coordinator.mark_submission_unknown(&turn.turn_id)?;
                        return Ok(HostOpenCodeTurnSubmission::Unknown {
                            detail: "OpenCode ACP prompt 已取消，但连接身份或 Host 资源终态未确认；不会自动重发。"
                                .to_string(),
                        });
                    }
                }
                return Ok(HostOpenCodeTurnSubmission::Cancelled {
                    detail: "OpenCode ACP prompt 已取消；不会自动重发。".to_string(),
                });
            }
            match crate::opencode_acp::verify_completed_session(
                runtime,
                &binding,
                &working_copy_path,
                &turn.native_session_id,
            ) {
                Ok(current) if current == turn.runtime_generation => {
                    if let Err(detail) = record_acp_provider_verification(store, &turn, &result)
                        .and_then(|()| {
                            coordinator.settle_verified_turn(&turn, "native_prompt_completed")
                        })
                    {
                        coordinator.mark_submission_unknown(&turn.turn_id)?;
                        return Ok(HostOpenCodeTurnSubmission::Unknown { detail });
                    }
                }
                _ => {
                    coordinator.mark_submission_unknown(&turn.turn_id)?;
                    return Ok(HostOpenCodeTurnSubmission::Unknown {
                        detail:
                            "OpenCode ACP prompt 已返回，但连接身份或 Host 资源终态未确认；不会自动重发。"
                                .to_string(),
                    });
                }
            }
            Ok(HostOpenCodeTurnSubmission::Accepted {
                submission: HostTurnSubmission {
                    turn_id: turn.turn_id,
                    accepted_at,
                },
            })
        }
        Err(crate::acp_transport::AcpDispatchError::Rejected {
            data: Some(result), ..
        }) if matches!(
            result["farfoldNativeFailure"].as_str(),
            Some("APIError" | "ProviderAuthError" | "ContextOverflowError")
        ) =>
        {
            let settled = crate::opencode_acp::verify_completed_session(
                runtime,
                &binding,
                &working_copy_path,
                &turn.native_session_id,
            )
            .and_then(|generation| {
                if generation != turn.runtime_generation {
                    return Err("Native failure belongs to a different Runtime generation".into());
                }
                if turn.provider_connection_id.is_some()
                    && acp_provider_verification(&turn, &result)?.is_none()
                {
                    return Err(
                        "Native failure omitted this managed Turn's Provider receipt".into(),
                    );
                }
                record_acp_provider_verification(store, &turn, &result)?;
                coordinator.settle_verified_turn(&turn, "native_prompt_failed")
            });
            if let Err(detail) = settled {
                coordinator.mark_submission_unknown(&turn.turn_id)?;
                return Ok(HostOpenCodeTurnSubmission::Unknown { detail });
            }
            Ok(HostOpenCodeTurnSubmission::Failed {
                detail: format!(
                    "OpenCode 已确认本轮失败（{}）；原生会话已保留，不会自动重发。",
                    result["farfoldNativeFailure"].as_str().unwrap()
                ),
            })
        }
        Err(crate::acp_transport::AcpDispatchError::Unknown(detail)) => {
            coordinator.mark_submission_unknown(&turn.turn_id)?;
            Ok(HostOpenCodeTurnSubmission::Unknown { detail })
        }
        Err(error) => match coordinator.cancel_submission(&turn.turn_id) {
            Ok(_) => Err(error.to_string()),
            Err(cleanup) => Err(format!(
                "{error}; Host Turn admission cleanup also failed: {cleanup}"
            )),
        },
    }
}

#[tauri::command]
pub async fn host_opencode_acp_turn_abort(
    app: tauri::AppHandle,
    input: HostOpenCodeAcpTurnAbortInput,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let store = app.state::<HostStore>();
        let runtime = app.state::<crate::opencode_acp::OpenCodeAcpRuntime>();
        let interactions = app.state::<crate::interaction_registry::InteractionRegistry>();
        let coordinator = app.state::<TurnCoordinator>();
        host_opencode_acp_turn_abort_blocking(
            &controller,
            &store,
            &runtime,
            &interactions,
            &coordinator,
            input,
        )
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

pub(crate) fn host_opencode_acp_turn_abort_blocking(
    controller: &HostSessionController,
    store: &HostStore,
    runtime: &crate::opencode_acp::OpenCodeAcpRuntime,
    interactions: &crate::interaction_registry::InteractionRegistry,
    coordinator: &TurnCoordinator,
    input: HostOpenCodeAcpTurnAbortInput,
) -> Result<bool, String> {
    let (active, binding) = controller.exclusive(|| {
        let target = require_opencode_acp_target(
            store,
            &input.farfold_session_id,
            &input.native_session_id,
        )?;
        let generation = crate::opencode_acp::verify_active_session(
            runtime,
            &target.binding(),
            &target.working_copy_path,
            &target.native_session_id,
        )?;
        if coordinator
            .active_for_session(&target.farfold_session_id)?
            .is_some_and(|turn| turn.abort_requested)
        {
            return Err("上一次停止请求仍未确认；请核对状态或终止自有 OpenCode ACP 进程。".into());
        }
        let active = coordinator
            .request_abort(&target.farfold_session_id)?
            .ok_or_else(|| "Host has no active Turn to abort for this Session".to_string())?;
        if active.runtime_generation != generation
            || active.native_session_id != target.native_session_id
        {
            coordinator.clear_abort_request(&active.turn_id)?;
            return Err("Active Host Turn does not match the current OpenCode ACP binding".into());
        }
        Ok((active, target.binding()))
    })?;
    let cancelled = crate::opencode_acp::cancel_session(runtime, &active.native_session_id);
    if cancelled.is_err() {
        coordinator.mark_submission_unknown(&active.turn_id)?;
    }
    let cancelled_permissions = cancelled.map_err(|error| error.to_string())?;
    for request_id in cancelled_permissions {
        let _ = interactions.finish_response(
            binding.clone(),
            active.runtime_generation,
            &request_id,
            true,
        );
    }
    Ok(true)
}

pub(crate) fn host_pi_acp_turn_submit_blocking(
    controller: &HostSessionController,
    store: &HostStore,
    runtime: &crate::pi_acp::PiAcpRuntime,
    router: &crate::runtime_event_router::RuntimeEventRouter,
    coordinator: &TurnCoordinator,
    interactions: &crate::interaction_registry::InteractionRegistry,
    input: HostPiAcpTurnSubmitInput,
) -> Result<HostNativeTurnSubmission, String> {
    if input.text.trim().is_empty() || input.text.len() > MAX_USER_PROMPT_BYTES {
        return Err("Pi ACP 任务文本为空或超过大小限制".into());
    }
    let observed_target = store.session_open_target(&input.farfold_session_id)?;
    require_session_target(observed_target.project_blockers())?;
    if !crate::pi_acp::is_acp_binding(&observed_target.binding())
        || observed_target.native_session_id != input.native_session_id
    {
        return Err("Pi ACP 任务与原生 Session 绑定不一致".into());
    }
    // Native reads may wait for RPC; never hold the shared controller while awaiting them.
    let observation = crate::pi_acp::capture_prompt_model(
        runtime,
        store,
        router,
        &observed_target,
        input.runtime_generation,
    )?;
    let (target, turn, dispatched) = controller.exclusive(|| {
        let target = store.session_open_target(&input.farfold_session_id)?;
        require_session_target(target.project_blockers())?;
        if !crate::pi_acp::is_acp_binding(&target.binding())
            || target.native_session_id != input.native_session_id
        {
            return Err("Pi ACP 任务与原生 Session 绑定不一致".into());
        }
        observation.verify_target(&target, input.runtime_generation)?;
        let current =
            crate::pi_acp::verify_prompt_target(runtime, &target, input.runtime_generation)?;
        if &current != observation.source() {
            return Err("Pi 模型来源在读取后发生变化；未接纳任务".into());
        }
        let provider = observation.source().managed_binding();
        let turn = coordinator
            .admit(TurnAdmissionRequest {
                farfold_session_id: target.farfold_session_id.clone(),
                working_copy_id: target.working_copy_id.clone(),
                runtime_product_id: target.runtime_product_id.clone(),
                installation_id: target.installation_id.clone(),
                runtime_connection_id: target.connection_id.clone(),
                native_session_id: target.native_session_id.clone(),
                runtime_generation: input.runtime_generation,
                started_at: now_millis(),
                provider_connection_id: provider
                    .map(|binding| binding.provider_connection_id.clone()),
                provider_config_version_id: provider
                    .map(|binding| binding.provider_config_version_id.clone()),
                runtime_provider_id: provider.map(|binding| binding.runtime_provider_id.clone()),
                runtime_model_id: provider.map(|binding| binding.runtime_model_id.clone()),
                provider_binding_authority:
                    TurnProviderBindingAuthority::ActiveRuntimeSessionBinding,
            })
            .map_err(|error| error.to_string())?;
        if let Err(error) = persist_pi_model_source(store, &target, &turn, &observation) {
            coordinator.cancel_submission(&turn.turn_id)?;
            return Err(error);
        }
        let dispatched = crate::pi_acp::begin_prompt_text(
            runtime,
            &target,
            turn.runtime_generation,
            &input.text,
            &turn.turn_id,
            &observation,
        );
        Ok((target, turn, dispatched))
    })?;
    let response = dispatched.and_then(|pending| pending.wait());
    let outcome = match &response {
        Ok(result) => match result.get("stopReason").and_then(Value::as_str) {
            Some("end_turn") => Some("native_prompt_completed"),
            Some("cancelled") => Some("cancelled"),
            _ => None,
        },
        Err(crate::acp_transport::AcpDispatchError::Rejected {
            data: Some(data), ..
        }) if data["farfoldOutcomeUnknown"] == false && data["nativeStopReason"] == "error" => {
            Some("native_prompt_failed")
        }
        Err(crate::acp_transport::AcpDispatchError::Rejected {
            code: -32600,
            data: Some(data),
        }) if data["farfoldPiPromptNotSent"] == true => {
            coordinator.cancel_submission(&turn.turn_id)?;
            return Err("Pi 原生派发前的模型或空闲状态校验未通过；本轮未发送，不会自动重发".into());
        }
        Err(crate::acp_transport::AcpDispatchError::NotSent(message)) => {
            coordinator.cancel_submission(&turn.turn_id)?;
            return Err((*message).into());
        }
        _ => None,
    };
    let Some(outcome) = outcome else {
        coordinator.mark_submission_unknown(&turn.turn_id)?;
        return Ok(HostNativeTurnSubmission::Unknown {
            detail: "Pi ACP 未返回可信的本轮终态；保留占用，不会自动重发".into(),
        });
    };
    if let Err(detail) = crate::pi_acp::verify_task_settled(
        runtime,
        store,
        router,
        &target,
        turn.runtime_generation,
        interactions,
        || {
            controller.exclusive(|| {
                crate::pi_acp::verify_task_target(runtime, &target, turn.runtime_generation)?;
                if coordinator
                    .active_for_session(&target.farfold_session_id)?
                    .is_none_or(|active| {
                        active.turn_id != turn.turn_id
                            || active.runtime_generation != turn.runtime_generation
                            || active.outcome_unknown
                    })
                {
                    return Err("Pi 本轮已被恢复流程结清；旧回执不更新当前任务或 Provider".into());
                }
                observation.verify_target(&target, turn.runtime_generation)?;
                if let Some(input) =
                    pi_provider_verification(&turn, observation.source(), &response)?
                {
                    crate::pi_acp::verify_provider_receipt_target(
                        runtime,
                        &target,
                        turn.runtime_generation,
                    )?;
                    record_current_provider_verification(store, &input)?;
                }
                coordinator.settle_verified_turn(&turn, outcome)
            })
        },
    ) {
        coordinator.mark_submission_unknown(&turn.turn_id)?;
        return Ok(HostNativeTurnSubmission::Unknown { detail });
    }
    Ok(match outcome {
        "cancelled" => HostNativeTurnSubmission::Cancelled {
            detail: "Pi 已确认停止本轮任务".into(),
        },
        "native_prompt_failed" => HostNativeTurnSubmission::Failed {
            detail: "Pi 已确认本轮失败，原生会话保留".into(),
        },
        _ => HostNativeTurnSubmission::Accepted {
            submission: HostTurnSubmission {
                turn_id: turn.turn_id,
                accepted_at: turn.started_at,
            },
        },
    })
}

#[tauri::command]
pub async fn host_pi_acp_turn_submit(
    app: tauri::AppHandle,
    input: HostPiAcpTurnSubmitInput,
) -> Result<HostNativeTurnSubmission, String> {
    tauri::async_runtime::spawn_blocking(move || {
        host_pi_acp_turn_submit_blocking(
            &app.state::<HostSessionController>(),
            &app.state::<HostStore>(),
            &app.state::<crate::pi_acp::PiAcpRuntime>(),
            &app.state::<crate::runtime_event_router::RuntimeEventRouter>(),
            &app.state::<TurnCoordinator>(),
            &app.state::<crate::interaction_registry::InteractionRegistry>(),
            input,
        )
    })
    .await
    .map_err(|_| "Pi ACP 任务提交被中断".to_string())?
}

#[tauri::command]
pub async fn host_pi_acp_turn_abort(
    app: tauri::AppHandle,
    input: HostPiAcpTurnAbortInput,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let store = app.state::<HostStore>();
        let runtime = app.state::<crate::pi_acp::PiAcpRuntime>();
        let coordinator = app.state::<TurnCoordinator>();
        host_pi_acp_turn_abort_blocking(
            &controller,
            &store,
            &runtime,
            &coordinator,
            &app.state::<crate::runtime_event_router::RuntimeEventRouter>(),
            &app.state::<crate::interaction_registry::InteractionRegistry>(),
            input,
        )
    })
    .await
    .map_err(|_| "Pi ACP 停止请求被中断".to_string())?
}

pub(crate) fn host_pi_acp_intervene_blocking(
    controller: &HostSessionController,
    store: &HostStore,
    runtime: &crate::pi_acp::PiAcpRuntime,
    coordinator: &TurnCoordinator,
    input: HostPiAcpInterventionInput,
) -> Result<HostPiAcpInterventionOutcome, String> {
    if input.message.trim().is_empty() || input.message.len() > 65_536 {
        return Err("Pi 插话为空或超过大小限制".into());
    }
    // Share the observation/settlement gate, but never hold the controller while
    // awaiting a native acknowledgement. Stop and explicit recovery remain usable.
    let gate = crate::pi_acp::settlement_gate(runtime)?;
    let _guard = gate.lock().map_err(|_| "Pi 结算锁不可用")?;
    let dispatched = controller.exclusive(|| {
        let target = store.session_open_target(&input.farfold_session_id)?;
        if target.native_session_id != input.native_session_id {
            return Err("Pi 插话原生会话不匹配".into());
        }
        crate::pi_acp::verify_task_target(runtime, &target, input.runtime_generation)?;
        let active = coordinator
            .active_for_session(&input.farfold_session_id)?
            .ok_or("Pi 当前没有可插话的任务")?;
        if active.turn_id != input.turn_id
            || active.runtime_generation != input.runtime_generation
            || active.native_session_id != input.native_session_id
            || active.abort_requested
            || active.outcome_unknown
        {
            return Err("Pi 插话属于旧任务或任务正在停止/结果未知".into());
        }
        Ok(crate::pi_acp::begin_intervention(
            runtime,
            &target,
            input.runtime_generation,
            input.kind,
            &input.message,
        ))
    })?;
    match dispatched.and_then(|pending| pending.wait_timeout(std::time::Duration::from_secs(15))) {
        Ok(result)
            if result["accepted"] == true
                && result["sessionId"].as_str() == Some(input.native_session_id.as_str())
                && result["delivery"].as_str() == Some(input.kind.delivery()) =>
        {
            Ok(HostPiAcpInterventionOutcome::Queued {
                delivery: input.kind,
            })
        }
        Err(crate::acp_transport::AcpDispatchError::NotSent(message)) => Err(message.into()),
        Err(crate::acp_transport::AcpDispatchError::Rejected { .. }) => {
            Err("Pi 已拒绝本次插话".into())
        }
        _ => {
            coordinator.mark_submission_unknown(&input.turn_id)?;
            Ok(HostPiAcpInterventionOutcome::Unknown {
                detail: "Pi 插话是否接收未确认；保留任务占用，不自动重发".into(),
            })
        }
    }
}

#[tauri::command]
pub async fn host_pi_acp_intervene(
    app: tauri::AppHandle,
    input: HostPiAcpInterventionInput,
) -> Result<HostPiAcpInterventionOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        host_pi_acp_intervene_blocking(
            &app.state::<HostSessionController>(),
            &app.state::<HostStore>(),
            &app.state::<crate::pi_acp::PiAcpRuntime>(),
            &app.state::<TurnCoordinator>(),
            input,
        )
    })
    .await
    .map_err(|_| "Pi 插话请求被中断".to_string())?
}

pub(crate) fn host_pi_acp_turn_abort_blocking(
    controller: &HostSessionController,
    store: &HostStore,
    runtime: &crate::pi_acp::PiAcpRuntime,
    coordinator: &TurnCoordinator,
    router: &crate::runtime_event_router::RuntimeEventRouter,
    _interactions: &crate::interaction_registry::InteractionRegistry,
    input: HostPiAcpTurnAbortInput,
) -> Result<bool, String> {
    let pending = controller.exclusive(|| {
        let target = store.session_open_target(&input.farfold_session_id)?;
        if target.native_session_id != input.native_session_id {
            return Err("Pi ACP 停止目标与会话不一致".into());
        }
        crate::pi_acp::verify_task_target(runtime, &target, input.runtime_generation)?;
        let active = coordinator
            .active_for_session(&input.farfold_session_id)?
            .ok_or("Pi ACP 当前没有可停止的任务")?;
        if active.runtime_generation != input.runtime_generation
            || active.native_session_id != input.native_session_id
            || active.turn_id != input.turn_id
        {
            return Err("Pi ACP 停止请求属于旧任务".into());
        }
        coordinator.request_abort(&input.farfold_session_id)?;
        // Keep validation and the bounded request write ordered with admission.
        // Wait for the capability ACK outside the controller, not for a terminal.
        let pending =
            crate::pi_acp::cancel_task(runtime, &target, input.runtime_generation, router);
        Ok(pending)
    })?;
    let result = pending.and_then(|pending| {
        pending
            .wait_timeout(std::time::Duration::from_secs(15))
            .map_err(|error| error.to_string())
    });
    match result {
        Ok(value)
            if value["version"] == 1
                && value["sessionId"].as_str() == Some(input.native_session_id.as_str())
                && value["outcome"] == "accepted" =>
        {
            Ok(true)
        }
        Ok(value)
            if value["version"] == 1
                && value["sessionId"].as_str() == Some(input.native_session_id.as_str())
                && value["outcome"] == "unsupported" =>
        {
            coordinator.clear_abort_request(&input.turn_id)?;
            Err("固定 Pi 0.84.3 不支持停止手动压缩；本次未取消，压缩继续运行".into())
        }
        _ => {
            coordinator.mark_submission_unknown(&input.turn_id)?;
            Err("Pi 停止请求是否接收未确认；保留任务状态，不自动重发".into())
        }
    }
}

#[tauri::command]
pub async fn host_pi_turn_submit(
    app: tauri::AppHandle,
    input: HostPiTurnSubmitInput,
) -> Result<HostTurnSubmission, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let store = app.state::<HostStore>();
        let runtime = app.state::<PiRuntime>();
        let coordinator = app.state::<TurnCoordinator>();
        controller.exclusive(|| {
            pi_runtime::validate_command_boundary(&input.command)?;
            if !input.command.is_turn_submission() {
                return Err(
                    "Host Pi Turn submit accepts only prompt, steer, or follow_up".to_string(),
                );
            }
            let target =
                require_pi_target(&store, &input.farfold_session_id, &input.native_session_id)?;
            let generation = match verify_pi_target(&runtime, &target) {
                Ok(generation) => generation,
                Err(error) => {
                    return Err(rejection_with_injection_cleanup(
                        &store,
                        &target,
                        input.life_model_manifest_id.as_deref(),
                        "runtime_verification_failed",
                        error,
                    ));
                }
            };
            let begins_turn = matches!(&input.command, PiCommand::Prompt { .. });
            let prompt_request_id = if let PiCommand::Prompt { id, .. } = &input.command {
                Some(
                    id.as_deref()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| "Pi prompt requires a correlated request ID".to_string())?
                        .to_string(),
                )
            } else {
                None
            };
            if !begins_turn && input.life_model_manifest_id.is_some() {
                return Err(rejection_with_injection_cleanup(
                    &store,
                    &target,
                    input.life_model_manifest_id.as_deref(),
                    "unsupported_pi_command",
                    "LifeModel injection can only accompany a new Pi prompt".to_string(),
                ));
            }
            let accepted_at = now_millis();
            let provider_binding = provider_binding(
                input.provider_connection_id,
                input.provider_config_version_id,
                input.runtime_provider_id,
                input.runtime_model_id,
            )?;
            let turn = if begins_turn {
                match coordinator.admit(TurnAdmissionRequest {
                    farfold_session_id: target.farfold_session_id.clone(),
                    working_copy_id: target.working_copy_id.clone(),
                    runtime_product_id: target.runtime_product_id.clone(),
                    installation_id: target.installation_id.clone(),
                    runtime_connection_id: target.connection_id.clone(),
                    native_session_id: target.native_session_id.clone(),
                    runtime_generation: generation,
                    started_at: accepted_at,
                    provider_connection_id: provider_binding
                        .as_ref()
                        .map(|binding| binding.0.clone()),
                    provider_config_version_id: provider_binding
                        .as_ref()
                        .map(|binding| binding.1.clone()),
                    runtime_provider_id: provider_binding.as_ref().map(|binding| binding.2.clone()),
                    runtime_model_id: provider_binding.as_ref().map(|binding| binding.3.clone()),
                    provider_binding_authority:
                        TurnProviderBindingAuthority::CurrentAppliedProjection,
                }) {
                    Ok(turn) => turn,
                    Err(rejection) => {
                        return Err(rejection_with_injection_cleanup(
                            &store,
                            &target,
                            input.life_model_manifest_id.as_deref(),
                            "turn_admission_rejected",
                            rejection.to_string(),
                        ));
                    }
                }
            } else {
                if provider_binding.is_some() {
                    return Err(
                        "Provider config binding can only accompany a new Host Turn".to_string()
                    );
                }
                let active = coordinator
                    .active_for_session(&target.farfold_session_id)?
                    .ok_or_else(|| "Pi steer/follow_up requires an active Host Turn".to_string())?;
                if active.runtime_generation != generation
                    || active.native_session_id != target.native_session_id
                {
                    return Err(
                        "Active Host Turn does not match the current Pi binding".to_string()
                    );
                }
                active
            };
            if let Some(request_id) = prompt_request_id {
                coordinator.bind_pi_prompt(&turn.turn_id, &request_id)?;
            }
            if begins_turn && let Err(error) = persist_provider_turn_binding(&store, &turn) {
                let _ = coordinator.cancel_submission(&turn.turn_id);
                return Err(error);
            }
            let injection = if begins_turn {
                match lifemodel::claim_injection_for_turn(
                    &store,
                    &target,
                    input.life_model_manifest_id.as_deref(),
                    &turn.turn_id,
                ) {
                    Ok(injection) => injection,
                    Err(error) => {
                        let _ = coordinator.cancel_submission(&turn.turn_id);
                        return Err(rejection_with_injection_cleanup(
                            &store,
                            &target,
                            input.life_model_manifest_id.as_deref(),
                            "manifest_claim_rejected",
                            error,
                        ));
                    }
                }
            } else {
                None
            };
            if let Some(injection) = &injection {
                let Some(argument) = injection.command_argument() else {
                    let _ = coordinator.cancel_submission(&turn.turn_id);
                    return Err("LifeModel did not prepare a Pi Extension argument".to_string());
                };
                let staged = pi_runtime::correlated_request(
                    &runtime,
                    PiCommand::Prompt {
                        id: Some(pi_runtime::next_request_id(&runtime, "lifemodel-stage")),
                        message: format!("/farfold-lifemodel-context {argument}"),
                    },
                    Duration::from_secs(5),
                );
                if let Err(error) = staged {
                    let _ = pi_runtime::correlated_request(
                        &runtime,
                        PiCommand::Prompt {
                            id: Some(pi_runtime::next_request_id(&runtime, "lifemodel-clear")),
                            message: "/farfold-lifemodel-clear".to_string(),
                        },
                        Duration::from_secs(5),
                    );
                    let _ = coordinator.cancel_submission(&turn.turn_id);
                    return Err(format!(
                        "LifeModel injection staging failed; user message was not sent: {error}"
                    ));
                }
            }
            let submitted = pi_runtime::send_command(&runtime, input.command);
            if let Err(error) = submitted {
                if begins_turn {
                    if injection.is_some() {
                        let _ = pi_runtime::correlated_request(
                            &runtime,
                            PiCommand::Prompt {
                                id: Some(pi_runtime::next_request_id(&runtime, "lifemodel-clear")),
                                message: "/farfold-lifemodel-clear".to_string(),
                            },
                            Duration::from_secs(5),
                        );
                    }
                    return match coordinator.cancel_submission(&turn.turn_id) {
                        Ok(_) => Err(error),
                        Err(cleanup) => Err(format!(
                            "{error}; Host Turn admission cleanup also failed: {cleanup}"
                        )),
                    };
                }
                return Err(error);
            }
            Ok(HostTurnSubmission {
                turn_id: turn.turn_id,
                accepted_at,
            })
        })
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[tauri::command]
pub async fn host_pi_turn_abort(
    app: tauri::AppHandle,
    input: HostPiTurnAbortInput,
) -> Result<HostTurnSubmission, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let store = app.state::<HostStore>();
        let runtime = app.state::<PiRuntime>();
        let coordinator = app.state::<TurnCoordinator>();
        controller.exclusive(|| {
            if !input.command.is_abort() {
                return Err("Host Pi Turn abort accepts only abort".to_string());
            }
            let target =
                require_pi_target(&store, &input.farfold_session_id, &input.native_session_id)?;
            let generation = verify_pi_target(&runtime, &target)?;
            let active = coordinator
                .request_abort(&target.farfold_session_id)?
                .ok_or_else(|| "Host has no active Turn to abort for this Session".to_string())?;
            if active.runtime_generation != generation
                || active.native_session_id != target.native_session_id
            {
                coordinator.clear_abort_request(&active.turn_id)?;
                return Err("Active Host Turn does not match the current Pi binding".to_string());
            }
            let submitted = pi_runtime::send_command(&runtime, input.command);
            if let Err(error) = submitted {
                coordinator.clear_abort_request(&active.turn_id)?;
                return Err(error);
            }
            Ok(HostTurnSubmission {
                turn_id: active.turn_id,
                accepted_at: now_millis(),
            })
        })
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[tauri::command]
pub async fn host_opencode_turn_submit(
    app: tauri::AppHandle,
    input: HostOpenCodeTurnSubmitInput,
) -> Result<HostOpenCodeTurnSubmission, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let store = app.state::<HostStore>();
        let runtime = app.state::<OpenCodeRuntime>();
        let coordinator = app.state::<TurnCoordinator>();
        controller.exclusive(|| {
            validate_opencode_submission(&input)?;
            let target = require_opencode_target(
                &store,
                &input.farfold_session_id,
                &input.native_session_id,
            )?;
            let generation = match verify_opencode_target(&runtime, &target) {
                Ok(generation) => generation,
                Err(error) => {
                    return Err(rejection_with_injection_cleanup(
                        &store,
                        &target,
                        input.life_model_manifest_id.as_deref(),
                        "runtime_verification_failed",
                        error,
                    ));
                }
            };
            let connection = match connection(&runtime) {
                Ok(connection) => connection,
                Err(error) => {
                    return Err(rejection_with_injection_cleanup(
                        &store,
                        &target,
                        input.life_model_manifest_id.as_deref(),
                        "runtime_connection_unavailable",
                        error,
                    ));
                }
            };
            if connection.generation != generation {
                return Err(rejection_with_injection_cleanup(
                    &store,
                    &target,
                    input.life_model_manifest_id.as_deref(),
                    "runtime_generation_changed",
                    "OpenCode connection changed during Turn admission".to_string(),
                ));
            }
            let accepted_at = now_millis();
            let provider_binding = provider_binding(
                input.provider_connection_id,
                input.provider_config_version_id,
                Some(input.provider_id.clone()),
                Some(input.model_id.clone()),
            )?;
            let turn = match coordinator.admit(TurnAdmissionRequest {
                farfold_session_id: target.farfold_session_id.clone(),
                working_copy_id: target.working_copy_id.clone(),
                runtime_product_id: target.runtime_product_id.clone(),
                installation_id: target.installation_id.clone(),
                runtime_connection_id: target.connection_id.clone(),
                native_session_id: target.native_session_id.clone(),
                runtime_generation: generation,
                started_at: accepted_at,
                provider_connection_id: provider_binding.as_ref().map(|binding| binding.0.clone()),
                provider_config_version_id: provider_binding
                    .as_ref()
                    .map(|binding| binding.1.clone()),
                runtime_provider_id: provider_binding.as_ref().map(|binding| binding.2.clone()),
                runtime_model_id: provider_binding.as_ref().map(|binding| binding.3.clone()),
                provider_binding_authority: TurnProviderBindingAuthority::CurrentAppliedProjection,
            }) {
                Ok(turn) => turn,
                Err(rejection) => {
                    return Err(rejection_with_injection_cleanup(
                        &store,
                        &target,
                        input.life_model_manifest_id.as_deref(),
                        "turn_admission_rejected",
                        rejection.to_string(),
                    ));
                }
            };
            if let Err(error) = persist_provider_turn_binding(&store, &turn) {
                let _ = coordinator.cancel_submission(&turn.turn_id);
                return Err(error);
            }
            let injection = match lifemodel::claim_injection_for_turn(
                &store,
                &target,
                input.life_model_manifest_id.as_deref(),
                &turn.turn_id,
            ) {
                Ok(injection) => injection,
                Err(error) => {
                    let _ = coordinator.cancel_submission(&turn.turn_id);
                    return Err(rejection_with_injection_cleanup(
                        &store,
                        &target,
                        input.life_model_manifest_id.as_deref(),
                        "manifest_claim_rejected",
                        error,
                    ));
                }
            };
            let submitted = prompt_text(
                &connection,
                turn.native_session_id.as_str(),
                &input.provider_id,
                &input.model_id,
                &input.text,
                injection.as_ref().map(|prepared| prepared.context_text()),
            );
            if let Ok(PromptDispatch::Unknown(detail)) = &submitted {
                coordinator.mark_submission_unknown(&turn.turn_id)?;
                return Ok(HostOpenCodeTurnSubmission::Unknown {
                    detail: detail.clone(),
                });
            }
            if let Err(error) = submitted {
                return match coordinator.cancel_submission(&turn.turn_id) {
                    Ok(_) => Err(error),
                    Err(cleanup) => Err(format!(
                        "{error}; Host Turn admission cleanup also failed: {cleanup}"
                    )),
                };
            }
            if injection.is_some()
                && let Err(error) =
                    lifemodel::mark_injection_submission_accepted(&store, &turn.turn_id)
            {
                eprintln!("[farfold] cannot accept OpenCode LifeModel submission: {error}");
            }
            Ok(HostOpenCodeTurnSubmission::Accepted {
                submission: HostTurnSubmission {
                    turn_id: turn.turn_id,
                    accepted_at,
                },
            })
        })
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[tauri::command]
pub async fn host_opencode_turn_abort(
    app: tauri::AppHandle,
    input: HostOpenCodeTurnAbortInput,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let store = app.state::<HostStore>();
        let runtime = app.state::<OpenCodeRuntime>();
        let coordinator = app.state::<TurnCoordinator>();
        let (connection, active) = controller.exclusive(|| {
            let target = require_opencode_target(
                &store,
                &input.farfold_session_id,
                &input.native_session_id,
            )?;
            let connection = connection(&runtime)?;
            if connection.project_path != target.working_copy_path {
                return Err("OpenCode Working Copy changed before Stop".into());
            }
            if coordinator
                .active_for_session(&target.farfold_session_id)?
                .is_some_and(|turn| turn.abort_requested)
            {
                return Err("上一次停止请求仍未确认；请核对状态或终止自有 OpenCode 进程。".into());
            }
            let active = coordinator
                .request_abort(&target.farfold_session_id)?
                .ok_or_else(|| "Host has no active Turn to abort for this Session".to_string())?;
            if active.runtime_generation != connection.generation
                || active.native_session_id != target.native_session_id
            {
                coordinator.clear_abort_request(&active.turn_id)?;
                return Err("Active Host Turn does not match the current OpenCode binding".into());
            }
            Ok((connection, active))
        })?;
        // Do not hold the lifecycle mutex across HTTP: an unresponsive server
        // must still be terminable. Its admission stays held until this request
        // is acknowledged (or its owned process exits), even if idle arrives.
        let aborted = abort_session(&connection, active.native_session_id.as_str());
        if aborted.is_ok() {
            coordinator.clear_abort_request(&active.turn_id)?;
        } else {
            coordinator.mark_submission_unknown(&active.turn_id)?;
        }
        aborted
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[tauri::command]
pub fn turn_coordinator_snapshot(
    coordinator: State<'_, TurnCoordinator>,
) -> Result<TurnCoordinatorSnapshot, String> {
    coordinator.snapshot()
}

#[cfg(test)]
mod tests {
    use super::{
        HostOpenCodeTurnSubmitInput, MAX_ACTIVE_TURNS, MAX_USER_PROMPT_BYTES, ProviderRequestState,
        TurnAdmissionBlocker, TurnAdmissionRejection, TurnAdmissionRequest, TurnCoordinator,
        acp_provider_verification, admission_conflicts, provider_binding,
        validate_opencode_submission,
    };
    use crate::host_ids::{
        AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId,
        ProviderConfigVersionId, ProviderConnectionId, RuntimeBuildId, RuntimeProductId,
        WorkingCopyId,
    };
    use crate::{
        host_store::provider_projection::TurnProviderBindingAuthority,
        runtime_event_router::RuntimeEventRouter,
        runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME, RuntimeBinding},
    };
    use serde_json::json;
    use std::sync::{Arc, Barrier};

    #[test]
    fn opencode_turn_boundary_rejects_unknown_fields_and_oversized_prompts() {
        let unknown = serde_json::from_value::<HostOpenCodeTurnSubmitInput>(json!({
            "farfoldSessionId": "session-1",
            "nativeSessionId": "ses_native",
            "providerId": "provider",
            "modelId": "model",
            "text": "hello",
            "lifeModelManifestId": null,
            "system": "attacker-controlled"
        }))
        .unwrap_err();
        assert!(unknown.to_string().contains("unknown field"));

        let oversized = HostOpenCodeTurnSubmitInput {
            farfold_session_id: FarfoldSessionId::parse("session-1").unwrap(),
            native_session_id: NativeSessionId::parse("ses_native").unwrap(),
            provider_id: "provider".to_string(),
            model_id: "model".to_string(),
            provider_connection_id: None,
            provider_config_version_id: None,
            text: "x".repeat(MAX_USER_PROMPT_BYTES + 1),
            life_model_manifest_id: None,
        };
        assert!(
            validate_opencode_submission(&oversized)
                .unwrap_err()
                .contains("exceeds")
        );
    }

    fn request(session: &str, working_copy: &str, started_at: u64) -> TurnAdmissionRequest {
        TurnAdmissionRequest {
            farfold_session_id: FarfoldSessionId::parse(session).unwrap(),
            working_copy_id: WorkingCopyId::parse(working_copy).unwrap(),
            runtime_product_id: RuntimeProductId::parse(PI_RUNTIME.product_id).unwrap(),
            installation_id: InstallationId::parse(PI_RUNTIME.installation_id).unwrap(),
            runtime_connection_id: ConnectionId::parse(PI_RUNTIME.default_connection_id).unwrap(),
            native_session_id: NativeSessionId::parse(format!("native-{session}")).unwrap(),
            runtime_generation: 4,
            started_at,
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
            provider_binding_authority: TurnProviderBindingAuthority::CurrentAppliedProjection,
        }
    }

    fn opencode_request(generation: u64) -> TurnAdmissionRequest {
        TurnAdmissionRequest {
            farfold_session_id: FarfoldSessionId::parse("session-1").unwrap(),
            working_copy_id: WorkingCopyId::parse("copy-1").unwrap(),
            runtime_product_id: RuntimeProductId::parse(OPENCODE_RUNTIME.product_id).unwrap(),
            installation_id: InstallationId::parse(OPENCODE_RUNTIME.installation_id).unwrap(),
            runtime_connection_id: ConnectionId::parse(OPENCODE_RUNTIME.default_connection_id)
                .unwrap(),
            native_session_id: NativeSessionId::parse("ses_1").unwrap(),
            runtime_generation: generation,
            started_at: 1,
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
            provider_binding_authority: TurnProviderBindingAuthority::CurrentAppliedProjection,
        }
    }

    fn system_opencode_binding() -> RuntimeBinding {
        RuntimeBinding {
            product_id: RuntimeProductId::parse(OPENCODE_RUNTIME.product_id).unwrap(),
            installation_id: InstallationId::parse("system-opencode-test-install").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("opencode-1.18.30-system-test").unwrap(),
            adapter_id: AdapterId::parse(OPENCODE_RUNTIME.adapter_id).unwrap(),
            connection_id: ConnectionId::parse("system-opencode-test-connection").unwrap(),
        }
    }

    fn system_opencode_request(generation: u64) -> TurnAdmissionRequest {
        let binding = system_opencode_binding();
        TurnAdmissionRequest {
            farfold_session_id: FarfoldSessionId::parse("system-session-1").unwrap(),
            working_copy_id: WorkingCopyId::parse("copy-1").unwrap(),
            runtime_product_id: binding.product_id,
            installation_id: binding.installation_id,
            runtime_connection_id: binding.connection_id,
            native_session_id: NativeSessionId::parse("ses_system_1").unwrap(),
            runtime_generation: generation,
            started_at: 1,
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
            provider_binding_authority: TurnProviderBindingAuthority::CurrentAppliedProjection,
        }
    }

    #[test]
    fn admits_two_independent_turns_and_rejects_the_application_third() {
        let coordinator = TurnCoordinator::default();
        let first = coordinator
            .admit(request("session-1", "copy-1", 1))
            .unwrap();
        coordinator
            .admit(request("session-2", "copy-2", 2))
            .unwrap();
        let rejection = coordinator
            .admit(request("session-3", "copy-3", 3))
            .unwrap_err();

        assert_eq!(MAX_ACTIVE_TURNS, 2);
        assert_eq!(
            rejection.blockers,
            vec![TurnAdmissionBlocker::ApplicationLimitReached]
        );
        assert!(rejection.conflicting_turn_ids.is_empty());
        assert_eq!(
            rejection
                .conflicting_sessions
                .iter()
                .map(|session| session.farfold_session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["session-1", "session-2"]
        );
        assert!(coordinator.cancel_submission(&first.turn_id).unwrap());
        assert_eq!(coordinator.snapshot().unwrap().active_turns.len(), 1);
    }

    #[test]
    fn provider_config_binding_requires_both_identity_parts() {
        assert!(provider_binding(None, None, None, None).unwrap().is_none());
        assert!(
            provider_binding(
                Some(ProviderConnectionId::parse("provider-zai-primary").unwrap()),
                None,
                Some("zai".to_string()),
                Some("glm-4.5-air".to_string()),
            )
            .unwrap_err()
            .contains("must be supplied together")
        );
    }

    #[test]
    fn acp_provider_receipt_must_match_this_native_turn_and_model() {
        let coordinator = TurnCoordinator::default();
        let mut input = opencode_request(1);
        input.provider_connection_id = Some(ProviderConnectionId::parse("provider-qa").unwrap());
        input.provider_config_version_id =
            Some(ProviderConfigVersionId::parse("version-qa").unwrap());
        input.runtime_provider_id = Some("provider-qa".into());
        input.runtime_model_id = Some("provider-qa/model-qa".into());
        let turn = coordinator.admit(input).unwrap();
        let response = json!({"stopReason":"end_turn","_meta":{"farfoldNativeProviderRequest":{
            "sessionId":"ses_1","assistantMessageId":"msg_answer","userMessageId":"msg_user",
            "runtimeProviderId":"provider-qa","runtimeModelId":"provider-qa/model-qa","completedAt":2
        }}});
        let verified = acp_provider_verification(&turn, &response)
            .unwrap()
            .unwrap();
        assert_eq!(
            verified.request_state,
            ProviderRequestState::VerifiedSuccess
        );
        assert_eq!(
            verified.config_version_id,
            turn.provider_config_version_id.clone().unwrap()
        );
        assert_eq!(verified.runtime_connection_id, turn.runtime_connection_id);
        let mut failed = response.clone();
        failed["farfoldNativeFailure"] = json!("APIError");
        assert_eq!(
            acp_provider_verification(&turn, &failed)
                .unwrap()
                .unwrap()
                .request_state,
            ProviderRequestState::VerifiedFailure
        );
        assert!(
            acp_provider_verification(&turn, &json!({"stopReason":"end_turn"}))
                .unwrap()
                .is_none()
        );
        for (field, value) in [
            ("sessionId", json!("ses_old")),
            ("runtimeProviderId", json!("wrong-provider")),
            ("runtimeModelId", json!("provider-qa/wrong-model")),
            ("completedAt", json!(0)),
            ("assistantMessageId", json!("")),
        ] {
            let mut wrong = response.clone();
            wrong["_meta"]["farfoldNativeProviderRequest"][field] = value;
            assert!(acp_provider_verification(&turn, &wrong).is_err(), "{field}");
        }
    }

    #[test]
    fn pi_provider_receipt_requires_this_host_turn_native_model_and_fresh_result() {
        use super::pi_provider_verification;
        use serde_json::Value;
        let coordinator = TurnCoordinator::default();
        let mut input = request("pi", "copy", 100);
        input.provider_connection_id = Some(ProviderConnectionId::parse("provider-qa").unwrap());
        input.provider_config_version_id =
            Some(ProviderConfigVersionId::parse("version-qa").unwrap());
        input.runtime_provider_id = Some("provider-qa".into());
        input.runtime_model_id = Some("provider-qa/model-qa".into());
        let turn = coordinator.admit(input).unwrap();
        let source = crate::pi_acp::PiModelSource::ManagedVersion {
            binding: crate::acp_provider_profile::ManagedAcpProviderBinding {
                provider_connection_id: turn.provider_connection_id.clone().unwrap(),
                provider_config_version_id: turn.provider_config_version_id.clone().unwrap(),
                runtime_provider_id: turn.runtime_provider_id.clone().unwrap(),
                runtime_model_id: turn.runtime_model_id.clone().unwrap(),
            },
        };
        let receipt = json!({"version":1,"hostTurnId":turn.turn_id,"sessionId":turn.native_session_id,
            "runtimeProviderId":"provider-qa","runtimeModelId":"provider-qa/model-qa","nativeModelId":"model-qa",
            "nativeTimestamp":110,"completedAt":120,"nativeStopReason":"stop"});
        let response = |receipt: Value| {
            Ok(json!({"stopReason":"end_turn","_meta":{"farfoldPiProviderRequest":receipt}}))
        };
        let verified = pi_provider_verification(&turn, &source, &response(receipt.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(
            verified.request_state,
            ProviderRequestState::VerifiedSuccess
        );
        assert_eq!(
            verified.request_verified_version_id,
            turn.provider_config_version_id
        );
        for (key, value) in [
            ("hostTurnId", json!("old-turn")),
            ("sessionId", json!("old-native")),
            ("runtimeProviderId", json!("other")),
            ("runtimeModelId", json!("other")),
            ("nativeModelId", json!("other")),
            ("version", json!(2)),
            ("nativeTimestamp", json!(99)),
            ("completedAt", json!(90)),
            ("nativeStopReason", json!("error")),
        ] {
            let mut wrong = receipt.clone();
            wrong[key] = value;
            assert!(
                pi_provider_verification(&turn, &source, &response(wrong)).is_err(),
                "accepted {key}"
            );
        }
        assert!(
            pi_provider_verification(&turn, &source, &Ok(json!({"stopReason":"end_turn"})))
                .unwrap()
                .is_none()
        );
        let mut failed = receipt;
        failed["nativeStopReason"] = json!("error");
        let failure = Err(crate::acp_transport::AcpDispatchError::Rejected {
            code: -32603,
            data: Some(
                json!({"farfoldOutcomeUnknown":false,"nativeStopReason":"error","farfoldPiProviderRequest":failed}),
            ),
        });
        assert_eq!(
            pi_provider_verification(&turn, &source, &failure)
                .unwrap()
                .unwrap()
                .request_state,
            ProviderRequestState::VerifiedFailure
        );
    }

    #[test]
    fn pi_native_receipt_validates_observed_source_without_managed_projection() {
        use super::pi_provider_verification;
        use crate::pi_acp::PiModelSource;
        use serde_json::Value;
        let coordinator = TurnCoordinator::default();
        let turn = coordinator
            .admit(request("pi-native", "copy-native", 100))
            .unwrap();
        let source = PiModelSource::NativeObservation {
            runtime_provider_id: "native-provider".into(),
            runtime_model_id: "native-provider/native/model".into(),
            native_model_id: "native/model".into(),
        };
        let receipt = json!({"version":1,"hostTurnId":turn.turn_id,"sessionId":turn.native_session_id,
            "runtimeProviderId":"native-provider","runtimeModelId":"native-provider/native/model","nativeModelId":"native/model",
            "nativeTimestamp":110,"completedAt":120,"nativeStopReason":"stop"});
        let response = |receipt: Value| {
            Ok(json!({"stopReason":"end_turn","_meta":{"farfoldPiProviderRequest":receipt}}))
        };
        assert!(
            pi_provider_verification(&turn, &source, &response(receipt.clone()))
                .unwrap()
                .is_none()
        );
        for (key, value) in [
            ("hostTurnId", json!("other-turn")),
            ("sessionId", json!("other-session")),
            ("runtimeProviderId", json!("other-provider")),
            ("runtimeModelId", json!("native-provider/other-model")),
            ("nativeModelId", json!("other-model")),
            ("nativeTimestamp", json!(99)),
            ("completedAt", json!(90)),
            ("nativeStopReason", json!("error")),
        ] {
            let mut wrong = receipt.clone();
            wrong[key] = value;
            assert!(
                pi_provider_verification(&turn, &source, &response(wrong)).is_err(),
                "{key}"
            );
        }
        let mut different = source.clone();
        if let PiModelSource::NativeObservation {
            runtime_provider_id,
            runtime_model_id,
            ..
        } = &mut different
        {
            *runtime_provider_id = "other-native".into();
            *runtime_model_id = "other-native/native/model".into();
        }
        assert!(pi_provider_verification(&turn, &different, &response(receipt.clone())).is_err());
        let mut contaminated = turn.clone();
        contaminated.provider_connection_id =
            Some(ProviderConnectionId::parse("managed-bootstrap").unwrap());
        assert!(
            pi_provider_verification(&contaminated, &source, &response(receipt.clone())).is_err()
        );
        let mut failed = receipt;
        failed["nativeStopReason"] = json!("error");
        let failure = Err(crate::acp_transport::AcpDispatchError::Rejected {
            code: -32603,
            data: Some(
                json!({"farfoldOutcomeUnknown":false,"nativeStopReason":"error","farfoldPiProviderRequest":failed}),
            ),
        });
        assert!(
            pi_provider_verification(&turn, &source, &failure)
                .unwrap()
                .is_none()
        );
        for response in [
            Ok(json!({"stopReason":"end_turn"})),
            Ok(json!({"stopReason":"cancelled"})),
        ] {
            assert!(
                pi_provider_verification(&turn, &source, &response)
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn pi_receipt_rejects_source_version_substitution_and_reserved_native_alias() {
        use super::pi_provider_verification;
        use crate::pi_acp::PiModelSource;
        let coordinator = TurnCoordinator::default();
        let mut input = request("pi-managed-source", "copy-managed-source", 100);
        input.provider_connection_id = Some(ProviderConnectionId::parse("provider").unwrap());
        input.provider_config_version_id = Some(ProviderConfigVersionId::parse("version").unwrap());
        input.runtime_provider_id = Some("provider".into());
        input.runtime_model_id = Some("provider/model".into());
        let turn = coordinator.admit(input).unwrap();
        let substituted = PiModelSource::ManagedVersion {
            binding: crate::acp_provider_profile::ManagedAcpProviderBinding {
                provider_connection_id: ProviderConnectionId::parse("provider").unwrap(),
                provider_config_version_id: ProviderConfigVersionId::parse("other-version")
                    .unwrap(),
                runtime_provider_id: "provider".into(),
                runtime_model_id: "provider/model".into(),
            },
        };
        let no_receipt = Ok(json!({"stopReason":"end_turn"}));
        assert!(pi_provider_verification(&turn, &substituted, &no_receipt).is_err());
        let native_turn = coordinator
            .admit(request("pi-native-source", "copy-native-source", 100))
            .unwrap();
        for (provider, model, native) in [
            (
                "farfold-managed-reserved",
                "farfold-managed-reserved/model",
                "model",
            ),
            ("ambiguous/provider", "ambiguous/provider/model", "model"),
            ("native", "native/other", "model"),
            ("", "/model", "model"),
            ("native", "native/", ""),
        ] {
            let invalid = PiModelSource::NativeObservation {
                runtime_provider_id: provider.into(),
                runtime_model_id: model.into(),
                native_model_id: native.into(),
            };
            assert!(pi_provider_verification(&native_turn, &invalid, &no_receipt).is_err());
        }
    }

    #[test]
    fn admitted_turn_retains_the_bound_provider_config_version() {
        let coordinator = TurnCoordinator::default();
        let mut request = request("session-provider", "copy-provider", 1);
        request.provider_connection_id =
            Some(ProviderConnectionId::parse("provider-zai-primary").unwrap());
        request.provider_config_version_id =
            Some(ProviderConfigVersionId::parse("provider-version-123").unwrap());
        request.runtime_provider_id = Some("zai".to_string());
        request.runtime_model_id = Some("glm-4.5-air".to_string());

        let turn = coordinator.admit(request).unwrap();

        assert_eq!(
            turn.provider_connection_id.unwrap().as_str(),
            "provider-zai-primary"
        );
        assert_eq!(
            turn.provider_config_version_id.unwrap().as_str(),
            "provider-version-123"
        );
        assert_eq!(turn.runtime_provider_id.unwrap(), "zai");
        assert_eq!(turn.runtime_model_id.unwrap(), "glm-4.5-air");
    }

    #[test]
    fn maintenance_is_exclusive_and_blocks_new_turn_admission() {
        let coordinator = TurnCoordinator::default();
        let token = "a".repeat(64);
        coordinator.begin_maintenance(&token).unwrap();
        assert!(coordinator.snapshot().unwrap().maintenance_active);
        assert_eq!(
            coordinator
                .admit(request("session-1", "copy-1", 1))
                .unwrap_err()
                .blockers,
            vec![TurnAdmissionBlocker::HostMaintenance]
        );
        assert!(coordinator.begin_maintenance(&"b".repeat(64)).is_err());
        coordinator.end_maintenance(&token).unwrap();
        assert!(!coordinator.snapshot().unwrap().maintenance_active);
        assert!(coordinator.admit(request("session-1", "copy-1", 2)).is_ok());
    }

    #[test]
    fn session_and_working_copy_conflicts_are_explicit_and_deduplicated() {
        let coordinator = TurnCoordinator::default();
        let active = coordinator
            .admit(request("session-1", "copy-1", 1))
            .unwrap();

        let same_session = coordinator
            .admit(request("session-1", "copy-1", 2))
            .unwrap_err();
        assert_eq!(
            same_session.blockers,
            vec![
                TurnAdmissionBlocker::SessionBusy,
                TurnAdmissionBlocker::WorkingCopyOccupied,
            ]
        );
        assert_eq!(
            same_session.conflicting_turn_ids,
            vec![active.turn_id.clone()]
        );

        let same_copy = coordinator
            .admit(request("session-2", "copy-1", 3))
            .unwrap_err();
        assert_eq!(
            same_copy.blockers,
            vec![TurnAdmissionBlocker::WorkingCopyOccupied]
        );
        assert_eq!(same_copy.conflicting_turn_ids, vec![active.turn_id]);
        assert_eq!(same_copy.conflicting_sessions.len(), 1);
        assert_eq!(
            same_copy.conflicting_sessions[0]
                .farfold_session_id
                .as_str(),
            "session-1"
        );
    }

    #[test]
    fn admission_message_names_the_actual_occupant_without_exposing_turn_ids() {
        let coordinator = TurnCoordinator::default();
        let active = coordinator
            .admit(request("session-occupant", "shared-copy", 1))
            .unwrap();
        let mut rejection = coordinator
            .admit(request("session-rejected", "shared-copy", 2))
            .unwrap_err();
        rejection.conflicting_sessions =
            admission_conflicts(vec![active.clone(), active.clone()], |id| {
                assert_eq!(id.as_str(), "session-occupant");
                Some("文档整理".to_string())
            });
        assert_eq!(rejection.conflicting_sessions.len(), 1);
        assert_eq!(
            rejection.conflicting_sessions[0].installation_id,
            active.installation_id
        );
        let message = rejection.to_string();
        assert!(message.contains("工作目录已有任务"));
        assert!(message.contains("Pi「文档整理」"));
        assert!(!message.contains(active.turn_id.as_str()));
        assert!(!message.contains("session-rejected"));
    }

    #[test]
    fn admission_message_does_not_invent_a_title_or_default_an_unknown_runtime_to_pi() {
        let coordinator = TurnCoordinator::default();
        let mut input = request("session-other", "copy-other", 1);
        input.runtime_product_id = RuntimeProductId::parse("future-runtime").unwrap();
        let active = coordinator.admit(input).unwrap();
        let rejection = TurnAdmissionRejection {
            blockers: vec![TurnAdmissionBlocker::WorkingCopyOccupied],
            conflicting_turn_ids: vec![active.turn_id.clone()],
            conflicting_sessions: admission_conflicts(vec![active], |_| None),
        };
        let message = rejection.to_string();
        assert!(message.contains("future-runtime 对话（标题暂不可读取）"));
        assert!(!message.contains("Pi"));
        assert!(!message.contains("新对话"));
    }

    #[test]
    fn abort_request_keeps_occupancy_until_a_matching_terminal_observation() {
        let coordinator = TurnCoordinator::default();
        let active = coordinator
            .admit(request("session-1", "copy-1", 1))
            .unwrap();

        let aborting = coordinator
            .request_abort(&FarfoldSessionId::parse("session-1").unwrap())
            .unwrap()
            .unwrap();
        assert!(aborting.abort_requested);
        assert_eq!(coordinator.snapshot().unwrap().active_turns.len(), 1);
        assert!(!coordinator.finish(&active.turn_id, Some(3)).unwrap());
        assert!(coordinator.finish(&active.turn_id, Some(4)).unwrap());
        assert!(coordinator.snapshot().unwrap().active_turns.is_empty());
    }

    #[test]
    fn active_turn_blocks_runtime_stop_until_terminal_observation() {
        let coordinator = TurnCoordinator::default();
        let active = coordinator
            .admit(request("session-1", "copy-1", 1))
            .unwrap();

        let blocked =
            coordinator.require_runtime_idle(PI_RUNTIME.product_id, PI_RUNTIME.installation_id);
        assert!(blocked.unwrap_err().contains(active.turn_id.as_str()));
        let working_copy = WorkingCopyId::parse("copy-1").unwrap();
        assert!(
            coordinator
                .require_working_copy_idle(&working_copy)
                .unwrap_err()
                .contains(active.turn_id.as_str())
        );
        coordinator.finish(&active.turn_id, Some(4)).unwrap();
        assert!(
            coordinator
                .require_runtime_idle(PI_RUNTIME.product_id, PI_RUNTIME.installation_id)
                .is_ok()
        );
        assert!(coordinator.require_working_copy_idle(&working_copy).is_ok());
    }

    #[test]
    fn provider_application_blocks_matching_turn_admission_until_released() {
        let coordinator = TurnCoordinator::default();
        let request = request("session-provider-apply", "copy-provider-apply", 1);
        coordinator
            .begin_provider_application(
                "provider-apply-test",
                request.runtime_product_id.clone(),
                request.installation_id.clone(),
                request.runtime_connection_id.clone(),
            )
            .unwrap();
        let rejection = coordinator.admit(request.clone()).unwrap_err();
        assert!(
            rejection
                .blockers
                .contains(&TurnAdmissionBlocker::RuntimeProviderConfigurationBusy)
        );
        coordinator
            .end_provider_application("provider-apply-test")
            .unwrap();
        assert!(coordinator.admit(request).is_ok());
    }

    #[test]
    fn provider_application_rejects_overlapping_apply_for_same_connection() {
        let coordinator = TurnCoordinator::default();
        let request = request("session-provider-apply-2", "copy-provider-apply-2", 1);
        coordinator
            .begin_provider_application(
                "provider-apply-first",
                request.runtime_product_id.clone(),
                request.installation_id.clone(),
                request.runtime_connection_id.clone(),
            )
            .unwrap();
        let second = coordinator.begin_provider_application(
            "provider-apply-second",
            request.runtime_product_id.clone(),
            request.installation_id.clone(),
            request.runtime_connection_id.clone(),
        );
        assert!(second.unwrap_err().contains("already active"));
        coordinator
            .end_provider_application("provider-apply-first")
            .unwrap();
        assert!(
            coordinator
                .begin_provider_application(
                    "provider-apply-second",
                    request.runtime_product_id,
                    request.installation_id,
                    request.runtime_connection_id,
                )
                .is_ok()
        );
    }

    #[test]
    fn provider_application_rejects_active_operation_id_reuse() {
        let coordinator = TurnCoordinator::default();
        let request = request(
            "session-provider-apply-token",
            "copy-provider-apply-token",
            1,
        );
        coordinator
            .begin_provider_application(
                "provider-apply-token",
                request.runtime_product_id.clone(),
                request.installation_id.clone(),
                request.runtime_connection_id.clone(),
            )
            .unwrap();
        let mut other = system_opencode_binding();
        other.installation_id = InstallationId::parse("other-installation").unwrap();
        let reused = coordinator.begin_provider_application(
            "provider-apply-token",
            other.product_id,
            other.installation_id,
            other.connection_id,
        );
        assert!(reused.unwrap_err().contains("operation id"));
    }

    #[test]
    fn provider_application_blocks_same_installation_across_connections() {
        let coordinator = TurnCoordinator::default();
        let binding = system_opencode_binding();
        coordinator
            .begin_provider_application(
                "provider-apply-system-a",
                binding.product_id.clone(),
                binding.installation_id.clone(),
                ConnectionId::parse("system-connection-a").unwrap(),
            )
            .unwrap();
        let blocked = coordinator.begin_provider_application(
            "provider-apply-system-b",
            binding.product_id,
            binding.installation_id,
            ConnectionId::parse("system-connection-b").unwrap(),
        );
        assert!(blocked.unwrap_err().contains("installation"));
    }

    #[test]
    fn stale_provider_application_end_does_not_release_new_operation() {
        let coordinator = TurnCoordinator::default();
        let request = request(
            "session-provider-apply-stale",
            "copy-provider-apply-stale",
            1,
        );
        coordinator
            .begin_provider_application(
                "provider-apply-old",
                request.runtime_product_id.clone(),
                request.installation_id.clone(),
                request.runtime_connection_id.clone(),
            )
            .unwrap();
        coordinator
            .end_provider_application("provider-apply-old")
            .unwrap();
        coordinator
            .begin_provider_application(
                "provider-apply-new",
                request.runtime_product_id.clone(),
                request.installation_id.clone(),
                request.runtime_connection_id.clone(),
            )
            .unwrap();
        coordinator
            .end_provider_application("provider-apply-old")
            .unwrap();
        let rejection = coordinator.admit(request.clone()).unwrap_err();
        assert!(
            rejection
                .blockers
                .contains(&TurnAdmissionBlocker::RuntimeProviderConfigurationBusy)
        );
        coordinator
            .end_provider_application("provider-apply-new")
            .unwrap();
        assert!(coordinator.admit(request).is_ok());
    }

    #[test]
    fn concurrent_admission_never_exceeds_the_bound() {
        let coordinator = TurnCoordinator::default();
        let barrier = Arc::new(Barrier::new(4));
        let mut threads = Vec::new();
        for index in 0..3 {
            let coordinator = coordinator.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                coordinator
                    .admit(request(
                        &format!("session-{index}"),
                        &format!("copy-{index}"),
                        index,
                    ))
                    .is_ok()
            }));
        }
        barrier.wait();
        let admitted = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|admitted| *admitted)
            .count();

        assert_eq!(admitted, MAX_ACTIVE_TURNS);
        assert_eq!(
            coordinator.snapshot().unwrap().active_turns.len(),
            MAX_ACTIVE_TURNS
        );
    }

    #[test]
    fn routed_opencode_terminal_requires_matching_generation_and_observed_work() {
        let coordinator = TurnCoordinator::default();
        coordinator.admit(opencode_request(4)).unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            8,
            None,
            None,
            Some(coordinator.clone()),
        );

        router
            .route(
                OPENCODE_RUNTIME,
                json!({
                    "generation": 3,
                    "kind": "sse",
                    "payload": {
                        "payload": {
                            "type": "session.idle",
                            "properties": { "sessionID": "ses_1" }
                        }
                    }
                }),
            )
            .unwrap();
        assert_eq!(coordinator.snapshot().unwrap().active_turns.len(), 1);

        router
            .route(
                OPENCODE_RUNTIME,
                json!({
                    "generation": 4,
                    "kind": "sse",
                    "payload": {
                        "payload": {
                            "type": "session.idle",
                            "properties": { "sessionID": "ses_1" }
                        }
                    }
                }),
            )
            .unwrap();
        assert_eq!(coordinator.snapshot().unwrap().active_turns.len(), 1);

        router
            .route(
                OPENCODE_RUNTIME,
                json!({
                    "generation": 4,
                    "kind": "sse",
                    "payload": {
                        "payload": {
                            "type": "session.status",
                            "properties": {
                                "sessionID": "ses_1",
                                "status": { "type": "busy" }
                            }
                        }
                    }
                }),
            )
            .unwrap();
        assert!(coordinator.snapshot().unwrap().active_turns[0].runtime_observed);

        router
            .route(
                OPENCODE_RUNTIME,
                json!({
                    "generation": 4,
                    "kind": "sse",
                    "payload": {
                        "payload": {
                            "type": "session.status",
                            "properties": {
                                "sessionID": "ses_1",
                                "status": { "type": "idle" }
                            }
                        }
                    }
                }),
            )
            .unwrap();
        assert!(coordinator.snapshot().unwrap().active_turns.is_empty());
    }

    #[test]
    fn opencode_session_error_cannot_release_a_working_copy() {
        let coordinator = TurnCoordinator::default();
        coordinator.admit(opencode_request(4)).unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            8,
            None,
            None,
            Some(coordinator.clone()),
        );
        let route = |event_type: &str, properties: serde_json::Value| {
            router
                .route(
                    OPENCODE_RUNTIME,
                    json!({
                        "generation": 4, "kind": "sse",
                        "payload": {"payload": {"type": event_type, "properties": properties}}
                    }),
                )
                .unwrap();
        };
        // Native file-reference errors may precede busy; processing continues.
        route(
            "session.error",
            json!({"sessionID":"ses_1", "error":{"message":"Read failed"}}),
        );
        assert_eq!(coordinator.snapshot().unwrap().active_turns.len(), 1);
        assert!(coordinator.admit(request("other", "copy-1", 2)).is_err());
        route(
            "session.status",
            json!({"sessionID":"ses_1", "status":{"type":"busy"}}),
        );
        route(
            "session.error",
            json!({"sessionID":"ses_1", "error":{"message":"Tool diagnostic"}}),
        );
        assert!(
            coordinator
                .require_working_copy_idle(&WorkingCopyId::parse("copy-1").unwrap())
                .is_err()
        );
        route(
            "session.status",
            json!({"sessionID":"ses_1", "status":{"type":"idle"}}),
        );
        assert!(coordinator.snapshot().unwrap().active_turns.is_empty());
        assert!(coordinator.admit(request("other", "copy-1", 3)).is_ok());
    }

    #[test]
    fn routed_pi_settled_requires_agent_start_for_the_generation() {
        let coordinator = TurnCoordinator::default();
        coordinator
            .admit(request("session-1", "copy-1", 1))
            .unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            8,
            None,
            None,
            Some(coordinator.clone()),
        );

        router
            .route(
                PI_RUNTIME,
                json!({
                    "generation": 4,
                    "kind": "rpc",
                    "payload": { "type": "agent_settled" }
                }),
            )
            .unwrap();
        assert_eq!(coordinator.snapshot().unwrap().active_turns.len(), 1);

        router
            .route(
                PI_RUNTIME,
                json!({
                    "generation": 4,
                    "kind": "rpc",
                    "payload": { "type": "agent_start" }
                }),
            )
            .unwrap();
        router
            .route(
                PI_RUNTIME,
                json!({
                    "generation": 4,
                    "kind": "rpc",
                    "payload": { "type": "agent_settled" }
                }),
            )
            .unwrap();
        assert!(coordinator.snapshot().unwrap().active_turns.is_empty());
    }

    #[test]
    fn handled_pi_prompt_releases_only_its_acknowledged_idle_native_session() {
        let coordinator = TurnCoordinator::default();
        let turn = coordinator
            .admit(request("session-1", "copy-1", 1))
            .unwrap();
        coordinator
            .bind_pi_prompt(&turn.turn_id, "extension-1")
            .unwrap();
        let idle = json!({"sessionId":turn.native_session_id.as_str(),"isStreaming":false,"isCompacting":false,"pendingMessageCount":0});
        assert!(
            !coordinator
                .settle_handled_pi_prompt(3, "extension-1", &idle, || Ok(()))
                .unwrap()
        );
        assert!(
            !coordinator
                .settle_handled_pi_prompt(4, "old-request", &idle, || Ok(()))
                .unwrap()
        );
        for patch in [
            json!({"sessionId":"other"}),
            json!({"isStreaming":true}),
            json!({"isCompacting":true}),
            json!({"pendingMessageCount":1}),
        ] {
            let mut state = idle.clone();
            state
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(
                !coordinator
                    .settle_handled_pi_prompt(4, "extension-1", &state, || Ok(()))
                    .unwrap()
            );
        }
        assert!(
            coordinator
                .settle_handled_pi_prompt(4, "extension-1", &idle, || Ok(()))
                .unwrap()
        );
        assert!(coordinator.admit(request("session-1", "copy-1", 2)).is_ok());
        // A late acknowledgement cannot release the newer reservation.
        assert!(
            !coordinator
                .settle_handled_pi_prompt(4, "extension-1", &idle, || Ok(()))
                .unwrap()
        );
    }

    #[test]
    fn prompt_acknowledgement_never_settles_an_observed_agent_run() {
        let coordinator = TurnCoordinator::default();
        let turn = coordinator
            .admit(request("session-1", "copy-1", 1))
            .unwrap();
        coordinator
            .bind_pi_prompt(&turn.turn_id, "prompt-1")
            .unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            8,
            None,
            None,
            Some(coordinator.clone()),
        );
        router
            .route(
                PI_RUNTIME,
                json!({"generation":4,"kind":"rpc","payload":{"type":"agent_start"}}),
            )
            .unwrap();
        assert!(!coordinator.settle_handled_pi_prompt(4, "prompt-1", &json!({"sessionId":turn.native_session_id.as_str(),"isStreaming":false,"isCompacting":false,"pendingMessageCount":0}), || panic!("must not clear context for a running Agent")).unwrap());
        assert_eq!(coordinator.snapshot().unwrap().active_turns.len(), 1);
    }

    #[test]
    fn routed_pi_rpc_rejections_release_prompt_or_undo_abort_state() {
        let coordinator = TurnCoordinator::default();
        coordinator
            .admit(request("session-1", "copy-1", 1))
            .unwrap();
        coordinator
            .request_abort(&FarfoldSessionId::parse("session-1").unwrap())
            .unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            8,
            None,
            None,
            Some(coordinator.clone()),
        );

        router
            .route(
                PI_RUNTIME,
                json!({
                    "generation": 4,
                    "kind": "rpc",
                    "payload": {
                        "type": "response",
                        "command": "abort",
                        "success": false
                    }
                }),
            )
            .unwrap();
        let snapshot = coordinator.snapshot().unwrap();
        assert_eq!(snapshot.active_turns.len(), 1);
        assert!(!snapshot.active_turns[0].abort_requested);

        router
            .route(
                PI_RUNTIME,
                json!({
                    "generation": 4,
                    "kind": "rpc",
                    "payload": {
                        "type": "response",
                        "command": "prompt",
                        "success": false
                    }
                }),
            )
            .unwrap();
        assert!(coordinator.snapshot().unwrap().active_turns.is_empty());
    }

    #[test]
    fn native_idle_during_unacknowledged_abort_does_not_admit_a_replacement() {
        let coordinator = TurnCoordinator::default();
        let turn = coordinator.admit(opencode_request(4)).unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            8,
            None,
            None,
            Some(coordinator.clone()),
        );
        for status in ["busy", "idle"] {
            if status == "idle" {
                coordinator.request_abort(&turn.farfold_session_id).unwrap();
            }
            router.route(OPENCODE_RUNTIME, json!({"generation":4,"kind":"sse","payload":{"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":status}}}})).unwrap();
        }
        let pending = coordinator
            .opencode_active_turn("ses_1", 4)
            .unwrap()
            .unwrap();
        assert!(coordinator.admit(opencode_request(4)).is_err());
        assert_eq!(
            coordinator
                .reconcile_opencode_activity(Some(&pending), "ses_1", 4, false)
                .unwrap(),
            "unknown"
        );
        coordinator.clear_abort_request(&turn.turn_id).unwrap();
        let acknowledged = coordinator
            .opencode_active_turn("ses_1", 4)
            .unwrap()
            .unwrap();
        assert_eq!(
            coordinator
                .reconcile_opencode_activity(Some(&acknowledged), "ses_1", 4, false)
                .unwrap(),
            "idle"
        );
        assert!(coordinator.admit(opencode_request(4)).is_ok());
    }

    #[test]
    fn idle_reconciliation_does_not_release_an_unobserved_submission() {
        let coordinator = TurnCoordinator::default();
        let turn = coordinator.admit(opencode_request(4)).unwrap();
        coordinator.mark_submission_unknown(&turn.turn_id).unwrap();
        assert_eq!(
            coordinator
                .reconcile_opencode_activity(Some(&turn), turn.native_session_id.as_str(), 4, false)
                .unwrap(),
            "unknown"
        );
        assert!(coordinator.admit(opencode_request(4)).is_err());
        assert_eq!(
            coordinator
                .reconcile_opencode_activity(Some(&turn), turn.native_session_id.as_str(), 4, true)
                .unwrap(),
            "working"
        );
        let observed = coordinator
            .opencode_active_turn(turn.native_session_id.as_str(), 4)
            .unwrap()
            .unwrap();
        assert_eq!(
            coordinator
                .reconcile_opencode_activity(
                    Some(&observed),
                    turn.native_session_id.as_str(),
                    4,
                    false
                )
                .unwrap(),
            "idle"
        );
        assert!(coordinator.snapshot().unwrap().active_turns.is_empty());
    }

    #[test]
    fn system_opencode_turn_reconciles_with_its_installation_identity() {
        let coordinator = TurnCoordinator::default();
        let turn = coordinator.admit(system_opencode_request(8)).unwrap();
        assert_eq!(
            turn.installation_id.as_str(),
            "system-opencode-test-install"
        );

        assert!(
            coordinator
                .opencode_active_turn("ses_system_1", 8)
                .unwrap()
                .is_some()
        );
        assert!(
            coordinator
                .require_runtime_idle(
                    OPENCODE_RUNTIME.product_id,
                    OPENCODE_RUNTIME.installation_id
                )
                .is_ok()
        );
        assert!(
            coordinator
                .require_runtime_idle(OPENCODE_RUNTIME.product_id, "system-opencode-test-install")
                .is_err()
        );

        assert_eq!(
            coordinator
                .reconcile_opencode_activity(Some(&turn), "ses_system_1", 8, true)
                .unwrap(),
            "working"
        );
        let observed = coordinator
            .opencode_active_turn("ses_system_1", 8)
            .unwrap()
            .unwrap();
        assert_eq!(
            coordinator
                .reconcile_opencode_activity(Some(&observed), "ses_system_1", 8, false)
                .unwrap(),
            "idle"
        );
        assert!(coordinator.snapshot().unwrap().active_turns.is_empty());
    }

    #[test]
    fn system_opencode_routed_events_settle_only_matching_installation() {
        let coordinator = TurnCoordinator::default();
        coordinator.admit(system_opencode_request(8)).unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            8,
            None,
            None,
            Some(coordinator.clone()),
        );

        router
            .route(
                OPENCODE_RUNTIME,
                json!({"generation":8,"kind":"sse","payload":{"type":"session.idle","properties":{"sessionID":"ses_system_1"}}}),
            )
            .unwrap();
        assert_eq!(coordinator.snapshot().unwrap().active_turns.len(), 1);

        router
            .route(
                system_opencode_binding(),
                json!({"generation":8,"kind":"sse","payload":{"type":"session.status","properties":{"sessionID":"ses_system_1","status":{"type":"busy"}}}}),
            )
            .unwrap();
        router
            .route(
                system_opencode_binding(),
                json!({"generation":8,"kind":"sse","payload":{"type":"session.idle","properties":{"sessionID":"ses_system_1"}}}),
            )
            .unwrap();
        assert!(coordinator.snapshot().unwrap().active_turns.is_empty());
    }

    #[test]
    fn late_status_read_cannot_settle_or_mark_a_replacement_turn() {
        let coordinator = TurnCoordinator::default();
        let old = coordinator.admit(opencode_request(4)).unwrap();
        coordinator.finish_opencode_recovery(&old).unwrap();
        let new = coordinator.admit(opencode_request(4)).unwrap();
        assert!(
            coordinator
                .reconcile_opencode_activity(Some(&old), old.native_session_id.as_str(), 4, false)
                .is_err()
        );
        assert!(
            coordinator
                .reconcile_opencode_activity(Some(&old), old.native_session_id.as_str(), 4, true)
                .is_err()
        );
        let active = coordinator.snapshot().unwrap().active_turns;
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].turn_id, new.turn_id);
        assert!(!active[0].runtime_observed);
    }

    #[test]
    fn old_recovery_cannot_stop_a_new_turn_in_the_same_session_and_generation() {
        let coordinator = TurnCoordinator::default();
        let old = coordinator.admit(opencode_request(4)).unwrap();
        coordinator.finish_opencode_recovery(&old).unwrap();
        let new = coordinator.admit(opencode_request(4)).unwrap();
        assert!(
            coordinator
                .require_opencode_recovery(
                    &old.farfold_session_id,
                    &old.native_session_id,
                    4,
                    &old.turn_id
                )
                .is_err()
        );
        assert!(
            coordinator
                .require_opencode_recovery(
                    &new.farfold_session_id,
                    &new.native_session_id,
                    3,
                    &new.turn_id
                )
                .is_err()
        );
        assert!(
            coordinator
                .require_opencode_recovery(
                    &new.farfold_session_id,
                    &new.native_session_id,
                    4,
                    &new.turn_id
                )
                .is_ok()
        );
        assert_eq!(coordinator.snapshot().unwrap().active_turns.len(), 1);
    }

    #[test]
    fn routed_transport_failure_keeps_the_working_copy_occupied() {
        let coordinator = TurnCoordinator::default();
        coordinator.admit(opencode_request(4)).unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            8,
            None,
            None,
            Some(coordinator.clone()),
        );

        router
            .route(
                OPENCODE_RUNTIME,
                json!({
                    "generation": 4,
                    "kind": "transport_error",
                    "payload": { "error": "connection lost" }
                }),
            )
            .unwrap();

        let active = coordinator.snapshot().unwrap().active_turns;
        assert_eq!(active.len(), 1);
        assert!(active[0].outcome_unknown);
        assert!(coordinator.admit(opencode_request(4)).is_err());
        let other_runtime = coordinator
            .admit(request("pi-other", "copy-1", 2))
            .unwrap_err();
        assert!(
            other_runtime
                .blockers
                .contains(&TurnAdmissionBlocker::WorkingCopyOccupied)
        );
        assert!(
            coordinator
                .require_runtime_idle(
                    OPENCODE_RUNTIME.product_id,
                    OPENCODE_RUNTIME.installation_id
                )
                .is_err()
        );
        router.route(OPENCODE_RUNTIME, json!({"generation": 3, "kind": "sse", "payload": {"type": "session.idle", "properties": {"sessionID": active[0].native_session_id}}})).unwrap();
        assert_eq!(coordinator.snapshot().unwrap().active_turns.len(), 1);
    }
}
