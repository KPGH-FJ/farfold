//! Synthetic master Drop gates exercise the production terminal receipt seam.
//! No native PTY, child process, notification, environment flag or Agent runs.
use super::*;
use std::sync::atomic::AtomicUsize;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

struct DropGate {
    entered: SyncSender<()>,
    release: (Mutex<bool>, Condvar),
    drops: AtomicUsize,
}
impl DropGate {
    fn new() -> (Arc<Self>, Receiver<()>) {
        let (entered, receiver) = sync_channel(1);
        (
            Arc::new(Self {
                entered,
                release: (Mutex::new(false), Condvar::new()),
                drops: AtomicUsize::new(0),
            }),
            receiver,
        )
    }
    fn release(&self) {
        *self.release.0.lock().unwrap() = true;
        self.release.1.notify_all();
    }
}
struct GatedMaster(Arc<DropGate>);
impl Drop for GatedMaster {
    fn drop(&mut self) {
        self.0.drops.fetch_add(1, Ordering::SeqCst);
        let _ = self.0.entered.try_send(());
        let mut release = self.0.release.0.lock().unwrap();
        while !*release {
            release = self.0.release.1.wait(release).unwrap();
        }
    }
}
impl MasterPty for GatedMaster {
    fn resize(&self, _: PtySize) -> anyhow::Result<()> {
        Ok(())
    }
    fn get_size(&self) -> anyhow::Result<PtySize> {
        Ok(PtySize::default())
    }
    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        Ok(Box::new(std::io::empty()))
    }
    fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
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
    fn tty_name(&self) -> Option<PathBuf> {
        None
    }
}
fn fixture(gate: Arc<DropGate>) -> (PtyManager, Arc<PtySession>) {
    let manager = PtyManager::new();
    let session = Arc::new(PtySession {
        writer: Arc::new(Mutex::new(Box::new(std::io::sink()))),
        #[cfg(windows)]
        cursor: Arc::default(),
        master: Arc::new(Mutex::new(Some(Box::new(GatedMaster(gate))))),
        pid: None,
        stop: Arc::new(AtomicBool::new(false)),
        exit: Arc::new((Mutex::new(None), Condvar::new())),
        _startup: None,
    });
    manager
        .lock()
        .unwrap()
        .insert("owned-master".into(), session.clone());
    (manager, session)
}
#[test]
fn terminal_receipt_waits_for_actual_master_drop_with_a_live_session_reference() {
    let (drop_gate, entered) = DropGate::new();
    let (manager, session) = fixture(drop_gate.clone());
    let admission = crate::managed_update::UpdateAdmission::default();
    let permit = admission.activity().unwrap();
    let sink_called = Arc::new(AtomicBool::new(false));
    let sink: PtySink = {
        let called = sink_called.clone();
        Arc::new(move |_| {
            called.store(true, Ordering::SeqCst);
        })
    };
    let master = session.master.clone();
    let exit = session.exit.clone();
    let owner = thread::spawn(move || {
        let result = finish_exit(&master, &exit, "owned-master", 7, &sink);
        drop(permit);
        result
    });
    let entered_before_receipt = entered.recv_timeout(Duration::from_secs(1)).is_ok();
    let registry_retained = manager.lock().unwrap().contains_key("owned-master");
    let no_receipt = wait_closed(&session, Duration::ZERO).is_err();
    let bounded_close_unknown = manager
        .close_with_timeout("owned-master", Duration::ZERO)
        .is_err();
    let update_blocked = admission.update().is_err();
    // This detects mutex-held Drop without blocking if the regression exists.
    let master_mutex_unlocked_and_empty =
        session.master.try_lock().is_ok_and(|value| value.is_none());
    let sink_waited = !sink_called.load(Ordering::SeqCst);
    // Always open the gate before assertions, including on the old ordering.
    drop_gate.release();
    let result = owner.join().unwrap();
    let closed = manager.close("owned-master");
    drop(session); // An extra caller Arc must never be the control-master owner.
    assert!(entered_before_receipt);
    assert!(registry_retained && no_receipt && bounded_close_unknown);
    assert!(update_blocked && sink_waited);
    assert!(master_mutex_unlocked_and_empty);
    assert!(result.is_ok());
    assert_eq!(closed.unwrap(), Some(7));
    assert!(admission.update().is_ok());
    assert_eq!(drop_gate.drops.load(Ordering::SeqCst), 1);
}
#[test]
fn registry_drop_requests_stop_while_the_real_owner_keeps_master_and_admission() {
    let (drop_gate, entered) = DropGate::new();
    let (manager, session) = fixture(drop_gate.clone());
    let admission = crate::managed_update::UpdateAdmission::default();
    let permit = admission.activity().unwrap();
    let master = session.master.clone();
    let exit = session.exit.clone();
    let stop = session.stop.clone();
    drop(session);
    let (start, starting) = sync_channel(1);
    let owner = thread::spawn(move || {
        starting.recv().unwrap();
        let sink: PtySink = Arc::new(|_| {});
        let result = finish_exit(&master, &exit, "owned-master", 0, &sink);
        drop(permit);
        result
    });
    // No master-slot Arc is held by this caller; only the real owner remains.
    drop(manager);
    let stop_requested = stop.load(Ordering::SeqCst);
    let no_drop_on_caller = entered.try_recv().is_err();
    let admission_still_held = admission.update().is_err();
    start.send(()).unwrap();
    let entered_by_owner = entered.recv_timeout(Duration::from_secs(1)).is_ok();
    drop_gate.release();
    let result = owner.join().unwrap();
    assert!(stop_requested && no_drop_on_caller && admission_still_held);
    assert!(entered_by_owner && result.is_ok());
    assert!(admission.update().is_ok());
    assert_eq!(drop_gate.drops.load(Ordering::SeqCst), 1);
}

