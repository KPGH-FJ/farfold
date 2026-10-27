//! These execute a built synthetic helper on Windows, never a real Agent.
//! CI builds `--example windows_process_fixture` before running this group.
use super::*;
use std::io::{Read, Write};
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

pub(super) fn fixture() -> std::path::PathBuf {
    let executable = std::env::current_exe().unwrap();
    let path = executable
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/windows_process_fixture.exe");
    assert!(
        path.is_file(),
        "build the Windows process fixture example first"
    );
    path
}
fn until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "bounded Windows fixture wait expired"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn child_handle(marker: &Path) -> Handle {
    until(|| std::fs::read_to_string(marker).is_ok_and(|s| s.parse::<u32>().is_ok()));
    let pid = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(!handle.is_null());
    Handle(handle)
}
fn exited(handle: &Handle) -> bool {
    unsafe { WaitForSingleObject(handle.0, 0) == 0 }
}
struct Parent(std::process::Child);
impl Drop for Parent {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn spawn_owned(args: &[&OsStr]) -> (std::process::Child, OwnedGroup) {
    let pending = pending().unwrap();
    let path = fixture();
    let child = Command::new(&path)
        .args(pending.helper_argv(
            path.as_os_str(),
            args.iter().map(|s| s.to_os_string()),
            false,
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let group = pending.attach(child.id()).unwrap();
    (child, group)
}

#[test]
fn helper_failure_never_starts_selected_work() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("must-not-exist");
    let name = format!("{PREFIX}{}", "0".repeat(32));
    let mut child = Parent(
        Command::new(fixture())
            .args([
                OsStr::new(HELPER),
                OsStr::new(&name),
                OsStr::new("stdio"),
                fixture().as_os_str(),
                OsStr::new("wait"),
                marker.as_os_str(),
            ])
            .spawn()
            .unwrap(),
    );
    until(|| child.0.try_wait().unwrap().is_some());
    let status = child.0.wait().unwrap();
    assert_eq!(status.code(), Some(126));
    assert!(!marker.exists());
}
#[test]
fn cancellation_before_helper_job_entry_never_starts_selected_work() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("must-not-start");
    let ready = directory.path().join("helper-waiting");
    let (child, group) = spawn_owned(&[
        OsStr::new("wait"),
        marker.as_os_str(),
        OsStr::new("--fixture-delay-helper"),
        ready.as_os_str(),
    ]);
    let mut child = Parent(child);
    until(|| ready.is_file());
    // The original helper is still a live owned object before entering its Job.
    assert!(active(child.0.id()));
    terminate(child.0.id());
    std::fs::remove_file(&ready).unwrap();
    until(|| child.0.try_wait().unwrap().is_some());
    assert!(!marker.exists());
    assert!(!active(child.0.id()));
    drop(group);
}
#[test]
fn leader_exit_does_not_release_live_descendants() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("child");
    let (mut child, group) = spawn_owned(&[OsStr::new("orphan"), marker.as_os_str()]);
    let descendant = child_handle(&marker);
    until(|| child.try_wait().unwrap().is_some());
    assert!(active(child.id()));
    assert!(!exited(&descendant));
    terminate(child.id());
    until(|| exited(&descendant) && !active(child.id()));
    drop(group);
}
#[test]
fn failed_attach_waits_for_original_child_and_unregistered_job_descendants() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("unregistered-child");
    let pending = pending().unwrap();
    let path = fixture();
    let mut child = Parent(
        Command::new(&path)
            .args(pending.helper_argv(
                path.as_os_str(),
                [OsString::from("orphan"), marker.clone().into_os_string()],
                false,
            ))
            .spawn()
            .unwrap(),
    );
    let descendant = child_handle(&marker);
    until(|| child.0.try_wait().unwrap().is_some());
    assert!(pending.0.active());
    assert!(!owns(child.0.id()));
    assert!(!exited(&descendant));
    let mut reaped = false;
    // PID zero deterministically rejects OpenProcess. The actual child and its
    // Job are real; no registry lookup can prove this unregistered Job ended.
    let result = pending.attach_or_reap(Some(0), || {
        let _ = child.0.kill();
        reaped = child.0.try_wait().unwrap().is_some();
        reaped
    });
    assert!(result.is_err());
    assert!(reaped);
    assert!(exited(&descendant));
    assert!(!pending.0.active());
}
#[test]
fn missing_pid_failure_reaps_the_helper_before_job_entry() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("must-not-start");
    let ready = directory.path().join("waiting-before-entry");
    let pending = pending().unwrap();
    let path = fixture();
    let mut child = Parent(
        Command::new(&path)
            .args(pending.helper_argv(
                path.as_os_str(),
                [
                    OsString::from("wait"),
                    marker.clone().into_os_string(),
                    OsString::from("--fixture-delay-helper"),
                    ready.clone().into_os_string(),
                ],
                false,
            ))
            .spawn()
            .unwrap(),
    );
    until(|| ready.is_file());
    assert!(!pending.0.active());
    let mut reaped = false;
    let result = pending.attach_or_reap(None, || {
        let _ = child.0.kill();
        reaped = child.0.try_wait().unwrap().is_some();
        reaped
    });
    assert!(result.is_err());
    assert!(reaped);
    assert!(!pending.0.active());
    assert!(!marker.exists());
}
#[test]
fn losing_the_parent_process_closes_its_job_and_stops_work() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("child");
    let ready = directory.path().join("ready");
    let mut parent = Parent(
        Command::new(fixture())
            .arg("parent")
            .arg(&marker)
            .arg(&ready)
            .spawn()
            .unwrap(),
    );
    until(|| ready.is_file());
    let descendant = child_handle(&marker);
    parent.0.kill().unwrap();
    parent.0.wait().unwrap();
    until(|| exited(&descendant));
}
#[test]
fn helper_preserves_literal_arguments_stdio_cwd_environment_and_exit_code() {
    let directory = tempfile::tempdir().unwrap();
    let pending = pending().unwrap();
    let fixture = fixture();
    let argv = [
        "argv",
        "space value",
        "& %PATH% literal",
        "",
        "quote\"value",
    ]
    .map(OsString::from);
    let mut child = Command::new(&fixture)
        .args(pending.helper_argv(fixture.as_os_str(), argv, false))
        .env("FIXTURE_LITERAL", "value")
        .current_dir(directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let _group = pending.attach(child.id()).unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"synthetic input")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(23));
    let observed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        observed["args"],
        serde_json::json!(["space value", "& %PATH% literal", "", "quote\"value"])
    );
    assert_eq!(observed["input"], "synthetic input");
    assert_eq!(observed["env"], "value");
    assert_eq!(
        std::path::PathBuf::from(observed["cwd"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        directory.path().canonicalize().unwrap()
    );
}

fn pipe_state(pipe: &impl std::os::windows::io::AsRawHandle) -> io::Result<(u32, bool)> {
    use windows_sys::Win32::{Foundation::ERROR_BROKEN_PIPE, System::Pipes::PeekNamedPipe};
    let mut available = 0;
    if unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle().cast(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    } != 0
    {
        return Ok((available, false));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
        Ok((0, true))
    } else {
        Err(error)
    }
}

struct EofOwner {
    child: Parent,
    group: OwnedGroup,
}
impl Drop for EofOwner {
    fn drop(&mut self) {
        // Also runs on any fixture/assertion failure: stop the exact owned Job
        // before Parent reaps its original helper. Never infer reap from EOF.
        self.group.terminate();
        let _ = self.child.0.kill();
        let _ = self.child.0.wait();
    }
}

fn observe_stdout_eof(case: &str) -> bool {
    let directory = tempfile::tempdir().unwrap();
    let pending = pending().unwrap();
    let fixture = fixture();
    let mut child = Parent(
        Command::new(&fixture)
            .args(pending.helper_argv(
                fixture.as_os_str(),
                [
                    OsString::from("stdout-eof"),
                    directory.path().into(),
                    OsString::from(case),
                ],
                false,
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let group = pending
        .attach_or_reap(Some(child.0.id()), || {
            let _ = child.0.kill();
            matches!(child.0.try_wait(), Ok(Some(_)))
        })
        .unwrap();
    let mut owner = EofOwner { child, group };
    let stdout = owner.child.0.stdout.take().unwrap();
    let mut stderr = owner.child.0.stderr.take().unwrap();
    let selected = child_handle(&directory.path().join("selected-pid"));
    let marker_deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::new();
    while !bytes.contains(&b'\n') && bytes.len() < 1024 && Instant::now() < marker_deadline {
        match pipe_state(&stderr) {
            Ok((available, false)) if available > 0 => {
                // This is the only reader. Read no more than the bytes Peek
                // just observed; neither this phase nor EOF uses blocking IO.
                let length = (available as usize).min(1024 - bytes.len());
                let start = bytes.len();
                bytes.resize(start + length, 0);
                if stderr.read_exact(&mut bytes[start..]).is_err() {
                    break;
                }
            }
            Ok((_, true)) | Err(_) => break,
            _ => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let closed = case == "closed";
    let marker = std::str::from_utf8(&bytes)
        .ok()
        .filter(|line| line.ends_with('\n'))
        .and_then(|line| line.strip_prefix("FARFOLD_STDIO_SELECTED "))
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());
    let marker_complete = marker.as_ref().is_some_and(|value| {
        value["case"] == case
            && value["pipeConfirmed"] == true
            && value["closeAttempted"] == closed
            && value["closeSucceeded"] == closed
    });
    if marker_complete {
        // Preserve the actual fixed ASCII marker bytes from the independent
        // selected stderr stream, not a reconstructed close-success receipt.
        std::io::stderr().write_all(&bytes).unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut eof = false;
    let mut probe_failed = false;
    let mut probe_error = None;
    while marker_complete && Instant::now() < deadline {
        match pipe_state(&stdout) {
            Ok((0, true)) => {
                eof = true;
                break;
            }
            Ok(_) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                probe_failed = true;
                probe_error = error.raw_os_error();
                break;
            }
        }
    }
    let selected_alive = unsafe {
        WaitForSingleObject(selected.0, 0) == windows_sys::Win32::Foundation::WAIT_TIMEOUT
    };
    let helper_alive = matches!(owner.child.0.try_wait(), Ok(None));
    let job_query = owner.group.job.activity_query();
    let job_active = job_query.ok != 0 && job_query.info.ActiveProcesses > 0;
    let stderr_alive = matches!(pipe_state(&stderr), Ok((0, false)));
    eprintln!(
        "FARFOLD_STDIO_EOF_OBSERVATION {}",
        serde_json::json!({"case":case,"markerComplete":marker_complete,
            "selectedStdoutClosed":closed && marker_complete,"eofBeforeRelease":eof,
            "selectedAliveBeforeRelease":selected_alive,"helperAliveBeforeRelease":helper_alive,
            "jobActiveBeforeRelease":job_active,"stderrAliveBeforeRelease":stderr_alive,
            "jobQuerySucceededBeforeRelease":job_query.ok != 0,
            "stdoutProbeFailed":probe_failed,"stdoutProbeError":probe_error})
    );
    std::fs::write(directory.path().join("stdout-release"), "release").unwrap();
    let cleanup_deadline = Instant::now() + Duration::from_secs(5);
    let mut status = None;
    while Instant::now() < cleanup_deadline {
        status = owner.child.0.try_wait().unwrap();
        if status.is_some() && exited(&selected) && !owner.group.active() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let selected_exited = exited(&selected);
    let helper_reaped = status.is_some();
    let job_inactive = !owner.group.active();
    let stdout_eof = matches!(pipe_state(&stdout), Ok((0, true)));
    let stderr_eof = matches!(pipe_state(&stderr), Ok((0, true)));
    eprintln!(
        "FARFOLD_STDIO_EOF_CLEANUP {}",
        serde_json::json!({"case":case,"selectedExited":selected_exited,
            "helperExitCode":status.and_then(|s|s.code()),"helperReaped":helper_reaped,
            "jobInactive":job_inactive,"stdoutEofAfterReap":stdout_eof,"stderrEofAfterReap":stderr_eof})
    );
    marker_complete
        && !probe_failed
        && eof == closed
        && selected_alive
        && helper_alive
        && job_active
        && stderr_alive
        && selected_exited
        && helper_reaped
        && status.is_some_and(|s| s.code() == Some(23))
        && job_inactive
        && stdout_eof
        && stderr_eof
}

#[test]
fn helper_stdout_eof_is_independent_of_selected_exit_with_open_pipe_countercontrol() {
    // Complete and record both actual exit/reap sequences before asserting the
    // EOF invariant, so a meaningful baseline failure does not leak the child.
    let held_open = observe_stdout_eof("held-open");
    let closed = observe_stdout_eof("closed");
    assert!(
        held_open && closed,
        "owned stdout EOF/countercontrol failed"
    );
}

#[test]
fn helper_stdout_handoff_native_guards_preserve_standard_handles() {
    // Only this independent fixture changes its own standard slots. Neither
    // prepare nor SetStdHandle runs in the parallel libtest process.
    let directory = tempfile::tempdir().unwrap();
    let mut child = Parent(
        Command::new(fixture())
            .arg("stdout-handoff-guards")
            .arg(directory.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut status = None;
    while Instant::now() < deadline {
        status = child.0.try_wait().unwrap();
        if status.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut observed: serde_json::Value =
        std::fs::read(directory.path().join("stdout-handoff-guards.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_else(|| serde_json::json!({"cases":[],"reportAvailable":false}));
    observed["fixtureExited"] = serde_json::json!(status.is_some());
    observed["fixtureExitCode"] = serde_json::json!(status.and_then(|value| value.code()));
    if status.is_some() {
        let mut stderr = Vec::new();
        child
            .0
            .stderr
            .take()
            .unwrap()
            .take(4096)
            .read_to_end(&mut stderr)
            .unwrap();
        observed["fixtureStderr"] = serde_json::json!(String::from_utf8_lossy(&stderr));
    }
    // Emit every available native subcase even if its prerequisite or guard
    // fails. A missing denied-query prerequisite is a failure, never a pass.
    eprintln!("FARFOLD_STDOUT_HANDOFF_GUARDS {observed}");
    assert!(
        status.is_some_and(|value| value.success()),
        "fixture did not finish successfully"
    );
    assert_eq!(observed["schemaVersion"], 1);
    assert_eq!(observed["caseCount"], 10);
    assert_eq!(observed["requiredCaseCount"], 10);
    assert_eq!(observed["originalSlotsRestored"], true);
    let cases = observed["cases"]
        .as_array()
        .expect("native case observations");
    let names = [
        "exclusive-inheritable",
        "exclusive-noninheritable",
        "stdout-equals-stderr",
        "stdout-equals-stdin",
        "nul",
        "ordinary-file",
        "null",
        "invalid",
        "protect-from-close",
        "write-only-query-denied",
    ];
    assert_eq!(cases.len(), names.len());
    for (case, name) in cases.iter().zip(names) {
        assert_eq!(case["case"], name);
        assert_eq!(case["passed"], true, "native guard case: {name}");
        assert_eq!(case["slotsUnchangedDuring"], true);
        assert_eq!(case["slotsUnchangedAfterDrop"], true);
        assert_eq!(case["flagsRestored"], true);
        assert_eq!(case["handlesRetained"], true);
    }
    for case in &cases[..2] {
        assert_eq!(case["pipeQuerySucceeded"], true);
        assert_eq!(case["nativeEligible"], true);
        assert_eq!(case["prepared"], true);
        assert_eq!(case["writeSucceeded"], true);
        assert_eq!(case["pipeBytesReadBack"], true);
    }
    for case in &cases[2..] {
        assert_eq!(case["prepared"], false);
    }
    let inherit = windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT as u64;
    assert_ne!(cases[0]["flagsBefore"][1].as_u64().unwrap() & inherit, 0);
    assert_eq!(cases[1]["flagsBefore"][1].as_u64().unwrap() & inherit, 0);
    assert_eq!(cases[2]["stdoutEqualsStderr"], true);
    assert_eq!(cases[3]["stdoutEqualsStdin"], true);
    assert_eq!(
        cases[4]["fileType"],
        windows_sys::Win32::Storage::FileSystem::FILE_TYPE_CHAR
    );
    assert_eq!(
        cases[5]["fileType"],
        windows_sys::Win32::Storage::FileSystem::FILE_TYPE_DISK
    );
    assert_eq!(cases[5]["fileBytesReadBack"], true);
    let protect = windows_sys::Win32::Foundation::HANDLE_FLAG_PROTECT_FROM_CLOSE as u64;
    assert_ne!(cases[8]["flagsBefore"][1].as_u64().unwrap() & protect, 0);
    assert_eq!(cases[8]["writeSucceeded"], true);
    assert_eq!(cases[8]["pipeBytesReadBack"], true);
    assert_eq!(cases[9]["negativePrerequisiteAvailable"], true);
    assert_eq!(cases[9]["pipeQuerySucceeded"], false);
    assert_eq!(
        cases[9]["pipeQueryError"],
        windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED
    );
    assert_eq!(cases[9]["writeSucceeded"], true);
    assert_eq!(cases[9]["pipeBytesReadBack"], true);
}

fn noninteractive_git_output(mut command: Command, input: &[u8]) -> std::process::Output {
    let pending = prepare_noninteractive_git_command(&mut command).unwrap();
    assert_eq!(command.get_args().nth(2), Some(OsStr::new("git-stdio")));
    let mut child = Parent(
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let group = pending.attach(child.0.id()).unwrap();
    child.0.stdin.take().unwrap().write_all(input).unwrap();
    until(|| child.0.try_wait().unwrap().is_some());
    let status = child.0.wait().unwrap();
    // The selected fixtures emit less than4KiB. Keep original handles and Job
    // through the same exit checks; an unknown member still fails this control.
    until(|| !group.active());
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    child
        .0
        .stdout
        .take()
        .unwrap()
        .take(4096)
        .read_to_end(&mut stdout)
        .unwrap();
    child
        .0
        .stderr
        .take()
        .unwrap()
        .take(4096)
        .read_to_end(&mut stderr)
        .unwrap();
    assert!(stdout.len() < 4096 && stderr.len() < 4096);
    std::process::Output {
        status,
        stdout,
        stderr,
    }
}

#[test]
fn noninteractive_git_helper_preserves_literal_arguments_stdio_cwd_environment_and_exit_code() {
    let directory = tempfile::tempdir().unwrap();
    for remove in [false, true] {
        let mut command = Command::new(fixture());
        command
            .args([
                "argv",
                "space value",
                "& %PATH% literal",
                "",
                "quote\"value",
                "中文🙂",
                "trailing \\",
            ])
            .current_dir(directory.path())
            .env("FIXTURE_LITERAL", "exact value");
        if remove {
            command.env_remove("FIXTURE_LITERAL");
        }
        let output = noninteractive_git_output(command, b"synthetic input\nsecond line");
        assert_eq!(output.status.code(), Some(23));
        assert!(output.stderr.is_empty());
        let observed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            observed["args"],
            serde_json::json!([
                "space value",
                "& %PATH% literal",
                "",
                "quote\"value",
                "中文🙂",
                "trailing \\",
            ])
        );
        assert_eq!(observed["input"], "synthetic input\nsecond line");
        assert_eq!(observed["env"], if remove { "" } else { "exact value" });
        assert_eq!(
            std::path::PathBuf::from(observed["cwd"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            directory.path().canonicalize().unwrap()
        );
    }
}

#[test]
fn noninteractive_git_helper_preserves_stderr_and_original_failure_exit() {
    let mut command = Command::new(fixture());
    command.arg("install-error");
    let output = noninteractive_git_output(command, b"");
    assert_eq!(output.status.code(), Some(13));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr,
        b"npm error code EACCES\nAuthorization: Bearer fixture-secret\nhttps://user:password@example.invalid/private?token=secret\n"
    );
}
