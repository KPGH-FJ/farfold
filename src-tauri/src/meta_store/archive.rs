//! Archive metadata and saved unsent input share the existing SQLite transaction.
use super::{MetaStore, SessionRow, now_millis, row_to_session};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;

impl MetaStore {
    /// These edits must never write a previously read archive flag back after
    /// the archive admission check has serialized a newer decision.
    pub(crate) fn edit_session_metadata(
        &self,
        id: &str,
        title: Option<&str>,
        pinned: Option<bool>,
    ) -> Result<SessionRow, String> {
        self.lock()?
            .query_row(
                "UPDATE sessions SET title = coalesce(?2, title), pinned = coalesce(?3, pinned),
             updated_at = max(updated_at, ?4) WHERE id = ?1
             RETURNING id, agent_id, cwd, native_session_id, title, config_options,
             pinned, archived, created_at, updated_at",
                params![id, title, pinned, now_millis()],
                row_to_session,
            )
            .optional()
            .map_err(|_| "未能更新对话，请重试")?
            .ok_or_else(|| "未找到此对话".into())
    }

    pub(crate) fn archive_session_row(
        &self,
        id: &str,
        archived: bool,
    ) -> Result<SessionRow, String> {
        self.archive_row(id, archived, None)
    }

    /// The caller holds admission for both the recorded and verified directory.
    /// This changes only the original row, never its id or stored directory.
    pub(crate) fn archive_session_row_in_directory(
        &self,
        expected: &SessionRow,
        canonical_cwd: &str,
    ) -> Result<SessionRow, String> {
        self.archive_row(&expected.id, true, Some((expected, canonical_cwd)))
    }

    fn archive_row(
        &self,
        id: &str,
        archived: bool,
        verified: Option<(&SessionRow, &str)>,
    ) -> Result<SessionRow, String> {
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "未能更新归档状态，请重试")?;
        let row = tx
            .query_row(
                "SELECT id, agent_id, cwd, native_session_id, title, config_options,
                    pinned, archived, created_at, updated_at FROM sessions WHERE id = ?1",
                [id],
                row_to_session,
            )
            .optional()
            .map_err(|_| "未能读取对话，请重试")?
            .ok_or("未找到此对话")?;
        if let Some((expected, _)) = verified
            && (row.agent_id != expected.agent_id
                || row.cwd != expected.cwd
                || row.native_session_id != expected.native_session_id)
        {
            return Err("对话状态已变化，请重试".into());
        }
        if let Some((_, captured)) = verified {
            // Runs on the storage worker, after any pump/SQLite wait. A path
            // changed since admission cannot silently select a different owner.
            let directory_error = "暂时无法核对资料文件夹，请确认它可访问后再归档。";
            let current = std::path::Path::new(&row.cwd)
                .canonicalize()
                .map_err(|_| directory_error)?;
            if current != std::path::Path::new(captured) || !current.is_dir() {
                return Err(directory_error.into());
            }
        }
        if archived && let Some(value) = read_saved_work(&tx)? {
            let blocked = "此对话还有未发送内容或发送结果待确认，请处理后再归档";
            if has_unsent_work(&value, &row.id)? {
                return Err(blocked.into());
            }
            if let Some((_, canonical_cwd)) = verified
                && canonical_cwd != row.cwd
                && let Some(native) = &row.native_session_id
                && has_unsent_work(
                    &value,
                    &MetaStore::dismissed_id(&row.agent_id, canonical_cwd, native),
                )?
            {
                return Err(blocked.into());
            }
        }
        let updated = tx
            .query_row(
                "UPDATE sessions SET archived = ?2, updated_at = max(updated_at, ?3)
             WHERE id = ?1 RETURNING id, agent_id, cwd, native_session_id, title,
             config_options, pinned, archived, created_at, updated_at",
                params![id, archived, now_millis()],
                row_to_session,
            )
            .map_err(|_| "未能更新归档状态，请重试")?;
        tx.commit().map_err(|_| "未能保存归档状态，请重试")?;
        Ok(updated)
    }
}

const UNREADABLE: &str = "未能读取未发送内容，请先恢复后再继续";

pub(super) fn read_saved_work(connection: &Connection) -> Result<Option<Value>, String> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'unsentWork.v1'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| UNREADABLE)?;
    raw.map(|value| serde_json::from_str(&value).map_err(|_| UNREADABLE.into()))
        .transpose()
}

