//! Archive branch of the existing file job owner. All domain checks precede mutation.
use super::*;
use crate::file_archive::{input, *};
use crate::file_delivery::ArchiveOutcome;

pub(super) struct ArchiveJob {
    pub(super) created: Instant,
    phase: AtomicU8,
    status: Mutex<Status>,
    payload: Mutex<Option<Prepare>>,
    retained_bytes: usize,
    admission: Mutex<Option<ActivityPermit>>,
}
impl ArchiveJob {
    pub(super) fn snapshot(&self) -> Status {
        let mut s = self
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if s.state.working() {
            match self.phase.load(Ordering::SeqCst) {
                CANCELLED => s.state = State::Cancelling,
                PUBLISHING => {
                    s.state = State::Publishing;
                    s.publication = Publication::Unknown;
                }
                _ => (),
            }
        }
        s
    }
    fn claim(&self) -> bool {
        self.phase
            .compare_exchange(RUNNING, PUBLISHING, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    fn finish(&self, outcome: ArchiveOutcome) {
        self.payload
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let mut s = self.status.lock().unwrap_or_else(|e| e.into_inner());
        match outcome {
            ArchiveOutcome::Completed(receipt) => {
                s.state = State::Completed;
                s.publication = Publication::Published;
                s.receipt = Some(receipt);
            }
            ArchiveOutcome::Cancelled => s.state = State::Cancelled,
            ArchiveOutcome::Failed(code, item) => {
                s.state = State::Failed;
                s.code = Some(code);
                s.failed_candidate_id = item;
            }
            ArchiveOutcome::Unknown(code, item) => {
                s.state = State::Unknown;
                s.publication = Publication::Unknown;
                s.code = Some(code);
                s.failed_candidate_id = item;
            }
        }
        s.settled = true;
        self.phase.store(FINISHED, Ordering::SeqCst);
        self.admission
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}
impl Jobs {
    fn archive(&self, key: &Key) -> Result<Option<Arc<ArchiveJob>>, Failure> {
        if let Some(hash) = self.seen.get(&key.operation_id)
            && hash != &key.input_sha256
        {
            return Err(fail("requestConflict"));
        }
        match self.entries.get(&key.operation_id) {
            Some(Entry::Copy(_)) => Err(fail("requestConflict")),
            Some(Entry::Archive(job)) => {
                if job.snapshot().input_sha256 != key.input_sha256 {
                    return Err(fail("requestConflict"));
                }
                Ok(Some(job.clone()))
            }
            None => Ok(None),
        }
    }
    fn absent(&self, key: &Key) -> Reply {
        Reply::absent(
            key,
            self.seen.contains_key(&key.operation_id) || self.seen.len() >= input::ID_CAPACITY,
        )
    }
}
impl FileCopyJobs {
    pub fn archive_prepare(&self, input: Prepare) -> Result<Status, Failure> {
        let bytes = input::validate(&input)?;
        let key = input.key();
        let mut jobs = self.jobs.lock().map_err(|_| fail("unavailable"))?;
        jobs.expire();
        if let Some(job) = jobs.archive(&key)? {
            return Ok(job.snapshot());
        }
        if jobs.seen.contains_key(&key.operation_id) {
            return Err(fail("requestRetired"));
        }
        if jobs.seen.len() >= input::ID_CAPACITY {
            return Err(fail("requestCapacity"));
        }
        let retained: usize = jobs
            .entries
            .values()
            .map(|j| match j {
                Entry::Archive(a) if !a.snapshot().settled => a.retained_bytes,
                _ => 0,
            })
            .sum();
        if jobs.entries.len() >= CAPACITY || retained.saturating_add(bytes) > input::PAYLOAD_BYTES {
            return Err(fail("busy"));
        }
        let admission = self.admission.activity().map_err(|_| fail("busy"))?;
        let status = Status::ready(&input);
        let job = Arc::new(ArchiveJob {
            created: Instant::now(),
            phase: AtomicU8::new(RUNNING),
            status: Mutex::new(status.clone()),
            payload: Mutex::new(Some(input)),
            retained_bytes: bytes,
            admission: Mutex::new(Some(admission)),
        });
        jobs.seen.insert(key.operation_id.clone(), key.input_sha256);
        jobs.entries.insert(key.operation_id, Entry::Archive(job));
        Ok(status)
    }
    pub fn archive_start(&self, key: &Key) -> Result<Reply, Failure> {
        self.archive_start_with(key, |input, job| {
            file_delivery::stream_archive(
                input,
                || job.phase.load(Ordering::SeqCst) == CANCELLED,
                || job.claim(),
                |bytes, items| {
                    let mut s = job.status.lock().unwrap_or_else(|e| e.into_inner());
                    s.processed_input_bytes = bytes;
                    s.items_completed = items;
                },
            )
        })
    }
    fn archive_start_with<F>(&self, key: &Key, run: F) -> Result<Reply, Failure>
    where
        F: FnOnce(&Prepare, &ArchiveJob) -> ArchiveOutcome + Send + 'static,
    {
        input::check_key(key)?;
        let mut jobs = self.jobs.lock().map_err(|_| fail("unavailable"))?;
        jobs.expire();
        let Some(job) = jobs.archive(key)? else {
            return Ok(jobs.absent(key));
        };
        if job.snapshot().state != State::Ready {
            return Ok(Reply::Status(Box::new(job.snapshot())));
        }
        if jobs.active.is_some() {
            return Err(fail("busy"));
        }
        let activity = crate::managed_update::activity().map_err(|_| fail("busy"))?;
        let payload = job
            .payload
            .lock()
            .map_err(|_| fail("unavailable"))?
            .take()
            .ok_or(fail("unavailable"))?;
        job.status.lock().map_err(|_| fail("unavailable"))?.state = State::Writing;
        jobs.active = Some(key.operation_id.clone());
        let all = self.jobs.clone();
        let worker = job.clone();
        let id = key.operation_id.clone();
        let spawned = std::thread::Builder::new()
            .name("conversation-archive".into())
            .spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run(&payload, &worker)
                }))
                .unwrap_or(ArchiveOutcome::Unknown("unavailable", None));
                drop(payload);
                // No source or destination handles remain; release actual work ownership
                // under the same registry lock before exposing terminal status.
                let mut jobs = all.lock().unwrap_or_else(|e| e.into_inner());
                if jobs.active.as_deref() == Some(&id) {
                    jobs.active = None;
                }
                drop(activity);
                worker.finish(outcome);
            });
        if spawned.is_err() {
            jobs.active = None;
            job.finish(ArchiveOutcome::Failed("unavailable", None));
        }
        Ok(Reply::Status(Box::new(job.snapshot())))
    }
    pub fn archive_status(&self, key: &Key) -> Result<Reply, Failure> {
        input::check_key(key)?;
        let mut jobs = self.jobs.lock().map_err(|_| fail("unavailable"))?;
        jobs.expire();
        Ok(match jobs.archive(key)? {
            Some(job) => Reply::Status(Box::new(job.snapshot())),
            None => jobs.absent(key),
        })
    }
    pub fn archive_cancel(&self, key: &Key) -> Result<Reply, Failure> {
        input::check_key(key)?;
        let mut jobs = self.jobs.lock().map_err(|_| fail("unavailable"))?;
        jobs.expire();
        let Some(job) = jobs.archive(key)? else {
            if jobs.seen.len() < input::ID_CAPACITY {
                jobs.seen
                    .insert(key.operation_id.clone(), key.input_sha256.clone());
            }
            return Ok(jobs.absent(key));
        };
        if job.snapshot().state == State::Ready {
            job.finish(ArchiveOutcome::Cancelled);
        } else {
            let _ =
                job.phase
                    .compare_exchange(RUNNING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst);
        }
        Ok(Reply::Status(Box::new(job.snapshot())))
    }
    pub fn archive_release(&self, key: &Key) -> Result<bool, Failure> {
        input::check_key(key)?;
        let mut jobs = self.jobs.lock().map_err(|_| fail("unavailable"))?;
        jobs.expire();
        let Some(job) = jobs.archive(key)? else {
            return Ok(false);
        };
        if !job.snapshot().settled {
            return Ok(false);
        }
        jobs.entries.remove(&key.operation_id);
        Ok(true)
    }
}

#[cfg(test)]
#[path = "../file_archive_jobs_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../file_archive_independent_tests.rs"]
mod independent_tests;
