use super::*;
use crate::storage_recovery::restore::KEYS;
use std::collections::BTreeMap;
fn setup(path: &Path) -> MetaStore {
    let store = MetaStore::open(path).unwrap();
    for key in KEYS {
        store
            .set_setting(key, &serde_json::json!({"version":1}))
            .unwrap();
    }
    store
}
#[test]
fn startup_restore_read_only_and_full_errors_keep_both_original_values() {
    for read_only in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite3");
        let store = setup(&path);
        let baseline = store.restore_values().unwrap();
        {
            let connection = store.lock().unwrap();
            if read_only {
                connection.pragma_update(None, "query_only", true).unwrap();
            } else {
                let pages: i64 = connection
                    .pragma_query_value(None, "page_count", |r| r.get(0))
                    .unwrap();
                connection
                    .pragma_update(None, "max_page_count", pages)
                    .unwrap();
            }
        }
        let value = serde_json::json!({"version":1,"text":"x".repeat(100_000)}).to_string();
        let error = store
            .restore_startup_values(
                &baseline,
                &BTreeMap::from([(KEYS[0].into(), value), (KEYS[1].into(), "null".into())]),
            )
            .unwrap_err();
        assert!(
            error.starts_with(if read_only {
                "FARFOLD_STORAGE:readOnly:"
            } else {
                "FARFOLD_STORAGE:full:"
            }),
            "{error}"
        );
        assert_eq!(store.restore_values().unwrap(), baseline);
        drop(store);
        assert_eq!(
            MetaStore::open(&path).unwrap().restore_values().unwrap(),
            baseline
        );
    }
}
#[test]
fn startup_restore_compares_missing_empty_and_null_raw_values_without_normalizing() {
    let dir = tempfile::tempdir().unwrap();
    let store = setup(&dir.path().join("db.sqlite3"));
    for (before, after) in [
        (None, Some("")),
        (Some(""), Some("null")),
        (Some("null"), None),
    ] {
        let connection = store.lock().unwrap();
        connection
            .execute("DELETE FROM settings WHERE key=?1", [KEYS[1]])
            .unwrap();
        if let Some(raw) = before {
            connection
                .execute("INSERT INTO settings VALUES (?1,?2)", params![KEYS[1], raw])
                .unwrap();
        }
        drop(connection);
        let baseline = store.restore_values().unwrap();
        let connection = store.lock().unwrap();
        connection
            .execute("DELETE FROM settings WHERE key=?1", [KEYS[1]])
            .unwrap();
        if let Some(raw) = after {
            connection
                .execute("INSERT INTO settings VALUES (?1,?2)", params![KEYS[1], raw])
                .unwrap();
        }
        drop(connection);
        let current = store.restore_values().unwrap();
        assert_eq!(
            store
                .restore_startup_values(
                    &baseline,
                    &BTreeMap::from([(KEYS[0].into(), "null".into())])
                )
                .unwrap_err(),
            "RESTORE_BASELINE_CHANGED"
        );
        assert_eq!(store.restore_values().unwrap(), current);
    }
    store.lock().unwrap().execute_batch("ALTER TABLE settings RENAME TO old_settings; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings SELECT key,value FROM old_settings; DROP TABLE old_settings; INSERT OR REPLACE INTO settings VALUES ('agentSetup.v1',NULL);").unwrap();
    assert!(store.restore_values().is_err());
}
