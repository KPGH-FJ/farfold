use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

async fn owner(agent: &str) -> Ownership {
    let attempt = crate::auth::attempts::reserve(agent, "first").unwrap();
    let configuration = attempt.configuration_guard().await.unwrap();
    Ownership {
        output: Channel::new(|_| Ok(())),
        configuration,
        scope: vec![],
        attempt,
    }
}

#[tokio::test]
async fn cancellation_before_configuration_acquisition_does_not_take_the_lock() {
    let agent = "cancel-before-auth-guard";
    crate::auth::attempts::auth_cancel(agent.into(), "first".into()).unwrap();
    let attempt = crate::auth::attempts::reserve(agent, "first").unwrap();
    let result = attempt.configuration_guard().await;
    assert_eq!(result.err().as_deref(), Some("AUTH_CANCELLED"));
    drop(attempt);
    let _available = crate::install_job::configuration_guard(agent).await;
}

#[tokio::test]
async fn cancellation_while_waiting_for_configuration_ends_the_same_attempt() {
    let agent = "cancel-waiting-auth-guard";
    let held = crate::install_job::configuration_guard(agent).await;
    let attempt = crate::auth::attempts::reserve(agent, "first").unwrap();
    let waiting = attempt.configuration_guard();
    tokio::pin!(waiting);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut waiting)
            .await
            .is_err()
    );
    crate::auth::attempts::auth_cancel(agent.into(), "first".into()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), &mut waiting).await;
    drop(held);
    assert!(matches!(result, Ok(Err(ref error)) if error == "AUTH_CANCELLED"));
}

#[tokio::test]
async fn cancelled_declared_or_manual_login_does_not_read_environment_or_spawn() {
    for phase in ["before-environment", "after-environment"] {
        let agent = format!("cancel-terminal-{phase}");
        let owned = owner(&agent).await;
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("must-not-exist");
        let pty = crate::pty::PtyManager::new();
        let calls = AtomicUsize::new(0);
        if phase == "before-environment" {
            crate::auth::attempts::auth_cancel(agent.clone(), "first".into()).unwrap();
        }
        let result = run(
            &pty,
            "/usr/bin/python3",
            &[
                "-c".into(),
                "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('created')".into(),
                marker.display().to_string(),
            ],
            directory.path(),
            owned,
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                crate::auth::attempts::auth_cancel(agent.clone(), "first".into()).unwrap();
                Ok(vec![])
            },
        );
        if let Ok(id) = &result {
            pty.await_exit(id).unwrap();
            pty.close(id).unwrap();
        }
        assert_eq!(result.err().as_deref(), Some("AUTH_CANCELLED"), "{phase}");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            usize::from(phase == "after-environment")
        );
        assert!(!marker.exists());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_after_spawn_keeps_the_original_exit_owner() {
    let agent = "cancel-live-auth-terminal";
    let owned = owner(agent).await;
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("pid");
    let pty = Arc::new(crate::pty::PtyManager::new());
    let id = run(
        &pty,
        "/usr/bin/python3",
        &[
            "-c".into(),
            "import pathlib,os,sys;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));input()"
                .into(),
            marker.display().to_string(),
        ],
        directory.path(),
        owned,
        || Ok(vec![]),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !marker.exists() || std::fs::read_to_string(&marker).unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    crate::auth::attempts::auth_cancel(agent.into(), "first".into()).unwrap();
    let (finished, receive) = std::sync::mpsc::channel();
    let waiter = pty.clone();
    let waiting_id = id.clone();
    let thread = std::thread::spawn(move || {
        let _ = finished.send(waiter.await_exit(&waiting_id));
    });
    let outcome = receive.recv_timeout(Duration::from_secs(1));
    let _ = pty.close(&id);
    thread.join().unwrap();
    assert!(
        outcome.is_ok(),
        "the same operation flag must reach the existing PTY owner"
    );
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
    let _available = tokio::time::timeout(
        Duration::from_secs(1),
        crate::install_job::configuration_guard(agent),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn cancellation_during_failed_environment_read_keeps_cancelled_status() {
    let agent = "cancel-failed-environment-read";
    let owned = owner(agent).await;
    let directory = tempfile::tempdir().unwrap();
    let pty = crate::pty::PtyManager::new();
    let result = run(
        &pty,
        "/usr/bin/python3",
        &[],
        directory.path(),
        owned,
        || {
            crate::auth::attempts::auth_cancel(agent.into(), "first".into()).unwrap();
            Err("controlled environment read failure".into())
        },
    );
    assert_eq!(result.err().as_deref(), Some("AUTH_CANCELLED"));
    let _available = crate::install_job::configuration_guard(agent).await;
}
