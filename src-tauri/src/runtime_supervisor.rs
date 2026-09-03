use serde::Serialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};

use crate::{
    interaction_registry::InteractionRegistry,
    opencode_runtime::{self, OpenCodeRuntime, OpenCodeRuntimeStatus, OpenCodeStartOptions},
    pi_runtime::{self, PiRuntime, RuntimeStatus, StartOptions},
    runtime_registry::{
        ManagedRuntimeDefinition, ManagedRuntimeKey, OPENCODE_RUNTIME, PI_RUNTIME, RuntimeIdentity,
    },
    session_controller::HostSessionController,
};

const CIRCUIT_FAILURE_LIMIT: u32 = 3;
const BASE_BACKOFF_MILLIS: u64 = 1_000;
const MAX_BACKOFF_MILLIS: u64 = 30_000;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SupervisorPhase {
    Stopped,
    Starting,
    Running,
    Stopping,
    Backoff,
    CircuitOpen,
}

#[derive(Debug, Clone)]
struct SupervisorSlot {
    generation: u64,
    phase: SupervisorPhase,
    consecutive_failures: u32,
    retry_not_before_ms: Option<u64>,
}

impl Default for SupervisorSlot {
    fn default() -> Self {
        Self {
            generation: 0,
            phase: SupervisorPhase::Stopped,
            consecutive_failures: 0,
            retry_not_before_ms: None,
        }
    }
}

impl SupervisorSlot {
    fn begin_start(&mut self, now_ms: u64) -> Result<u64, String> {
        if self.phase == SupervisorPhase::Backoff {
            if self.retry_not_before_ms.is_some_and(|retry| retry > now_ms) {
                return Err("Runtime restart is temporarily backed off".to_string());
            }
            self.phase = SupervisorPhase::Stopped;
            self.retry_not_before_ms = None;
        }
        match self.phase {
            SupervisorPhase::Stopped => {
                self.generation = self.generation.saturating_add(1);
                self.phase = SupervisorPhase::Starting;
                Ok(self.generation)
            }
            SupervisorPhase::CircuitOpen => {
                Err("Runtime restart circuit is open; an explicit reset is required".to_string())
            }
            SupervisorPhase::Starting | SupervisorPhase::Stopping => {
                Err("Runtime is already changing state".to_string())
            }
            SupervisorPhase::Running => Err("Runtime is already running".to_string()),
            SupervisorPhase::Backoff => unreachable!("expired backoff was normalized"),
        }
    }

    fn begin_stop(&mut self) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.phase = SupervisorPhase::Stopping;
        self.retry_not_before_ms = None;
        self.generation
    }

    fn complete_start(&mut self, generation: u64, succeeded: bool, now_ms: u64) {
        if self.generation != generation || self.phase != SupervisorPhase::Starting {
            return;
        }
        if succeeded {
            self.phase = SupervisorPhase::Running;
            self.consecutive_failures = 0;
            self.retry_not_before_ms = None;
        } else {
            self.record_failure(now_ms);
        }
    }

    fn complete_stop(&mut self, generation: u64, succeeded: bool, now_ms: u64) {
        if self.generation != generation || self.phase != SupervisorPhase::Stopping {
            return;
        }
        if succeeded {
            self.phase = SupervisorPhase::Stopped;
            self.consecutive_failures = 0;
            self.retry_not_before_ms = None;
        } else {
            self.record_failure(now_ms);
        }
    }

    fn record_failure(&mut self, now_ms: u64) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.consecutive_failures >= CIRCUIT_FAILURE_LIMIT {
            self.phase = SupervisorPhase::CircuitOpen;
            self.retry_not_before_ms = None;
            return;
        }
        let shift = self.consecutive_failures.saturating_sub(1).min(15);
        let delay = BASE_BACKOFF_MILLIS
            .saturating_mul(1_u64 << shift)
            .min(MAX_BACKOFF_MILLIS);
        self.phase = SupervisorPhase::Backoff;
        self.retry_not_before_ms = Some(now_ms.saturating_add(delay));
    }

    fn observe(&mut self, running: bool, now_ms: u64) {
        if running {
            self.phase = SupervisorPhase::Running;
            self.consecutive_failures = 0;
            self.retry_not_before_ms = None;
            return;
        }
        match self.phase {
            SupervisorPhase::Running => self.record_failure(now_ms),
            SupervisorPhase::Backoff
                if self
                    .retry_not_before_ms
                    .is_some_and(|retry| retry <= now_ms) =>
            {
                self.phase = SupervisorPhase::Stopped;
                self.retry_not_before_ms = None;
            }
            SupervisorPhase::Starting
            | SupervisorPhase::Stopping
            | SupervisorPhase::Stopped
            | SupervisorPhase::Backoff
            | SupervisorPhase::CircuitOpen => {}
        }
    }

    fn reset(&mut self, running: bool) {
        self.generation = self.generation.saturating_add(1);
        self.phase = if running {
            SupervisorPhase::Running
        } else {
            SupervisorPhase::Stopped
        };
        self.consecutive_failures = 0;
        self.retry_not_before_ms = None;
    }
}

