use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
fn gate(active: usize, pending: usize, bytes: usize) -> Arc<Admission> {
    Admission::new(Policy {
        active,
        pending,
        bytes,
    })
    .unwrap()
}
fn owner(g: &Admission, agent: &str, token: &str) -> Owner {
    g.fixture_owner("window", token, agent)
}

#[tokio::test]
async fn count_bytes_and_last_owner_are_independent() {
    let g = gate(1, 1, 30);
    let a = g
        .enqueue(owner(&g, "a", "1"), 10)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let b = g.enqueue(owner(&g, "b", "2"), 20).unwrap();
    assert!(matches!(
        g.enqueue(owner(&g, "c", "3"), 1),
        Err(Failure::Full)
    ));
    let clone = a.clone();
    drop(a);
    assert_eq!(g.counts(), (1, 1, 30));
    drop(clone);
    let b = b.acquire().await.unwrap();
    assert_eq!(g.counts(), (1, 0, 20));
    drop(b);
    assert_eq!(g.counts(), (0, 0, 0));
    assert!(matches!(
        g.enqueue(owner(&g, "a", "4"), 31),
        Err(Failure::Payload)
    ));
}
#[tokio::test]
async fn same_agent_fifo_and_cross_agent_round_robin() {
    let g = gate(1, 4, 100);
    let a = g
        .enqueue(owner(&g, "a", "1"), 1)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let a2 = g.enqueue(owner(&g, "a", "2"), 1).unwrap();
    let a3 = g.enqueue(owner(&g, "a", "3"), 1).unwrap();
    let b = g.enqueue(owner(&g, "b", "4"), 1).unwrap();
    drop(a);
    let b = b.acquire().await.unwrap();
    assert_eq!(g.counts(), (1, 2, 3));
    drop(b);
    let a2 = a2.acquire().await.unwrap();
    assert_eq!(g.counts(), (1, 1, 2));
    drop(a2);
    drop(a3.acquire().await.unwrap());
    assert_eq!(g.counts(), (0, 0, 0));
}
#[tokio::test]
async fn cancellation_and_grant_have_one_order_and_exact_owner() {
    let g = gate(1, 3, 100);
    let a = g
        .enqueue(owner(&g, "a", "1"), 1)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let b = g.enqueue(owner(&g, "b", "2"), 1).unwrap();
    let id = b.id();
    assert_eq!(g.cancel(id, &owner(&g, "wrong", "2")), Ok(Cancel::NotFound));
    assert_eq!(
        g.cancel(id, &owner(&g, "b", "2")),
        Ok(Cancel::CancelledWaiting)
    );
    assert!(matches!(b.acquire().await, Err(Failure::Cancelled)));
    let c = g.enqueue(owner(&g, "c", "3"), 1).unwrap();
    let id = c.id();
    drop(a);
    assert_eq!(
        g.cancel(id, &owner(&g, "c", "3")),
        Ok(Cancel::AlreadyStarting)
    );
    drop(c);
    assert_eq!(g.counts(), (0, 0, 0)); // Unconsumed grant must release.
}
#[tokio::test]
async fn shutdown_cancels_only_queued_and_keeps_started_until_last_clone() {
    let g = gate(1, 1, 100);
    let a = g
        .enqueue(owner(&g, "a", "1"), 1)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let b = g.enqueue(owner(&g, "b", "2"), 1).unwrap();
    let later = owner(&g, "a", "3");
    g.shutdown().unwrap();
    assert!(matches!(b.acquire().await, Err(Failure::Closed)));
    assert!(matches!(g.enqueue(later, 1), Err(Failure::Closed)));
    assert_eq!(g.counts(), (1, 0, 1));
    drop(a);
    assert_eq!(g.counts(), (0, 0, 0));
}
#[test]
fn charge_walks_unknown_nested_values_and_rejects_before_large_stack() {
    let value = serde_json::json!({"future":[null,true,{"exact":"🙂"}],"number":123456});
    let copy = value.clone();
    let mut charge = Charge::new(4096);
    charge.json(&value).unwrap();
    let bytes = charge.finish();
    assert!(bytes > serde_json::to_vec(&value).unwrap().len());
    let mut short = Charge::new(bytes - 1);
    assert_eq!(short.json(&value), Err(Failure::Payload));
    assert_eq!(value, copy);
    let mut overflow = Charge::new(usize::MAX);
    overflow.add(usize::MAX).unwrap();
    assert_eq!(overflow.add(1), Err(Failure::Payload));
}
#[tokio::test]
async fn startup_and_orphan_keep_capacity_until_actual_finish() {
    use crate::acp_client::lifecycle::{ConnectionLife, OpenIdentity};
    let g = gate(1, 2, 100);
    let life = ConnectionLife::new();
    let a = g
        .enqueue(owner(&g, "a", "1"), 1)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    life.retain_history_startup(Some(a)).unwrap();
    let b = g.enqueue(owner(&g, "b", "2"), 1).unwrap();
    life.close(true, None).unwrap();
    life.release_history_startup();
    assert_eq!(g.counts(), (1, 1, 2));
    life.finish(Ok(()));
    let b = b.acquire().await.unwrap();
    let life = ConnectionLife::new();
    life.ready().unwrap();
    drop(OpenIdentity::new(life.clone(), None).with_history(Some(b)));
    let c = g.enqueue(owner(&g, "c", "3"), 1).unwrap();
    assert_eq!(g.counts(), (1, 1, 2));
    life.finish(Ok(()));
    drop(c.acquire().await.unwrap());
    assert_eq!(g.counts(), (0, 0, 0));
}
struct WakeCheck {
    g: Arc<Admission>,
    life: Arc<crate::acp_client::lifecycle::ConnectionLife>,
    unlocked: AtomicBool,
}
impl std::task::Wake for WakeCheck {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        let free = self.g.state.try_lock().is_ok() && self.life.history_activity_unlocked();
        self.unlocked.store(free, Ordering::SeqCst);
    }
}
#[tokio::test]
async fn release_wakes_only_outside_activity_and_admission_locks() {
    use crate::acp_client::lifecycle::ConnectionLife;
    use std::{
        future::Future,
        pin::Pin,
        task::{Context, Waker},
    };
    let g = gate(1, 1, 100);
    let life = ConnectionLife::new();
    let a = g
        .enqueue(owner(&g, "a", "1"), 1)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    life.retain_history_startup(Some(a)).unwrap();
    life.ready().unwrap();
    let mut b = Box::pin(g.enqueue(owner(&g, "b", "2"), 1).unwrap().acquire());
    let check = Arc::new(WakeCheck {
        g: g.clone(),
        life: life.clone(),
        unlocked: AtomicBool::new(false),
    });
    assert!(
        Pin::new(&mut b)
            .poll(&mut Context::from_waker(&Waker::from(check.clone())))
            .is_pending()
    );
    life.release_history_startup();
    assert!(check.unlocked.load(Ordering::SeqCst));
    drop(b.await.unwrap());
}

