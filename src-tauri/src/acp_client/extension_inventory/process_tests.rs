//! Real fixed-exchange pipe/owner tests; never launches an installed Agent.
use super::*;
use std::io::Write;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

struct ControlState {
    interested: AtomicBool,
    spawned: AtomicBool,
    deadline: Instant,
}
impl ControlState {
    fn new() -> Self {
        Self {
            interested: AtomicBool::new(true),
            spawned: AtomicBool::new(false),
            deadline: Instant::now() + Duration::from_secs(3),
        }
    }
}
impl Control for ControlState {
    fn interested(&self) -> bool {
        self.interested.load(Ordering::SeqCst)
    }
    fn deadline(&self) -> Instant {
        self.deadline
    }
    fn pending_cleanup(&self) {}
    fn spawned(&self) {
        self.spawned.store(true, Ordering::SeqCst);
    }
}
fn peer(code: &str) -> Command {
    let mut command = Command::new(crate::platform_tests::python());
    command.args(["-u", "-c", code]);
    command
}
struct InputFrame {
    bytes: Vec<u8>,
    sent: usize,
}
impl InputFrame {
    fn new() -> Self {
        Self {
            bytes: (0..262144).map(|n| (n % 251) as u8).collect(),
            sent: 0,
        }
    }
}
impl FixedExchange for InputFrame {
    fn write(&mut self, writer: &mut dyn Write) -> Result<()> {
        if self.sent == self.bytes.len() {
            return Ok(());
        }
        match writer.write(&self.bytes[self.sent..]) {
            Ok(0) => Err(Code::QueryFailed.into()),
            Ok(count) => {
                assert!(
                    count <= 8192,
                    "one fixed input turn exceeded the output fairness quantum"
                );
                self.sent += count;
                Ok(())
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                Ok(())
            }
            Err(_) => Err(Code::QueryFailed.into()),
        }
    }
    fn received(&mut self, _: &mut Vec<u8>) -> Result<()> {
        Ok(())
    }
    fn done(&self) -> bool {
        self.sent == self.bytes.len()
    }
}

#[test]
fn fixed_input_preserves_large_frame_and_closes_only_after_last_byte() {
    let state = ControlState::new();
    let mut exchange = InputFrame::new();
    let command = peer(
        "import sys;data=sys.stdin.buffer.read();sys.stdout.buffer.write(data);sys.stdout.buffer.flush();sys.stderr.write('private diagnostic')",
    );
    let output = run_owned(command, &state, Some(&mut exchange), 1048576).unwrap();
    assert_eq!(output, exchange.bytes);
    assert_eq!(exchange.sent, exchange.bytes.len());
    assert!(state.spawned.load(Ordering::SeqCst));
}
#[test]
fn fixed_no_input_keeps_owned_stdout_stderr_and_null_stdin() {
    let command = peer(
        "import sys;assert sys.stdin.buffer.read()==b'';sys.stdout.write('owned-output');sys.stderr.write('private diagnostic')",
    );
    let state = ControlState::new();
    assert_eq!(
        run_owned(command, &state, None, 1048576).unwrap(),
        b"owned-output"
    );
}
#[test]
fn fixed_input_saturation_does_not_block_output_cap_or_owned_exit() {
    let command = peer(
        "import sys,time;sys.stdout.buffer.write(b'x'*65536);sys.stdout.buffer.flush();sys.stderr.buffer.write(b'y'*65536);sys.stderr.buffer.flush();time.sleep(30)",
    );
    let state = ControlState::new();
    let mut exchange = InputFrame::new();
    let result = run_owned(command, &state, Some(&mut exchange), 16384);
    assert_eq!(result.unwrap_err().code, Code::OutputLimit);
    assert!(state.spawned.load(Ordering::SeqCst));
}
#[test]
fn fixed_input_saturation_keeps_cancellation_live_and_pre_cancel_starts_nothing() {
    let state = Arc::new(ControlState::new());
    state.interested.store(false, Ordering::SeqCst);
    let command = peer("raise RuntimeError('must not start')");
    assert_eq!(
        run_owned(command, state.as_ref(), None, 1048576)
            .unwrap_err()
            .code,
        Code::Cancelled
    );
    assert!(!state.spawned.load(Ordering::SeqCst));
    state.interested.store(true, Ordering::SeqCst);
    let observer = state.clone();
    let cancel = std::thread::spawn(move || {
        while !observer.spawned.load(Ordering::SeqCst) && Instant::now() < observer.deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(50));
        observer.interested.store(false, Ordering::SeqCst);
    });
    let command = peer("import time;time.sleep(30)");
    let mut exchange = InputFrame::new();
    let result = run_owned(command, state.as_ref(), Some(&mut exchange), 1048576);
    cancel.join().unwrap();
    assert_eq!(result.unwrap_err().code, Code::Cancelled);
    assert!(exchange.sent < exchange.bytes.len());
}
