use super::*;
use crate::storage_recovery::restore::{KEYS, SavedValues};
use std::collections::BTreeMap;

fn values(connection: &Connection) -> Result<SavedValues, String> {
    KEYS.into_iter()
        .map(|key| {
            let raw = connection
                .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .map_err(sqlite_receipt)?;
            Ok((key.to_string(), raw))
        })
        .collect()
}
impl MetaStore {
    pub(crate) fn restore_values(&self) -> Result<SavedValues, String> {
        let connection = self.lock()?;
        values(&connection)
    }
    pub(crate) fn restore_startup_values(
        &self,
        baseline: &SavedValues,
        selected: &BTreeMap<String, String>,
    ) -> Result<(), String> {
        if selected.is_empty()
            || selected.keys().any(|key| !KEYS.contains(&key.as_str()))
            || baseline.len() != KEYS.len()
            || KEYS.iter().any(|key| !baseline.contains_key(*key))
        {
            return Err("RESTORE_INVALID_KEYS".into());
        }
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_receipt)?;
        if values(&transaction)? != *baseline {
            return Err("RESTORE_BASELINE_CHANGED".into());
        }
        for (key, raw) in selected {
            transaction.execute("INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, raw]).map_err(sqlite_receipt)?;
        }
        transaction.commit().map_err(sqlite_receipt)
    }
}
