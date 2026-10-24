//! Transient ownership of live official compaction reports, never history storage.
use super::lifecycle::{ConnectionLife, WorkLease};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

const LIMIT: usize = 512;
fn block(value: &Value) -> bool {
    value.is_object()
        && value
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "text" || value.get("text").is_some_and(Value::is_string))
}
/// Match the shared compaction projection's patch semantics. Schema decoding
/// deliberately defaults some bad optional fields; that cannot endorse a
/// terminal raw report that the actual projection must reject.
fn valid_patch(update: &Value) -> bool {
    let Some(status) = update.get("status").and_then(Value::as_str) else {
        return false;
    };
    let summary = update.get("summary").is_none_or(|value| {
        value.is_null()
            || value.as_array().is_some_and(|items| {
                items.iter().all(block) && (items.is_empty() || status == "completed")
            })
    });
    let error = update
        .get("error")
        .is_none_or(|value| value.is_null() || (value.is_string() && status == "failed"));
    let meta = update
        .get("_meta")
        .is_none_or(|value| value.is_null() || value.is_object());
    summary && error && meta
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    History,
    Ended,
    Active { uncertain: bool },
}
pub(super) struct CompactionActivity {
    life: Arc<ConnectionLife>,
    connection: String,
    session: String,
    entries: BTreeMap<String, State>,
    unaddressed: bool,
    live: Arc<AtomicBool>,
    lease: Option<WorkLease>,
}
impl CompactionActivity {
    pub(super) fn new(life: Arc<ConnectionLife>, connection: String, session: String) -> Self {
        Self {
            life,
            connection,
            session,
            entries: BTreeMap::new(),
            unaddressed: false,
            live: Arc::new(AtomicBool::new(false)),
            lease: None,
        }
    }
    /// Only a locally admitted request establishes live observation. A received
    /// load prefix and delayed pre-request replay do not become current work.
    pub(super) fn begin_live(&mut self) {
        self.live.store(true, Ordering::SeqCst);
    }
    /// A lazy mutation may be rejected before its first poll. Start observing
    /// only when that exact request future is polled, never merely queued.
    /// Polling is not proof of successful transport delivery; only subsequent
    /// owned typed reports can hold work, including after a request error.
    pub(super) fn live_request<F>(
        &self,
        request: F,
    ) -> impl Future<Output = F::Output> + Send + 'static
    where
        F: Future + Send + 'static,
    {
        let live = self.live.clone();
        async move {
            live.store(true, Ordering::SeqCst);
            request.await
        }
    }
    pub(super) fn busy(&self) -> bool {
        self.unaddressed
            || self
                .entries
                .values()
                .any(|state| matches!(state, State::Active { .. }))
    }
    pub(super) fn event(&self) -> Value {
        json!({"kind":"compactionActivity", "connectionId":self.connection, "sessionId":self.session,
            "compactionIds":self.entries.iter().filter_map(|(id,state)| matches!(state,State::Active { .. }).then_some(id)).collect::<Vec<_>>(),
            "uncertain":self.unaddressed || self.entries.values().any(|state| matches!(state,State::Active { uncertain:true }))})
    }
    pub(super) fn observe(&mut self, params: &Value) -> Option<Value> {
        if params.get("sessionId").and_then(Value::as_str) != Some(self.session.as_str()) {
            return None;
        }
        let update = params.get("update")?;
        let kind = update.get("sessionUpdate")?.as_str()?;
        if !matches!(kind, "compaction_update" | "compaction_summary_chunk") {
            return None;
        }
        let id = update
            .get("compactionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 4096 && !id.contains('\0'));
        if !self.live.load(Ordering::SeqCst) {
            if let Some(id) = id
                && self.entries.len() < LIMIT
            {
                self.entries.insert(id.into(), State::History);
            }
            return None;
        }
        let before = self.event();
        if let Some(id) = id {
            match self.entries.get(id) {
                // IDs are unique within a session. Neither delayed replay nor
                // duplicate/future patches can revive a settled entity.
                Some(State::History | State::Ended) => return None,
                None if self.entries.len() >= LIMIT => {
                    // A terminal-only report owns no unfinished work. If a
                    // later untracked start arrives it will retain uncertainty.
                    if kind == "compaction_update"
                        && valid_patch(update)
                        && matches!(
                            update.get("status").and_then(Value::as_str),
                            Some("completed" | "failed" | "cancelled")
                        )
                    {
                        return None;
                    }
                    self.unaddressed = true;
                }
                _ => {
                    let state = if kind == "compaction_update" && valid_patch(update) {
                        match update.get("status").and_then(Value::as_str) {
                            Some("completed" | "failed" | "cancelled") => State::Ended,
                            Some("in_progress") => State::Active { uncertain: false },
                            _ => State::Active { uncertain: true },
                        }
                    } else if kind == "compaction_summary_chunk"
                        && update.get("content").is_some_and(block)
                    {
                        // Official chunks belong between start and terminal.
                        // An orphan chunk cannot establish completion.
                        self.entries
                            .get(id)
                            .copied()
                            .unwrap_or(State::Active { uncertain: true })
                    } else {
                        State::Active { uncertain: true }
                    };
                    self.entries.insert(id.into(), state);
                }
            }
        } else {
            // No safe identity can match a later terminal. Retain uncertainty
            // until the actual connection process ends; never clear another ID.
            self.unaddressed = true;
        }
        if self.busy() {
            if self.lease.is_none() {
                self.lease = self.life.work().ok();
            }
        } else {
            self.lease.take();
        }
        let after = self.event();
        (before != after).then_some(after)
    }
}
impl Drop for CompactionActivity {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            lease.retain_until_terminated();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    fn activity() -> CompactionActivity {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        CompactionActivity::new(life, "connection".into(), "session".into())
    }
    fn patch(id: Value, status: Value) -> Value {
        json!({"sessionId":"session","update":{"sessionUpdate":"compaction_update","compactionId":id,"status":status}})
    }
    #[test]
    fn only_official_terminal_status_releases_live_work() {
        for terminal in ["completed", "failed", "cancelled"] {
            let mut c = activity();
            c.begin_live();
            c.observe(&patch(json!("c"), json!("in_progress")));
            assert!(c.busy());
            assert_eq!(c.life.work.load(Ordering::SeqCst), 1);
            c.observe(&patch(json!("c"), json!("future")));
            assert_eq!(c.event()["uncertain"], true);
            c.observe(&patch(json!("c"), Value::Null));
            assert!(c.busy());
            c.observe(&patch(json!("c"), json!(terminal)));
            assert!(!c.busy());
            assert_eq!(c.life.work.load(Ordering::SeqCst), 0);
            c.observe(&patch(json!("c"), json!("in_progress")));
            assert!(!c.busy());
        }
    }
    #[test]
    fn historical_id_and_foreign_session_never_own_current_work() {
        let mut c = activity();
        c.observe(&patch(json!("old"), json!("in_progress")));
        c.begin_live();
        c.observe(&patch(json!("old"), json!("in_progress")));
        assert!(!c.busy());
        c.observe(&patch(json!("new"), json!("in_progress")));
        c.observe(&patch(json!("old"), json!("completed")));
        assert!(c.busy());
        let mut foreign = patch(json!("new"), json!("completed"));
        foreign["sessionId"] = json!("other");
        c.observe(&foreign);
        assert!(c.busy());
    }
    #[test]
    fn orphan_chunk_or_future_first_status_is_uncertain_work() {
        let mut c = activity();
        c.begin_live();
        c.observe(&json!({"sessionId":"session","update":{"sessionUpdate":"compaction_summary_chunk","compactionId":"chunk","content":{"type":"text","text":"summary"}}}));
        c.observe(&patch(json!("future"), json!("_future")));
        assert_eq!(c.event()["compactionIds"], json!(["chunk", "future"]));
        assert_eq!(c.event()["uncertain"], true);
        assert!(c.busy());
    }
    #[test]
    fn malformed_identity_cannot_be_cleared_by_another_terminal() {
        let mut c = activity();
        c.begin_live();
        c.observe(&patch(Value::Null, json!("completed")));
        c.observe(&patch(json!("other"), json!("completed")));
        assert!(c.busy());
        assert_eq!(c.event()["uncertain"], true);
    }
    #[test]
    fn malformed_terminal_fields_never_release_reported_live_work() {
        let malformed = [
            json!({"summary":17}),
            json!({"error":"oops"}),
            json!({"_meta":[]}),
        ];
        let mut held = Vec::new();
        for extra in malformed {
            let mut c = activity();
            c.begin_live();
            c.observe(&patch(json!("c"), json!("in_progress")));
            let mut end = patch(json!("c"), json!("completed"));
            end["update"]
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            c.observe(&end);
            held.push(c.busy() && c.life.work.load(Ordering::SeqCst) > 0);
        }
        assert_eq!(
            held,
            vec![true; 3],
            "invalid summary/error/meta cannot release work"
        );
    }
    #[test]
    fn bounded_identity_overflow_retains_unknown_work() {
        let mut c = activity();
        c.begin_live();
        for i in 0..=LIMIT {
            c.observe(&patch(json!(format!("{i}")), json!("completed")));
        }
        assert_eq!(c.entries.len(), LIMIT);
        assert!(!c.busy(), "settled overflow alone is not active work");
        c.observe(&patch(json!("untracked-active"), json!("in_progress")));
        assert!(c.busy());
        assert_eq!(c.event()["uncertain"], true);
    }

