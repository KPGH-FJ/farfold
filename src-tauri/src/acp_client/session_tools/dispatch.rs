//! Tiny delegation from the existing pump, with all busy inputs still owned
//! by that exact actor. This module is a pump child, not another actor.
use super::*;

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
