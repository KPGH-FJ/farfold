//! Shared test-only headless terminal consumer; never a production cursor.
use crate::pty::{PtyManager, PtySink};
use base64::engine::general_purpose::STANDARD as BASE64;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Default)]
pub(crate) struct CursorCapture {
    pub(crate) tail: Vec<u8>,
    pub(crate) bytes: usize,
    pub(crate) queries: usize,
    pub(crate) replies: usize,
    pub(crate) pending: usize,
    pub(crate) failed: bool,
}

impl CursorCapture {
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> usize {
        let Some(total) = self.bytes.checked_add(bytes.len()) else {
            self.failed = true;
            return 0;
        };
        if total > 1024 * 1024 {
            self.failed = true;
            return 0;
        }
        self.bytes = total;
        let mut found = 0;
        for byte in bytes {
            self.tail.push(*byte);
            if self.tail.len() == 4 {
                if self.tail == b"\x1b[6n" {
                    self.queries += 1;
                    if self.queries > 8 {
                        self.failed = true;
                    } else {
                        found += 1;
                    }
                }
                self.tail.remove(0);
            }
        }
        found
    }
}

pub(crate) struct CursorConsumer {
    pub(crate) capture: Arc<Mutex<CursorCapture>>,
    stop: Arc<AtomicBool>,
    receiver: Option<std::sync::mpsc::Receiver<()>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl CursorConsumer {
    /// Test-only Tauri boundary. Original terminal_output still forwards the
    /// same frame and owns configuration/attempt release; this reader only
    /// observes its serialized controlled output and uses public pty.write.
    pub(crate) fn channel(reply: bool) -> (tauri::ipc::Channel<serde_json::Value>, Self) {
        let (sink, consumer) = Self::new(reply);
        let observed = consumer.capture.clone();
        let output = tauri::ipc::Channel::new(move |body| {
            match body.deserialize::<serde_json::Value>() {
                Ok(value) => sink(value),
                Err(_) => observed.lock().unwrap().failed = true,
            }
            Ok(())
        });
        (output, consumer)
    }

    pub(crate) fn assert_settled(&self) {
        let state = self.capture.lock().unwrap();
        assert!(!state.failed && state.pending == 0);
        assert_eq!(state.replies, state.queries);
    }

    pub(crate) fn new(reply: bool) -> (PtySink, Self) {
        let capture = Arc::new(Mutex::new(CursorCapture::default()));
        let observed = capture.clone();
        let (send, receiver) = std::sync::mpsc::sync_channel(8);
        let sink: PtySink = Arc::new(move |value| {
            let Some(data) = value.get("data").and_then(serde_json::Value::as_str) else {
                return;
            };
            let Ok(bytes) = base64::Engine::decode(&BASE64, data) else {
                observed.lock().unwrap().failed = true;
                return;
            };
            let mut state = observed.lock().unwrap();
            if bytes.len() > 8192 {
                state.failed = true;
                return;
            }
            let queries = state.feed(&bytes);
            if reply {
                for _ in 0..queries {
                    // Reader callback never waits on manager registry, writer,
                    // response thread or a full queue, including during spawn.
                    if send.try_send(()).is_ok() {
                        state.pending += 1;
                    } else {
                        state.failed = true;
                    }
                }
            }
        });
        (
            sink,
            Self {
                capture,
                stop: Arc::new(AtomicBool::new(false)),
                receiver: Some(receiver),
                worker: None,
            },
        )
    }

    pub(crate) fn start(&mut self, manager: std::sync::Weak<PtyManager>, id: String, reply: bool) {
        let receiver = self.receiver.take().unwrap();
        if !reply {
            drop(receiver);
            return;
        }
        let capture = self.capture.clone();
        let stop = self.stop.clone();
        self.worker = Some(thread::spawn(move || {
            loop {
                match receiver.recv_timeout(Duration::from_millis(20)) {
                    Ok(()) => {
                        // Only the ordinary public input operation is used. No
                        // production hooks, native handles or output rewrite.
                        let sent = manager
                            .upgrade()
                            .is_some_and(|manager| manager.write(&id, b"\x1b[1;1R").is_ok());
                        let mut state = capture.lock().unwrap();
                        state.pending -= 1;
                        if sent {
                            state.replies += 1;
                        } else {
                            state.failed = true;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if stop.load(Ordering::SeqCst) {
                            return;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        }));
    }

    pub(crate) fn phase(&self, phase: &str, reply: bool, started: Instant) {
        let state = self.capture.lock().unwrap();
        eprintln!(
            "FARFOLD_TERMINAL_CURSOR {}",
            serde_json::json!({
                "phase":phase,"replyEnabled":reply,"elapsedMillis":started.elapsed().as_millis(),
                "bytes":state.bytes,"queries":state.queries,"replies":state.replies,
                "pending":state.pending,"failed":state.failed,
                "cursorCoverage":if state.queries == 0 { "notCovered" } else { "observed" }
            })
        );
    }

    pub(crate) fn finish(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

impl Drop for CursorConsumer {
    fn drop(&mut self) {
        // A panic never synthesizes cleanup. The existing parent still owns
        // the original child+Job+pipes and enforces the same 20s test budget.
        self.stop.store(true, Ordering::SeqCst);
    }
}