#[tokio::test]
async fn accepted_identity_keeps_delivery_until_outer_marker_owner_ends() {
    use crate::acp_client::lifecycle::{ConnectionLife, OpenIdentity};
    let g = gate(1, 1, 100);
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let a = g
        .enqueue(owner(&g, "a", "1"), 1)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let mut identity = OpenIdentity::new(life.clone(), None).with_history(Some(a));
    identity.delivered();
    let b = g.enqueue(owner(&g, "b", "2"), 1).unwrap();
    assert_eq!(g.counts(), (1, 1, 2));
    drop(identity);
    drop(b.acquire().await.unwrap());
    assert_eq!(g.counts(), (0, 0, 0));
}
#[tokio::test]
async fn closing_operation_transfers_its_only_permit_until_finish() {
    use crate::acp_client::lifecycle::ConnectionLife;
    let g = gate(1, 1, 100);
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let a = g
        .enqueue(owner(&g, "a", "1"), 1)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let operation = life
        .operation_with_history("open:a".into(), Some(a))
        .unwrap();
    life.close(true, None).unwrap();
    drop(operation);
    let b = g.enqueue(owner(&g, "b", "2"), 1).unwrap();
    assert_eq!(g.counts(), (1, 1, 2));
    life.finish(Ok(()));
    drop(b.acquire().await.unwrap());
    assert_eq!(g.counts(), (0, 0, 0));
}

