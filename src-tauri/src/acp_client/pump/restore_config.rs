//! Reapply an already confirmed selection to the same loaded conversation.
use super::*;
use crate::acp_client::model_guard::{Choice, ConfigCheck, ConfigStore, ModelGuard, Snapshot};
use crate::acp_client::service_connection::ServiceRecord;
use std::collections::{BTreeSet, VecDeque};

pub(crate) struct OpenState {
    pub options: Option<Value>,
    pub config_options_modern: bool,
    pub check: ConfigCheck,
    pub permission_config_id: Option<String>,
    pub permission_state: &'static str,
    pub permission_effect: Option<super::super::permission_effect::PermissionEffect>,
    pub warnings: Vec<String>,
}

pub(super) struct Opening {
    pub purpose: super::super::open_purpose::OpenPurpose,
    pub reply: Option<oneshot::Sender<Result<OpenState, String>>>,
    pub operation: Operation,
    pub recorded: Option<Value>,
    pub restored: bool,
    pub options: Option<Value>,
    pub config_options_modern: bool,
    pub warnings: Vec<String>,
}

impl Opening {
    pub fn state(
        &self,
        guard: &ModelGuard,
        permissions: &super::super::permission_guard::PermissionGuard,
    ) -> OpenState {
        OpenState {
            options: self.options.clone(),
            config_options_modern: self.config_options_modern,
            check: guard.check(),
            permission_config_id: permissions.id(),
            permission_state: permissions.state(),
            permission_effect: permissions.effect(),
            warnings: self.warnings.clone(),
        }
    }
}

pub(crate) struct Plan {
    pub record: Value,
    remaining: VecDeque<Choice>,
    confirmed: Vec<Choice>,
    requested: Option<Choice>,
    observed: Option<Value>,
}

const UNCONFIRMED: &str = "无法确认此对话已保存的模型或思考选择，请检查后重试";

impl Plan {
    pub(super) fn new(opening: &Opening, store: &ConfigStore) -> Result<Option<Self>, String> {
        let Some(record) = opening.recorded.as_ref().filter(|_| opening.restored) else {
            return Ok(None);
        };
        if record["_farfoldConfig"] != 2 {
            return Ok(None);
        }
        let object = record.as_object().ok_or(UNCONFIRMED)?;
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "choices" | "_farfoldConfig" | "_farfoldService"
            )
        }) {
            return Err(UNCONFIRMED.into());
        }
        let source = object.get("_farfoldService").ok_or(UNCONFIRMED)?;
        let source: ServiceRecord =
            serde_json::from_value(source.clone()).map_err(|_| UNCONFIRMED)?;
        if store.service_record.as_ref() != Some(&source) {
            return Err("此对话的 API 来源无法确认，请保持原设置".into());
        }
        let saved: Snapshot = serde_json::from_value(record.clone()).map_err(|_| UNCONFIRMED)?;
        let mut ids = BTreeSet::new();
        if saved.choices.iter().any(|choice| {
            choice.id.is_empty()
                || choice.kind != "select"
                || !matches!(choice.category.as_str(), "model" | "thought_level")
                || !ids.insert(choice.id.clone())
        }) {
            return Err(UNCONFIRMED.into());
        }
        if !saved
            .choices
            .iter()
            .any(|choice| choice.category == "model")
        {
            return Ok(None);
        }
        if let Some(expected) = &store.expected_model {
            let models = saved
                .choices
                .iter()
                .filter(|choice| choice.category == "model")
                .collect::<Vec<_>>();
            if models.len() != 1 || models[0].value != *expected {
                return Err("此对话已保存的模型与所选 API 不一致，请检查原设置".into());
            }
        } else if matches!(source, ServiceRecord::Configured { .. }) {
            return Err("无法确认此对话的 API 模型，请检查原设置".into());
        }
        let mut choices = saved.choices;
        choices.sort_by(|left, right| {
            (left.category != "model", &left.id).cmp(&(right.category != "model", &right.id))
        });
        Ok(Some(Self {
            record: record.clone(),
            remaining: choices.into(),
            confirmed: Vec::new(),
            requested: None,
            observed: None,
        }))
    }

    pub(super) fn observe(&mut self, options: &Value) {
        self.observed = Some(options.clone());
    }

    fn validate_confirmed(&self, options: &Value) -> Result<(), String> {
        if ModelGuard::new(options, Some(&self.record), true)
            .check()
            .issues
            .iter()
            .any(|issue| issue.category == "model" && issue.reason != "changed")
        {
            return Err(UNCONFIRMED.into());
        }
        for choice in &self.confirmed {
            if declared(options, choice)?["currentValue"] != choice.value {
                return Err("Agent 已恢复的选择又发生变化，请重新检查此对话".into());
            }
        }
        Ok(())
    }

    fn validate_pending(&self, options: &Value) -> Result<(), String> {
        self.validate_confirmed(options)?;
        let requested = self.requested.as_ref().ok_or(UNCONFIRMED)?;
        let option = declared(options, requested)?;
        if !offers(&option["options"], &requested.value) {
            return Err(UNCONFIRMED.into());
        }
        Ok(())
    }

    pub(super) fn next(&mut self, options: &Value) -> Result<Option<Choice>, String> {
        self.validate_confirmed(options)?;
        while let Some(choice) = self.remaining.pop_front() {
            let option = declared(options, &choice)?;
            if option["currentValue"] == choice.value {
                self.confirmed.push(choice);
                continue;
            }
            if !offers(&option["options"], &choice.value) {
                return Err(UNCONFIRMED.into());
            }
            self.requested = Some(choice.clone());
            self.observed = None;
            return Ok(Some(choice));
        }
        Ok(None)
    }

    pub(super) fn complete(&mut self, reply: &Value) -> Result<Value, String> {
        let requested = self.requested.as_ref().ok_or(UNCONFIRMED)?;
        if declared(reply, requested)?["currentValue"] != requested.value {
            return Err(UNCONFIRMED.into());
        }
        // During this request the pump already delivered every received raw
        // envelope. A conflicting notification cannot be hidden by an older
        // request receipt. The load prefix was drained before starting it.
        if let Some(observed) = &self.observed {
            let observed_guard = ModelGuard::new(observed, Some(&self.record), true);
            let reply_guard = ModelGuard::new(reply, Some(&self.record), true);
            if observed_guard.current_value() != reply_guard.current_value()
                || observed_guard
                    .check()
                    .issues
                    .iter()
                    .any(|issue| issue.reason == "missing")
                || observed_mode(observed) != observed_mode(reply)
            {
                return Err("Agent 设置在恢复确认时又发生变化，请重新检查此对话".into());
            }
        }
        self.confirmed
            .push(self.requested.take().ok_or(UNCONFIRMED)?);
        Ok(reply.clone())
    }
}

