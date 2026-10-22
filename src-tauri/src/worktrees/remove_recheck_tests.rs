use super::*;
use crate::worktrees::{recovery_tests as fixture, recycle_tests, tests, *};
use std::{fs, path::Path};

const RECOVER: &str = "52345678-1234-4123-8123-123456789abc";

fn deleted(m: &Worktrees, s: &MetaStore, r: &tests::Repo) -> Recovery {
    let l = recycle_tests::created(m, s, r);
    let a = fixture::archive(m, s, &l);
    let p = fixture::prepare_removal(m, s, &a);
    assert_eq!(p.state, "prepared", "{p:?}");
    let b = p.recovery.unwrap();
    m.confirm_remove(
        s,
        fixture::REMOVE,
        RemoveConfirmation {
            record_id: a.id,
            expected_revision: a.revision,
            recovery_id: b.id.clone(),
            recovery_sha256: b.bundle_sha256.clone(),
            manifest_sha256: b.manifest_sha256.clone(),
        },
    )
    .unwrap();
    let o = recycle_tests::wait(m, s, fixture::REMOVE);
    assert_eq!(o.state, "ready", "{o:?}");
    assert!(!Path::new(&b.retained_path).exists());
    b
}

fn recover_input(r: &tests::Repo, b: &Recovery) -> RecoverInput {
    RecoverInput {
        recovery_id: b.id.clone(),
        expected_revision: b.revision,
        parent_path: r
            ._dir
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        directory_name: "after-delete-recovered".into(),
    }
}

fn check_then_recover(cold: bool) {
    let r = tests::Repo::new();
    let s = tests::store();
    let original = Worktrees::default();
    let b = deleted(&original, &s, &r);
    let m = if cold { Worktrees::default() } else { original };
    if cold {
        let list = m.list(&s).unwrap();
        assert_eq!(list.recoveries[0].availability, "unknown");
        assert_eq!(list.operation.unwrap().state, "unknown");
    }
    let checked = tests::op(m.recheck(&s, fixture::REMOVE).unwrap());
    assert_eq!(checked.state, "ready", "{checked:?}");
    let proof = checked.recovery.unwrap();
    assert_eq!(proof.id, b.id);
    assert_eq!(proof.availability, "verified");
    assert_eq!(m.list(&s).unwrap().recoveries[0], proof);
    let (_, removal_doc) = storage::read(&s).unwrap();
    assert_eq!(removal_doc.recoveries[0].receipt, proof);
    let removed_op = removal_doc.operation.as_ref().unwrap();
    assert_eq!(removed_op.status.recovery.as_ref(), Some(&proof));
    assert_eq!(
        removed_op
            .removal
            .as_ref()
            .unwrap()
            .recovery
            .as_ref()
            .unwrap()
            .receipt,
        proof
    );
    let args = recover_input(&r, &proof);
    let target = Path::new(&args.parent_path).join(&args.directory_name);
    // This is the same manager/API sequence as the installed failure, not a direct pack call.
    let prepared = tests::op(m.prepare_recover(&s, RECOVER, args).unwrap());
    assert_eq!(prepared.state, "prepared", "{prepared:?}");
    let list = m.list(&s).unwrap();
    assert_eq!(list.recoveries[0], proof);
    let (_, durable) = storage::read(&s).unwrap();
    assert_eq!(durable.recoveries[0].receipt, proof);
    assert_eq!(
        durable.operation.as_ref().unwrap().status.recovery.as_ref(),
        Some(&proof)
    );
    m.start(&s, RECOVER).unwrap();
    let done = recycle_tests::wait(&m, &s, RECOVER);
    assert_eq!(done.state, "ready", "{done:?}");
    let location = done.location.as_ref().unwrap();
    assert_eq!(location.ownership, "existing");
    assert_eq!(location.path, target.to_str().unwrap());
    assert_eq!(location.repository_root, location.path);
    assert_eq!(fs::read(target.join("a.txt")).unwrap(), b"fixture");
    assert!(!target.join(".git/objects/info/alternates").exists());
    assert!(tests::git(&target, &["remote"]).is_empty());
    if cold {
        println!(
            "COLD_RECOVERY_WIRE={}",
            serde_json::json!({
                "removalRechecked": removed_op.status,
                "canonicalList": m.list(&s).unwrap(),
                "recoverPrepared": prepared,
                "recoverReady": done,
            })
        );
    }
}

#[test]
fn warm_remove_recheck_can_recover_through_the_manager() {
    recycle_tests::isolated(
        "worktrees::manager::remove_recheck_tests::warm_remove_recheck_can_recover_through_the_manager",
        || check_then_recover(false),
    );
}

