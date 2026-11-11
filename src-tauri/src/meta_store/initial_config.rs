//! First confirmed configuration on a live, previously unestablished dialog.
//! The original index is never replaced or rewritten with a different baseline.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InitialConfigError {
    Changed,
    SaveFailed,
}

impl MetaStore {
    pub(crate) fn save_initial_session_config(
        &self,
        requested: &SessionRow,
        previous: Option<&SessionRow>,
    ) -> Result<SessionRow, InitialConfigError> {
        use InitialConfigError::{Changed, SaveFailed};
        let native = requested
            .native_session_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or(Changed)?;
        let next = requested.config_options.as_ref().ok_or(Changed)?;
        if requested.id != Self::dismissed_id(&requested.agent_id, &requested.cwd, native)
            || requested.archived
        {
            return Err(Changed);
        }
        let mut connection = self.lock().map_err(|_| SaveFailed)?;
        self.ensure_worktree_write_available()
            .map_err(|_| SaveFailed)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SaveFailed)?;
        mcp_pending::ensure_absent(&tx, &requested.id).map_err(|_| Changed)?;
        // Dismissals use composite keys. Preserve even a historical matching
        // native identity at a different directory; do not revive it implicitly.
        let prefix = format!("{}:", requested.agent_id);
        let suffix = format!(":{native}");
        let dismissed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM dismissed_sessions WHERE id=?1 OR (substr(id,1,length(?2))=?2 AND substr(id,-length(?3))=?3))",
            params![requested.id, prefix, suffix], |row| row.get(0),
        ).map_err(|_| SaveFailed)?;
        if dismissed {
            return Err(Changed);
        }
        let rows = {
            let mut query = tx.prepare(
                "SELECT id,agent_id,cwd,native_session_id,title,config_options,pinned,archived,created_at,updated_at FROM sessions WHERE id=?1 OR (agent_id=?2 AND native_session_id=?3)",
            ).map_err(|_| SaveFailed)?;
            query
                .query_map(
                    params![requested.id, requested.agent_id, native],
                    row_to_session,
                )
                .map_err(|_| SaveFailed)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| SaveFailed)?
        };
        if rows.len() > 1 {
            return Err(Changed);
        }
        let existing = rows.into_iter().next();
        if let Some(expected) = previous {
            let Some(actual) = &existing else {
                return Err(Changed);
            };
            if expected.id != actual.id
                || expected.agent_id != actual.agent_id
                || expected.cwd != actual.cwd
                || expected.native_session_id != actual.native_session_id
                || expected.created_at != actual.created_at
                || (expected.config_options != actual.config_options
                    && !(expected.config_options.is_none()
                        && actual.config_options.as_ref() == Some(next)))
            {
                return Err(Changed);
            }
        }
        let saved = if let Some(mut actual) = existing {
            if actual.id != requested.id
                || actual.agent_id != requested.agent_id
                || actual.cwd != requested.cwd
                || actual.native_session_id != requested.native_session_id
                || actual.archived
            {
                return Err(Changed);
            }
            match &actual.config_options {
                Some(config) if config != next => return Err(Changed),
                Some(_) => {} // Exact same baseline: preserve every stored field.
                None => {
                    let count = tx.execute("UPDATE sessions SET config_options=?1 WHERE id=?2 AND config_options IS NULL", params![next.to_string(), actual.id]).map_err(|_| SaveFailed)?;
                    if count != 1 {
                        return Err(Changed);
                    }
                    actual.config_options = Some(next.clone());
                }
            }
            actual
        } else {
            tx.execute("INSERT INTO sessions (id,agent_id,cwd,native_session_id,title,config_options,pinned,archived,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,0,0,?7,?7)",
                params![requested.id, requested.agent_id, requested.cwd, native, requested.title, next.to_string(), requested.created_at]).map_err(|_| SaveFailed)?;
            let mut saved = requested.clone();
            saved.pinned = false;
            saved.updated_at = saved.created_at;
            saved
        };
        tx.commit().map_err(|_| SaveFailed)?;
        Ok(saved)
    }
}

#[cfg(test)]
#[path = "initial_config_tests.rs"]
mod tests;