#[derive(Default)]
pub struct RuntimeSupervisor {
    slots: Mutex<HashMap<&'static str, SupervisorSlot>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSupervisorSnapshot {
    runtime: RuntimeIdentity,
    runtime_build_id: &'static str,
    supervisor_generation: u64,
    phase: SupervisorPhase,
    process_running: bool,
    consecutive_failures: u32,
    retry_not_before_ms: Option<u64>,
}

impl RuntimeSupervisor {
    fn with_slot<T>(
        &self,
        definition: ManagedRuntimeDefinition,
        mutate: impl FnOnce(&mut SupervisorSlot) -> T,
    ) -> Result<T, String> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| "Runtime Supervisor state is unavailable".to_string())?;
        Ok(mutate(slots.entry(definition.installation_id).or_default()))
    }

    fn begin_start(
        &self,
        definition: ManagedRuntimeDefinition,
        now_ms: u64,
    ) -> Result<u64, String> {
        self.with_slot(definition, |slot| slot.begin_start(now_ms))?
    }

    fn complete_start(
        &self,
        definition: ManagedRuntimeDefinition,
        generation: u64,
        succeeded: bool,
        now_ms: u64,
    ) -> Result<(), String> {
        self.with_slot(definition, |slot| {
            slot.complete_start(generation, succeeded, now_ms)
        })
    }

    fn begin_stop(&self, definition: ManagedRuntimeDefinition) -> Result<u64, String> {
        self.with_slot(definition, SupervisorSlot::begin_stop)
    }

    fn complete_stop(
        &self,
        definition: ManagedRuntimeDefinition,
        generation: u64,
        succeeded: bool,
        now_ms: u64,
    ) -> Result<(), String> {
        self.with_slot(definition, |slot| {
            slot.complete_stop(generation, succeeded, now_ms)
        })
    }

    fn observe(
        &self,
        definition: ManagedRuntimeDefinition,
        running: bool,
        now_ms: u64,
    ) -> Result<(), String> {
        self.with_slot(definition, |slot| slot.observe(running, now_ms))
    }

    fn reset(&self, definition: ManagedRuntimeDefinition, running: bool) -> Result<(), String> {
        self.with_slot(definition, |slot| slot.reset(running))
    }

    fn snapshot(
        &self,
        definition: ManagedRuntimeDefinition,
        process_running: bool,
    ) -> Result<RuntimeSupervisorSnapshot, String> {
        self.with_slot(definition, |slot| RuntimeSupervisorSnapshot {
            runtime: definition.identity(),
            runtime_build_id: definition.runtime_build_id,
            supervisor_generation: slot.generation,
            phase: slot.phase,
            process_running,
            consecutive_failures: slot.consecutive_failures,
            retry_not_before_ms: slot.retry_not_before_ms,
        })
    }

    pub(crate) fn snapshots(
        &self,
        pi: &PiRuntime,
        opencode: &OpenCodeRuntime,
    ) -> Result<Vec<RuntimeSupervisorSnapshot>, String> {
        let now = now_millis();
        let pi_running = pi_runtime::is_running(pi)?;
        let opencode_running = opencode_runtime::is_running(opencode)?;
        self.observe(PI_RUNTIME, pi_running, now)?;
        self.observe(OPENCODE_RUNTIME, opencode_running, now)?;
        Ok(vec![
            self.snapshot(PI_RUNTIME, pi_running)?,
            self.snapshot(OPENCODE_RUNTIME, opencode_running)?,
        ])
    }
}

trait RuntimeAdapter {
    type StartOptions;
    type Status;

    fn definition(&self) -> ManagedRuntimeDefinition;
    fn is_running(&self) -> Result<bool, String>;
    fn start(&self, app: &AppHandle, options: Self::StartOptions) -> Result<Self::Status, String>;
    fn stop(&self, app: &AppHandle) -> Result<Self::Status, String>;
    fn status(&self, app: &AppHandle) -> Result<Self::Status, String>;
    fn status_is_running(status: &Self::Status) -> bool;
}

struct PiAdapter<'a> {
    runtime: &'a PiRuntime,
}

