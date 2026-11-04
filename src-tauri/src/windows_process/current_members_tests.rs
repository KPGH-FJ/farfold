//! These use self-created Windows Job/process objects, never Agents or user work.
use super::super::{OwnedGroup, behavior_tests::fixture, pending};
use super::*;
use std::{
    cell::Cell,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId};

#[path = "current_members_gap_shadow_tests.rs"]
mod gap_shadow_tests;
#[path = "git_exact_handle_tests.rs"]
mod git_exact_handle_tests;
#[path = "current_members_lifetime_tests.rs"]
mod lifetime_tests;

// Only the original production list call supplies these values. The logger
// performs no native query, lookup or wait and retains no process handle.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeListObservation {
    query_return: i32,
    native_error: Option<i32>,
    assigned: u32,
    listed: u32,
    written: u32,
    parse_rejections: Vec<&'static str>,
}
impl NativeListObservation {
    pub(super) fn capture(
        native: &NativeList,
        written: u32,
        query_return: i32,
        native_error: Option<i32>,
    ) -> Self {
        let mut parse_rejections = Vec::new();
        // A failed API call did not produce a valid list to parse.
        if query_return != 0 {
            let offset = std::mem::offset_of!(NativeList, ids);
            let count = native.listed as usize;
            if offset != std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) {
                parse_rejections.push("layout");
            }
            if native.assigned != native.listed {
                parse_rejections.push("assigned-listed-mismatch");
            }
            if count > CAPACITY {
                parse_rejections.push("capacity");
            }
            if written as usize > size_of::<NativeList>() {
                parse_rejections.push("written-exceeds-buffer");
            }
            if count
                .checked_mul(size_of::<usize>())
                .and_then(|n| offset.checked_add(n))
                .is_none_or(|needed| needed > written as usize)
            {
                parse_rejections.push("truncated-list");
            }
            if parse_rejections.is_empty() {
                for (index, &pid) in native.ids[..count].iter().enumerate() {
                    if u32::try_from(pid).ok().is_none_or(|pid| pid == 0) {
                        parse_rejections.push("invalid-pid");
                        break;
                    }
                    if native.ids[..index].contains(&pid) {
                        parse_rejections.push("duplicate-pid");
                        break;
                    }
                }
            }
        }
        Self {
            query_return,
            native_error,
            assigned: native.assigned,
            listed: native.listed,
            written,
            parse_rejections,
        }
    }
}
pub(super) fn emit_incomplete(
    reason: &'static str,
    leader: Option<u32>,
    associated: Option<u32>,
    current: &CurrentObservation,
    native_list: Option<NativeListObservation>,
) {
    eprintln!(
        "FARFOLD_WINDOWS_CURRENT_MEMBERS_FIRST_INCOMPLETE {}",
        serde_json::json!({
            "reason": reason,
            "originalLeaderPid": leader,
            "accountingActiveProcesses": associated,
            "current": current,
            "originalListCall": native_list,
            "scope": "first incomplete observation creating a coverage gap; original call metadata; sticky gap unchanged; no extra native query"
        })
    );
}

#[test]
fn native_list_failure_diagnostic_preserves_api_error_and_exact_parse_categories() {
    let mut native = NativeList {
        assigned: 0,
        listed: 0,
        ids: [0; CAPACITY],
    };
    let offset = std::mem::offset_of!(NativeList, ids) as u32;
    assert!(parse_list(&native, offset).is_ok());
    let empty = NativeListObservation::capture(&native, offset, 1, None);
    assert!(empty.parse_rejections.is_empty());
    let failed = NativeListObservation::capture(&native, 0, 0, Some(5));
    assert_eq!(failed.native_error, Some(5));
    assert!(failed.parse_rejections.is_empty());
    native.assigned = 1;
    assert!(parse_list(&native, offset).is_err());
    assert_eq!(
        NativeListObservation::capture(&native, offset, 1, None).parse_rejections,
        ["assigned-listed-mismatch"]
    );
    native.listed = 1;
    assert!(parse_list(&native, offset).is_err());
    assert_eq!(
        NativeListObservation::capture(&native, offset, 1, None).parse_rejections,
        ["truncated-list"]
    );
    let one = offset + size_of::<usize>() as u32;
    assert!(parse_list(&native, one).is_err());
    assert_eq!(
        NativeListObservation::capture(&native, one, 1, None).parse_rejections,
        ["invalid-pid"]
    );
    native.assigned = 2;
    native.listed = 2;
    native.ids[..2].copy_from_slice(&[42, 42]);
    let two = offset + 2 * size_of::<usize>() as u32;
    assert!(parse_list(&native, two).is_err());
    assert_eq!(
        NativeListObservation::capture(&native, two, 1, None).parse_rejections,
        ["duplicate-pid"]
    );
}

