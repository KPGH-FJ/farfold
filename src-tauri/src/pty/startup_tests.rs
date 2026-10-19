//! Tests of the production Start/Slot and setup pipeline, not an emulated map.
use super::*;
use std::sync::atomic::AtomicUsize;
#[test]
fn timeout_requests_real_stop_but_never_releases_unknown_or_calls_late_register() {
    let slot = Slot::default();
    let closing = AtomicBool::new(false);
    let stop = Arc::new(AtomicBool::new(false));
    let start = slot.reserve(stop.clone(), &closing).unwrap();
    let result = start.wait_ready(Duration::ZERO);
    assert_eq!(result.unwrap_err(), UNKNOWN);
    assert!(stop.load(Ordering::SeqCst));
    assert!(!slot.release(&start));
    assert!(
        slot.reserve(Arc::new(AtomicBool::new(false)), &closing)
            .is_err()
    );
    let registrations = AtomicUsize::new(0);
    assert!(
        !start
            .publish_ready(&closing, || {
                registrations.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap()
    );
    assert_eq!(registrations.load(Ordering::SeqCst), 0);
    // Test stands in for the actual worker's completed resource barrier ONLY.
    // It does not itself prove native cleanup or claim a Windows success.
    start.setup_failed_after_cleanup("AUTH_CANCELLED".into());
    assert!(slot.release(&start));
    assert_eq!(
        start.wait_ready(Duration::ZERO).unwrap_err(),
        "AUTH_CANCELLED"
    );
}
#[test]
fn ready_winner_is_returned_and_old_release_cannot_remove_the_next_owner() {
    let slot = Slot::default();
    let closing = AtomicBool::new(false);
    let first = slot
        .reserve(Arc::new(AtomicBool::new(false)), &closing)
        .unwrap();
    assert!(first.publish_ready(&closing, || Ok(())).unwrap());
    assert_eq!(first.wait_ready(Duration::ZERO), Ok(()));
    assert!(slot.release(&first));
    let second = slot
        .reserve(Arc::new(AtomicBool::new(false)), &closing)
        .unwrap();
    assert!(!slot.release(&first));
    assert!(
        slot.reserve(Arc::new(AtomicBool::new(false)), &closing)
            .is_err()
    );
    slot.cancel_pending();
    assert!(second.stop.load(Ordering::SeqCst));
}
#[test]
fn closing_or_caller_cancel_never_registers_a_ready_terminal() {
    let slot = Slot::default();
    let closing = AtomicBool::new(false);
    let start = slot
        .reserve(Arc::new(AtomicBool::new(false)), &closing)
        .unwrap();
    closing.store(true, Ordering::SeqCst);
    assert!(
        !start
            .publish_ready(&closing, || panic!("must not register"))
            .unwrap()
    );
    assert!(!slot.release(&start));
    assert!(
        slot.reserve(Arc::new(AtomicBool::new(false)), &closing)
            .is_err()
    );
}

// Actual native-setup code is exercised through official portable-pty traits.
// No fake Agent, native PTY, OS Child or runtime environment flag is used.
use crate::pty::startup_owner::{self as owner, Cleanup, Engines, Launch, Resources};
use crate::pty::{CommandBuilder, Condvar, ExitLatch, PtyManager, PtySink, PtySize};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::{self, JoinHandle, ThreadId};
#[derive(Clone, Copy, Debug)]
enum Fail {
    None,
    Open,
    Reader,
    Writer,
    Spawn,
    SpawnPanic,
}
struct Gate {
    entered: SyncSender<ThreadId>,
    released: Mutex<bool>,
    changed: Condvar,
    opens: AtomicUsize,
    drops: AtomicUsize,
    killed: AtomicUsize,
    reaped: AtomicUsize,
    spawns: AtomicUsize,
    cancel_writer: Mutex<Option<Arc<AtomicBool>>>,
}
impl Gate {
    fn new(released: bool) -> (Arc<Self>, Receiver<ThreadId>) {
        let (send, receive) = mpsc::sync_channel(4);
        (
            Arc::new(Self {
                entered: send,
                released: Mutex::new(released),
                changed: Condvar::new(),
                opens: AtomicUsize::new(0),
                drops: AtomicUsize::new(0),
                killed: AtomicUsize::new(0),
                reaped: AtomicUsize::new(0),
                spawns: AtomicUsize::new(0),
                cancel_writer: Mutex::new(None),
            }),
            receive,
        )
    }
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}
struct FakeMaster {
    gate: Arc<Gate>,
    fail: Fail,
}
impl Drop for FakeMaster {
    fn drop(&mut self) {
        self.gate.drops.fetch_add(1, Ordering::SeqCst);
        let _ = self.gate.entered.try_send(thread::current().id());
        let mut released = self.gate.released.lock().unwrap();
        while !*released {
            released = self.gate.changed.wait(released).unwrap();
        }
    }
}
impl portable_pty::MasterPty for FakeMaster {
    fn resize(&self, _: PtySize) -> anyhow::Result<()> {
        Ok(())
    }
    fn get_size(&self) -> anyhow::Result<PtySize> {
        Ok(PtySize::default())
    }
    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        if matches!(self.fail, Fail::Reader) {
            anyhow::bail!("controlled reader error");
        }
        Ok(Box::new(std::io::empty()))
    }
    fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
        if matches!(self.fail, Fail::Writer) {
            anyhow::bail!("controlled writer error");
        }
        if let Some(stop) = self.gate.cancel_writer.lock().unwrap().as_ref() {
            stop.store(true, Ordering::SeqCst);
        }
        Ok(Box::new(std::io::sink()))
    }
    #[cfg(unix)]
    fn process_group_leader(&self) -> Option<libc::pid_t> {
        None
    }
    #[cfg(unix)]
    fn as_raw_fd(&self) -> Option<std::os::fd::RawFd> {
        None
    }
    #[cfg(unix)]
    fn tty_name(&self) -> Option<std::path::PathBuf> {
        None
    }
}
struct FakeSlave {
    gate: Arc<Gate>,
    fail: Fail,
}
impl portable_pty::SlavePty for FakeSlave {
    fn spawn_command(
        &self,
        _: CommandBuilder,
    ) -> anyhow::Result<Box<dyn portable_pty::Child + Send + Sync>> {
        self.gate.spawns.fetch_add(1, Ordering::SeqCst);
        if matches!(self.fail, Fail::Spawn) {
            anyhow::bail!("controlled ordinary spawn error");
        }
        if matches!(self.fail, Fail::SpawnPanic) {
            panic!("controlled spawn panic without returned child");
        }
        Ok(Box::new(FakeChild {
            gate: self.gate.clone(),
            first_panic: false,
            complete: true,
        }))
    }
}
struct FakeSystem {
    gate: Arc<Gate>,
    fail: Fail,
}
impl portable_pty::PtySystem for FakeSystem {
    fn openpty(&self, _: PtySize) -> anyhow::Result<portable_pty::PtyPair> {
        self.gate.opens.fetch_add(1, Ordering::SeqCst);
        if matches!(self.fail, Fail::Open) {
            anyhow::bail!("controlled open error");
        }
        Ok(portable_pty::PtyPair {
            slave: Box::new(FakeSlave {
                gate: self.gate.clone(),
                fail: self.fail,
            }),
            master: Box::new(FakeMaster {
                gate: self.gate.clone(),
                fail: self.fail,
            }),
        })
    }
}
impl std::fmt::Debug for Gate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("controlled-gate")
    }
}
#[derive(Debug)]
struct FakeChild {
    gate: Arc<Gate>,
    first_panic: bool,
    complete: bool,
}
#[derive(Debug)]
struct Killer(Arc<Gate>);
impl portable_pty::ChildKiller for Killer {
    fn kill(&mut self) -> std::io::Result<()> {
        self.0.killed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(Self(self.0.clone()))
    }
}
impl portable_pty::ChildKiller for FakeChild {
    fn kill(&mut self) -> std::io::Result<()> {
        Killer(self.gate.clone()).kill()
    }
    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(Killer(self.gate.clone()))
    }
}
impl portable_pty::Child for FakeChild {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        if self.first_panic {
            self.first_panic = false;
            panic!("controlled child panic");
        }
        if self.complete || self.gate.killed.load(Ordering::SeqCst) > 0 {
            self.gate.reaped.fetch_add(1, Ordering::SeqCst);
            Ok(Some(portable_pty::ExitStatus::with_exit_code(0)))
        } else {
            Ok(None)
        }
    }
    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        self.try_wait()?
            .ok_or_else(|| std::io::Error::other("not finished"))
    }
    fn process_id(&self) -> Option<u32> {
        None
    }
    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}
