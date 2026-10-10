//! Bounded RAM ownership. A dropped observer does not settle a real worker.
use super::{plan::Plan, types::*};
use crate::acp_client::{
    extension_inventory::{process::Control, targets::Source},
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
    touched: Mutex<Instant>,
    final_outcome: Mutex<Option<Outcome>>,
    pending_review: Mutex<Option<Review>>,
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
    pub fn finish(&self, error: Option<Failure>) {
        let outcome = *self.final_outcome.lock().unwrap_or_else(|p| p.into_inner());
        let review = self
            .pending_review
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
            if v.write_ack == Ack::Rejected && v.action == Action::SetEnabled {
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
                if v.action != Action::Inspect {
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
    Tombstone { agent: String, at: Instant },
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
    fn existing(&self, agent: &str, id: &str, input: &Input) -> Result<Option<Arc<Job>>> {
        match self.entries.get(id) {
            None => Ok(None),
            Some(Entry::Job(j)) if j.source.set.row.id == agent && &j.input == input => {
                Ok(Some(j.clone()))
            }
            Some(Entry::Tombstone { agent: a, .. }) if a == agent => Err(Code::Cancelled.into()),
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
        enabled: bool,
    ) -> Result<Arc<Job>> {
        let agent = source.set.row.id.as_str();
        if self.entries.len()>=64 || self.entries.values().any(|v|matches!(v,Entry::Job(j) if j.source.set.row.id==agent && !j.snapshot().settled)) {return Err(Code::Busy.into());}
        let action = match input {
            Input::Inspect { .. } => Action::Inspect,
            Input::Confirm { .. } => Action::SetEnabled,
            Input::Recheck { .. } => Action::Recheck,
        };
        let target = Target {
            inventory_request_id: source.inventory_id.clone(),
            item_id: source.target.id,
            name: source.target.name.clone(),
            origin: source.target.origin.clone(),
            display_path: super::plan::display_path(&source.target.path)?,
        };
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
            touched: Mutex::new(Instant::now()),
            final_outcome: Mutex::new(None),
            pending_review: Mutex::new(None),
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
        validate(agent, id)?;
        let input = Input::Inspect {
            inventory: inventory.into(),
            item,
            enabled,
        };
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        if let Some(j) = s.existing(agent, id, &input)? {
            return Ok((j, false));
        }
        let source = crate::acp_client::extension_inventory::targets::get(agent, inventory, item)?;
        s.insert(id, input, source, None, None, enabled)
            .map(|j| (j, true))
    }
    pub fn begin_confirm(&self, agent: &str, id: &str, review: &str) -> Result<(Arc<Job>, bool)> {
        validate(agent, id)?;
        let input = Input::Confirm {
            review: review.into(),
        };
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        if let Some(j) = s.existing(agent, id, &input)? {
            return Ok((j, false));
        }
        let r = s.reviews.get(review).ok_or(Code::ReviewExpired)?;
        if r.source.set.row.id != agent || !r.source.available() || !r.inspection.interested() {
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
        validate(agent, id)?;
        let input = Input::Recheck {
            operation: operation.into(),
        };
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        if let Some(j) = s.existing(agent, id, &input)? {
            return Ok((j, false));
        }
        let Some(Entry::Job(old)) = s.entries.get(operation) else {
            return Err(Code::UnknownRequest.into());
        };
        let op = old.snapshot();
        if op.agent_id != agent || op.action != Action::SetEnabled || !op.settled {
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
        let public = Review {
            review_id: id.clone(),
            agent_id: op.agent_id,
            cwd: op.cwd,
            target: op.target,
            requested_enabled: plan.enabled,
            reported_enabled: plan.target.enabled,
            write_scope: plan.before.scope()?,
            observed_at_ms: now_ms(),
            valid_for_ms: 300000,
            rules_before: plan.rules_before,
            rules_after: plan.array.as_array().ok_or(Code::InvalidOutput)?.len(),
            mutation: plan.mutation,
            preservation: "officialJsonValues",
            session_applicability: "unverified",
        };
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
        validate(agent, id)?;
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        match s.entries.get(id) {
            Some(Entry::Job(j)) if j.source.set.row.id == agent => Ok(j.clone()),
            _ => Err(Code::UnknownRequest.into()),
        }
    }
    pub fn cancel(&self, agent: &str, id: &str) -> Result<Cancellation> {
        validate(agent, id)?;
        let mut s = self.0.lock().unwrap_or_else(|p| p.into_inner());
        s.prune();
        let op = match s.entries.get(id) {
            Some(Entry::Job(j)) if j.source.set.row.id == agent => {
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
            Some(Entry::Tombstone { agent: a, .. }) if a == agent => None,
            Some(_) => return Err(Code::RequestConflict.into()),
            None => {
                if s.entries.len() >= 64 {
                    return Err(Code::Busy.into());
                }
                s.entries.insert(
                    id.into(),
                    Entry::Tombstone {
                        agent: agent.into(),
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
