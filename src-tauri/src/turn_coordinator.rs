use crate::host_ids::{
    FarfoldSessionId, HostTurnId, InstallationId, NativeSessionId, RuntimeProductId, WorkingCopyId,
};
use crate::{
    host_store::{
        HostStore,
        session_open::SessionOpenTarget,
        turn_changes::{TurnChangeCaptureInput, begin_capture, cancel_capture, finish_capture},
    },
    lifemodel,
    opencode_protocol::{abort_session, prompt_text},
    opencode_runtime::{OpenCodeRuntime, connection},
    pi_runtime::{self, PiCommand, PiRuntime},
    runtime_event_router::RoutedRuntimeEvent,
    runtime_registry::{OPENCODE_RUNTIME, OPENCODE_RUNTIME_PRODUCT_ID, PI_RUNTIME_PRODUCT_ID},
    session_controller::{
        HostSessionController, require_active_pi_target, require_openable, verify_opencode_target,
        verify_pi_target,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fmt,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;

pub const MAX_ACTIVE_TURNS: usize = 2;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveHostTurn {
    turn_id: HostTurnId,
    farfold_session_id: FarfoldSessionId,
    working_copy_id: WorkingCopyId,
    runtime_product_id: RuntimeProductId,
    installation_id: InstallationId,
    native_session_id: NativeSessionId,
    runtime_generation: u64,
    started_at: u64,
    runtime_observed: bool,
    abort_requested: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct TurnAdmissionRequest {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) working_copy_id: WorkingCopyId,
    pub(crate) runtime_product_id: RuntimeProductId,
    pub(crate) installation_id: InstallationId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) runtime_generation: u64,
    pub(crate) started_at: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnAdmissionBlocker {
    SessionBusy,
    WorkingCopyOccupied,
    ApplicationLimitReached,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnAdmissionRejection {
    blockers: Vec<TurnAdmissionBlocker>,
    conflicting_turn_ids: Vec<HostTurnId>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnCoordinatorSnapshot {
    capacity: usize,
    active_turns: Vec<ActiveHostTurn>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOpenCodeTurnSubmitInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    provider_id: String,
    model_id: String,
    text: String,
    life_model_manifest_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOpenCodeTurnAbortInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPiTurnSubmitInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    life_model_manifest_id: Option<String>,
    command: PiCommand,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPiTurnAbortInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    command: PiCommand,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostTurnSubmission {
    turn_id: HostTurnId,
    accepted_at: u64,
}

struct TurnCoordinatorState {
    next_turn_sequence: u64,
    active_turns: Vec<ActiveHostTurn>,
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
    fn as_str(self) -> &'static str {
        match self {
            Self::SessionBusy => "session_busy",
            Self::WorkingCopyOccupied => "working_copy_occupied",
            Self::ApplicationLimitReached => "application_limit_reached",
        }
    }
}

impl fmt::Display for TurnAdmissionRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let blockers = self
            .blockers
            .iter()
            .map(|blocker| blocker.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let conflicts = self
            .conflicting_turn_ids
            .iter()
            .map(HostTurnId::as_str)
            .collect::<Vec<_>>()
            .join(",");
        write!(
            formatter,
            "Host rejected Turn admission: blockers={blockers}; conflicting_turn_ids={conflicts}"
        )
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
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
            return Err(TurnAdmissionRejection {
                blockers,
                conflicting_turn_ids,
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
            native_session_id: request.native_session_id,
            runtime_generation: request.runtime_generation,
            started_at: request.started_at,
            runtime_observed: false,
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

    fn active_for_session(
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
                        (Some("session.error"), _) => {
                            self.finish_matching(
                                event,
                                Some(native_session_id),
                                false,
                                "runtime_error",
                            )?;
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(crate) fn snapshot(&self) -> Result<TurnCoordinatorSnapshot, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Turn coordinator is unavailable".to_string())?;
        Ok(TurnCoordinatorSnapshot {
            capacity: self.capacity,
            active_turns: state.active_turns.clone(),
        })
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
}

fn require_opencode_target(
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
pub fn host_pi_turn_submit(
    controller: State<'_, HostSessionController>,
    store: State<'_, HostStore>,
    runtime: State<'_, PiRuntime>,
    coordinator: State<'_, TurnCoordinator>,
    input: HostPiTurnSubmitInput,
) -> Result<HostTurnSubmission, String> {
    controller.exclusive(|| {
        if !input.command.is_turn_submission() {
            return Err("Host Pi Turn submit accepts only prompt, steer, or follow_up".to_string());
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
        let turn = if begins_turn {
            match coordinator.admit(TurnAdmissionRequest {
                farfold_session_id: target.farfold_session_id.clone(),
                working_copy_id: target.working_copy_id.clone(),
                runtime_product_id: target.runtime_product_id.clone(),
                installation_id: target.installation_id.clone(),
                native_session_id: target.native_session_id.clone(),
                runtime_generation: generation,
                started_at: accepted_at,
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
            let active = coordinator
                .active_for_session(&target.farfold_session_id)?
                .ok_or_else(|| "Pi steer/follow_up requires an active Host Turn".to_string())?;
            if active.runtime_generation != generation
                || active.native_session_id != target.native_session_id
            {
                return Err("Active Host Turn does not match the current Pi binding".to_string());
            }
            active
        };
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
}

#[tauri::command]
pub fn host_pi_turn_abort(
    controller: State<'_, HostSessionController>,
    store: State<'_, HostStore>,
    runtime: State<'_, PiRuntime>,
    coordinator: State<'_, TurnCoordinator>,
    input: HostPiTurnAbortInput,
) -> Result<HostTurnSubmission, String> {
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
}

#[tauri::command]
pub fn host_opencode_turn_submit(
    controller: State<'_, HostSessionController>,
    store: State<'_, HostStore>,
    runtime: State<'_, OpenCodeRuntime>,
    coordinator: State<'_, TurnCoordinator>,
    input: HostOpenCodeTurnSubmitInput,
) -> Result<HostTurnSubmission, String> {
    controller.exclusive(|| {
        let target =
            require_opencode_target(&store, &input.farfold_session_id, &input.native_session_id)?;
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
        let turn = match coordinator.admit(TurnAdmissionRequest {
            farfold_session_id: target.farfold_session_id.clone(),
            working_copy_id: target.working_copy_id.clone(),
            runtime_product_id: target.runtime_product_id.clone(),
            installation_id: target.installation_id.clone(),
            native_session_id: target.native_session_id.clone(),
            runtime_generation: generation,
            started_at: accepted_at,
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
        if let Err(error) = submitted {
            return match coordinator.cancel_submission(&turn.turn_id) {
                Ok(_) => Err(error),
                Err(cleanup) => Err(format!(
                    "{error}; Host Turn admission cleanup also failed: {cleanup}"
                )),
            };
        }
        if injection.is_some()
            && let Err(error) = lifemodel::mark_injection_submission_accepted(&store, &turn.turn_id)
        {
            eprintln!("[farfold] cannot accept OpenCode LifeModel submission: {error}");
        }
        Ok(HostTurnSubmission {
            turn_id: turn.turn_id,
            accepted_at,
        })
    })
}

#[tauri::command]
pub fn host_opencode_turn_abort(
    controller: State<'_, HostSessionController>,
    store: State<'_, HostStore>,
    runtime: State<'_, OpenCodeRuntime>,
    coordinator: State<'_, TurnCoordinator>,
    input: HostOpenCodeTurnAbortInput,
) -> Result<bool, String> {
    controller.exclusive(|| {
        let target =
            require_opencode_target(&store, &input.farfold_session_id, &input.native_session_id)?;
        let generation = verify_opencode_target(&runtime, &target)?;
        let active = coordinator
            .request_abort(&target.farfold_session_id)?
            .ok_or_else(|| "Host has no active Turn to abort for this Session".to_string())?;
        if active.runtime_generation != generation
            || active.native_session_id != target.native_session_id
        {
            coordinator.clear_abort_request(&active.turn_id)?;
            return Err("Active Host Turn does not match the current OpenCode binding".to_string());
        }
        let connection = connection(&runtime)?;
        if connection.generation != generation {
            coordinator.clear_abort_request(&active.turn_id)?;
            return Err("OpenCode connection changed during Turn abort".to_string());
        }
        let aborted = abort_session(&connection, target.native_session_id.as_str());
        if !matches!(aborted, Ok(true)) {
            coordinator.clear_abort_request(&active.turn_id)?;
        }
        aborted
    })
}

#[tauri::command]
pub fn turn_coordinator_snapshot(
    coordinator: State<'_, TurnCoordinator>,
) -> Result<TurnCoordinatorSnapshot, String> {
    coordinator.snapshot()
}

#[cfg(test)]
mod tests {
    use super::{MAX_ACTIVE_TURNS, TurnAdmissionBlocker, TurnAdmissionRequest, TurnCoordinator};
    use crate::host_ids::{
        FarfoldSessionId, InstallationId, NativeSessionId, RuntimeProductId, WorkingCopyId,
    };
    use crate::{
        runtime_event_router::RuntimeEventRouter,
        runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME},
    };
    use serde_json::json;
    use std::sync::{Arc, Barrier};

    fn request(session: &str, working_copy: &str, started_at: u64) -> TurnAdmissionRequest {
        TurnAdmissionRequest {
            farfold_session_id: FarfoldSessionId::parse(session).unwrap(),
            working_copy_id: WorkingCopyId::parse(working_copy).unwrap(),
            runtime_product_id: RuntimeProductId::parse(PI_RUNTIME.product_id).unwrap(),
            installation_id: InstallationId::parse(PI_RUNTIME.installation_id).unwrap(),
            native_session_id: NativeSessionId::parse(format!("native-{session}")).unwrap(),
            runtime_generation: 4,
            started_at,
        }
    }

    fn opencode_request(generation: u64) -> TurnAdmissionRequest {
        TurnAdmissionRequest {
            farfold_session_id: FarfoldSessionId::parse("session-1").unwrap(),
            working_copy_id: WorkingCopyId::parse("copy-1").unwrap(),
            runtime_product_id: RuntimeProductId::parse(OPENCODE_RUNTIME.product_id).unwrap(),
            installation_id: InstallationId::parse(OPENCODE_RUNTIME.installation_id).unwrap(),
            native_session_id: NativeSessionId::parse("ses_1").unwrap(),
            runtime_generation: generation,
            started_at: 1,
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
        assert!(coordinator.cancel_submission(&first.turn_id).unwrap());
        assert_eq!(coordinator.snapshot().unwrap().active_turns.len(), 1);
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
    fn routed_transport_failure_releases_the_generation_for_reconciliation() {
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

        assert!(coordinator.snapshot().unwrap().active_turns.is_empty());
    }
}
