use super::*;
use agent_client_protocol::{Dispatch, Role, schema::v1::RequestId};
use std::sync::atomic::{AtomicBool, Ordering};

struct Witness {
    id: RequestId,
    observed: Arc<AtomicBool>,
}
pub(crate) struct Availability {
    available: AtomicBool,
    // Only actual outstanding SDK requests. No history, persisted identity or
    // application event ledger is added; each completed witness is removed.
    witnesses: Mutex<Vec<Witness>>,
}
impl Availability {
    pub(crate) fn new(agent: &crate::meta_store::AgentRow) -> Arc<Self> {
        let command = Path::new(&agent.command);
        let reviewed = agent.source == "registry"
            && agent.id == "registry:goose"
            && agent.args == ["acp"]
            && command.is_absolute()
            && command
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| {
                    s == "goose" || (cfg!(windows) && s.eq_ignore_ascii_case("goose.exe"))
                });
        Self::with_available(reviewed)
    }
    fn with_available(available: bool) -> Arc<Self> {
        Arc::new(Self {
            available: AtomicBool::new(available),
            witnesses: Mutex::new(Vec::new()),
        })
    }
    pub(crate) fn capability(&self) -> Option<Capability> {
        self.available.load(Ordering::SeqCst).then_some(Capability {
            source: "reviewedOfficialSupplement",
            scope: "currentConversation",
        })
    }
    pub(crate) fn observe(&self, dispatch: &Dispatch<UntypedMessage, UntypedMessage>) {
        if let Dispatch::Response(_, router) = dispatch
            && router.method() == METHOD
            && router.role_id() == Agent.role_id()
            && let Ok(entries) = self.witnesses.lock()
            && let Some(witness) = entries.iter().find(|w| &w.id == router.id())
        {
            witness.observed.store(true, Ordering::SeqCst);
        }
    }
    pub(super) fn send(
        &self,
        cx: &ConnectionTo<Agent>,
        session_id: &str,
    ) -> Result<(Wire, Arc<AtomicBool>), ToolsError> {
        let message = UntypedMessage::new(
            METHOD,
            serde_json::json!({"sessionId":session_id,"extensionName":null}),
        )
        .map_err(|_| Code::QueryFailed)?;
        // Synchronous enqueue and witness registration share the incoming
        // hook's short lock, including a peer's immediate error response.
        let mut entries = self.witnesses.lock().map_err(|_| Code::Busy)?;
        let sent = cx.send_request_to(Agent, message);
        let observed = Arc::new(AtomicBool::new(false));
        entries.push(Witness {
            id: sent.id().clone(),
            observed: observed.clone(),
        });
        Ok((Box::pin(sent.block_task()), observed))
    }
    pub(super) fn clear(&self, observed: &Arc<AtomicBool>) {
        if let Ok(mut entries) = self.witnesses.lock() {
            entries.retain(|w| !Arc::ptr_eq(&w.observed, observed));
        }
    }
    pub(super) fn unsupported(&self) {
        self.available.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
#[path = "availability_test_support.rs"]
mod test_support;