pub(super) fn has_unsent_work(saved: &Value, id: &str) -> Result<bool, String> {
    let unreadable = UNREADABLE;
    if saved["version"] != 1 {
        return Err(unreadable.into());
    }
    let composers = saved["composers"].as_object().ok_or(unreadable)?;
    let feedback = saved["feedback"].as_object().ok_or(unreadable)?;
    let queues = saved["queues"].as_object().ok_or(unreadable)?;
    for prefix in ["session:", "queue-edit:", "resend:"] {
        if let Some(draft) = composers.get(&format!("{prefix}{id}")) {
            let draft = draft.as_object().ok_or(unreadable)?;
            let text = draft
                .get("text")
                .and_then(Value::as_str)
                .ok_or(unreadable)?;
            let attachments = draft
                .get("attachments")
                .and_then(Value::as_array)
                .ok_or(unreadable)?;
            if !text.trim().is_empty()
                || !attachments.is_empty()
                || draft.get("sendPending") == Some(&Value::Bool(true))
                || draft.get("queueEdit").is_some_and(|v| !v.is_null())
            {
                return Ok(true);
            }
        }
    }
    // A first send may have no ordinary conversation draft yet. Its saved
    // pointer protects exactly the real target, including after a crash.
    if composers.values().any(|draft| {
        let target = &draft["pendingConversation"];
        match (
            target["agentId"].as_str(),
            target["cwd"].as_str(),
            target["nativeSessionId"].as_str(),
        ) {
            (Some(agent), Some(cwd), Some(native)) => {
                MetaStore::dismissed_id(agent, cwd, native) == id
            }
            _ => false,
        }
    }) {
        return Ok(true);
    }
    if let Some(files) = feedback.get(id) {
        for draft in files.as_object().ok_or(unreadable)?.values() {
            let text = draft["text"].as_str().ok_or(unreadable)?;
            if !text.trim().is_empty() {
                return Ok(true);
            }
        }
    }
    if let Some(queue) = queues.get(id) {
        let unknown = match queue.get("outcomeUnknown") {
            Some(value) => value.as_bool().ok_or(unreadable)?,
            None => false,
        };
        if unknown
            || !queue["blocks"].as_array().ok_or(unreadable)?.is_empty()
            || queue.get("uncertainIndex").is_some_and(|v| !v.is_null())
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn archive_checks_every_owned_unsent_kind_and_keeps_unrelated_rows_available() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        let row = crate::acp_client::session_index::touch_session_row(
            &store,
            "fixture",
            "/fixture",
            "native",
            Some("unchanged"),
            None,
        )
        .unwrap();
        let other = crate::acp_client::session_index::touch_session_row(
            &store, "fixture", "/fixture", "sibling", None, None,
        )
        .unwrap();
        let key = &row.id;
        let mut examples = Vec::new();
        for draft in [
            json!({"text":"retained", "attachments":[]}),
            json!({"text":"", "attachments":[{"kind":"image","data":"image"}]}),
            json!({"text":"", "attachments":[], "sendPending":true}),
        ] {
            for prefix in ["session", "resend"] {
                examples.push(json!({"version":1,"composers":{format!("{prefix}:{key}"):draft},"feedback":{},"queues":{}}));
            }
        }
        examples.extend([
            json!({"version":1,"composers":{format!("queue-edit:{key}"):{"text":"", "attachments":[],"queueEdit":{"index":0,"original":[]}}},"feedback":{},"queues":{}}),
            json!({"version":1,"composers":{},"feedback":{key:{"/file":{"text":"review this"}}},"queues":{}}),
            json!({"version":1,"composers":{},"feedback":{},"queues":{key:{"blocks":[[{"type":"text","text":"next"}]],"uncertainIndex":null}}}),
            json!({"version":1,"composers":{},"feedback":{},"queues":{key:{"blocks":[],"uncertainIndex":0}}}),
            json!({"version":1,"composers":{},"feedback":{},"queues":{key:{"blocks":[],"uncertainIndex":null,"outcomeUnknown":true}}}),
            json!({"version":1,"composers":{"new":{"text":"", "attachments":[],"pendingConversation":{"agentId":"fixture","cwd":"/fixture","nativeSessionId":"native"}}},"feedback":{},"queues":{}}),
        ]);
        for saved in examples {
            store.set_setting("unsentWork.v1", &saved).unwrap();
            assert!(store.archive_session_row(key, true).is_err(), "{saved}");
            assert!(!store.get_session(key).unwrap().unwrap().archived);
            assert!(store.remove_and_dismiss_session(key).is_err(), "{saved}");
            assert!(store.list_dismissed().unwrap().is_empty());
            assert!(store.archive_session_row(&other.id, true).unwrap().archived);
            assert!(
                !store
                    .archive_session_row(&other.id, false)
                    .unwrap()
                    .archived
            );
        }
        let empty = json!({"version":1,"composers":{format!("session:{key}"):{"text":"  ","attachments":[]}},"feedback":{key:{"/file":{"text":" "}}},"queues":{}});
        store.set_setting("unsentWork.v1", &empty).unwrap();
        assert!(store.archive_session_row(key, true).unwrap().archived);
        let actual = store.get_session(key).unwrap().unwrap();
        assert_eq!(actual.title, row.title);
        assert_eq!(actual.config_options, row.config_options);
        // Concurrent independent metadata edits preserve each other's fields,
        // including the archive flag that only its guarded path may change.
        let rename_store = store.clone();
        let rename_id = row.id.clone();
        let rename = std::thread::spawn(move || {
            rename_store
                .edit_session_metadata(&rename_id, Some("renamed"), None)
                .unwrap()
        });
        let pin_store = store.clone();
        let pin_id = row.id.clone();
        let pin = std::thread::spawn(move || {
            pin_store
                .edit_session_metadata(&pin_id, None, Some(true))
                .unwrap()
        });
        store.archive_session_row(key, false).unwrap();
        rename.join().unwrap();
        pin.join().unwrap();
        let edited = store.get_session(key).unwrap().unwrap();
        assert_eq!(edited.title.as_deref(), Some("renamed"));
        assert!(edited.pinned);
        assert!(!edited.archived);
        store
            .set_setting("unsentWork.v1", &json!({"version":2}))
            .unwrap();
        assert!(store.archive_session_row(key, true).is_err());
        assert!(!store.archive_session_row(key, false).unwrap().archived);
    }
}
