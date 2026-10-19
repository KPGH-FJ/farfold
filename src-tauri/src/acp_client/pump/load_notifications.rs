//! Consume the response-independent load prefix on its original route. This
//! state is moved into the normal pump; it is not another session controller.
use super::*;

pub(super) struct State {
    pub(super) permission_ids: Vec<String>,
    pub(super) elicitation_ids: Vec<String>,
    pub(super) tools: super::super::tool_activity::ToolActivity,
    pub(super) compactions: super::super::compaction_activity::CompactionActivity,
    pub(super) async_tasks: super::super::async_tasks::Tasks,
    pub(super) failures: super::super::failures::FailureTracker,
    pub(super) expiry_tx: mpsc::UnboundedSender<String>,
    pub(super) expiry_rx: mpsc::UnboundedReceiver<String>,
    pub(super) held_dispatch: Option<Dispatch>,
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
            held_dispatch: None,
        }
    }

    pub(super) async fn while_loading<T>(
        &mut self,
        session_id: &str,
        inbox: &mut mpsc::UnboundedReceiver<Dispatch>,
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
                dispatch = inbox.recv() => {
                    let Some(dispatch) = dispatch else { return load.await; };
                    if !matches!(&dispatch, Dispatch::Notification(_))
                        || super::super::session_config::SessionConfig::waits_for_load_response(&dispatch)
                    {
                        // Keep the first dependent message intact and stop
                        // early consumption. Its entire following FIFO remains
                        // in the original inbox until response-based setup.
                        self.held_dispatch = Some(dispatch);
                        return load.await;
                    }
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
                    // This is exactly the existing passive-observation/raw
                    // dispatcher. Never run the early branch for a Request.
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
