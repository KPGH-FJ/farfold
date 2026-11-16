//! Owns the command and its group after a one-time local approval.
use std::{
    collections::VecDeque,
    io,
    path::PathBuf,
    process::{Command, ExitStatus},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::Thread,
};

use tokio::sync::watch;

pub(super) struct Output {
    pub text: String,
    pub truncated: bool,
    pub exit: Option<ExitStatus>,
}

pub(super) struct Process {
    output: Arc<Mutex<Tail>>,
    started: watch::Receiver<Option<Result<(), io::ErrorKind>>>,
    exit: watch::Receiver<Option<Result<ExitStatus, io::ErrorKind>>>,
    stop: Arc<AtomicBool>,
    worker: Thread,
}

impl Process {
    /// The caller supplies the exact approved executable, argv, cwd, and child
    /// environment. No login or provider environment is added here.
    pub(super) fn spawn(
        command: Command,
        output_limit: usize,
        recovery_dir: Option<PathBuf>,
    ) -> io::Result<Self> {
        #[cfg(target_os = "macos")]
        {
            macos::spawn(command, output_limit, recovery_dir)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (command, output_limit, recovery_dir);
            Err(io::ErrorKind::Unsupported.into())
        }
    }

    pub(super) fn output(&self) -> Output {
        // Read exit first. Once it is available, the writer has finalized the
        // output and no caller can observe an exited status with an older tail.
        let exit = self.exit.borrow().and_then(Result::ok);
        let (text, truncated) = self
            .output
            .lock()
            .map_or_else(|_| (String::new(), true), |tail| tail.snapshot());
        Output {
            text,
            truncated,
            exit,
        }
    }

    pub(super) fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.worker.unpark();
    }

    pub(super) fn exited(&self) -> bool {
        self.exit.borrow().is_some_and(|status| status.is_ok())
    }

    pub(super) fn finished(&self) -> bool {
        self.started.borrow().is_some_and(|status| status.is_err()) || self.exited()
    }

    pub(super) async fn started(&self) -> io::Result<()> {
        let mut status = self.started.clone();
        loop {
            if let Some(result) = *status.borrow_and_update() {
                return result.map_err(io::Error::from);
            }
            status.changed().await.map_err(|_| io::ErrorKind::Other)?;
        }
    }

    pub(super) async fn wait_for_group(&self) -> io::Result<()> {
        if self.started().await.is_err() && self.finished() {
            return Ok(());
        }
        self.wait().await.map(|_| ())
    }

    /// A stop signal and a child exit alone do not resolve this wait. Timeouts
    /// or wait cancellation leave ownership with the dedicated worker.
    pub(super) async fn wait(&self) -> io::Result<ExitStatus> {
        let mut status = self.exit.clone();
        loop {
            if let Some(result) = *status.borrow_and_update() {
                return result.map_err(io::Error::from);
            }
            status.changed().await.map_err(|_| io::ErrorKind::Other)?;
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.request_stop();
    }
}

struct Tail {
    bytes: VecDeque<u8>,
    limit: usize,
    truncated: bool,
}

