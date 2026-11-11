//! Tiny delegation from the existing pump, with all busy inputs still owned
//! by that exact actor. This module is a pump child, not another actor.
use super::*;

pub(super) fn changing(sessions: &SessionMap, session_id: &str) -> bool {
    sessions
        .lock()
        .map(|entries| {
            entries
                .get(session_id)
                .is_some_and(|entry| entry.tools_report.changes.busy())
        })
        .unwrap_or(true)
}

pub(super) struct ChangeInput<'a, 'event> {
    pub cx: &'a ConnectionTo<Agent>,
    pub ctx: &'a mut DispatchContext<'event>,
    pub store: &'a super::super::model_guard::ConfigStore,
    pub guard: &'a mut super::super::model_guard::ModelGuard,
    pub permissions: &'a mut super::super::permission_guard::PermissionGuard,
    pub inbox: &'a mut super::super::session_routes::Inbox,
    pub configuration: &'a mut super::super::session_config::SessionConfig,
    pub models: &'a mut HashSet<String>,
    pub opening: &'a mut Option<restore_config::Opening>,
    pub mutation: &'a mut Option<Mutation>,
    pub other_busy: bool,
}

pub(super) async fn admit_change(
    mut request: super::super::session_tool_changes::Request,
    input: ChangeInput<'_, '_>,
    deadline: tokio::time::Instant,
    result: oneshot::Sender<Result<(), super::super::session_tool_changes::ChangeError>>,
) {
    use super::super::session_tool_changes::{Change, ChangeError, Code};
    let ChangeInput {
        cx,
        ctx,
        store,
        guard,
        permissions,
        inbox,
        configuration,
        models,
        opening,
        mutation,
        other_busy,
    } = input;
    let busy =
        other_busy || restore_config::busy(ctx) || !guard.admissible() || !permissions.admissible();
    let preparation: Result<_, ChangeError> = async {
        if request.operation.connection_id != ctx.ops.connection_id
            || request.operation.native_session_id != ctx.session_id
        {
            return Err(Code::Changed.into());
        }
        request.validate_target()?;
        if busy {
            return Err(Code::Busy.into());
        }
        if result.is_closed() || tokio::time::Instant::now() >= deadline {
            return Err(Code::Timeout.into());
        }
        if matches!(request.change, Change::Inspect) {
            return Ok(None);
        }
        if guard.is_established() {
            if request.row.is_none() {
                return Err(Code::Changed.into());
            }
            request.operation.conversation_saved = true;
            return Ok(None);
        }
        // Same pump and confirmed selection as first prompt admission, without
        // sending a prompt. The lease covers every await before actor handoff.
        request.validate_new_target()?;
        let lease = ctx
            .ops
            .life
            .operation(format!("open:{}", ctx.session_id))
            .map_err(|_| Code::Busy)?;
        let _configuration = crate::install_job::configuration_guard(&store.agent_id).await;
        request.validate_target()?;
        if store
            .expected_model
            .as_ref()
            .is_some_and(|expected| guard.single_model_value() != Some(expected))
        {
            return Err(Code::Changed.into());
        }
        store.validate_service().await.map_err(|_| Code::Changed)?;
        let snapshot = guard.record();
        let row = store
            .save_initial(ctx.session_id, snapshot.clone(), request.row.clone())
            .await
            .map_err(|error| match error {
                crate::meta_store::InitialConfigError::Changed => Code::Changed,
                crate::meta_store::InitialConfigError::SaveFailed => Code::SaveFailed,
            })?;
        request.operation.conversation_saved = true;
        // Lock the snapshot that was actually saved BEFORE draining later
        // notifications. Drift then blocks; it is never adopted as confirmed.
        guard.saved_session();
        request.row = Some(row);
        let source_valid = store.validate_service().await.is_ok();
        restore_config::drain(
            inbox,
            ctx,
            configuration,
            models,
            guard,
            permissions,
            opening,
            mutation,
        );
        (ctx.events)(serde_json::json!({"kind":"configCheck","check":guard.check()}));
        request.validate_target()?;
        if !source_valid
            || guard.record() != snapshot
            || !guard.admissible()
            || !permissions.admissible()
            || restore_config::busy(ctx)
        {
            return Err(Code::Changed.into());
        }
        Ok(Some(lease))
    }
    .await;
    let lease = match preparation {
        Ok(lease) => lease,
        Err(error) => {
            let _ = result.send(Err(
                error.with_saved_conversation(request.operation.conversation_saved)
            ));
            return;
        }
    };
    // No await or pump command can interleave with reacquiring this operation.
    // If another owner acquired it, start rejects before any official request.
    drop(lease);
    super::super::session_tool_changes::start(
        request,
        cx.clone(),
        &ctx.ops.connection_id,
        ctx.session_id,
        &ctx.ops.life,
        false,
        deadline,
        result,
    );
}

pub(super) fn admit(
    request: super::super::session_tools::Request,
    cx: &ConnectionTo<Agent>,
    ctx: &DispatchContext<'_>,
    other_busy: bool,
    deadline: tokio::time::Instant,
    result: oneshot::Sender<Result<(), super::super::session_tools::ToolsError>>,
) {
    let awaiting = ctx
        .pending
        .lock()
        .map(|entries| entries.values().any(|e| e.session_id == ctx.session_id))
        .unwrap_or(true)
        || ctx
            .ops
            .elicitations
            .lock()
            .map(|entries| entries.values().any(|e| e.session_id == ctx.session_id))
            .unwrap_or(true);
    let busy = other_busy
        || ctx.tools.busy()
        || ctx.async_tasks.busy()
        || ctx.compactions.busy()
        || awaiting;
    super::super::session_tools::start(
        request,
        cx.clone(),
        &ctx.ops.connection_id,
        ctx.session_id,
        &ctx.ops.life,
        busy,
        deadline,
        result,
    );
}
