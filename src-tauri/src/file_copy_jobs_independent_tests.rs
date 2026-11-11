//! Independent copy ownership challenges using only private temporary fixtures.
use super::*;
use std::io::{Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicU64};

fn fixture() -> (tempfile::TempDir, VerifiedFile, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.txt");
    std::fs::write(&source, vec![b'a'; 192 * 1024]).unwrap();
    let file = file_delivery::inspect(directory.path(), &source).unwrap();
    let destination = directory.path().join("result.txt");
    (directory, file, destination)
}

fn names(directory: &Path) -> Vec<String> {
    let mut values: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    values.sort();
    values
}

#[cfg(unix)]
fn settled(jobs: &FileCopyJobs, id: &str) -> CopyStatus {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = jobs.status(id).unwrap().unwrap();
        if !status.state.working() {
            return status;
        }
        assert!(Instant::now() < deadline, "independent copy did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(unix)]
#[test]
fn independent_completed_copy_retains_the_explicit_destination_identity() {
    let (directory, file, _) = fixture();
    let actual_parent = directory.path().join("actual-parent");
    let selected_parent = directory.path().join("selected-parent");
    std::fs::create_dir(&actual_parent).unwrap();
    std::os::unix::fs::symlink(&actual_parent, &selected_parent).unwrap();
    let destination = selected_parent
        .join("result.txt")
        .to_str()
        .unwrap()
        .to_owned();
    let jobs = FileCopyJobs::default();
    let ready = jobs.prepare(file.clone(), destination.clone()).unwrap();
    jobs.start(&ready.operation_id).unwrap();
    let done = settled(&jobs, &ready.operation_id);
    assert_eq!(done.state, CopyState::Completed);
    assert_eq!(std::fs::read(&destination).unwrap().len() as u64, file.size);
    assert_eq!(done.destination, destination);
    // This is the exact destination equality required by parseCopyStatus.
    let receipt = done.receipt.unwrap();
    assert_eq!(receipt.destination, done.destination);
    let saved = receipt.destination_file.unwrap();
    assert_eq!(saved.path, done.destination);
    assert_eq!(
        saved.root,
        actual_parent.canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(
        saved,
        file_delivery::inspect(&actual_parent, Path::new(&destination)).unwrap()
    );
    assert_eq!(
        file_delivery::revalidate_for_open(&saved).unwrap(),
        saved.resolved_path
    );
    std::fs::remove_file(&selected_parent).unwrap();
    std::os::unix::fs::symlink(directory.path(), &selected_parent).unwrap();
    assert!(file_delivery::revalidate_for_open(&saved).is_err());
}

#[test]
fn independent_cancel_before_io_creates_no_private_or_final_file() {
    let (directory, file, destination) = fixture();
    let before = names(directory.path());
    let result = file_delivery::stream_copy(
        &file,
        &destination,
        || true,
        || panic!("cancelled copy must not claim publication"),
        |_| panic!("cancelled copy must not report written bytes"),
    );
    assert!(matches!(result, CopyOutcome::Cancelled));
    assert_eq!(names(directory.path()), before);
}

#[test]
fn independent_cancel_after_final_chunk_wins_before_publication() {
    let (directory, file, destination) = fixture();
    let before = names(directory.path());
    let cancelled = AtomicBool::new(false);
    let claimed = AtomicBool::new(false);
    let result = file_delivery::stream_copy(
        &file,
        &destination,
        || cancelled.load(Ordering::SeqCst),
        || {
            claimed.store(true, Ordering::SeqCst);
            !cancelled.load(Ordering::SeqCst)
        },
        |total| {
            if total == file.size {
                cancelled.store(true, Ordering::SeqCst);
            }
        },
    );
    assert!(claimed.load(Ordering::SeqCst));
    assert!(matches!(result, CopyOutcome::Cancelled));
    assert_eq!(names(directory.path()), before);
    assert!(!destination.exists());
}

#[test]
fn independent_publication_winner_is_not_reported_cancelled_afterwards() {
    let (directory, file, destination) = fixture();
    let cancelled = AtomicBool::new(false);
    let result = file_delivery::stream_copy(
        &file,
        &destination,
        || cancelled.load(Ordering::SeqCst),
        || {
            // Model cancellation arriving after the publication CAS won.
            cancelled.store(true, Ordering::SeqCst);
            true
        },
        |_| {},
    );
    let CopyOutcome::Completed(receipt) = result else {
        panic!("publication winner must report the completed receipt");
    };
    assert_eq!(receipt.sha256, file.sha256);
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        std::fs::read(&file.path).unwrap()
    );
    assert_eq!(names(directory.path()), vec!["result.txt", "source.txt"]);
}

#[test]
fn independent_destination_created_at_publication_is_preserved_exactly() {
    let (directory, file, destination) = fixture();
    let result = file_delivery::stream_copy(
        &file,
        &destination,
        || false,
        || {
            std::fs::write(&destination, b"other owner's file").unwrap();
            true
        },
        |_| {},
    );
    assert!(matches!(
        result,
        CopyOutcome::Failed(DeliveryError::AlreadyExists)
    ));
    assert_eq!(std::fs::read(&destination).unwrap(), b"other owner's file");
    assert_eq!(names(directory.path()), vec!["result.txt", "source.txt"]);
}

#[test]
fn independent_same_length_source_change_never_publishes_partial_bytes() {
    let (directory, file, destination) = fixture();
    let before = names(directory.path());
    let changed = AtomicBool::new(false);
    let result = file_delivery::stream_copy(
        &file,
        &destination,
        || false,
        || panic!("changed source must not claim publication"),
        |_| {
            if !changed.swap(true, Ordering::SeqCst) {
                let mut source = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&file.path)
                    .unwrap();
                source.seek(SeekFrom::End(-1)).unwrap();
                source.write_all(b"Z").unwrap();
                source.sync_all().unwrap();
            }
        },
    );
    assert!(matches!(
        result,
        CopyOutcome::Failed(DeliveryError::Changed)
    ));
    assert_eq!(names(directory.path()), before);
    assert!(!destination.exists());
}

#[test]
fn independent_source_growth_never_reports_progress_beyond_the_verified_total() {
    let (directory, file, destination) = fixture();
    let before = names(directory.path());
    let changed = AtomicBool::new(false);
    let maximum = AtomicU64::new(0);
    let result = file_delivery::stream_copy(
        &file,
        &destination,
        || false,
        || panic!("growing source must not claim publication"),
        |total| {
            maximum.fetch_max(total, Ordering::SeqCst);
            if !changed.swap(true, Ordering::SeqCst) {
                let mut source = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&file.path)
                    .unwrap();
                source.write_all(&vec![b'Z'; 64 * 1024]).unwrap();
                source.sync_all().unwrap();
            }
        },
    );
    assert!(matches!(
        result,
        CopyOutcome::Failed(DeliveryError::Changed)
    ));
    assert!(maximum.load(Ordering::SeqCst) <= file.size);
    assert_eq!(names(directory.path()), before);
    assert!(!destination.exists());
}

#[test]
fn independent_expired_reservation_cannot_restart_and_releases_only_its_gate() {
    let (_directory, file, destination) = fixture();
    let jobs = FileCopyJobs::default();
    let first = jobs
        .prepare(file.clone(), destination.to_str().unwrap().to_owned())
        .unwrap();
    let second = jobs
        .prepare(file, destination.to_str().unwrap().to_owned())
        .unwrap();
    {
        let mut all = jobs.jobs.lock().unwrap();
        let first = all.entries.get_mut(&first.operation_id).unwrap();
        let Entry::Copy(first) = first else {
            panic!("copy domain")
        };
        Arc::get_mut(first).unwrap().created = Instant::now() - READY_LIFETIME;
    }
    assert!(jobs.status(&first.operation_id).unwrap().is_none());
    assert!(jobs.start(&first.operation_id).unwrap().is_none());
    assert_eq!(
        jobs.status(&second.operation_id).unwrap().unwrap().state,
        CopyState::Ready
    );
    assert!(jobs.seal_exit().is_err());
    jobs.cancel(&second.operation_id).unwrap();
    assert!(jobs.seal_exit().is_ok());
    assert!(!destination.exists());
}
