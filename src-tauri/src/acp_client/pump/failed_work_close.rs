//! Review and end the exact local connection for a previously failed prompt.
use super::*;

const UNAVAILABLE: &str = "现在无法关闭这条连接，请检查待处理事项";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedWorkCloseReceipt {
    pub connection_id: String,
    pub session_id: String,
    pub proof_id: String,
}

fn candidate(
    ctx: &DispatchContext<'_>,
    active: Option<&prompt::Active>,
    failed_prompt: Option<u64>,
) -> Option<FailedWorkCloseReceipt> {
    let active = active?;
    let receipt = active.observation.receipt_id();
    if failed_prompt != Some(receipt)
        || !active.unresolved()
        || restore_config::deletion_busy(ctx)
        || ctx.terminals.is_some_and(tool_terminal::Session::blocked)
        || !ctx.ops.life.can_close_failed_work()
    {
        return None;
    }
    Some(FailedWorkCloseReceipt {
        connection_id: ctx.ops.connection_id.clone(),
        session_id: ctx.session_id.to_owned(),
        proof_id: receipt.to_string(),
    })
}

pub(super) fn handle(
    command: SessionControl,
    ctx: &DispatchContext<'_>,
    active: Option<&prompt::Active>,
    failed_prompt: Option<u64>,
    ready: bool,
) -> bool {
    if command.abandoned() {
        return false;
    }
    let proof = ready
        .then(|| candidate(ctx, active, failed_prompt))
        .flatten();
    match command {
        SessionControl::CheckFailedWorkClose { result, .. } => {
            let _ = result.send(Ok(proof));
            false
        }
        SessionControl::CloseFailedWork {
            proof_id, result, ..
        } => {
            let outcome = proof
                .filter(|proof| proof.proof_id == proof_id)
                .ok_or_else(|| UNAVAILABLE.to_owned())
                .and_then(|proof| ctx.ops.life.close_failed_work().map(|()| proof));
            let closing = outcome.is_ok();
            // This is admission only. The manager waits for the process owner
            // before returning the same receipt to the explicitly acting user.
            let _ = result.send(outcome);
            closing
        }
        _ => unreachable!(),
    }
}