#[test]
fn cold_remove_recheck_can_recover_through_the_manager() {
    recycle_tests::isolated(
        "worktrees::manager::remove_recheck_tests::cold_remove_recheck_can_recover_through_the_manager",
        || check_then_recover(true),
    );
}

#[test]
fn removal_recheck_uses_newer_canonical_revision_without_accepting_stale_recovery_input() {
    recycle_tests::isolated(
        "worktrees::manager::remove_recheck_tests::removal_recheck_uses_newer_canonical_revision_without_accepting_stale_recovery_input",
        || {
            let r = tests::Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let b = deleted(&m, &s, &r);
            let cold = Worktrees::default();
            let list = cold.recovery_check(&s, &b.id, b.revision).unwrap();
            let newer = list.recoveries[0].clone();
            assert!(newer.revision > b.revision);
            let checked = tests::op(cold.recheck(&s, fixture::REMOVE).unwrap());
            assert_eq!(checked.state, "ready");
            let current = checked.recovery.unwrap();
            assert!(current.revision > newer.revision);
            assert_eq!(cold.list(&s).unwrap().recoveries[0], current);
            let (_, doc) = storage::read(&s).unwrap();
            assert_eq!(doc.recoveries[0].receipt, current);
            assert_eq!(
                doc.operation.unwrap().status.recovery,
                Some(current.clone())
            );
            // Reopen the newly saved record, not the original deletion snapshot.
            let reopened = Worktrees::default();
            let loaded = reopened.list(&s).unwrap();
            assert_eq!(loaded.recoveries[0].revision, current.revision);
            assert_eq!(loaded.recoveries[0].availability, "unknown");
            assert_eq!(
                loaded
                    .operation
                    .as_ref()
                    .unwrap()
                    .recovery
                    .as_ref()
                    .unwrap(),
                &loaded.recoveries[0]
            );
            let checked = tests::op(reopened.recheck(&s, fixture::REMOVE).unwrap());
            assert_eq!(checked.state, "ready");
            let latest = checked.recovery.unwrap();
            assert!(latest.revision > current.revision);
            let (_, doc) = storage::read(&s).unwrap();
            assert_eq!(doc.recoveries[0].receipt, latest);
            let op = doc.operation.unwrap();
            assert_eq!(op.status.recovery.as_ref(), Some(&latest));
            assert_eq!(op.removal.unwrap().recovery.unwrap().receipt, latest);
            let cold = reopened;
            let stale = tests::op(
                cold.prepare_recover(&s, RECOVER, recover_input(&r, &b))
                    .unwrap(),
            );
            assert_eq!(stale.state, "failed");
            assert_eq!(stale.code.as_deref(), Some("missingRecovery"));
            let fresh = tests::op(
                cold.prepare_recover(
                    &s,
                    "62345678-1234-4123-8123-123456789abc",
                    recover_input(&r, &latest),
                )
                .unwrap(),
            );
            assert_eq!(fresh.state, "prepared", "{fresh:?}");
            cold.cancel(&s, &fresh.operation_id).unwrap();
        },
    );
}

#[test]
fn removal_recheck_never_promotes_tampered_bundle_or_manifest() {
    recycle_tests::isolated(
        "worktrees::manager::remove_recheck_tests::removal_recheck_never_promotes_tampered_bundle_or_manifest",
        || {
            for file in ["recovery.bundle", "manifest.json"] {
                let r = tests::Repo::new();
                let s = tests::store();
                let m = Worktrees::default();
                let b = deleted(&m, &s, &r);
                let path = Path::new(&b.path).join(file);
                let mut bytes = fs::read(&path).unwrap();
                bytes[0] ^= 1;
                fs::write(&path, &bytes).unwrap();
                let cold = Worktrees::default();
                let checked = tests::op(cold.recheck(&s, fixture::REMOVE).unwrap());
                assert_eq!(checked.state, "unknown", "{checked:?}");
                assert_eq!(checked.code.as_deref(), Some("recoveryChanged"));
                assert!(checked.removed.is_none());
                let proof = checked.recovery.unwrap();
                assert_eq!(proof.availability, "unknown");
                assert_eq!(cold.list(&s).unwrap().recoveries[0], proof);
                let (_, doc) = storage::read(&s).unwrap();
                assert_eq!(doc.recoveries[0].receipt, proof);
                assert_eq!(doc.operation.unwrap().status.recovery, Some(proof.clone()));
                cold.acknowledge(&s, fixture::REMOVE).unwrap();
                let rejected = tests::op(
                    cold.prepare_recover(&s, RECOVER, recover_input(&r, &proof))
                        .unwrap(),
                );
                assert_eq!(rejected.state, "failed");
                assert_eq!(rejected.code.as_deref(), Some("missingRecovery"));
                assert!(!r._dir.path().join("after-delete-recovered").exists());
                assert_eq!(fs::read(path).unwrap(), bytes);
            }
        },
    );
}

