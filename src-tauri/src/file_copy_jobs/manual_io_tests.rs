//! Explicit real-OS exercise; no worker hooks, private job edits or artificial IO delays.
use super::{CopyState, CopyStatus, FileCopyJobs};
use crate::file_delivery;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{Duration, Instant},
};

const DEADLINE: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq, Eq)]
enum Observation {
    PartialWrite,
    CompletedBeforeObservation,
    Unexpected,
}

fn classify_observation(state: CopyState, settled: bool, bytes: u64, total: u64) -> Observation {
    if state == CopyState::Completed && settled && bytes == total {
        Observation::CompletedBeforeObservation
    } else if state == CopyState::Copying && !settled && bytes > 0 && bytes < total {
        Observation::PartialWrite
    } else {
        Observation::Unexpected
    }
}

#[test]
fn manual_observation_classifier_never_calls_failure_a_missed_window() {
    for state in [CopyState::Failed, CopyState::Unknown, CopyState::Cancelled] {
        assert_eq!(
            classify_observation(state, true, 0, 1024),
            Observation::Unexpected
        );
    }
    assert_eq!(
        classify_observation(CopyState::Completed, true, 1024, 1024),
        Observation::CompletedBeforeObservation
    );
    assert_eq!(
        classify_observation(CopyState::Copying, false, 64, 1024),
        Observation::PartialWrite
    );
    for state in [
        CopyState::Ready,
        CopyState::Cancelling,
        CopyState::Publishing,
        CopyState::Failed,
        CopyState::Unknown,
        CopyState::Cancelled,
    ] {
        assert_eq!(
            classify_observation(state, false, 64, 1024),
            Observation::Unexpected
        );
    }
    assert_eq!(
        classify_observation(CopyState::Copying, false, 0, 1024),
        Observation::Unexpected
    );
    assert_eq!(
        classify_observation(CopyState::Completed, false, 1024, 1024),
        Observation::Unexpected
    );
    assert_eq!(
        classify_observation(CopyState::Completed, true, 64, 1024),
        Observation::Unexpected
    );
}

fn record(stage: &str, value: serde_json::Value) {
    println!("MANUAL_COPY_IO={}", json!({"stage": stage, "value": value}));
}

fn status(jobs: &FileCopyJobs, id: &str) -> Result<CopyStatus, String> {
    jobs.status(id)
        .map_err(|e| format!("status: {}", e.code))?
        .ok_or_else(|| "operation disappeared".into())
}

fn observe(jobs: &FileCopyJobs, id: &str, partial: bool) -> Result<CopyStatus, String> {
    let start = Instant::now();
    loop {
        let value = status(jobs, id)?;
        if value.settled || (partial && value.bytes_copied > 0 && value.bytes_copied < value.total)
        {
            record(
                if partial {
                    "partialObservation"
                } else {
                    "settled"
                },
                json!({"elapsedMs": start.elapsed().as_millis(), "status": value}),
            );
            return Ok(value);
        }
        if start.elapsed() >= DEADLINE {
            record("deadlineUnknown", json!({"status": value}));
            return Err("manual observation deadline; owned files retained, no retry".into());
        }
        // Yield only this observer. The production writer receives no hook or delay.
        std::thread::yield_now();
    }
}

fn await_worker_release(jobs: &FileCopyJobs) -> Result<(), String> {
    let start = Instant::now();
    loop {
        // A settled status is published just before the real worker releases its
        // global activity permit. Observe that production gate before a new job.
        if let Ok(permit) = crate::managed_update::quiet_exit() {
            let local = jobs.seal_exit()?;
            drop(local);
            drop(permit);
            return Ok(());
        }
        if start.elapsed() >= DEADLINE {
            return Err("worker activity did not release; owned files retained".into());
        }
        std::thread::yield_now();
    }
}

fn names(directory: &Path) -> Result<Vec<String>, String> {
    let mut names = fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    Ok(names)
}