fn until(mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !check() {
        assert!(Instant::now() < deadline, "current-member fixture deadline");
        std::thread::sleep(Duration::from_millis(5));
    }
}
struct Owned {
    child: Child,
    group: OwnedGroup,
}
impl Drop for Owned {
    fn drop(&mut self) {
        self.group.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn launch(marker: &Path) -> Owned {
    let pending = pending().unwrap();
    let program = fixture();
    let child = Command::new(&program)
        .args(pending.helper_argv(
            program.as_os_str(),
            ["orphan".into(), marker.as_os_str().to_owned()],
            false,
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let group = pending.attach(child.id()).unwrap();
    Owned { child, group }
}
fn descendant(marker: &Path) -> (u32, Handle) {
    until(|| std::fs::read_to_string(marker).is_ok_and(|text| text.parse::<u32>().is_ok()));
    let pid = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    match native_lookup(pid).unwrap() {
        Lookup::Object(handle) => (pid, handle),
        Lookup::Gone => panic!("held fixture unexpectedly gone"),
    }
}
fn empty() -> Listed {
    Listed {
        len: 0,
        ids: [0; CAPACITY],
    }
}

#[test]
fn known_original_member_stays_held_until_real_signal_and_is_then_retired() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("descendant");
    let mut owner = launch(&marker);
    let (pid, handle) = descendant(&marker);
    until(|| owner.child.try_wait().unwrap().is_some());
    assert!(owner.group.active());
    assert!(
        owner
            .group
            .job
            .current
            .lock()
            .unwrap()
            .held
            .iter()
            .any(|member| member.pid == pid && member.admitted)
    );
    assert_eq!(unsafe { WaitForSingleObject(handle.0, 0) }, WAIT_TIMEOUT);
    owner.group.terminate();
    until(|| !owner.group.active());
    assert_eq!(unsafe { WaitForSingleObject(handle.0, 0) }, WAIT_OBJECT_0);
    let current = owner.group.job.current.lock().unwrap();
    assert!(current.held.is_empty());
    assert!(current.pending.is_empty());
}

#[test]
fn later_original_job_member_is_observed_after_the_first_member_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("first");
    let mut owner = launch(&marker);
    let (_, first) = descendant(&marker);
    until(|| owner.child.try_wait().unwrap().is_some());
    assert!(owner.group.active());
    let later = directory.path().join("later");
    let program = fixture();
    // Test-only explicit assignment through the SAME original Job's real helper.
    // No new registry entry, process owner, or production launch behavior.
    let pending = super::super::PendingGroup(owner.group.job.clone());
    let mut child = Command::new(&program)
        .args(pending.helper_argv(
            program.as_os_str(),
            ["wait".into(), later.clone().into_os_string()],
            false,
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let (pid, held) = descendant(&later);
    assert!(owner.group.active());
    assert!(
        owner
            .group
            .job
            .current
            .lock()
            .unwrap()
            .held
            .iter()
            .any(|member| member.pid == pid)
    );
    owner.group.terminate();
    until(|| !owner.group.active());
    child.wait().unwrap();
    assert_eq!(unsafe { WaitForSingleObject(first.0, 0) }, WAIT_OBJECT_0);
    assert_eq!(unsafe { WaitForSingleObject(held.0, 0) }, WAIT_OBJECT_0);
}

#[test]
fn failed_pending_lookup_survives_empty_snapshot_and_later_resolves_without_latch() {
    let job = pending().unwrap();
    let pid = unsafe { GetCurrentProcessId() };
    let mut current = Current::new().unwrap();
    current.pending.push(pid);
    let queried = Cell::new(false);
    for _ in 0..2 {
        assert!(current.observe_using(
            job.0.handle.0,
            None,
            Some(0),
            || {
                queried.set(true);
                Ok(empty())
            },
            |_| Err(io::Error::from_raw_os_error(5))
        ));
        assert_eq!(current.pending, [pid]);
        assert!(
            !queried.get(),
            "empty snapshot must not erase unresolved candidate"
        );
    }
    // An actual successful Open now proves this candidate is foreign. It is
    // discarded without any process termination or privilege change.
    assert!(!current.observe(job.0.handle.0, None, Some(0)));
    assert!(current.pending.is_empty());
    assert!(current.held.is_empty());
    assert_eq!(
        unsafe { WaitForSingleObject(GetCurrentProcess(), 0) },
        WAIT_TIMEOUT
    );
}

#[test]
fn actual_foreign_object_is_never_accepted_or_terminated_as_a_job_member() {
    let job = pending().unwrap();
    let pid = unsafe { GetCurrentProcessId() };
    let mut current = Current::new().unwrap();
    let mut snapshot = empty();
    snapshot.len = 1;
    snapshot.ids[0] = pid;
    assert!(!current.observe_using(
        job.0.handle.0,
        None,
        Some(0),
        || Ok(snapshot),
        native_lookup
    ));
    assert!(current.held.is_empty());
    assert_eq!(
        unsafe { WaitForSingleObject(GetCurrentProcess(), 0) },
        WAIT_TIMEOUT
    );
}

#[test]
fn failed_live_snapshot_keeps_original_handle_and_gap_after_later_empty_list() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("held");
    let mut owner = launch(&marker);
    let (pid, held) = descendant(&marker);
    until(|| owner.child.try_wait().unwrap().is_some());
    assert!(owner.group.active());
    {
        let associated = owner.group.job.activity_query();
        assert_ne!(associated.ok, 0);
        assert!(associated.info.ActiveProcesses > 0);
        let mut current = owner.group.job.current.lock().unwrap();
        assert!(current.observe_using(
            owner.group.job.handle.0,
            Some(owner.child.id()),
            Some(associated.info.ActiveProcesses),
            || Err(io::Error::from_raw_os_error(5)),
            native_lookup
        ));
        assert!(current.held.iter().any(|member| member.pid == pid));
    }
    assert_eq!(unsafe { WaitForSingleObject(held.0, 0) }, WAIT_TIMEOUT);
    owner.group.terminate();
    until(|| unsafe { WaitForSingleObject(held.0, 0) } == WAIT_OBJECT_0);
    until(|| !owner.group.job.activity_query().not_confirmed_inactive());
    assert!(
        owner.group.active(),
        "later empty list cannot identify the lost interval"
    );
    let current = owner.group.job.current.lock().unwrap();
    assert!(current.coverage_gap);
    assert!(current.unknown());
    assert!(
        current.held.is_empty(),
        "actual signaled handles are still retired"
    );
}

#[test]
fn truncated_capacity_invalid_and_duplicate_lists_are_not_successful_empty_observations() {
    let mut native = NativeList {
        assigned: 1,
        listed: 1,
        ids: [0; CAPACITY],
    };
    let bytes = (std::mem::offset_of!(NativeList, ids) + size_of::<usize>()) as u32;
    assert!(parse_list(&native, bytes).is_err());
    native.ids[0] = 100;
    assert_eq!(parse_list(&native, bytes).unwrap().ids(), [100]);
    assert!(parse_list(&native, bytes - 1).is_err());
    native.assigned = 2;
    assert!(parse_list(&native, bytes).is_err());
    native.listed = 2;
    native.ids[1] = 100;
    assert!(parse_list(&native, bytes + size_of::<usize>() as u32).is_err());
    native.assigned = CAPACITY as u32 + 1;
    native.listed = native.assigned;
    assert!(parse_list(&native, size_of::<NativeList>() as u32).is_err());
}

#[test]
fn query_failure_does_not_permanently_latch_an_empty_original_job() {
    let job = pending().unwrap();
    let mut current = Current::new().unwrap();
    assert!(current.observe_using(
        job.0.handle.0,
        None,
        Some(0),
        || Err(io::Error::from_raw_os_error(5)),
        |_| panic!("failed snapshot supplies no PID")
    ));
    assert!(!current.observe(job.0.handle.0, None, Some(0)));
    assert!(current.held.is_empty());
    assert!(current.pending.is_empty());
}

#[test]
fn unknown_accounting_is_never_zero_and_successful_empty_observation_can_retry() {
    let job = pending().unwrap();
    let mut current = Current::new().unwrap();
    assert!(current.observe_using(job.0.handle.0, None, None, || Ok(empty()), native_lookup));
    assert!(current.unknown());
    assert!(
        !current.coverage_gap,
        "unknown count does not invent a positive count"
    );
    assert!(!current.observe(job.0.handle.0, None, Some(0)));
    assert!(!current.unknown());
}

#[test]
fn unknown_accounting_with_failed_snapshot_keeps_gap_after_a_later_empty_list() {
    let job = pending().unwrap();
    let mut current = Current::new().unwrap();
    assert!(current.observe_using(
        job.0.handle.0,
        None,
        None,
        || Err(io::Error::from_raw_os_error(5)),
        native_lookup
    ));
    assert!(current.coverage_gap);
    assert!(current.unknown());
    assert!(current.observe(job.0.handle.0, None, Some(0)));
    assert!(current.held.is_empty());
    assert!(current.pending.is_empty());
    assert!(
        current.unknown(),
        "empty list cannot fill an unobserved interval"
    );
}

#[test]
fn unresolved_candidate_skipping_a_live_snapshot_preserves_gap_after_resolution() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("lookup-gap");
    let mut owner = launch(&marker);
    let (pid, held) = descendant(&marker);
    until(|| owner.child.try_wait().unwrap().is_some());
    let associated = owner.group.job.activity_query();
    assert_ne!(associated.ok, 0);
    assert!(associated.info.ActiveProcesses > 0);
    let mut current = Current::new().unwrap();
    current.pending.push(pid);
    assert!(current.observe_using(
        owner.group.job.handle.0,
        Some(owner.child.id()),
        Some(associated.info.ActiveProcesses),
        || panic!("unresolved actual candidate prevents complete enumeration"),
        |_| Err(io::Error::from_raw_os_error(5))
    ));
    assert!(current.coverage_gap);
    // Resolve this exact PID while it is alive, then retire its original
    // process handle. That proves THIS member, not a missed future member.
    assert!(current.observe(
        owner.group.job.handle.0,
        Some(owner.child.id()),
        Some(associated.info.ActiveProcesses)
    ));
    assert!(current.pending.is_empty());
    owner.group.terminate();
    until(|| unsafe { WaitForSingleObject(held.0, 0) } == WAIT_OBJECT_0);
    assert!(current.observe(owner.group.job.handle.0, Some(owner.child.id()), Some(0)));
    assert!(current.held.is_empty());
    assert!(current.unknown());
}

#[test]
fn real_member_wait_failure_skipping_enumeration_preserves_live_gap() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("wait-gap");
    let mut owner = launch(&marker);
    let (pid, held) = descendant(&marker);
    until(|| owner.child.try_wait().unwrap().is_some());
    let associated = owner.group.job.activity_query();
    assert_ne!(associated.ok, 0);
    assert!(associated.info.ActiveProcesses > 0);
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    assert!(!raw.is_null());
    let mut belongs = 0;
    assert_ne!(
        unsafe { IsProcessInJob(raw, owner.group.job.handle.0, &mut belongs) },
        0
    );
    assert_ne!(belongs, 0);
    let mut current = Current::new().unwrap();
    current.held.push(Member {
        pid,
        handle: Handle(raw),
        admitted: true,
        counted_live: false,
    });
    assert!(current.observe_using(
        owner.group.job.handle.0,
        Some(owner.child.id()),
        Some(associated.info.ActiveProcesses),
        || panic!("failed actual wait prevents complete enumeration"),
        native_lookup
    ));
    assert!(current.coverage_gap);
    assert_eq!(
        current.held.len(),
        1,
        "failed wait never discards the actual object"
    );
    owner.group.terminate();
    until(|| unsafe { WaitForSingleObject(held.0, 0) } == WAIT_OBJECT_0);
    assert!(current.unknown());
}

#[test]
fn native_current_observation_never_holds_the_shared_process_registry_lock() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("registry-boundary");
    let mut owner = launch(&marker);
    let (_, held) = descendant(&marker);
    until(|| owner.child.try_wait().unwrap().is_some());
    let current = owner.group.job.current.lock().unwrap();
    let before = std::sync::Arc::strong_count(&owner.group.job);
    let pid = owner.child.id();
    let observer = std::thread::spawn(move || super::super::active(pid));
    // This count observes the original Arc acquired by active(), not a sleep
    // assumption. Its next real observation is blocked by our Current guard.
    until(|| std::sync::Arc::strong_count(&owner.group.job) > before);
    let registry_available = super::super::groups().try_lock().is_ok();
    drop(current);
    assert!(observer.join().unwrap());
    assert!(
        registry_available,
        "one Job observation blocked all other owners"
    );
    owner.group.terminate();
    until(|| unsafe { WaitForSingleObject(held.0, 0) } == WAIT_OBJECT_0);
}

