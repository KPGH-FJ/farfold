//! Lifetime cardinality uses only original objects observed alive, never PID history.
use super::*;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

struct LiveJob {
    children: Vec<Child>,
    group: OwnedGroup,
}
struct LaunchChildren(Vec<Child>);
impl Drop for LaunchChildren {
    fn drop(&mut self) {
        for child in &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for LiveJob {
    fn drop(&mut self) {
        self.group.terminate();
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn launch_live(count: usize) -> LiveJob {
    let pending = pending().unwrap();
    let mut children = LaunchChildren(Vec::new());
    for _ in 0..count {
        children.0.push(
            Command::new(fixture())
                .arg("argv")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let child = children.0.last().unwrap();
        assert_ne!(
            unsafe { AssignProcessToJobObject(pending.0.handle.0, child.as_raw_handle()) },
            0,
            "{}",
            io::Error::last_os_error()
        );
    }
    let group = pending.attach(children.0[0].id()).unwrap();
    LiveJob {
        children: std::mem::take(&mut children.0),
        group,
    }
}
fn snapshot(pids: &[u32]) -> Listed {
    let mut value = empty();
    value.len = pids.len();
    value.ids[..pids.len()].copy_from_slice(pids);
    value
}
fn admit(owner: &LiveJob, indices: &[usize]) {
    let pids: Vec<_> = indices
        .iter()
        .map(|&index| owner.children[index].id())
        .collect();
    let query = owner.group.job.activity_query();
    assert_ne!(query.ok, 0);
    let mut current = owner.group.job.current.lock().unwrap();
    assert!(current.observe_using(
        owner.group.job.handle.0,
        Some(owner.children[0].id()),
        Some(query.info.ActiveProcesses),
        || Ok(snapshot(&pids)),
        native_lookup
    ));
    assert_eq!(current.observed_live, indices.len() as u32);
    assert_eq!(current.retired_live, 0);
}
fn inject_gap(owner: &LiveJob) {
    let query = owner.group.job.activity_query();
    assert_ne!(query.ok, 0);
    assert!(query.info.ActiveProcesses > 0);
    let mut current = owner.group.job.current.lock().unwrap();
    assert!(current.observe_using(
        owner.group.job.handle.0,
        Some(owner.children[0].id()),
        Some(query.info.ActiveProcesses),
        || Err(io::Error::from_raw_os_error(5)),
        native_lookup
    ));
    assert!(current.coverage_gap);
}
fn exit_all(owner: &mut LiveJob) {
    for child in &mut owner.children {
        drop(child.stdin.take());
    }
    until(|| {
        owner
            .children
            .iter_mut()
            .all(|child| child.try_wait().unwrap().is_some())
    });
    until(|| !owner.group.job.activity_query().not_confirmed_inactive());
}

#[test]
fn complete_live_objects_retire_original_job_without_clearing_historical_gap() {
    let mut owner = launch_live(3);
    admit(&owner, &[1, 2]);
    inject_gap(&owner);
    exit_all(&mut owner);
    until(|| !owner.group.active());
    let current = owner.group.job.current.lock().unwrap();
    assert!(current.coverage_gap && current.unknown());
    assert_eq!(
        current.completely_retired_live(owner.children[0].id()),
        Some(2)
    );
    assert_eq!((current.observed_live, current.retired_live), (2, 2));
    assert!(current.held.is_empty() && current.pending.is_empty());
    assert_eq!(owner.group.job.activity_query().info.TotalProcesses, 3);
}

#[test]
fn reopening_signaled_objects_never_compensates_for_an_unobserved_original_member() {
    let mut owner = launch_live(3);
    admit(&owner, &[1]); // Deliberately never observe the third original object alive.
    inject_gap(&owner);
    exit_all(&mut owner);
    let pids = [owner.children[1].id(), owner.children[2].id()];
    {
        let mut current = owner.group.job.current.lock().unwrap();
        for _ in 0..4 {
            assert!(current.observe_using(
                owner.group.job.handle.0,
                Some(owner.children[0].id()),
                Some(0),
                || Ok(snapshot(&pids)),
                native_lookup
            ));
            assert_eq!((current.observed_live, current.retired_live), (1, 1));
            assert!(current.held.is_empty());
        }
    }
    assert!(
        owner.group.active(),
        "native Total still includes the missed object"
    );
    let mut current = owner.group.job.current.lock().unwrap();
    assert_eq!(
        current.completely_retired_live(owner.children[0].id()),
        Some(1)
    );
    assert!(!owner.group.job.complete_retired_object_count(&mut current));
    assert_eq!(owner.group.job.activity_query().info.TotalProcesses, 3);
    assert!(current.coverage_gap);
}

#[test]
fn missing_or_changed_leader_context_permanently_refuses_lifetime_proof() {
    for missing_first in [false, true] {
        let mut owner = launch_live(2);
        if missing_first {
            let mut current = owner.group.job.current.lock().unwrap();
            current.observe_using(
                owner.group.job.handle.0,
                None,
                Some(2),
                || Ok(empty()),
                native_lookup,
            );
        } else {
            admit(&owner, &[1]);
            let mut current = owner.group.job.current.lock().unwrap();
            current.observe_using(
                owner.group.job.handle.0,
                Some(owner.children[0].id().wrapping_add(1)),
                Some(2),
                || Ok(empty()),
                native_lookup,
            );
        }
        inject_gap(&owner);
        exit_all(&mut owner);
        assert!(owner.group.active());
        let current = owner.group.job.current.lock().unwrap();
        assert!(current.count_invalid);
        assert_eq!(
            current.completely_retired_live(owner.children[0].id()),
            None
        );
    }
}

#[test]
fn checked_live_count_overflow_cannot_supply_lifetime_coverage() {
    let mut owner = launch_live(2);
    {
        let mut current = owner.group.job.current.lock().unwrap();
        current.observed_live = u32::MAX;
        assert!(current.observe_using(
            owner.group.job.handle.0,
            Some(owner.children[0].id()),
            Some(2),
            || Ok(snapshot(&[owner.children[1].id()])),
            native_lookup
        ));
        assert!(current.count_invalid);
        assert_eq!(current.observed_live, u32::MAX);
        assert!(!current.held[0].counted_live);
    }
    inject_gap(&owner);
    exit_all(&mut owner);
    assert!(owner.group.active());
    let current = owner.group.job.current.lock().unwrap();
    assert_eq!(
        current.completely_retired_live(owner.children[0].id()),
        None
    );
}
