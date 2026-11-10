use super::*;
use agent_client_protocol::{Dispatch, Role, schema::v1::RequestId};
use std::sync::atomic::{AtomicBool, Ordering};

struct Witness {
    id: RequestId,
    method: &'static str,
    observed: Arc<AtomicBool>,
}
pub(crate) struct Availability {
    available: AtomicBool,
    configuration_available: AtomicBool,
    // Only actual outstanding SDK requests. No history, persisted identity or
    // application event ledger is added; each completed witness is removed.
    witnesses: Mutex<Vec<Witness>>,
}
impl Availability {
    pub(crate) fn new(agent: &crate::meta_store::AgentRow) -> Arc<Self> {
        Self::with_available(super::super::recipes::goose_acp(agent))
    }
    fn with_available(available: bool) -> Arc<Self> {
        Arc::new(Self {
            available: AtomicBool::new(available),
            configuration_available: AtomicBool::new(available),
            witnesses: Mutex::new(Vec::new()),
        })
    }
    pub(crate) fn capability(&self) -> Option<Capability> {
        let tools = self.supports(Query::Tools(None));
        let configuration = self.supports(Query::Configuration);
        (tools || configuration).then_some(Capability {
            source: "reviewedOfficialSupplement",
            scope: "currentConversation",
            startup: None,
            extensions: Vec::new(),
            configuration: configuration.then_some(true),
            tools_unavailable: (!tools).then_some(true),
        })
    }
    pub(super) fn supports(&self, query: Query<'_>) -> bool {
        self.flag(query).load(Ordering::SeqCst)
    }
    fn flag(&self, query: Query<'_>) -> &AtomicBool {
        match query {
            Query::Tools(_) => &self.available,
            Query::Configuration => &self.configuration_available,
        }
    }
    pub(crate) fn observe(&self, dispatch: &Dispatch<UntypedMessage, UntypedMessage>) {
        if let Dispatch::Response(_, router) = dispatch
            && router.role_id() == Agent.role_id()
            && let Ok(entries) = self.witnesses.lock()
            && let Some(witness) = entries
                .iter()
                .find(|w| w.method == router.method() && &w.id == router.id())
        {
            witness.observed.store(true, Ordering::SeqCst);
        }
    }
    pub(super) fn send(
        &self,
        cx: &ConnectionTo<Agent>,
        session_id: &str,
        query: Query<'_>,
    ) -> Result<(Wire, Arc<AtomicBool>), ToolsError> {
        let method = query.method();
        let params = match query {
            Query::Tools(extension) => {
                serde_json::json!({"sessionId": session_id, "extensionName": extension})
            }
            Query::Configuration => serde_json::json!({"sessionId": session_id}),
        };
        let message = UntypedMessage::new(method, params).map_err(|_| Code::QueryFailed)?;
        // Synchronous enqueue and witness registration share the incoming
        // hook's short lock, including a peer's immediate error response.
        let mut entries = self.witnesses.lock().map_err(|_| Code::Busy)?;
        let sent = cx.send_request_to(Agent, message);
        let observed = Arc::new(AtomicBool::new(false));
        entries.push(Witness {
            id: sent.id().clone(),
            method,
            observed: observed.clone(),
        });
        Ok((Box::pin(sent.block_task()), observed))
    }
    pub(super) fn clear(&self, observed: &Arc<AtomicBool>) {
        if let Ok(mut entries) = self.witnesses.lock() {
            entries.retain(|w| !Arc::ptr_eq(&w.observed, observed));
        }
    }
    pub(super) fn unsupported(&self, query: Query<'_>) {
        self.flag(query).store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
#[path = "availability_test_support.rs"]
mod test_support;
