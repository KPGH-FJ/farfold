//! Bounded RAM ownership. A dropped observer does not settle a real worker.
use super::{
    domain::{Domain, PreparedPlan as Plan, Source},
    plan::Config,
    types::*,
};
use crate::acp_client::{
    extension_inventory::{Kind, mcp_targets::Report, process::Control},
    operations::Operation,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::watch;
const TTL: Duration = Duration::from_secs(300);
#[derive(Clone, PartialEq, Eq)]
pub(super) enum Input {
    Inspect {
        inventory: String,
        item: usize,
        enabled: bool,
    },
    InspectRemove {
        inventory: String,
        item: usize,
    },
    InspectAdd {
        inventory: String,
        input_id: String,
        input: super::mcp_add_input::Input,
    },
    Confirm {
        review: String,
    },
    Recheck {
        operation: String,
    },
}
pub(super) struct Job {
    pub input: Input,
    pub source: Source,
    pub operation: Operation,
    pub deadline: Instant,
    pub changed: watch::Sender<ChangeOperation>,
    pub plan: Mutex<Option<Arc<Plan>>>,
    pub mcp_report: Mutex<Option<Report>>,
    pub mcp_readback: Mutex<Option<(Config, Config)>>,
    touched: Mutex<Instant>,
    final_outcome: Mutex<Option<Outcome>>,
    pending_review: Mutex<Option<Review>>,
    pending_observation: Mutex<Option<Observation>>,
}
impl Job {
    pub fn snapshot(&self) -> ChangeOperation {
        self.changed.borrow().clone()
    }
    pub fn update(&self, f: impl FnOnce(&mut ChangeOperation)) {
        self.changed.send_modify(f);
    }
    pub fn phase(&self, phase: Phase) {
        self.update(|v| v.phase = phase);
    }
    pub fn within(&self) -> Result<()> {
        if !self.operation.interested() {
            return Err(Code::Cancelled.into());
        }
        if Instant::now() >= self.deadline {
            return Err(Code::TimedOut.into());
        }
        Ok(())
    }
    pub fn observed_outcome(&self, outcome: Outcome) {
        *self.final_outcome.lock().unwrap_or_else(|p| p.into_inner()) = Some(outcome);
    }
    pub fn observed(&self, observation: Observation) {
        *self
            .pending_observation
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(observation);
    }
    pub fn finish(&self, error: Option<Failure>) {
        let outcome = *self.final_outcome.lock().unwrap_or_else(|p| p.into_inner());
        let review = self
            .pending_review
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        let observation = self
            .pending_observation
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        self.update(|v| {
            if v.settled {
                return;
            }
            let error = error.or_else(|| {
                if v.action != Action::Inspect {
                    None
                } else if !self.operation.interested() {
                    Some(Code::Cancelled.into())
                } else if review.is_none() {
                    Some(Code::InvalidOutput.into())
                } else {
                    None
                }
            });
            v.settled = true;
            v.phase = Phase::Complete;
            if v.write_ack == Ack::Rejected
                && matches!(v.action, Action::SetEnabled | Action::Add | Action::Remove)
            {
                // The official pre-write refusal remains a fact even if cleanup fails.
                v.state = State::Failed;
                v.outcome = Some(Outcome::Rejected);
            } else if let Some(error) = error {
                v.code = Some(error.code);
                v.review = None;
                v.state = if error.code == Code::Cancelled && !v.write_dispatched {
                    State::Cancelled
                } else {
                    State::Failed
                };
                if v.action != Action::Inspect
                    || matches!(
                        self.source.domain(),
                        Domain::McpAdd | Domain::McpRemove | Domain::SkillPreferenceRemoval
                    )
                {
                    v.outcome = Some(if v.write_dispatched {
                        Outcome::Unknown
                    } else {
                        Outcome::NotDispatched
                    });
                    if v.write_dispatched && v.write_ack == Ack::None {
                        v.write_ack = Ack::Unknown;
                    }
                }
            } else {
                v.state = State::Ready;
                v.code = None;
                v.outcome = outcome;
                v.review = review;
                if matches!(
                    self.source.domain(),
                    Domain::McpRemove | Domain::SkillPreferenceRemoval
                ) {
                    v.observation = observation;
                }
            }
        });
        *self.touched.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
    }
}
impl Control for Job {
    fn interested(&self) -> bool {
        self.operation.interested()
    }
    fn deadline(&self) -> Instant {
        self.deadline
    }
    fn pending_cleanup(&self) {
        self.update(|v| {
            if v.settled {
                return;
            }
            v.state = State::PendingCleanup;
            if v.write_ack != Ack::Rejected {
                v.code = Some(Code::PendingCleanup);
            }
            v.phase = Phase::Cleaning;
        });
    }
}
struct ReviewEntry {
    inspection: Operation,
    source: Source,
    plan: Arc<Plan>,
    public: Review,
    issued: Instant,
    consumed: bool,
}
enum Entry {
    Job(Arc<Job>),
    Tombstone {
        agent: String,
        domain: Domain,
        at: Instant,
    },
}
#[derive(Default)]
struct RegistryState {
    entries: HashMap<String, Entry>,
    reviews: HashMap<String, ReviewEntry>,
}
#[derive(Default)]
pub(super) struct Requests(Mutex<RegistryState>);
pub(super) fn shared() -> &'static Requests {
    static V: OnceLock<Requests> = OnceLock::new();
    V.get_or_init(Default::default)
}
fn validate(agent: &str, id: &str) -> Result<()> {
    if agent.is_empty()
        || agent.len() > 256
        || agent.chars().any(char::is_control)
        || !crate::acp_client::extension_inventory::requests::valid_id(id)
    {
        return Err(Code::InvalidRequest.into());
    }
    Ok(())
}
pub(super) fn uuid() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Code::Unavailable)?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
impl RegistryState {
    fn prune(&mut self) {
        self.entries.retain(|_, v| match v {
            Entry::Job(j) => {
                !j.snapshot().settled
                    || j.touched
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .elapsed()
                        < TTL
            }
            Entry::Tombstone { at, .. } => at.elapsed() < TTL,
        });
        self.reviews.retain(|_, v| v.issued.elapsed() < TTL);
    }
    fn existing(
        &self,
        agent: &str,
        id: &str,
        input: &Input,
        domain: Domain,
    ) -> Result<Option<Arc<Job>>> {
        match self.entries.get(id) {
            None => Ok(None),
            Some(Entry::Job(j))
                if j.source.row().id == agent
                    && j.source.domain() == domain
                    && &j.input == input =>
            {
                Ok(Some(j.clone()))
            }
            Some(Entry::Tombstone {
                agent: a,
                domain: k,
                ..
            }) if a == agent && *k == domain => Err(Code::Cancelled.into()),
            _ => Err(Code::RequestConflict.into()),
        }
    }
    fn insert(
        &mut self,
        id: &str,
        input: Input,
        source: Source,
        plan: Option<Arc<Plan>>,
        original: Option<&ChangeOperation>,
        enabled: Option<bool>,
    ) -> Result<Arc<Job>> {
        let agent = source.row().id.as_str();
        if self.entries.len() >= 64
            || self.entries.values().any(
                |v| matches!(v,Entry::Job(j) if j.source.row().id==agent && !j.snapshot().settled),
            )
        {
            return Err(Code::Busy.into());
        }
        let action = match input {
            Input::Inspect { .. } | Input::InspectAdd { .. } | Input::InspectRemove { .. } => {
                Action::Inspect
            }
            Input::Confirm { .. } => match source.domain() {
                Domain::McpAdd => Action::Add,
                Domain::McpRemove | Domain::SkillPreferenceRemoval => Action::Remove,
                _ => Action::SetEnabled,
            },
            Input::Recheck { .. } => Action::Recheck,
        };
        let target = source.public()?;
        let op = ChangeOperation {
            agent_id: agent.into(),
            request_id: id.into(),
            action,
            cwd: source.cwd().into(),
            target,
            requested_enabled: enabled,
            operation_id: original.map(|v| v.request_id.clone()),
            state: State::Running,
            phase: Phase::Queued,
            settled: false,
            write_dispatched: original.is_some_and(|v| v.write_dispatched),
            write_ack: original.map_or(Ack::None, |v| v.write_ack),
            outcome: None,
            code: None,
            review: None,
            observation: None,
        };
        let j = Arc::new(Job {
            input,
            source,
            operation: Operation::new(),
            deadline: Instant::now() + Duration::from_secs(30),
            changed: watch::channel(op).0,
            plan: Mutex::new(plan),
            mcp_report: Mutex::new(None),
            mcp_readback: Mutex::new(None),
            touched: Mutex::new(Instant::now()),
            final_outcome: Mutex::new(None),
            pending_review: Mutex::new(None),
            pending_observation: Mutex::new(None),
        });
        self.entries.insert(id.into(), Entry::Job(j.clone()));
        Ok(j)
    }
}
impl Requests {
    pub fn begin_inspect(
        &self,
        agent: &str,
        id: &str,
        inventory: &str,
        item: usize,
        enabled: bool,
    ) -> Result<(Arc<Job>, bool)> {
        self.begin_inspect_kind(agent, id, inventory, item, enabled, Kind::Skills)
    }
    pub fn begin_inspect_kind(
        &self,
        agent: &str,
        id: &str,
        inventory: &str,
        item: usize,
        enabled: bool,
        kind: Kind,
    ) -> Result<(Arc<Job>, bool)> {
        validate(agent, id)?;
        let input = Input::Inspect {
            inventory: inventory.into(),
            item,
            enabled,
        };
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        if let Some(j) = s.existing(agent, id, &input, kind.into())? {
            return Ok((j, false));
        }
        let source = match kind {
            Kind::Skills => Source::Skill(crate::acp_client::extension_inventory::targets::get(
                agent, inventory, item,
            )?),
            Kind::Mcp => Source::Mcp(crate::acp_client::extension_inventory::mcp_targets::get(
                agent, inventory, item,
            )?),
        };
        s.insert(id, input, source, None, None, Some(enabled))
            .map(|j| (j, true))
    }
    pub fn begin_remove_inspect(
        &self,
        agent: &str,
        id: &str,
        inventory: &str,
        item: usize,
    ) -> Result<(Arc<Job>, bool)> {
        validate(agent, id)?;
        let input = Input::InspectRemove {
            inventory: inventory.into(),
            item,
        };
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        if let Some(j) = s.existing(agent, id, &input, Domain::McpRemove)? {
            return Ok((j, false));
        }
        let source =
            crate::acp_client::extension_inventory::mcp_targets::get(agent, inventory, item)?;
        if !source.request.snapshot().is_some_and(|v| matches!(v.snapshot, Some(crate::acp_client::extension_inventory::InventorySnapshot::Mcp(ref m)) if m.complete)) {
            return Err(Code::InventoryIncomplete.into());
        }
        if !source.request.snapshot().is_some_and(|v| matches!(v.snapshot, Some(crate::acp_client::extension_inventory::InventorySnapshot::Mcp(ref m)) if m.items.iter().any(|v|v.id == item && !v.reported_enabled))) {
            return Err(Code::TargetEnabled.into());
        }
        s.insert(id, input, Source::Removal(source), None, None, None)
            .map(|j| (j, true))
    }
    pub fn begin_skill_preference_remove_inspect(
        &self,
        agent: &str,
        id: &str,
        inventory: &str,
        item: usize,
    ) -> Result<(Arc<Job>, bool)> {
        validate(agent, id)?;
        let input = Input::InspectRemove {
            inventory: inventory.into(),
            item,
        };
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.prune();
        if let Some(job) = state.existing(agent, id, &input, Domain::SkillPreferenceRemoval)? {
            return Ok((job, false));
        }
        let source = crate::acp_client::extension_inventory::targets::get(agent, inventory, item)?;
        if !source.request.snapshot().is_some_and(|value| {
            matches!(value.snapshot, Some(crate::acp_client::extension_inventory::InventorySnapshot::Skills(ref skills)) if skills.complete)
        }) {
            return Err(Code::InventoryIncomplete.into());
        }
        state
            .insert(
                id,
                input,
                Source::SkillPreferenceRemoval(source),
                None,
                None,
                None,
            )
            .map(|job| (job, true))
    }
    pub fn begin_add_inspect(
        &self,
        agent: &str,
        id: &str,
        inventory: &str,
        input_id: &str,
        value: impl Into<super::mcp_add_input::Input>,
    ) -> Result<(Arc<Job>, bool)> {
        validate(agent, id)?;
        let value = value.into();
        let input = Input::InspectAdd {
            inventory: inventory.into(),
            input_id: input_id.into(),
            input: value.clone(),
        };
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        if let Some(j) = s.existing(agent, id, &input, Domain::McpAdd)? {
            return Ok((j, false));
        }
        validate(agent, input_id)?;
        value.validate()?;
        let catalogue =
            crate::acp_client::extension_inventory::mcp_targets::catalogue(agent, inventory)?;
        let source = Source::Addition(super::mcp_add_input::Source {
            catalogue,
            input_id: input_id.into(),
            input: value,
        });
        s.insert(id, input, source, None, None, Some(false))
            .map(|j| (j, true))
    }
    pub fn begin_confirm(&self, agent: &str, id: &str, review: &str) -> Result<(Arc<Job>, bool)> {
        self.begin_confirm_kind(agent, id, review, Kind::Skills)
    }
    pub fn begin_confirm_kind(
        &self,
        agent: &str,
        id: &str,
        review: &str,
        kind: Kind,
    ) -> Result<(Arc<Job>, bool)> {
        self.begin_confirm_domain(agent, id, review, kind.into())
    }
    pub fn begin_confirm_domain(
        &self,
        agent: &str,
        id: &str,
        review: &str,
        domain: Domain,
    ) -> Result<(Arc<Job>, bool)> {
        validate(agent, id)?;
        let input = Input::Confirm {
            review: review.into(),
        };
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        if let Some(j) = s.existing(agent, id, &input, domain)? {
            return Ok((j, false));
        }
        let r = s.reviews.get(review).ok_or(Code::ReviewExpired)?;
        if r.source.row().id != agent
            || r.source.domain() != domain
            || !r.source.available()
            || !r.inspection.interested()
        {
            return Err(Code::TargetUnavailable.into());
        }
        if r.consumed {
            return Err(Code::ReviewConsumed.into());
        }
        let (source, plan, enabled) =
            (r.source.clone(), r.plan.clone(), r.public.requested_enabled);
        let j = s.insert(id, input, source, Some(plan), None, enabled)?;
        s.reviews
            .get_mut(review)
            .ok_or(Code::ReviewExpired)?
            .consumed = true;
        Ok((j, true))
    }
    pub fn begin_recheck(
        &self,
        agent: &str,
        id: &str,
        operation: &str,
    ) -> Result<(Arc<Job>, bool)> {
        self.begin_recheck_kind(agent, id, operation, Kind::Skills)
    }
    pub fn begin_recheck_kind(
        &self,
        agent: &str,
        id: &str,
        operation: &str,
        kind: Kind,
    ) -> Result<(Arc<Job>, bool)> {
        self.begin_recheck_domain(agent, id, operation, kind.into())
    }
    pub fn begin_recheck_domain(
        &self,
        agent: &str,
        id: &str,
        operation: &str,
        domain: Domain,
    ) -> Result<(Arc<Job>, bool)> {
        validate(agent, id)?;
        let input = Input::Recheck {
            operation: operation.into(),
        };
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        if let Some(j) = s.existing(agent, id, &input, domain)? {
            return Ok((j, false));
        }
        let Some(Entry::Job(old)) = s.entries.get(operation) else {
            return Err(Code::UnknownRequest.into());
        };
        let op = old.snapshot();
        if op.agent_id != agent
            || old.source.domain() != domain
            || op.action
                != match domain {
                    Domain::McpAdd => Action::Add,
                    Domain::McpRemove | Domain::SkillPreferenceRemoval => Action::Remove,
                    _ => Action::SetEnabled,
                }
            || !op.settled
        {
            return Err(Code::Busy.into());
        }
        let source = old.source.clone();
        let plan = old
            .plan
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or(Code::TargetUnavailable)?;
        s.insert(
            id,
            input,
            source,
            Some(plan),
            Some(&op),
            op.requested_enabled,
        )
        .map(|j| (j, true))
    }
    pub fn publish_review(&self, j: &Job, plan: Arc<Plan>) -> Result<Review> {
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        if j.snapshot().settled || j.snapshot().action != Action::Inspect {
            return Err(Code::InvalidRequest.into());
        }
        if !j.operation.interested() || !j.source.available() {
            return Err(Code::Cancelled.into());
        }
        if s.reviews.len() >= 32 {
            return Err(Code::Busy.into());
        }
        let op = j.snapshot();
        let id = uuid()?;
        if s.reviews.contains_key(&id) {
            return Err(Code::Unavailable.into());
        }
        let public = plan.review(op, id.clone())?;
        s.reviews.insert(
            id,
            ReviewEntry {
                inspection: j.operation.clone(),
                source: j.source.clone(),
                plan,
                public: public.clone(),
                issued: Instant::now(),
                consumed: false,
            },
        );
        // Keep the review private until finish publishes Ready atomically.
        // Exact cancel holds this registry lock and can revoke it first.
        *j.pending_review.lock().unwrap_or_else(|p| p.into_inner()) = Some(public.clone());
        Ok(public)
    }
    pub fn get(&self, agent: &str, id: &str) -> Result<Arc<Job>> {
        self.get_kind(agent, id, Kind::Skills)
    }
    pub fn get_kind(&self, agent: &str, id: &str, kind: Kind) -> Result<Arc<Job>> {
        self.get_domain(agent, id, kind.into())
    }
    pub fn get_domain(&self, agent: &str, id: &str, domain: Domain) -> Result<Arc<Job>> {
        validate(agent, id)?;
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        match s.entries.get(id) {
            Some(Entry::Job(j)) if j.source.row().id == agent && j.source.domain() == domain => {
                Ok(j.clone())
            }
            _ => Err(Code::UnknownRequest.into()),
        }
    }
    pub fn cancel(&self, agent: &str, id: &str) -> Result<Cancellation> {
        self.cancel_kind(agent, id, Kind::Skills)
    }
    pub fn cancel_kind(&self, agent: &str, id: &str, kind: Kind) -> Result<Cancellation> {
        self.cancel_domain(agent, id, kind.into())
    }
    pub fn cancel_domain(&self, agent: &str, id: &str, domain: Domain) -> Result<Cancellation> {
        validate(agent, id)?;
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        let op = match s.entries.get(id) {
            Some(Entry::Job(j)) if j.source.row().id == agent && j.source.domain() == domain => {
                j.operation.abandon();
                j.pending_review
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
                j.update(|v| {
                    if !v.settled {
                        v.state = State::Cancelling;
                    }
                });
                let op = j.snapshot();
                s.reviews.retain(|_, r| r.inspection.interested());
                Some(op)
            }
            Some(Entry::Tombstone {
                agent: a,
                domain: k,
                ..
            }) if a == agent && *k == domain => None,
            Some(_) => return Err(Code::RequestConflict.into()),
            None => {
                if s.entries.len() >= 64 {
                    return Err(Code::Busy.into());
                }
                s.entries.insert(
                    id.into(),
                    Entry::Tombstone {
                        agent: agent.into(),
                        domain,
                        at: Instant::now(),
                    },
                );
                None
            }
        };
        Ok(Cancellation {
            agent_id: agent.into(),
            request_id: id.into(),
            cancel_requested: true,
            operation: op,
        })
    }
}
