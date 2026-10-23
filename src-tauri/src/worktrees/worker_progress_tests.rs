use super::*;

#[test]
fn original_scoped_owner_reports_unknown_without_taking_the_manager_lock() {
    let manager = Worktrees::default();
    let owner = Working::new("original", Arc::new(AtomicBool::new(false)));
    let other = Working::new("other", Arc::new(AtomicBool::new(false)));
    let mut inner = manager.lock().unwrap();
    inner.working = Some(owner.clone());
    let _scope = owner.scope();
    // A native report is safe even when THIS thread holds Inner: it only
    // changes the original owner's atomic flag, never locks or writes a DB.
    mark_unknown();
    assert!(owner.uncertain());
    assert!(!other.uncertain());
    let mut stored = operation("original", "cancelling", Some("prior"));
    stored.action = "remove".into();
    stored.maintenance_active = true;
    stored.cancel_requested = true;
    stored.removal_phase = Some("deletingOriginal".into());
    stored.delete_dispatched = Some(true);
    stored.target_path = Some("original-target".into());
    let mut expected = stored.clone();
    expected.state = "unknown".into();
    expected.code = Some("unknown".into());
    expected.settled = false;
    expected.reviewed = false;
    assert_eq!(inner.visible_status(&stored), expected);
    assert_eq!(
        stored.state, "cancelling",
        "status query never rewrites the intent"
    );
    let foreign = operation("other", "running", None);
    assert_eq!(inner.visible_status(&foreign), foreign);
}

#[test]
fn nested_scopes_restore_only_the_original_owner_and_never_cross_threads() {
    let outer = Working::new("outer", Arc::new(AtomicBool::new(false)));
    let inner = Working::new("inner", Arc::new(AtomicBool::new(false)));
    let scope = outer.scope();
    std::thread::spawn(mark_unknown).join().unwrap();
    assert!(!outer.uncertain());
    {
        let _inner = inner.scope();
        mark_unknown();
    }
    assert!(inner.uncertain());
    assert!(!outer.uncertain());
    mark_unknown();
    assert!(outer.uncertain());
    drop(scope);
    assert!(CURRENT.with(|value| value.borrow().is_none()));
    mark_unknown();
}

#[cfg(unix)]
fn prepared() -> (Worktrees, MetaStore, crate::worktrees::tests::Repo) {
    use crate::worktrees::tests::{OP, Repo, git, input, op, store};
    let repository = Repo::new();
    let store = store();
    let manager = Worktrees::default();
    let input = input(
        &manager,
        &store,
        &repository,
        Branch::New {
            name: "bounded-control".into(),
            start_oid: git(&repository.root, &["rev-parse", "HEAD"]),
        },
        "bounded-control",
    );
    assert_eq!(
        op(manager.prepare(&store, OP, input).unwrap()).state,
        "prepared"
    );
    (manager, store, repository)
}

#[cfg(unix)]
#[test]
fn native_ref_identity_boundary_leaves_original_status_and_cancel_reachable() {
    use crate::worktrees::tests::{OP, op};
    use std::sync::mpsc;
    let (manager, store, repository) = prepared();
    let ticket = manager
        .inspect(&store, repository.root.to_str().unwrap())
        .unwrap()
        .inspection_id;
    let cancel = Arc::new(AtomicBool::new(false));
    let work = Working::new(OP, cancel.clone());
    {
        let mut inner = manager.lock().unwrap();
        inner.working = Some(work.clone());
        inner.doc.operation.as_mut().unwrap().status.state = "running".into();
    }
    let (ready, started) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let reader = manager.clone();
    let file = std::fs::File::open(repository.root.join("a.txt")).unwrap();
    let worker = std::thread::spawn(move || {
        let _scope = work.scope();
        reader.refs_with_identity(&ticket, None, |snapshot| {
            snapshot.identity()?;
            mark_unknown();
            ready.send(()).unwrap();
            blocked.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(file.metadata().unwrap().len(), 7);
            Ok(())
        })
    });
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    let (finished, observed) = mpsc::channel();
    let control = manager.clone();
    let data = store.clone();
    let controls = std::thread::spawn(move || {
        let status = op(control.status(&data, OP).unwrap());
        let cancelled = op(control.cancel(&data, OP).unwrap());
        finished.send((status, cancelled)).unwrap();
    });
    let result = observed.recv_timeout(Duration::from_secs(2));
    // Always release the original fixture before asserting: even the old
    // lock-held implementation cannot strand a test thread on failure.
    release.send(()).unwrap();
    worker.join().unwrap().unwrap();
    controls.join().unwrap();
    let (status, cancelled) = result.expect("real manager control waited behind native identity");
    assert_eq!(status.state, "unknown");
    assert!(!status.settled);
    assert_eq!(cancelled.operation_id, OP);
    assert!(cancelled.cancel_requested);
    assert!(!cancelled.settled);
    assert!(cancel.load(Ordering::SeqCst));
    assert!(manager.lock().unwrap().working.is_some());
    assert_eq!(manager.acknowledge(&store, OP).unwrap_err().code, "busy");
    assert_eq!(
        manager.seal_exit(Some(&store), true).err().unwrap(),
        "WORKTREE_EXIT_BLOCKED"
    );
    manager.lock().unwrap().working = None;
    assert!(!repository._dir.path().join("bounded-control").exists());
}

#[cfg(unix)]
#[test]
fn identity_result_cannot_publish_refs_after_original_ticket_is_removed() {
    let (manager, store, repository) = prepared();
    let ticket = manager
        .inspect(&store, repository.root.to_str().unwrap())
        .unwrap()
        .inspection_id;
    let failure = manager
        .refs_with_identity(&ticket, None, |snapshot| {
            snapshot.identity()?;
            manager.lock().unwrap().tickets.remove(&ticket);
            Ok(())
        })
        .unwrap_err();
    assert_eq!(failure.code, "inspectionExpired");
}
