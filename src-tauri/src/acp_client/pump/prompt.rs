//! One granted request, using the original pump guards and SDK actor.
use super::super::active_prompt::{CancelRequest, DispatchResult, Granted, Phase, Progress};
use super::*;
use agent_client_protocol::schema::v1::{ContentBlock, PromptRequest};

pub(super) struct Outcome {
    pub receipt_id: u64,
    pub result: Result<Value, String>,
    pub matched_wire_error: bool,
}
pub(super) struct Active {
    pub owner: super::super::history_admission::Owner,
    pub observation: super::super::process::PromptObservation,
}
impl Active {
    pub(super) fn unresolved(&self) -> bool {
        self.observation.unresolved()
    }
}
pub(super) struct Started {
    pub active: Active,
    pub sent: Result<(), String>,
}
pub(super) struct Input<'a, 'event> {
    pub cx: &'a ConnectionTo<Agent>,
    pub ctx: &'a mut DispatchContext<'event>,
    pub config_store: &'a super::super::model_guard::ConfigStore,
    pub model_guard: &'a mut super::super::model_guard::ModelGuard,
    pub permission_guard: &'a mut super::super::permission_guard::PermissionGuard,
    pub inbox: &'a mut super::super::session_routes::Inbox,
    pub configuration: &'a mut super::super::session_config::SessionConfig,
    pub models: &'a mut HashSet<String>,
    pub opening: &'a mut Option<restore_config::Opening>,
    pub mutation: &'a mut Option<Mutation>,
    pub mcp: Option<&'a super::super::transient_mcp::SessionMcpRequests>,
    pub turn: &'a mpsc::UnboundedSender<Outcome>,
    pub in_flight: bool,
    pub unresolved: bool,
}
pub(super) async fn send(
    input: Input<'_, '_>,
    blocks: Vec<ContentBlock>,
    grant: Granted,
    result: &oneshot::Sender<DispatchResult>,
) -> Result<Started, String> {
    let Input {
        cx,
        ctx,
        config_store,
        model_guard,
        permission_guard,
        inbox,
        configuration,
        models,
        opening,
        mutation,
        mcp,
        turn,
        in_flight,
        unresolved,
    } = input;
    if grant.connection_id != ctx.ops.connection_id || grant.session_id != ctx.session_id {
        return Err("SESSION_UNAVAILABLE".into());
    }
    if ctx.compactions.busy() {
        return Err("上下文整理尚未结束，请等待明确结果".into());
    }
    if !permission_guard.admissible() {
        (ctx.events)(permission_guard.event());
        return Err("请重新确认权限后再发送".into());
    }
    if permission_guard.blocks_prompt(&blocks) {
        return Err("PROMPT_PERMISSION_SCOPE_UNVERIFIED".into());
    }
    let source_model_ok = config_store
        .expected_model
        .as_ref()
        .is_none_or(|expected| model_guard.single_model_value() == Some(expected));
    let source_check = if source_model_ok {
        config_store.validate_service().await
    } else {
        Err("Agent 的模型与所选 API 不一致，请重新选择后重试".into())
    };
    if let Err(error) = source_check {
        (ctx.events)(serde_json::json!({"kind":"serviceUnavailable","message":error}));
        return Err("SERVICE_UNAVAILABLE".into());
    }
    if !model_guard.admissible() {
        (ctx.events)(serde_json::json!({"kind":"configCheck","check":model_guard.check()}));
        return Err(format!(
            "CONFIG_{}",
            model_guard.check().status.to_uppercase()
        ));
    }
    if model_guard.current_value() != grant.expected_current {
        return Err("CONFIG_BLOCKED".into());
    }
    if in_flight || unresolved || mutation.is_some() {
        return Err("上次请求尚未结束，请先停止或等待".into());
    }
    if ctx.terminals.is_some_and(tool_terminal::Session::blocked) {
        return Err("上次命令仍未确认结束，请先检查".into());
    }
    let lease = ctx.ops.life.work()?;
    let saved_config = model_guard.record();
    if config_store
        .save(ctx.session_id, saved_config.clone())
        .await
        .is_err()
    {
        model_guard.record_failed();
        (ctx.events)(serde_json::json!({"kind":"configCheck","check":model_guard.check()}));
        return Err("CONFIG_RECORD_FAILED".into());
    }
    model_guard.saved_session();
    if let Err(error) = config_store.validate_service().await {
        (ctx.events)(serde_json::json!({"kind":"serviceUnavailable","message":error}));
        return Err("SERVICE_UNAVAILABLE".into());
    }
    restore_config::drain(
        inbox,
        ctx,
        configuration,
        models,
        model_guard,
        permission_guard,
        opening,
        mutation,
    );
    if ctx.compactions.busy() {
        return Err("上下文整理尚未结束，请等待明确结果".into());
    }
    if !permission_guard.admissible() {
        (ctx.events)(permission_guard.event());
        return Err("请重新确认权限后再发送".into());
    }
    if !model_guard.admissible()
        || model_guard.record() != saved_config
        || model_guard.current_value() != grant.expected_current
    {
        (ctx.events)(serde_json::json!({"kind":"configCheck","check":model_guard.check()}));
        return Err("CONFIG_BLOCKED".into());
    }
    if result.is_closed() {
        return Err("请求等待已结束，消息尚未发送".into());
    }
    super::super::session_tool_recovery::require_ready(config_store, ctx.session_id).await?;
    let observation = ctx
        .ops
        .prompt_escrow
        .commit(ctx.session_id, &grant.permit, lease, grant.deadline)
        .map_err(|error| match error {
            super::super::history_admission::Failure::Timeout => "PROMPT_QUEUE_TIMEOUT",
            _ => "PROMPT_QUEUE_CANCELLED",
        })?;
    // Commit is conservative: a panic/SDK registration error from here cannot
    // return an unsent rejection or release the exact process resource.
    let _ = (grant.progress)(Progress {
        receipt_id: grant.receipt_id,
        phase: Phase::Offered,
    });
    if let Some(requests) = mcp {
        requests.set_prompt_active(true);
    }
    let receipt_id = grant.receipt_id;
    let active = Active {
        owner: grant.owner,
        observation: observation.clone(),
    };
    let sent = cx
        .send_request_to(Agent, PromptRequest::new(ctx.session_id.to_owned(), blocks))
        .on_receiving_result({
            let turn = turn.clone();
            async move |outcome| {
                let matched_wire_error = outcome.as_ref().is_err_and(|error| {
                    !agent_client_protocol::is_incoming_transport_closed(error)
                        && observation.matched_wire_error()
                });
                let outcome = outcome
                    .and_then(|response| {
                        serde_json::to_value(&response)
                            .map_err(agent_client_protocol::Error::into_internal_error)
                    })
                    .map_err(describe_acp_error);
                observation.observe(&outcome);
                let _ = turn.send(Outcome {
                    receipt_id,
                    result: outcome,
                    matched_wire_error,
                });
                Ok(())
            }
        })
        .map_err(describe_acp_error);
    if sent.is_ok() {
        if let Some(terminals) = ctx.terminals {
            terminals.begin(receipt_id, active.observation.clone());
        }
        ctx.tools.start_prompt(receipt_id);
        ctx.compactions.begin_live();
        (ctx.events)(serde_json::json!({"kind":"configCheck","check":model_guard.check()}));
    } else {
        ctx.tools.invalidate_stopped_close();
        if let Some(requests) = mcp {
            requests.set_prompt_active(false);
        }
    }
    Ok(Started { active, sent })
}

