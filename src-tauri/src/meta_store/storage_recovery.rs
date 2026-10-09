use super::*;
use std::io::Read;

impl MetaStore {
    /// SQLite's backup includes committed WAL pages while serializing this
    /// process's writes. Raw settings strings (including invalid JSON) survive.
    pub(crate) fn export_snapshot(&self, destination: &Path) -> Result<(), String> {
        if destination.exists() {
            return Err("保存位置已有文件，请选择新的位置".into());
        }
        let connection = self.lock()?;
        connection
            .backup(rusqlite::MAIN_DB, destination, None)
            .map_err(sqlite_receipt)?;
        // Verify SQLite structure, not application fields: an unreadable draft
        // must be retained verbatim for later recovery.
        let copy =
            Connection::open_with_flags(destination, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(sqlite_receipt)?;
        let result: String = copy
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(sqlite_receipt)?;
        if result != "ok" {
            return Err("恢复副本尚未通过完整性检查".into());
        }
        std::fs::OpenOptions::new()
            .write(true)
            .open(destination)
            .and_then(|file| file.sync_all())
            .map_err(crate::storage_recovery::io_receipt)
    }
}

/// An existing DB must be readable and structurally intact before setup writes.
/// Semantic draft validation is separate and never rewrites saved strings.
pub(super) fn check_existing(path: &Path) -> Result<bool, String> {
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !crate::storage_recovery::existing_material(path)?.is_empty() {
                return Err("FARFOLD_STORAGE:missing:主资料文件缺失，仍保留恢复材料".into());
            }
            return Ok(false);
        }
        Err(error) => return Err(crate::storage_recovery::io_receipt(error)),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("FARFOLD_STORAGE:unknown:资料位置不是普通文件".into());
    }
    let mut header = [0u8; 16];
    let mut file = std::fs::File::open(path).map_err(io_receipt)?;
    if metadata.len() < 100 {
        return Err("FARFOLD_STORAGE:corrupt:资料文件无法读取".into());
    }
    file.read_exact(&mut header).map_err(io_receipt)?;
    if header != *b"SQLite format 3\0" {
        return Err("FARFOLD_STORAGE:corrupt:资料文件无法读取".into());
    }
    if metadata.permissions().readonly() {
        return Err("FARFOLD_STORAGE:readOnly:资料位置处于只读状态".into());
    }
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(sqlite_receipt)?;
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(sqlite_receipt)?;
    if result != "ok" {
        return Err("FARFOLD_STORAGE:corrupt:资料文件未通过完整性检查".into());
    }
    Ok(true)
}

pub(super) fn open_connection(path: &Path, existing: bool) -> Result<Connection, String> {
    let mut flags = rusqlite::OpenFlags::default();
    if existing {
        flags.remove(rusqlite::OpenFlags::SQLITE_OPEN_CREATE);
    }
    Connection::open_with_flags(path, flags).map_err(sqlite_receipt)
}
