//! The real Hub + byte pump on owned UnixStreams. Peers deliberately control
//! their ACKs here; separate subprocess tests exercise the actual helper stdout.
use super::super::stream::ChannelPolicy;
use super::*;
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::sync::atomic::AtomicUsize;

struct ExecutionRequest {
    scope: FixedPageReadScope,
    finished: Arc<AtomicBool>,
    send: mpsc::Sender<Result<Value, ToolFailure>>,
}
impl ExecutionRequest {
    fn complete(self, text: &str) {
        self.finished.store(true, Ordering::Release);
        self.send.send(Ok(json!({"text":text}))).unwrap();
    }
}
struct Fixture {
    handle: TransportHandle,
    gate: Arc<Gate>,
    incoming: mpsc::Sender<Stream>,
    reads: mpsc::Receiver<ExecutionRequest>,
    ready: Arc<AtomicUsize>,
    done: Option<std::thread::JoinHandle<bool>>,
}
impl Fixture {
    fn new() -> Self {
        let gate = Arc::new(Gate::default());
        let (scope, _) =
            crate::browser_workspace::sharing_scope_fixture("owned-task", "owned-page");
        let page = Arc::new(Mutex::new(Some(scope)));
        let (send, reads) = mpsc::channel();
        let execution = Execution {
            screenshots: false,
            read: Arc::new(move |scope, _, finished, result| {
                send.send(ExecutionRequest {
                    scope,
                    finished,
                    send: result,
                })
                .unwrap();
                tauri::async_runtime::spawn(std::future::pending())
            }),
        };
        let (incoming, accepted) = mpsc::channel();
        let (controls, receive) = mpsc::channel();
        let shutdown = Arc::new(AtomicBool::new(false));
        let (complete, completed) = watch::channel(0);
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
            live: Arc::new(|| true),
            callbacks: hub::Callbacks {
                ready: Arc::new(move || {
                    ready_count.fetch_add(1, Ordering::AcqRel);
                }),
                closed: Arc::new(|_| {}),
                permission: Arc::new(|_| Err("not granted".into())),
                invalidated: Arc::new(|_| {}),
            },
            incoming: Box::new(
                move |_| match accepted.recv_timeout(Duration::from_millis(10)) {
                    Ok(stream) => Ok(Some(stream)),
                    Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
                    Err(_) => Err(()),
                },
            ),
        };
        let done = std::thread::spawn(move || {
            let clean = hub.run();
            let _ = complete.send(if clean { 1 } else { 2 });
            clean
        });
        Self {
            handle,
            gate,
            incoming,
            reads,
            ready,
            done: Some(done),
        }
    }
    fn peer(&self) -> Peer {
        let (local, remote) = Stream::pair().unwrap();
        remote
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        self.incoming.send(local).unwrap();
        Peer {
            read: BufReader::new(remote.try_clone().unwrap()),
            stream: remote,
        }
    }
    fn read(&self) -> ExecutionRequest {
        self.reads.recv_timeout(Duration::from_secs(3)).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.handle.shutdown();
        if let Some(done) = self.done.take() {
            let _ = done.join();
        }
    }
}
struct Peer {
    stream: Stream,
    read: BufReader<Stream>,
}
impl Peer {
    fn send(&mut self, value: Value) {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        self.stream.write_all(&bytes).unwrap();
    }
    fn receive(&mut self) -> Value {
        let mut line = String::new();
        assert_ne!(self.read.read_line(&mut line).unwrap(), 0);
        serde_json::from_str(&line).unwrap()
    }
    fn call(&mut self, id: u64, method: &str, params: Value) {
        self.send(json!({"kind":"request","message":{"jsonrpc":"2.0","id":id,"method":method,"params":params}}));
    }
    fn ack(&mut self, packet: &Value) {
        self.send(json!({"kind":"written","delivery":packet["delivery"]}));
    }
    fn initialize_only(&mut self) {
        self.call(1,"initialize",json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"owned-test"}}));
        let packet = self.receive();
        assert!(packet["message"]["result"]["capabilities"].is_object());
        self.ack(&packet);
        self.send(json!({"kind":"request","message":{"jsonrpc":"2.0","method":"notifications/initialized"}}));
    }
    fn ready(&mut self) {
        self.initialize_only();
        self.call(2, "tools/list", json!({}));
        let packet = self.receive();
        assert!(packet["message"]["result"]["tools"].is_array());
        self.ack(&packet);
    }
    fn read_page(&mut self) {
        self.call(
            7,
            "tools/call",
            json!({"name":"read_page_snapshot","arguments":{}}),
        );
    }
    fn stop_ack(&mut self, packet: &Value, delta: u64) {
        self.send(json!({"kind":"stopped","barrier":packet["barrier"].as_u64().unwrap()+delta,"stdoutClosed":false}));
    }
}
fn until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !condition() {
        assert!(Instant::now() < deadline, "condition deadline");
        std::thread::yield_now();
    }
}

