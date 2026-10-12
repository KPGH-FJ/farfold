use super::*;
use crate::file_archive::tests::{id, resign, sample};
use std::{fs, sync::mpsc};
fn status(r: Reply) -> Status {
    match r {
        Reply::Status(s) => *s,
        _ => panic!("expected retained record"),
    }
}
fn wait(jobs: &FileCopyJobs, key: &Key) -> Status {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let s = status(jobs.archive_status(key).unwrap());
        if s.settled {
            return s;
        }
        assert!(Instant::now() < deadline, "archive did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}
#[test]
fn exact_ready_completion_is_idempotent_does_not_rewrite_and_releases_payload() {
    let dir = tempfile::tempdir().unwrap();
    let p = sample(dir.path().join("a.zip").to_str().unwrap().into());
    let key = p.key();
    let jobs = FileCopyJobs::default();
    let ready = jobs.archive_prepare(p.clone()).unwrap();
    assert_eq!(jobs.archive_prepare(p.clone()).unwrap().state, State::Ready);
    assert!(!Path::new(&p.destination).exists());
    assert!(jobs.seal_exit().is_err());
    assert!(!jobs.archive_release(&key).unwrap());
    jobs.archive_start(&key).unwrap();
    let completed = wait(&jobs, &key);
    assert_eq!(completed.state, State::Completed);
    assert_eq!(completed.items_completed, ready.included_count);
    assert_eq!(completed.processed_input_bytes, ready.total_input_bytes);
    assert!(
        jobs.jobs
            .lock()
            .unwrap()
            .archive(&key)
            .unwrap()
            .unwrap()
            .payload
            .lock()
            .unwrap()
            .is_none()
    );
    fs::write(&p.destination, b"changed after success").unwrap();
    assert_eq!(
        status(jobs.archive_start(&key).unwrap()).state,
        State::Completed
    );
    assert_eq!(
        status(jobs.archive_cancel(&key).unwrap()).state,
        State::Completed
    );
    assert_eq!(fs::read(&p.destination).unwrap(), b"changed after success");
    assert!(jobs.archive_release(&key).unwrap());
    assert!(matches!(
        jobs.archive_status(&key).unwrap(),
        Reply::Absent {
            admission_closed: true,
            ..
        }
    ));
    assert_eq!(jobs.archive_prepare(p).unwrap_err().code, "requestRetired");
    assert!(jobs.seal_exit().is_ok());
}
#[test]
fn ready_expiry_drops_payload_but_not_closed_identity_and_copy_capacity_is_shared() {
    let jobs = FileCopyJobs::default();
    let p = sample("/synthetic/archive.zip".into());
    let key = p.key();
    jobs.archive_prepare(p.clone()).unwrap();
    {
        let mut all = jobs.jobs.lock().unwrap();
        let Entry::Archive(a) = all.entries.get_mut(&key.operation_id).unwrap() else {
            panic!()
        };
        Arc::get_mut(a).unwrap().created = Instant::now() - READY_LIFETIME;
    }
    assert!(matches!(
        jobs.archive_status(&key).unwrap(),
        Reply::Absent {
            admission_closed: true,
            ..
        }
    ));
    assert_eq!(
        jobs.archive_prepare(p.clone()).unwrap_err().code,
        "requestRetired"
    );
    assert!(jobs.seal_exit().is_ok());
    for i in 10..10 + CAPACITY as u64 {
        let mut n = p.clone();
        n.operation_id = id(i);
        jobs.archive_prepare(n).unwrap();
    }
    let mut extra = p;
    extra.operation_id = id(1000);
    assert_eq!(jobs.archive_prepare(extra).unwrap_err().code, "busy");
    let f = crate::file_delivery::VerifiedFile {
        root: "/synthetic".into(),
        path: "/synthetic/file".into(),
        resolved_path: "/synthetic/file".into(),
        name: "file".into(),
        size: 0,
        sha256: "0".repeat(64),
        version: "1".repeat(64),
    };
    assert_eq!(
        jobs.prepare(f, "/synthetic/copied".into())
            .unwrap_err()
            .code,
        "busy"
    );
}
#[test]
fn actual_archive_public_states_wire() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = FileCopyJobs::default();
    let p = sample(dir.path().join("actual.zip").to_str().unwrap().into());
    let key = p.key();
    let ready = jobs.archive_prepare(p.clone()).unwrap();
    let (entered_rx_tx, entered_rx) = mpsc::channel();
    let (continue_tx, continue_rx) = mpsc::channel();
    let (pub_tx, pub_rx) = mpsc::channel();
    jobs.archive_start_with(&key, move |p, job| {
        entered_rx_tx.send(()).unwrap();
        continue_rx.recv().unwrap();
        file_delivery::stream_archive(
            p,
            || job.phase.load(Ordering::SeqCst) == CANCELLED,
            || {
                let claimed = job.claim();
                pub_tx.send(job.snapshot()).unwrap();
                claimed
            },
            |bytes, items| {
                let mut s = job.status.lock().unwrap();
                s.processed_input_bytes = bytes;
                s.items_completed = items;
            },
        )
    })
    .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let writing = jobs.archive_status(&key).unwrap();
    continue_tx.send(()).unwrap();
    let publishing = pub_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let completed = wait(&jobs, &key);
    let mut second = p.clone();
    second.operation_id = id(31);
    second.destination = dir.path().join("cancel.zip").to_str().unwrap().into();
    resign(&mut second);
    let key2 = second.key();
    let ready2 = jobs.archive_prepare(second).unwrap();
    let cancelled = jobs.archive_cancel(&key2).unwrap();
    let mut third = p.clone();
    third.operation_id = id(32);
    third.destination = dir
        .path()
        .join("absent-parent/no.zip")
        .to_str()
        .unwrap()
        .into();
    resign(&mut third);
    let key3 = third.key();
    jobs.archive_prepare(third).unwrap();
    jobs.archive_start(&key3).unwrap();
    let failed = wait(&jobs, &key3);
    let key4 = Key {
        operation_id: id(33),
        input_sha256: "0".repeat(64),
    };
    let absent = jobs.archive_status(&key4).unwrap();
    let closed = jobs.archive_cancel(&key4).unwrap();
    // Real worker/owned ZIP publication, then parent path drift at the exact claim seam.
    let parent = dir.path().join("unknown-parent");
    fs::create_dir(&parent).unwrap();
    let old = dir.path().join("old-parent");
    let mut fourth = p.clone();
    fourth.operation_id = id(34);
    fourth.destination = parent.join("unknown.zip").to_str().unwrap().into();
    resign(&mut fourth);
    let key5 = fourth.key();
    jobs.archive_prepare(fourth).unwrap();
    jobs.archive_start_with(&key5, move |p, job| {
        file_delivery::stream_archive(
            p,
            || false,
            || {
                let claimed = job.claim();
                fs::rename(&parent, &old).unwrap();
                fs::create_dir(&parent).unwrap();
                claimed
            },
            |bytes, items| {
                let mut s = job.status.lock().unwrap();
                s.processed_input_bytes = bytes;
                s.items_completed = items;
            },
        )
    })
    .unwrap();
    let unknown = wait(&jobs, &key5);
    assert_eq!(unknown.state, State::Unknown);
    assert_eq!(jobs.seal_exit().unwrap_err(), "EXIT_CONFIRMATION_REQUIRED");
    let mut fifth = p.clone();
    fifth.operation_id = id(35);
    fifth.destination = dir
        .path()
        .join("in-progress-cancel.zip")
        .to_str()
        .unwrap()
        .into();
    resign(&mut fifth);
    let key6 = fifth.key();
    jobs.archive_prepare(fifth).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    jobs.archive_start_with(&key6, move |p, job| {
        let once = std::sync::atomic::AtomicBool::new(false);
        file_delivery::stream_archive(
            p,
            || job.phase.load(Ordering::SeqCst) == CANCELLED,
            || job.claim(),
            |bytes, items| {
                {
                    let mut s = job.status.lock().unwrap();
                    s.processed_input_bytes = bytes;
                    s.items_completed = items;
                }
                if !once.swap(true, Ordering::SeqCst) {
                    entered_tx.send(()).unwrap();
                    resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                }
            },
        )
    })
    .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let cancelling = jobs.archive_cancel(&key6).unwrap();
    resume_tx.send(()).unwrap();
    let cancelled_writing = wait(&jobs, &key6);
    let mut zero = p.clone();
    zero.operation_id = id(36);
    zero.destination = dir
        .path()
        .join("zero-selected.zip")
        .to_str()
        .unwrap()
        .into();
    zero.selected.clear();
    zero.omitted = vec![Omitted {
        candidate_id: id(4),
        reason: Omission::NotSelected,
    }];
    resign(&mut zero);
    let key7 = zero.key();
    let zero_ready = jobs.archive_prepare(zero).unwrap();
    assert_eq!(zero_ready.state, State::Ready);
    jobs.archive_start(&key7).unwrap();
    let zero_completed = wait(&jobs, &key7);
    assert_eq!(zero_completed.state, State::Completed);
    println!("ARCHIVE_STATES_WIRE={}",serde_json::to_string(&serde_json::json!({"ready":ready,"writing":writing,"publishing":publishing,"completed":completed,"cancelReady":ready2,"cancelled":cancelled,"failed":failed,"unknown":unknown,"absent":absent,"admissionClosed":closed,"cancelling":cancelling,"cancelledWriting":cancelled_writing,"zeroReady":zero_ready,"zeroCompleted":zero_completed})).unwrap());
}
