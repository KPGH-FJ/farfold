//! User-authorized close of one cancelled, never-approved tool's route.
use super::*;
use agent_client_protocol::schema::v1::{RequestPermissionOutcome, RequestPermissionResponse};

pub(crate) const INELIGIBLE: &str = "无法确认该步骤在获准前已停止，请等待明确结果";
const UNCONFIRMED: &str = "关闭结果尚未确认，请等待";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedToolCloseReceipt {
    pub connection_id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub proof_id: String,
}

pub(super) fn observe_cancellation(
    responder: &Responder<Value>,
    id: &str,
    expirations: &mpsc::UnboundedSender<String>,
) -> (RequestCancellation, oneshot::Sender<()>) {
    let marker = responder.cancellation();
    let cancellation = marker.clone();
    let (completed, done) = oneshot::channel();
    let (id, expirations) = (id.to_owned(), expirations.clone());
    super::super::manager::runtime().spawn(async move {
        tokio::select! {
            _ = done => {}
            _ = cancellation.cancelled() => { let _ = expirations.send(id); }
        }
    });
    (marker, completed)
}

pub(super) fn cancel_permissions(pending: &PendingPermissions, ids: &mut Vec<String>) {
    cancel_permissions_recording(pending, ids, None);
}

pub(super) fn cancel_permissions_recording(
    pending: &PendingPermissions,
    ids: &mut Vec<String>,
    expected: Option<(&str, &Arc<ConnectionLife>)>,
) -> bool {
    let Ok(outcome) = serde_json::to_value(RequestPermissionResponse::new(
        RequestPermissionOutcome::Cancelled,
    )) else {
        return false;
    };
    let Ok(mut entries) = pending.lock() else {
        return false;
    };
    let unique = expected.and_then(|(id, life)| {
        let candidate = entries.get(id)?;
        (candidate.lease.belongs_to(life)
            && entries
                .values()
                .filter(|entry| {
                    entry.session_id == candidate.session_id && entry.lease.belongs_to(life)
                })
                .count()
                == 1)
            .then_some(id)
    });
    let mut proven = false;
    for id in ids.drain(..) {
        if let Some(request) = entries.remove(&id)
            && let Some(responder) = request.responder
        {
            // Approval takes this exact responder under the same mutex.
            // An expired or ambiguous reply never supplies stop evidence.
            let eligible = unique == Some(id.as_str()) && !request.cancelled.is_cancelled();
            let sent = responder.respond(outcome.clone()).is_ok();
            proven |= eligible && sent;
        }
    }
    proven
}

pub(super) fn no_elicitation(ctx: &DispatchContext<'_>) -> bool {
    ctx.ops.elicitations.lock().is_ok_and(|entries| {
        !entries.values().any(|entry| {
            entry.session_id == ctx.session_id && entry.lease.belongs_to(&ctx.ops.life)
        })
    })
}

pub(super) fn candidate(ctx: &DispatchContext<'_>) -> Option<StoppedToolCloseReceipt> {
    let (tool, proof) = ctx.tools.stopped_close()?;
    if ctx.async_tasks.busy()
        || ctx.compactions.busy()
        || !ctx.pending.lock().is_ok_and(|entries| {
            !entries.values().any(|entry| {
                entry.session_id == ctx.session_id && entry.lease.belongs_to(&ctx.ops.life)
            })
        })
        || !no_elicitation(ctx)
    {
        return None;
    }
    Some(StoppedToolCloseReceipt {
        connection_id: ctx.ops.connection_id.clone(),
        session_id: ctx.session_id.to_owned(),
        tool_call_id: tool.to_owned(),
        proof_id: proof.to_string(),
    })
}

pub(super) fn start(
    cx: &ConnectionTo<Agent>,
    ctx: &DispatchContext<'_>,
    proof: StoppedToolCloseReceipt,
    deadline: tokio::time::Instant,
    result: oneshot::Sender<Result<StoppedToolCloseReceipt, String>>,
) -> Option<Mutation> {
    let lease = match ctx.ops.life.operation(format!("open:{}", ctx.session_id)) {
        Ok(lease) => lease,
        Err(error) => {
            let _ = result.send(Err(error));
            return None;
        }
    };
    let cx = cx.clone();
    let session = proof.session_id.clone();
    let operation = Operation::new();
    Some(Mutation::new(
        MutationKind::StoppedToolClose(proof),
        MutationReply::StoppedToolClose(result),
        operation,
        lease,
        deadline,
        async move {
            let request =
                UntypedMessage::new("session/close", serde_json::json!({"sessionId":session}))
                    .map_err(describe_acp_error)?;
            cx.send_request_to(Agent, request)
                .block_task()
                .await
                .map_err(describe_acp_error)
        },
    ))
}

pub(super) fn complete(
    ctx: &mut DispatchContext<'_>,
    sessions: &SessionMap,
    completed: Mutation,
    outcome: Result<Value, String>,
    ready: bool,
) -> bool {
    let MutationKind::StoppedToolClose(expected) = &completed.kind else {
        unreachable!();
    };
    let started = completed.started();
    let success = outcome
        .as_ref()
        .is_ok_and(|reply| reply.as_object().is_some_and(|object| object.is_empty()))
        && ready
        && completed.awaiting_reply()
        && candidate(ctx).as_ref() == Some(expected);
    if success
        && let Ok(mut entries) = sessions.lock()
        && completed.awaiting_reply()
        && entries.get(ctx.session_id).is_some_and(|entry| {
            entry.connection_id == expected.connection_id
                && entry.purpose == super::super::open_purpose::OpenPurpose::Conversation
                && entry.preview_token.is_none()
        })
    {
        let receipt = expected.clone();
        // Sending into the original waiting command is the commitment point.
        // Hold the owner lock so a subsequent open cannot see an old route
        // after receiving the receipt.
        if completed.finish_stopped_tool_close(Ok(receipt)) {
            entries.remove(ctx.session_id);
            ctx.tools.release_stopped_close();
            return true;
        }
    } else {
        completed
            .finish_stopped_tool_close(Err(outcome.err().unwrap_or_else(|| UNCONFIRMED.into())));
    }
    if started {
        ctx.tools.invalidate_stopped_close();
    }
    false
}
