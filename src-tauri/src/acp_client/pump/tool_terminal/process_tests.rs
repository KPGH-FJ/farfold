use super::Tail;

#[test]
fn retained_output_stays_at_character_boundaries_and_neutralizes_controls() {
    let mut tail = Tail::new(7);
    tail.append("前".as_bytes());
    tail.append("面🙂!".as_bytes());
    assert_eq!(tail.snapshot(), ("🙂!".into(), true));

    let mut tail = Tail::new(32);
    tail.append(b"\x1b]52\x07line\t\n");
    assert_eq!(tail.snapshot(), ("]52line\t\n".into(), false));

    let mut tail = Tail::new(1);
    tail.append(&[0xff]);
    assert_eq!(tail.snapshot(), (String::new(), true));
}

#[cfg(target_os = "macos")]
mod macos {
    use super::super::Process;
    use std::{fs, path::Path, process::Command, sync::Arc, time::Duration};
    use tokio::time::{sleep, timeout};

    const DEADLINE: Duration = Duration::from_secs(8);

    fn shell(cwd: &Path, script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.current_dir(cwd).args(["-c", script]);
        command
    }

    async fn pids(path: &Path, count: usize) -> Vec<libc::pid_t> {
        timeout(DEADLINE, async {
            loop {
                if let Ok(saved) = fs::read_to_string(path) {
                    let found: Vec<_> = saved
                        .split_whitespace()
                        .filter_map(|pid| pid.parse::<libc::pid_t>().ok())
                        .filter(|pid| *pid > 1)
                        .collect();
                    if found.len() == count && saved.ends_with('\n') {
                        return found;
                    }
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }

    fn exists(pid: libc::pid_t) -> bool {
        (unsafe { libc::kill(pid, 0) }) == 0
    }

    #[tokio::test]
    async fn stop_reaps_only_the_selected_shell_and_its_descendant() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let process_a = Arc::new(
            Process::spawn(
                shell(
                    a.path(),
                    "/bin/sleep 20 &\nchild=$!\nprintf '%s %s\\n' \"$$\" \"$child\" > pids\nwait \"$child\"\nprintf A-LATE > late",
                ),
                4096,
                None,
            )
            .unwrap(),
        );
        let process_b = Process::spawn(
            shell(
                b.path(),
                "printf '%s\\n' \"$$\" > pids\nfor i in 1 2 3 4 5 6 7 8 9 10; do\n  [ ! -f finish ] || { printf B-DONE; exit 0; }\n  /bin/sleep 1\ndone\nexit 4",
            ),
            4096,
                None,
        )
        .unwrap();
        let a_pids = pids(&a.path().join("pids"), 2).await;
        let b_pids = pids(&b.path().join("pids"), 1).await;
        assert!(a_pids.iter().chain(&b_pids).all(|pid| exists(*pid)));
        assert!(!process_a.exited());
        assert!(process_a.output().exit.is_none());
        let second = process_a.clone();
        let waiter = tokio::spawn(async move { second.wait().await });

        process_a.request_stop();
        let status = timeout(DEADLINE, process_a.wait()).await.unwrap().unwrap();
        assert_eq!(waiter.await.unwrap().unwrap(), status);
        assert!(process_a.exited());
        assert_eq!(process_a.output().exit, Some(status));
        assert!(!status.success());
        assert!(a_pids.iter().all(|pid| !exists(*pid)));
        assert!(b_pids.iter().all(|pid| exists(*pid)));
        assert!(!a.path().join("late").exists());

        fs::write(b.path().join("finish"), b"").unwrap();
        assert!(
            timeout(DEADLINE, process_b.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        assert_eq!(process_b.output().text, "B-DONE");
    }

    #[tokio::test]
    async fn an_exited_shell_does_not_release_the_group_while_its_child_is_live() {
        let root = tempfile::tempdir().unwrap();
        let process = Process::spawn(
            shell(
                root.path(),
                "trap '' TERM\n/bin/sleep 20 &\nprintf '%s %s\\n' \"$$\" \"$!\" > pids\nexit 0",
            ),
            4096,
            None,
        )
        .unwrap();
        let pids = pids(&root.path().join("pids"), 2).await;
        assert!(
            timeout(Duration::from_millis(100), process.wait())
                .await
                .is_err()
        );
        assert!(exists(pids[1]));
        assert!(!process.exited());
        assert!(process.output().exit.is_none());

        process.request_stop();
        // The leader's genuine exit code is retained even though a later
        // stop was needed to finish its still-running descendant, which
        // ignores SIGTERM and exercises the exact process-group escalation.
        assert!(
            timeout(DEADLINE, process.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        assert!(pids.iter().all(|pid| !exists(*pid)));
    }

    #[tokio::test]
    async fn shell_start_receives_only_its_explicit_environment() {
        let root = tempfile::tempdir().unwrap();
        let mut command = Command::new("/usr/bin/env");
        command
            .current_dir(root.path())
            .env("FF_TERMINAL_TEST", "approved");
        let process = Process::spawn(command, 4096, None).unwrap();
        assert!(
            timeout(DEADLINE, process.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        assert_eq!(process.output().text, "FF_TERMINAL_TEST=approved\n");
    }
}