fn observed_mode(options: &Value) -> Vec<Value> {
    options.as_array().into_iter().flatten().filter(|option| option["category"] == "mode")
        .map(|option| serde_json::json!({"id":option["id"], "type":option["type"], "value":option["currentValue"]})).collect()
}

fn declared<'a>(options: &'a Value, choice: &Choice) -> Result<&'a Value, String> {
    let mut matches = options
        .as_array()
        .ok_or(UNCONFIRMED)?
        .iter()
        .filter(|option| option["id"] == choice.id);
    let option = matches.next().ok_or(UNCONFIRMED)?;
    if matches.next().is_some() || option["type"] != "select" || !option["currentValue"].is_string()
    {
        return Err(UNCONFIRMED.into());
    }
    Ok(option)
}

fn offers(options: &Value, value: &str) -> bool {
    options.as_array().is_some_and(|entries| {
        entries
            .iter()
            .any(|entry| entry["value"] == value || offers(&entry["options"], value))
    })
}

fn work_busy(ctx: &DispatchContext<'_>) -> bool {
    ctx.tools.busy() || ctx.compactions.busy() || ctx.async_tasks.busy()
}

pub(super) fn busy(ctx: &DispatchContext<'_>) -> bool {
    work_busy(ctx)
        || ctx
            .pending
            .lock()
            .map(|entries| {
                entries
                    .values()
                    .any(|entry| entry.session_id == ctx.session_id)
            })
            .unwrap_or(true)
        || ctx
            .ops
            .elicitations
            .lock()
            .map(|entries| {
                entries
                    .values()
                    .any(|entry| entry.session_id == ctx.session_id)
            })
            .unwrap_or(true)
}

