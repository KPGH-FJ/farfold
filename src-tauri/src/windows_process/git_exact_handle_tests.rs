//! Actual Git exit samples, with two exact process handles and no PID reopen.
use super::*;
use std::{ffi::OsString, os::windows::io::AsRawHandle};

#[path = "git_job_debug_tests.rs"]
mod git_job_debug_tests;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    accounting_before: Option<u32>,
    listed_count: Option<usize>,
    list_error: Option<NativeListObservation>,
    accounting_after: Option<u32>,
    total_processes: Option<u32>,
    helper_wait: u32,
    git_wait: Option<u32>,
}
impl Sample {
    fn observe(group: &OwnedGroup, helper: &Child, git: Option<&Handle>) -> Self {
        let job = &group.job;
        let before = job.activity_query();
        let mut list_error = None;
        let listed_count = list(job.handle.0, &mut list_error)
            .ok()
            .map(|pids| pids.len);
        let after = job.activity_query();
        Self {
            accounting_before: (before.ok != 0).then_some(before.info.ActiveProcesses),
            listed_count,
            list_error,
            accounting_after: (after.ok != 0).then_some(after.info.ActiveProcesses),
            total_processes: (after.ok != 0).then_some(after.info.TotalProcesses),
            helper_wait: unsafe { WaitForSingleObject(helper.as_raw_handle(), 0) },
            git_wait: git.map(|process| unsafe { WaitForSingleObject(process.0, 0) }),
        }
    }
    fn exact_mismatch(&self) -> bool {
        self.list_error.as_ref().is_some_and(|error| {
            error.query_return != 0 && error.assigned == 1 && error.listed == 0
        })
    }
}

fn pinned_git() -> crate::file_access::PinnedPath {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .filter(|entry| entry.is_absolute())
        .find_map(|entry| crate::file_access::PinnedPath::regular(&entry.join("git.exe")).ok())
        .expect("Windows native tests require Git")
}

#[test]
fn actual_git_job_debugger_observes_transient_descendant_handles() {
    git_job_debug_tests::run();
}

#[test]
fn actual_git_job_observes_exact_launch_handle_across_exit() {
    let directory = tempfile::tempdir().unwrap();
    let executable = pinned_git();
    let fixture = fixture();
    let mut command = Command::new(fixture);
    command
        .arg("git-job-probe")
        .arg(&executable.path)
        .arg(directory.path())
        .arg(OsString::from(unsafe { GetCurrentProcessId() }.to_string()));
    let pending = super::super::super::prepare_noninteractive_git_command(&mut command).unwrap();
    let child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let group = pending.attach(child.id()).unwrap();
    let mut owner = Owned { child, group };
    let marker = directory.path().join("git-handle");
    until(|| marker.is_file());
    let git = Handle(
        std::fs::read_to_string(marker)
            .unwrap()
            .parse::<usize>()
            .unwrap() as HANDLE,
    );
    assert!(!git.0.is_null());
    let mut belongs = 0;
    assert_ne!(
        unsafe { IsProcessInJob(git.0, owner.group.job.handle.0, &mut belongs) },
        0
    );
    assert_ne!(belongs, 0);
    let before = Sample::observe(&owner.group, &owner.child, Some(&git));
    assert_eq!(before.git_wait, Some(WAIT_TIMEOUT));
    assert_eq!(before.helper_wait, WAIT_TIMEOUT);
    drop(owner.child.stdin.take().unwrap());
    let mut sampled = 0;
    let mut first_mismatch = None;
    let deadline = Instant::now() + Duration::from_secs(5);
    let signaled = loop {
        let sample = Sample::observe(&owner.group, &owner.child, Some(&git));
        sampled += 1;
        if sample.exact_mismatch() && first_mismatch.is_none() {
            first_mismatch = Some(serde_json::to_value(&sample).unwrap());
        }
        if sample.git_wait == Some(WAIT_OBJECT_0) && sample.helper_wait == WAIT_OBJECT_0 {
            break sample;
        }
        assert!(
            Instant::now() < deadline,
            "exact Git Job processes did not exit"
        );
        std::thread::yield_now();
    };
    assert!(owner.child.wait().unwrap().success());
    drop(git);
    let released = Sample::observe(&owner.group, &owner.child, None);
    let mut final_sample = None;
    until(|| {
        let sample = Sample::observe(&owner.group, &owner.child, None);
        if sample.accounting_before == Some(0)
            && sample.listed_count == Some(0)
            && sample.accounting_after == Some(0)
        {
            final_sample = Some(sample);
            true
        } else {
            false
        }
    });
    executable.verify().unwrap();
    eprintln!(
        "FARFOLD_WINDOWS_ACTUAL_GIT_JOB_EXIT {}",
        serde_json::json!({
            "fixedCommand": "hash-object --stdin --no-filters",
            "detached": true,
            "selectedAbsolutePathGitMayBeLauncher": true,
            "topology": "original Job wrapper, extra test fixture, selected Git and any Git descendants",
            "selectedHandleFromSpawn": true,
            "selectedHandleBelongsToOriginalJob": true,
            "before": before,
            "exitSamples": sampled,
            "firstAssignedOneListedZero": first_mismatch,
            "bothHandlesSignaled": signaled,
            "afterSelectedHandleRelease": released,
            "finalEmptyAccountingSample": final_sample.unwrap()
        })
    );
}
