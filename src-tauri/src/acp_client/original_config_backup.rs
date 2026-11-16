//! Read one exact Farfold-owned configuration from an explicitly selected backup.

use std::path::Path;

use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};

use super::{model_guard::Snapshot, session_index::session_row_id};
use crate::storage_recovery::restore::candidate::snapshot_file;

const INVALID_BACKUP: &str = "无法核对所选备份，请选择有效的 Farfold 资料备份";
const INVALID_RECORD: &str = "备份没有唯一且完整的原对话设置，原对话仍保留";
const LIVE_DATABASE: &str = "请选择以前的 Farfold 资料备份，不能使用当前资料";
const MAX_RECORD_BYTES: i64 = 64 * 1024;

pub(super) fn existing_config_from_backup(
    source: &Path,
    live_database: &Path,
    agent_id: &str,
    cwd: &str,
    native_id: &str,
) -> Result<Option<Value>, String> {
    let canonical = super::manager::validate_cwd(cwd)?;
    if canonical != Path::new(cwd) || agent_id.is_empty() || native_id.is_empty() {
        return Err(INVALID_RECORD.into());
    }

    require_separate_backup(source, live_database)?;
    let directory = tempfile::tempdir().map_err(|_| INVALID_BACKUP)?;
    let snapshot = directory
        .path()
        .canonicalize()
        .map_err(|_| INVALID_BACKUP)?
        .join("snapshot.sqlite3");
    snapshot_file(source, &snapshot).map_err(|_| INVALID_BACKUP)?;
    require_separate_backup(source, live_database)?;
    let connection = Connection::open_with_flags(
        snapshot,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| INVALID_BACKUP)?;
    validate_schema(&connection)?;

    let id = session_row_id(agent_id, cwd, native_id);
    let mut query = connection
        .prepare(
            "SELECT id,agent_id,cwd,native_session_id,config_options IS NOT NULL,
                    CASE WHEN length(CAST(config_options AS BLOB)) <= ?4 THEN config_options END
             FROM sessions WHERE id=?1 OR (agent_id=?2 AND native_session_id=?3) LIMIT 2",
        )
        .map_err(|_| INVALID_BACKUP)?;
    let mut rows = query
        .query(params![id, agent_id, native_id, MAX_RECORD_BYTES])
        .map_err(|_| INVALID_BACKUP)?;
    let Some(row) = rows.next().map_err(|_| INVALID_BACKUP)? else {
        return Ok(None);
    };
    let recorded_id: String = row.get(0).map_err(|_| INVALID_RECORD)?;
    let recorded_agent: String = row.get(1).map_err(|_| INVALID_RECORD)?;
    let recorded_cwd: String = row.get(2).map_err(|_| INVALID_RECORD)?;
    let recorded_native: String = row.get(3).map_err(|_| INVALID_RECORD)?;
    let present: bool = row.get(4).map_err(|_| INVALID_RECORD)?;
    let raw: Option<String> = row.get(5).map_err(|_| INVALID_RECORD)?;
    if recorded_id != id
        || recorded_agent != agent_id
        || recorded_cwd != cwd
        || recorded_native != native_id
        || rows.next().map_err(|_| INVALID_BACKUP)?.is_some()
    {
        return Err(INVALID_RECORD.into());
    }
    let dismissed: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM dismissed_sessions WHERE id=?1)",
            [&id],
            |row| row.get(0),
        )
        .map_err(|_| INVALID_BACKUP)?;
    if dismissed {
        return Err(INVALID_RECORD.into());
    }
    if !present {
        return Ok(None);
    }
    exact_existing_record(&raw.ok_or(INVALID_RECORD)?).map(Some)
}

fn require_separate_backup(source: &Path, live_database: &Path) -> Result<(), String> {
    let canonical = source.canonicalize().map_err(|_| INVALID_BACKUP)?;
    let live = live_database.canonicalize().map_err(|_| INVALID_BACKUP)?;
    if canonical == live {
        return Err(LIVE_DATABASE.into());
    }
    if canonical != source {
        return Err(INVALID_BACKUP.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let source = canonical.metadata().map_err(|_| INVALID_BACKUP)?;
        let live = live.metadata().map_err(|_| INVALID_BACKUP)?;
        if (source.dev(), source.ino()) == (live.dev(), live.ino()) {
            return Err(LIVE_DATABASE.into());
        }
    }
    Ok(())
}

fn validate_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(|_| INVALID_BACKUP)?;
    for pragma in ["application_id", "user_version"] {
        let value: i64 = connection
            .pragma_query_value(None, pragma, |row| row.get(0))
            .map_err(|_| INVALID_BACKUP)?;
        if value != 0 {
            return Err(INVALID_BACKUP.into());
        }
    }
    let reference = Connection::open_in_memory().map_err(|_| INVALID_BACKUP)?;
    reference
        .execute_batch(crate::meta_store::schema::SCHEMA)
        .map_err(|_| INVALID_BACKUP)?;
    let schema = |connection: &Connection| -> rusqlite::Result<Vec<_>> {
        let mut query = connection
            .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")?;
        query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect()
    };
    if schema(connection).map_err(|_| INVALID_BACKUP)?
        != schema(&reference).map_err(|_| INVALID_BACKUP)?
    {
        return Err(INVALID_BACKUP.into());
    }
    Ok(())
}

