use super::{HostDatabase, HostDatabaseOpen, HostStore};
use crate::{
    host_ids::{ProjectId, WorkingCopyId},
    host_store::records::WorkingCopyKind,
};
use rusqlite::TransactionBehavior;
use serde::Serialize;
use std::{fs, io::ErrorKind, path::Path};
use tauri::State;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkingCopyPathState {
    Ready,
    Missing,
    NotDirectory,
    IdentityMismatch,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopySnapshot {
    working_copies: Vec<WorkingCopyRecord>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyRecord {
    working_copy_id: WorkingCopyId,
    project_id: ProjectId,
    canonical_path: String,
    kind: WorkingCopyKind,
    branch_name: Option<String>,
    path_state: WorkingCopyPathState,
    bound_session_count: u64,
    unarchived_session_count: u64,
    created_at: i64,
    updated_at: i64,
}

struct RawWorkingCopyRecord {
    working_copy_id: String,
    project_id: String,
    canonical_path: String,
    kind: String,
    branch_name: Option<String>,
    bound_session_count: i64,
    unarchived_session_count: i64,
    created_at: i64,
    updated_at: i64,
}

impl TryFrom<RawWorkingCopyRecord> for WorkingCopyRecord {
    type Error = String;

    fn try_from(raw: RawWorkingCopyRecord) -> Result<Self, Self::Error> {
        Ok(Self {
            working_copy_id: WorkingCopyId::parse(raw.working_copy_id)
                .map_err(|error| error.to_string())?,
            project_id: ProjectId::parse(raw.project_id).map_err(|error| error.to_string())?,
            path_state: observe_path(Path::new(&raw.canonical_path)),
            canonical_path: raw.canonical_path,
            kind: WorkingCopyKind::parse(&raw.kind)?,
            branch_name: raw.branch_name,
            bound_session_count: u64::try_from(raw.bound_session_count)
                .map_err(|_| "Working Copy Session count is invalid".to_string())?,
            unarchived_session_count: u64::try_from(raw.unarchived_session_count)
                .map_err(|_| "Working Copy active Session count is invalid".to_string())?,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
        })
    }
}

fn observe_path(expected: &Path) -> WorkingCopyPathState {
    let metadata = match fs::symlink_metadata(expected) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return WorkingCopyPathState::Missing,
        Err(_) => return WorkingCopyPathState::Unavailable,
    };
    if !metadata.is_dir() {
        return WorkingCopyPathState::NotDirectory;
    }
    match expected.canonicalize() {
        Ok(observed) if observed == expected => WorkingCopyPathState::Ready,
        Ok(_) => WorkingCopyPathState::IdentityMismatch,
        Err(_) => WorkingCopyPathState::Unavailable,
    }
}

impl HostStore {
    pub fn working_copy_snapshot(&self) -> Result<WorkingCopySnapshot, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Host storage state is unavailable".to_string())?;
        match &mut *state {
            HostDatabaseOpen::Ready(database) => snapshot(database),
            HostDatabaseOpen::Recovery(recovery) => Err(format!(
                "Host storage is in recovery mode: {}",
                recovery.reason()
            )),
        }
    }
}

fn snapshot(database: &mut HostDatabase) -> Result<WorkingCopySnapshot, String> {
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Cannot begin Working Copy snapshot: {error}"))?;
    let working_copies = {
        let mut statement = transaction
            .prepare(
                "SELECT
                    w.working_copy_id,
                    w.project_id,
                    w.canonical_path,
                    w.kind,
                    w.branch_name,
                    COUNT(s.farfold_session_id),
                    COALESCE(SUM(CASE
                        WHEN s.farfold_session_id IS NOT NULL AND s.archived_at IS NULL THEN 1
                        ELSE 0
                    END), 0),
                    w.created_at,
                    w.updated_at
                 FROM working_copies w
                 LEFT JOIN sessions s
                   ON s.working_copy_id = w.working_copy_id
                  AND s.project_id = w.project_id
                 GROUP BY
                    w.working_copy_id,
                    w.project_id,
                    w.canonical_path,
                    w.kind,
                    w.branch_name,
                    w.created_at,
                    w.updated_at
                 ORDER BY w.project_id ASC, w.canonical_path ASC",
            )
            .map_err(|error| format!("Cannot prepare Working Copy snapshot: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(RawWorkingCopyRecord {
                    working_copy_id: row.get(0)?,
                    project_id: row.get(1)?,
                    canonical_path: row.get(2)?,
                    kind: row.get(3)?,
                    branch_name: row.get(4)?,
                    bound_session_count: row.get(5)?,
                    unarchived_session_count: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|error| format!("Cannot read Working Copy snapshot: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot decode Working Copy snapshot: {error}"))?
            .into_iter()
            .map(WorkingCopyRecord::try_from)
            .collect::<Result<Vec<_>, _>>()?
    };
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Working Copy snapshot: {error}"))?;
    Ok(WorkingCopySnapshot { working_copies })
}

#[tauri::command]
pub fn working_copy_snapshot(store: State<'_, HostStore>) -> Result<WorkingCopySnapshot, String> {
    store.working_copy_snapshot()
}

#[cfg(test)]
mod tests {
    use super::{WorkingCopyPathState, observe_path, snapshot};
    use crate::host_store::{CURRENT_SCHEMA_VERSION, HostDatabaseOpen};
    use rusqlite::params;
    use std::fs;

    #[test]
    fn path_observation_does_not_confuse_presence_with_directory_readiness() {
        let root = std::env::temp_dir().join(format!(
            "farfold-working-copy-observation-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let directory = root.join("ready");
        let file = root.join("file");
        let missing = root.join("missing");
        fs::create_dir(&directory).unwrap();
        fs::write(&file, b"not a directory").unwrap();

        assert_eq!(observe_path(&directory), WorkingCopyPathState::Ready);
        assert_eq!(observe_path(&file), WorkingCopyPathState::NotDirectory);
        assert_eq!(observe_path(&missing), WorkingCopyPathState::Missing);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_reports_unbound_copy_and_detects_path_loss() {
        let root = std::env::temp_dir().join(format!(
            "farfold-working-copy-snapshot-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let project = root.join("project");
        fs::create_dir(&project).unwrap();
        let mut database = match HostDatabaseOpen::open(root.join("host.sqlite3")) {
            HostDatabaseOpen::Ready(database) => database,
            HostDatabaseOpen::Recovery(recovery) => panic!("{}", recovery.reason()),
        };
        database
            .connection
            .execute(
                "INSERT INTO projects(
                    project_id, canonical_path, display_name, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["project-1", project.to_string_lossy(), "Project", 1, 1],
            )
            .unwrap();
        database
            .connection
            .execute(
                "INSERT INTO working_copies(
                    working_copy_id, project_id, canonical_path, kind, branch_name,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    "working-copy-1",
                    "project-1",
                    project.to_string_lossy(),
                    "root",
                    "main",
                    1,
                    1
                ],
            )
            .unwrap();

        let ready = snapshot(&mut database).unwrap();
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(ready.working_copies.len(), 1);
        assert_eq!(
            ready.working_copies[0].path_state,
            WorkingCopyPathState::Ready
        );
        assert_eq!(ready.working_copies[0].bound_session_count, 0);
        assert_eq!(ready.working_copies[0].unarchived_session_count, 0);

        fs::remove_dir(&project).unwrap();
        let missing = snapshot(&mut database).unwrap();
        assert_eq!(
            missing.working_copies[0].path_state,
            WorkingCopyPathState::Missing
        );
        drop(database);
        let _ = fs::remove_dir_all(root);
    }
}