#[test]
fn native_job_accounting_samples_exact_children_across_exit_and_handle_release() {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

    let launch = |job: &super::super::Job| {
        let child = Command::new(fixture())
            .arg("argv")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert_ne!(
            unsafe { AssignProcessToJobObject(job.handle.0, child.as_raw_handle()) },
            0,
            "{}",
            io::Error::last_os_error()
        );
        child
    };
    let sample = |job: &super::super::Job| {
        let before = job.activity_query();
        let mut incomplete = None;
        let listed = list(job.handle.0, &mut incomplete);
        let after = job.activity_query();
        assert_ne!(before.ok, 0);
        assert_ne!(after.ok, 0);
        assert_eq!(after.info.TotalProcesses, 2);
        (
            before.info.ActiveProcesses,
            listed.map(|value| value.len),
            incomplete,
            after.info.ActiveProcesses,
        )
    };
    for forced in [false, true] {
        let job = pending().unwrap();
        let first = launch(&job.0);
        let second = launch(&job.0);
        let (before, listed, _, after) = sample(&job.0);
        assert_eq!((before, listed.unwrap(), after), (2, 2, 2));
        let mut sample_count = 0;
        let mut mismatches = 0;
        let mut first_mismatch = None;
        let mut signaled_accounting = [0; 2];
        let mut released_accounting = [0; 2];
        for (index, mut child) in [first, second].into_iter().enumerate() {
            if forced {
                child.kill().unwrap();
            } else {
                drop(child.stdin.take());
            }
            let started = Instant::now();
            while started.elapsed() < Duration::from_millis(100) {
                let (before, _, incomplete, after) = sample(&job.0);
                sample_count += 1;
                if let Some(incomplete) = incomplete
                    && incomplete.query_return != 0
                    && incomplete.assigned != incomplete.listed
                {
                    mismatches += 1;
                    first_mismatch.get_or_insert_with(|| {
                        serde_json::json!({
                            "childOrdinal": index + 1,
                            "accountingBefore": before,
                            "list": incomplete,
                            "accountingAfter": after,
                        })
                    });
                }
                std::thread::yield_now();
            }
            until(|| child.try_wait().unwrap().is_some());
            signaled_accounting[index] = sample(&job.0).3;
            drop(child);
            released_accounting[index] = sample(&job.0).3;
        }
        until(|| {
            let (before, listed, _, after) = sample(&job.0);
            before == 0 && listed.is_ok_and(|count| count == 0) && after == 0
        });
        eprintln!(
            "FARFOLD_WINDOWS_JOB_EXIT_SAMPLES {}",
            serde_json::json!({
                "forcedExit": forced,
                "samples": sample_count,
                "nativeAssignedListedMismatches": mismatches,
                "firstMismatch": first_mismatch,
                "signaledAccounting": signaled_accounting,
                "immediatelyAfterHandleReleaseAccounting": released_accounting,
                "settledAccounting": 0,
            })
        );
    }
}