fn exact_existing_record(raw: &str) -> Result<Value, String> {
    let record: Value = serde_json::from_str(raw).map_err(|_| INVALID_RECORD)?;
    let snapshot: Snapshot = serde_json::from_value(record.clone()).map_err(|_| INVALID_RECORD)?;
    let models = snapshot
        .choices
        .iter()
        .filter(|choice| choice.category == "model")
        .count();
    let mut ids = std::collections::BTreeSet::new();
    if models != 1
        || snapshot.choices.iter().any(|choice| {
            choice.id.is_empty()
                || choice.value.is_empty()
                || choice.kind != "select"
                || !matches!(choice.category.as_str(), "model" | "thought_level")
                || !ids.insert(&choice.id)
        })
        || record
            != json!({
                "_farfoldConfig": 2,
                "_farfoldService": { "kind": "existing" },
                "choices": snapshot.choices,
            })
    {
        return Err(INVALID_RECORD.into());
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    struct Fixture {
        connection: Connection,
        source: PathBuf,
        live: PathBuf,
        cwd: String,
        _directory: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let canonical = directory.path().canonicalize().unwrap();
            let source = canonical.join("old.sqlite3");
            let live = canonical.join("farfold.sqlite3");
            fs::write(&live, b"live marker").unwrap();
            let connection = Connection::open(&source).unwrap();
            connection
                .execute_batch(crate::meta_store::schema::SCHEMA)
                .unwrap();
            Self {
                connection,
                source,
                live,
                cwd: canonical.to_str().unwrap().to_owned(),
                _directory: directory,
            }
        }

        fn insert(&self, id: &str, raw: Option<&str>) {
            self.connection
                .execute(
                    "INSERT INTO sessions(id,agent_id,cwd,native_session_id,config_options,created_at,updated_at)
                     VALUES(?1,'pi',?2,'old',?3,1,1)",
                    params![id, self.cwd, raw],
                )
                .unwrap();
        }

        fn read(&self, source: &Path) -> Result<Option<Value>, String> {
            existing_config_from_backup(source, &self.live, "pi", &self.cwd, "old")
        }
    }

    fn config() -> Value {
        json!({
            "_farfoldConfig": 2,
            "_farfoldService": {"kind": "existing"},
            "choices": [
                {"id": "model", "category": "model", "type": "select", "value": "provider/model"},
                {"id": "thought_level", "category": "thought_level", "type": "select", "value": "medium"}
            ]
        })
    }

    #[test]
    fn copies_committed_configuration_for_exact_tuple_without_touching_source_files() {
        let fixture = Fixture::new();
        let config = config();
        let id = session_row_id("pi", &fixture.cwd, "old");
        fixture.insert(&id, Some(&config.to_string()));
        let materials = || {
            crate::storage_recovery::existing_material(&fixture.source)
                .unwrap()
                .into_iter()
                .map(|path| (path.clone(), fs::read(path).unwrap()))
                .collect::<Vec<_>>()
        };
        let before = materials();
        assert_eq!(fixture.read(&fixture.source).unwrap(), Some(config));
        let other_directory = tempfile::tempdir().unwrap();
        let other = other_directory.path().canonicalize().unwrap();
        assert_eq!(
            existing_config_from_backup(
                &fixture.source,
                &fixture.live,
                "pi",
                other.to_str().unwrap(),
                "old",
            )
            .unwrap_err(),
            INVALID_RECORD
        );
        assert_eq!(materials(), before);
        assert_eq!(fs::read(&fixture.live).unwrap(), b"live marker");
    }

    #[test]
    fn rejects_ambiguous_or_dismissed_backups_and_does_not_infer_absent_settings() {
        let fixture = Fixture::new();
        let id = session_row_id("pi", &fixture.cwd, "old");
        assert_eq!(fixture.read(&fixture.source).unwrap(), None);
        fixture.insert(&id, None);
        assert_eq!(fixture.read(&fixture.source).unwrap(), None);
        fixture.insert("misbound-index", Some(&config().to_string()));
        assert_eq!(fixture.read(&fixture.source).unwrap_err(), INVALID_RECORD);
        fixture
            .connection
            .execute("DELETE FROM sessions WHERE id='misbound-index'", [])
            .unwrap();
        fixture
            .connection
            .execute("INSERT INTO dismissed_sessions VALUES(?1,1)", [&id])
            .unwrap();
        assert_eq!(fixture.read(&fixture.source).unwrap_err(), INVALID_RECORD);
    }

    #[test]
    fn rejects_the_current_database_unverified_schema_and_unreviewed_record_fields() {
        let fixture = Fixture::new();
        assert_eq!(fixture.read(&fixture.live).unwrap_err(), LIVE_DATABASE);
        #[cfg(unix)]
        {
            let hardlink = fixture.live.with_file_name("current-linked.sqlite3");
            fs::hard_link(&fixture.live, &hardlink).unwrap();
            assert_eq!(fixture.read(&hardlink).unwrap_err(), LIVE_DATABASE);
        }
        let id = session_row_id("pi", &fixture.cwd, "old");
        let mut record = config();
        record["_farfoldService"]["unrelated"] = json!("ignored by ordinary deserialization");
        fixture.insert(&id, Some(&record.to_string()));
        assert_eq!(fixture.read(&fixture.source).unwrap_err(), INVALID_RECORD);
        fixture
            .connection
            .execute_batch("CREATE VIEW unexpected AS SELECT id FROM sessions;")
            .unwrap();
        assert_eq!(fixture.read(&fixture.source).unwrap_err(), INVALID_BACKUP);
    }
}
