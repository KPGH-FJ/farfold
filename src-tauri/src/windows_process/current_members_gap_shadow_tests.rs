//! Bounded native challenge of a deliberately missed historical Job member.
//! The external exact target handle is evidence only, never a shadow authority.
use super::*;
use windows_sys::Win32::{
    Foundation::{GetLastError, WAIT_FAILED},
    System::JobObjects::IsProcessInJob,
};

#[test]
fn native_zero_empty_window_never_precedes_untracked_exact_target_signal() {
    const TRIALS: usize = 16;
    const WINDOW: Duration = Duration::from_millis(500);
    const MAX_SAMPLES: usize = 100_000;
    let directory = tempfile::tempdir().unwrap();
    let mut matched_windows = 0;
    let mut counterexamples = 0;
    let mut missed_windows = 0;
    let mut native_wait_errors = 0;
    for trial in 0..TRIALS {
        let marker = directory.path().join(format!("shadow-{trial}"));
        let mut owner = launch(&marker);
        // Open while the self-created target is waiting, prove membership in
        // THIS original Job, then retain that same object through every sample.
        let (pid, target) = descendant(&marker);
        let mut member = 0;
        assert_ne!(
            unsafe { IsProcessInJob(target.0, owner.group.job.handle.0, &mut member) },
            0,
            "{}",
            io::Error::last_os_error()
        );
        assert_ne!(member, 0);
        assert_eq!(unsafe { WaitForSingleObject(target.0, 0) }, WAIT_TIMEOUT);
        until(|| owner.child.try_wait().unwrap().is_some());
        let leader = owner.group.job.leader.get().unwrap();
        assert_eq!(leader.pid, owner.child.id());
        until(|| unsafe { WaitForSingleObject(leader.handle.0, 0) } == WAIT_OBJECT_0);
        let live = owner.group.job.activity_query();
        assert_ne!(live.ok, 0);
        assert!(live.info.ActiveProcesses > 0);

        let mut shadow = Current::new().unwrap();
        assert!(shadow.observe_using(
            owner.group.job.handle.0,
            Some(owner.child.id()),
            Some(live.info.ActiveProcesses),
            || Err(io::Error::from_raw_os_error(5)),
            |_| panic!("failed historical snapshot supplies no target PID")
        ));
        assert!(shadow.coverage_gap);
        assert!(shadow.held.is_empty() && shadow.pending.is_empty());
        // Deliberately do not admit target into shadow. The original real owner
        // still controls termination and cleanup; the shadow controls nothing.
        owner.group.terminate();
        let started = Instant::now();
        let mut samples = 0;
        let mut matched = None;
        let mut first_query_error = None;
        while started.elapsed() < WINDOW && samples < MAX_SAMPLES {
            samples += 1;
            let before = owner.group.job.activity_query();
            let mut list_error = None;
            let listed = list(owner.group.job.handle.0, &mut list_error);
            let listed_count = listed.as_ref().ok().map(|value| value.len);
            let gap_before_probe = shadow.coverage_gap;
            // Only native zero plus a parsed complete empty list reaches the
            // shadow. Positive/nonempty lists are intentionally not captured:
            // this is the missed-history counterexample, not the known guard.
            let shadow_active =
                if before.ok != 0 && before.info.ActiveProcesses == 0 && listed_count == Some(0) {
                    Some(shadow.observe_using(
                        owner.group.job.handle.0,
                        Some(owner.child.id()),
                        Some(before.info.ActiveProcesses),
                        || listed,
                        |_| panic!("complete empty list supplies no target PID"),
                    ))
                } else {
                    None
                };
            let after = owner.group.job.activity_query();
            // No formatting, logging, allocation, yield, sleep, or further Job
            // query separates the final native accounting and this exact wait.
            let target_wait = unsafe { WaitForSingleObject(target.0, 0) };
            let target_error = (target_wait == WAIT_FAILED).then(|| unsafe { GetLastError() });
            let zero_empty_zero = before.ok != 0
                && before.info.ActiveProcesses == 0
                && listed_count == Some(0)
                && after.ok != 0
                && after.info.ActiveProcesses == 0;
            let proposed_would_clear = zero_empty_zero
                && !shadow.observation_unknown
                && shadow.held.is_empty()
                && shadow.pending.is_empty();
            if zero_empty_zero {
                matched_windows += 1;
                if proposed_would_clear && target_wait == WAIT_TIMEOUT {
                    counterexamples += 1;
                }
                if target_wait == WAIT_FAILED {
                    native_wait_errors += 1;
                }
                matched = Some(serde_json::json!({
                    "accountingBefore": before.info.ActiveProcesses,
                    "completeListedCount": listed_count,
                    "accountingAfter": after.info.ActiveProcesses,
                    "exactTargetWaitReturn": target_wait,
                    "exactTargetWaitError": target_error,
                    "zeroBeforeExactTargetSignal": target_wait == WAIT_TIMEOUT,
                    "proposedWouldClear": proposed_would_clear,
                    "shadowCurrentActive": shadow_active,
                    "shadowGapBeforeProbe": gap_before_probe,
                    "shadowGapAfterProbe": shadow.coverage_gap,
                    "shadowHeldCount": shadow.held.len(),
                    "shadowPendingCount": shadow.pending.len(),
                }));
                break;
            }
            if first_query_error.is_none()
                && (before.ok == 0 || listed_count.is_none() || after.ok == 0)
            {
                first_query_error = Some((before.native_error, list_error, after.native_error));
            }
        }
        if matched.is_none() {
            missed_windows += 1;
        }
        // Every trial retires the original target and Job under its existing
        // owner before reporting or starting the next trial. No retry of work,
        // PID reopen, alternate Job, or new termination authority is introduced.
        until(|| unsafe { WaitForSingleObject(target.0, 0) } == WAIT_OBJECT_0);
        until(|| !owner.group.job.activity_query().not_confirmed_inactive());
        let first_query_error = first_query_error.map(|(before, listed, after)| {
            serde_json::json!({
                "accountingBeforeError": before,
                "listError": listed,
                "accountingAfterError": after,
            })
        });
        eprintln!(
            "FARFOLD_WINDOWS_JOB_GAP_SHADOW_TRIAL {}",
            serde_json::json!({
                "trial": trial + 1,
                "originalLeaderPid": owner.child.id(),
                "originalLeaderSignaledBeforeTermination": true,
                "exactTargetPid": pid,
                "exactTargetMemberBeforeTermination": true,
                "samples": samples,
                "matchedWindow": matched,
                "firstQueryError": first_query_error,
                "targetSignaledAfterCleanup": true,
                "originalJobNativeZeroAfterCleanup": true,
                "scope": "owned OS fixture; historical list failure injected only into shadow Current; same external target handle deliberately absent from shadow; actual native zero/list/final-zero precede exact zero-wait; non-atomic observations; no complete historical membership or general safety proof",
            })
        );
    }
    eprintln!(
        "FARFOLD_WINDOWS_JOB_GAP_SHADOW_RESULT {}",
        serde_json::json!({
            "trials": TRIALS,
            "matchedNativeZeroEmptyZeroWindows": matched_windows,
            "zeroBeforeExactTargetSignal": counterexamples,
            "missedWindows": missed_windows,
            "nativeWaitErrors": native_wait_errors,
            "scope": "bounded counterexample search; no observed counterexample is not a universal Windows retirement guarantee",
        })
    );
    assert_eq!(missed_windows, 0, "native window coverage was incomplete");
    assert_eq!(native_wait_errors, 0, "exact target wait must be known");
    assert_eq!(
        counterexamples, 0,
        "native zero/empty/zero preceded an omitted original target's exact signal"
    );
}
