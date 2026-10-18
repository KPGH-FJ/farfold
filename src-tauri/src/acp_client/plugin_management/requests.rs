//! Single bounded RAM worker. Cancellation never releases process ownership.
use super::{catalog::Entry, types::*};
use crate::{
    acp_client::{
        extension_inventory::{self as inventory, process::Control},
        operations::Operation,
    },
    meta_store::{AgentRow, MetaStore},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;
pub(super) const TTL: Duration = Duration::from_secs(300);

pub(super) struct Source {
    pub row: AgentRow,
    pub cwd: String,
    pub directory: inventory::launch::Directory,
    pub environment: HashMap<String, String>,
}
impl Source {
    pub fn current(&self, store: &MetaStore) -> Result<()> {
        let row = store
            .get_agent(&self.row.id)
            .map_err(|_| Code::Unavailable)?;
        if !row
            .as_ref()
            .is_some_and(|v| inventory::launch::same_selection(&self.row, v))
        {
            return Err(Code::SelectionChanged.into());
        }
        inventory::launch::admission(&self.row)?;
        if !self.directory.current() {
            return Err(Code::CwdUnavailable.into());
        }
        if crate::shell_env::cached_command_env().as_ref() != Some(&self.environment) {
            return Err(Code::ConfigurationChanged.into());
        }
        Ok(())
    }
}
pub(super) struct Plan {
    pub public: PluginReview,
    pub entry: Entry,
    pub source: Arc<Source>,
    pub born: Instant,
    pub consumed: AtomicBool,
    pub acknowledged_version: Mutex<Option<String>>,
}
#[derive(Clone, PartialEq, Eq)]
pub(super) enum Input {
    Inventory {
        selection: String,
        cwd: String,
    },
    Inspect {
        inventory: String,
        item: usize,
        install: bool,
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
    pub source: Arc<Source>,
    pub entry: Option<Entry>,
    pub plan: Option<Arc<Plan>>,
    pub operation: Operation,
    pub deadline: Instant,
    pub born: Instant,
    pub changed: watch::Sender<PluginOperation>,
    pub entries: Mutex<Option<Vec<Entry>>>,
    pub review: Mutex<Option<Arc<Plan>>>,
    pub effectful: AtomicBool,
}
impl Job {
    pub fn snapshot(&self) -> PluginOperation {
        self.changed.borrow().clone()
    }
    pub fn update(&self, f: impl FnOnce(&mut PluginOperation)) {
        self.changed.send_modify(f);
    }
    pub fn within(&self) -> Result<()> {
        if !self.operation.interested() {
            Err(Code::Cancelled.into())
        } else if Instant::now() >= self.deadline {
            Err(Code::TimedOut.into())
        } else {
            Ok(())
        }
    }
    pub fn finish(&self, error: Option<Failure>) {
        self.update(|v| {
            v.settled = true;
            v.phase = Phase::Complete;
            let error =
                error.or_else(|| (!self.operation.interested()).then_some(Code::Cancelled.into()));
            if let Some(error) = error {
                v.code = Some(error.code);
                v.catalog = None;
                v.review = None;
                v.state = if error.code == Code::Cancelled && !v.write_dispatched {
                    State::Cancelled
                } else {
                    State::Failed
                };
                if matches!(v.action, Action::Install | Action::Remove | Action::Recheck) {
                    v.outcome = Some(if v.write_dispatched || v.action == Action::Recheck {
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
            }
        });
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
            v.state = State::PendingCleanup;
            v.phase = Phase::Cleaning;
            v.code = Some(Code::PendingCleanup);
        });
    }
    fn spawned(&self) {
        if self.effectful.load(Ordering::SeqCst) {
            self.update(|v| {
                v.write_dispatched = true;
                v.write_ack = Ack::Unknown;
            });
        }
    }
}
#[derive(Default)]
struct Registry {
    jobs: HashMap<String, Arc<Job>>,
    cancelled: HashMap<String, (String, Instant)>,
}
#[derive(Default)]
pub(super) struct Requests(Mutex<Registry>);
struct Setup {
    source: Arc<Source>,
    entry: Option<Entry>,
    plan: Option<Arc<Plan>>,
    action: Action,
    target: Option<PluginItem>,
}
pub(super) fn shared() -> &'static Requests {
    static R: OnceLock<Requests> = OnceLock::new();
    R.get_or_init(Default::default)
}
fn validate(agent: &str, id: &str) -> Result<()> {
    if agent.is_empty()
        || agent.len() > 256
        || agent.chars().any(char::is_control)
        || !inventory::requests::valid_id(id)
    {
        Err(Code::InvalidRequest.into())
    } else {
        Ok(())
    }
}
impl Requests {
    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        let mut r = self.0.lock().unwrap_or_else(|p| p.into_inner());
        r.jobs
            .retain(|_, j| !j.snapshot().settled || j.born.elapsed() < TTL);
        r.cancelled.retain(|_, (_, t)| t.elapsed() < TTL);
        r
    }
    pub fn get(&self, agent: &str, id: &str) -> Result<Arc<Job>> {
        validate(agent, id)?;
        self.lock()
            .jobs
            .get(id)
            .filter(|j| j.source.row.id == agent)
            .cloned()
            .ok_or_else(|| Code::UnknownRequest.into())
    }
    fn begin(&self, agent: &str, id: &str, input: Input, setup: Setup) -> Result<(Arc<Job>, bool)> {
        let Setup {
            source,
            entry,
            plan,
            action,
            target,
        } = setup;
        validate(agent, id)?;
        let mut r = self.lock();
        if let Some(j) = r.jobs.get(id) {
            return if j.source.row.id == agent && j.input == input {
                Ok((j.clone(), false))
            } else {
                Err(Code::RequestConflict.into())
            };
        }
        if let Some((owner, _)) = r.cancelled.get(id) {
            return Err(if owner == agent {
                Code::Cancelled
            } else {
                Code::RequestConflict
            }
            .into());
        }
        if r.jobs.len() + r.cancelled.len() >= 64 || r.jobs.values().any(|j| !j.snapshot().settled)
        {
            return Err(Code::Busy.into());
        }
        if let Some(p) = plan.as_ref()
            && matches!(input, Input::Confirm { .. })
        {
            if p.born.elapsed() >= TTL || !p.source.directory.current() {
                return Err(Code::ReviewExpired.into());
            }
            if p.consumed.swap(true, Ordering::SeqCst) {
                return Err(Code::ReviewConsumed.into());
            }
        }
        let public = PluginOperation {
            agent_id: agent.into(),
            request_id: id.into(),
            cwd: source.cwd.clone(),
            action,
            state: State::Running,
            phase: Phase::Queued,
            settled: false,
            code: None,
            write_dispatched: false,
            write_ack: Ack::None,
            outcome: None,
            catalog: None,
            review: None,
            observation: None,
            target,
        };
        let now = Instant::now();
        let job = Arc::new(Job {
            input,
            source,
            entry,
            plan,
            operation: Operation::new(),
            deadline: now + Duration::from_secs(30),
            born: now,
            changed: watch::channel(public).0,
            entries: Mutex::new(None),
            review: Mutex::new(None),
            effectful: AtomicBool::new(false),
        });
        r.jobs.insert(id.into(), job.clone());
        Ok((job, true))
    }
    pub fn inventory(
        &self,
        agent: &str,
        id: &str,
        selection: &str,
        cwd: &str,
    ) -> Result<(Arc<Job>, bool)> {
        validate(agent, id)?;
        if cwd.is_empty() || cwd.len() > 4096 || cwd.chars().any(char::is_control) {
            return Err(Code::CwdUnavailable.into());
        }
        let row = inventory::launch::selections().get(agent, selection, Instant::now())?;
        inventory::launch::admission(&row)?;
        let source = Arc::new(Source {
            row,
            cwd: cwd.into(),
            directory: inventory::launch::Directory::open(cwd)?,
            environment: crate::shell_env::cached_command_env()
                .ok_or(Code::EnvironmentUnavailable)?,
        });
        self.begin(
            agent,
            id,
            Input::Inventory {
                selection: selection.into(),
                cwd: cwd.into(),
            },
            Setup {
                source,
                entry: None,
                plan: None,
                action: Action::Inventory,
                target: None,
            },
        )
    }
    pub fn inspect(
        &self,
        agent: &str,
        id: &str,
        inventory: &str,
        item: usize,
        install: bool,
    ) -> Result<(Arc<Job>, bool)> {
        let original = self.get(agent, inventory)?;
        if original.snapshot().state != State::Ready
            || original.born.elapsed() >= TTL
            || !original.operation.interested()
        {
            return Err(Code::TargetUnavailable.into());
        }
        let entry = original
            .entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .and_then(|v| v.get(item))
            .cloned()
            .ok_or(Code::TargetUnavailable)?;
        entry.admitted(install)?;
        self.begin(
            agent,
            id,
            Input::Inspect {
                inventory: inventory.into(),
                item,
                install,
            },
            Setup {
                source: original.source.clone(),
                entry: Some(entry.clone()),
                plan: None,
                action: Action::Inspect,
                target: Some(entry.item(item)),
            },
        )
    }
    pub fn confirm(&self, agent: &str, id: &str, review: &str) -> Result<(Arc<Job>, bool)> {
        let plan = self
            .lock()
            .jobs
            .values()
            .filter(|j| {
                j.source.row.id == agent
                    && j.snapshot().state == State::Ready
                    && j.operation.interested()
            })
            .find_map(|j| {
                j.review
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_ref()
                    .filter(|p| p.public.review_id == review)
                    .cloned()
            })
            .ok_or(Code::ReviewExpired)?;
        self.begin(
            agent,
            id,
            Input::Confirm {
                review: review.into(),
            },
            Setup {
                source: plan.source.clone(),
                entry: Some(plan.entry.clone()),
                plan: Some(plan.clone()),
                action: if plan.public.install {
                    Action::Install
                } else {
                    Action::Remove
                },
                target: Some(plan.public.target.clone()),
            },
        )
    }
    pub fn recheck(&self, agent: &str, id: &str, operation: &str) -> Result<(Arc<Job>, bool)> {
        let previous = self.get(agent, operation)?;
        let state = previous.snapshot();
        if !state.settled
            || !matches!(
                state.action,
                Action::Install | Action::Remove | Action::Recheck
            )
        {
            return Err(Code::TargetUnavailable.into());
        }
        self.begin(
            agent,
            id,
            Input::Recheck {
                operation: operation.into(),
            },
            Setup {
                source: previous.source.clone(),
                entry: previous.entry.clone(),
                plan: previous.plan.clone(),
                action: Action::Recheck,
                target: state.target,
            },
        )
    }
    pub fn cancel(&self, agent: &str, id: &str) -> Result<Cancellation> {
        validate(agent, id)?;
        let mut r = self.lock();
        if let Some(j) = r.jobs.get(id) {
            if j.source.row.id != agent {
                return Err(Code::RequestConflict.into());
            }
            let snapshot = j.snapshot();
            if !snapshot.settled {
                j.operation.abandon();
                j.update(|v| v.state = State::Cancelling);
            } else if matches!(snapshot.action, Action::Inventory | Action::Inspect) {
                // Closing a completed query/review retires its remaining authority;
                // it does not rewrite the already observed result or rerun anything.
                j.operation.abandon();
            }
            return Ok(Cancellation {
                agent_id: agent.into(),
                request_id: id.into(),
                cancel_requested: !snapshot.settled,
                operation: Some(j.snapshot()),
            });
        }
        if r.jobs.len() + r.cancelled.len() >= 64 {
            return Err(Code::Busy.into());
        }
        if r.cancelled.get(id).is_some_and(|(owner, _)| owner != agent) {
            return Err(Code::RequestConflict.into());
        }
        r.cancelled
            .entry(id.into())
            .or_insert_with(|| (agent.into(), Instant::now()));
        Ok(Cancellation {
            agent_id: agent.into(),
            request_id: id.into(),
            cancel_requested: true,
            operation: None,
        })
    }
}
pub(super) fn review_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Code::Unavailable)?;
    let h: String = bytes.iter().map(|v| format!("{v:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}
