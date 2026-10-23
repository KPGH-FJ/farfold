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
        ops: &SessionOps,
        load: impl std::future::Future<Output = T>,
    ) -> T {
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
                    self.deferred.observe(&dispatch);
                    observe_failure(&dispatch, &mut self.failures, false);
                    let mut context = DispatchContext {
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
                    };
                    // Original raw messages and owned inquiries progress during
                    // load; only response-dependent configuration effects wait.
                    handle_session_dispatch(dispatch, &mut context);
                }
            }
        }
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