#[test]
fn same_rpc_ids_on_two_channels_cannot_cancel_or_ack_each_other() {
    let f = Fixture::new();
    let mut a = f.peer();
    let mut b = f.peer();
    a.ready();
    b.ready();
    until(|| f.ready.load(Ordering::Acquire) == 2);
    a.read_page();
    let original = f.read();
    b.send(json!({"kind":"request","message":{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}}));
    b.read_page();
    let denied = b.receive();
    assert_eq!(denied["message"]["result"]["isError"], true);
    b.ack(&denied);
    assert!(original.scope.is_valid());
    assert!(f.reads.try_recv().is_err());
    original.complete("controlled-public");
    let result = a.receive();
    assert_eq!(result["message"]["id"], 7);
    b.ack(&result); // Same local serial on B is not an acknowledgement for A.
    b.read_page();
    let still_denied = b.receive();
    assert_eq!(still_denied["message"]["result"]["isError"], true);
    b.ack(&still_denied);
    assert!(f.reads.try_recv().is_err());
    a.ack(&result);
    until(|| f.gate.0.lock().unwrap().reading.is_none());
    b.read_page();
    f.read().complete("second-explicit-read");
    let result = b.receive();
    assert_eq!(result["message"]["id"], 7);
    b.ack(&result);
}

#[tokio::test]
async fn withdrawal_waits_for_every_helper_and_rejects_a_late_wrong_ack() {
    let f = Fixture::new();
    let mut a = f.peer();
    let mut b = f.peer();
    a.ready();
    b.ready();
    until(|| f.ready.load(Ordering::Acquire) == 2);
    let handle = f.handle.clone();
    let stop = tokio::spawn(async move { handle.quiesce().await });
    tokio::task::yield_now().await;
    let sa = a.receive();
    let sb = b.receive();
    assert_eq!(sa["kind"], "stop");
    assert_eq!(sb["kind"], "stop");
    a.stop_ack(&sa, 0);
    b.stop_ack(&sb, 1);
    assert!(!f.gate.available());
    assert!(!stop.is_finished());
    let mut rebuilt = f.peer(); // It remains queued until the complete barrier.
    rebuilt.call(1, "ping", json!({}));
    b.stop_ack(&sb, 0);
    assert!(stop.await.unwrap().is_ok());
    let response = rebuilt.receive();
    assert_eq!(response["message"]["id"], 1);
    rebuilt.ack(&response);
    assert!(f.gate.available());
}

#[test]
fn helper_eof_during_an_unconfirmed_read_poisoned_owner_cannot_rebuild() {
    let f = Fixture::new();
    let mut a = f.peer();
    a.ready();
    until(|| f.ready.load(Ordering::Acquire) == 1);
    a.read_page();
    let original = f.read();
    drop(a);
    until(|| f.gate.unknown());
    assert!(!original.scope.is_valid());
    assert!(!f.gate.available());
    assert!(f.reads.try_recv().is_err());
    let epoch = f.gate.retire();
    assert!(!f.gate.settle(epoch));
    assert!(
        !ChannelLease {
            id: 99,
            gate: f.gate.clone(),
            live: Arc::new(|| true)
        }
        .admit()
    );
}

