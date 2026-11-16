use super::*;

fn fixture() -> (tempfile::TempDir, VerifiedFile, String) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.txt");
    std::fs::write(&path, b"exact bytes\r\n").unwrap();
    let file = file_delivery::inspect(directory.path(), &path).unwrap();
    let destination = directory
        .path()
        .join("result.txt")
        .to_str()
        .unwrap()
        .to_owned();
    (directory, file, destination)
}
fn settled(jobs: &FileCopyJobs, id: &str) -> CopyStatus {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let state = jobs.status(id).unwrap().unwrap();
        if !state.state.working() {
            return state;
        }
        assert!(Instant::now() < deadline, "copy worker did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn prepare_has_no_filesystem_effect_and_cancelled_or_unknown_ids_never_start() {
    let (_directory, file, destination) = fixture();
    let jobs = FileCopyJobs::default();
    let ready = jobs.prepare(file, destination.clone()).unwrap();
    assert!(!Path::new(&destination).exists());
    assert_eq!(jobs.seal_exit().unwrap_err(), EXIT_BLOCKED);
    let cancelled = jobs.cancel(&ready.operation_id).unwrap().unwrap();
    assert_eq!(cancelled.state, CopyState::Cancelled);
    assert_eq!(
        jobs.start(&ready.operation_id).unwrap().unwrap().state,
        CopyState::Cancelled
    );
    assert!(jobs.start("unknown").unwrap().is_none());
    assert!(jobs.release(&ready.operation_id).unwrap());
    assert!(jobs.start(&ready.operation_id).unwrap().is_none());
    assert!(!Path::new(&destination).exists());
}

#[test]
fn completed_receipt_is_retained_and_duplicate_start_does_not_rewrite() {
    let (_directory, file, destination) = fixture();
    let jobs = FileCopyJobs::default();
    let ready = jobs.prepare(file.clone(), destination.clone()).unwrap();
    jobs.start(&ready.operation_id).unwrap();
    let result = settled(&jobs, &ready.operation_id);
    assert_eq!(result.state, CopyState::Completed);
    let receipt = result.receipt.unwrap();
    assert_eq!((receipt.size, receipt.sha256), (file.size, file.sha256));
    assert_eq!(std::fs::read(&destination).unwrap(), b"exact bytes\r\n");
    std::fs::write(&destination, "external change after completion").unwrap();
    assert_eq!(
        jobs.start(&ready.operation_id).unwrap().unwrap().state,
        CopyState::Completed
    );
    assert_eq!(
        std::fs::read_to_string(&destination).unwrap(),
        "external change after completion"
    );
    assert_eq!(
        jobs.cancel(&ready.operation_id).unwrap().unwrap().state,
        CopyState::Completed
    );
}

#[test]
fn exit_seal_is_independent_of_other_activity_and_blocks_new_reservations() {
    let (_directory, file, destination) = fixture();
    let jobs = FileCopyJobs::default();
    let seal = jobs.seal_exit().unwrap();
    assert_eq!(
        jobs.prepare(file.clone(), destination.clone())
            .unwrap_err()
            .code,
        "busy"
    );
    drop(seal);
    let ready = jobs.prepare(file, destination).unwrap();
    assert!(jobs.seal_exit().is_err());
    jobs.cancel(&ready.operation_id).unwrap();
    assert!(jobs.seal_exit().is_ok());
}

#[test]
fn busy_start_settles_only_the_unstarted_copy() {
    let (directory, file, first_destination) = fixture();
    let jobs = FileCopyJobs::default();
    let first = jobs.prepare(file.clone(), first_destination).unwrap();
    let first_worker = {
        let mut registry = jobs.jobs.lock().unwrap();
        let worker = registry.entries[&first.operation_id].as_copy().unwrap();
        worker.status.lock().unwrap().state = CopyState::Copying;
        registry.active = Some(first.operation_id.clone());
        worker
    };
    let second_destination = directory.path().join("second.txt");
    let second = jobs
        .prepare(file.clone(), second_destination.to_str().unwrap().into())
        .unwrap();
    let rejected = jobs.start(&second.operation_id).unwrap().unwrap();
    let reply = serde_json::to_value(&rejected).unwrap();
    assert_eq!(reply["operationId"], second.operation_id);
    assert_eq!(reply["file"], serde_json::to_value(&file).unwrap());
    assert_eq!(reply["destination"], second.destination);
    assert_eq!(reply["state"], "failed");
    assert_eq!(reply["code"], "busy");
    assert_eq!(reply["settled"], true);
    assert_eq!(reply["bytesCopied"], 0);
    assert!(reply.get("receipt").is_none());
    assert_eq!(first_worker.snapshot().state, CopyState::Copying);
    assert_eq!(
        jobs.jobs.lock().unwrap().active.as_deref(),
        Some(first.operation_id.as_str())
    );
    assert_eq!(jobs.seal_exit().unwrap_err(), EXIT_BLOCKED);

    first_worker.finish(CopyOutcome::Cancelled);
    jobs.jobs.lock().unwrap().active = None;
    assert!(
        jobs.seal_exit().is_ok(),
        "refused copy still owns admission"
    );
    for observed in [
        jobs.status(&second.operation_id).unwrap().unwrap(),
        jobs.start(&second.operation_id).unwrap().unwrap(),
    ] {
        assert_eq!(serde_json::to_value(observed).unwrap(), reply);
    }
    assert!(jobs.release(&second.operation_id).unwrap());
    assert!(!second_destination.exists());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    assert_eq!(
        std::fs::read(&file.resolved_path).unwrap(),
        b"exact bytes\r\n"
    );
}

#[test]
fn capacity_is_bounded_and_release_removes_only_in_memory_reservation() {
    let (_directory, file, destination) = fixture();
    let jobs = FileCopyJobs::default();
    let mut ids = Vec::new();
    for _ in 0..CAPACITY {
        ids.push(
            jobs.prepare(file.clone(), destination.clone())
                .unwrap()
                .operation_id,
        );
    }
    assert_eq!(
        jobs.prepare(file.clone(), destination.clone())
            .unwrap_err()
            .code,
        "busy"
    );
    assert!(jobs.release(&ids[0]).unwrap());
    assert!(jobs.prepare(file, destination.clone()).is_ok());
    assert!(!Path::new(&destination).exists());
}

#[test]
fn real_cancel_and_publication_gate_have_one_winner() {
    let (_directory, file, destination) = fixture();
    let jobs = FileCopyJobs::default();
    let first = jobs.prepare(file.clone(), destination.clone()).unwrap();
    let job = jobs.jobs.lock().unwrap().entries[&first.operation_id]
        .as_copy()
        .unwrap();
    job.status.lock().unwrap().state = CopyState::Copying;
    assert_eq!(
        jobs.cancel(&first.operation_id).unwrap().unwrap().state,
        CopyState::Cancelling
    );
    assert!(!job.claim_publication());
    assert!(!jobs.cancel(&first.operation_id).unwrap().unwrap().settled);
    assert_eq!(
        jobs.seal_exit_with_confirmation(true).unwrap_err(),
        EXIT_BLOCKED
    );
    job.finish(CopyOutcome::Cancelled);
    let second = jobs.prepare(file, destination).unwrap();
    let job = jobs.jobs.lock().unwrap().entries[&second.operation_id]
        .as_copy()
        .unwrap();
    job.status.lock().unwrap().state = CopyState::Copying;
    assert!(job.claim_publication());
    assert_eq!(
        jobs.cancel(&second.operation_id).unwrap().unwrap().state,
        CopyState::Publishing
    );
    assert_eq!(job.phase.load(Ordering::SeqCst), PUBLISHING);
    assert_eq!(
        jobs.seal_exit_with_confirmation(true).unwrap_err(),
        EXIT_BLOCKED
    );
}

#[test]
fn finished_unknown_requires_explicit_review_and_does_not_claim_success() {
    let (_directory, file, destination) = fixture();
    let jobs = FileCopyJobs::default();
    let ready = jobs.prepare(file, destination).unwrap();
    let job = jobs.jobs.lock().unwrap().entries[&ready.operation_id]
        .as_copy()
        .unwrap();
    job.finish(CopyOutcome::CleanupUnknown);
    let status = jobs.status(&ready.operation_id).unwrap().unwrap();
    assert_eq!(status.state, CopyState::Unknown);
    assert!(status.settled && status.receipt.is_none());
    assert_eq!(jobs.seal_exit().unwrap_err(), "EXIT_CONFIRMATION_REQUIRED");
    assert!(jobs.seal_exit_with_confirmation(true).is_ok());
    assert!(jobs.release(&ready.operation_id).unwrap());
    assert!(jobs.seal_exit().is_ok());
}

#[test]
fn p17_wire_contract_copy_statuses() {
    let (_directory, file, destination) = fixture();
    let jobs = FileCopyJobs::default();
    let ready = jobs.prepare(file, destination).unwrap();
    jobs.start(&ready.operation_id).unwrap();
    let completed = settled(&jobs, &ready.operation_id);
    assert_eq!(completed.state, CopyState::Completed);
    println!(
        "P17_COPY_CONTRACT={}",
        serde_json::to_string(&[ready, completed]).unwrap()
    );
}
