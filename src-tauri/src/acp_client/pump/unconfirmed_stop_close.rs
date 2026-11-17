//! Official close for the exact prompt that is still unanswered after Stop.
use super::super::process::SessionCloseConfirmation;
use super::*;

pub(super) const UNAVAILABLE: &str = "无法确认这条对话可以关闭，请等待原请求的结果";
const UNCONFIRMED: &str = "关闭结果尚未确认，请等待";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnconfirmedStopCloseReceipt {
    pub connection_id: String,
    pub session_id: String,
    pub proof_id: String,
}

pub(super) fn candidate(
    ctx: &DispatchContext<'_>,
    active: Option<&prompt::Active>,
) -> Option<UnconfirmedStopCloseReceipt> {
    let active = active?;
    if !active.observation.awaits_wire_response(ctx.session_id)
        || restore_config::deletion_busy(ctx)
        || ctx
            .terminals
            .is_some_and(|terminal| !terminal.can_close_after_stop())
    {
        return None;
    }
    Some(UnconfirmedStopCloseReceipt {
        connection_id: ctx.ops.connection_id.clone(),
        session_id: ctx.session_id.to_owned(),
        proof_id: active.observation.receipt_id().to_string(),
    })
}

pub(super) fn handle(
    command: SessionControl,
    cx: &ConnectionTo<Agent>,
    ctx: &DispatchContext<'_>,
    active: Option<&prompt::Active>,
) -> Option<Mutation> {
    let proof = candidate(ctx, active);
    match command {
        SessionControl::CheckUnconfirmedStopClose { result, .. } => {
            let _ = result.send(Ok(proof));
            None
        }
        SessionControl::CloseUnconfirmedStop {
            proof_id,
            result,
            deadline,
        } => {
            let Some(proof) = proof.filter(|proof| proof.proof_id == proof_id) else {
                let _ = result.send(Err(UNAVAILABLE.into()));
                return None;
            };
            let active = active.expect("only an active prompt can produce a close proof");
            let lease = match ctx.ops.life.operation(format!("open:{}", ctx.session_id)) {
                Ok(lease) => lease,
                Err(error) => {
                    let _ = result.send(Err(error));
                    return None;
                }
            };
            Some(Mutation::new(
                MutationKind::UnconfirmedStopClose(proof, active.observation.clone()),
                MutationReply::UnconfirmedStopClose(result),
                Operation::new(),
                lease,
                deadline,
                stopped_tool_close::send_close(cx.clone(), ctx.session_id.to_owned()),
            ))
        }
        _ => unreachable!(),
    }
}

pub(super) enum Completion {
    Closed,
    KeptOpen,
    WaitForOriginal(Box<Mutation>),
}

pub(super) fn complete(
    sessions: &SessionMap,
    mut completed: Mutation,
    outcome: Result<Value, String>,
    original_projected: bool,
) -> Completion {
    let MutationKind::UnconfirmedStopClose(expected, observation) = &completed.kind else {
        unreachable!();
    };
    if completed.started()
        && stopped_tool_close::empty_result(&outcome)
        && let Ok(mut entries) = sessions.lock()
        && entries.get(&expected.session_id).is_some_and(|entry| {
            entry.connection_is(&expected.connection_id)
                && entry.preview_token.is_none()
                && entry.purpose == super::super::open_purpose::OpenPurpose::Conversation
        })
    {
        let receipt = expected.clone();
        let session_id = receipt.session_id.clone();
        let observation = observation.clone();
        // The waiter rechecks this same map lock. Complete the exact prompt's
        // capacity and route release before publishing any new open eligibility.
        match observation.confirm_session_close(&session_id, original_projected, || {
            completed.deliver_unconfirmed_stop_close(receipt)
        }) {
            SessionCloseConfirmation::Confirmed => {
                entries.remove(&session_id);
                return Completion::Closed;
            }
            SessionCloseConfirmation::WaitForOriginal => {
                return Completion::WaitForOriginal(Box::new(
                    completed.defer_close_until_original(outcome),
                ));
            }
            SessionCloseConfirmation::Rejected => {}
        }
    }
    completed.finish(Err(outcome.err().unwrap_or_else(|| UNCONFIRMED.into())));
    Completion::KeptOpen
}