#[test]
fn removal_recheck_rejects_changed_proof_identity_or_older_revision_before_verification() {
    recycle_tests::isolated(
        "worktrees::manager::remove_recheck_tests::removal_recheck_rejects_changed_proof_identity_or_older_revision_before_verification",
        || {
            let r = tests::Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            deleted(&m, &s, &r);
            m.recheck(&s, fixture::REMOVE).unwrap();
            let baseline = m.lock().unwrap().doc.clone();
            for variant in ["hash", "inode", "origin", "older"] {
                {
                    let mut i = m.lock().unwrap();
                    let mut doc = baseline.clone();
                    let recovery = &mut doc.recoveries[0];
                    match variant {
                        "hash" => recovery.receipt.bundle_sha256 = "0".repeat(64),
                        "inode" => match &mut recovery.bundle_stamp {
                            recovery_pack::FileIdentity::Unix(value) => value.ino += 1,
                            recovery_pack::FileIdentity::Windows(_) => {
                                panic!("Unix fixture identity required")
                            }
                        },
                        "origin" => recovery.operation_id = RECOVER.into(),
                        "older" => recovery.receipt.revision -= 1,
                        _ => unreachable!(),
                    }
                    i.save(&s, doc).unwrap();
                }
                let before = s.worktree_raw().unwrap();
                assert_eq!(
                    m.recheck_remove_with(&s, fixture::REMOVE, |_| {
                        panic!("mismatched proof must not reach filesystem verification")
                    })
                    .unwrap_err()
                    .code,
                    "changed",
                    "{variant}"
                );
                assert_eq!(s.worktree_raw().unwrap(), before);
            }
        },
    );
}

#[test]
fn late_removal_verification_cannot_overwrite_newer_catalogue_or_another_operation() {
    recycle_tests::isolated(
        "worktrees::manager::remove_recheck_tests::late_removal_verification_cannot_overwrite_newer_catalogue_or_another_operation",
        || {
            let r = tests::Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let b = deleted(&m, &s, &r);
            let mut newer = None;
            let mut durable_after_newer = None;
            let rejected = m
                .recheck_remove_with(&s, fixture::REMOVE, |intent| {
                    crate::worktrees::removal::verify_deleted(
                        &crate::worktrees::material_owner::Owner::default(),
                        intent,
                        &AtomicBool::new(false),
                    )?;
                    newer = Some(m.recovery_check(&s, &b.id, b.revision)?.recoveries[0].clone());
                    durable_after_newer = s.worktree_raw().unwrap();
                    Ok(())
                })
                .unwrap_err();
            assert_eq!(rejected.code, "changed");
            assert_eq!(m.list(&s).unwrap().recoveries[0], newer.unwrap());
            assert_eq!(s.worktree_raw().unwrap(), durable_after_newer);

            let mut durable_after_observation = None;
            let rejected = m
                .recheck_remove_with(&s, fixture::REMOVE, |intent| {
                    crate::worktrees::removal::verify_deleted(
                        &crate::worktrees::material_owner::Owner::default(),
                        intent,
                        &AtomicBool::new(false),
                    )?;
                    let mut i = m.lock()?;
                    let mut doc = i.doc.clone();
                    doc.recoveries[0].receipt.availability = "unknown".into();
                    i.save(&s, doc)?;
                    durable_after_observation = s.worktree_raw().unwrap();
                    Ok(())
                })
                .unwrap_err();
            assert_eq!(rejected.code, "changed");
            assert_eq!(m.list(&s).unwrap().recoveries[0].availability, "unknown");
            assert_eq!(s.worktree_raw().unwrap(), durable_after_observation);

            let adopted_id = "62345678-1234-4123-8123-123456789abc";
            let mut durable_after_adopt = None;
            let rejected = m
                .recheck_remove_with(&s, fixture::REMOVE, |intent| {
                    crate::worktrees::removal::verify_deleted(
                        &crate::worktrees::material_owner::Owner::default(),
                        intent,
                        &AtomicBool::new(false),
                    )?;
                    let inspected = m.inspect(&s, r.root.to_str().unwrap())?;
                    let adopted = tests::op(m.adopt(
                        &s,
                        adopted_id,
                        &inspected.inspection_id,
                        &inspected.root,
                    )?);
                    assert_eq!(adopted.state, "ready");
                    durable_after_adopt = s.worktree_raw().unwrap();
                    Ok(())
                })
                .unwrap_err();
            assert_eq!(rejected.code, "changed");
            assert_eq!(
                m.list(&s).unwrap().operation.unwrap().operation_id,
                adopted_id
            );
            assert_eq!(s.worktree_raw().unwrap(), durable_after_adopt);
        },
    );
}
