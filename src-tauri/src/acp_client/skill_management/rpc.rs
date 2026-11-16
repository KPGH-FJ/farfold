//! A finite official exchange, never a general RPC/Agent execution interface.
use super::{
    domain::PreparedPlan,
    mcp_plan,
    plan::{Config, Plan, exact_skill},
    requests::Job,
    types::*,
};
use crate::{
    acp_client::extension_inventory::{output, process::FixedExchange},
    meta_store::MetaStore,
};
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    sync::Arc,
};
#[derive(Clone, Copy, PartialEq)]
enum Step {
    Initialize,
    BeforeConfig,
    BeforeSkills,
    Write,
    AfterConfig,
    AfterSkills,
    Done,
}
pub(super) struct Exchange<'a> {
    job: &'a Job,
    store: &'a MetaStore,
    step: Step,
    pending: Vec<u8>,
    sent: usize,
    before: Option<Config>,
    after: Option<Config>,
}
impl<'a> Exchange<'a> {
    pub fn new(job: &'a Job, store: &'a MetaStore) -> Result<Self> {
        let mut this = Self {
            job,
            store,
            step: Step::Initialize,
            pending: vec![],
            sent: 0,
            before: None,
            after: None,
        };
        this.queue(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"farfold_skill_management","title":"Farfold","version":env!("CARGO_PKG_VERSION")}}}))?;
        Ok(this)
    }
    fn queue(&mut self, value: Value) -> Result<()> {
        self.pending.fill(0);
        self.pending = serde_json::to_vec(&value).map_err(|_| Code::InvalidRequest)?;
        self.pending.push(b'\n');
        self.sent = 0;
        Ok(())
    }
    fn config(&mut self, id: u64) -> Result<()> {
        self.queue(
            json!({"id":id,"method":"config/read","params":{"includeLayers":true,"cwd":null}}),
        )
    }
    fn skills(&mut self, id: u64) -> Result<()> {
        if self.job.source.kind() == crate::acp_client::extension_inventory::Kind::Mcp {
            return self.queue(json!({"id":id,"method":"config/read","params":{"includeLayers":true,"cwd":self.job.source.cwd()}}));
        }
        self.queue(json!({"id":id,"method":"skills/list","params":{"cwds":[self.job.source.cwd()],"forceReload":true}}))
    }
    fn plan(&self) -> Result<Arc<PreparedPlan>> {
        self.job
            .plan
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| Code::InvalidOutput.into())
    }
    fn accept(&mut self, envelope: Value) -> Result<()> {
        let object = envelope.as_object().ok_or(Code::InvalidOutput)?;
        if let Some(method) = object.get("method") {
            if object.get("id").is_none()
                && object.get("result").is_none()
                && object.get("error").is_none()
                && method.as_str().is_some_and(|v| !v.is_empty())
            {
                return Ok(());
            }
            return Err(Code::InvalidOutput.into());
        }
        let expected = match self.step {
            Step::Initialize => 1,
            Step::BeforeConfig => 2,
            Step::BeforeSkills => 3,
            Step::Write => 4,
            Step::AfterConfig => 5,
            Step::AfterSkills => 6,
            Step::Done => return Err(Code::InvalidOutput.into()),
        };
        if object.get("id").and_then(Value::as_u64) != Some(expected)
            || self.sent != self.pending.len()
        {
            return Err(Code::InvalidOutput.into());
        }
        if let Some(error) = object.get("error") {
            if object.contains_key("result") {
                return Err(Code::InvalidOutput.into());
            }
            if self.step == Step::Write {
                if error.get("code").and_then(Value::as_i64) != Some(-32600)
                    || error.get("message").and_then(Value::as_str).is_none()
                {
                    return Err(Code::WriteUncertain.into());
                }
                let code = match error
                    .pointer("/data/config_write_error_code")
                    .and_then(Value::as_str)
                {
                    Some("configLayerReadonly" | "configRequirementReadonly") => {
                        Some(Code::ConfigurationReadOnly)
                    }
                    Some("configVersionConflict") => Some(Code::ConfigurationChanged),
                    Some("configValidationError") => Some(Code::ConfigurationRejected),
                    _ => None,
                };
                if let Some(code) = code {
                    self.job.update(|v| {
                        v.write_ack = Ack::Rejected;
                        v.code = Some(code);
                    });
                    self.step = Step::Done;
                    return Ok(());
                }
                return Err(Code::WriteUncertain.into());
            }
            return Err(Code::QueryFailed.into());
        }
        let value = object.get("result").cloned().ok_or(Code::InvalidOutput)?;
        match self.step {
            Step::Initialize => {
                if !value
                    .get("userAgent")
                    .and_then(Value::as_str)
                    .is_some_and(|v| !v.is_empty() && v.len() <= 4096)
                {
                    return Err(Code::InvalidOutput.into());
                }
                self.config(2)?;
                self.pending
                    .splice(..0, b"{\"method\":\"initialized\"}\n".iter().copied());
                self.step = Step::BeforeConfig;
                self.job.phase(Phase::Reading);
            }
            Step::BeforeConfig => {
                self.before = Some(Config::parse(value)?);
                self.skills(3)?;
                self.step = Step::BeforeSkills;
            }
            Step::BeforeSkills
                if self.job.source.kind() == crate::acp_client::extension_inventory::Kind::Mcp =>
            {
                let before = self.before.take().ok_or(Code::InvalidOutput)?;
                self.before_mcp(before, Config::parse(value)?)?;
            }
            Step::BeforeSkills => {
                let action = self.job.snapshot().action;
                let target =
                    match exact_skill(value, self.job.source.cwd(), self.job.source.skill()?) {
                        Ok(target) => Some(target),
                        Err(error)
                            if action == Action::Recheck && error.code == Code::TargetChanged =>
                        {
                            None
                        }
                        Err(error) => return Err(error),
                    };
                let before = self.before.take().ok_or(Code::InvalidOutput)?;
                self.job.within()?;
                self.job
                    .source
                    .current(self.store, action == Action::Inspect)?;
                if self.job.source.domain() == super::domain::Domain::SkillPreferenceRemoval {
                    self.before_skill_preference_removal(before, target, action)?;
                    if self.step == Step::Done {
                        self.job.phase(Phase::Cleaning);
                    }
                    return Ok(());
                }
                match action {
                    Action::Inspect => {
                        let plan = Arc::new(Plan::new(
                            before,
                            target.ok_or(Code::TargetChanged)?,
                            self.job
                                .snapshot()
                                .requested_enabled
                                .ok_or(Code::RequestConflict)?,
                        )?);
                        *self.job.plan.lock().unwrap_or_else(|p| p.into_inner()) =
                            Some(Arc::new(PreparedPlan::Skill((*plan).clone())));
                        self.step = Step::Done;
                    }
                    Action::SetEnabled => {
                        let plan = self.plan()?;
                        if !plan
                            .skill()?
                            .unchanged(&before, &target.ok_or(Code::TargetChanged)?)
                        {
                            return Err(Code::ConfigurationChanged.into());
                        }
                        // Conservatively publish before even attempting a partial frame write.
                        self.job.update(|v| {
                            v.write_dispatched = true;
                            v.write_ack = Ack::Unknown;
                            v.phase = Phase::Writing;
                        });
                        self.queue(
                            json!({"id":4,"method":"config/value/write","params":plan.params()}),
                        )?;
                        self.step = Step::Write;
                    }
                    Action::Add | Action::Remove => return Err(Code::RequestConflict.into()),
                    Action::Recheck => {
                        self.observe(before, target.map(|v| v.enabled), false)?;
                        self.step = Step::Done;
                    }
                }
            }
            Step::Write => {
                let plan = self.plan()?;
                if value.get("filePath").and_then(Value::as_str)
                    != Some(plan.before().file.as_str())
                    || !value
                        .get("version")
                        .and_then(Value::as_str)
                        .is_some_and(|v| !v.is_empty() && v.len() <= 256)
                {
                    return Err(Code::InvalidOutput.into());
                }
                let ack = match value.get("status").and_then(Value::as_str) {
                    Some("ok") => Ack::Ok,
                    Some("okOverridden") => Ack::OkOverridden,
                    _ => return Err(Code::InvalidOutput.into()),
                };
                self.job.update(|v| {
                    v.write_ack = ack;
                    v.phase = Phase::Checking;
                });
                self.config(5)?;
                self.step = Step::AfterConfig;
            }
            Step::AfterConfig => {
                self.after = Some(Config::parse(value)?);
                self.skills(6)?;
                self.step = Step::AfterSkills;
            }
            Step::AfterSkills
                if self.job.source.kind() == crate::acp_client::extension_inventory::Kind::Mcp =>
            {
                let after = self.after.take().ok_or(Code::InvalidOutput)?;
                *self
                    .job
                    .mcp_readback
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some((after, Config::parse(value)?));
                self.step = Step::Done;
            }
            Step::AfterSkills => {
                let target =
                    match exact_skill(value, self.job.source.cwd(), self.job.source.skill()?) {
                        Ok(v) => Some(v.enabled),
                        Err(e) if e.code == Code::TargetChanged => None,
                        Err(e) => return Err(e),
                    };
                let after = self.after.take().ok_or(Code::InvalidOutput)?;
                if self.job.source.domain() == super::domain::Domain::SkillPreferenceRemoval {
                    self.observe_skill_preference_removal(&after, target, true)?;
                } else {
                    self.observe(after, target, true)?;
                }
                self.step = Step::Done;
            }
            Step::Done => return Err(Code::InvalidOutput.into()),
        }
        if self.step == Step::Done {
            self.job.phase(Phase::Cleaning);
        }
        Ok(())
    }
    fn before_mcp(&mut self, before: Config, directory: Config) -> Result<()> {
        if self.job.source.domain() == super::domain::Domain::McpRemove {
            return self.before_remove(before, directory);
        }
        if self.job.source.domain() == super::domain::Domain::McpAdd {
            return self.before_add(before, directory);
        }

        let action = self.job.snapshot().action;
        let report = self
            .job
            .mcp_report
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or(Code::InvalidOutput)?;
        self.job.within()?;
        self.job
            .source
            .current(self.store, action == Action::Inspect)?;
        match action {
            Action::Inspect => {
                let plan = mcp_plan::Plan::new(
                    before,
                    directory,
                    report,
                    self.job
                        .snapshot()
                        .requested_enabled
                        .ok_or(Code::RequestConflict)?,
                )?;
                *self.job.plan.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(Arc::new(PreparedPlan::Mcp(plan)));
                self.step = Step::Done;
            }
            Action::SetEnabled => {
                let plan = self.plan()?;
                if !plan.mcp()?.unchanged(&before, &directory, &report) {
                    return Err(Code::ConfigurationChanged.into());
                }
                self.job.update(|v| {
                    v.write_dispatched = true;
                    v.write_ack = Ack::Unknown;
                    v.phase = Phase::Writing;
                });
                self.queue(json!({"id":4,"method":"config/value/write","params":plan.params()}))?;
                self.step = Step::Write;
            }
            Action::Add | Action::Remove => return Err(Code::RequestConflict.into()),
            Action::Recheck => {
                observe_mcp(self.job, &before, &directory, &report, false)?;
                self.step = Step::Done;
            }
        }
        Ok(())
    }
    fn before_remove(&mut self, before: Config, directory: Config) -> Result<()> {
        let action = self.job.snapshot().action;
        self.job.within()?;
        self.job
            .source
            .current(self.store, action != Action::Recheck)?;
        if action == Action::Recheck {
            *self
                .job
                .mcp_readback
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some((before, directory));
            self.step = Step::Done;
            return Ok(());
        }
        let report = self
            .job
            .mcp_report
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or(Code::InvalidOutput)?;
        match action {
            Action::Inspect => {
                let plan = super::mcp_remove_plan::Plan::new(before, directory, report)?;
                *self.job.plan.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(Arc::new(PreparedPlan::Removal(plan)));
                self.step = Step::Done;
            }
            Action::Remove => {
                let plan = self.plan()?;
                if !plan.removal()?.unchanged(&before, &directory, &report) {
                    return Err(Code::ConfigurationChanged.into());
                }
                self.job.update(|v| {
                    v.write_dispatched = true;
                    v.write_ack = Ack::Unknown;
                    v.phase = Phase::Writing;
                });
                self.queue(json!({"id":4,"method":"config/value/write","params":plan.params()}))?;
                self.step = Step::Write;
            }
            _ => return Err(Code::RequestConflict.into()),
        }
        Ok(())
    }
    fn before_add(&mut self, before: Config, directory: Config) -> Result<()> {
        let action = self.job.snapshot().action;
        self.job.within()?;
        self.job
            .source
            .current(self.store, action != Action::Recheck)?;
        match action {
            Action::Inspect => {
                let plan = super::mcp_add_plan::Plan::new(
                    before,
                    directory,
                    self.job.source.addition()?.input.clone(),
                )?;
                *self.job.plan.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(Arc::new(PreparedPlan::Addition(plan)));
                self.step = Step::Done;
            }
            Action::Add => {
                let plan = self.plan()?;
                if !plan.addition()?.unchanged(&before, &directory) {
                    return Err(Code::ConfigurationChanged.into());
                }
                self.job.update(|v| {
                    v.write_dispatched = true;
                    v.write_ack = Ack::Unknown;
                    v.phase = Phase::Writing;
                });
                self.queue(json!({"id":4,"method":"config/value/write","params":plan.params()}))?;
                self.step = Step::Write;
            }
            Action::Recheck => {
                *self
                    .job
                    .mcp_readback
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some((before, directory));
                self.step = Step::Done;
            }
            _ => return Err(Code::RequestConflict.into()),
        }
        Ok(())
    }
    fn before_skill_preference_removal(
        &mut self,
        before: Config,
        target: Option<crate::acp_client::extension_inventory::targets::SkillTarget>,
        action: Action,
    ) -> Result<()> {
        match action {
            Action::Inspect => {
                let plan = super::skill_preference_remove_plan::Plan::new(
                    before,
                    target.ok_or(Code::TargetChanged)?,
                )?;
                *self.job.plan.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(Arc::new(PreparedPlan::SkillPreferenceRemoval(plan)));
                self.step = Step::Done;
            }
            Action::Remove => {
                let plan = self.plan()?;
                if !plan
                    .skill_preference_removal()?
                    .unchanged(&before, &target.ok_or(Code::TargetChanged)?)
                {
                    return Err(Code::ConfigurationChanged.into());
                }
                self.job.update(|value| {
                    value.write_dispatched = true;
                    value.write_ack = Ack::Unknown;
                    value.phase = Phase::Writing;
                });
                self.queue(json!({"id":4,"method":"config/value/write","params":plan.params()}))?;
                self.step = Step::Write;
            }
            Action::Recheck => {
                self.observe_skill_preference_removal(
                    &before,
                    target.map(|value| value.enabled),
                    false,
                )?;
                self.step = Step::Done;
            }
            _ => return Err(Code::RequestConflict.into()),
        }
        Ok(())
    }

    fn observe_skill_preference_removal(
        &self,
        after: &Config,
        actual_enabled: Option<bool>,
        acknowledged: bool,
    ) -> Result<()> {
        let owned = self.plan()?;
        let (observation, matching) = owned
            .skill_preference_removal()?
            .observation(after, actual_enabled)?;
        // Publication waits for actual worker cleanup, as for MCP removal.
        self.job.observed(observation);
        self.job.observed_outcome(if matching {
            if acknowledged {
                Outcome::Verified
            } else {
                Outcome::Observed
            }
        } else {
            Outcome::Mismatch
        });
        Ok(())
    }
    fn observe(&self, config: Config, enabled: Option<bool>, acknowledged: bool) -> Result<()> {
        let owned = self.plan()?;
        let plan = owned.skill()?;
        let matches = plan.config_matches(&config);
        let target_matches = enabled == Some(plan.enabled);
        let observation = Observation {
            observed_at_ms: now_ms(),
            configuration: if matches {
                "matchesIntended"
            } else {
                "changed"
            },
            mcp: None,
            configured_enabled: None,
            skill: Some(if enabled.is_none() {
                "missing"
            } else if target_matches {
                "matchesRequested"
            } else {
                "differs"
            }),
            reported_enabled: enabled,
            parent_outcome: None,
            session_applicability: "unverified",
        };
        self.job.update(|v| v.observation = Some(observation));
        self.job.observed_outcome(if matches && target_matches {
            if acknowledged {
                Outcome::Verified
            } else {
                Outcome::Observed
            }
        } else {
            Outcome::Mismatch
        });
        Ok(())
    }
    pub fn finish(&self, remaining: &[u8]) -> Result<()> {
        if self.step != Step::Done || !remaining.iter().all(u8::is_ascii_whitespace) {
            return Err(Code::InvalidOutput.into());
        }
        Ok(())
    }
    pub(super) fn write_to(&mut self, writer: &mut (impl Write + ?Sized)) -> Result<()> {
        if self.sent == self.pending.len() {
            return Ok(());
        }
        if self.step == Step::Write {
            self.job.within()?;
            // A queued frame does not keep a replaced cwd/selection current.
            // An independently admitted enablement still survives inventory revocation.
            let require_inventory = matches!(
                self.job.source.domain(),
                super::domain::Domain::McpAdd
                    | super::domain::Domain::McpRemove
                    | super::domain::Domain::SkillPreferenceRemoval
            );
            self.job.source.current(self.store, require_inventory)?;
        }
        match writer.write(&self.pending[self.sent..]) {
            Ok(0) => Err(Code::QueryFailed.into()),
            Ok(n) => {
                self.sent += n;
                Ok(())
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) =>
            {
                Ok(())
            }
            Err(_) => Err(Code::QueryFailed.into()),
        }
    }
}
impl FixedExchange for Exchange<'_> {
    fn write(&mut self, writer: &mut dyn Write) -> Result<()> {
        self.write_to(writer)
    }
    fn received(&mut self, bytes: &mut Vec<u8>) -> Result<()> {
        while let Some(end) = bytes.iter().position(|b| *b == b'\n') {
            if end > 1048576 || !output::bounded_depth(&bytes[..end]) {
                return Err(Code::OutputLimit.into());
            }
            let value = serde_json::from_slice(&bytes[..end]).map_err(|_| Code::InvalidOutput)?;
            self.accept(value)?;
            bytes[..=end].fill(0);
            bytes.drain(..=end);
        }
        if bytes.len() > 1048576 {
            return Err(Code::OutputLimit.into());
        }
        Ok(())
    }
    fn done(&self) -> bool {
        self.step == Step::Done
    }
}
impl Drop for Exchange<'_> {
    fn drop(&mut self) {
        self.pending.fill(0);
    }
}

pub(super) fn observe_mcp(
    job: &Job,
    after: &Config,
    directory: &Config,
    report: &crate::acp_client::extension_inventory::mcp_targets::Report,
    acknowledged: bool,
) -> Result<()> {
    let owned = job
        .plan
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or(Code::InvalidOutput)?;
    let plan = owned.mcp()?;
    // list omits fields such as tool filters; inspect adds the complete get
    // identity. A later get must still describe that exact reviewed target.
    if report.target != plan.report.target {
        return Err(Code::TargetChanged.into());
    }
    let (observation, matching) = plan.observation(after, directory, report);
    job.update(|v| v.observation = Some(observation));
    job.observed_outcome(if matching {
        if acknowledged {
            Outcome::Verified
        } else {
            Outcome::Observed
        }
    } else {
        Outcome::Mismatch
    });
    Ok(())
}
