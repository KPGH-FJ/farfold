//! Independent archive challenges: real temporary files, exact ownership and barriers.
use super::*;
use crate::file_archive::tests::{id, resign, sample};
use std::sync::mpsc;

fn status(reply: Reply) -> Status {
    let Reply::Status(value) = reply else {
        panic!("expected the exact retained archive operation")
    };
    *value
}

fn settled(jobs: &FileCopyJobs, key: &Key) -> Status {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let value = status(jobs.archive_status(key).unwrap());
        if value.settled {
            return value;
        }
        assert!(Instant::now() < deadline, "archive worker did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn closed_absence(reply: Reply, key: &Key) {
    let Reply::Absent {
        operation_id,
        input_sha256,
        admission_closed,
        result,
        scope,
        ..
    } = reply
    else {
        panic!("expected exact closed absence, not a fabricated terminal receipt")
    };
    assert_eq!(operation_id, key.operation_id);
    assert_eq!(input_sha256, key.input_sha256);
    assert!(admission_closed);
    assert_eq!((result, scope), ("unknown", "currentProcess"));
}

fn names(directory: &Path) -> Vec<String> {
    let mut values: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    values.sort();
    values
}

#[test]
fn independent_early_cancel_retains_exact_pair_through_capacity_and_copy_calls() {
    let jobs = FileCopyJobs::default();
    let original = sample("/synthetic/never-opened/archive.zip".into());
    let key = original.key();
    closed_absence(jobs.archive_cancel(&key).unwrap(), &key);
    assert_eq!(
        jobs.archive_prepare(original.clone()).unwrap_err().code,
        "requestRetired"
    );
    let mut changed = original.clone();
    changed.markdown.push_str("different frozen input");
    resign(&mut changed);
    assert_eq!(
        jobs.archive_prepare(changed.clone()).unwrap_err().code,
        "requestConflict"
    );
    for reply in [
        jobs.archive_status(&changed.key()),
        jobs.archive_start(&changed.key()),
        jobs.archive_cancel(&changed.key()),
    ] {
        assert_eq!(reply.unwrap_err().code, "requestConflict");
    }
    assert_eq!(
        jobs.archive_release(&changed.key()).unwrap_err().code,
        "requestConflict"
    );
    // Foreign Copy commands cannot remove or reinterpret an archive tombstone.
    assert_eq!(
        jobs.status(&key.operation_id).unwrap_err().code,
        "requestConflict"
    );
    assert_eq!(
        jobs.cancel(&key.operation_id).unwrap_err().code,
        "requestConflict"
    );
    assert_eq!(
        jobs.start(&key.operation_id).unwrap_err().code,
        "requestConflict"
    );
    assert_eq!(
        jobs.release(&key.operation_id).unwrap_err().code,
        "requestConflict"
    );
    for n in 2..=input::ID_CAPACITY {
        let other = Key {
            operation_id: id(n as u64),
            input_sha256: "a".repeat(64),
        };
        closed_absence(jobs.archive_cancel(&other).unwrap(), &other);
    }
    assert_eq!(jobs.jobs.lock().unwrap().seen.len(), input::ID_CAPACITY);
    assert!(jobs.jobs.lock().unwrap().entries.is_empty());
    let mut overflow = original;
    overflow.operation_id = id(9000);
    resign(&mut overflow);
    let overflow_key = overflow.key();
    closed_absence(jobs.archive_status(&overflow_key).unwrap(), &overflow_key);
    assert_eq!(
        jobs.archive_prepare(overflow).unwrap_err().code,
        "requestCapacity"
    );
    closed_absence(jobs.archive_cancel(&overflow_key).unwrap(), &overflow_key);
    closed_absence(jobs.archive_start(&key).unwrap(), &key);
    assert_eq!(jobs.jobs.lock().unwrap().seen.len(), input::ID_CAPACITY);
    assert!(jobs.seal_exit().is_ok());
}

struct ReleaseOnDrop(Option<mpsc::Sender<()>>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

#[test]
fn independent_cancelled_real_writer_holds_copy_slot_until_handles_are_closed() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("archive.zip");
    let source = directory.path().join("copy-source.txt");
    std::fs::write(&source, b"separate copy source").unwrap();
    let file = file_delivery::inspect(directory.path(), &source).unwrap();
    let jobs = FileCopyJobs::default();
    let p = sample(destination.to_str().unwrap().to_owned());
    let key = p.key();
    jobs.archive_prepare(p).unwrap();
    let copy = jobs
        .prepare(
            file,
            directory
                .path()
                .join("copy.txt")
                .to_str()
                .unwrap()
                .to_owned(),
        )
        .unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let release = ReleaseOnDrop(Some(resume_tx));
    jobs.archive_start_with(&key, move |input, job| {
        let once = std::sync::atomic::AtomicBool::new(false);
        file_delivery::stream_archive(
            input,
            || job.phase.load(Ordering::SeqCst) == CANCELLED,
            || job.claim(),
            |_, _| {
                if !once.swap(true, Ordering::SeqCst) {
                    entered_tx.send(()).unwrap();
                    resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                }
            },
        )
    })
    .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(jobs.start(&copy.operation_id).unwrap_err().code, "busy");
    jobs.cancel(&copy.operation_id).unwrap();
    assert!(jobs.release(&copy.operation_id).unwrap());
    let pending = status(jobs.archive_cancel(&key).unwrap());
    assert_eq!(pending.state, State::Cancelling);
    assert!(!pending.settled);
    assert!(pending.receipt.is_none());
    assert!(!jobs.archive_release(&key).unwrap());
    assert_eq!(
        jobs.seal_exit_with_confirmation(true).unwrap_err(),
        EXIT_BLOCKED
    );
    assert_eq!(
        jobs.jobs.lock().unwrap().active.as_deref(),
        Some(key.operation_id.as_str())
    );
    assert!(!destination.exists());
    drop(release);
    let terminal = settled(&jobs, &key);
    assert_eq!(terminal.state, State::Cancelled);
    assert_eq!(terminal.publication, Publication::NotPublished);
    assert!(terminal.receipt.is_none());
    assert_eq!(names(directory.path()), vec!["copy-source.txt"]);
    assert!(jobs.jobs.lock().unwrap().active.is_none());
    assert!(jobs.seal_exit().is_ok());
    assert!(jobs.archive_release(&key).unwrap());
    closed_absence(jobs.archive_start(&key).unwrap(), &key);
    assert!(!destination.exists());
}

#[cfg(unix)]
#[test]
fn independent_parent_replaced_at_claim_is_unknown_and_never_touches_new_parent() {
    let directory = tempfile::tempdir().unwrap();
    let parent = directory.path().join("selected");
    let moved = directory.path().join("moved-owned-parent");
    std::fs::create_dir(&parent).unwrap();
    let destination = parent.join("archive.zip");
    let p = sample(destination.to_str().unwrap().to_owned());
    let outcome = file_delivery::stream_archive(
        &p,
        || false,
        || {
            std::fs::rename(&parent, &moved).unwrap();
            std::fs::create_dir(&parent).unwrap();
            std::fs::write(parent.join("sentinel.txt"), b"other owner's new directory").unwrap();
            true
        },
        |_, _| {},
    );
    assert!(matches!(
        outcome,
        ArchiveOutcome::Unknown("destinationChanged", None)
    ));
    assert_eq!(names(&parent), vec!["sentinel.txt"]);
    assert_eq!(
        std::fs::read(parent.join("sentinel.txt")).unwrap(),
        b"other owner's new directory"
    );
    assert_eq!(names(&moved), vec!["archive.zip"]);
    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(moved.join("archive.zip")).unwrap()).unwrap();
    use std::io::Read;
    let mut markdown = String::new();
    archive
        .by_name("conversation.md")
        .unwrap()
        .read_to_string(&mut markdown)
        .unwrap();
    assert_eq!(markdown, p.markdown);
}

#[test]
fn independent_destination_created_at_archive_claim_is_never_replaced() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("archive.zip");
    let p = sample(destination.to_str().unwrap().to_owned());
    let outcome = file_delivery::stream_archive(
        &p,
        || false,
        || {
            std::fs::write(&destination, b"other owner's non-zip file").unwrap();
            true
        },
        |_, _| {},
    );
    assert!(matches!(
        outcome,
        ArchiveOutcome::Failed("alreadyExists", None)
    ));
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"other owner's non-zip file"
    );
    assert_eq!(names(directory.path()), vec!["archive.zip"]);
}