#[test]
fn idle_discovery_eof_preserves_controller_for_a_later_helper() {
    let f = Fixture::new();
    let mut discovery = f.peer();
    discovery.ready();
    until(|| f.ready.load(Ordering::Acquire) == 1);
    drop(discovery);
    let mut call = f.peer();
    call.ready();
    until(|| f.ready.load(Ordering::Acquire) == 2);
    call.read_page();
    f.read().complete("actual-byte-pump");
    let packet = call.receive();
    assert_eq!(packet["message"]["id"], 7);
    call.ack(&packet);
    assert!(!f.gate.unknown());
}

#[test]
fn unknown_preserves_revoked_scope_until_registry_records_retirement() {
    let f = Fixture::new();
    let mut a = f.peer();
    a.ready();
    until(|| f.ready.load(Ordering::Acquire) == 1);
    a.read_page();
    let _request = f.read();
    drop(a);
    until(|| *f.handle.0.completed.borrow() != 0);
    let page = f.handle.0.page.lock().unwrap();
    let page = page
        .as_ref()
        .expect("registry still needs the original scope for STOP_FAILED");
    assert!(!page.is_valid(), "authority must already be withdrawn");
}

#[test]
fn idle_helper_eof_racing_shutdown_does_not_invent_unconfirmed_output() {
    let (local, remote) = Stream::pair().unwrap();
    local.set_nonblocking(true).unwrap();
    drop(remote);
    let (_, controls) = mpsc::channel();
    let mut worker = Worker {
        execution: Execution {
            screenshots: false,
            read: Arc::new(|_, _, _, _| panic!("no request")),
        },
        page: Arc::new(Mutex::new(None)),
        shutdown: Arc::new(AtomicBool::new(true)),
        controls,
        on_ready: Arc::new(|| {}),
        on_initialized: None,
        on_closed: Arc::new(|_| {}),
        on_permission: Arc::new(|_| panic!("no request")),
        on_invalidated: Arc::new(|_| {}),
        closed_notified: false,
    };
    let lease = ChannelLease {
        id: 1,
        gate: Arc::new(Gate::default()),
        live: Arc::new(|| true),
    };
    assert!(
        worker.serve_channel(local, Some(&lease)),
        "no response or request preceded this local shutdown"
    );
}

#[test]
fn eof_never_substitutes_for_a_missing_original_result_ack() {
    let mut wire = Wire::default();
    wire.reply(
        protocol::snapshot(json!(7), json!({"text":"original"})),
        None,
        false,
    )
    .unwrap();
    wire.stop(true, None).unwrap();
    assert!(!wire.clean_eof());
    wire.packets.clear(); // Complete broker writes still are not helper stdout ACKs.
    assert!(!wire.clean_eof());
    let barrier = wire.barrier.as_ref().unwrap().number;
    assert!(wire.acknowledge_written(barrier).is_none());
    assert!(!wire.clean_eof());
}

#[test]
fn a_rebuilt_initialized_channel_uses_only_its_own_controllers_delivered_catalog() {
    let f = Fixture::new();
    let mut discovery = f.peer();
    discovery.ready();
    until(|| f.ready.load(Ordering::Acquire) == 1);
    drop(discovery);
    let mut uninitialized = f.peer();
    uninitialized.read_page();
    let rejected = uninitialized.receive();
    assert_eq!(rejected["message"]["error"]["code"], -32002);
    uninitialized.ack(&rejected);
    let mut call = f.peer();
    call.initialize_only();
    call.read_page();
    let read = f.reads.recv_timeout(Duration::from_secs(1)).expect(
        "same controller already delivered its catalog; pool only initializes the rebuilt helper",
    );
    read.complete("reconstructed-official-shape");
    let result = call.receive();
    assert_eq!(result["message"]["id"], 7);
    call.ack(&result);
    let other = Fixture::new();
    let mut unlisted = other.peer();
    unlisted.initialize_only();
    unlisted.read_page();
    let denied = unlisted.receive();
    assert_eq!(denied["message"]["result"]["isError"], true);
    unlisted.ack(&denied);
    assert!(
        other.reads.try_recv().is_err(),
        "another controller cannot inherit the first list witness"
    );
}
