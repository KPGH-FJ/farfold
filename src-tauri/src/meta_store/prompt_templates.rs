//! Compare-and-set for one user-owned template setting, never Agent configuration.
use super::*;
use serde_json::Value;

const KEY: &str = "promptTemplates.v1";
const INVALID: &str = "模板格式无法识别，原内容已保留。";

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum TemplateWriteReceipt {
    Saved,
    Conflict,
    Rejected { message: String },
}
fn rejected(message: impl Into<String>) -> TemplateWriteReceipt {
    TemplateWriteReceipt::Rejected {
        message: message.into(),
    }
}
fn valid_document(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != 2
        || object.get("version") != Some(&Value::from(1))
        || value.to_string().len() > 1024 * 1024
    {
        return false;
    }
    let Some(items) = object.get("items").and_then(Value::as_array) else {
        return false;
    };
    if items.len() > 100 {
        return false;
    }
    let mut ids = std::collections::HashSet::new();
    items.iter().all(|item| {
        let Some(item) = item.as_object() else {
            return false;
        };
        let (Some(id), Some(label), Some(text)) = (
            item.get("id").and_then(Value::as_str),
            item.get("label").and_then(Value::as_str),
            item.get("text").and_then(Value::as_str),
        ) else {
            return false;
        };
        item.len() == 3
            && !id.trim().is_empty()
            && id.encode_utf16().count() <= 128
            && !id.chars().any(|ch| ch <= '\u{001f}')
            && ids.insert(id)
            && !label.trim().is_empty()
            && label.encode_utf16().count() <= 80
            && !text.trim().is_empty()
            && text.encode_utf16().count() <= 32000
    })
}
fn rollback_rejected(
    transaction: rusqlite::Transaction<'_>,
    message: String,
) -> Result<TemplateWriteReceipt, String> {
    transaction.rollback().map_err(sqlite_receipt)?;
    Ok(rejected(message))
}

