//! Real queued OpenSession delivery with controlled peers, never official Agents.
use super::*;
use crate::acp_client::{
    lifecycle::{ConnectionLife, OpenReservations},
    manager::{ManagedConnection, ManagerCommand},
    model_guard::ConfigStore,
    operations::{OpenDelivery, QueuedCommand},
    pump::OpenedSession,
};
use std::future::Future;
use std::sync::{Mutex, atomic::Ordering};
use std::task::{Context, Wake, Waker};
use tokio::sync::{Notify, oneshot};

struct AtDelivery {
    life: Arc<ConnectionLife>,
    openings: OpenReservations,
    agent: String,
    cwd: PathBuf,
    native: String,
    receive: Mutex<Option<oneshot::Receiver<Result<OpenDelivery, String>>>>,
    outcome: Mutex<Option<Result<OpenedSession, String>>>,
    drop_at_delivery: bool,
    available: Mutex<Vec<(bool, bool)>>,
    notified: Notify,
}

impl Wake for AtDelivery {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        // This runs synchronously inside the real result Sender::send. Do not
        // yield, block awaiting release, or retain the new observation guards.
        let mut receive = self.receive.lock().unwrap().take().unwrap();
        if self.drop_at_delivery {
            // Drop while Sender::send is still notifying this receiver.
            drop(receive);
        } else {
            let outcome = receive.try_recv().unwrap().and_then(OpenDelivery::accept);
            *self.outcome.lock().unwrap() = Some(outcome);
        }
        let operation = self.life.operation(format!("open:{}", self.native));
        let opening = self.openings.reserve(&self.agent, &self.cwd, &self.native);
        self.available
            .lock()
            .unwrap()
            .push((operation.is_ok(), opening.is_ok()));
        drop((operation, opening));
        self.notified.notify_one();
    }
}

fn send_open(
    f: &Fixture,
    connection: &ManagedConnection,
    native: &str,
    result: oneshot::Sender<Result<OpenDelivery, String>>,
    deadline: Option<tokio::time::Instant>,
) {
    send_open_history(f, connection, native, result, deadline, None);
}
fn send_open_history(
    f: &Fixture,
    connection: &ManagedConnection,
    native: &str,
    result: oneshot::Sender<Result<OpenDelivery, String>>,
    deadline: Option<tokio::time::Instant>,
    history: Option<crate::acp_client::history_admission::Permit>,
) {
    let opening = f
        .manager
        .opening_sessions
        .reserve(&f.row.id, &f.cwd, native)
        .unwrap();
    let command = ManagerCommand::OpenSession {
        fork_owned: false,
        native_session_id: Some(native.into()),
        preview_token: Some("delivery-fixture".into()),
        opening_token: None,
        recorded_config: None,
        config_store: Box::new(ConfigStore {
            store: f.store.clone(),
            agent_id: f.row.id.clone(),
            cwd: f.cwd.to_string_lossy().into(),
            service_record: None,
            expected_model: None,
            verified_permission_option: false,
        }),
        config_options: vec![],
        mcp: None,
        browser_unavailable: None,
        events: Arc::new(|_| {}),
        result,
    };
    if let Some(deadline) = deadline {
        // Only the test controls the existing queue deadline. Production still
        // uses send_reserved's standard budget; dispatch and pump are unchanged.
        let lease = connection
            .life
            .operation_with_history(command.operation_key(), history)
            .unwrap()
            .with_opening(Some(opening));
        connection
            .command_tx
            .send(QueuedCommand {
                command,
                deadline,
                _lease: lease,
            })
            .unwrap();
    } else {
        connection
            .send_reserved_with_history(command, Some(opening), history)
            .unwrap();
    }
}