#[test]
#[ignore = "manual 256 MiB real background IO and asynchronous cancellation; not routine fixtures"]
fn manual_real_worker_cancel_after_partial_write_then_complete_new_operation() -> Result<(), String>
{
    let started = Instant::now();
    // Keep ownership explicit on failure/unknown: never let TempDir remove files
    // while a worker might still be writing. Successful cleanup is checked below.
    let directory = tempfile::Builder::new()
        .prefix("farfold-manual-copy-io-")
        .tempdir()
        .map_err(|e| e.to_string())?
        .keep();
    record("ownedDirectory", json!({"path": directory}));
    let source = directory.join("source.bin");
    let destination = directory.join("result.bin");
    let mut writer = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&source)
        .map_err(|e| e.to_string())?;
    let mut chunk = [0u8; 64 * 1024];
    let mut seed = 0x4f17_2026_u32;
    for byte in &mut chunk {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        *byte = seed as u8;
    }
    let size = 256 * 1024 * 1024;
    assert_eq!(size, file_delivery::MAX_VERIFIED_FILE_BYTES);
    let mut expected = Sha256::new();
    for _ in 0..size / chunk.len() as u64 {
        writer.write_all(&chunk).map_err(|e| e.to_string())?;
        expected.update(chunk);
    }
    writer.sync_all().map_err(|e| e.to_string())?;
    drop(writer);
    let expected_sha: String = expected
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let file = file_delivery::inspect(&directory, &source).map_err(|e| format!("{e:?}"))?;
    assert_eq!(file.sha256, expected_sha);
    assert_eq!(file.size, size);
    record(
        "sourceBefore",
        json!({"file": file, "peakFileBytesBound": size * 2}),
    );

    let jobs = FileCopyJobs::default();
    let ready = jobs
        .prepare(file.clone(), destination.to_string_lossy().into_owned())
        .map_err(|e| e.code.to_owned())?;
    let first = &ready.operation_id;
    record(
        "start",
        json!(jobs.start(first).map_err(|e| e.code.to_owned())?),
    );
    let observed = observe(&jobs, first, true)?;
    match classify_observation(
        observed.state,
        observed.settled,
        observed.bytes_copied,
        size,
    ) {
        Observation::PartialWrite => {}
        Observation::CompletedBeforeObservation => {
            await_worker_release(&jobs)?;
            record(
                "conditionUnavailable",
                json!({"noRetry": true, "status": observed}),
            );
            return Err("MANUAL_CONDITION_UNAVAILABLE: copy completed before partial-write observation; not a product failure".into());
        }
        Observation::Unexpected => {
            record(
                "unexpectedObservation",
                json!({"noRetry": true, "status": observed}),
            );
            return Err(format!(
                "unexpected initial copy state {:?}, settled={}, code={:?}; owned files retained",
                observed.state, observed.settled, observed.code
            ));
        }
    }
    let cancellation = jobs.cancel(first).map_err(|e| e.code.to_owned())?;
    record("cancelRequestedOnce", json!(cancellation));
    let cancelled = observe(&jobs, first, false)?;
    await_worker_release(&jobs)?;
    if cancelled.state == CopyState::Completed {
        record(
            "conditionUnavailable",
            json!({"noRetry": true, "status": cancelled}),
        );
        return Err("MANUAL_CONDITION_UNAVAILABLE: publication won after observation; not a product failure".into());
    }
    assert_eq!(cancelled.state, CopyState::Cancelled);
    assert!(cancelled.settled && cancelled.receipt.is_none());
    if cancelled.bytes_copied == size {
        return Err("MANUAL_CONDITION_UNAVAILABLE: all bytes written before cancellation; no write-in-flight success claimed".into());
    }
    assert!(cancelled.bytes_copied >= observed.bytes_copied && cancelled.bytes_copied < size);
    assert!(!destination.exists());
    assert_eq!(names(&directory)?, vec!["source.bin"]);
    let after = file_delivery::inspect(&directory, &source).map_err(|e| format!("{e:?}"))?;
    assert_eq!(after, file);
    record(
        "cancelledAndClean",
        json!({"source": after, "entries": names(&directory)?, "targetAbsent": true}),
    );
    assert!(jobs.release(first).map_err(|e| e.code.to_owned())?);

    // This is an explicit NEW operation after proven cancellation and cleanup;
    // it is not an automatic retry of an unknown or failed write.
    let retry = jobs
        .prepare(file.clone(), destination.to_string_lossy().into_owned())
        .map_err(|e| e.code.to_owned())?;
    assert_ne!(retry.operation_id, *first);
    record(
        "newOperationStart",
        json!(
            jobs.start(&retry.operation_id)
                .map_err(|e| e.code.to_owned())?
        ),
    );
    let done = observe(&jobs, &retry.operation_id, false)?;
    await_worker_release(&jobs)?;
    assert_eq!(done.state, CopyState::Completed);
    assert_eq!(done.bytes_copied, size);
    let receipt = done.receipt.as_ref().expect("completed receipt");
    assert_eq!(receipt.sha256, expected_sha);
    assert_eq!(receipt.size, size);
    let copied = file_delivery::inspect(&directory, &destination).map_err(|e| format!("{e:?}"))?;
    assert_eq!(copied.sha256, expected_sha);
    assert_eq!(copied.size, size);
    assert_eq!(names(&directory)?, vec!["result.bin", "source.bin"]);
    let late = jobs
        .cancel(&retry.operation_id)
        .map_err(|e| e.code.to_owned())?
        .expect("retained operation");
    assert_eq!(
        serde_json::to_value(&late).unwrap(),
        serde_json::to_value(&done).unwrap()
    );
    assert_eq!(
        file_delivery::inspect(&directory, &source).map_err(|e| format!("{e:?}"))?,
        file
    );
    record(
        "newCompletedAndLateCancelUnchanged",
        json!({"status": late, "target": copied, "sourceSha256": expected_sha, "entries": names(&directory)?}),
    );
    assert!(
        jobs.release(&retry.operation_id)
            .map_err(|e| e.code.to_owned())?
    );
    fs::remove_dir_all(&directory).map_err(|e| e.to_string())?;
    assert!(!directory.exists());
    record(
        "passed",
        json!({"elapsedMs": started.elapsed().as_millis(), "ownedDirectoryRemoved": true, "actualBackgroundWriteCancellation": true, "formalUiCancellation": false}),
    );
    Ok(())
}
