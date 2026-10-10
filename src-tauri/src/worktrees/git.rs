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
pub(super) fn execute_command(
    mut cmd: Command,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<Output> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut stdout = tempfile::tempfile().map_err(|_| error("unavailable"))?;
    let stderr = tempfile::tempfile().map_err(|_| error("unavailable"))?;
    cmd.stdout(stdout.try_clone().map_err(|_| error("unavailable"))?)
        .stderr(stderr.try_clone().map_err(|_| error("unavailable"))?);
    if cancel.load(Ordering::SeqCst) {
        return Err(error("cancelled"));
    }
    let mut child = cmd.spawn().map_err(|_| error("gitUnavailable"))?;
    let started = Instant::now();
    let mut stopped = None;
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
            if let Some(code) = stopped {
                return Err(error(code));
            }
            if [&stdout, &stderr]
                .into_iter()
                .any(|f| f.metadata().map_or(true, |m| m.len() > OUTPUT_LIMIT))
            {
                return Err(error("tooLarge"));
            }
            stdout
                .seek(SeekFrom::Start(0))
                .map_err(|_| error("unavailable"))?;
            let mut bytes = Vec::new();
            stdout
                .take(OUTPUT_LIMIT + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| error("unavailable"))?;
            return Ok(Output {
                success: status.success(),
                code: status.code(),
                bytes,
            });
        }
        if stopped.is_none() {
            let over = [&stdout, &stderr]
                .into_iter()
                .any(|f: &File| f.metadata().map_or(true, |s| s.len() > OUTPUT_LIMIT));
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
