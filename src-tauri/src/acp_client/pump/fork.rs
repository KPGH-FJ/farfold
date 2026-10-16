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
