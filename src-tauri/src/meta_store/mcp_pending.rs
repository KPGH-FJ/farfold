//! One unresolved user-requested tool change on an existing conversation.
//! Only comparison digests are retained; no Agent configuration or tool URL.
use super::*;

pub(crate) const PREFIX: &str = "mcpPending.v1:";
pub(crate) const BLOCKED: &str = "SESSION_TOOL_CHANGE_PENDING";
const INVALID: &str = "工具变更记录无法确认，原记录已保留，请重新核对";
const CHANGED: &str = "工具变更记录或对话已变化，请重新核对";
const MAX_BYTES: i64 = 4096;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Action {
    Add,
    Remove,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Pending {
    pub operation_id: String,
    pub action: Action,
    pub before_digest: String,
    pub expected_digest: Option<String>,
    pub target_digest: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    version: u8,
    created_at: i64,
    change: Pending,
}

pub(super) fn key(row_id: &str) -> String {
    format!("{PREFIX}{row_id}")
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid(change: &Pending) -> bool {
    !change.operation_id.is_empty()
        && change.operation_id.len() <= 128
        && change
            .operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        && valid_digest(&change.before_digest)
        && valid_digest(&change.target_digest)
        && match (&change.action, &change.expected_digest) {
            (Action::Add, None) => true,
            (Action::Remove, Some(digest)) => valid_digest(digest),
            _ => false,
        }
}

fn validate_owner(connection: &Connection, expected: &SessionRow) -> Result<(), String> {
    let actual = connection
        .query_row(
            "SELECT agent_id,cwd,native_session_id,created_at FROM sessions WHERE id=?1",
            [&expected.id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(sqlite_receipt)?;
    if expected
        .native_session_id
        .as_ref()
        .is_none_or(String::is_empty)
        || actual
            != Some((
                expected.agent_id.clone(),
                expected.cwd.clone(),
                expected.native_session_id.clone(),
                expected.created_at,
            ))
    {
        return Err(CHANGED.into());
    }
    let config: Option<String> = connection
        .query_row(
            "SELECT config_options FROM sessions WHERE id=?1",
            [&expected.id],
            |row| row.get(0),
        )
        .map_err(sqlite_receipt)?;
    let config = config
        .map(|raw| serde_json::from_str::<serde_json::Value>(&raw))
        .transpose()
        .map_err(|_| CHANGED)?;
    if config != expected.config_options {
        return Err(CHANGED.into());
    }
    Ok(())
}

fn read(connection: &Connection, row_id: &str) -> Result<Option<Pending>, String> {
    let raw: Option<Option<String>> = connection
        .query_row(
            "SELECT CASE WHEN length(CAST(value AS BLOB)) <= ?2 THEN value END FROM settings WHERE key=?1",
            params![key(row_id), MAX_BYTES],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_receipt)?;
    let Some(raw) = raw else { return Ok(None) };
    let saved: Saved = serde_json::from_str(&raw.ok_or(INVALID)?).map_err(|_| INVALID)?;
    let created: Option<i64> = connection
        .query_row(
            "SELECT created_at FROM sessions WHERE id=?1",
            [row_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_receipt)?;
    if saved.version != 1 || created != Some(saved.created_at) || !valid(&saved.change) {
        return Err(INVALID.into());
    }
    Ok(Some(saved.change))
}

pub(super) fn ensure_absent(connection: &Connection, row_id: &str) -> Result<(), String> {
    if connection
        .query_row("SELECT 1 FROM settings WHERE key=?1", [key(row_id)], |_| {
            Ok(())
        })
        .optional()
        .map_err(sqlite_receipt)?
        .is_some()
    {
        return Err(BLOCKED.into());
    }
    Ok(())
}

pub(super) fn ensure_none(db: &Connection) -> Result<(), String> {
    let any = db
        .query_row(
            "SELECT 1 FROM settings WHERE substr(key,1,?1)=?2 LIMIT 1",
            params![PREFIX.len() as i64, PREFIX],
            |_| Ok(()),
        )
        .optional()
        .map_err(sqlite_receipt)?;
    if any.is_some() {
        return Err(BLOCKED.into());
    }
    Ok(())
}

pub(super) fn ensure_agent_ready(db: &Connection, agent: &str) -> Result<(), String> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings p JOIN sessions s ON p.key=?1||s.id WHERE s.agent_id=?2)",
        params![PREFIX, agent], |row| row.get(0),
    ).map_err(sqlite_receipt)?;
    if exists {
        return Err(BLOCKED.into());
    }
    Ok(())
}

impl MetaStore {
    pub(crate) fn require_mcp_agent_ready(&self, agent: &str) -> Result<(), String> {
        ensure_agent_ready(&*self.lock()?, agent)
    }

    pub(crate) fn require_mcp_service_ready(&self, service: &str) -> Result<(), String> {
        let db = self.lock()?;
        let mut query = db
            .prepare("SELECT s.config_options FROM settings p JOIN sessions s ON p.key=?1||s.id")
            .map_err(sqlite_receipt)?;
        let rows = query
            .query_map([PREFIX], |row| row.get::<_, Option<String>>(0))
            .map_err(sqlite_receipt)?;
        for raw in rows {
            if let Some(raw) = raw.map_err(sqlite_receipt)? {
                let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| BLOCKED)?;
                if value
                    .pointer("/_farfoldService/kind")
                    .and_then(serde_json::Value::as_str)
                    == Some("configured")
                    && value
                        .pointer("/_farfoldService/identity/id")
                        .and_then(serde_json::Value::as_str)
                        .is_none_or(|id| id == service)
                {
                    return Err(BLOCKED.into());
                }
            }
        }
        Ok(())
    }
    pub(crate) fn mcp_pending(&self, row_id: &str) -> Result<Option<Pending>, String> {
        read(&*self.lock()?, row_id)
    }

    pub(crate) fn require_mcp_ready(&self, row_id: &str) -> Result<(), String> {
        ensure_absent(&*self.lock()?, row_id)
    }

    /// Admission for destructive replacement/reset must precede any file or
    /// secure-storage mutation. A missing/invalid value is still unresolved.
    pub(crate) fn require_no_mcp_pending(&self) -> Result<(), String> {
        ensure_none(&*self.lock()?)
    }

    /// This must finish successfully before the official mutation is sent.
    pub(crate) fn begin_mcp_pending(
        &self,
        row: &SessionRow,
        change: &Pending,
    ) -> Result<(), String> {
        crate::credentials::with_stable_mcp_source(self, row, || {
            self.begin_mcp_pending_stable(row, change)
        })
    }

    fn begin_mcp_pending_stable(&self, row: &SessionRow, change: &Pending) -> Result<(), String> {
        if !valid(change) {
            return Err(INVALID.into());
        }
        let mut db = self.lock()?;
        self.ensure_worktree_write_available()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_receipt)?;
        validate_owner(&tx, row)?;
        ensure_absent(&tx, &row.id)?;
        let value = serde_json::to_string(&Saved {
            version: 1,
            created_at: row.created_at,
            change: change.clone(),
        })
        .map_err(|_| INVALID)?;
        tx.execute(
            "INSERT INTO settings(key,value) VALUES (?1,?2)",
            params![key(&row.id), value],
        )
        .map_err(sqlite_receipt)?;
        tx.commit().map_err(sqlite_receipt)
    }

    /// Exact comparison prevents a stale completion from clearing a later
    /// change. No success is returned until the durable deletion commits.
    pub(crate) fn clear_mcp_pending(
        &self,
        row: &SessionRow,
        expected: &Pending,
    ) -> Result<(), String> {
        let mut db = self.lock()?;
        self.ensure_worktree_write_available()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_receipt)?;
        validate_owner(&tx, row)?;
        if read(&tx, &row.id)?.as_ref() != Some(expected) {
            return Err(CHANGED.into());
        }
        let changed = tx
            .execute("DELETE FROM settings WHERE key=?1", [key(&row.id)])
            .map_err(sqlite_receipt)?;
        if changed != 1 {
            return Err(CHANGED.into());
        }
        tx.commit().map_err(sqlite_receipt)
    }
}

#[cfg(test)]
#[path = "mcp_pending_tests.rs"]
mod tests;
