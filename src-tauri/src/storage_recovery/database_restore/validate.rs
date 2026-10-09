use super::{Counts, Failure};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

fn invalid(_: rusqlite::Error) -> Failure {
    Failure::new("unsupported")
}
fn normalize(sql: String) -> String {
    let mut quoted = None;
    sql.chars()
        .filter_map(|character| {
            if let Some(quote) = quoted {
                if character == quote {
                    quoted = None;
                }
                Some(character)
            } else if ['\'', '"', '`'].contains(&character) {
                quoted = Some(character);
                Some(character)
            } else if character.is_whitespace() {
                None
            } else {
                Some(character.to_ascii_lowercase())
            }
        })
        .collect()
}
type SchemaObject = (String, String, String, Option<String>);

fn shape(connection: &Connection) -> Result<Vec<SchemaObject>, Failure> {
    let mut statement = connection
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .map_err(invalid)?;
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get::<_, Option<String>>(3)?.map(normalize),
            ))
        })
        .map_err(invalid)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(invalid)
}
pub(super) fn captured_database(path: &Path) -> Result<Counts, Failure> {
    let copy = tempfile::tempdir().map_err(super::files::storage)?;
    let snapshot = copy
        .path()
        .canonicalize()
        .map_err(super::files::storage)?
        .join("verify.sqlite3");
    super::candidate::snapshot_file(path, &snapshot)?;
    database(&snapshot)
}
pub(super) fn database(path: &Path) -> Result<Counts, Failure> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(invalid)?;
    connection
        .execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(invalid)?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(invalid)?;
    let app_id: i64 = connection
        .pragma_query_value(None, "application_id", |r| r.get(0))
        .map_err(invalid)?;
    if version != 0 || app_id != 0 {
        return Err(Failure::new("unsupported"));
    }
    // A matching column list alone misses CHECK/PK/UNIQUE and trigger changes.
    // Compare every schema object with this build's trusted in-memory schema.
    let reference = Connection::open_in_memory().map_err(invalid)?;
    reference
        .execute_batch(crate::meta_store::schema::SCHEMA)
        .map_err(invalid)?;
    if shape(&connection)? != shape(&reference)? {
        return Err(Failure::new("unsupported"));
    }
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(invalid)?;
    if integrity != "ok" {
        return Err(Failure::new("unsupported"));
    }
    for key in ["lifemodel.master", "lifemodel.contribute", "lifemodel.use"] {
        use rusqlite::OptionalExtension;
        let raw: Option<String> = connection
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(invalid)?;
        if raw.is_some_and(|value| serde_json::from_str::<serde_json::Value>(&value).is_err()) {
            return Err(Failure::new("unsupported"));
        }
    }
    let count = |table: &str| {
        connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(invalid)
            .and_then(|value| u64::try_from(value).map_err(|_| Failure::new("unsupported")))
    };
    Ok(Counts {
        agents: count("agents")?,
        sessions: count("sessions")?,
        settings: count("settings")?,
        dismissed_sessions: count("dismissed_sessions")?,
    })
}
