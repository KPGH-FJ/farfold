use super::*;
use serde_json::json;

fn requested() -> SessionRow {
    SessionRow {
        id: MetaStore::dismissed_id("agent", "/fixture", "native"),
        agent_id: "agent".into(),
        cwd: "/fixture".into(),
        native_session_id: Some("native".into()),
        title: None,
        config_options: Some(
            json!({"choices":["selected-a"],"_farfoldService":{"kind":"existing"}}),
        ),
        pinned: false,
        archived: false,
        created_at: 31,
        updated_at: 31,
    }
}

#[test]
fn initial_config_inserts_or_fills_null_without_replacing_index_metadata() {
    let store = MetaStore::test_memory();
    let target = requested();
    assert_eq!(
        store.save_initial_session_config(&target, None),
        Ok(target.clone())
    );
    let mut index = target.clone();
    index.config_options = None;
    index.title = Some("My title".into());
    index.pinned = true;
    index.created_at = 4;
    index.updated_at = 7;
    let store = MetaStore::test_memory();
    store.upsert_session(&index).unwrap();
    let mut expected = index.clone();
    expected.config_options = target.config_options.clone();
    assert_eq!(
        store.save_initial_session_config(&target, Some(&index)),
        Ok(expected.clone())
    );
    assert_eq!(
        store.get_session(&target.id).unwrap(),
        Some(expected.clone())
    );
    assert_eq!(
        store.save_initial_session_config(&target, None),
        Ok(expected.clone())
    );
    assert_eq!(
        store.save_initial_session_config(&target, Some(&index)),
        Ok(expected)
    );
}

#[test]
fn initial_config_refuses_nonempty_different_even_when_lookup_observed_no_row() {
    for observed in [false, true] {
        let store = MetaStore::test_memory();
        let target = requested();
        let mut existing = target.clone();
        existing.config_options =
            Some(json!({"choices":["selected-b"],"_farfoldService":{"kind":"existing"}}));
        store.upsert_session(&existing).unwrap();
        assert_eq!(
            store.save_initial_session_config(&target, observed.then_some(&existing)),
            Err(InitialConfigError::Changed)
        );
        assert_eq!(store.get_session(&target.id).unwrap(), Some(existing));
    }
}

#[test]
fn initial_config_refuses_changed_identity_creation_archive_and_disappearance() {
    for case in [
        "agent",
        "cwd",
        "native",
        "created",
        "archived",
        "removed",
        "duplicate",
    ] {
        let store = MetaStore::test_memory();
        let target = requested();
        let mut original = target.clone();
        original.config_options = None;
        store.upsert_session(&original).unwrap();
        let mut changed = original.clone();
        match case {
            "agent" => changed.agent_id = "other".into(),
            "cwd" => changed.cwd = "/other".into(),
            "native" => changed.native_session_id = Some("other".into()),
            "created" => {
                store
                    .lock()
                    .unwrap()
                    .execute("UPDATE sessions SET created_at=999", [])
                    .unwrap();
            }
            "archived" => changed.archived = true,
            "removed" => {
                store
                    .lock()
                    .unwrap()
                    .execute("DELETE FROM sessions", [])
                    .unwrap();
            }
            "duplicate" => {
                let mut duplicate = original.clone();
                duplicate.id = "another-key".into();
                store.upsert_session(&duplicate).unwrap();
            }
            _ => unreachable!(),
        }
        if matches!(case, "agent" | "cwd" | "native" | "archived") {
            store.upsert_session(&changed).unwrap();
        }
        let before = store.list_sessions().unwrap();
        assert_eq!(
            store.save_initial_session_config(&target, Some(&original)),
            Err(InitialConfigError::Changed),
            "{case}"
        );
        assert_eq!(store.list_sessions().unwrap(), before, "{case}");
    }
}

#[test]
fn initial_config_preserves_dismissals_and_pending_even_without_a_row() {
    for case in ["dismissed", "moved-dismissal", "pending"] {
        let store = MetaStore::test_memory();
        let target = requested();
        match case {
            "dismissed" => store.dismiss_session(&target.id).unwrap(),
            "moved-dismissal" => store
                .dismiss_session(&MetaStore::dismissed_id("agent", "/previous", "native"))
                .unwrap(),
            "pending" => {
                // Deliberately malformed/orphaned legacy marker. The ordinary
                // settings API rightly refuses writes to this protected key.
                store
                    .lock()
                    .unwrap()
                    .execute(
                        "INSERT INTO settings(key,value) VALUES (?1,?2)",
                        params![
                            mcp_pending::key(&target.id),
                            json!({"unresolved":true}).to_string()
                        ],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let pending = store.get_setting(&mcp_pending::key(&target.id)).unwrap();
        let dismissed = store.list_dismissed().unwrap();
        assert_eq!(
            store.save_initial_session_config(&target, None),
            Err(InitialConfigError::Changed),
            "{case}"
        );
        assert!(store.get_session(&target.id).unwrap().is_none());
        assert_eq!(
            store.get_setting(&mcp_pending::key(&target.id)).unwrap(),
            pending
        );
        assert_eq!(store.list_dismissed().unwrap(), dismissed);
    }
}

#[test]
fn initial_config_sql_failure_rolls_back_null_fill() {
    let store = MetaStore::test_memory();
    let target = requested();
    let mut index = target.clone();
    index.config_options = None;
    store.upsert_session(&index).unwrap();
    store.lock().unwrap().execute_batch("CREATE TRIGGER fail_initial BEFORE UPDATE OF config_options ON sessions BEGIN SELECT RAISE(FAIL,'test'); END;").unwrap();
    assert_eq!(
        store.save_initial_session_config(&target, Some(&index)),
        Err(InitialConfigError::SaveFailed)
    );
    assert_eq!(store.get_session(&target.id).unwrap(), Some(index));
}

#[test]
fn initial_config_serializes_two_competing_baselines_without_overwrite() {
    let store = MetaStore::test_memory();
    let first = requested();
    let mut second = first.clone();
    second.config_options = Some(json!({"choices":["selected-b"]}));
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let threads = [first.clone(), second.clone()].map(|row| {
        let store = store.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            store.save_initial_session_config(&row, None)
        })
    });
    barrier.wait();
    let results = threads.map(|thread| thread.join().unwrap());
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| **result == Err(InitialConfigError::Changed))
            .count(),
        1
    );
    let winner = results.into_iter().find_map(Result::ok).unwrap();
    assert_eq!(store.get_session(&first.id).unwrap(), Some(winner));
}
