use super::{
    recovery_tests as fixture,
    tests::{self, Repo},
    *,
};
use serde::Serialize;
fn emit(name: &str, value: impl Serialize, out: &mut Vec<serde_json::Value>) {
    out.push(serde_json::json!({"name":name,"value":serde_json::to_value(value).unwrap()}));
}
#[test]
fn actual_remove_and_recover_wire_receipts() {
    recycle_tests::isolated(
        "worktrees::remove_wire_tests::actual_remove_and_recover_wire_receipts",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let a = fixture::archive(&m, &s, &l);
            let id = fixture::REMOVE;
            let mut wire = Vec::new();
            let p = m.remove_inspect(&s, &a.id, a.revision).unwrap();
            emit("removeInspection", &p, &mut wire);
            let wrong = "72345678-1234-4123-8123-123456789abc";
            let failed = m
                .prepare_remove(
                    &s,
                    wrong,
                    RemoveInput {
                        inspection_id: p.inspection_id,
                        expected_draft_baseline: DraftBaseline {
                            unsent_work: Some("0".repeat(64)),
                            agent_setup: None,
                        },
                    },
                    |_| panic!("refused before retirement"),
                )
                .unwrap();
            assert_eq!(tests::op(failed.clone()).state, "failed");
            emit("knownRefusal", failed, &mut wire);
            let p = m.remove_inspect(&s, &a.id, a.revision).unwrap();
            let initial = m
                .prepare_remove(
                    &s,
                    id,
                    RemoveInput {
                        inspection_id: p.inspection_id,
                        expected_draft_baseline: p.draft_baseline,
                    },
                    |_| Ok(()),
                )
                .unwrap();
            emit("removeInitial", initial, &mut wire);
            let prepared = fixture::wait_prepared(&m, &s, id);
            assert_eq!(prepared.state, "prepared", "{prepared:?}");
            emit("removePrepared", &prepared, &mut wire);
            emit("awaitingList", m.list(&s).unwrap(), &mut wire);
            let b = prepared.recovery.unwrap();
            let initial = m
                .confirm_remove(
                    &s,
                    id,
                    RemoveConfirmation {
                        record_id: a.id,
                        expected_revision: a.revision,
                        recovery_id: b.id.clone(),
                        recovery_sha256: b.bundle_sha256.clone(),
                        manifest_sha256: b.manifest_sha256.clone(),
                    },
                )
                .unwrap();
            emit("removeConfirm", initial, &mut wire);
            let done = recycle_tests::wait(&m, &s, id);
            assert_eq!(done.state, "ready", "{done:?}");
            emit("removeReady", done, &mut wire);
            emit("removedList", m.list(&s).unwrap(), &mut wire);
            let cold = Worktrees::default();
            let cold_list = cold.list(&s).unwrap();
            assert!(cold_list.operation.as_ref().unwrap().removed.is_none());
            emit("coldRemovalList", cold_list, &mut wire);
            let verified = cold.recheck(&s, id).unwrap();
            assert_eq!(tests::op(verified.clone()).state, "ready");
            emit("removeRechecked", verified, &mut wire);
            let checked = cold.recovery_check(&s, &b.id, b.revision).unwrap();
            let b = checked.recoveries[0].clone();
            emit("recoveryChecked", checked, &mut wire);
            let recover = "52345678-1234-4123-8123-123456789abc";
            let p = cold
                .prepare_recover(
                    &s,
                    recover,
                    RecoverInput {
                        recovery_id: b.id,
                        expected_revision: b.revision,
                        parent_path: r
                            ._dir
                            .path()
                            .canonicalize()
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .into(),
                        directory_name: "wire-recovered".into(),
                    },
                )
                .unwrap();
            assert_eq!(tests::op(p.clone()).state, "prepared");
            emit("recoverPrepared", p, &mut wire);
            emit("recoverStart", cold.start(&s, recover).unwrap(), &mut wire);
            let ready = recycle_tests::wait(&cold, &s, recover);
            assert_eq!(ready.state, "ready", "{ready:?}");
            emit("recoverReady", ready, &mut wire);
            emit("recoveredList", cold.list(&s).unwrap(), &mut wire);
            let final_cold = Worktrees::default();
            emit("coldRecoveredList", final_cold.list(&s).unwrap(), &mut wire);
            let rechecked = final_cold.recheck(&s, recover).unwrap();
            assert_eq!(tests::op(rechecked.clone()).state, "ready");
            emit("recoverRechecked", rechecked, &mut wire);
            emit(
                "exactUnknown",
                final_cold
                    .status(&s, "ffffffff-ffff-4fff-8fff-ffffffffffff")
                    .unwrap(),
                &mut wire,
            );
            eprintln!("REMOVE_WIRE {}", serde_json::to_string(&wire).unwrap());
        },
    );
}
