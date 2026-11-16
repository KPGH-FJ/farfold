//! Consume the response-independent load prefix on its original route. This
//! state is moved into the normal pump; it is not another session controller.
use super::*;

/// Until the actual pump takes ownership, every return and cancelled opening
/// must retire its original inquiry responders, including failures after load.
pub(super) struct Opening {
    state: Option<State>,
    permissions: PendingPermissions,
    elicitations: PendingElicitations,
}
impl Opening {
    pub(super) fn new(id: Option<&str>, ops: &SessionOps, pending: &PendingPermissions) -> Self {
        Self {
            state: id.map(|id| State::new(id, ops)),
            permissions: pending.clone(),
            elicitations: ops.elicitations.clone(),
        }
    }
    pub(super) fn as_mut(&mut self) -> Option<&mut State> {
        self.state.as_mut()
    }
    pub(super) fn take(&mut self) -> Option<State> {
        self.state.take()
    }
}
impl Drop for Opening {
    fn drop(&mut self) {
        if let Some(state) = &mut self.state {
            cancel_permissions(&self.permissions, &mut state.permission_ids);
            cancel_elicitations(&self.elicitations, &mut state.elicitation_ids);
        }
    }
}

pub(super) struct State {
    pub(super) permission_ids: Vec<String>,
    pub(super) elicitation_ids: Vec<String>,
    pub(super) tools: super::super::tool_activity::ToolActivity,
    pub(super) compactions: super::super::compaction_activity::CompactionActivity,
    pub(super) async_tasks: super::super::async_tasks::Tasks,
    pub(super) failures: super::super::failures::FailureTracker,
    pub(super) expiry_tx: mpsc::UnboundedSender<String>,
    pub(super) expiry_rx: mpsc::UnboundedReceiver<String>,
    pub(super) deferred: super::super::session_config::Deferred,
}

impl State {
    pub(super) fn new(session_id: &str, ops: &SessionOps) -> Self {
        let (expiry_tx, expiry_rx) = mpsc::unbounded_channel();
        Self {
            permission_ids: Vec::new(),
            elicitation_ids: Vec::new(),
            tools: super::super::tool_activity::ToolActivity::new(ops.life.clone()),
            compactions: super::super::compaction_activity::CompactionActivity::new(
                ops.life.clone(),
                ops.connection_id.clone(),
                session_id.to_owned(),
            ),
            async_tasks: super::super::async_tasks::Tasks::new(
                ops.async_tasks_supported.load(Ordering::SeqCst),
                ops.connection_id.clone(),
                session_id.to_owned(),
                ops.life.clone(),
            ),
            failures: super::super::failures::FailureTracker::default(),
            expiry_tx,
            expiry_rx,
            deferred: Default::default(),
        }
    }

    pub(super) async fn while_loading<T>(
        &mut self,
        session_id: &str,
        inbox: &mut super::super::session_routes::Inbox,
        events: &SessionSink,
        pending: &PendingPermissions,
        source: (&SessionOps, &super::super::live_status::Owner),
        load: impl std::future::Future<Output = T>,
    ) -> T {
        let (ops, presentation) = source;
        tokio::pin!(load);
        loop {
            tokio::select! {
                // A continuously ready replay may not starve the real reply.
                biased;
                result = &mut load => return result,
                expired = self.expiry_rx.recv() => {
                    if let Some(request_id) = expired {
                        cancel_permissions(pending, &mut vec![request_id.clone()]);
                        cancel_elicitations(&ops.elicitations, &mut vec![request_id.clone()]);
                        events(serde_json::json!({"kind":"interactionExpired", "requestId":request_id}));
                    }
                }
                dispatch = inbox.recv() => {
                    let Some(dispatch) = dispatch else { return load.await; };
                    self.dispatch(dispatch, session_id, events, pending, (ops, presentation));
                }
            }
        }
    }

    pub(super) fn drain(
        &mut self,
        session_id: &str,
        inbox: &mut super::super::session_routes::Inbox,
        events: &SessionSink,
        pending: &PendingPermissions,
        source: (&SessionOps, &super::super::live_status::Owner),
    ) {
        for _ in 0..inbox.queued_len() {
            let Ok(dispatch) = inbox.try_recv() else {
                break;
            };
            self.dispatch(dispatch, session_id, events, pending, source);
        }
    }

