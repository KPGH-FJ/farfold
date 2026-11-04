//! Fixed test-case and checkout-key labels on the ORIGINAL Git executor.
//! No paths, argv, environment, output, new native queries or process control.
use std::{
    cell::RefCell,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::Instant,
};

const CASE: &str =
    "worktrees::tests::existing_branch_and_checkout_transforms_modes_links_are_preserved";
const COMMAND_LIMIT: u32 = 256;

#[derive(Default)]
pub(super) struct DebugEvents {
    received: u64,
    empty_waits: u64,
}
impl DebugEvents {
    pub(super) fn event_received(&mut self) {
        self.received = self.received.saturating_add(1);
    }
    pub(super) fn empty_wait(&mut self) {
        self.empty_waits = self.empty_waits.saturating_add(1);
    }
    pub(super) fn counts(&self) -> (u64, u64) {
        (self.received, self.empty_waits)
    }
}

#[derive(Clone, Copy)]
struct Classification {
    config_key: &'static str,
    boolean: bool,
}
pub(in crate::worktrees) struct Case {
    next_command: AtomicU32,
}
thread_local! {
    static CASE_SCOPE: RefCell<Option<Arc<Case>>> = const { RefCell::new(None) };
    static CLASSIFICATION: RefCell<Option<Classification>> = const { RefCell::new(None) };
}
pub(in crate::worktrees) struct CaseScope(Option<Arc<Case>>);
impl CaseScope {
    pub(in crate::worktrees) fn selected_create() -> Self {
        enter(Some(Arc::new(Case {
            next_command: AtomicU32::new(1),
        })))
    }
}
impl Drop for CaseScope {
    fn drop(&mut self) {
        CASE_SCOPE.with(|slot| *slot.borrow_mut() = self.0.take());
    }
}
pub(in crate::worktrees) fn capture() -> Option<Arc<Case>> {
    CASE_SCOPE.with(|slot| slot.borrow().clone())
}
pub(in crate::worktrees) fn enter(case: Option<Arc<Case>>) -> CaseScope {
    CaseScope(CASE_SCOPE.with(|slot| slot.replace(case)))
}
pub(in crate::worktrees) struct ConfigScope(Option<Classification>);
impl ConfigScope {
    pub(in crate::worktrees) fn new(config_key: &'static str, boolean: bool) -> Self {
        Self(CLASSIFICATION.with(|slot| {
            slot.replace(Some(Classification {
                config_key,
                boolean,
            }))
        }))
    }
}
impl Drop for ConfigScope {
    fn drop(&mut self) {
        CLASSIFICATION.with(|slot| *slot.borrow_mut() = self.0.take());
    }
}
pub(super) struct CommandObservation {
    command: Option<u32>,
    classification: Option<Classification>,
    started: Instant,
}
impl CommandObservation {
    pub(super) fn new() -> Self {
        let command = capture()
            .map(|case| case.next_command.fetch_add(1, Ordering::Relaxed))
            .filter(|id| *id <= COMMAND_LIMIT);
        Self {
            command,
            classification: CLASSIFICATION.with(|slot| *slot.borrow()),
            started: Instant::now(),
        }
    }
    pub(super) fn emit(
        &self,
        phase: &'static str,
        child: u32,
        exit_code: Option<i32>,
        stop_reason: Option<&'static str>,
    ) {
        let Some(command) = self.command else { return };
        eprintln!(
            "FARFOLD_WINDOWS_CREATE_GIT_COMMAND {}",
            serde_json::json!({
                "case": CASE,
                "processId": std::process::id(),
                "command": command,
                "originalChildPid": child,
                "phase": phase,
                "elapsedMs": self.started.elapsed().as_millis(),
                "classification": if self.classification.is_some() { "checkoutEffectiveConfig" } else { "otherFixedGit" },
                "configKey": self.classification.map(|value| value.config_key),
                "boolean": self.classification.map(|value| value.boolean),
                "originalChildExitCode": exit_code,
                "stopReason": stop_reason,
            })
        );
    }
    pub(super) fn enabled(&self) -> bool {
        self.command.is_some()
    }
    pub(super) fn emit_certificate(&self, child: u32, objects: serde_json::Value) {
        let Some(command) = self.command else { return };
        eprintln!(
            "FARFOLD_WINDOWS_CREATE_GIT_CERTIFICATE {}",
            serde_json::json!({
                "case": CASE,
                "processId": std::process::id(),
                "command": command,
                "originalChildPid": child,
                "certificateConfirmed": true,
                "objects": objects,
                "scope": "same successful complete-object certificate branch; owned state only; no extra native query",
            })
        );
    }
}

#[test]
fn case_and_config_scopes_restore_and_explicit_worker_context_shares_command_ids() {
    assert!(capture().is_none());
    let first = {
        let _case = CaseScope::selected_create();
        let _config = ConfigScope::new("core.autocrlf", false);
        let first = CommandObservation::new();
        assert_eq!(first.command, Some(1));
        assert_eq!(first.classification.unwrap().config_key, "core.autocrlf");
        let context = capture();
        std::thread::spawn(move || {
            assert!(capture().is_none());
            let _case = enter(context);
            let second = CommandObservation::new();
            assert_eq!(second.command, Some(2));
            assert!(second.classification.is_none());
        })
        .join()
        .unwrap();
        first
    };
    assert!(capture().is_none());
    assert!(CommandObservation::new().command.is_none());
    assert!(CLASSIFICATION.with(|slot| slot.borrow().is_none()));
    assert_eq!(first.command, Some(1));
}