impl RuntimeAdapter for PiAdapter<'_> {
    type StartOptions = StartOptions;
    type Status = RuntimeStatus;

    fn definition(&self) -> ManagedRuntimeDefinition {
        PI_RUNTIME
    }

    fn is_running(&self) -> Result<bool, String> {
        pi_runtime::is_running(self.runtime)
    }

    fn start(&self, app: &AppHandle, options: Self::StartOptions) -> Result<Self::Status, String> {
        pi_runtime::pi_runtime_start(app.clone(), self.runtime, options)
    }

    fn stop(&self, app: &AppHandle) -> Result<Self::Status, String> {
        pi_runtime::pi_runtime_stop(app.clone(), self.runtime)
    }

    fn status(&self, app: &AppHandle) -> Result<Self::Status, String> {
        pi_runtime::pi_runtime_status(app.clone(), self.runtime)
    }

    fn status_is_running(status: &Self::Status) -> bool {
        status.is_running()
    }
}

struct OpenCodeAdapter<'a> {
    runtime: &'a OpenCodeRuntime,
}

impl RuntimeAdapter for OpenCodeAdapter<'_> {
    type StartOptions = OpenCodeStartOptions;
    type Status = OpenCodeRuntimeStatus;

    fn definition(&self) -> ManagedRuntimeDefinition {
        OPENCODE_RUNTIME
    }

    fn is_running(&self) -> Result<bool, String> {
        opencode_runtime::is_running(self.runtime)
    }

    fn start(&self, app: &AppHandle, options: Self::StartOptions) -> Result<Self::Status, String> {
        opencode_runtime::opencode_runtime_start(app.clone(), self.runtime, options)
    }

    fn stop(&self, _app: &AppHandle) -> Result<Self::Status, String> {
        opencode_runtime::opencode_runtime_stop(self.runtime)
    }

    fn status(&self, _app: &AppHandle) -> Result<Self::Status, String> {
        opencode_runtime::opencode_runtime_status(self.runtime)
    }

    fn status_is_running(status: &Self::Status) -> bool {
        status.is_running()
    }
}

fn supervised_start<A: RuntimeAdapter>(
    app: &AppHandle,
    supervisor: &RuntimeSupervisor,
    adapter: &A,
    options: A::StartOptions,
) -> Result<A::Status, String> {
    if adapter.is_running()? {
        supervisor.observe(adapter.definition(), true, now_millis())?;
        return adapter.status(app);
    }
    let generation = supervisor.begin_start(adapter.definition(), now_millis())?;
    let result = adapter.start(app, options);
    supervisor.complete_start(
        adapter.definition(),
        generation,
        result.is_ok(),
        now_millis(),
    )?;
    result
}

fn supervised_stop<A: RuntimeAdapter>(
    app: &AppHandle,
    supervisor: &RuntimeSupervisor,
    adapter: &A,
) -> Result<A::Status, String> {
    let generation = supervisor.begin_stop(adapter.definition())?;
    let result = adapter.stop(app);
    supervisor.complete_stop(
        adapter.definition(),
        generation,
        result.is_ok(),
        now_millis(),
    )?;
    result
}

fn supervised_status<A: RuntimeAdapter>(
    app: &AppHandle,
    supervisor: &RuntimeSupervisor,
    adapter: &A,
) -> Result<A::Status, String> {
    let status = adapter.status(app)?;
    supervisor.observe(
        adapter.definition(),
        A::status_is_running(&status),
        now_millis(),
    )?;
    Ok(status)
}

pub(crate) fn pi_start(
    app: AppHandle,
    supervisor: &RuntimeSupervisor,
    runtime: &PiRuntime,
    options: StartOptions,
) -> Result<RuntimeStatus, String> {
    supervised_start(&app, supervisor, &PiAdapter { runtime }, options)
}

pub(crate) fn pi_stop(
    app: AppHandle,
    supervisor: &RuntimeSupervisor,
    runtime: &PiRuntime,
) -> Result<RuntimeStatus, String> {
    supervised_stop(&app, supervisor, &PiAdapter { runtime })
}

pub(crate) fn pi_status(
    app: AppHandle,
    supervisor: &RuntimeSupervisor,
    runtime: &PiRuntime,
) -> Result<RuntimeStatus, String> {
    supervised_status(&app, supervisor, &PiAdapter { runtime })
}

pub(crate) fn opencode_start(
    app: &AppHandle,
    supervisor: &RuntimeSupervisor,
    runtime: &OpenCodeRuntime,
    options: OpenCodeStartOptions,
) -> Result<OpenCodeRuntimeStatus, String> {
    supervised_start(app, supervisor, &OpenCodeAdapter { runtime }, options)
}

pub(crate) fn opencode_stop(
    app: &AppHandle,
    supervisor: &RuntimeSupervisor,
    runtime: &OpenCodeRuntime,
) -> Result<OpenCodeRuntimeStatus, String> {
    supervised_stop(app, supervisor, &OpenCodeAdapter { runtime })
}