// The synthetic window is confined to tests. Production authority is created
// only from a registered, Tauri-injected actual Window.
impl Admission {
    pub(in crate::acp_client) fn fixture_owner(
        &self,
        window: &str,
        token: &str,
        agent: &str,
    ) -> Owner {
        self.register_window_label(window).unwrap();
        self.owner_label(window, token, agent).unwrap()
    }
}
impl crate::acp_client::manager::AcpManager {
    pub(in crate::acp_client) async fn admit_cold_history_for_test(
        &self,
        agent: &crate::meta_store::AgentRow,
        cwd: &std::path::Path,
        native: &str,
        config: &[(String, serde_json::Value)],
        store: &crate::meta_store::MetaStore,
        selection: Option<&crate::credentials::ServiceSelection>,
    ) -> Result<Permit, String> {
        let owner = self.history_admission.fixture_owner(
            "controlled",
            &crate::acp_client::manager::next_connection_id(),
            &agent.id,
        );
        self.admit_cold_history(
            agent,
            cwd,
            native,
            config,
            store,
            selection,
            crate::acp_client::history_admission_commands::HistoryRequest {
                owner,
                progress: Arc::new(|_| Ok(())),
                preparation_bytes: 0,
            },
        )
        .await
    }
}

#[tokio::test]
async fn closed_window_cancels_only_waiters_and_stale_authority_cannot_reenter() {
    let g = gate(1, 3, 100);
    let old = owner(&g, "a", "old");
    let active = g.enqueue(old.clone(), 1).unwrap().acquire().await.unwrap();
    let queued = g.enqueue(owner(&g, "a", "queued"), 1).unwrap();
    let other_owner = g.fixture_owner("other", "survivor", "b");
    let survivor = g.enqueue(other_owner, 1).unwrap();
    g.close_window("window").unwrap();
    assert!(matches!(queued.acquire().await, Err(Failure::Cancelled)));
    assert_eq!(g.counts(), (1, 1, 2));
    assert!(matches!(g.enqueue(old.clone(), 1), Err(Failure::Closed)));
    assert_eq!(g.cancel_label_token("other", "old"), Ok(Cancel::NotFound));
    // A genuinely recreated window gets a new transient authority. The stale
    // request and its guessed same-label token cannot attach to that window.
    let fresh = g.fixture_owner("window", "fresh", "a");
    assert!(matches!(g.enqueue(old, 1), Err(Failure::Closed)));
    assert_eq!(g.cancel_label_token("window", "old"), Ok(Cancel::NotFound));
    let fresh = g.enqueue(fresh, 1).unwrap();
    drop(active);
    drop(survivor.acquire().await.unwrap());
    drop(fresh.acquire().await.unwrap());
    assert_eq!(g.counts(), (0, 0, 0));
}
#[tokio::test]
async fn token_cancellation_cannot_cross_real_window_scope_or_claim_started_cancelled() {
    let g = gate(1, 1, 100);
    let active = g
        .enqueue(owner(&g, "a", "active"), 1)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let queued = g.enqueue(owner(&g, "a", "queued"), 1).unwrap();
    let _other = g.fixture_owner("other", "registered", "b");
    assert_eq!(
        g.cancel_label_token("other", "queued"),
        Ok(Cancel::NotFound)
    );
    assert_eq!(
        g.cancel_label_token("window", "active"),
        Ok(Cancel::AlreadyStarting)
    );
    assert_eq!(
        g.cancel_label_token("window", "queued"),
        Ok(Cancel::CancelledWaiting)
    );
    assert!(matches!(queued.acquire().await, Err(Failure::Cancelled)));
    drop(active);
    assert_eq!(g.counts(), (0, 0, 0));
}
impl Admission {
    pub(in crate::acp_client) fn fixture_cancel(
        self: &Arc<Self>,
        window: &str,
        token: &str,
    ) -> Result<Cancel, Failure> {
        self.cancel_label_token(window, token)
    }
}
