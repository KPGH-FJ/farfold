//! Single actual process owner, sensitive bytes only in bounded private memory.
use super::{
    output::{STDERR_LIMIT, STDOUT_LIMIT},
    requests::Request,
    types::*,
};
use crate::{
    process_platform::{self, PipeReader},
    supervisor,
};
use std::{
    io::{self, Read},
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

struct Streams {
    out: PipeReader<io::PipeReader>,
    err: PipeReader<io::PipeReader>,
}
struct ChildOwner {
    child: Child,
    pid: u32,
    _group: process_platform::OwnedGroup,
    settled: bool,
}
impl Drop for ChildOwner {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        // Panic/early return must not release the caller's permits while a child
        // still exists. Actual cleanup has no fictitious OS completion deadline.
        supervisor::signal_owned_group(self.pid, supervisor::KILL);
        loop {
            let reaped = matches!(self.child.try_wait(), Ok(Some(_)));
            if reaped && !supervisor::owned_group_alive(self.pid) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}
fn spawn(mut command: Command) -> Result<(ChildOwner, Streams)> {
    // Configure both fallible pipe readers before spawn, no post-spawn conversion.
    let (out, child_out) = io::pipe().map_err(|_| Code::SpawnFailed)?;
    let (err, child_err) = io::pipe().map_err(|_| Code::SpawnFailed)?;
    let streams = Streams {
        out: PipeReader::new(out).map_err(|_| Code::SpawnFailed)?,
        err: PipeReader::new(err).map_err(|_| Code::SpawnFailed)?,
    };
    command
        .stdin(Stdio::null())
        .stdout(child_out)
        .stderr(child_err);
    let group = process_platform::prepare_command(&mut command).map_err(|_| Code::SpawnFailed)?;
    let mut child = command.spawn().map_err(|_| Code::SpawnFailed)?;
    drop(command); // Close all parent-side copies of child output handles.
    let pid = child.id();
    let group = match group.attach(pid) {
        Ok(group) => group,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Code::SpawnFailed.into());
        }
    };
    Ok((
        ChildOwner {
            child,
            pid,
            _group: group,
            settled: false,
        },
        streams,
    ))
}
fn drain(
    reader: &mut impl Read,
    bytes: &mut Vec<u8>,
    count: &mut usize,
    limit: usize,
    keep: bool,
) -> Result<bool> {
    let mut buffer = [0u8; 8192];
    // One bounded chunk per pipe per loop, so stderr cannot starve stdout/cancel.
    match reader.read(&mut buffer) {
        Ok(0) => Ok(true),
        Ok(read) => {
            *count = count.saturating_add(read);
            if *count > limit {
                buffer.fill(0);
                return Err(Code::OutputLimit.into());
            }
            if keep {
                bytes.extend_from_slice(&buffer[..read]);
            }
            buffer.fill(0);
            Ok(false)
        }
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) =>
        {
            Ok(false)
        }
        Err(_) => Err(Code::QueryFailed.into()),
    }
}
pub(super) fn run(command: Command, request: &Request) -> Result<Vec<u8>> {
    if !request.operation.interested() {
        return Err(Code::Cancelled.into());
    }
    if Instant::now() >= request.deadline {
        return Err(Code::TimedOut.into());
    }
    let (mut owner, mut streams) = spawn(command)?;
    let (mut out, mut discarded) = (Vec::new(), Vec::new());
    let (mut out_count, mut err_count) = (0, 0);
    let (mut out_done, mut err_done) = (false, false);
    let mut status: Option<ExitStatus> = None;
    let mut failure: Option<Failure> = None;
    let mut stopping: Option<Instant> = None;
    let mut killed = false;
    loop {
        if failure.is_none() {
            failure = if Instant::now() >= request.deadline {
                Some(Code::TimedOut.into())
            } else if !request.operation.interested() {
                Some(Code::Cancelled.into())
            } else {
                None
            };
        }
        if failure.is_some() && stopping.is_none() {
            stopping = Some(Instant::now());
            out.fill(0);
            out.clear();
            supervisor::signal_owned_group(owner.pid, supervisor::TERM);
        }
        if let Some(start) = stopping {
            if start.elapsed() >= Duration::from_secs(2) && !killed {
                supervisor::signal_owned_group(owner.pid, supervisor::KILL);
                killed = true;
            }
            if start.elapsed() >= Duration::from_secs(7) {
                request.progress(State::PendingCleanup, Some(Code::PendingCleanup));
            }
        }
        if !out_done {
            match drain(
                &mut streams.out,
                &mut out,
                &mut out_count,
                STDOUT_LIMIT,
                failure.is_none(),
            ) {
                Ok(done) => out_done = done,
                Err(error) => {
                    out_done = error.code != Code::OutputLimit;
                    failure.get_or_insert(error);
                }
            }
        }
        if !err_done {
            match drain(
                &mut streams.err,
                &mut discarded,
                &mut err_count,
                STDERR_LIMIT,
                false,
            ) {
                Ok(done) => err_done = done,
                Err(error) => {
                    err_done = error.code != Code::OutputLimit;
                    failure.get_or_insert(error);
                }
            }
        }
        if status.is_none() {
            match owner.child.try_wait() {
                Ok(next) => status = next,
                Err(_) => {
                    failure.get_or_insert(Code::QueryFailed.into());
                }
            }
        }
        if status.is_some() && out_done && err_done && !supervisor::owned_group_alive(owner.pid) {
            owner.settled = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if let Some(error) = failure {
        out.fill(0);
        return Err(error);
    }
    if !status.is_some_and(|status| status.success()) {
        out.fill(0);
        return Err(Code::QueryFailed.into());
    }
    Ok(out)
}
