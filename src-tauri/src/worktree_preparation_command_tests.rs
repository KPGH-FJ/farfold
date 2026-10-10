use super::*;
use std::{
    sync::{Arc, mpsc},
    time::Duration,
};

#[tokio::test]
async fn preparation_observer_preserves_typed_failures_and_normalizes_unknown_details() {
    let _checks = crate::file_read_check::tests::PRODUCTION_CHECKS
        .lock()
        .await;
    assert_eq!(
        observe::<()>(|| Err(worktrees::Failure { code: "changed" }))
            .await
            .unwrap_err()
            .code,
        "changed"
    );
    assert_eq!(
        observe::<()>(|| Err(worktrees::Failure {
            code: "storageInvalid"
        }))
        .await
        .unwrap_err()
        .code,
        "unavailable"
    );
    assert_eq!(
        observe::<()>(|| Err(worktrees::Failure {
            code: "environmentOverride"
        }))
        .await
        .unwrap_err()
        .code,
        "unsupportedGit"
    );
}
#[tokio::test]
async fn preparation_dropped_observer_keeps_real_worker_admission() {
    let _checks = crate::file_read_check::tests::PRODUCTION_CHECKS
        .lock()
        .await;
    let gate = Arc::new(crate::managed_update::UpdateAdmission::default());
    let held = gate.activity().unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = mpsc::channel();
    let (ended, finished) = tokio::sync::oneshot::channel();
    let observer = tokio::spawn(observe(move || {
        let permit = held;
        started.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        drop(permit);
        ended.send(()).unwrap();
        Ok(())
    }));
    tokio::time::timeout(Duration::from_secs(1), ready)
        .await
        .unwrap()
        .unwrap();
    observer.abort();
    assert!(observer.await.unwrap_err().is_cancelled());
    let still_held = gate.update().is_err();
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), finished)
        .await
        .unwrap()
        .unwrap();
    assert!(still_held);
    assert!(gate.update().is_ok());
}
#[test]
fn preparation_commands_stay_main_only_and_outside_recovery_allowlist() {
    let source = include_str!("worktree_preparation_commands.rs");
    assert!(source.contains("caller_allowed(webview)"));
    assert!(source.contains("try_state::<MetaStore>()"));
    assert!(!source.contains(".state::<MetaStore>()"));
    assert!(source.contains("file_read_check::run"));
    let dispatcher = include_str!("lib.rs");
    assert!(dispatcher.contains("worktree_preparation_commands::worktree_preparation_inspect,"));
    assert!(dispatcher.contains("worktree_preparation_commands::worktree_preparation_validate,"));
    let recovery = include_str!("storage_recovery.rs");
    assert!(!recovery.contains("worktree_preparation_"));
}
