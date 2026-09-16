use super::*;
use crate::host_ids::FarfoldSessionId;
use crate::host_store::session_open::{OwnedFocusGuard, SessionFocusGuard};
use rusqlite::OptionalExtension;

fn db(f: &Fixture) -> rusqlite::Connection {
    let db = rusqlite::Connection::open(f.temp.path().join("host.sqlite3")).unwrap();
    db.pragma_update(None, "foreign_keys", true).unwrap();
    db
}
fn persisted(f: &Fixture) -> Value {
    let db = db(f);
    let state: Option<(Option<String>, Option<String>, i64)> = db
        .query_row(
            "SELECT last_project_id,last_session_id,updated_at FROM app_state WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .unwrap();
    let opened: Vec<(String, i64)> = db
        .prepare(
            "SELECT farfold_session_id,last_opened_at FROM sessions ORDER BY farfold_session_id",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let drafts:Vec<(String,String,i64)>=db.prepare("SELECT farfold_session_id,body,updated_at FROM session_drafts ORDER BY farfold_session_id").unwrap().query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<Result<_,_>>().unwrap();
    json!({"state":state,"opened":opened,"drafts":drafts})
}

#[test]
fn guarded_focus_facade_commits_once_without_native_replay_and_rejects_foreign_receipts() {
    let f = Fixture::new("thread_events");
    let expected = f.store.raw_navigation_expectation().unwrap();
    let result = f.call(f.request()).unwrap();
    let receipt = result["snapshot"].clone();
    let id = receipt["farfoldSessionId"].as_str().unwrap();
    db(&f).execute("INSERT INTO session_drafts(farfold_session_id,body,updated_at) VALUES(?1,'original draft',1)",[id]).unwrap();
    let native = f
        .temp
        .path()
        .join("home/codex/sessions/synthetic-thread.jsonl");
    let bytes = fs::read(&native).unwrap();
    let original = persisted(&f);
    for field in [
        "scope",
        "nativeThreadId",
        "nativeTreeId",
        "workingCopyId",
        "selection",
    ] {
        let mut wrong = receipt.clone();
        match field {
            "scope" => wrong[field] = json!(scope(2)),
            "selection" => wrong[field]["provider"] = json!("other"),
            _ => wrong[field] = json!("foreign"),
        }
        assert!(
            f.call(json!({"action":"focus","receipt":wrong,"expectedNavigation":expected}))
                .is_err(),
            "{field}"
        );
        assert_eq!(persisted(&f), original);
    }
    let focus = json!({"action":"focus","receipt":receipt,"expectedNavigation":expected});
    let committed = f.call(focus.clone()).unwrap();
    assert_eq!(committed["kind"], "focused");
    assert_eq!(committed["farfoldSessionId"], id);
    assert_eq!(committed["navigation"]["restoreState"]["lastSessionId"], id);
    let after = persisted(&f);
    assert!(
        f.call(focus).is_err(),
        "original navigation token cannot commit twice"
    );
    assert_eq!(persisted(&f), after);
    assert_eq!(fs::read(native).unwrap(), bytes);
    assert_eq!(after["drafts"], original["drafts"]);
}

#[test]
fn guarded_focus_transaction_rechecks_target_model_and_persisted_generation() {
    for change in [
        "generation",
        "target",
        "tree",
        "model",
        "archived",
        "navigation",
    ] {
        let f = Fixture::new("thread_events");
        let result = f.call(f.request()).unwrap();
        let id = FarfoldSessionId::parse(result["snapshot"]["farfoldSessionId"].as_str().unwrap())
            .unwrap();
        let target = f.store.session_open_target(&id).unwrap();
        let mut model = f.store.session_model_selection(&id).unwrap();
        let expected = f.store.raw_navigation_expectation().unwrap();
        let handle = f.runtime.connection().unwrap();
        let home = handle.lock().unwrap().profile_home.clone();
        let db = db(&f);
        match change {
            "generation" => {
                db.execute(
                    "UPDATE runtime_owned_profile_launches SET last_generation=last_generation+1",
                    [],
                )
                .unwrap();
            }
            "target" => {
                db.execute("UPDATE sessions SET native_session_id='foreign'", [])
                    .unwrap();
            }
            "tree" => {
                db.execute(
                    "UPDATE session_native_locators SET locator_value='foreign'",
                    [],
                )
                .unwrap();
            }
            "model" => {
                let mut changed = model.clone();
                changed.selection.provider = "other".into();
                assert!(
                    db.execute(
                        "UPDATE sessions SET native_model_selection_json=?1",
                        [serde_json::to_string(&changed).unwrap()],
                    )
                    .is_err(),
                    "schema already prevents a stored model overwrite"
                );
                model = changed; // An incorrect caller observation must also fail in the focus tx.
            }
            "archived" => {
                db.execute("UPDATE sessions SET archived_at=3", []).unwrap();
            }
            "navigation" => {
                f.store.mark_session_opened(&id).unwrap();
            }
            _ => unreachable!(),
        }
        let before = persisted(&f);
        let guard = SessionFocusGuard {
            expected_navigation: &expected,
            target: &target,
            owned: Some(OwnedFocusGuard {
                model: &model,
                generation: 1,
                profile_home: &home,
            }),
        };
        assert!(
            f.store.mark_session_opened_guarded(&id, &guard).is_err(),
            "{change}"
        );
        assert_eq!(persisted(&f), before, "{change}");
    }
}

#[test]
fn guarded_focus_rejects_current_connection_drift_without_persistent_writes() {
    for change in [
        "unknown",
        "native-thread",
        "native-tree",
        "actual",
        "replaced",
    ] {
        let f = Fixture::new("thread_events");
        let expected = f.store.raw_navigation_expectation().unwrap();
        let receipt = f.call(f.request()).unwrap()["snapshot"].clone();
        let before = persisted(&f);
        if change == "replaced" {
            f.runtime.stop(&scope(1)).unwrap();
            let workspace = attach_threads(&f.runtime, f.temp.path(), "thread_events", 2);
            shared_profile(&f.store, &workspace, &workspace.cwd.join("home"), false);
        } else {
            let handle = f.runtime.connection().unwrap();
            let mut c = handle.lock().unwrap();
            match change {
                "unknown" => c.threads.unknown = true,
                "native-thread" => {
                    c.threads.bound.as_mut().unwrap().native_thread_id = "foreign".into()
                }
                "native-tree" => {
                    c.threads.bound.as_mut().unwrap().native_session_id = "foreign".into()
                }
                "actual" => c.admission.as_mut().unwrap().actual = None,
                _ => unreachable!(),
            }
        }
        assert!(
            f.call(json!({"action":"focus","receipt":receipt,"expectedNavigation":expected}))
                .is_err(),
            "{change}"
        );
        assert_eq!(persisted(&f), before, "{change}");
    }
}
