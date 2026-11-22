use super::MetaStore;
#[cfg(any(target_os = "macos", test))]
use super::SessionRow;
#[cfg(any(target_os = "macos", test))]
use rusqlite::TransactionBehavior;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub(crate) struct Owner {
    pub model: String,
    pub effort: String,
    pub account_digest: String,
}

fn key(index_id: &str) -> String {
    format!("codexAppServer.owner:{index_id}")
}

impl MetaStore {
    pub(crate) fn codex_app_server_owner_for(
        &self,
        agent_id: &str,
        native_id: &str,
        cwd: &str,
    ) -> Result<Option<Owner>, String> {
        let db = self.lock()?;
        let failure = "无法确认对话来源";
        let mut statement = db
            .prepare(
                "SELECT sessions.cwd, settings.value FROM sessions JOIN settings
               ON settings.key='codexAppServer.owner:' || sessions.id
             WHERE sessions.agent_id=?1 AND sessions.native_session_id=?2 LIMIT 2",
            )
            .map_err(|_| failure)?;
        let mut matches = statement
            .query(params![agent_id, native_id])
            .map_err(|_| failure)?;
        let Some(found) = matches.next().map_err(|_| failure)? else {
            return Ok(None);
        };
        let directory: String = found.get(0).map_err(|_| failure)?;
        let owner: String = found.get(1).map_err(|_| failure)?;
        if directory != cwd || matches.next().map_err(|_| failure)?.is_some() {
            return Err(failure.into());
        }
        serde_json::from_str(&owner)
            .map(Some)
            .map_err(|_| failure.into())
    }

    pub(crate) fn codex_app_server_owner(&self, index_id: &str) -> Result<Option<Owner>, String> {
        let owner: Option<String> = self
            .lock()?
            .query_row(
                "SELECT value FROM settings WHERE key=?1",
                [key(index_id)],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "无法确认对话来源")?;
        owner
            .map(|value| serde_json::from_str(&value).map_err(|_| "无法确认对话来源".into()))
            .transpose()
    }

    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn insert_codex_app_server_session(
        &self,
        row: &SessionRow,
        owner: &Owner,
    ) -> Result<(), String> {
        let failure = "未能保存已创建的对话，请检查对话记录";
        let owner = serde_json::to_string(owner).map_err(|_| failure)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| failure)?;
        let inserted = transaction
            .execute(
                "INSERT INTO sessions (id,agent_id,cwd,native_session_id,title,config_options,pinned,archived,created_at,updated_at)
                 SELECT ?1,?2,?3,?4,?5,?6,0,0,?7,?7
                 WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE agent_id=?2 AND native_session_id=?4)
                   AND NOT EXISTS (SELECT 1 FROM dismissed_sessions WHERE id=?1)",
                params![row.id,row.agent_id,row.cwd,row.native_session_id,row.title,
                    row.config_options.as_ref().map(serde_json::Value::to_string),row.created_at],
            )
            .map_err(|_| failure)?;
        if inserted != 1 {
            return Err("已存在同一段对话，请从对话列表打开".into());
        }
        transaction
            .execute(
                "INSERT INTO settings (key,value) VALUES (?1,?2)",
                params![key(&row.id), owner],
            )
            .map_err(|_| failure)?;
        transaction.commit().map_err(|_| failure.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_dedicated_codex_session_does_not_replace_an_acp_session_or_change_folder() {
        let directory = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&directory.path().join("test.sqlite3")).unwrap();
        let mut row = SessionRow {
            id: "codex:/work:native".into(),
            agent_id: "codex".into(),
            cwd: "/work".into(),
            native_session_id: Some("native".into()),
            title: Some("Untitled".into()),
            config_options: Some(json!({"model":"selected"})),
            pinned: false,
            archived: false,
            created_at: 1,
            updated_at: 1,
        };
        let owner = Owner {
            model: "selected".into(),
            effort: "high".into(),
            account_digest: "synthetic".into(),
        };
        store.upsert_session(&row).unwrap();
        assert!(
            store
                .codex_app_server_owner_for("codex", "native", "/work")
                .unwrap()
                .is_none()
        );
        assert!(store.insert_codex_app_server_session(&row, &owner).is_err());
        assert_eq!(store.get_session(&row.id).unwrap(), Some(row.clone()));
        row.id = "codex:/work:owned".into();
        row.native_session_id = Some("owned".into());
        store.insert_codex_app_server_session(&row, &owner).unwrap();
        assert_eq!(store.get_session(&row.id).unwrap(), Some(row));
        assert!(
            store
                .codex_app_server_owner_for("codex", "owned", "/incorrect")
                .is_err()
        );
        assert!(
            store
                .codex_app_server_owner_for("copilot", "owned", "/work")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .codex_app_server_owner_for("codex", "owned", "/work")
                .unwrap()
                .unwrap()
                .model,
            "selected"
        );
    }
}
