use super::{KEYS, MAX_DATABASE_BYTES, MAX_VALUE_BYTES, RestoreFailure, SavedValues};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(crate) fn read_file(
    path: &Path,
    mut output: Option<&mut File>,
) -> Result<(u64, Vec<u8>), RestoreFailure> {
    let fail = || RestoreFailure::new("unsupported");
    let metadata = path.symlink_metadata().map_err(|_| fail())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(fail());
    }
    if metadata.len() > MAX_DATABASE_BYTES {
        return Err(RestoreFailure::new("tooLarge"));
    }
    // Canonical equality rejects symlinks in every ancestor as well as the file.
    if path.canonicalize().map_err(|_| fail())? != path {
        return Err(fail());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let mut input = options.open(path).map_err(|_| fail())?;
    if !input.metadata().map_err(|_| fail())?.is_file() {
        return Err(fail());
    }
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0; 65536];
    loop {
        let count = input.read(&mut buffer).map_err(|_| fail())?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > MAX_DATABASE_BYTES {
            return Err(RestoreFailure::new("tooLarge"));
        }
        hash.update(&buffer[..count]);
        if let Some(file) = output.as_deref_mut() {
            file.write_all(&buffer[..count])
                .map_err(|_| RestoreFailure::new("unavailable"))?;
        }
    }
    Ok((bytes, hash.finalize().to_vec()))
}
pub(crate) fn capture(source: &Path, directory: &Path) -> Result<PathBuf, RestoreFailure> {
    let fail = || RestoreFailure::new("unsupported");
    if !source.is_absolute() {
        return Err(fail());
    }
    let sources = crate::storage_recovery::existing_material(source).map_err(|_| fail())?;
    if !sources.iter().any(|path| path == source) {
        return Err(fail());
    }
    let mut before = Vec::new();
    let mut total = 0;
    let name = source.file_name().ok_or_else(fail)?;
    for path in &sources {
        let dest = directory.join(path.file_name().ok_or_else(fail)?);
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&dest)
            .map_err(|_| RestoreFailure::new("unavailable"))?;
        let fingerprint = read_file(path, Some(&mut output))?;
        total += fingerprint.0;
        if total > MAX_DATABASE_BYTES {
            return Err(RestoreFailure::new("tooLarge"));
        }
        drop(output);
        if read_file(&dest, None)? != fingerprint {
            return Err(fail());
        }
        before.push(fingerprint);
    }
    verify_capture(source, &sources, &before)?;
    Ok(directory.join(name))
}
fn verify_capture(
    source: &Path,
    sources: &[PathBuf],
    before: &[(u64, Vec<u8>)],
) -> Result<(), RestoreFailure> {
    let fail = || RestoreFailure::new("unsupported");
    if crate::storage_recovery::existing_material(source).map_err(|_| fail())? != sources {
        return Err(fail());
    }
    for (path, original) in sources.iter().zip(before) {
        if read_file(path, None)? != *original {
            return Err(fail());
        }
    }
    Ok(())
}

pub(crate) fn snapshot_file(source: &Path, snapshot: &Path) -> Result<(), RestoreFailure> {
    let invalid = || RestoreFailure::new("unsupported");
    let temporary = tempfile::tempdir().map_err(|_| RestoreFailure::new("unavailable"))?;
    let directory = temporary
        .path()
        .canonicalize()
        .map_err(|_| RestoreFailure::new("unavailable"))?;
    let source = capture(source, &directory)?;
    let metadata = source.symlink_metadata().map_err(|_| invalid())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_DATABASE_BYTES
    {
        return Err(invalid());
    }
    let candidate = Connection::open_with_flags(
        &source,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| invalid())?;
    let pages: i64 = candidate
        .pragma_query_value(None, "page_count", |row| row.get(0))
        .map_err(|_| invalid())?;
    let page_size: i64 = candidate
        .pragma_query_value(None, "page_size", |row| row.get(0))
        .map_err(|_| invalid())?;
    if pages < 1 || page_size < 1 || pages.saturating_mul(page_size) > MAX_DATABASE_BYTES as i64 {
        return Err(invalid());
    }
    // SQLite operates only on private copies. Include committed WAL in a
    // consistent snapshot; no schema migration or source-file mutation.
    candidate
        .backup(rusqlite::MAIN_DB, snapshot, None)
        .map_err(|_| invalid())?;
    drop(candidate);
    Ok(())
}

pub(super) fn read_candidate(source: &Path) -> Result<SavedValues, RestoreFailure> {
    let invalid = || RestoreFailure::new("unsupported");
    let output = tempfile::tempdir().map_err(|_| RestoreFailure::new("unavailable"))?;
    let snapshot = output.path().join("snapshot.sqlite3");
    snapshot_file(source, &snapshot)?;
    let snapshot = Connection::open_with_flags(snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| invalid())?;
    let integrity: String = snapshot
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| invalid())?;
    let version: i64 = snapshot
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| invalid())?;
    if integrity != "ok" || version != 0 {
        return Err(invalid());
    }
    for (table, columns) in [
        (
            "agents",
            "id,name,source,command,args,env,version,handshake,created_at,updated_at",
        ),
        (
            "sessions",
            "id,agent_id,cwd,native_session_id,title,config_options,pinned,archived,created_at,updated_at",
        ),
        ("settings", "key,value"),
        ("dismissed_sessions", "id,created_at"),
    ] {
        let kind: String = snapshot
            .query_row(
                "SELECT type FROM sqlite_schema WHERE name=?1",
                [table],
                |row| row.get(0),
            )
            .map_err(|_| invalid())?;
        if kind != "table" {
            return Err(invalid());
        }
        let found: String = snapshot
            .query_row(
                "SELECT group_concat(name, ',') FROM pragma_table_info(?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(|_| invalid())?;
        if found != columns {
            return Err(invalid());
        }
    }
    let extra: i64 = snapshot.query_row("SELECT count(*) FROM sqlite_schema WHERE type IN ('table','view','trigger') AND name NOT IN ('agents','sessions','settings','dismissed_sessions') AND name NOT LIKE 'sqlite_%'", [], |row| row.get(0)).map_err(|_| invalid())?;
    if extra != 0 {
        return Err(invalid());
    }
    let mut result = SavedValues::new();
    for key in KEYS {
        let count: i64 = snapshot
            .query_row("SELECT count(*) FROM settings WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .map_err(|_| invalid())?;
        if count > 1 {
            return Err(invalid());
        }
        let raw: Option<String> = snapshot
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|_| invalid())?;
        if raw.as_ref().is_some_and(|raw| raw.len() > MAX_VALUE_BYTES) {
            return Err(RestoreFailure::new("tooLarge"));
        }
        result.insert(key.to_string(), raw);
    }
    Ok(result)
}

#[cfg(test)]
#[path = "candidate_tests.rs"]
mod tests;
