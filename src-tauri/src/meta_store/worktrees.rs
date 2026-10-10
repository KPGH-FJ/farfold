//! Raw CAS for the single current worktree intent; interpretation belongs to worktrees.
use super::*;
const KEY: &str = "worktreeLocations.v1";
impl MetaStore {
    pub(crate) fn worktree_raw(&self) -> Result<Option<String>, String> {
        self.lock()?
            .query_row("SELECT value FROM settings WHERE key=?1", [KEY], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sqlite_receipt)
    }
    pub(crate) fn worktree_compare_write(
        &self,
        expected: Option<&str>,
        next: &str,
    ) -> Result<bool, String> {
        let mut c = self.lock()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_receipt)?;
        let raw: Option<String> = tx
            .query_row("SELECT value FROM settings WHERE key=?1", [KEY], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sqlite_receipt)?;
        if raw.as_deref() != expected {
            tx.rollback().map_err(sqlite_receipt)?;
            return Ok(false);
        }
        tx.execute("INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![KEY,next]).map_err(sqlite_receipt)?;
        tx.commit().map_err(sqlite_receipt)?;
        let saved: String = c
            .query_row("SELECT value FROM settings WHERE key=?1", [KEY], |r| {
                r.get(0)
            })
            .map_err(sqlite_receipt)?;
        if saved != next {
            return Err("worktree storage readback differed".into());
        }
        Ok(true)
    }
}