fn thread_factory(task: Box<dyn FnOnce() + Send>) -> std::io::Result<JoinHandle<()>> {
    thread::Builder::new().spawn(task)
}
fn failed_thread(task: Box<dyn FnOnce() + Send>) -> std::io::Result<JoinHandle<()>> {
    drop(task);
    Err(std::io::Error::other("controlled thread creation error"))
}
fn fake_command(_: &Launch, resources: &mut Resources) -> Result<CommandBuilder, String> {
    #[cfg(unix)]
    {
        resources.group = Some(crate::process_platform::OwnedGroup);
    }
    #[cfg(windows)]
    let _ = resources;
    Ok(CommandBuilder::new("never-executed"))
}
fn engines(gate: Arc<Gate>, fail: Fail) -> Engines {
    Engines {
        system: Box::new(move || -> Box<dyn portable_pty::PtySystem> {
            Box::new(FakeSystem { gate, fail })
        }),
        command: fake_command,
        owner_thread: Box::new(thread_factory),
        reader_thread: thread_factory,
    }
}
fn gated_engines(
    gate: Arc<Gate>,
    fail: Fail,
    entered: Receiver<ThreadId>,
) -> (Engines, Arc<Mutex<Option<ThreadId>>>) {
    let observed = Arc::new(Mutex::new(None));
    let store = observed.clone();
    let mut value = engines(gate, fail);
    value.owner_thread = Box::new(move |task| {
        let handle = thread_factory(task)?;
        // Observe the real fake-trait Drop before starting this test's caller
        // wait budget. Even a failed observation MUST return the actual handle;
        // it may never masquerade as a pre-spawn Builder error.
        *store.lock().unwrap() = entered.recv_timeout(Duration::from_secs(1)).ok();
        Ok(handle)
    });
    (value, observed)
}
struct SinkGuard(Arc<AtomicUsize>);
impl Drop for SinkGuard {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
fn launch(dropped: Arc<AtomicUsize>) -> Launch {
    let held = SinkGuard(dropped);
    let output: PtySink = Arc::new(move |_| {
        let _ = &held;
    });
    Launch {
        command: "never-executed".into(),
        args: vec![],
        env: vec![],
        cwd: std::env::temp_dir(),
        size: PtySize::default(),
        output,
    }
}
fn join_start(start: &Start) {
    let handle = start.thread.lock().unwrap().take();
    if let Some(handle) = handle {
        handle.join().unwrap();
    }
}
#[test]
fn actual_reader_writer_and_ordinary_spawn_errors_drop_on_owner_after_bounded_unknown() {
    for fail in [Fail::Reader, Fail::Writer, Fail::Spawn] {
        let manager = PtyManager::new();
        let admission = crate::managed_update::UpdateAdmission::default();
        let dropped = Arc::new(AtomicUsize::new(0));
        let (gate, entered) = Gate::new(false);
        let (hooks, drop_thread) = gated_engines(gate.clone(), fail, entered);
        let (send, receive) = mpsc::sync_channel(1);
        let (caller_send, caller_receive) = mpsc::sync_channel(1);
        thread::scope(|scope| {
            let manager = &manager;
            let caller_dropped = dropped.clone();
            let permit = admission.activity().unwrap();
            let caller = scope.spawn(move || {
                caller_send.send(thread::current().id()).unwrap();
                let value = owner::begin(
                    manager,
                    launch(caller_dropped),
                    Arc::new(AtomicBool::new(false)),
                    permit,
                    Duration::from_millis(100),
                    hooks,
                );
                send.send(value).unwrap();
            });
            let caller_id = caller_receive.recv_timeout(Duration::from_secs(1)).unwrap();
            let result = receive.recv_timeout(Duration::from_secs(2));
            let owner_id = *drop_thread.lock().unwrap();
            let pending = manager.startup.0.lock().unwrap().clone();
            let active = admission.update().is_err();
            let not_released = dropped.load(Ordering::SeqCst) == 0;
            let second = owner::begin(
                manager,
                launch(Arc::new(AtomicUsize::new(0))),
                Arc::new(AtomicBool::new(false)),
                admission.activity().unwrap(),
                Duration::ZERO,
                engines(gate.clone(), fail),
            );
            // Release before assertions, even if a regression blocked the caller.
            gate.release();
            caller.join().unwrap();
            if let Some(start) = &pending {
                join_start(start);
            }
            assert!(owner_id.is_some());
            assert_ne!(owner_id.unwrap(), caller_id);
            assert_eq!(result.unwrap().unwrap_err(), UNKNOWN);
            assert!(active && not_released && second.is_err());
            assert_eq!(gate.opens.load(Ordering::SeqCst), 1);
            assert_eq!(gate.drops.load(Ordering::SeqCst), 1);
            assert_eq!(dropped.load(Ordering::SeqCst), 1);
            assert!(admission.update().is_ok());
            assert!(manager.startup.0.lock().unwrap().is_none());
        });
    }
}
#[test]
fn owner_thread_creation_error_has_no_native_call_and_releases_no_work_reservation() {
    let manager = PtyManager::new();
    let admission = crate::managed_update::UpdateAdmission::default();
    let dropped = Arc::new(AtomicUsize::new(0));
    let (gate, _) = Gate::new(true);
    let mut hooks = engines(gate.clone(), Fail::Reader);
    hooks.owner_thread = Box::new(failed_thread);
    assert!(
        owner::begin(
            &manager,
            launch(dropped.clone()),
            Arc::new(AtomicBool::new(false)),
            admission.activity().unwrap(),
            Duration::ZERO,
            hooks
        )
        .is_err()
    );
    assert_eq!(gate.opens.load(Ordering::SeqCst), 0);
    assert_eq!(gate.drops.load(Ordering::SeqCst), 0);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(admission.update().is_ok());
    assert!(manager.startup.0.lock().unwrap().is_none());
}
#[test]
fn manager_drop_cancels_pending_without_waiting_for_gated_native_drop() {
    let manager = PtyManager::new();
    let admission = crate::managed_update::UpdateAdmission::default();
    let dropped = Arc::new(AtomicUsize::new(0));
    let (gate, entered) = Gate::new(false);
    let (hooks, drop_thread) = gated_engines(gate.clone(), Fail::Reader, entered);
    // The bounded call returns unknown while actual native-trait Drop is gated.
    let result = owner::begin(
        &manager,
        launch(dropped.clone()),
        Arc::new(AtomicBool::new(false)),
        admission.activity().unwrap(),
        Duration::from_millis(100),
        hooks,
    );
    let observed = *drop_thread.lock().unwrap();
    let pending = manager.startup.0.lock().unwrap().clone().unwrap();
    let began = std::time::Instant::now();
    drop(manager);
    let elapsed = began.elapsed();
    let still_held = admission.update().is_err() && dropped.load(Ordering::SeqCst) == 0;
    gate.release();
    join_start(&pending);
    assert!(observed.is_some());
    assert_eq!(result.unwrap_err(), UNKNOWN);
    assert!(elapsed < Duration::from_secs(1));
    assert!(pending.stop.load(Ordering::SeqCst) && still_held);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(admission.update().is_ok());
}
#[test]
fn spawn_panic_without_a_returned_child_is_unknown_not_no_child() {
    let (gate, _) = Gate::new(true);
    let mut resources = Resources::default();
    let start = Start::new(Arc::new(AtomicBool::new(false)));
    let closing = AtomicBool::new(false);
    let launch = launch(Arc::new(AtomicUsize::new(0)));
    let actual = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        resources.setup(owner::Setup {
            start: &start,
            closing: &closing,
            launch: &launch,
            system: Box::new(FakeSystem {
                gate: gate.clone(),
                fail: Fail::SpawnPanic,
            }),
            command: fake_command,
            reader_thread: thread_factory,
            id: "fake",
        })
    }));
    assert!(actual.is_err());
    assert!(
        resources.spawn_entered && !resources.spawn_returned_error && resources.child.is_none()
    );
    let exit: ExitLatch = Arc::new((Mutex::new(None), Condvar::new()));
    assert_eq!(
        resources.cleanup(&start, &exit, "fake", &launch.output),
        Cleanup::Unknown
    );
    assert_eq!(gate.drops.load(Ordering::SeqCst), 0);
    assert!(exit.0.lock().unwrap().is_none());
    // The controlled fake never created an OS process. Dispose these fake
    // objects without marking the actual production unknown owner settled.
    drop(resources);
    assert_eq!(gate.drops.load(Ordering::SeqCst), 1);
}

