use super::*;
use crate::worktrees::tests::{OP, Repo, git, op, store};
use std::fs;

fn registered() -> (Repo, Worktrees, MetaStore, Location) {
    let r = Repo::new();
    let m = Worktrees::default();
    let s = store();
    let inspection = m.inspect(&s, r.root.to_str().unwrap()).unwrap();
    let l = op(m
        .adopt(&s, OP, &inspection.inspection_id, &inspection.root)
        .unwrap())
    .location
    .unwrap();
    (r, m, s, l)
}
#[test]
fn preparation_ticket_is_metadata_only_does_not_save_or_increment_location() {
    let (_r, m, s, l) = registered();
    let before = s.worktree_raw().unwrap();
    let receipt = m.preparation_inspect(&s, &l.id, l.revision, "").unwrap();
    let valid = m.preparation_validate(&s, &receipt.inspection_id).unwrap();
    assert!(valid.valid);
    assert_eq!(valid.inspection_id, receipt.inspection_id);
    assert_eq!(receipt.location, l);
    assert_eq!(receipt.coverage.scope, "fixedNameMetadata");
    assert_eq!(receipt.coverage.checked_names, 22);
    assert!(receipt.coverage.complete);
    assert_eq!(s.worktree_raw().unwrap(), before);
    println!(
        "PREPARATION_WIRE {}",
        serde_json::to_string(&serde_json::json!({"inspection":receipt,"validation":valid}))
            .unwrap()
    );
}
#[test]
fn preparation_requires_fresh_verified_exact_location_and_does_not_adopt() {
    let (_r, m, s, l) = registered();
    assert_eq!(
        m.preparation_inspect(&s, "unregistered", 0, "")
            .unwrap_err()
            .code,
        "missing"
    );
    assert_eq!(
        m.preparation_inspect(&s, &l.id, l.revision + 1, "")
            .unwrap_err()
            .code,
        "changed"
    );
    let cold = Worktrees::default();
    assert_eq!(
        cold.preparation_inspect(&s, &l.id, l.revision, "")
            .unwrap_err()
            .code,
        "changed"
    );
    let fresh = cold.check_location(&s, &l.id).unwrap();
    assert!(
        cold.preparation_inspect(&s, &l.id, fresh.revision, "")
            .is_ok()
    );
}
#[test]
fn preparation_validation_detects_catalogue_revision_and_does_not_refresh_it() {
    let (_r, m, s, l) = registered();
    let receipt = m.preparation_inspect(&s, &l.id, l.revision, "").unwrap();
    let checked = m.check_location(&s, &l.id).unwrap();
    assert!(checked.revision > l.revision);
    assert_eq!(
        m.preparation_validate(&s, &receipt.inspection_id)
            .unwrap_err()
            .code,
        "changed"
    );
    assert_eq!(m.list(&s).unwrap().locations[0], checked);
}
#[test]
fn preparation_failed_validation_retires_the_exact_ticket() {
    let (r, m, s, l) = registered();
    let receipt = m.preparation_inspect(&s, &l.id, l.revision, "").unwrap();
    fs::write(r.root.join("package.json"), "fixture").unwrap();
    assert_eq!(
        m.preparation_validate(&s, &receipt.inspection_id)
            .unwrap_err()
            .code,
        "changed"
    );
    fs::remove_file(r.root.join("package.json")).unwrap();
    assert_eq!(
        m.preparation_validate(&s, &receipt.inspection_id)
            .unwrap_err()
            .code,
        "inspectionExpired"
    );
}
#[test]
fn preparation_publication_rechecks_same_revision_availability() {
    let (_r, m, s, l) = registered();
    let result = m.preparation_inspect_with(&s, &l.id, l.revision, "", || {
        m.lock().unwrap().doc.locations[0].location.availability = "unknown".into();
    });
    assert_eq!(result.unwrap_err().code, "changed");
    assert!(m.lock().unwrap().preparation_tickets.is_empty());
}
#[test]
fn preparation_validation_rechecks_catalogue_after_filesystem_work() {
    let (_r, m, s, l) = registered();
    let receipt = m.preparation_inspect(&s, &l.id, l.revision, "").unwrap();
    let result = m.preparation_validate_with(&s, &receipt.inspection_id, || {
        m.lock().unwrap().doc.locations[0].location.availability = "unknown".into();
    });
    assert_eq!(result.unwrap_err().code, "changed");
    assert!(
        !m.lock()
            .unwrap()
            .preparation_tickets
            .contains_key(&receipt.inspection_id)
    );
}
#[test]
fn preparation_tickets_are_bounded_expire_and_do_not_survive_restart() {
    let (_r, m, s, l) = registered();
    let receipt = m.preparation_inspect(&s, &l.id, l.revision, "").unwrap();
    {
        let mut i = m.lock().unwrap();
        let ticket = i.preparation_tickets[&receipt.inspection_id].clone();
        for n in 1..TICKET_LIMIT {
            i.preparation_tickets.insert(n.to_string(), ticket.clone());
        }
    }
    assert_eq!(
        m.preparation_inspect(&s, &l.id, l.revision, "")
            .unwrap_err()
            .code,
        "capacity"
    );
    {
        let mut i = m.lock().unwrap();
        for t in i.preparation_tickets.values_mut() {
            t.created = Instant::now() - TICKET_TTL - Duration::from_secs(1);
        }
    }
    assert_eq!(
        m.preparation_validate(&s, &receipt.inspection_id)
            .unwrap_err()
            .code,
        "inspectionExpired"
    );
    assert!(m.preparation_inspect(&s, &l.id, l.revision, "").is_ok());
    assert_eq!(
        Worktrees::default()
            .preparation_validate(&s, &receipt.inspection_id)
            .unwrap_err()
            .code,
        "inspectionExpired"
    );
}
#[test]
fn preparation_local_worker_admission_blocks_maintenance_until_actual_read_returns() {
    let (_r, m, s, l) = registered();
    let (started, ready) = std::sync::mpsc::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let manager = m.clone();
    let worker = std::thread::spawn(move || {
        manager.preparation_inspect_with(&s, &l.id, l.revision, "", || {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
        })
    });
    ready.recv_timeout(Duration::from_secs(10)).unwrap();
    let blocked = m.0.admission.update().is_err();
    release.send(()).unwrap();
    worker.join().unwrap().unwrap();
    assert!(blocked);
    assert!(m.0.admission.update().is_ok());
}
#[test]
fn preparation_head_change_cannot_be_validated_from_old_ticket() {
    let (r, m, s, l) = registered();
    let receipt = m.preparation_inspect(&s, &l.id, l.revision, "").unwrap();
    git(&r.root, &["commit", "--allow-empty", "-qm", "changed"]);
    assert_eq!(
        m.preparation_validate(&s, &receipt.inspection_id)
            .unwrap_err()
            .code,
        "changed"
    );
}

