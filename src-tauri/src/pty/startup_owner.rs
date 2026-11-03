//! One existing PTY owner, now starting before the first native operation.
use super::startup_control::{Slot, Stage, Start};
use super::*;
use std::panic::{AssertUnwindSafe, catch_unwind};
type Registry = Arc<Mutex<HashMap<String, Arc<PtySession>>>>;
type Task = Box<dyn FnOnce() + Send>;
pub(super) type Spawn = fn(Task) -> std::io::Result<thread::JoinHandle<()>>;
pub(super) struct Launch {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub size: PtySize,
    pub output: PtySink,
}
// Private dependency seams, not an environment/product switch. Test factories
// live only in startup_tests.rs; production always selects these native funcs.
pub(super) struct Engines {
    pub system: Box<dyn FnOnce() -> Box<dyn portable_pty::PtySystem> + Send>,
    pub command: fn(&Launch, &mut Resources) -> Result<CommandBuilder, String>,
    pub owner_thread: Box<dyn FnOnce(Task) -> std::io::Result<thread::JoinHandle<()>> + Send>,
    pub reader_thread: Spawn,
}
fn spawn_thread(task: Task) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("farfold-pty-owner".into())
        .spawn(task)
}
fn spawn_reader(task: Task) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("farfold-pty-output".into())
        .spawn(task)
}
fn native_system() -> Box<dyn portable_pty::PtySystem> {
    native_pty_system()
}
impl Engines {
    pub(super) fn native() -> Self {
        Self {
            system: Box::new(native_system),
            command: native_command,
            owner_thread: Box::new(spawn_thread),
            reader_thread: spawn_reader,
        }
    }
}
fn native_command(launch: &Launch, resources: &mut Resources) -> Result<CommandBuilder, String> {
    #[cfg(unix)]
    let mut command = {
        resources.group = Some(crate::process_platform::OwnedGroup);
        let mut command = CommandBuilder::new(&launch.command);
        command.args(launch.args.iter().map(String::as_str));
        command
    };
    #[cfg(windows)]
    let mut command = {
        resources.pending =
            Some(crate::windows_process::pending().map_err(|_| "无法准备终端进程")?);
        let helper = crate::windows_process::helper_executable().map_err(|_| "无法定位应用程序")?;
        let mut command = CommandBuilder::new(helper);
        command.args(resources.pending.as_ref().unwrap().helper_argv(
            std::ffi::OsStr::new(&launch.command),
            launch.args.iter().map(std::ffi::OsString::from),
            true,
        ));
        command
    };
    command.cwd(launch.cwd.as_os_str());
    for (name, value) in &launch.env {
        command.env(name.as_str(), value.as_str());
    }
    Ok(command)
}
pub(super) struct Setup<'a> {
    pub start: &'a Start,
    pub closing: &'a AtomicBool,
    pub launch: &'a Launch,
    pub system: Box<dyn portable_pty::PtySystem>,
    pub command: fn(&Launch, &mut Resources) -> Result<CommandBuilder, String>,
    pub reader_thread: Spawn,
    pub id: &'a str,
}
#[derive(Default)]
pub(super) struct Resources {
    pub master: MasterSlot,
    pub slave: Option<Box<dyn portable_pty::SlavePty + Send>>,
    pub reader: Option<Box<dyn std::io::Read + Send>>,
    pub writer: Option<Input>,
    #[cfg(windows)]
    cursor: Arc<cursor_retirement::CursorRetirement>,
    pub child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    pub group: Option<crate::process_platform::OwnedGroup>,
    #[cfg(windows)]
    pub pending: Option<crate::windows_process::PendingGroup>,
    pub pid: Option<u32>,
    pub spawn_entered: bool,
    pub spawn_returned_error: bool,
    master_created: bool,
    master_drop_attempted: bool,
    child_settled: bool,
    reader_thread: Option<thread::JoinHandle<()>>,
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Cleanup {
    Confirmed,
    Unknown,
}
impl Resources {
    pub(super) fn put_pair(&mut self, pair: portable_pty::PtyPair) {
        self.slave = Some(pair.slave);
        *self
            .master
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(pair.master);
        self.master_created = true;
    }
    pub(super) fn setup(&mut self, setup: Setup<'_>) -> Result<(), String> {
        let Setup {
            start,
            closing,
            launch,
            system,
            command,
            reader_thread,
            id,
        } = setup;
        if start.stopped(closing) {
            return Err("AUTH_CANCELLED".into());
        }
        start.stage(Stage::Opening);
        let pair = system
            .openpty(launch.size)
            .map_err(|error| format!("cannot open pty: {error}"))?;
        self.put_pair(pair);
        if start.stopped(closing) {
            return Err("AUTH_CANCELLED".into());
        }
        let command = command(launch, self)?;
        if start.stopped(closing) {
            return Err("AUTH_CANCELLED".into());
        }
        start.stage(Stage::Reader);
        self.reader = Some(
            self.master
                .lock()
                .map_err(|_| "无法读取终端")?
                .as_ref()
                .ok_or("无法读取终端")?
                .try_clone_reader()
                .map_err(|error| format!("cannot clone pty reader: {error}"))?,
        );
        if start.stopped(closing) {
            return Err("AUTH_CANCELLED".into());
        }
        start.stage(Stage::Writer);
        self.writer = Some(Arc::new(Mutex::new(
            self.master
                .lock()
                .map_err(|_| "无法写入终端")?
                .as_ref()
                .ok_or("无法写入终端")?
                .take_writer()
                .map_err(|error| format!("cannot take pty writer: {error}"))?,
        )));
        if start.stopped(closing) {
            return Err("AUTH_CANCELLED".into());
        }
        start.stage(Stage::Spawning);
        self.spawn_entered = true;
        match self
            .slave
            .as_ref()
            .ok_or("无法启动终端")?
            .spawn_command(command)
        {
            Ok(child) => self.child = Some(child),
            Err(error) => {
                self.spawn_returned_error = true;
                return Err(format!("cannot spawn {} on pty: {error}", launch.command));
            }
        }
        // Child is already stored outside the catch before any subsequent call.
        self.pid = self.child.as_ref().unwrap().process_id();
        drop(self.slave.take());
        start.stage(Stage::Attaching);
        #[cfg(windows)]
        {
            let child = self.child.as_mut().unwrap();
            self.group = Some(
                self.pending
                    .as_ref()
                    .ok_or("无法确认终端进程")?
                    .attach_or_reap(self.pid, || {
                        let _ = child.kill();
                        matches!(child.try_wait(), Ok(Some(_)))
                    })
                    .map_err(|_| "无法确认终端进程")?,
            );
        }
        if self.group.is_none() {
            return Err("无法确认终端进程".into());
        }
        if start.stopped(closing) {
            return Err("AUTH_CANCELLED".into());
        }
        let mut reader = self.reader.take().ok_or("无法读取终端")?;
        let output = launch.output.clone();
        let id = id.to_owned();
        #[cfg(windows)]
        let cursor = self.cursor.clone();
        // A failed reader-thread factory drops this closure on THIS owner,
        // never the IPC caller. Child/Job/master stay in Resources for cleanup.
        self.reader_thread = Some(
            reader_thread(Box::new(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match std::io::Read::read(&mut reader, &mut buffer) {
                        Ok(0) | Err(_) => return,
                        Ok(count) => {
                            #[cfg(windows)]
                            cursor.observe(&buffer[..count]);
                            output(
                                serde_json::json!({"id":id,"data":BASE64.encode(&buffer[..count])}),
                            );
                        }
                    }
                }
            }))
            .map_err(|_| "无法读取终端输出")?,
        );
        Ok(())
    }
    fn drop_no_child(&mut self) -> Cleanup {
        if self.spawn_entered && !self.spawn_returned_error && !self.child_settled {
            return Cleanup::Unknown;
        }
        if self.master_drop_attempted {
            return Cleanup::Unknown;
        }
        let result = catch_unwind(AssertUnwindSafe(|| {
            drop(self.reader.take());
            drop(self.writer.take());
            drop(self.slave.take());
            if self.master_created {
                self.master_drop_attempted = true;
                drop_master(&self.master)?;
            }
            Ok::<(), ()>(())
        }));
        if matches!(result, Ok(Ok(()))) {
            Cleanup::Confirmed
        } else {
            Cleanup::Unknown
        }
    }
    fn reap_child_only(&mut self) {
        let child = self.child.as_mut().unwrap();
        loop {
            let _ = catch_unwind(AssertUnwindSafe(|| child.kill()));
            if matches!(
                catch_unwind(AssertUnwindSafe(|| child.try_wait())),
                Ok(Ok(Some(_)))
            ) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    pub(super) fn cleanup(
        &mut self,
        start: &Start,
        exit: &ExitLatch,
        id: &str,
        output: &PtySink,
    ) -> Cleanup {
        start.stop.store(true, Ordering::SeqCst);
        if self.child.is_none() {
            return self.drop_no_child();
        }
        #[cfg(windows)]
        if self.group.is_none() {
            let Some(pending) = self.pending.as_ref() else {
                self.reap_child_only();
                return Cleanup::Unknown;
            };
            let child = self.child.as_mut().unwrap();
            let _ = pending.attach_or_reap(None, || {
                let _ = catch_unwind(AssertUnwindSafe(|| child.kill()));
                matches!(
                    catch_unwind(AssertUnwindSafe(|| child.try_wait())),
                    Ok(Ok(Some(_)))
                )
            });
            self.child_settled = true;
            self.child.take();
            return self.drop_no_child();
        }
        if self.group.is_none() {
            self.reap_child_only();
            return Cleanup::Unknown;
        }
        let group = self.group.as_ref().unwrap();
        let slave_drop = catch_unwind(AssertUnwindSafe(|| drop(self.slave.take())));
        let mut terminal = TerminalOwner {
            child: self.child.as_mut().unwrap().as_mut(),
            _group: group,
            pid: self.pid,
            stop: &start.stop,
            master: &self.master,
            exit,
            id,
            on_output: output,
            #[cfg(windows)]
            cursor: &self.cursor,
            #[cfg(windows)]
            writer: self.writer.as_ref(),
        };
        #[cfg(unix)]
        if self.pid.is_none() {
            // The trait returned no original group id. Reap the exact Child,
            // but do not turn unknown descendant/control state into an exit.
            terminal.reap_after_failure();
            return Cleanup::Unknown;
        }
        if slave_drop.is_err() {
            terminal.reap_after_failure();
            let _ = catch_unwind(AssertUnwindSafe(|| drop_master(&self.master)));
            return Cleanup::Unknown;
        }
        if terminal.settle() {
            Cleanup::Confirmed
        } else {
            Cleanup::Unknown
        }
    }
}
pub(super) fn begin(
    manager: &PtyManager,
    launch: Launch,
    stop: Arc<AtomicBool>,
    admission: crate::managed_update::ActivityPermit,
    budget: Duration,
    engines: Engines,
) -> Result<String, String> {
    if stop.load(Ordering::SeqCst) {
        return Err("AUTH_CANCELLED".into());
    }
    // Preflight registry only; no native object exists and no lock crosses spawn.
    drop(manager.lock()?);
    let start = manager.startup.reserve(stop, &manager.shutting_down)?;
    let id = format!(
        "pty-{}-{}",
        now_millis(),
        manager.counter.fetch_add(1, Ordering::SeqCst)
    );
    let sessions = manager.sessions.clone();
    let closing = manager.shutting_down.clone();
    let slot = manager.startup.clone();
    let owned = start.clone();
    let key = id.clone();
    let Engines {
        system,
        command,
        owner_thread,
        reader_thread,
    } = engines;
    let task: Task = Box::new(move || {
        run_owner(Work {
            sessions,
            closing,
            slot,
            start: owned,
            id: key,
            launch,
            admission,
            system,
            command,
            reader_thread,
        })
    });
    match owner_thread(task) {
        Ok(thread) => start.attach_thread(thread),
        Err(_) => {
            manager
                .startup
                .owner_thread_never_started(&start, "无法准备终端，请重试".into());
            return Err("无法准备终端，请重试".into());
        }
    }
    start.wait_ready(budget).map(|()| id)
}
struct Work {
    sessions: Registry,
    closing: Arc<AtomicBool>,
    slot: Slot,
    start: Arc<Start>,
    id: String,
    launch: Launch,
    admission: crate::managed_update::ActivityPermit,
    system: Box<dyn FnOnce() -> Box<dyn portable_pty::PtySystem> + Send>,
    command: fn(&Launch, &mut Resources) -> Result<CommandBuilder, String>,
    reader_thread: Spawn,
}
fn run_owner(work: Work) {
    let Work {
        sessions,
        closing,
        slot,
        start,
        id,
        launch,
        admission,
        system,
        command,
        reader_thread,
    } = work;
    let _admission = admission;
    let mut resources = Resources::default();
    let exit: ExitLatch = Arc::new((Mutex::new(None), Condvar::new()));
    // All resource owners live OUTSIDE this unwind boundary, including Child
    // before process_id/attach/reader-thread/registration can fail or panic.
    let prepared = catch_unwind(AssertUnwindSafe(|| {
        resources.setup(Setup {
            start: &start,
            closing: &closing,
            launch: &launch,
            system: system(),
            command,
            reader_thread,
            id: &id,
        })?;
        start.stage(Stage::Registering);
        let mut sessions = sessions.lock().map_err(|_| "无法登记终端")?;
        start.publish_ready(&closing, || {
            if sessions.contains_key(&id) {
                return Err("无法登记终端".into());
            }
            #[cfg(windows)]
            let writer = resources.writer.as_ref().ok_or("无法写入终端")?.clone();
            #[cfg(not(windows))]
            let writer = resources.writer.take().ok_or("无法写入终端")?;
            sessions.insert(
                id.clone(),
                Arc::new(PtySession {
                    writer,
                    #[cfg(windows)]
                    cursor: resources.cursor.clone(),
                    master: resources.master.clone(),
                    #[cfg(test)]
                    pid: resources.pid,
                    stop: start.stop.clone(),
                    exit: exit.clone(),
                    _startup: Some(start.clone()),
                }),
            );
            Ok(())
        })
    }));
    match prepared {
        Ok(Ok(true)) => {
            slot.release(&start);
            crate::logging::info("pty", format_args!("spawn: {id} (pid {:?})", resources.pid));
            // The same worker continues R3, never hands Child/Job to another.
            let settled = TerminalOwner {
                child: resources.child.as_mut().unwrap().as_mut(),
                _group: resources.group.as_ref().unwrap(),
                pid: resources.pid,
                stop: &start.stop,
                master: &resources.master,
                exit: &exit,
                id: &id,
                on_output: &launch.output,
                #[cfg(windows)]
                cursor: &resources.cursor,
                #[cfg(windows)]
                writer: resources.writer.as_ref(),
            }
            .settle();
            if settled {
                return;
            }
        }
        failed => {
            start.stage(Stage::Cleaning);
            let error = match failed {
                Ok(Err(error)) => error,
                Ok(Ok(false)) => "AUTH_CANCELLED".into(),
                Err(_) => "终端准备未能完成".into(),
                Ok(Ok(true)) => unreachable!(),
            };
            let cancelled = start.stopped(&closing);
            if resources.cleanup(&start, &exit, &id, &launch.output) == Cleanup::Confirmed {
                // All Child/control proofs preceded these ordinary owners.
                // A trait Drop panic still cannot unwind away Activity.
                if catch_unwind(AssertUnwindSafe(|| {
                    drop(resources);
                    drop(launch);
                }))
                .is_ok()
                {
                    let error = if cancelled {
                        "AUTH_CANCELLED".into()
                    } else {
                        error
                    };
                    start.setup_failed_after_cleanup(error);
                    slot.release(&start);
                    return;
                }
            }
        }
    }
    start.unknown();
    // A blocked native call never reaches here; it keeps this exact stack too.
    // No new reaper, retries, synthetic exit or Activity/sink release on unknown.
    loop {
        thread::park();
    }
}