#[cfg(unix)]
#[test]
fn a_stored_child_is_killed_and_reaped_even_when_group_identity_is_unknown() {
    let (gate, _) = Gate::new(true);
    let mut resources = Resources::default();
    resources.put_pair(portable_pty::PtyPair {
        slave: Box::new(FakeSlave {
            gate: gate.clone(),
            fail: Fail::None,
        }),
        master: Box::new(FakeMaster {
            gate: gate.clone(),
            fail: Fail::None,
        }),
    });
    resources.child = Some(Box::new(FakeChild {
        gate: gate.clone(),
        first_panic: true,
        complete: false,
    }));
    resources.spawn_entered = true;
    let start = Start::new(Arc::new(AtomicBool::new(false)));
    let exit: ExitLatch = Arc::new((Mutex::new(None), Condvar::new()));
    let sinks = Arc::new(AtomicUsize::new(0));
    let observed = sinks.clone();
    let sink: PtySink = Arc::new(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(
        resources.cleanup(&start, &exit, "fake", &sink),
        Cleanup::Unknown
    );
    assert!(gate.killed.load(Ordering::SeqCst) > 0 && gate.reaped.load(Ordering::SeqCst) > 0);
    assert_eq!(sinks.load(Ordering::SeqCst), 0);
    assert!(exit.0.lock().unwrap().is_none());
    drop(resources);
}
#[cfg(unix)]
#[test]
fn ready_setup_keeps_existing_id_exit_and_live_session_reference_contract() {
    let manager = PtyManager::new();
    let admission = crate::managed_update::UpdateAdmission::default();
    let (gate, _) = Gate::new(true);
    let id = owner::begin(
        &manager,
        launch(Arc::new(AtomicUsize::new(0))),
        Arc::new(AtomicBool::new(false)),
        admission.activity().unwrap(),
        Duration::from_secs(1),
        engines(gate.clone(), Fail::None),
    )
    .unwrap();
    let start = manager
        .lock()
        .unwrap()
        .get(&id)
        .unwrap()
        ._startup
        .clone()
        .unwrap();
    assert_eq!(manager.await_exit(&id).unwrap(), 0);
    join_start(&start);
    assert!(manager.lock().unwrap().is_empty());
    assert_eq!(gate.drops.load(Ordering::SeqCst), 1);
    assert!(admission.update().is_ok());
}

#[test]
fn cancellation_after_writer_waits_for_actual_control_cleanup_before_confirmed_cancel() {
    let manager = PtyManager::new();
    let admission = crate::managed_update::UpdateAdmission::default();
    let dropped = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (gate, entered) = Gate::new(false);
    *gate.cancel_writer.lock().unwrap() = Some(stop.clone());
    let (hooks, observed) = gated_engines(gate.clone(), Fail::None, entered);
    let result = owner::begin(
        &manager,
        launch(dropped.clone()),
        stop,
        admission.activity().unwrap(),
        Duration::from_millis(100),
        hooks,
    );
    let pending = manager.startup.0.lock().unwrap().clone();
    let held = admission.update().is_err() && dropped.load(Ordering::SeqCst) == 0;
    gate.release();
    if let Some(start) = &pending {
        join_start(start);
    }
    assert!(observed.lock().unwrap().is_some());
    assert_eq!(result.unwrap_err(), UNKNOWN);
    assert!(held);
    assert_eq!(gate.spawns.load(Ordering::SeqCst), 0);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert_eq!(
        pending.unwrap().wait_ready(Duration::ZERO).unwrap_err(),
        "AUTH_CANCELLED"
    );
    assert!(admission.update().is_ok());
}
#[cfg(unix)]
#[test]
fn reader_thread_failure_keeps_stored_child_until_same_child_reap() {
    let (gate, _) = Gate::new(true);
    let mut resources = Resources::default();
    let start = Start::new(Arc::new(AtomicBool::new(false)));
    let closing = AtomicBool::new(false);
    let launch = launch(Arc::new(AtomicUsize::new(0)));
    let result = resources.setup(owner::Setup {
        start: &start,
        closing: &closing,
        launch: &launch,
        system: Box::new(FakeSystem {
            gate: gate.clone(),
            fail: Fail::None,
        }),
        command: fake_command,
        reader_thread: failed_thread,
        id: "fake",
    });
    let exit: ExitLatch = Arc::new((Mutex::new(None), Condvar::new()));
    assert!(result.is_err());
    assert!(resources.child.is_some());
    assert_eq!(gate.reaped.load(Ordering::SeqCst), 0);
    assert_eq!(
        resources.cleanup(&start, &exit, "fake", &launch.output),
        Cleanup::Unknown
    );
    assert!(gate.killed.load(Ordering::SeqCst) > 0 && gate.reaped.load(Ordering::SeqCst) > 0);
    assert_eq!(gate.drops.load(Ordering::SeqCst), 0);
    assert!(exit.0.lock().unwrap().is_none());
    // Fake child has no OS/group id, so no false descendant proof is made.
    // Only these fake objects are disposed here; production keeps unknown owner.
    drop(resources);
}

#[test]
fn openpty_returned_error_releases_only_after_same_owner_finished() {
    let manager = PtyManager::new();
    let admission = crate::managed_update::UpdateAdmission::default();
    let dropped = Arc::new(AtomicUsize::new(0));
    let (gate, _) = Gate::new(true);
    let captured = Arc::new(Mutex::new(None));
    let store = captured.clone();
    let pending = manager.startup.clone();
    let mut hooks = engines(gate.clone(), Fail::Open);
    hooks.owner_thread = Box::new(move |task| {
        *store.lock().unwrap() = pending.0.lock().unwrap().clone();
        thread_factory(task)
    });
    let result = owner::begin(
        &manager,
        launch(dropped.clone()),
        Arc::new(AtomicBool::new(false)),
        admission.activity().unwrap(),
        Duration::from_secs(1),
        hooks,
    );
    let owned = captured.lock().unwrap().take().unwrap();
    join_start(&owned);
    assert!(result.unwrap_err().contains("controlled open error"));
    assert_eq!(gate.opens.load(Ordering::SeqCst), 1);
    assert_eq!(gate.drops.load(Ordering::SeqCst), 0);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(admission.update().is_ok());
    assert!(manager.startup.0.lock().unwrap().is_none() && manager.lock().unwrap().is_empty());
}
