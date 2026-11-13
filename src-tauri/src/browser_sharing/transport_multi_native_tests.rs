//! Real Mach rendezvous and production helper subprocesses. Only page execution
//! is synthetic: no AppHandle, Agent, model, native page or bearer is involved.
use super::*;
use crate::browser_sharing::mach_channel::Server;
use serde_json::json;
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::atomic::AtomicUsize,
};

const WAIT: Duration = Duration::from_secs(10);
const CHILD_TEST: &str =
    "browser_sharing::transport::multi::native_tests::production_mach_helper_subprocess";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Process {
    pid: u32,
    uid: u32,
    parent: u32,
    seconds: u64,
    micros: u64,
}
impl Process {
    fn read(pid: u32) -> Option<Self> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let count = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        (count == size).then_some(Self {
            pid,
            uid: info.pbi_uid,
            parent: info.pbi_ppid,
            seconds: info.pbi_start_tvsec,
            micros: info.pbi_start_tvusec,
        })
    }
}

struct Fixture {
    handle: TransportHandle,
    gate: Arc<Gate>,
    name: String,
    pid: u32,
    children: Arc<Mutex<BTreeMap<u32, Process>>>,
    ready: Arc<AtomicUsize>,
    reads: Arc<AtomicUsize>,
    done: Option<std::thread::JoinHandle<bool>>,
}
impl Fixture {
    fn new() -> Self {
        Self::with_text("controlled public value".into())
    }
    fn with_text(text: String) -> Self {
        let server = Server::bind().expect("real Mach broker");
        let name = server.name().to_owned();
        let pid = server.broker_pid();
        let owner = Process::read(pid).unwrap();
        let children = Arc::new(Mutex::new(BTreeMap::<u32, Process>::new()));
        let accepted = children.clone();
        let gate = Arc::new(Gate::default());
        let (scope, _) =
            crate::browser_workspace::sharing_scope_fixture("native-helper-test", "public-page");
        let page = Arc::new(Mutex::new(Some(scope)));
        let reads = Arc::new(AtomicUsize::new(0));
        let read_count = reads.clone();
        let execution = Execution {
            screenshots: false,
            read: Arc::new(move |scope, _, finished, send| {
                assert!(scope.is_valid());
                let number = read_count.fetch_add(1, Ordering::AcqRel) + 1;
                let text = text.clone();
                tauri::async_runtime::spawn(async move {
                    finished.store(true, Ordering::Release);
                    let _ = send.send(Ok(json!({"text":text,"read":number})));
                })
            }),
        };
        let (controls, receive) = mpsc::channel();
        let (complete, completed) = watch::channel(0);
        let shutdown = Arc::new(AtomicBool::new(false));
        let ready = Arc::new(AtomicUsize::new(0));
        let ready_count = ready.clone();
        let handle = TransportHandle(Arc::new(HandleInner {
            page: page.clone(),
            controls,
            shutdown: shutdown.clone(),
            completed,
            initialized: Arc::new(AtomicBool::new(false)),
            listed: Arc::new(AtomicBool::new(false)),
            multi: Some(gate.clone()),
        }));
        let hub = hub::Hub {
            execution,
            page,
            gate: gate.clone(),
            shutdown,
            controls: receive,
            live: Arc::new(move || Process::read(pid) == Some(owner)),
            callbacks: hub::Callbacks {
                ready: Arc::new(move || {
                    ready_count.fetch_add(1, Ordering::AcqRel);
                }),
                closed: Arc::new(|_| {}),
                permission: Arc::new(|_| Err("fixture has no renewed page permission".into())),
                invalidated: Arc::new(|_| {}),
            },
            incoming: Box::new(move |gate| {
                server.accept(
                    &|peer| {
                        gate.available()
                            && Process::read(pid) == Some(owner)
                            && accepted
                                .lock()
                                .unwrap()
                                .get(&peer.pid)
                                .is_some_and(|child| {
                                    child.uid == peer.uid
                                        && child.parent == pid
                                        && Process::read(peer.pid).as_ref() == Some(child)
                                })
                    },
                    Duration::from_millis(25),
                )
            }),
        };
        let done = std::thread::spawn(move || {
            let clean = hub.run();
            let _ = complete.send(if clean { 1 } else { 2 });
            clean
        });
        Self {
            handle,
            gate,
            name,
            pid,
            children,
            ready,
            reads,
            done: Some(done),
        }
    }
    fn helper(&self) -> Helper {
        Helper::spawn(&self.name, self.pid, Some(&self.children))
    }
    fn idle(&self) {
        until(|| self.gate.0.lock().unwrap().reading.is_none());
        assert!(!self.gate.unknown());
    }
    fn close(&mut self) {
        self.handle.shutdown();
        until(|| self.done.as_ref().unwrap().is_finished());
        assert!(self.done.take().unwrap().join().unwrap());
        assert_eq!(*self.handle.0.completed.borrow(), 1);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.handle.shutdown();
        if let Some(done) = self.done.take() {
            let deadline = Instant::now() + WAIT;
            while !done.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if done.is_finished() {
                let _ = done.join();
            } else {
                eprintln!("owned Mach test broker did not finish within cleanup deadline");
            }
        }
    }
}