#[test]
fn preparation_actual_work_or_maintenance_admission_is_not_bypassed() {
    let (_r, m, s, l) = registered();
    {
        let _exclusive = m.0.admission.update().unwrap();
        assert_eq!(
            m.preparation_inspect(&s, &l.id, l.revision, "")
                .unwrap_err()
                .code,
            "busy"
        );
    }
    m.lock().unwrap().working = Some(Working::new(
        "controlled-worker",
        Arc::new(AtomicBool::new(false)),
    ));
    assert_eq!(
        m.preparation_inspect(&s, &l.id, l.revision, "")
            .unwrap_err()
            .code,
        "busy"
    );
    m.lock().unwrap().working = None;
    assert!(m.preparation_inspect(&s, &l.id, l.revision, "").is_ok());
}
#[test]
fn preparation_ttl_is_rechecked_after_actual_validation_work() {
    let (_r, m, s, l) = registered();
    let receipt = m.preparation_inspect(&s, &l.id, l.revision, "").unwrap();
    let result = m.preparation_validate_with(&s, &receipt.inspection_id, || {
        m.lock()
            .unwrap()
            .preparation_tickets
            .get_mut(&receipt.inspection_id)
            .unwrap()
            .created -= TICKET_TTL;
    });
    assert_eq!(result.unwrap_err().code, "inspectionExpired");
    assert!(
        !m.lock()
            .unwrap()
            .preparation_tickets
            .contains_key(&receipt.inspection_id)
    );
}