    fn dispatch(
        &mut self,
        dispatch: Dispatch,
        session_id: &str,
        events: &SessionSink,
        pending: &PendingPermissions,
        (ops, presentation): (&SessionOps, &super::super::live_status::Owner),
    ) {
        self.deferred.observe(&dispatch, ops.configuration_dialect);
        observe_failure(&dispatch, &mut self.failures, false);
        let mut context = DispatchContext {
            live_status: presentation,
            session_id,
            events,
            pending,
            ops,
            permission_ids: &mut self.permission_ids,
            elicitation_ids: &mut self.elicitation_ids,
            expirations: &self.expiry_tx,
            tools: &mut self.tools,
            compactions: &mut self.compactions,
            async_tasks: &mut self.async_tasks,
            prompt_cancelling: false,
            terminals: None,
        };
        // Preserve the original dispatcher and inquiry owners across load,
        // its queued prefix and the optional read-only empty-history inquiry.
        handle_session_dispatch(dispatch, &mut context);
    }
}

pub(super) fn observe_failure(
    dispatch: &Dispatch,
    failures: &mut super::super::failures::FailureTracker,
    prompt_in_flight: bool,
) {
    if let Dispatch::Notification(message) = dispatch
        && message.method() == "session/update"
        && message
            .params()
            .pointer("/update/sessionUpdate")
            .and_then(Value::as_str)
            == Some("session_info_update")
        && let Some(meta) = message.params().pointer("/update/_meta")
    {
        failures.observe(meta, prompt_in_flight);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn frame(sequence: usize) -> Dispatch {
        Dispatch::Notification(UntypedMessage::new("session/update", serde_json::json!({
            "sessionId":"finite-prefix", "update":{"sessionUpdate":"future_owned_update","sequence":sequence}
        })).unwrap())
    }

    #[test]
    fn load_prefix_drain_returns_under_replenishment_and_keeps_following_fifo() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let forms: PendingElicitations = Default::default();
        let ops = SessionOps {
            configuration_dialect: Default::default(),
            live_status_enabled: false,
            tool_media_enabled: false,
            history_supplement_source: None,
            session_tools: crate::acp_client::session_tools::Availability::unavailable(),
            workspace_access: crate::acp_client::workspace_access::Availability::new(None),
            async_tasks_supported: Arc::new(AtomicBool::new(false)),
            opening: None,
            connection_id: "finite-prefix-connection".into(),
            verify_identity: Arc::new(|_, _| Ok(None)),
            elicitations: forms.clone(),
            inquiries: crate::acp_client::elicitation::ConnectionElicitations::new(
                forms,
                life.clone(),
                "finite-prefix-connection".into(),
            ),
            life: life.clone(),
            prompt_escrow: Default::default(),
        };
        let pending = Default::default();
        let (sender, mut inbox) = life.routes.channel();
        for sequence in 0..3 {
            sender.send(frame(sequence)).unwrap();
        }
        let following = sender.clone();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = seen.clone();
        let next = AtomicUsize::new(3);
        let events: SessionSink = Arc::new(move |value| {
            let Some(sequence) = value.pointer("/update/sequence").and_then(Value::as_u64) else {
                return;
            };
            recorded.lock().unwrap().push(sequence);
            let sequence = next.fetch_add(1, Ordering::SeqCst);
            // The old unbounded drain consumes all 32. This fence makes the
            // actual regression finite without sleep, threads or a real Agent.
            if sequence < 32 {
                following.send(frame(sequence)).unwrap();
            }
        });
        let operation = Operation::new();
        let owner = super::super::super::live_status::Owner::loading(
            &ops,
            "finite-prefix",
            crate::acp_client::open_purpose::OpenPurpose::Conversation,
            None,
            &operation,
        );
        let mut prefix = State::new("finite-prefix", &ops);
        prefix.drain(
            "finite-prefix",
            &mut inbox,
            &events,
            &pending,
            (&ops, &owner),
        );
        assert_eq!(*seen.lock().unwrap(), vec![0, 1, 2]);
        prefix.drain(
            "finite-prefix",
            &mut inbox,
            &events,
            &pending,
            (&ops, &owner),
        );
        assert_eq!(*seen.lock().unwrap(), vec![0, 1, 2, 3, 4, 5]);
        let mut remaining = Vec::new();
        while let Ok(Dispatch::Notification(message)) = inbox.try_recv() {
            remaining.push(message.params()["update"]["sequence"].as_u64().unwrap());
        }
        assert_eq!(remaining, vec![6, 7, 8]);
    }
}
