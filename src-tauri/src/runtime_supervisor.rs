use serde::Serialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

use crate::runtime_registry::{RuntimeBinding, RuntimeIdentity};

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
    Running,
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
            SupervisorPhase::Stopped | SupervisorPhase::Backoff | SupervisorPhase::CircuitOpen => {}
        }
    }
}

#[derive(Default)]
pub struct RuntimeSupervisor {
    slots: Mutex<HashMap<crate::host_ids::InstallationId, SupervisorSlot>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSupervisorSnapshot {
    runtime: RuntimeIdentity,
    runtime_build_id: crate::host_ids::RuntimeBuildId,
    supervisor_generation: u64,
    phase: SupervisorPhase,
    process_running: bool,
    consecutive_failures: u32,
    retry_not_before_ms: Option<u64>,
}

impl RuntimeSupervisor {
    fn with_slot<T>(
        &self,
        definition: impl Into<RuntimeBinding>,
        mutate: impl FnOnce(&mut SupervisorSlot) -> T,
    ) -> Result<T, String> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| "Runtime Supervisor state is unavailable".to_string())?;
        Ok(mutate(
            slots.entry(definition.into().installation_id).or_default(),
        ))
    }

    fn observe(
        &self,
        definition: impl Into<RuntimeBinding>,
        running: bool,
        now_ms: u64,
    ) -> Result<(), String> {
        self.with_slot(definition, |slot| slot.observe(running, now_ms))
    }

    fn snapshot(
        &self,
        definition: impl Into<RuntimeBinding>,
        process_running: bool,
    ) -> Result<RuntimeSupervisorSnapshot, String> {
        let definition = definition.into();
        self.with_slot(definition.clone(), |slot| RuntimeSupervisorSnapshot {
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
        pi_acp: &crate::pi_acp::PiAcpRuntime,
        codex_acp: &crate::codex_acp::configure::Runtime,
    ) -> Result<Vec<RuntimeSupervisorSnapshot>, String> {
        let now = now_millis();
        let mut snapshots = Vec::new();
        // The owned ACP connection is the only live Runtime surface for each
        // product; a stopped connection reports no entry instead of synthetic
        // readiness.
        if let Some(binding) = pi_acp.current_binding()? {
            self.observe(binding.clone(), true, now)?;
            snapshots.push(self.snapshot(binding, true)?);
        }
        if let Some(binding) = codex_acp.current_binding()? {
            self.observe(binding.clone(), true, now)?;
            snapshots.push(self.snapshot(binding, true)?);
        }
        Ok(snapshots)
    }
}

#[tauri::command]
pub fn runtime_supervisor_snapshot(
    supervisor: State<'_, RuntimeSupervisor>,
    pi_acp: State<'_, crate::pi_acp::PiAcpRuntime>,
    codex: State<'_, crate::codex_acp::configure::Runtime>,
) -> Result<Vec<RuntimeSupervisorSnapshot>, String> {
    supervisor.snapshots(&pi_acp, &codex)
}

#[cfg(test)]
mod tests {
    use super::{SupervisorPhase, SupervisorSlot};

    #[test]
    fn observing_an_unexpected_exit_enters_backoff() {
        let mut slot = SupervisorSlot::default();
        slot.observe(true, 1_000);
        slot.observe(false, 2_000);
        assert_eq!(slot.phase, SupervisorPhase::Backoff);
        assert_eq!(slot.consecutive_failures, 1);
    }
}
