//! These execute a built synthetic helper on Windows, never a real Agent.
//! CI builds `--example windows_process_fixture` before running this group.
use super::*;
use std::io::Write;
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
    assert!(!active(child.0.id()));
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