impl MetaStore {
    pub(crate) fn save_prompt_templates(
        &self,
        expected: &Value,
        next: &Value,
    ) -> Result<TemplateWriteReceipt, String> {
        if !valid_document(next) || (!expected.is_null() && !valid_document(expected)) {
            return Ok(rejected(INVALID));
        }
        let mut connection = match self.lock() {
            Ok(connection) => connection,
            Err(error) => return Ok(rejected(error)),
        };
        let transaction = match connection.transaction_with_behavior(TransactionBehavior::Immediate)
        {
            Ok(transaction) => transaction,
            Err(error) => return Ok(rejected(sqlite_receipt(error))),
        };
        let raw: Option<String> = match transaction
            .query_row("SELECT value FROM settings WHERE key=?1", [KEY], |row| {
                row.get(0)
            })
            .optional()
        {
            Ok(raw) => raw,
            Err(error) => return rollback_rejected(transaction, sqlite_receipt(error)),
        };
        let current = match raw
            .map(|raw| serde_json::from_str::<Value>(&raw))
            .transpose()
        {
            Ok(current) => current,
            Err(_) => return rollback_rejected(transaction, INVALID.into()),
        };
        if current.as_ref().is_some_and(|value| !valid_document(value)) {
            return rollback_rejected(transaction, INVALID.into());
        }
        let matches = match current {
            Some(ref current) => current == expected,
            None => expected.is_null(),
        };
        if !matches {
            transaction.rollback().map_err(sqlite_receipt)?;
            return Ok(TemplateWriteReceipt::Conflict);
        }
        if let Err(error) = transaction.execute("INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![KEY, next.to_string()]) {
            return rollback_rejected(transaction, sqlite_receipt(error));
        }
        // A failed COMMIT does not become a claimed rejection. The caller must
        // read back and retain uncertainty if it cannot confirm the intended value.
        transaction.commit().map_err(sqlite_receipt)?;
        Ok(TemplateWriteReceipt::Saved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn document(text: &str) -> Value {
        json!({"version":1,"items":[{"id":"a","label":"模板","text":text}]})
    }
    fn store() -> MetaStore {
        MetaStore::test_memory()
    }

    #[test]
    fn template_cas_creates_updates_and_preserves_unrelated_settings() {
        let store = store();
        let first = document("first");
        let second = document("second");
        store
            .set_setting("unrelated", &json!({"keep":true}))
            .unwrap();
        assert_eq!(
            store.save_prompt_templates(&Value::Null, &first).unwrap(),
            TemplateWriteReceipt::Saved
        );
        assert_eq!(
            store.save_prompt_templates(&first, &second).unwrap(),
            TemplateWriteReceipt::Saved
        );
        assert_eq!(store.get_setting(KEY).unwrap(), Some(second));
        assert_eq!(
            store.get_setting("unrelated").unwrap(),
            Some(json!({"keep":true}))
        );
    }
    #[test]
    fn template_cas_rejects_late_or_missing_baseline_without_overwriting() {
        let store = store();
        let first = document("first");
        let second = document("second");
        store.set_setting(KEY, &first).unwrap();
        assert_eq!(
            store.save_prompt_templates(&first, &second).unwrap(),
            TemplateWriteReceipt::Saved
        );
        assert_eq!(
            store
                .save_prompt_templates(&first, &document("late"))
                .unwrap(),
            TemplateWriteReceipt::Conflict
        );
        assert_eq!(
            store
                .save_prompt_templates(&Value::Null, &document("new"))
                .unwrap(),
            TemplateWriteReceipt::Conflict
        );
        assert_eq!(store.get_setting(KEY).unwrap(), Some(second));
    }
    #[test]
    fn template_cas_protects_future_malformed_and_null_stored_values() {
        for existing in [
            json!({"version":2,"items":[]}),
            json!({"version":1,"items":[],"future":true}),
            Value::Null,
        ] {
            let store = store();
            store.set_setting(KEY, &existing).unwrap();
            assert!(matches!(
                store
                    .save_prompt_templates(&existing, &document("replacement"))
                    .unwrap(),
                TemplateWriteReceipt::Rejected { .. }
            ));
            assert_eq!(store.get_setting(KEY).unwrap(), Some(existing));
        }
        let store = store();
        store
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO settings(key,value) VALUES (?1,?2)",
                params![KEY, "broken-json"],
            )
            .unwrap();
        assert!(matches!(
            store
                .save_prompt_templates(&Value::Null, &document("replacement"))
                .unwrap(),
            TemplateWriteReceipt::Rejected { .. }
        ));
        let raw: String = store
            .lock()
            .unwrap()
            .query_row("SELECT value FROM settings WHERE key=?1", [KEY], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(raw, "broken-json");
    }
    #[test]
    fn template_cas_validates_limits_and_complete_schema_before_writing() {
        let mut examples = vec![
            json!({"version":2,"items":[]}),
            json!({"version":1,"items":[],"extra":true}),
            document(" "),
        ];
        let mut invalid = document("body");
        invalid["items"][0]["extra"] = json!(true);
        examples.push(invalid);
        let mut long_label = document("body");
        long_label["items"][0]["label"] = json!("x".repeat(81));
        examples.push(long_label);
        examples.push(document(&"x".repeat(32001)));
        let mut duplicates = document("body");
        duplicates["items"] = json!([
            duplicates["items"][0].clone(),
            duplicates["items"][0].clone()
        ]);
        examples.push(duplicates);
        examples.push(json!({"version":1,"items":(0..101).map(|n|json!({"id":n.to_string(),"label":"a","text":"a"})).collect::<Vec<_>>()}));
        examples.push(json!({"version":1,"items":(0..20).map(|n|json!({"id":n.to_string(),"label":"a","text":"中".repeat(32000)})).collect::<Vec<_>>()}));
        for next in examples {
            let store = store();
            assert!(matches!(
                store.save_prompt_templates(&Value::Null, &next).unwrap(),
                TemplateWriteReceipt::Rejected { .. }
            ));
            assert!(store.get_setting(KEY).unwrap().is_none());
        }
    }
    #[test]
    fn template_cas_only_one_concurrent_writer_can_use_the_same_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("metadata.db");
        let first_store = MetaStore::open(&path).unwrap();
        let other_store = MetaStore::open(&path).unwrap();
        let initial = document("first");
        first_store.set_setting(KEY, &initial).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let tasks: Vec<_> = [("a", first_store), ("b", other_store)]
            .into_iter()
            .map(|(text, store)| {
                let barrier = barrier.clone();
                let initial = initial.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store
                        .save_prompt_templates(&initial, &document(text))
                        .unwrap()
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = tasks.into_iter().map(|task| task.join().unwrap()).collect();
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == TemplateWriteReceipt::Saved)
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == TemplateWriteReceipt::Conflict)
                .count(),
            1
        );
    }
    #[test]
    fn template_cas_read_only_failure_preserves_saved_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("metadata.db");
        let writable = MetaStore::open(&path).unwrap();
        let first = document("first");
        writable.set_setting(KEY, &first).unwrap();
        drop(writable);
        let connection =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let store = MetaStore {
            connection: Arc::new(Mutex::new(connection)),
            maintenance: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        };
        let TemplateWriteReceipt::Rejected { message: error } = store
            .save_prompt_templates(&first, &document("second"))
            .unwrap()
        else {
            panic!("expected confirmed rejection");
        };
        assert!(error.starts_with("FARFOLD_STORAGE:readOnly:"));
        assert_eq!(store.get_setting(KEY).unwrap(), Some(first));
    }
}
