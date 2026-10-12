//! Volatile request ownership. No transcript or request state is persisted.
use super::{source::Source, types::*};
use crate::acp_client::{extension_inventory as inventory, operations::Operation};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::watch;
const DETAILS: usize = 32;
const USED: usize = 4096;
const RETAIN: Duration = Duration::from_secs(300);
pub(super) struct Job {
    pub request: Request,
    pub source: Source,
    pub operation: Operation,
    pub deadline: Instant,
    pub changed: watch::Sender<SearchOperation>,
    value: Mutex<SearchOperation>,
    finished: Mutex<Option<Instant>>,
}
impl Job {
    fn new(request: Request, source: Source) -> Self {
        let row_ids: Vec<_> = source.rows.iter().map(|r| r.id.clone()).collect();
        let value = SearchOperation {
            agent_id: request.agent_id.clone(),
            request_id: request.request_id.clone(),
            selection_id: request.selection_id.clone(),
            query: request.query.clone(),
            row_ids: row_ids.clone(),
            revision: 0,
            state: State::Running,
            settled: false,
            code: None,
            source: source.route.source(),
            sdk_scope: source.route.scope(),
            scope: "userAndAssistantText",
            match_mode: "unicodeLowercaseLiteral",
            exclusions: [
                "attachments",
                "toolOutput",
                "reasoning",
                "otherMessageKinds",
            ],
            rows: row_ids
                .into_iter()
                .map(|row_id| Row {
                    row_id,
                    state: RowState::Queued,
                    pages_read: 0,
                    text_blocks_read: 0,
                    matched_text_blocks: 0,
                    code: None,
                })
                .collect(),
            hits: vec![],
        };
        Self {
            request,
            source,
            operation: Operation::new(),
            deadline: Instant::now() + Duration::from_secs(60),
            changed: watch::channel(value.clone()).0,
            value: Mutex::new(value),
            finished: Mutex::new(None),
        }
    }
    pub fn snapshot(&self) -> SearchOperation {
        self.value.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    pub fn update(&self, change: impl FnOnce(&mut SearchOperation)) {
        let mut value = self.value.lock().unwrap_or_else(|p| p.into_inner());
        if value.settled {
            return;
        }
        change(&mut value);
        value.revision += 1;
        self.changed.send_replace(value.clone());
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
    pub fn cancel(&self) {
        self.update(|value| {
            self.operation.abandon();
            if value.state != State::PendingCleanup {
                value.state = State::Cancelling;
                value.code = Some(Code::Cancelled);
            }
        });
    }
    pub fn row_failed(&self, index: usize, code: Code) {
        self.update(|value| {
            let row = &mut value.rows[index];
            row.state = if row.pages_read > 0 {
                RowState::Partial
            } else {
                RowState::Failed
            };
            row.code = Some(code);
        });
    }
    pub fn finish(&self, error: Option<Code>) {
        self.update(|value| {
            let error = error.or_else(|| (!self.operation.interested()).then_some(Code::Cancelled));
            value.state = match error {
                Some(Code::Cancelled) => State::Cancelled,
                Some(_) => State::Failed,
                None => State::Completed,
            };
            value.code = error;
            value.settled = true;
            for row in &mut value.rows {
                if matches!(row.state, RowState::Queued | RowState::Reading) {
                    row.state = if row.pages_read > 0 {
                        RowState::Partial
                    } else {
                        RowState::Skipped
                    };
                    row.code = Some(error.unwrap_or(Code::QueryFailed));
                }
            }
            *self.finished.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        });
    }
}
impl inventory::process::Control for Job {
    fn interested(&self) -> bool {
        self.operation.interested()
    }
    fn deadline(&self) -> Instant {
        self.deadline
    }
    fn pending_cleanup(&self) {
        self.update(|v| {
            v.state = State::PendingCleanup;
            v.code = Some(Code::PendingCleanup);
        });
    }
}
struct Entry {
    agent: String,
    job: Option<Arc<Job>>,
}
#[derive(Default)]
pub(super) struct Requests(Mutex<HashMap<String, Entry>>);
pub(super) fn shared() -> &'static Requests {
    static VALUE: OnceLock<Requests> = OnceLock::new();
    VALUE.get_or_init(Default::default)
}
impl Requests {
    fn prune(entries: &mut HashMap<String, Entry>) {
        for entry in entries.values_mut() {
            let expired = entry.job.as_ref().is_some_and(|job| {
                job.finished
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .is_some_and(|t| t.elapsed() >= RETAIN)
            });
            if expired {
                entry.job = None;
            }
        }
    }
    pub fn begin(
        &self,
        request: Request,
        source: impl FnOnce() -> Result<Source>,
    ) -> Result<(Arc<Job>, bool)> {
        let mut entries = self.0.lock().unwrap_or_else(|p| p.into_inner());
        Self::prune(&mut entries);
        if let Some(entry) = entries.get(&request.request_id) {
            if entry.agent != request.agent_id {
                return Err(Code::RequestConflict.into());
            }
            return match &entry.job {
                Some(job) if job.request == request => Ok((job.clone(), false)),
                _ => Err(Code::RequestConflict.into()),
            };
        }
        if !uuid(&request.request_id)
            || !uuid(&request.selection_id)
            || !identifier(&request.agent_id)
            || request.query.len() > 256
            || request.query.trim().is_empty()
            || request.query.chars().any(char::is_control)
        {
            return Err(Code::InvalidRequest.into());
        }
        if entries.len() >= USED || entries.values().filter(|e| e.job.is_some()).count() >= DETAILS
        {
            return Err(Code::RequestCapacity.into());
        }
        let source = source()?;
        let job = Arc::new(Job::new(request, source));
        entries.insert(
            job.request.request_id.clone(),
            Entry {
                agent: job.request.agent_id.clone(),
                job: Some(job.clone()),
            },
        );
        Ok((job, true))
    }
    fn identity(agent: &str, id: &str) -> Result<()> {
        if !identifier(agent) || !uuid(id) {
            Err(Code::InvalidRequest.into())
        } else {
            Ok(())
        }
    }
    pub fn reply(&self, agent: &str, id: &str, cancel: bool) -> Result<Reply> {
        Self::identity(agent, id)?;
        let mut entries = self.0.lock().unwrap_or_else(|p| p.into_inner());
        Self::prune(&mut entries);
        if let Some(entry) = entries.get(id) {
            if entry.agent != agent {
                return Err(Code::RequestConflict.into());
            }
            if let Some(job) = &entry.job {
                if cancel {
                    job.cancel();
                }
                return Ok(Reply::Operation {
                    operation: Box::new(job.snapshot()),
                });
            }
            return Ok(Reply::Absent {
                agent_id: agent.into(),
                request_id: id.into(),
                scope: "currentProcess",
                admission_closed: true,
            });
        }
        let capacity = entries.len() >= USED;
        if cancel && !capacity {
            entries.insert(
                id.into(),
                Entry {
                    agent: agent.into(),
                    job: None,
                },
            );
        }
        Ok(Reply::Absent {
            agent_id: agent.into(),
            request_id: id.into(),
            scope: "currentProcess",
            admission_closed: cancel || capacity,
        })
    }
    pub fn release(&self, agent: &str, id: &str) -> Result<bool> {
        Self::identity(agent, id)?;
        let mut entries = self.0.lock().unwrap_or_else(|p| p.into_inner());
        Self::prune(&mut entries);
        let Some(entry) = entries.get_mut(id) else {
            return Ok(false);
        };
        if entry.agent != agent {
            return Err(Code::RequestConflict.into());
        }
        if !entry.job.as_ref().is_some_and(|j| j.snapshot().settled) {
            return Ok(false);
        }
        entry.job = None;
        Ok(true)
    }
}