async fn terminal_delivery(failed: bool, drop_at_delivery: bool) {
    let f = Fixture::new();
    if failed {
        let original = " elif method=='session/load': threading.Thread(target=loaded,args=(m,),daemon=True).start()";
        let peer = PEER.replace(original, " elif method=='session/load': send({'id':m['id'],'error':{'code':-32603,'message':'controlled load failure'}})");
        assert_ne!(peer, PEER);
        std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
    }
    f.connect().await;
    let connection = f.manager.lock().unwrap().values().next().unwrap().clone();
    let pid = connection.child_pid.load(Ordering::SeqCst);
    let (result, receive) = oneshot::channel();
    let observer = Arc::new(AtDelivery {
        life: connection.life.clone(),
        openings: f.manager.opening_sessions.clone(),
        agent: f.row.id.clone(),
        cwd: f.cwd.clone(),
        native: "restored".into(),
        receive: Mutex::new(Some(receive)),
        outcome: Mutex::new(None),
        drop_at_delivery,
        available: Mutex::new(vec![]),
        notified: Notify::new(),
    });
    let waker = Waker::from(observer.clone());
    assert!(
        std::pin::Pin::new(observer.receive.lock().unwrap().as_mut().unwrap())
            .poll(&mut Context::from_waker(&waker))
            .is_pending()
    );
    send_open(&f, &connection, "restored", result, None);
    // Do not poll receive with a different waker before observing delivery.
    tokio::time::timeout(Duration::from_secs(10), observer.notified.notified())
        .await
        .unwrap();
    let outcome = observer.outcome.lock().unwrap().take();
    let has_route = connection.sessions.lock().unwrap().contains_key("restored");
    let at_delivery = observer.available.lock().unwrap().clone();
    let closed = if !failed && !drop_at_delivery {
        Some(
            f.manager
                .close_session_owned(&f.row.id, &f.cwd, "restored", Some("delivery-fixture"))
                .await,
        )
    } else {
        None
    };
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    let gone = crate::platform_tests::process_check(pid as i32) != 0;
    eprintln!("open-delivery fixture pid={pid} reaped={gone}");
    assert!(
        gone,
        "the exact controlled child must be gone before assertions"
    );
    if !drop_at_delivery {
        assert_eq!(outcome.unwrap().is_err(), failed);
    }
    assert_eq!(has_route, !failed && !drop_at_delivery);
    if let Some(closed) = closed {
        assert!(closed.is_ok());
    }
    assert_eq!(at_delivery, vec![(true, failed || !drop_at_delivery)]);
    assert!(
        f.manager
            .opening_sessions
            .reserve(&f.row.id, &f.cwd, "restored")
            .is_ok()
    );
}

#[tokio::test]
async fn open_delivery_success_releases_both_reservations_before_actual_reply() {
    terminal_delivery(false, false).await;
}

#[tokio::test]
async fn open_delivery_failure_releases_both_reservations_before_actual_reply() {
    terminal_delivery(true, false).await;
}

#[tokio::test]
async fn open_delivery_receiver_drops_during_notification_retains_identity_until_reaping() {
    terminal_delivery(false, true).await;
}

struct DeliveryNotice(Notify);
impl Wake for DeliveryNotice {
    fn wake(self: Arc<Self>) {
        self.0.notify_one();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.notify_one();
    }
}

#[tokio::test]
async fn open_delivery_buffered_success_is_owned_until_consumed_or_dropped() {
    let f = Fixture::new();
    f.connect().await;
    let connection = f.manager.lock().unwrap().values().next().unwrap().clone();
    let (result, mut receive) = oneshot::channel();
    let notice = Arc::new(DeliveryNotice(Notify::new()));
    assert!(
        std::pin::Pin::new(&mut receive)
            .poll(&mut Context::from_waker(&Waker::from(notice.clone())))
            .is_pending()
    );
    send_open(&f, &connection, "restored", result, None);
    tokio::time::timeout(Duration::from_secs(10), notice.0.notified())
        .await
        .unwrap();
    let before = available(&f, &connection, "restored");
    let had_route = connection.sessions.lock().unwrap().contains_key("restored");
    drop(receive); // Sender finished, but no manager caller accepted this result.
    let after = available(&f, &connection, "restored");
    let orphan_gone = !connection.sessions.lock().unwrap().contains_key("restored");
    let unconfirmed_retained = !connection.life.close(false, Some(Duration::ZERO)).unwrap();
    finish(&f, &connection).await;
    assert_eq!(before, (false, false));
    assert!(had_route);
    assert_eq!(after, (true, false));
    assert!(orphan_gone);
    assert!(unconfirmed_retained);
}

fn gated_peer(f: &Fixture) {
    let peer = PEER.replace(" time.sleep(.2)", "\n open(sys.argv[1]+'_loading','w').write('started')\n while not os.path.exists(sys.argv[1]+'_release'): time.sleep(.005)");
    assert_ne!(peer, PEER);
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
}

fn available(f: &Fixture, connection: &ManagedConnection, native: &str) -> (bool, bool) {
    let operation = connection.life.operation(format!("open:{native}"));
    let opening = f
        .manager
        .opening_sessions
        .reserve(&f.row.id, &f.cwd, native);
    (operation.is_ok(), opening.is_ok())
}

async fn finish(f: &Fixture, connection: &ManagedConnection) {
    let pid = connection.child_pid.load(Ordering::SeqCst);
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    let gone = crate::platform_tests::process_check(pid as i32) != 0;
    eprintln!("open-delivery fixture pid={pid} reaped={gone}");
    assert!(gone);
}