pub(super) fn cancel(
    cx: &ConnectionTo<Agent>,
    ctx: &mut DispatchContext<'_>,
    active: Option<&Active>,
    request: CancelRequest,
    mcp: Option<&super::super::transient_mcp::SessionMcpRequests>,
) {
    let matches = active.is_some_and(|active| {
        active.owner == request.owner
            && active.observation.receipt_id() == request.receipt_id
            && (active.unresolved()
                || ctx
                    .terminals
                    .is_some_and(|terminals| terminals.stopping_possible(request.receipt_id)))
    });
    if !matches {
        let _ = request.result.send(Ok(false));
        return;
    }
    let (sent, mut received) = oneshot::channel();
    send_session_cancel(cx, ctx, sent, true, mcp);
    let sent = received
        .try_recv()
        .map_err(|_| "无法确认停止请求".to_owned())
        .and_then(|result| result)
        .map(|()| true);
    let _ = request.result.send(sent);
}

/// `{kind:"turnEnd"}` event for a finished prompt request.
pub(super) fn turn_end_event(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(response) => {
            let mut event = serde_json::Map::new();
            event.insert("kind".to_string(), Value::String("turnEnd".to_string()));
            if let Some(stop_reason) = response.get("stopReason") {
                event.insert("stopReason".to_string(), stop_reason.clone());
            }
            if let Some(usage) = response.get("usage") {
                event.insert("usage".to_string(), usage.clone());
            }
            if let Some(meta) = response.get("_meta") {
                event.insert("meta".to_string(), meta.clone());
            }
            Value::Object(event)
        }
        Err(error) => serde_json::json!({"kind": "turnEnd", "error": error}),
    }
}
