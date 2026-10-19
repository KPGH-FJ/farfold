//! Read-only test-build observation at existing executor failure branches.
//! No command/env/payload/path/security bytes, owner, retry or timing policy.
use std::io::Write;

pub(super) fn emit(
    phase: &'static str,
    original_child_pid: u32,
    original_child_exit_code: Option<i32>,
    try_wait_error: Option<i32>,
    group_not_confirmed_inactive: bool,
    preserved_stop_reason: Option<&'static str>,
) {
    let event = serde_json::json!({
        "phase": phase,
        "originalChildPid": original_child_pid,
        "originalChildExitCode": original_child_exit_code,
        "tryWaitError": try_wait_error,
        // Existing Job.active() treats a failed query as active. This boolean
        // therefore cannot prove any particular descendant actually survived.
        "groupNotConfirmedInactive": group_not_confirmed_inactive,
        "preservedStopReason": preserved_stop_reason,
    });
    // Only the test file writes this observation; failure cannot change the
    // original terminate/reap/result path. No additional OS query is issued.
    let _ = writeln!(
        std::io::stderr().lock(),
        "FARFOLD_WINDOWS_GIT_EARLY_SETTLEMENT {event}"
    );
}
