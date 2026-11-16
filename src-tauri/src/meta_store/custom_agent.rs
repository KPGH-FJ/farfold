//! Atomic publication after the explicitly protected environment is secured.
use super::*;

impl MetaStore {
    pub(crate) fn publish_custom_agent(
        &self,
        agent: &AgentRow,
        pending_key: &str,
    ) -> Result<(), String> {
        let mut connection = self.lock()?;
        self.ensure_worktree_write_available()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_receipt)?;
        insert_agent_row(&transaction, agent)?;
        transaction
            .execute("DELETE FROM settings WHERE key = ?1", params![pending_key])
            .map_err(sqlite_receipt)?;
        transaction.commit().map_err(sqlite_receipt)
    }

    pub(crate) fn forget_custom_env_pending(&self, key: &str) -> Result<(), String> {
        let connection = self.lock()?;
        self.ensure_worktree_write_available()?;
        connection
            .execute("DELETE FROM settings WHERE key = ?1", params![key])
            .map_err(sqlite_receipt)?;
        Ok(())
    }
}
