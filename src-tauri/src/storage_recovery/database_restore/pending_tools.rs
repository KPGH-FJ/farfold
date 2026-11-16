//! A readable pending tool change cannot be erased by installing an older
//! backup. Read only stable captured bytes, never open the production DB.
use super::*;

pub(super) fn reject_known_pending(path: &Path) -> Result<(), Failure> {
    if !files::exists(path)? {
        return Ok(());
    }
    let temporary = tempfile::tempdir().map_err(files::storage)?;
    let directory = temporary.path().canonicalize().map_err(files::storage)?;
    let copy = candidate::capture(path, &directory)?;
    let connection = match rusqlite::Connection::open_with_flags(
        copy,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    ) {
        Ok(connection) => connection,
        // Existing recovery also accepts damaged non-SQLite originals. Such
        // bytes do not establish that a tool change was absent or present.
        Err(_) => return Ok(()),
    };
    let prefix = crate::meta_store::mcp_pending::PREFIX;
    let present = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE substr(key,1,?1)=?2)",
        rusqlite::params![prefix.len() as i64, prefix],
        |row| row.get::<_, bool>(0),
    );
    if matches!(present, Ok(true)) {
        return Err(Failure::new("pendingTools"));
    }
    // No new interpretation or migration of corrupt original settings. The
    // ordinary recovery flow still retains every original byte before moving.
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::meta_store::MetaStore;

    #[test]
    fn old_backup_cannot_replace_a_known_pending_change_before_or_after_preview() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("current.sqlite3");
        let source = root.join("old.sqlite3");
        let current = MetaStore::open(&path).unwrap();
        let candidate = MetaStore::open(&source).unwrap();
        drop(candidate);
        let mut state = State::default();
        let preview = state.preview(&path, &source).unwrap();
        let connection = rusqlite::Connection::open(&path).unwrap();
        // Presence, even a corrupt pending value, must not be interpreted as
        // a completed operation and erased by an unrelated backup choice.
        connection
            .execute(
                "INSERT INTO settings(key,value) VALUES ('mcpPending.v1:one','{broken')",
                [],
            )
            .unwrap();
        drop(connection);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            State::default().preview(&path, &source).unwrap_err().code,
            "pendingTools"
        );
        assert_eq!(
            state.apply(&path, &preview.id).unwrap_err().code,
            "pendingTools"
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(!record(&path).unwrap().exists());
        assert!(!container(&path).unwrap().exists());
        assert!(current.require_no_mcp_pending().is_err());
    }

    #[test]
    fn ordinary_no_pending_and_unreadable_originals_keep_existing_recovery_scope() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("current.sqlite3");
        let store = MetaStore::open(&path).unwrap();
        store
            .set_setting("other", &serde_json::json!(true))
            .unwrap();
        drop(store);
        reject_known_pending(&path).unwrap();
        std::fs::write(&path, b"previously damaged original").unwrap();
        reject_known_pending(&path).unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"previously damaged original"
        );
    }
}