#[tauri::command]
pub fn opencode_runtime_start(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    supervisor: State<'_, RuntimeSupervisor>,
    runtime: State<'_, OpenCodeRuntime>,
    interactions: State<'_, InteractionRegistry>,
    options: OpenCodeStartOptions,
) -> Result<OpenCodeRuntimeStatus, String> {
    controller.exclusive(|| {
        let result = opencode_start(&app, &supervisor, &runtime, options);
        interactions.advance_generation(
            OPENCODE_RUNTIME,
            opencode_runtime::current_generation(&runtime),
        )?;
        result
    })
}

#[tauri::command]
pub fn opencode_runtime_stop(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    supervisor: State<'_, RuntimeSupervisor>,
    runtime: State<'_, OpenCodeRuntime>,
    interactions: State<'_, InteractionRegistry>,
) -> Result<OpenCodeRuntimeStatus, String> {
    controller.exclusive(|| {
        let result = opencode_stop(&app, &supervisor, &runtime);
        interactions.advance_generation(
            OPENCODE_RUNTIME,
            opencode_runtime::current_generation(&runtime),
        )?;
        result
    })
}

#[tauri::command]
pub fn opencode_runtime_status(
    app: AppHandle,
    supervisor: State<'_, RuntimeSupervisor>,
    runtime: State<'_, OpenCodeRuntime>,
    interactions: State<'_, InteractionRegistry>,
) -> Result<OpenCodeRuntimeStatus, String> {
    let result = supervised_status(&app, &supervisor, &OpenCodeAdapter { runtime: &runtime });
    interactions.advance_generation(
        OPENCODE_RUNTIME,
        opencode_runtime::current_generation(&runtime),
    )?;
    result
}

#[tauri::command]
pub fn runtime_supervisor_snapshot(
    supervisor: State<'_, RuntimeSupervisor>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
) -> Result<Vec<RuntimeSupervisorSnapshot>, String> {
    supervisor.snapshots(&pi, &opencode)
}

#[tauri::command]
pub fn runtime_supervisor_reset(
    supervisor: State<'_, RuntimeSupervisor>,
    runtime: ManagedRuntimeKey,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
) -> Result<RuntimeSupervisorSnapshot, String> {
    let running = match runtime {
        ManagedRuntimeKey::Pi => pi_runtime::is_running(&pi)?,
        ManagedRuntimeKey::Opencode => opencode_runtime::is_running(&opencode)?,
    };
    let definition = runtime.definition();
    supervisor.reset(definition, running)?;
    supervisor.snapshot(definition, running)
}

#[cfg(test)]
mod tests {
    use super::{SupervisorPhase, SupervisorSlot};

    #[test]
    fn failures_back_off_then_open_the_circuit() {
        let mut slot = SupervisorSlot::default();
        for attempt in 1_u64..=3 {
            let now = attempt * 10_000;
            let generation = slot.begin_start(now).unwrap();
            slot.complete_start(generation, false, now);
            if attempt < 3 {
                assert_eq!(slot.phase, SupervisorPhase::Backoff);
                assert!(slot.begin_start(now).is_err());
                let retry = slot.retry_not_before_ms.unwrap();
                assert!(slot.begin_start(retry).is_ok());
                slot.phase = SupervisorPhase::Stopped;
            }
        }
        assert_eq!(slot.phase, SupervisorPhase::CircuitOpen);
        assert!(slot.begin_start(100_000).is_err());
    }

    #[test]
    fn explicit_reset_recovers_a_circuit_without_claiming_a_process() {
        let mut slot = SupervisorSlot {
            phase: SupervisorPhase::CircuitOpen,
            consecutive_failures: 3,
            ..SupervisorSlot::default()
        };
        slot.reset(false);
        assert_eq!(slot.phase, SupervisorPhase::Stopped);
        assert_eq!(slot.consecutive_failures, 0);
    }

    #[test]
    fn stale_start_completion_cannot_overwrite_a_stop_generation() {
        let mut slot = SupervisorSlot::default();
        let start_generation = slot.begin_start(1_000).unwrap();
        let stop_generation = slot.begin_stop();
        slot.complete_start(start_generation, true, 1_001);
        assert_eq!(slot.phase, SupervisorPhase::Stopping);
        slot.complete_stop(stop_generation, true, 1_002);
        assert_eq!(slot.phase, SupervisorPhase::Stopped);
    }

    #[test]
    fn observing_an_unexpected_exit_enters_backoff() {
        let mut slot = SupervisorSlot::default();
        slot.observe(true, 1_000);
        slot.observe(false, 2_000);
        assert_eq!(slot.phase, SupervisorPhase::Backoff);
        assert_eq!(slot.consecutive_failures, 1);
    }
}
