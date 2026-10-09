//! Bounded in-memory ownership for explicit file copies; no persisted operation log.
use crate::file_delivery::{self, CopyOutcome, DeliveryError, DeliveryReceipt, VerifiedFile};
use crate::managed_update::{ActivityPermit, UpdateAdmission, UpdatePermit};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

const RUNNING: u8 = 0;
const CANCELLED: u8 = 1;
const PUBLISHING: u8 = 2;
const FINISHED: u8 = 3;
const CAPACITY: usize = 64;
const READY_LIFETIME: Duration = Duration::from_secs(600);
pub(crate) const EXIT_BLOCKED: &str = "FILE_COPY_EXIT_BLOCKED";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CopyState {
    Ready,
    Copying,
    Cancelling,
    Publishing,
    Completed,
    Cancelled,
    Failed,
    Unknown,
}
impl CopyState {
    fn working(self) -> bool {
        matches!(self, Self::Copying | Self::Cancelling | Self::Publishing)
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyStatus {
    pub operation_id: String,
    pub file: VerifiedFile,
    pub destination: String,
    pub state: CopyState,
    pub settled: bool,
    pub bytes_copied: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<DeliveryReceipt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}
#[derive(Debug, Serialize)]
pub(crate) struct CopyFailure {
    pub code: &'static str,
}
fn failure(code: &'static str) -> CopyFailure {
    CopyFailure { code }
}
fn code(error: DeliveryError) -> &'static str {
    match error {
        DeliveryError::InvalidPath => "invalidPath",
        DeliveryError::OutsideRoot => "outsideRoot",
        DeliveryError::NotFile => "notFile",
        DeliveryError::TooLarge => "tooLarge",
        DeliveryError::Changed => "changed",
        DeliveryError::Unreadable => "unreadable",
        DeliveryError::AlreadyExists => "alreadyExists",
        DeliveryError::InvalidDestination => "invalidDestination",
        DeliveryError::DestinationChanged => "destinationChanged",
        DeliveryError::WriteFailed => "writeFailed",
        _ => "unavailable",
    }
}
struct Job {
    created: Instant,
    phase: AtomicU8,
    status: Mutex<CopyStatus>,
    // Ready reservations also prevent normal exit until cancelled or expired.
    admission: Mutex<Option<ActivityPermit>>,
}
impl Job {
    fn claim_publication(&self) -> bool {
        self.phase
            .compare_exchange(RUNNING, PUBLISHING, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    fn snapshot(&self) -> CopyStatus {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if status.state.working() {
            status.state = match self.phase.load(Ordering::SeqCst) {
                CANCELLED => CopyState::Cancelling,
                PUBLISHING => CopyState::Publishing,
                _ => status.state,
            };
        }
        status
    }
    fn finish(&self, outcome: CopyOutcome) {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match outcome {
            CopyOutcome::Completed(receipt) => {
                status.state = CopyState::Completed;
                status.receipt = Some(receipt);
            }
            CopyOutcome::Cancelled => status.state = CopyState::Cancelled,
            CopyOutcome::Failed(error) => {
                status.state = CopyState::Failed;
                status.code = Some(code(error));
            }
            CopyOutcome::Unknown(error) => {
                status.state = CopyState::Unknown;
                status.code = Some(code(error));
            }
            CopyOutcome::CleanupUnknown => {
                status.state = CopyState::Unknown;
                status.code = Some("cleanupUnknown");
            }
        }
        status.settled = true;
        self.phase.store(FINISHED, Ordering::SeqCst);
        self.admission
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
    }
}
#[derive(Default)]
struct Jobs {
    entries: HashMap<String, Arc<Job>>,
    active: Option<String>,
}
impl Jobs {
    fn expire(&mut self) {
        self.entries.retain(|_, job| {
            !(job.created.elapsed() >= READY_LIFETIME && job.snapshot().state == CopyState::Ready)
        });
    }
}
#[derive(Default)]
pub(crate) struct FileCopyJobs {
    jobs: Arc<Mutex<Jobs>>,
    admission: UpdateAdmission,
}
impl FileCopyJobs {
    pub fn prepare(
        &self,
        file: VerifiedFile,
        destination: String,
    ) -> Result<CopyStatus, CopyFailure> {
        if file.size > file_delivery::MAX_VERIFIED_FILE_BYTES {
            return Err(failure("tooLarge"));
        }
        if destination.len() > 32768
            || file.path.len() > 32768
            || file.root.len() > 32768
            || file.resolved_path.len() > 32768
            || file.name.len() > 32768
            || file.sha256.len() != 64
            || file.version.len() != 64
        {
            return Err(failure("invalidPath"));
        }
        let mut jobs = self.jobs.lock().map_err(|_| failure("unavailable"))?;
        jobs.expire();
        if jobs.entries.len() >= CAPACITY {
            return Err(failure("busy"));
        }
        let admission = self.admission.activity().map_err(|_| failure("busy"))?;
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).map_err(|_| failure("unavailable"))?;
        let operation_id: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        if jobs.entries.contains_key(&operation_id) {
            return Err(failure("unavailable"));
        }
        let status = CopyStatus {
            operation_id: operation_id.clone(),
            total: file.size,
            file,
            destination,
            state: CopyState::Ready,
            settled: false,
            bytes_copied: 0,
            receipt: None,
            code: None,
        };
        jobs.entries.insert(
            operation_id,
            Arc::new(Job {
                created: Instant::now(),
                phase: AtomicU8::new(RUNNING),
                status: Mutex::new(status.clone()),
                admission: Mutex::new(Some(admission)),
            }),
        );
        Ok(status)
    }
    pub fn start(&self, id: &str) -> Result<Option<CopyStatus>, CopyFailure> {
        let mut jobs = self.jobs.lock().map_err(|_| failure("unavailable"))?;
        jobs.expire();
        let Some(job) = jobs.entries.get(id).cloned() else {
            return Ok(None);
        };
        if job.snapshot().state != CopyState::Ready {
            return Ok(Some(job.snapshot()));
        }
        if jobs.active.is_some() {
            return Err(failure("busy"));
        }
        let activity = crate::managed_update::activity().map_err(|_| failure("busy"))?;
        job.status.lock().map_err(|_| failure("unavailable"))?.state = CopyState::Copying;
        jobs.active = Some(id.to_owned());
        let all = self.jobs.clone();
        let worker = job.clone();
        let spawn = std::thread::Builder::new()
            .name("file-copy".into())
            .spawn(move || {
                let original = worker.snapshot();
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    file_delivery::stream_copy(
                        &original.file,
                        Path::new(&original.destination),
                        || worker.phase.load(Ordering::SeqCst) == CANCELLED,
                        || worker.claim_publication(),
                        |total| {
                            worker
                                .status
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .bytes_copied = total
                        },
                    )
                }))
                .unwrap_or(CopyOutcome::Unknown(DeliveryError::Unavailable));
                worker.finish(outcome);
                all.lock().unwrap_or_else(|error| error.into_inner()).active = None;
                drop(activity);
            });
        if spawn.is_err() {
            jobs.active = None;
            job.finish(CopyOutcome::Failed(DeliveryError::Unavailable));
        }
        Ok(Some(job.snapshot()))
    }
    pub fn status(&self, id: &str) -> Result<Option<CopyStatus>, CopyFailure> {
        let mut jobs = self.jobs.lock().map_err(|_| failure("unavailable"))?;
        jobs.expire();
        Ok(jobs.entries.get(id).map(|job| job.snapshot()))
    }
    pub fn cancel(&self, id: &str) -> Result<Option<CopyStatus>, CopyFailure> {
        let mut jobs = self.jobs.lock().map_err(|_| failure("unavailable"))?;
        jobs.expire();
        let Some(job) = jobs.entries.get(id) else {
            return Ok(None);
        };
        if job.snapshot().state == CopyState::Ready {
            job.finish(CopyOutcome::Cancelled);
        } else {
            let _ =
                job.phase
                    .compare_exchange(RUNNING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst);
        }
        Ok(Some(job.snapshot()))
    }
    pub fn release(&self, id: &str) -> Result<bool, CopyFailure> {
        let mut jobs = self.jobs.lock().map_err(|_| failure("unavailable"))?;
        jobs.expire();
        let Some(job) = jobs.entries.get(id) else {
            return Ok(false);
        };
        if job.snapshot().state.working() {
            return Ok(false);
        }
        jobs.entries.remove(id);
        Ok(true)
    }
    /// Held through the final native ExitRequested event. Even a confirmed
    /// Agent interruption cannot admit a new copy after saving was accepted.
    pub fn seal_exit(&self) -> Result<UpdatePermit, String> {
        self.seal_exit_with_confirmation(false)
    }
    pub fn seal_exit_with_confirmation(
        &self,
        confirm_unknown: bool,
    ) -> Result<UpdatePermit, String> {
        let mut jobs = self.jobs.lock().map_err(|_| EXIT_BLOCKED)?;
        jobs.expire();
        let permit = self
            .admission
            .update()
            .map_err(|_| EXIT_BLOCKED.to_owned())?;
        if !confirm_unknown
            && jobs
                .entries
                .values()
                .any(|job| job.snapshot().state == CopyState::Unknown)
        {
            return Err("EXIT_CONFIRMATION_REQUIRED".into());
        }
        Ok(permit)
    }
}

#[cfg(test)]
#[path = "file_copy_jobs_independent_tests.rs"]
mod independent_tests;
#[cfg(test)]
#[path = "file_copy_jobs_tests.rs"]
mod tests;
