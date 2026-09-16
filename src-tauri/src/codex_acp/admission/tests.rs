use super::*;
use crate::codex_acp::{
    threads::{
        self,
        tests::{attach, scope, select_test_model, session_registration, shared_profile},
    },
    turns::tests::Fixture,
};
use std::path::Path;

fn choice(s: Snapshot, id: &str, effort: &str) -> CommandInput {
    CommandInput::Select {
        observation_scope: s.scope.clone(),
        epoch: s.epoch,
        catalog_hash: s.catalog_hash.unwrap(),
        catalog_model_id: id.into(),
        provider: "synthetic".into(),
        reasoning_effort: effort.into(),
    }
}
fn setup(
    mode: &str,
) -> (
    tempfile::TempDir,
    configure::Runtime,
    threads::Workspace,
    HostStore,
) {
    let temp = tempfile::tempdir().unwrap();
    let runtime = configure::Runtime::default();
    let workspace = attach(&runtime, temp.path(), mode, 1);
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    shared_profile(&store, &workspace, &workspace.cwd.join("home"), true);
    (temp, runtime, workspace, store)
}
fn no_native_thread(root: &Path) {
    assert!(
        !root
            .join("home/codex/sessions/synthetic-thread.jsonl")
            .exists()
    );
}

#[test]
fn complete_catalog_requires_explicit_visible_choice_and_rejects_stale_scope() {
    let (temp, r, w, _) = setup("admission_ok");
    let s = r.admission(&scope(1), CommandInput::Refresh).unwrap();
    assert_eq!(s.catalog.as_ref().unwrap().len(), 2);
    assert!(s.selection.is_none());
    assert!(
        r.admission(&scope(2), choice(s.clone(), "synthetic-picker", "medium"))
            .is_err()
    );
    assert!(
        r.admission(&scope(1), choice(s, "synthetic-hidden", "medium"))
            .is_err()
    );
    let s = r.admission(&scope(1), CommandInput::Refresh).unwrap();
    assert!(
        r.admission(&scope(1), choice(s, "synthetic-picker", "unsupported"))
            .is_err()
    );
    no_native_thread(temp.path());
    select_test_model(&r, 1);
    let s = r
        .threads(&scope(1), &w, threads::CommandInput::Start)
        .unwrap();
    assert_eq!(s.model.unwrap().native_model, "synthetic-model");
    r.stop(&scope(1)).unwrap();
}
#[test]
fn malformed_or_unauthenticated_catalog_cannot_register_or_start() {
    for mode in [
        "admission_unauthenticated",
        "admission_duplicate",
        "admission_cursor_loop",
    ] {
        let (temp, r, w, _) = setup(mode);
        if let Ok(s) = r.admission(&scope(1), CommandInput::Refresh) {
            assert!(
                r.admission(&scope(1), choice(s, "synthetic-picker", "medium"))
                    .is_err()
            );
        }
        assert!(
            r.threads(&scope(1), &w, threads::CommandInput::Start)
                .is_err()
        );
        no_native_thread(temp.path());
        let _ = r.stop(&scope(1));
    }
}
#[test]
fn actual_start_model_or_effort_mismatch_never_registers() {
    for mode in ["admission_actual_mismatch", "admission_effort_mismatch"] {
        let (temp, r, w, _store) = setup(mode);
        select_test_model(&r, 1);
        assert!(
            r.threads(&scope(1), &w, threads::CommandInput::Start)
                .is_err()
        );
        let db = rusqlite::Connection::open(temp.path().join("host.sqlite3")).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        let _ = r.stop(&scope(1));
    }
}
#[test]
fn original_shared_session_metadata_is_immutable_and_each_turn_is_native_not_managed() {
    let f = Fixture::new("turn_complete");
    let saved = f.store.session_model_selection(&f.id).unwrap();
    assert_eq!(saved.selection.catalog_model_id, "synthetic-picker");
    let mut changed = saved.clone();
    changed.selection.native_model = "other".into();
    assert!(f.store.record_session_model_selection(&changed).is_err());
    let host = f.start();
    f.settle();
    let db = rusqlite::Connection::open(f.temp.path().join("host.sqlite3")).unwrap();
    let row:(String,String,String,String,Option<String>)=db.query_row("SELECT source_kind,runtime_model_id,native_model_id,runtime_provider_id,provider_connection_id FROM turn_provider_bindings WHERE host_turn_id=?1",[host.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    assert_eq!(
        row,
        (
            "native_observation".into(),
            "synthetic-picker".into(),
            "synthetic-model".into(),
            "synthetic".into(),
            None
        )
    );
    assert!(
        db.execute(
            "UPDATE sessions SET native_model_selection_json=NULL WHERE farfold_session_id=?1",
            [f.id.as_str()]
        )
        .is_err()
    );
    let bytes = std::fs::read(
        f.temp
            .path()
            .join("home/codex/sessions/synthetic-thread.jsonl"),
    )
    .unwrap();
    f.runtime.stop(&scope(1)).unwrap();
    let w = attach(&f.runtime, f.temp.path(), "turn_complete", 2);
    shared_profile(&f.store, &w, &w.cwd.join("home"), false);
    f.runtime
        .open_registered_thread(&f.store, &scope(2), &f.id)
        .unwrap();
    assert!(f.store.session_model_selection(&f.id).unwrap() == saved);
    assert_eq!(
        std::fs::read(
            f.temp
                .path()
                .join("home/codex/sessions/synthetic-thread.jsonl")
        )
        .unwrap(),
        bytes
    );
    let host = f
        .runtime
        .start_turn(
            &f.store,
            &scope(2),
            &f.id,
            &f.coordinator,
            &f.router,
            "second synthetic turn",
        )
        .unwrap();
    assert_eq!(
        db.query_row(
            "SELECT runtime_generation FROM turn_provider_bindings WHERE host_turn_id=?1",
            [host.as_str()],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}
#[test]
fn cold_resume_missing_metadata_or_changed_native_model_remains_blocked() {
    for missing in [true, false] {
        let f = Fixture::new("turn_complete");
        if missing {
            // Simulate a pre-metadata Session only in this disposable fixture database.
            let db = rusqlite::Connection::open(f.temp.path().join("host.sqlite3")).unwrap();
            db.execute_batch("DROP TRIGGER immutable_session_native_model_selection; UPDATE sessions SET native_model_selection_json=NULL;").unwrap();
        } else {
            std::fs::write(f.temp.path().join("home/codex/synthetic-model.json"),r#"{"model":"default-fallback","modelProvider":"synthetic","reasoningEffort":"medium"}"#).unwrap();
        }
        f.runtime.stop(&scope(1)).unwrap();
        let w = attach(&f.runtime, f.temp.path(), "turn_complete", 2);
        shared_profile(&f.store, &w, &w.cwd.join("home"), false);
        assert!(
            f.runtime
                .open_registered_thread(&f.store, &scope(2), &f.id)
                .is_err()
        );
        assert!(
            f.runtime
                .start_turn(
                    &f.store,
                    &scope(2),
                    &f.id,
                    &f.coordinator,
                    &f.router,
                    "must not send"
                )
                .is_err()
        );
        assert_eq!(f.count(), 0);
    }
}
#[test]
fn fresh_catalog_or_account_change_closes_next_turn_before_host_admission() {
    for mode in [
        "admission_catalog_change",
        "admission_account_change",
        "admission_read_provider",
        "admission_read_active",
    ] {
        let (_temp, r, w, store) = setup(mode);
        select_test_model(&r, 1);
        let t = r
            .threads(&scope(1), &w, threads::CommandInput::Start)
            .unwrap()
            .thread
            .unwrap();
        let reg = session_registration(&w, &t);
        r.register_thread(&store, &scope(1), &reg).unwrap();
        r.thread_events(&scope(1)).unwrap();
        let coordinator = crate::turn_coordinator::TurnCoordinator::default();
        let router = crate::runtime_event_router::RuntimeEventRouter::default();
        let error = r
            .start_turn(
                &store,
                &scope(1),
                &reg.farfold_session_id,
                &coordinator,
                &router,
                "must not send",
            )
            .unwrap_err();
        assert!(
            error.contains("Admission unavailable"),
            "wrong rejection boundary: {error}"
        );
        assert_eq!(coordinator.snapshot().unwrap().active_turn_count(), 0);
        let _ = r.stop(&scope(1));
    }
}

#[test]
fn adapter_rechecks_after_host_observation_and_never_sends_on_late_account_change() {
    let (temp, r, w, store) = setup("admission_late_account_change");
    select_test_model(&r, 1);
    let t = r
        .threads(&scope(1), &w, threads::CommandInput::Start)
        .unwrap()
        .thread
        .unwrap();
    let reg = session_registration(&w, &t);
    r.register_thread(&store, &scope(1), &reg).unwrap();
    r.thread_events(&scope(1)).unwrap();
    let coordinator = crate::turn_coordinator::TurnCoordinator::default();
    let router = crate::runtime_event_router::RuntimeEventRouter::default();
    let error = r
        .start_turn(
            &store,
            &scope(1),
            &reg.farfold_session_id,
            &coordinator,
            &router,
            "must not send",
        )
        .unwrap_err();
    assert!(
        error.contains("Turn"),
        "unexpected rejection layer: {error}"
    );
    assert_eq!(coordinator.snapshot().unwrap().active_turn_count(), 1); // uncertain ACP outcome is not native terminal.
    let raw: Value = serde_json::from_slice(
        &std::fs::read(
            temp.path()
                .join("home/codex/sessions/synthetic-thread.jsonl"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(raw["turns"], json!([]));
    assert!(
        !temp
            .path()
            .join("home/codex/synthetic-turn-start-count.json")
            .exists()
    );
    assert!(
        r.start_turn(
            &store,
            &scope(1),
            &reg.farfold_session_id,
            &coordinator,
            &router,
            "no retry"
        )
        .is_err()
    );
    let _ = r.stop(&scope(1));
}

#[test]
fn model_metadata_cannot_cross_profile_tree_or_working_copy() {
    let f = Fixture::new("turn_complete");
    let saved = f.store.session_model_selection(&f.id).unwrap();
    for field in ["profile", "tree", "cwd", "build"] {
        let mut wrong = saved.clone();
        match field {
            "profile" => {
                wrong.profile_id =
                    crate::host_ids::RuntimeProfileId::parse("other-profile").unwrap()
            }
            "tree" => wrong.native_tree_id = "019a0000-0000-7000-8000-000000000099".into(),
            "cwd" => wrong.cwd = "/".into(),
            _ => {
                wrong.runtime.runtime_build_id =
                    crate::host_ids::RuntimeBuildId::parse("foreign-build").unwrap()
            }
        }
        assert!(f.store.record_session_model_selection(&wrong).is_err());
    }
    assert_eq!(f.count(), 0);
}