struct Helper {
    child: Child,
    input: Option<ChildStdin>,
    messages: mpsc::Receiver<Result<Value, String>>,
    consume: Option<mpsc::Sender<()>>,
    consumed_bytes: Arc<AtomicUsize>,
    incomplete_bytes: Arc<AtomicUsize>,
    reader: Option<std::thread::JoinHandle<()>>,
    status: Option<ExitStatus>,
}
impl Helper {
    fn spawn(name: &str, pid: u32, children: Option<&Mutex<BTreeMap<u32, Process>>>) -> Self {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                CHILD_TEST,
                "--ignored",
                "--nocapture",
                "--quiet",
                "--test-threads=1",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        if let Some(children) = children {
            let identity = Process::read(child.id()).unwrap();
            assert_eq!(identity.parent, std::process::id());
            children.lock().unwrap().insert(child.id(), identity);
        }
        let (send, messages) = mpsc::channel();
        let (consume, permits) = mpsc::channel();
        let consumed_bytes = Arc::new(AtomicUsize::new(0));
        let incomplete_bytes = Arc::new(AtomicUsize::new(0));
        let consumed = consumed_bytes.clone();
        let incomplete = incomplete_bytes.clone();
        let output = child.stdout.take().unwrap();
        let reader = std::thread::spawn(move || {
            let mut output = BufReader::new(output);
            // The consumer requests one MCP line at a time. Not requesting the
            // next line leaves the real stdout pipe unread, not a paused writer.
            while permits.recv().is_ok() {
                loop {
                    let mut bytes = Vec::new();
                    let result = (&mut output).take(700_001).read_until(b'\n', &mut bytes);
                    consumed.fetch_add(bytes.len(), Ordering::AcqRel);
                    match result {
                        Ok(0) => return,
                        Ok(_) if bytes.len() <= 700_000 => {
                            if !bytes.ends_with(b"\n") {
                                incomplete.store(bytes.len(), Ordering::Release);
                                let _ = send.send(Err("incomplete helper stdout frame".into()));
                                return;
                            }
                            let text = String::from_utf8_lossy(&bytes);
                            // Only libtest's fixed preamble precedes production stdout.
                            // No test-generated protocol frame or ACK is supplied.
                            if text.trim().is_empty() || text.trim() == "running 1 test" {
                                continue;
                            }
                            let message = serde_json::from_slice(&bytes)
                                .map_err(|error| format!("unexpected helper stdout: {error}"));
                            if send.send(message).is_err() {
                                return;
                            }
                            break;
                        }
                        other => {
                            let _ = send.send(Err(format!("helper stdout read failed: {other:?}")));
                            return;
                        }
                    }
                }
            }
        });
        let mut input = child.stdin.take().unwrap();
        writeln!(input, "{}", json!({"name":name,"pid":pid})).unwrap();
        Self {
            child,
            input: Some(input),
            messages,
            consume: Some(consume),
            consumed_bytes,
            incomplete_bytes,
            reader: Some(reader),
            status: None,
        }
    }
    fn send(&mut self, value: Value) {
        writeln!(self.input.as_mut().unwrap(), "{value}").unwrap();
    }
    fn receive(&self) -> Value {
        self.receive_result().unwrap()
    }
    fn receive_result(&self) -> Result<Value, String> {
        self.consume.as_ref().unwrap().send(()).unwrap();
        self.messages
            .recv_timeout(WAIT)
            .expect("real helper response")
    }
    fn call(&mut self, id: Value, method: &str, params: Value) -> Value {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        let response = self.receive();
        assert_eq!(response["id"], id);
        response
    }
    fn initialize_only(&mut self) {
        let initialized = self.call(json!(1), "initialize", json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"owned-test"}}));
        assert!(initialized["result"]["capabilities"]["tools"].is_object());
        self.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
    }
    fn ready(&mut self) {
        self.initialize_only();
        let listed = self.call(json!(2), "tools/list", json!({}));
        assert!(
            listed["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "read_page_snapshot")
        );
    }
    fn read_page(&mut self, id: Value) -> Value {
        self.call(
            id,
            "tools/call",
            json!({"name":"read_page_snapshot","arguments":{}}),
        )
    }
    fn finish(&mut self) -> ExitStatus {
        self.input.take();
        until(|| {
            self.status = self.child.try_wait().unwrap();
            self.status.is_some()
        });
        self.consume.take();
        if let Some(reader) = self.reader.take() {
            reader.join().unwrap();
        }
        self.status.unwrap()
    }
}
impl Drop for Helper {
    fn drop(&mut self) {
        self.input.take();
        self.consume.take();
        if self.status.is_none() {
            let deadline = Instant::now() + WAIT;
            while Instant::now() < deadline {
                match self.child.try_wait() {
                    Ok(Some(status)) => {
                        self.status = Some(status);
                        break;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                    Err(_) => break,
                }
            }
        }
        if self.status.is_some() {
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
        } else {
            eprintln!(
                "owned helper {} did not exit after stdin EOF",
                self.child.id()
            );
        }
    }
}

fn until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !condition() {
        assert!(Instant::now() < deadline, "owned helper condition deadline");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn real_helper_discovery_eof_allows_reconstruction_and_a_public_read() {
    let mut fixture = Fixture::new();
    let mut discovery = fixture.helper();
    discovery.ready();
    until(|| fixture.ready.load(Ordering::Acquire) == 1);
    assert!(discovery.finish().success());
    let mut rebuilt = fixture.helper();
    // Mistral's per-call helper initializes but does not repeat tools/list after
    // the discovery helper already delivered the same controller's catalog.
    rebuilt.initialize_only();
    let result = rebuilt.read_page(json!("original-call-id"));
    assert_eq!(
        result["result"]["structuredContent"]["text"],
        "controlled public value"
    );
    assert_eq!(fixture.reads.load(Ordering::Acquire), 1);
    fixture.idle();
    assert!(rebuilt.finish().success());
    fixture.close();
}

#[test]
fn real_stdout_backpressure_keeps_unknown_and_cannot_reexecute_after_rebuild() {
    let text = "p".repeat(200 * 1024);
    let response = protocol::snapshot(json!(7), json!({"text":text,"read":1}));
    let expected_bytes = serde_json::to_vec(&response).unwrap().len() + 1;
    assert!(expected_bytes > 400 * 1024 && expected_bytes < MAX_RESPONSE);
    let mut fixture = Fixture::with_text(text);
    let mut helper = fixture.helper();
    helper.ready();
    until(|| fixture.ready.load(Ordering::Acquire) == 1);
    let already_consumed = helper.consumed_bytes.load(Ordering::Acquire);
    // No receive permit follows this request. Production helper writes into its
    // real pipe until capacity/deadline; no test code blocks its execution thread.
    helper.send(json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"read_page_snapshot","arguments":{}}}));
    until(|| fixture.gate.unknown());
    assert_eq!(
        helper.consumed_bytes.load(Ordering::Acquire),
        already_consumed
    );
    assert!(!fixture.gate.available());
    assert_eq!(fixture.reads.load(Ordering::Acquire), 1);
    // Only now consume the physical pipe residue: there must have been an
    // actual partial stdout write, not merely a rejected oversize response.
    assert!(helper.receive_result().is_err());
    let partial = helper.incomplete_bytes.load(Ordering::Acquire);
    assert!(partial > 0 && partial < expected_bytes);
    assert!(
        helper.finish().code().is_some(),
        "normal exit, never a signal"
    );
    until(|| fixture.done.as_ref().unwrap().is_finished());
    assert!(!fixture.done.take().unwrap().join().unwrap());
    assert_eq!(*fixture.handle.0.completed.borrow(), 2);
    let mut rebuilt = Helper::spawn(&fixture.name, fixture.pid, None);
    assert_eq!(rebuilt.finish().code(), Some(1));
    assert!(fixture.gate.unknown());
    assert_eq!(fixture.reads.load(Ordering::Acquire), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_helpers_keep_equal_rpc_ids_separate_and_both_acknowledge_withdrawal() {
    let mut fixture = Fixture::new();
    let mut first = fixture.helper();
    let mut second = fixture.helper();
    first.ready();
    second.ready();
    until(|| fixture.ready.load(Ordering::Acquire) == 2);
    assert_eq!(
        first.read_page(json!(7))["result"]["structuredContent"]["read"],
        1
    );
    fixture.idle();
    assert_eq!(
        second.read_page(json!(7))["result"]["structuredContent"]["read"],
        2
    );
    fixture.idle();
    assert!(first.child.try_wait().unwrap().is_none());
    assert!(second.child.try_wait().unwrap().is_none());
    // No hand-built ACK is sent. This resolves only through each actual helper's
    // input/output gate and production stopped frame on its private channel.
    assert!(fixture.handle.quiesce().await.is_ok());
    assert!(fixture.handle.0.page.lock().unwrap().is_none());
    assert!(fixture.gate.available());
    assert_eq!(first.read_page(json!(8))["result"]["isError"], true);
    fixture.idle();
    assert_eq!(second.read_page(json!(8))["result"]["isError"], true);
    fixture.idle();
    assert_eq!(fixture.reads.load(Ordering::Acquire), 2);
    assert!(first.finish().success());
    assert!(second.finish().success());
    fixture.close();
}

#[test]
fn a_public_old_name_cannot_rebuild_after_the_real_hub_has_closed() {
    let mut fixture = Fixture::new();
    let mut helper = fixture.helper();
    helper.ready();
    until(|| fixture.ready.load(Ordering::Acquire) == 1);
    fixture.close();
    assert!(helper.finish().success());
    let mut old = Helper::spawn(&fixture.name, fixture.pid, None);
    assert_eq!(old.finish().code(), Some(1));
    assert!(matches!(
        old.messages.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
    assert_eq!(fixture.reads.load(Ordering::Acquire), 0);
}

#[test]
#[ignore = "private subprocess entry; parent supplies an owned public Mach name"]
fn production_mach_helper_subprocess() {
    let result = (|| {
        // libc single-byte reads deliberately avoid Stdin's buffering: no MCP
        // request after the bootstrap newline may be consumed before run_mach.
        let mut bootstrap = Vec::new();
        loop {
            let mut byte = 0_u8;
            let count = unsafe { libc::read(libc::STDIN_FILENO, (&mut byte as *mut u8).cast(), 1) };
            if count < 0
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
            {
                continue;
            }
            if count != 1 || bootstrap.len() >= 512 {
                return Err(());
            }
            if byte == b'\n' {
                break;
            }
            bootstrap.push(byte);
        }
        let value: Value = serde_json::from_slice(&bootstrap).map_err(|_| ())?;
        let name = value["name"].as_str().ok_or(())?;
        let pid = u32::try_from(value["pid"].as_u64().ok_or(())?).map_err(|_| ())?;
        helper::run_mach(name, pid)
    })();
    // Production helper owns/closes stdout. Never run libtest's trailing print.
    std::process::exit(result.unwrap_or(1));
}
