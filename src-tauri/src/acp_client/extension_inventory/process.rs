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
    input: Option<std::process::ChildStdin>,
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
fn spawn(mut command: Command, interactive: bool) -> Result<(ChildOwner, Streams)> {
    // Configure both fallible pipe readers before spawn, no post-spawn conversion.
    let (out, child_out) = io::pipe().map_err(|_| Code::SpawnFailed)?;
    let (err, child_err) = io::pipe().map_err(|_| Code::SpawnFailed)?;
    let mut streams = Streams {
        out: PipeReader::new(out).map_err(|_| Code::SpawnFailed)?,
        err: PipeReader::new(err).map_err(|_| Code::SpawnFailed)?,
        input: None,
    };
    command
        .stdin(if interactive {
            Stdio::piped()
        } else {
            Stdio::null()
        })
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
    let mut owner = ChildOwner {
        child,
        pid,
        _group: group,
        settled: false,
    };
    if interactive {
        let input = owner.child.stdin.take().ok_or(Code::SpawnFailed)?;
        nonblocking_input(&input)?;
        streams.input = Some(input);
    }
    Ok((owner, streams))
}
#[cfg(unix)]
fn nonblocking_input(input: &std::process::ChildStdin) -> Result<()> {
    use std::os::fd::AsRawFd;
    let fd = input.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(Code::SpawnFailed.into());
    }
    Ok(())
}
#[cfg(not(unix))]
fn nonblocking_input(_: &std::process::ChildStdin) -> Result<()> {
    Err(Code::PlatformUnsupported.into())
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
// A transport seam for the two fixed exchanges only; it exposes no RPC method API.
pub(in crate::acp_client) trait FixedExchange {
    fn write(&mut self, writer: &mut std::process::ChildStdin) -> Result<()>;
    fn received(&mut self, bytes: &mut Vec<u8>) -> Result<()>;
    fn done(&self) -> bool;
}
pub(in crate::acp_client) trait Control {
    fn interested(&self) -> bool;
    fn deadline(&self) -> Instant;
    fn pending_cleanup(&self);
    fn spawned(&self) {}
}
impl Control for Request {
    fn interested(&self) -> bool {
        self.operation.interested()
    }
    fn deadline(&self) -> Instant {
        self.deadline
    }
    fn pending_cleanup(&self) {
        self.progress(State::PendingCleanup, Some(Code::PendingCleanup));
    }
}
struct ScopedSkillsExchange {
    rpc: super::skills_rpc::Exchange,
    roots: super::extra_skill_roots::PinnedRoots,
}
impl FixedExchange for ScopedSkillsExchange {
    fn write(&mut self, writer: &mut std::process::ChildStdin) -> Result<()> {
        if !self.roots.current() {
            return Err(Code::CwdUnavailable.into());
        }
        self.rpc.write(writer)
    }
    fn received(&mut self, bytes: &mut Vec<u8>) -> Result<()> {
        if !self.roots.current() {
            return Err(Code::CwdUnavailable.into());
        }
        self.rpc.received(bytes)
    }
    fn done(&self) -> bool {
        self.rpc.done()
    }
}
pub(super) fn run(command: Command, request: &Request) -> Result<Vec<u8>> {
    run_owned(command, request, None, STDOUT_LIMIT)
}
#[cfg(test)]
pub(super) fn run_skills(command: Command, request: &Request) -> Result<SkillsInventory> {
    run_skills_private(command, request).map(|v| v.0)
}
pub(super) fn run_skills_private(
    command: Command,
    request: &Request,
) -> Result<(SkillsInventory, Vec<super::targets::SkillTarget>)> {
    let roots = super::extra_skill_roots::PinnedRoots::open(&request.extra_skill_roots)?;
    let rpc = super::skills_rpc::Exchange::with_roots(
        request.cwd.as_deref().ok_or(Code::InvalidRequest)?,
        &roots.paths(),
    )?;
    let mut exchange = ScopedSkillsExchange { rpc, roots };
    let mut out = run_owned(command, request, Some(&mut exchange), STDOUT_LIMIT)?;
    let targets = exchange.rpc.take_targets();
    let result = exchange.rpc.finish(&out);
    out.fill(0);
    if !exchange.roots.current() {
        return Err(Code::CwdUnavailable.into());
    }
    result.map(|v| (v, targets))
}
pub(in crate::acp_client) fn run_owned(
    command: Command,
    request: &dyn Control,
    mut rpc: Option<&mut dyn FixedExchange>,
    stdout_limit: usize,
) -> Result<Vec<u8>> {
    if !request.interested() {
        return Err(Code::Cancelled.into());
    }
    if Instant::now() >= request.deadline() {
        return Err(Code::TimedOut.into());
    }
    let (mut owner, mut streams) = spawn(command, rpc.is_some())?;
    request.spawned();
    let (mut out, mut discarded) = (Vec::new(), Vec::new());
    let (mut out_count, mut err_count) = (0, 0);
    let (mut out_done, mut err_done) = (false, false);
    let mut status: Option<ExitStatus> = None;
    let mut failure: Option<Failure> = None;
    let mut stopping: Option<Instant> = None;
    let mut killed = false;
    loop {
        if failure.is_none() {
            failure = if Instant::now() >= request.deadline() {
                Some(Code::TimedOut.into())
            } else if !request.interested() {
                Some(Code::Cancelled.into())
            } else {
                None
            };
        }
        if failure.is_some() && stopping.is_none() {
            stopping = Some(Instant::now());
            streams.input.take();
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
                request.pending_cleanup();
            }
        }
        if failure.is_none()
            && let Some(exchange) = rpc.as_mut()
            && let Some(input) = streams.input.as_mut()
            && let Err(error) = exchange.write(input)
        {
            failure = Some(error);
        }
        if !out_done {
            match drain(
                &mut streams.out,
                &mut out,
                &mut out_count,
                stdout_limit,
                failure.is_none(),
            ) {
                Ok(done) => out_done = done,
                Err(error) => {
                    out_done = error.code != Code::OutputLimit;
                    failure.get_or_insert(error);
                }
            }
        }
        if failure.is_none()
            && let Some(exchange) = rpc.as_mut()
        {
            if let Err(error) = exchange.received(&mut out) {
                failure = Some(error);
            }
            if exchange.done() {
                streams.input.take();
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
