//! Launch failure must not pre-empt the caller's chosen cancellation.
use super::*;

// On Windows the parent launches an ownership helper. The target is opened
// by that helper, so a missing target is not a parent spawn failure.
fn parent_spawn_failure(dir: &Path, target: &str, control: &ProcessControl) -> i32 {
    let agent = AcpAgent::new(agent_client_protocol::AcpAgentConfig::new(dir.join(target)));
    #[cfg(unix)]
    let (cwd, expected) = (dir.to_path_buf(), libc::ENOENT);
    #[cfg(windows)]
    let (cwd, expected) = {
        let cwd = dir.join("regular-file-cwd");
        std::fs::write(&cwd, []).unwrap();
        let error =
            std::process::Command::new(crate::windows_process::helper_executable().unwrap())
                .current_dir(&cwd)
                .spawn()
                .expect_err("the Windows launch cwd must be a directory");
        (cwd, error.raw_os_error().unwrap())
    };
    assert!(spawn_process_in(&agent, &cwd, control).is_err());
    assert!(control.start_failed());
    expected
}

#[cfg(windows)]
#[tokio::test]
async fn missing_selected_program_is_reported_by_the_owned_windows_helper() {
    use futures_lite::io::AsyncReadExt;
    let dir = tempfile::tempdir().unwrap();
    let diagnostics = Diagnostics::open(&dir.path().join("logs"), "fixture");
    let control = ProcessControl::new(diagnostics);
    let canary = "missing-selected-private-canary.exe";
    let agent = AcpAgent::new(agent_client_protocol::AcpAgentConfig::new(
        dir.path().join(canary),
    ));
    let (_, _, mut stderr, mut child, group) =
        spawn_process_in(&agent, dir.path(), &control).unwrap();
    let status = tokio::time::timeout(Duration::from_secs(5), child.status())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.code(), Some(126));
    assert!(!control.start_failed());
    let mut output = String::new();
    tokio::time::timeout(Duration::from_secs(5), stderr.read_to_string(&mut output))
        .await
        .unwrap()
        .unwrap();
    assert!(!output.contains(canary));
    assert!(output.lines().any(|line| line == "无法启动所选程序"));
    assert!(
        output
            .lines()
            .any(|line| line == "执行或等待程序时失败，系统错误：2")
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while group.active() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the exact helper Job must retire");
    eprintln!("FARFOLD_WINDOWS_SELECTED_SPAWN_FAILURE helperExit=126 systemError=2");
}

#[test]
fn spawn_failure_missing_program_records_os_error_and_own_file_limits() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    let diagnostics = Diagnostics::open(&logs, "fixture");
    let control = ProcessControl::new(diagnostics.clone());
    let expected = parent_spawn_failure(dir.path(), "missing-spawn-private-canary", &control);
    assert_eq!(control.pid.load(Ordering::SeqCst), 0);
    diagnostics.outcome(super::super::startup_diagnostics::Outcome::StartFailed);
    let until = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let observed = std::fs::read_dir(&logs)
            .unwrap()
            .flat_map(|entry| {
                let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
                assert!(!text.contains("private-canary"));
                text.lines()
                    .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                    .collect::<Vec<_>>()
            })
            .find(|value| value["startupOutcome"] == "start_failed");
        if let Some(value) = observed {
            assert_eq!(value["spawnFailure"]["osError"], expected);
            assert_eq!(value["childStarted"], false);
            #[cfg(unix)]
            {
                let mut limits = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                assert_eq!(
                    unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limits) },
                    0
                );
                for (name, limit) in [("soft", limits.rlim_cur), ("hard", limits.rlim_max)] {
                    let expected = if limit == libc::RLIM_INFINITY {
                        serde_json::json!({"kind":"infinite"})
                    } else {
                        serde_json::json!({"kind":"finite","value":limit})
                    };
                    assert_eq!(value["spawnFailure"]["fileLimit"][name], expected);
                }
            }
            #[cfg(not(unix))]
            {
                assert_eq!(
                    value["spawnFailure"]["fileLimit"],
                    serde_json::json!({"soft":{"kind":"unavailable"},"hard":{"kind":"unavailable"}})
                );
            }
            break;
        }
        assert!(std::time::Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn nonzero_child() -> async_process::Child {
    #[cfg(unix)]
    let mut command = {
        let mut command = async_process::Command::new("/bin/sh");
        command.args(["-c", "exit 17"]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command =
            async_process::Command::new(crate::windows_process::helper_executable().unwrap());
        // This synthetic fixture rejects unknown modes without spawning work.
        command.arg("nonzero-exit-observation");
        command
    };
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap()
}

#[tokio::test]
async fn exit_observation_respects_already_ready_process_and_connection_stop() {
    for connection in [false, true] {
        let (stop_tx, mut stop) = watch::channel(false);
        let (connection_tx, mut connection_stop) = watch::channel(false);
        let mut child = nonzero_child();
        let exited = tokio::time::timeout(Duration::from_secs(5), child.status())
            .await
            .unwrap()
            .unwrap();
        assert!(!exited.success());
        if connection {
            connection_tx.send_replace(true);
        } else {
            stop_tx.send_replace(true);
        }
        assert!(stop.has_changed().unwrap() || connection_stop.has_changed().unwrap());
        // Both futures are ready; deterministically exercise the exit branch
        // that an unbiased production select may also choose after user stop.
        let observed = tokio::select! {
            biased;
            value = child.status() => observe_exit(value, &stop, &connection_stop),
            _ = stop.changed() => panic!("cached child exit must be ready"),
            _ = connection_stop.changed() => panic!("cached child exit must be ready"),
        };
        assert!(!observed.0.unwrap().success());
        assert!(
            !observed.1,
            "an already visible stop makes this exit expected"
        );
    }
}

#[tokio::test]
async fn later_stop_does_not_erase_an_already_observed_unexpected_exit() {
    let (stop_tx, stop) = watch::channel(false);
    let (connection_tx, connection_stop) = watch::channel(false);
    let mut child = nonzero_child();
    let status = tokio::time::timeout(Duration::from_secs(5), child.status())
        .await
        .unwrap();
    let observed = observe_exit(status, &stop, &connection_stop);
    assert!(!observed.0.as_ref().unwrap().success());
    assert!(observed.1);
    stop_tx.send_replace(true);
    connection_tx.send_replace(true);
    assert!(
        observed.1,
        "cleanup intent cannot rewrite the earlier exit observation"
    );
}

#[test]
fn startup_diagnostics_cancel_selected_after_spawn_failure_keeps_cancelled_outcome() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    let diagnostics = Diagnostics::open(&logs, "fixture");
    let control = ProcessControl::new(diagnostics.clone());
    parent_spawn_failure(dir.path(), "missing-canary", &control);
    // The probe's biased branch selects cancellation when both are ready.
    diagnostics.outcome(super::super::startup_diagnostics::Outcome::Cancelled);
    let until = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let mut observed = None;
        for file in std::fs::read_dir(&logs).unwrap() {
            let text = std::fs::read_to_string(file.unwrap().path()).unwrap();
            assert!(!text.contains("missing-canary"));
            for line in text.lines() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line)
                    && v["event"] == "startup"
                    && v["startupOutcome"] != "unknown"
                {
                    observed = Some(v);
                }
            }
        }
        if let Some(value) = observed {
            assert_eq!(value["startupOutcome"], "cancelled");
            assert_eq!(value["childStarted"], false);
            break;
        }
        assert!(std::time::Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    }
}