    #[tokio::test]
    async fn unpolled_cancelled_or_expired_mutation_does_not_start_live_observation() {
        use super::super::{
            mutation::{self, Kind, Mutation, Reply},
            operations::Operation,
            session_config::SessionConfig,
        };
        use std::time::Duration;
        use tokio::sync::oneshot;
        for caller_closed in [true, false] {
            let mut c = activity();
            let called = Arc::new(AtomicBool::new(false));
            let was_called = called.clone();
            let request = c.live_request(async move {
                was_called.store(true, Ordering::SeqCst);
                Ok(Value::Null)
            });
            let (reply, receive) = oneshot::channel();
            let _receive = if caller_closed {
                drop(receive);
                None
            } else {
                Some(receive)
            };
            let deadline = if caller_closed {
                tokio::time::Instant::now() + Duration::from_secs(5)
            } else {
                tokio::time::Instant::now() - Duration::from_secs(1)
            };
            let mut pending = Some(Mutation::new(
                Kind::Config {
                    request: SessionConfig::default()
                        .prepare("format", &json!("one"))
                        .unwrap(),
                    permission_value: None,
                    choice: None,
                    prior_guard: None,
                    config_store: None,
                },
                Reply::Config(reply),
                Operation::new(),
                c.life.operation("configuration".into()).unwrap(),
                deadline,
                request,
            ));
            assert!(mutation::next(&mut pending).await.unwrap().is_err());
            assert!(!pending.as_ref().unwrap().started());
            assert!(!called.load(Ordering::SeqCst));
            drop(pending);
            assert!(
                c.observe(&patch(json!("delayed-history"), json!("in_progress")))
                    .is_none()
            );
            assert!(!c.busy());
            // A polled request error is not proof of no external work. Keep
            // accepting owned typed activity without reviving known history.
            assert!(
                c.live_request(async { Err::<Value, String>("request failed".into()) })
                    .await
                    .is_err()
            );
            assert!(!c.busy(), "the marker alone must not hold work");
            c.observe(&patch(json!("delayed-history"), json!("in_progress")));
            assert!(!c.busy(), "known history must remain history");
            c.observe(&patch(json!("current"), json!("in_progress")));
            assert!(c.busy());
            assert_eq!(c.life.work.load(Ordering::SeqCst), 1);
        }
    }
}
