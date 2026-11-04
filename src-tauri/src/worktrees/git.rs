//! Fixed official Git invocations. No shell, repository helper execution or config writes.
use super::types::{Result, error};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
#[cfg(windows)]
#[path = "git_bundle_output_windows.rs"]
pub(super) mod bundle_output;
#[cfg(all(windows, test))]
#[path = "git_command_observation_tests.rs"]
pub(super) mod command_observation;
#[cfg(windows)]
#[path = "git_debug_windows.rs"]
mod debug_windows;
#[path = "git_input.rs"]
mod input;
#[cfg(windows)]
#[path = "git_source_export_windows.rs"]
pub(super) mod source_export;
#[cfg(windows)]
#[path = "git_source_roots_windows.rs"]
pub(super) mod source_roots;
pub(super) use input::Input;
pub(super) const OUTPUT_LIMIT: u64 = 4 * 1024 * 1024;
pub(super) struct Output {
    pub success: bool,
    pub code: Option<i32>,
    pub bytes: Vec<u8>,
}
fn override_name(name: &str, case_insensitive: bool) -> bool {
    let folded;
    let name = if case_insensitive {
        folded = name.to_ascii_uppercase();
        &folded
    } else {
        name
    };
    name.starts_with("GIT_")
        && !matches!(
            name,
            "GIT_PAGER" | "GIT_EDITOR" | "GIT_SEQUENCE_EDITOR" | "GIT_TERMINAL_PROMPT"
        )
}
pub(super) fn environment() -> Result<()> {
    if std::env::vars_os().any(|(k, _)| k.to_str().is_some_and(|k| override_name(k, cfg!(windows))))
    {
        return Err(error("environmentOverride"));
    }
    Ok(())
}
#[cfg(unix)]
pub(super) fn command(root: &Path, args: &[&str]) -> Result<Command> {
    environment()?;
    if !cfg!(target_os = "macos") {
        return Err(error("unsupportedGit"));
    }
    let mut c = Command::new("/usr/bin/git");
    // Applies to registration as well as object reads: a source config/ref can change
    // after preflight. Missing objects must fail locally, never contact a promisor.
    c.env("GIT_NO_LAZY_FETCH", "1");
    c.arg("--no-pager")
        .arg("--no-replace-objects")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-c",
            "submodule.recurse=false",
            "-c",
            "worktree.guessRemote=false",
            "-c",
            "credential.helper=",
        ])
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    Ok(c)
}
pub(super) fn execute(
    root: &Path,
    args: &[&str],
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<Output> {
    #[cfg(windows)]
    {
        super::windows_git::execute(root, args, cancel, timeout)
    }
    #[cfg(unix)]
    {
        execute_command(command(root, args)?, cancel, timeout)
    }
}
// Unwinding must not orphan a Git child while its caller releases directory
// admission. Normal completion disables this guard only after group quiescence.
struct OwnedProcess {
    child: std::process::Child,
    #[cfg(unix)]
    group: i32,
    #[cfg(windows)]
    group: crate::process_platform::OwnedGroup,
    #[cfg(windows)]
    debug: debug_windows::DebugProcesses,
    finished: bool,
}
impl OwnedProcess {
    fn terminate_group(&self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        }
        #[cfg(windows)]
        self.group.terminate();
    }
    fn terminate(&mut self) {
        self.terminate_group();
        let _ = self.child.kill();
    }
    fn group_alive(&self) -> bool {
        #[cfg(unix)]
        {
            group_exists(self.group)
        }
        #[cfg(windows)]
        {
            self.debug_group_alive()
        }
    }
    #[cfg(windows)]
    fn debug_group_alive(&self) -> bool {
        match self.debug.confirmed(&self.group, &self.child) {
            Ok(confirmed) => !confirmed,
            Err(_) => {
                super::manager::mark_unknown();
                true
            }
        }
    }
}
impl std::ops::Deref for OwnedProcess {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.child
    }
}
impl std::ops::DerefMut for OwnedProcess {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.terminate();
        #[cfg(windows)]
        super::manager::mark_unknown();
        #[cfg(windows)]
        loop {
            let progressed = self.debug.drain(&self.group, &self.child).unwrap_or(false);
            let reaped = matches!(self.child.try_wait(), Ok(Some(_)));
            if reaped && !self.group_alive() {
                return;
            }
            if !progressed {
                thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(unix)]
        {
            loop {
                if self.child.wait().is_ok() {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            while self.group_alive() {
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}
pub(super) fn execute_command(
    cmd: Command,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<Output> {
    let stdout = tempfile::tempfile().map_err(|_| error("unavailable"))?;
    execute_bounded(cmd, None, cancel, timeout, stdout, OUTPUT_LIMIT, true)
}
pub(super) fn execute_command_input(
    cmd: Command,
    input: Input,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<Output> {
    let stdout = tempfile::tempfile().map_err(|_| error("unavailable"))?;
    execute_bounded(
        cmd,
        Some(input),
        cancel,
        timeout,
        stdout,
        OUTPUT_LIMIT,
        true,
    )
}
#[cfg(unix)]
pub(super) fn execute_to_file(
    cmd: Command,
    input: Input,
    cancel: &AtomicBool,
    timeout: Duration,
    stdout: File,
    limit: u64,
) -> Result<Output> {
    super::mutation_supported()?;
    execute_bounded(cmd, Some(input), cancel, timeout, stdout, limit, false)
}
fn execute_bounded(
    mut cmd: Command,
    input: Option<Input>,
    cancel: &AtomicBool,
    timeout: Duration,
    mut stdout: File,
    limit: u64,
    collect: bool,
) -> Result<Output> {
    #[cfg(all(windows, test))]
    let command_trace = command_observation::CommandObservation::new();
    #[cfg(windows)]
    let pending = crate::process_platform::prepare_noninteractive_git_command(&mut cmd)
        .map_err(|_| error("gitUnavailable"))?;
    #[cfg(windows)]
    let debug = debug_windows::DebugProcesses::new(&mut cmd).map_err(|_| error("unavailable"))?;
    if let Some(input) = &input {
        // The Windows wrapper intentionally rebuilds Command. Install the
        // explicit finite input only AFTER that replacement, not on the lost
        // original. The input remains alive until exact child/group cleanup.
        input.install(&mut cmd)?;
    } else {
        // Existing generic calls retain their exact platform behavior: null on
        // Windows, configured stdin untouched on Unix. Private callers below
        // use explicit Input, including index-pack's file rather than None.
        #[cfg(windows)]
        cmd.stdin(Stdio::null());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let stderr = tempfile::tempfile().map_err(|_| error("unavailable"))?;
    cmd.stdout(stdout.try_clone().map_err(|_| error("unavailable"))?)
        .stderr(stderr.try_clone().map_err(|_| error("unavailable"))?);
    if cancel.load(Ordering::SeqCst) {
        return Err(error("cancelled"));
    }
    let child = cmd.spawn().map_err(|_| error("gitUnavailable"))?;
    #[cfg(all(windows, test))]
    command_trace.emit("spawned", child.id(), None, None);
    #[cfg(windows)]
    drop(cmd);
    #[cfg(windows)]
    let (group, attached) = pending.attach_for_fixed_git(child.id());
    let mut child = OwnedProcess {
        #[cfg(unix)]
        group: child.id() as i32,
        #[cfg(windows)]
        group,
        #[cfg(windows)]
        debug,
        child,
        finished: false,
    };
    #[cfg(windows)]
    attached.map_err(|_| error("gitUnavailable"))?;
    let started = Instant::now();
    let mut stopped = None;
    #[cfg(windows)]
    let mut settling = false;
    #[cfg(all(windows, test))]
    let mut first_active_query = None;
    loop {
        #[cfg(windows)]
        let debug_progress = match child.debug.drain(&child.group, &child.child) {
            Ok(progressed) => progressed,
            Err(_) => {
                stopped.get_or_insert("unknown");
                super::manager::mark_unknown();
                child.terminate();
                false
            }
        };
        let waited = match child.try_wait() {
            Ok(value) => value,
            Err(_wait_error) => {
                stopped.get_or_insert("unknown");
                child.terminate();
                #[cfg(all(windows, test))]
                settlement_observation::emit(
                    "originalChildTryWaitError",
                    child.id(),
                    None,
                    _wait_error.raw_os_error(),
                    false,
                    stopped,
                );
                // Windows must keep pumping debug events before the exact
                // object can finish. A blocking wait here would strand it.
                #[cfg(windows)]
                {
                    None
                }
                #[cfg(unix)]
                match child.wait() {
                    Ok(status) => Some(status),
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                }
            }
        };
        if let Some(status) = waited {
            #[cfg(all(windows, test))]
            let group_alive = if first_active_query.is_none() {
                let (_, observation) = child.group.active_with_observation(&child.child);
                let active = child.debug_group_alive();
                if active {
                    command_trace.emit(
                        "firstActiveAfterOriginalExit",
                        child.id(),
                        status.code(),
                        stopped,
                    );
                    first_active_query = Some(observation);
                }
                active
            } else {
                child.group_alive()
            };
            #[cfg(not(all(windows, test)))]
            let group_alive = child.group_alive();
            #[cfg(all(windows, test))]
            if group_alive {
                settlement_tests::observed_active_after_original_exit(child.id(), status.code());
            }
            #[cfg(windows)]
            {
                // The retained helper's ExitStatus is not a Job completion
                // receipt: selected Git/descendant termination can still be
                // settling. Keep the SAME child, Job, caller admission and
                // original clock until that Job is confirmed inactive. Every
                // existing bound continues to apply during this interval.
                settling |= group_alive;
                if settling && stopped.is_none() {
                    stopped = stop_reason(
                        cancel,
                        started,
                        timeout,
                        &stdout,
                        &stderr,
                        limit,
                        input.as_ref(),
                    );
                }
                if group_alive && stopped.is_none() {
                    if !debug_progress {
                        #[cfg(test)]
                        let sleep_started = Instant::now();
                        thread::sleep(Duration::from_millis(10));
                        #[cfg(test)]
                        child.debug.observe_poll_sleep(sleep_started.elapsed());
                    }
                    continue;
                }
            }
            if group_alive {
                // Unix still rejects surviving helpers immediately. Windows
                // reaches this branch only after an original bound/error.
                stopped = Some(stopped.unwrap_or("unknown"));
                #[cfg(windows)]
                super::manager::mark_unknown();
                #[cfg(all(windows, test))]
                command_trace.emit(
                    "beforeOriginalTermination",
                    child.id(),
                    status.code(),
                    stopped,
                );
                #[cfg(all(windows, test))]
                child.group.emit_unsettled_observation(
                    "beforeOriginalTermination",
                    child.id(),
                    status.code(),
                    stopped,
                    first_active_query.as_ref(),
                );
                child.terminate_group();
                #[cfg(all(windows, test))]
                child.group.emit_unsettled_observation(
                    "afterOriginalTermination",
                    child.id(),
                    status.code(),
                    stopped,
                    first_active_query.as_ref(),
                );
                #[cfg(all(windows, test))]
                settlement_observation::emit(
                    "groupNotConfirmedInactiveAfterOriginalChild",
                    child.id(),
                    status.code(),
                    None,
                    true,
                    stopped,
                );
                while child.group_alive() {
                    #[cfg(windows)]
                    if matches!(child.debug.drain(&child.group, &child.child), Ok(true)) {
                        continue;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }
            child.finished = true;
            #[cfg(all(windows, test))]
            if command_trace.enabled() {
                command_trace.emit_certificate(child.id(), child.debug.observation());
            }
            #[cfg(all(windows, test))]
            command_trace.emit("settled", child.id(), status.code(), stopped);
            #[cfg(all(windows, test))]
            if let Some(observation) = first_active_query {
                observation.emit(child.id(), status.code(), stopped);
            }
            if let Some(code) = stopped {
                return Err(error(code));
            }
            if let Some(input) = &input {
                input.verify()?;
            }
            if stdout.metadata().map_or(true, |m| m.len() > limit)
                || stderr.metadata().map_or(true, |m| m.len() > OUTPUT_LIMIT)
            {
                return Err(error("tooLarge"));
            }
            #[cfg(all(windows, test))]
            super::windows_git::launch_matrix_tests::observe_settlement(
                status.code(),
                input.is_some(),
                &stderr,
            );
            #[cfg(all(windows, test))]
            if !status.success() {
                // Owned test diagnostics only, after the same Child/Job has
                // settled and the original stderr cap has passed. Observation
                // failure must not change the existing command result.
                let sample = (|| -> std::io::Result<Vec<u8>> {
                    let mut reader = stderr.try_clone()?;
                    reader.seek(SeekFrom::Start(0))?;
                    let mut sample = Vec::new();
                    reader.take(4097).read_to_end(&mut sample)?;
                    Ok(sample)
                })();
                let event = match sample {
                    Ok(sample) => serde_json::json!({
                        "exitCode": status.code(),
                        "stderrPrefix": String::from_utf8_lossy(&sample[..sample.len().min(4096)]),
                        "prefixTruncated": sample.len() > 4096,
                        "observationError": null,
                    }),
                    Err(error) => serde_json::json!({
                        "exitCode": status.code(),
                        "stderrPrefix": null,
                        "prefixTruncated": null,
                        "observationError": error.raw_os_error(),
                    }),
                };
                eprintln!("FARFOLD_WINDOWS_GIT_TEST_CHILD {event}");
            }
            stdout
                .seek(SeekFrom::Start(0))
                .map_err(|_| error("unavailable"))?;
            let mut bytes = Vec::new();
            if collect {
                stdout
                    .take(OUTPUT_LIMIT + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| error("unavailable"))?;
            } else {
                stdout.sync_all().map_err(|_| error("unavailable"))?;
            }
            return Ok(Output {
                success: status.success(),
                code: status.code(),
                bytes,
            });
        }
        if stopped.is_none() {
            let reason = stop_reason(
                cancel,
                started,
                timeout,
                &stdout,
                &stderr,
                limit,
                input.as_ref(),
            );
            if let Some(reason) = reason {
                stopped = Some(reason);
                child.terminate();
                // A cancellation never releases ownership before the exact child is reaped.
            }
        }
        #[cfg(windows)]
        if debug_progress {
            continue;
        }
        #[cfg(all(windows, test))]
        let sleep_started = Instant::now();
        thread::sleep(Duration::from_millis(10));
        #[cfg(all(windows, test))]
        child.debug.observe_poll_sleep(sleep_started.elapsed());
    }
}
fn stop_reason(
    cancel: &AtomicBool,
    started: Instant,
    timeout: Duration,
    stdout: &File,
    stderr: &File,
    limit: u64,
    input: Option<&Input>,
) -> Option<&'static str> {
    if cancel.load(Ordering::SeqCst) {
        Some("cancelled")
    } else if started.elapsed() >= timeout {
        Some("waitExpired")
    } else if stdout.metadata().map_or(true, |s| s.len() > limit)
        || stderr.metadata().map_or(true, |s| s.len() > OUTPUT_LIMIT)
    {
        Some("tooLarge")
    } else if input.is_some_and(|input| input.verify().is_err()) {
        Some("changed")
    } else {
        None
    }
}
pub(super) fn read(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let r = execute(root, args, &AtomicBool::new(false), Duration::from_secs(10))?;
    if r.success {
        Ok(r.bytes)
    } else {
        Err(error("unavailable"))
    }
}
#[cfg(unix)]
pub(super) fn text(root: &Path, args: &[&str]) -> Result<String> {
    let raw = read(root, args)?;
    String::from_utf8(raw)
        .map(|s| s.strip_suffix('\n').unwrap_or(&s).to_owned())
        .map_err(|_| error("unsupportedGit"))
}
#[cfg(unix)]
pub(super) fn config(root: &Path, name: &str, boolean: bool) -> Result<Option<String>> {
    let mut args = vec!["config"];
    if boolean {
        args.push("--type=bool");
    }
    args.extend(["--get", name]);
    let out = execute(
        root,
        &args,
        &AtomicBool::new(false),
        Duration::from_secs(10),
    )?;
    match out.code {
        Some(1) if out.bytes.is_empty() => Ok(None),
        Some(0) => String::from_utf8(out.bytes)
            .map(|s| Some(s.strip_suffix('\n').unwrap_or(&s).to_owned()))
            .map_err(|_| error("unsupportedGit")),
        _ => Err(error("unsupportedGit")),
    }
}

#[cfg(unix)]
fn group_exists(group: i32) -> bool {
    if unsafe { libc::kill(-group, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}
#[cfg(all(windows, test))]
#[path = "git_settlement_observation_tests.rs"]
mod settlement_observation;
#[cfg(all(windows, test))]
#[path = "git_settlement_windows_tests.rs"]
mod settlement_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_override_names_are_case_insensitive_without_changing_unix_rules() {
        assert!(override_name("git_dir", true));
        assert!(override_name("Git_Config_Count", true));
        assert!(!override_name("git_dir", false));
        assert!(!override_name("git_editor", true));
        assert!(override_name("GIT_COMMON_DIR", false));
        assert!(!override_name("NOT_GIT_DIR", true));
    }
    #[test]
    #[cfg(windows)]
    fn child_exit_with_live_job_descendant_is_not_a_success_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("descendant-pid");
        let mut command = Command::new(crate::windows_process::helper_executable().unwrap());
        command.arg("orphan").arg(&marker);
        let output = execute_command(command, &AtomicBool::new(false), Duration::from_secs(1));
        assert_eq!(output.err().unwrap().code, "waitExpired");
        // A live descendant may settle naturally within the original bound;
        // this 60-second orphan cannot. It must still never become success.
        // The separate cancellation case observes an exact handle.
        // execute_command only returns after exact-child reap and direct Job
        // inactivity. No descendant PID is signalled through a guessed lookup.
    }
    #[test]
    #[cfg(windows)]
    fn cancellation_waits_for_the_observed_selected_child_and_its_job() {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
        };
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("selected-pid");
        let cancel = AtomicBool::new(false);
        struct CancelOnDrop<'a>(&'a AtomicBool);
        impl Drop for CancelOnDrop<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        thread::scope(|scope| {
            let cancel = &cancel;
            let marker = &marker;
            let owner = scope.spawn(move || {
                let mut command =
                    Command::new(crate::windows_process::helper_executable().unwrap());
                command.arg("wait").arg(marker);
                execute_command(command, cancel, Duration::from_secs(10))
            });
            // Every assertion/timeout path cancels before scoped joining; no
            // guessed PID signal or unowned 60-second fixture is left behind.
            let _cancel_on_drop = CancelOnDrop(cancel);
            let deadline = Instant::now() + Duration::from_secs(5);
            let pid = loop {
                if let Ok(pid) = std::fs::read_to_string(marker)
                    .unwrap_or_default()
                    .parse::<u32>()
                {
                    break pid;
                }
                assert!(Instant::now() < deadline, "owned fixture readiness expired");
                thread::sleep(Duration::from_millis(10));
            };
            let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            assert!(!raw.is_null());
            let selected = unsafe { OwnedHandle::from_raw_handle(raw) };
            cancel.store(true, Ordering::SeqCst);
            assert_eq!(owner.join().unwrap().err().unwrap().code, "cancelled");
            assert_eq!(
                unsafe { WaitForSingleObject(selected.as_raw_handle(), 0) },
                0
            );
        });
    }
    #[test]
    #[cfg(unix)]
    fn child_exit_with_live_output_holder_is_not_success() {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", "sleep 0.4 & exit 0"]);
        let out = execute_command(c, &AtomicBool::new(false), Duration::from_secs(2));
        assert_eq!(out.err().unwrap().code, "unknown");
    }
    #[test]
    fn fast_stderr_over_limit_cannot_be_success() {
        let mut c = Command::new(crate::platform_tests::python());
        c.args(["-c", "import os; os.write(2,b'x'*(4*1024*1024+1))"]);
        assert_eq!(
            execute_command(c, &AtomicBool::new(false), Duration::from_secs(2))
                .err()
                .unwrap()
                .code,
            "tooLarge"
        );
    }
}

#[cfg(all(test, unix))]
#[test]
fn unwind_reaps_owned_process_before_directory_permit_can_drop() {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new("/bin/sleep");
    command.arg("30").process_group(0);
    let child = command.spawn().unwrap();
    let pid = child.id() as i32;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _process = OwnedProcess {
            child,
            group: pid,
            finished: false,
        };
        panic!("controlled process-owner unwind");
    }));
    assert!(result.is_err());
    assert!(!group_exists(pid));
    assert_eq!(
        unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}

#[cfg(test)]
#[path = "git_content_stream.rs"]
mod content_stream;
