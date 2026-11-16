//! Fork admission uses this pump's live state, never historical cards.
use super::*;

pub(super) fn idle(
    ctx: &DispatchContext<'_>,
    prompt: bool,
    mutation: bool,
    models: &super::super::model_guard::ModelGuard,
    permissions: &super::super::permission_guard::PermissionGuard,
) -> bool {
    !prompt
        && !mutation
        && !ctx.tools.busy()
        && !ctx.async_tasks.busy()
        && !ctx.compactions.busy()
        && models.is_established()
        && models.admissible()
        && permissions.admissible()
        && ctx.pending.lock().is_ok_and(|entries| {
            !entries
                .values()
                .any(|v| v.session_id == ctx.session_id && v.lease.belongs_to(&ctx.ops.life))
        })
        && ctx.ops.elicitations.lock().is_ok_and(|entries| {
            !entries
                .values()
                .any(|v| v.session_id == ctx.session_id && v.lease.belongs_to(&ctx.ops.life))
        })
}

/// A completed observer may reconnect to the same operation, never repeat its mutation.
pub(super) fn repeat(
    command: SessionControl,
    prior: Option<&Arc<super::super::session_fork::SourceFork>>,
) -> Option<SessionControl> {
    if let SessionControl::Fork {
        request,
        result,
        deadline,
    } = command
    {
        if let Some(prior) = prior.filter(|prior| prior.operation_matches(&request.operation_id)) {
            let value = if prior.request_matches(&request) {
                Ok(prior.clone())
            } else {
                Err(super::super::session_fork::AdmissionFailure::rejected(
                    "point_unavailable",
                ))
            };
            let _ = result.send(value);
            None
        } else {
            Some(SessionControl::Fork {
                request,
                result,
                deadline,
            })
        }
    } else {
        Some(command)
    }
}
