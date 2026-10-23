use super::*;
use std::sync::{atomic::AtomicUsize, mpsc};

async fn released(gate: &Semaphore) {
    drop(
        tokio::time::timeout(Duration::from_secs(2), gate.acquire())
            .await
            .unwrap()
            .unwrap(),
    );
}

#[tokio::test]
async fn timed_out_original_closures_keep_actual_file_handles_and_both_slots() {
    let admission = Arc::new(Admission::default());
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("owned-file");
    std::fs::write(&path, b"original").unwrap();
    let completed = Arc::new(AtomicUsize::new(0));
    let launched = Arc::new(AtomicUsize::new(0));
    let mut releases = Vec::new();
    for _ in 0..2 {
        let file = std::fs::File::open(&path).unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, blocked) = mpsc::channel();
        releases.push(release);
        let owner = admission.clone();
        let completed = completed.clone();
        let launched = launched.clone();
        let wait = tokio::spawn(async move {
            owner
                .run(RequestClass::Work, Duration::from_millis(40), move || {
                    launched.fetch_add(1, Ordering::SeqCst);
                    started.send(()).unwrap();
                    blocked.recv_timeout(Duration::from_secs(5)).unwrap();
                    // This is the ORIGINAL moved-in File, read only after the
                    // caller has already received unknown. No reopen/clone.
                    assert_eq!(file.metadata().unwrap().len(), 8);
                    completed.fetch_add(1, Ordering::SeqCst);
                    Ok(42)
                })
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), ready)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(wait.await.unwrap().unwrap_err().code, "unknown");
    }
    assert_eq!(completed.load(Ordering::SeqCst), 0);
    assert_eq!(admission.work.available_permits(), 0);
    for _ in 0..8 {
        let launched = launched.clone();
        assert_eq!(
            admission
                .run(RequestClass::Work, Duration::from_secs(1), move || {
                    launched.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
                .unwrap_err()
                .code,
            "busy"
        );
    }
    assert_eq!(launched.load(Ordering::SeqCst), 2);
    for release in releases {
        release.send(()).unwrap();
    }
    drop(
        tokio::time::timeout(Duration::from_secs(2), admission.work.acquire_many(2))
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(completed.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn work_and_status_saturation_do_not_take_the_original_cancel_admission() {
    let admission = Arc::new(Admission::default());
    let work = admission.work.clone().acquire_many_owned(2).await.unwrap();
    let status = admission.status.clone().acquire_owned().await.unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let original = cancelled.clone();
    assert_eq!(
        admission
            .run(RequestClass::Cancel, Duration::from_secs(1), move || {
                original.store(true, Ordering::SeqCst);
                Ok(7)
            })
            .await
            .unwrap(),
        7
    );
    assert!(cancelled.load(Ordering::SeqCst));
    drop(status);
    assert_eq!(
        admission
            .run(RequestClass::Status, Duration::from_secs(1), || Ok(9))
            .await
            .unwrap(),
        9
    );
    assert_eq!(admission.work.available_permits(), 0);
    drop(work);
}

#[tokio::test]
async fn dropped_user_reply_does_not_abort_or_release_original_blocking_work() {
    let admission = Arc::new(Admission::default());
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = mpsc::channel();
    let owner = admission.clone();
    let request = tokio::spawn(async move {
        owner
            .run(RequestClass::Cancel, Duration::from_secs(5), move || {
                started.send(()).unwrap();
                blocked.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(admission.cancel.available_permits(), 0);
    assert_eq!(
        admission
            .run(RequestClass::Cancel, Duration::from_secs(1), || Ok(()))
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    release.send(()).unwrap();
    released(&admission.cancel).await;
}

#[tokio::test]
async fn actual_result_and_error_are_preserved_and_panic_is_only_unknown() {
    let admission = Admission::default();
    assert_eq!(
        admission
            .run(RequestClass::Work, Duration::from_secs(1), || Ok(4))
            .await
            .unwrap(),
        4
    );
    assert_eq!(
        admission
            .run::<()>(RequestClass::Work, Duration::from_secs(1), || Err(error(
                "changed"
            )))
            .await
            .unwrap_err()
            .code,
        "changed"
    );
    assert_eq!(
        admission
            .run::<()>(RequestClass::Work, Duration::from_secs(1), || panic!(
                "controlled worker"
            ))
            .await
            .unwrap_err()
            .code,
        "unknown"
    );
    assert_eq!(admission.work.available_permits(), 2);
}

#[cfg(unix)]
#[tokio::test]
async fn timed_out_preparation_finishes_only_original_intent_and_never_starts_it() {
    use crate::worktrees::tests::{OP, Repo, git, input, op, store};
    let repository = Repo::new();
    let store = store();
    let manager = Worktrees::default();
    let input = input(
        &manager,
        &store,
        &repository,
        Branch::New {
            name: "late-preparation".into(),
            start_oid: git(&repository.root, &["rev-parse", "HEAD"]),
        },
        "late-preparation",
    );
    let (ready, started) = tokio::sync::oneshot::channel();
    let (release, blocked) = mpsc::channel();
    let worker = manager.clone();
    let data = store.clone();
    let owner = manager.clone();
    let wait = tokio::spawn(async move {
        owner
            .0
            .requests
            .run(RequestClass::Work, Duration::from_millis(40), move || {
                ready.send(()).unwrap();
                blocked.recv_timeout(Duration::from_secs(5)).unwrap();
                worker.prepare(&data, OP, input)
            })
            .await
    });
    started.await.unwrap();
    assert_eq!(wait.await.unwrap().unwrap_err().code, "unknown");
    assert!(matches!(
        manager.status(&store, OP).unwrap(),
        Reply::Unknown { .. }
    ));
    release.send(()).unwrap();
    drop(
        tokio::time::timeout(
            Duration::from_secs(5),
            manager.0.requests.work.acquire_many(2),
        )
        .await
        .unwrap()
        .unwrap(),
    );
    let late = op(manager.status(&store, OP).unwrap());
    assert_eq!(late.operation_id, OP);
    assert_eq!(late.state, "prepared");
    assert!(!late.settled);
    assert!(manager.lock().unwrap().working.is_none());
    assert!(!repository._dir.path().join("late-preparation").exists());
    assert_eq!(op(manager.cancel(&store, OP).unwrap()).state, "cancelled");
}
