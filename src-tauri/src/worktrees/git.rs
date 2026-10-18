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
pub(super) const OUTPUT_LIMIT: u64 = 4 * 1024 * 1024;
pub(super) struct Output {
    pub success: bool,
    pub code: Option<i32>,
    pub bytes: Vec<u8>,
}
pub(super) fn environment() -> Result<()> {
    if std::env::vars_os().any(|(k, _)| {
        k.to_str().is_some_and(|k| {
            k.starts_with("GIT_")
                && !matches!(
                    k,
                    "GIT_PAGER" | "GIT_EDITOR" | "GIT_SEQUENCE_EDITOR" | "GIT_TERMINAL_PROMPT"
                )
        })
    }) {
        return Err(error("environmentOverride"));
    }
    Ok(())
}
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
    execute_command(command(root, args)?, cancel, timeout)
}
// Unwinding must not orphan a Git child while its caller releases directory
// admission. Normal completion disables this guard only after group quiescence.
struct OwnedProcess {
    child: std::process::Child,
    #[cfg(unix)]
    group: i32,
    finished: bool,
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
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.group, libc::SIGKILL);
        }
        let _ = self.child.kill();
        loop {
            if self.child.wait().is_ok() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        #[cfg(unix)]
        while group_exists(self.group) {
            thread::sleep(Duration::from_millis(10));
        }
    }
}
pub(super) fn execute_command(
    cmd: Command,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<Output> {
    let stdout = tempfile::tempfile().map_err(|_| error("unavailable"))?;
    execute_bounded(cmd, cancel, timeout, stdout, OUTPUT_LIMIT, true)
}
pub(super) fn execute_to_file(
    cmd: Command,
    cancel: &AtomicBool,
    timeout: Duration,
    stdout: File,
    limit: u64,
) -> Result<Output> {
    execute_bounded(cmd, cancel, timeout, stdout, limit, false)
}
fn execute_bounded(
    mut cmd: Command,
    cancel: &AtomicBool,
    timeout: Duration,
    mut stdout: File,
    limit: u64,
    collect: bool,
) -> Result<Output> {
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
    let mut child = OwnedProcess {
        #[cfg(unix)]
        group: child.id() as i32,
        child,
        finished: false,
    };
    let started = Instant::now();
    let mut stopped = None;
    #[cfg(unix)]
    let group = child.id() as i32;
    loop {
        let waited = match child.try_wait() {
            Ok(value) => value,
            Err(_) => {
                stopped = Some("unknown");
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                // Keep the admission until wait confirms this child has ended.
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
            #[cfg(unix)]
            if group_exists(group) {
                // Git should join its helpers. A surviving process is not a successful receipt.
                stopped = Some(stopped.unwrap_or("unknown"));
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
                while group_exists(group) {
                    thread::sleep(Duration::from_millis(10));
                }
            }
            child.finished = true;
            if let Some(code) = stopped {
                return Err(error(code));
            }
            if stdout.metadata().map_or(true, |m| m.len() > limit)
                || stderr.metadata().map_or(true, |m| m.len() > OUTPUT_LIMIT)
            {
                return Err(error("tooLarge"));
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
            let over = stdout.metadata().map_or(true, |s| s.len() > limit)
                || stderr.metadata().map_or(true, |s| s.len() > OUTPUT_LIMIT);
            let reason = if cancel.load(Ordering::SeqCst) {
                Some("cancelled")
            } else if started.elapsed() >= timeout {
                Some("waitExpired")
            } else if over {
                Some("tooLarge")
            } else {
                None
            };
            if let Some(reason) = reason {
                stopped = Some(reason);
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                // A cancellation never releases ownership before the exact child is reaped.
            }
        }
        thread::sleep(Duration::from_millis(10));
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
pub(super) fn text(root: &Path, args: &[&str]) -> Result<String> {
    let raw = read(root, args)?;
    String::from_utf8(raw)
        .map(|s| s.strip_suffix('\n').unwrap_or(&s).to_owned())
        .map_err(|_| error("unsupportedGit"))
}
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
#[cfg(test)]
mod tests {
    use super::*;
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
        let mut c = Command::new("/usr/bin/python3");
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