impl Tail {
    #[cfg(any(target_os = "macos", test))]
    fn new(limit: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            limit,
            truncated: false,
        }
    }

    #[cfg(any(target_os = "macos", test))]
    fn append(&mut self, incoming: &[u8]) {
        let start = incoming.len().saturating_sub(self.limit);
        let kept = &incoming[start..];
        let discard = (self.bytes.len() + kept.len()).saturating_sub(self.limit);
        self.truncated |= start != 0 || discard != 0;
        self.bytes.drain(..discard);
        self.bytes.extend(kept);
    }

    fn snapshot(&self) -> (String, bool) {
        let bytes = self.bytes.iter().copied();
        // The retained tail may start partway through a UTF-8 scalar.
        let skip = if self.truncated {
            bytes.clone().take_while(|byte| byte & 0xc0 == 0x80).count()
        } else {
            0
        };
        self.decode(&bytes.skip(skip).collect::<Vec<_>>())
    }

    fn decode(&self, bytes: &[u8]) -> (String, bool) {
        let mut text: String = String::from_utf8_lossy(bytes)
            .chars()
            .filter(|ch| !ch.is_control() || matches!(*ch, '\n' | '\t'))
            .collect();
        // Replacement characters can enlarge malformed output. Keep the byte
        // limit while preserving valid UTF-8 for the protocol and display.
        let mut start = text.len().saturating_sub(self.limit);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        if start != 0 {
            text.drain(..start);
        }
        (text, self.truncated || start != 0)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use crate::{process_platform, supervisor};
    use std::{
        io::Read as _,
        process::{Child, Stdio},
        sync::atomic::AtomicUsize,
        thread,
        time::{Duration, Instant},
    };

    // A blocked or unobservable command keeps its slot until resolved. Bound
    // both the number of such workers and the output retained by each one.
    const MAX_RUNNING_GROUPS: usize = 16;
    const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
    const POLL: Duration = Duration::from_millis(20);
    const TERM_GRACE: Duration = Duration::from_millis(200);
    const FORCE_INTERVAL: Duration = Duration::from_millis(250);
    const PROC_PGRP_ONLY: u32 = 2;

    static RUNNING_GROUPS: AtomicUsize = AtomicUsize::new(0);

    struct Slot;
    impl Slot {
        fn reserve() -> io::Result<Self> {
            RUNNING_GROUPS
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |running| {
                    (running < MAX_RUNNING_GROUPS).then_some(running + 1)
                })
                .map(|_| Self)
                .map_err(|_| io::ErrorKind::WouldBlock.into())
        }
    }

    impl Drop for Slot {
        fn drop(&mut self) {
            RUNNING_GROUPS.fetch_sub(1, Ordering::AcqRel);
        }
    }

    type Pipe = process_platform::PipeReader<io::PipeReader>;

    pub(super) fn spawn(
        command: Command,
        output_limit: usize,
        recovery_dir: Option<PathBuf>,
    ) -> io::Result<Process> {
        let slot = Slot::reserve()?;
        let output = Arc::new(Mutex::new(Tail::new(output_limit.min(MAX_OUTPUT_BYTES))));
        let stop = Arc::new(AtomicBool::new(false));
        let (completion, exit) = watch::channel(None);
        let (ready, started) = watch::channel(None);
        let executable = command.get_program().to_string_lossy().into_owned();
        let cwd = command
            .get_current_dir()
            .unwrap_or(std::path::Path::new(""))
            .to_string_lossy()
            .into_owned();
        let worker = thread::Builder::new()
            .name("ff-tool-terminal".into())
            .spawn({
                let stop = stop.clone();
                let output = output.clone();
                move || {
                    let _slot = slot;
                    if stop.load(Ordering::Acquire) {
                        ready.send_replace(Some(Err(io::ErrorKind::Interrupted)));
                        return;
                    }
                    match OwnedChild::launch(command) {
                        Ok((child, pipe)) => {
                            let registered = recovery_dir.as_ref().and_then(|dir| {
                                supervisor::register_pid(
                                    dir,
                                    "fast-agent-terminal",
                                    &cwd,
                                    &executable,
                                    child.child.id(),
                                )
                                .ok()
                            });
                            ready.send_replace(Some(Ok(())));
                            let exit = child.run(pipe, &output, &stop);
                            if exit.is_ok()
                                && let (Some(dir), Some(entry)) = (recovery_dir, registered)
                            {
                                supervisor::unregister_pid(&dir, &entry);
                            }
                            completion.send_replace(Some(exit.map_err(|error| error.kind())));
                        }
                        Err(error) => {
                            ready.send_replace(Some(Err(error.kind())));
                        }
                    }
                }
            })?;
        Ok(Process {
            output,
            started,
            exit,
            stop,
            worker: worker.thread().clone(),
        })
    }

    struct OwnedChild {
        child: Child,
        _group: process_platform::OwnedGroup,
        anchored: bool,
    }

    impl OwnedChild {
        fn launch(mut command: Command) -> io::Result<(Self, Pipe)> {
            if !std::path::Path::new(command.get_program()).is_absolute()
                || !command
                    .get_current_dir()
                    .is_some_and(std::path::Path::is_absolute)
            {
                return Err(io::ErrorKind::InvalidInput.into());
            }
            // This is the user-approved host child. Its environment is the
            // exact list provided by the local approval, independent of the
            // parent application's or the Agent connection's environment.
            let environment = command
                .get_envs()
                .filter_map(|(name, value)| Some((name.to_owned(), value?.to_owned())))
                .collect::<Vec<_>>();
            command.env_clear().envs(environment);
            let (read, write) = io::pipe()?;
            let read = Pipe::new(read)?;
            command
                .stdin(Stdio::null())
                .stdout(write.try_clone()?)
                .stderr(write);
            let group = process_platform::prepare_command(&mut command)?;
            let mut child = command.spawn()?;
            drop(command);
            let group = group.attach_or_reap(Some(child.id()), || {
                let _ = child.kill();
                child.wait().is_ok()
            })?;
            Ok((
                Self {
                    child,
                    _group: group,
                    anchored: true,
                },
                read,
            ))
        }

        fn run(
            mut self,
            pipe: Pipe,
            output: &Mutex<Tail>,
            stop: &AtomicBool,
        ) -> io::Result<ExitStatus> {
            let mut pipe = Some(pipe);
            let mut next_force = None;
            let pid = self.child.id();
            loop {
                match self.can_reap() {
                    Ok(true) => {
                        self.anchored = false;
                        let status = self.child.wait();
                        drain(&mut pipe, output, true);
                        return status;
                    }
                    Err(error) if error.raw_os_error() == Some(libc::ECHILD) => {
                        // No Child identity remains to authorize signals to a
                        // numeric group. Keep the user-visible result unknown.
                        self.anchored = false;
                        return Err(error);
                    }
                    // A temporary inability to observe the group is not exit
                    // proof. Keep ownership and let the caller time out.
                    _ => {}
                }
                if stop.load(Ordering::Acquire) && next_force.is_none() {
                    supervisor::signal_owned_group(pid, supervisor::TERM);
                    next_force = Some(Instant::now() + TERM_GRACE);
                } else if next_force.is_some_and(|until| Instant::now() >= until) {
                    // A member can spawn another process while the first
                    // signal is being delivered. The unreaped leader still
                    // anchors the group for a bounded-rate follow-up signal.
                    supervisor::signal_owned_group(pid, supervisor::KILL);
                    next_force = Some(Instant::now() + FORCE_INTERVAL);
                }
                drain(&mut pipe, output, false);
                thread::park_timeout(POLL);
            }
        }

        fn can_reap(&self) -> io::Result<bool> {
            let pid = self.child.id();
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            // Keep the exited group leader unreaped while group members may
            // still be alive. Its reserved PID prevents numeric group reuse.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result != 0 {
                return Err(io::Error::last_os_error());
            }
            if unsafe { info.si_pid() } != pid as libc::pid_t {
                return Ok(false);
            }
            only_group_leader(pid)
        }
    }

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if self.anchored {
                supervisor::signal_owned_group(self.child.id(), supervisor::KILL);
                let _ = self.child.wait();
            }
        }
    }

    fn only_group_leader(pid: u32) -> io::Result<bool> {
        // This is a kernel query for the one locally created group. Two slots
        // suffice: one exact leader and any other member means it is still live.
        let mut members = [0 as libc::pid_t; 2];
        let bytes = unsafe {
            libc::proc_listpids(
                PROC_PGRP_ONLY,
                pid,
                members.as_mut_ptr().cast(),
                std::mem::size_of_val(&members) as libc::c_int,
            )
        };
        if bytes <= 0 {
            // The still-owned zombie leader should be present. A failed or
            // inconsistent query cannot prove that its members are gone.
            return Err(io::ErrorKind::Other.into());
        }
        Ok(
            bytes as usize == std::mem::size_of::<libc::pid_t>()
                && members[0] == pid as libc::pid_t,
        )
    }

    fn drain(pipe: &mut Option<Pipe>, tail: &Mutex<Tail>, final_read: bool) {
        let Some(reader) = pipe else { return };
        let mut bytes = [0; 8192];
        // A continuously writing process must not delay the stop poll.
        for _ in 0..16 {
            match reader.read(&mut bytes) {
                Ok(0) => {
                    pipe.take();
                    return;
                }
                Ok(count) => {
                    if let Ok(mut tail) = tail.lock() {
                        tail.append(&bytes[..count]);
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock && !final_read => return,
                Err(_) => {
                    pipe.take();
                    if let Ok(mut tail) = tail.lock() {
                        tail.truncated = true;
                    }
                    return;
                }
            }
        }
        if final_read {
            pipe.take();
            if let Ok(mut tail) = tail.lock() {
                tail.truncated = true;
            }
        }
    }
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
