//! Admit one confirmed fork identity without overwriting any existing index.
use super::*;

impl MetaStore {
    pub(crate) fn insert_fork_session(&self, row: &SessionRow) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "未能保存新对话")?;
        let collision: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1 OR (agent_id = ?2 AND native_session_id = ?3)) OR EXISTS(SELECT 1 FROM dismissed_sessions WHERE id = ?1)",
                params![row.id, row.agent_id, row.native_session_id],
                |r| r.get(0),
            )
            .map_err(|_| "未能检查新对话")?;
        if collision {
            return Err("FORK_IDENTITY_CONFLICT".into());
        }
        // Tombstones store a historical composite key, not separate identity
        // fields. Treat a matching source prefix/native suffix conservatively
        // as a possible collision; never parse a guessed cwd or revive it.
        let native = row.native_session_id.as_deref().ok_or("未能检查新对话")?;
        let prefix = format!("{}:", row.agent_id);
        let suffix = format!(":{native}");
        {
            let mut statement = transaction
                .prepare("SELECT id FROM dismissed_sessions")
                .map_err(|_| "未能检查新对话")?;
            let mut ids = statement
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|_| "未能检查新对话")?;
            if ids
                .try_fold(false, |found, id| {
                    id.map(|id| found || (id.starts_with(&prefix) && id.ends_with(&suffix)))
                })
                .map_err(|_| "未能检查新对话")?
            {
                return Err("FORK_IDENTITY_CONFLICT".into());
            }
        }
        let config = row
            .config_options
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| "未能保存新对话")?;
        transaction.execute(
            "INSERT INTO sessions (id,agent_id,cwd,native_session_id,title,config_options,pinned,archived,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,0,0,?7,?7)",
            params![row.id,row.agent_id,row.cwd,row.native_session_id,row.title,config,row.created_at],
        ).map_err(|_| "未能保存新对话")?;
        transaction.commit().map_err(|_| "未能保存新对话".into())
    }
}