// This controlled panic occurs in the REAL borrowed sole-owner settle path,
// before the fake child has exited. No OS process or production hook is used.
#[cfg(unix)]
#[derive(Debug, Default)]
struct PanicChildState {
    killed: AtomicBool,
    reaped: AtomicBool,
    kill_calls: AtomicUsize,
}
#[cfg(unix)]
#[derive(Debug)]
struct PanicChild {
    state: Arc<PanicChildState>,
    panic_first_wait: bool,
}
#[cfg(unix)]
#[derive(Debug)]
struct PanicKiller(Arc<PanicChildState>);
#[cfg(unix)]
impl portable_pty::ChildKiller for PanicKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        self.0.kill_calls.fetch_add(1, Ordering::SeqCst);
        self.0.killed.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(Self(self.0.clone()))
    }
}
#[cfg(unix)]
impl portable_pty::ChildKiller for PanicChild {
    fn kill(&mut self) -> std::io::Result<()> {
        PanicKiller(self.state.clone()).kill()
    }
    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(PanicKiller(self.state.clone()))
    }
}
#[cfg(unix)]
impl portable_pty::Child for PanicChild {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        if self.panic_first_wait {
            self.panic_first_wait = false;
            panic!("controlled test panic before child exit");
        }
        if self.state.killed.load(Ordering::SeqCst) {
            self.state.reaped.store(true, Ordering::SeqCst);
            Ok(Some(portable_pty::ExitStatus::with_exit_code(1)))
        } else {
            Ok(None)
        }
    }
    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        self.try_wait()?
            .ok_or_else(|| std::io::Error::other("fake child still running"))
    }
    fn process_id(&self) -> Option<u32> {
        None
    }
}
#[cfg(unix)]
#[test]
fn controlled_owner_panic_reaps_the_same_child_before_attempting_master_retirement() {
    let state = Arc::new(PanicChildState::default());
    let observed = state.clone();
    let (drop_gate, entered) = DropGate::new();
    let (manager, session) = fixture(drop_gate.clone());
    let master = session.master.clone();
    let exit = session.exit.clone();
    let stop = session.stop.clone();
    let admission = crate::managed_update::UpdateAdmission::default();
    let permit = admission.activity().unwrap();
    let sink_called = Arc::new(AtomicBool::new(false));
    let called = sink_called.clone();
    let owner = thread::spawn(move || {
        let mut child = PanicChild {
            state,
            panic_first_wait: true,
        };
        let group = crate::process_platform::OwnedGroup;
        let sink: PtySink = Arc::new(move |_| {
            called.store(true, Ordering::SeqCst);
        });
        let settled = TerminalOwner {
            child: &mut child,
            _group: &group,
            pid: None,
            stop: &stop,
            master: &master,
            exit: &exit,
            id: "owned-master",
            on_output: &sink,
        }
        .settle();
        // Only fake resources exist. Production's outer worker retains unknown
        // admission after false; this test stops after proving the real seam.
        drop(permit);
        settled
    });
    let retired_after_panic = entered.recv_timeout(Duration::from_secs(1)).is_ok();
    let same_child_killed_and_reaped = observed.killed.load(Ordering::SeqCst)
        && observed.reaped.load(Ordering::SeqCst)
        && observed.kill_calls.load(Ordering::SeqCst) > 0;
    let no_receipt = session.exit.0.try_lock().is_ok_and(|value| value.is_none());
    let master_unlocked = session.master.try_lock().is_ok_and(|value| value.is_none());
    let retained_activity_while_retiring = admission.update().is_err();
    let no_sink = !sink_called.load(Ordering::SeqCst);
    // Always release any gated destructor before assertions on either variant.
    drop_gate.release();
    let settled = owner.join().unwrap();
    drop(manager);
    drop(session);
    assert!(retired_after_panic && same_child_killed_and_reaped);
    assert!(no_receipt && no_sink && !settled);
    assert!(master_unlocked && retained_activity_while_retiring);
    assert_eq!(drop_gate.drops.load(Ordering::SeqCst), 1);
}