pub(super) async fn next_mutation(
    mutation: &mut Option<Mutation>,
    opening: &Option<Opening>,
    ctx: &mut DispatchContext<'_>,
    permissions: &super::super::permission_guard::PermissionGuard,
    stopped_close_ready: impl FnOnce() -> bool,
) -> Option<Result<Value, String>> {
    // This async body runs only when the select branch is polled. An inbox
    // update can invalidate a prepared continuation before its first poll.
    if let Some(pending) = mutation.as_ref()
        && !pending.started()
    {
        // Repeat each control's existing work admission. Ordinary close need
        // not wait for pending inquiries; ForkClose still owns its actual reply
        // independently of caller interest/deadline in Mutation::poll.
        let rejected = match &pending.kind {
            MutationKind::Config { .. } if busy(ctx) => {
                Some("当前无法修改此设置，请等待已发出的请求结束")
            }
            MutationKind::Mode | MutationKind::Close | MutationKind::Delete if work_busy(ctx) => {
                Some("上次请求尚未结束，请先停止或等待")
            }
            MutationKind::StoppedToolClose(expected)
                if !stopped_close_ready()
                    || !permissions.admissible()
                    || stopped_tool_close::candidate(ctx).as_ref() != Some(expected) =>
            {
                Some(stopped_tool_close::INELIGIBLE)
            }
            _ => None,
        };
        if let Some(error) = rejected {
            return Some(Err(error.into()));
        }
    }
    if let Some(pending) = mutation.as_ref()
        && !pending.started()
        && let MutationKind::Restore { plan, .. } = &pending.kind
    {
        let admission = if !pending.awaiting_reply()
            || busy(ctx)
            || !matches!(permissions.state(), "ready" | "required")
        {
            Err("恢复结果尚未确认，请完成待处理事项后重试".into())
        } else {
            plan.validate_pending(
                opening
                    .as_ref()
                    .and_then(|opening| opening.options.as_ref())
                    .unwrap_or(&Value::Null),
            )
        };
        if let Err(error) = admission {
            return Some(Err(error));
        }
    }
    super::super::mutation::next(mutation).await
}

pub(super) fn update(
    options: &Value,
    modern: bool,
    guard: &ModelGuard,
    opening: &mut Option<Opening>,
    mutation: &mut Option<Mutation>,
) {
    if let Some(opening) = opening {
        opening.options = Some(options.clone());
        opening.config_options_modern = modern;
    }
    match mutation.as_mut().map(|active| &mut active.kind) {
        Some(MutationKind::Restore { plan, .. }) => plan.observe(options),
        Some(MutationKind::Config {
            request,
            prior_guard: Some(prior),
            ..
        }) => request.observe_choices(prior, guard),
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn drain(
    inbox: &mut super::super::session_routes::Inbox,
    ctx: &mut DispatchContext<'_>,
    configuration: &mut super::super::session_config::SessionConfig,
    models: &mut HashSet<String>,
    guard: &mut ModelGuard,
    permissions: &mut super::super::permission_guard::PermissionGuard,
    opening: &mut Option<Opening>,
    mutation: &mut Option<Mutation>,
) {
    while let Ok(dispatch) = inbox.try_recv() {
        let options = configuration.observe(&dispatch);
        if let Some(options) = &options {
            models.extend(model_ids(options));
            guard.observe(options);
            if !options.is_array() {
                guard.change_unknown();
            }
            permissions.observe(options);
            update(
                options,
                configuration.modern_options().is_some(),
                guard,
                opening,
                mutation,
            );
        }
        handle_session_dispatch(dispatch, ctx);
        if let Some(options) = options {
            (ctx.events)(super::super::session_config::projection(
                options,
                configuration.modern_options().is_some(),
            ));
        }
    }
}

pub(super) fn finish(
    opening: &mut Option<Opening>,
    completed: Option<Mutation>,
    guard: &mut ModelGuard,
    permissions: &super::super::permission_guard::PermissionGuard,
    events: &SessionSink,
) {
    let Some(mut opening) = opening.take() else {
        return;
    };
    let delivered = opening.operation.interested()
        && completed.as_ref().map_or_else(
            || {
                opening
                    .reply
                    .as_ref()
                    .is_some_and(|reply| !reply.is_closed())
            },
            Mutation::awaiting_reply,
        );
    if !delivered {
        guard.change_unknown();
    }
    let state = opening.state(guard, permissions);
    events(permissions.event());
    events(serde_json::json!({"kind":"configCheck", "check":state.check}));
    if let Some(completed) = completed {
        completed.finish_open(if delivered {
            Ok(state)
        } else {
            Err("恢复结果尚未确认，请重新检查此对话".into())
        });
    } else if let Some(reply) = opening.reply.take() {
        let _ = reply.send(if delivered {
            Ok(state)
        } else {
            Err("恢复结果尚未确认，请重新检查此对话".into())
        });
    }
}