async fn abandoned_open(timeout: bool) {
    let f = Fixture::new();
    gated_peer(&f);
    f.connect().await;
    let connection = f.manager.lock().unwrap().values().next().unwrap().clone();
    let (result, receive) = oneshot::channel();
    send_open(
        &f,
        &connection,
        "restored",
        result,
        timeout.then(|| tokio::time::Instant::now() + Duration::from_secs(1)),
    );
    until(|| f.cwd.join("listed_loading").exists()).await;
    if timeout {
        let outcome = tokio::time::timeout(Duration::from_secs(3), receive)
            .await
            .unwrap()
            .unwrap();
        assert!(outcome.err().unwrap().contains("尚未确认"));
    } else {
        drop(receive);
    }
    let pending = available(&f, &connection, "restored");
    let other = available(&f, &connection, "other");
    std::fs::write(f.cwd.join("listed_release"), "release").unwrap();
    until(|| available(&f, &connection, "restored") == (true, false)).await;
    let orphan_gone = !connection.sessions.lock().unwrap().contains_key("restored");
    let unconfirmed_retained = !connection.life.close(false, Some(Duration::ZERO)).unwrap();
    // Retry through the public entry, not a fake channel-only implementation.
    let retry = f
        .manager
        .open_session_owned(
            &f.row,
            &f.cwd,
            Some("restored".into()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
            None,
            Some("retry".into()),
            None,
            None,
        )
        .await;
    assert!(
        retry.is_err(),
        "an unresolved native owner must reject a second process"
    );
    finish(&f, &connection).await;
    let reopened = f
        .manager
        .open_session_owned(
            &f.row,
            &f.cwd,
            Some("restored".into()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
            None,
            Some("retry-after-reaping".into()),
            None,
            None,
        )
        .await;
    let retried = reopened.is_ok();
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    assert_eq!(pending, (false, false));
    assert_eq!(other, (true, true));
    assert!(orphan_gone);
    assert!(unconfirmed_retained);
    assert!(retried);
}

#[tokio::test]
async fn open_delivery_timeout_keeps_native_reservation_until_actual_process_reaping() {
    abandoned_open(true).await;
}

#[tokio::test]
async fn open_delivery_abandoned_caller_keeps_native_reservation_until_actual_process_reaping() {
    abandoned_open(false).await;
}

#[tokio::test]
async fn open_delivery_unstarted_expired_or_closed_queue_never_sends_load() {
    for expired in [false, true] {
        let f = Fixture::new();
        gated_peer(&f);
        f.connect().await;
        let connection = f.manager.lock().unwrap().values().next().unwrap().clone();
        let (result, receive) = oneshot::channel();
        if expired {
            send_open(
                &f,
                &connection,
                "restored",
                result,
                Some(tokio::time::Instant::now()),
            );
            assert!(receive.await.is_err());
        } else {
            drop(receive);
            send_open(&f, &connection, "restored", result, None);
        }
        until(|| available(&f, &connection, "restored") == (true, true)).await;
        let sent = f.cwd.join("listed_loading").exists();
        finish(&f, &connection).await;
        assert!(!sent);
    }
}

#[tokio::test]
async fn cold_admission_unconsumed_delivery_holds_slot_until_real_reap() {
    cold_orphan_slot(false).await;
}
#[tokio::test]
async fn cold_admission_timeout_holds_slot_until_real_reap() {
    cold_orphan_slot(true).await;
}
async fn cold_orphan_slot(timeout: bool) {
    use crate::acp_client::history_admission::{Admission, Policy};
    let f = Fixture::new();
    if timeout {
        gated_peer(&f);
    }
    f.connect().await;
    let connection = f.manager.lock().unwrap().values().next().unwrap().clone();
    let gate = Admission::new(Policy {
        active: 1,
        pending: 1,
        bytes: 100,
    })
    .unwrap();
    let owner = |token: &str| gate.fixture_owner("owned", token, "fixture");
    let permit = gate
        .enqueue(owner("a"), 1)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let (send, mut receive) = oneshot::channel();
    // Move the sole A permit into production ownership. No test observer clone.
    send_open_history(
        &f,
        &connection,
        "retained",
        send,
        timeout.then(|| tokio::time::Instant::now() + Duration::from_secs(1)),
        Some(permit),
    );
    let waiting = gate.enqueue(owner("b"), 1).unwrap();
    if timeout {
        until(|| f.cwd.join("listed_loading").exists()).await;
        assert!(
            tokio::time::timeout(Duration::from_secs(3), receive)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        std::fs::write(f.cwd.join("listed_release"), b"release").unwrap();
        until(|| available(&f, &connection, "retained") == (true, false)).await;
    } else {
        let notice = Arc::new(DeliveryNotice(Notify::new()));
        assert!(
            std::pin::Pin::new(&mut receive)
                .poll(&mut Context::from_waker(&Waker::from(notice.clone())))
                .is_pending()
        );
        tokio::time::timeout(Duration::from_secs(10), notice.0.notified())
            .await
            .unwrap();
        drop(receive);
        assert_eq!(available(&f, &connection, "retained"), (true, false));
    }
    assert_eq!(gate.counts(), (1, 1, 2));
    assert!(!connection.sessions.lock().unwrap().contains_key("retained"));
    finish(&f, &connection).await;
    drop(waiting.acquire().await.unwrap());
    assert_eq!(gate.counts(), (0, 0, 0));
}
