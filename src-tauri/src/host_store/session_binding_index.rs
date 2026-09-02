use super::{HostDatabase, HostDatabaseOpen, HostStore};
use crate::{
    host_ids::{
        AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
        RuntimeBuildId, RuntimeProductId, WorkingCopyId,
    },
    host_store::records::{SessionTitleSource, WorkingCopyKind},
};
use rusqlite::TransactionBehavior;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBindingIndexSnapshot {
    schema_version: i64,
    sessions: Vec<SessionBinding>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBinding {
    farfold_session_id: FarfoldSessionId,
    runtime_product_id: RuntimeProductId,
    installation_id: InstallationId,
    runtime_build_id: RuntimeBuildId,
    adapter_id: AdapterId,
    connection_id: ConnectionId,
    project_id: ProjectId,
    project_path: String,
    project_name: String,
    working_copy_id: WorkingCopyId,
    working_copy_path: String,
    working_copy_kind: WorkingCopyKind,
    branch_name: Option<String>,
    native_session_id: NativeSessionId,
    title: String,
    title_source: SessionTitleSource,
    pinned: bool,
    archived_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    last_opened_at: i64,
}

struct RawSessionBinding {
    farfold_session_id: String,
    runtime_product_id: String,
    installation_id: String,
    runtime_build_id: String,
    adapter_id: String,
    connection_id: String,
    project_id: String,
    project_path: String,
    project_name: String,
    working_copy_id: String,
    working_copy_path: String,
    working_copy_kind: String,
    branch_name: Option<String>,
    native_session_id: String,
    title: String,
    title_source: String,
    pinned: i64,
    archived_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    last_opened_at: i64,
}

impl TryFrom<RawSessionBinding> for SessionBinding {
    type Error = String;

    fn try_from(raw: RawSessionBinding) -> Result<Self, Self::Error> {
        Ok(Self {
            farfold_session_id: FarfoldSessionId::parse(raw.farfold_session_id)
                .map_err(|error| error.to_string())?,
            runtime_product_id: RuntimeProductId::parse(raw.runtime_product_id)
                .map_err(|error| error.to_string())?,
            installation_id: InstallationId::parse(raw.installation_id)
                .map_err(|error| error.to_string())?,
            runtime_build_id: RuntimeBuildId::parse(raw.runtime_build_id)
                .map_err(|error| error.to_string())?,
            adapter_id: AdapterId::parse(raw.adapter_id).map_err(|error| error.to_string())?,
            connection_id: ConnectionId::parse(raw.connection_id)
                .map_err(|error| error.to_string())?,
            project_id: ProjectId::parse(raw.project_id).map_err(|error| error.to_string())?,
            project_path: raw.project_path,
            project_name: raw.project_name,
            working_copy_id: WorkingCopyId::parse(raw.working_copy_id)
                .map_err(|error| error.to_string())?,
            working_copy_path: raw.working_copy_path,
            working_copy_kind: WorkingCopyKind::parse(&raw.working_copy_kind)?,
            branch_name: raw.branch_name,
            native_session_id: NativeSessionId::parse(raw.native_session_id)
                .map_err(|error| error.to_string())?,
            title: raw.title,
            title_source: SessionTitleSource::parse(&raw.title_source)?,
            pinned: raw.pinned != 0,
            archived_at: raw.archived_at,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            last_opened_at: raw.last_opened_at,
        })
    }
}

impl HostStore {
    pub fn session_binding_index_snapshot(&self) -> Result<SessionBindingIndexSnapshot, String> {
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

fn snapshot(database: &mut HostDatabase) -> Result<SessionBindingIndexSnapshot, String> {
    let schema_version = database
        .schema_version()
        .map_err(|error| format!("Cannot read Session binding schema version: {error}"))?;
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Cannot begin Session binding snapshot: {error}"))?;
    let sessions = {
        let mut statement = transaction
            .prepare(
                "SELECT
                    s.farfold_session_id,
                    s.runtime_product_id,
                    s.installation_id,
                    s.runtime_build_id,
                    s.adapter_id,
                    s.connection_id,
                    s.project_id,
                    p.canonical_path,
                    p.display_name,
                    s.working_copy_id,
                    w.canonical_path,
                    w.kind,
                    w.branch_name,
                    s.native_session_id,
                    s.title,
                    s.title_source,
                    s.pinned,
                    s.archived_at,
                    s.created_at,
                    s.updated_at,
                    s.last_opened_at
                 FROM sessions s
                 JOIN projects p ON p.project_id = s.project_id
                 JOIN working_copies w
                   ON w.working_copy_id = s.working_copy_id
                  AND w.project_id = s.project_id
                 ORDER BY
                    s.pinned DESC,
                    s.last_opened_at DESC,
                    s.updated_at DESC,
                    s.farfold_session_id ASC",
            )
            .map_err(|error| format!("Cannot prepare Session binding snapshot: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(RawSessionBinding {
                    farfold_session_id: row.get(0)?,
                    runtime_product_id: row.get(1)?,
                    installation_id: row.get(2)?,
                    runtime_build_id: row.get(3)?,
                    adapter_id: row.get(4)?,
                    connection_id: row.get(5)?,
                    project_id: row.get(6)?,
                    project_path: row.get(7)?,
                    project_name: row.get(8)?,
                    working_copy_id: row.get(9)?,
                    working_copy_path: row.get(10)?,
                    working_copy_kind: row.get(11)?,
                    branch_name: row.get(12)?,
                    native_session_id: row.get(13)?,
                    title: row.get(14)?,
                    title_source: row.get(15)?,
                    pinned: row.get(16)?,
                    archived_at: row.get(17)?,
                    created_at: row.get(18)?,
                    updated_at: row.get(19)?,
                    last_opened_at: row.get(20)?,
                })
            })
            .map_err(|error| format!("Cannot read Session binding snapshot: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot decode Session binding snapshot: {error}"))?
            .into_iter()
            .map(SessionBinding::try_from)
            .collect::<Result<Vec<_>, _>>()?
    };
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Session binding snapshot: {error}"))?;
    Ok(SessionBindingIndexSnapshot {
        schema_version,
        sessions,
    })
}

#[tauri::command]
pub fn session_binding_index_snapshot(
    store: State<'_, HostStore>,
) -> Result<SessionBindingIndexSnapshot, String> {
    store.session_binding_index_snapshot()
}

#[cfg(test)]
mod tests {
    use super::snapshot;
    use crate::{
        host_ids::{
            AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
            RuntimeBuildId, RuntimeProductId, WorkingCopyId,
        },
        host_store::{
            HostDatabase, HostDatabaseOpen,
            records::{
                RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration,
                SessionRegistration, SessionTitleSource, WorkingCopyKind,
            },
        },
    };
    use std::{fs, path::PathBuf};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "farfold-session-index-{}-{}",
                std::process::id(),
                std::thread::current().name().unwrap_or("test")
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn database(&self) -> HostDatabase {
            match HostDatabaseOpen::open(self.0.join("host.sqlite3")) {
                HostDatabaseOpen::Ready(database) => database,
                HostDatabaseOpen::Recovery(recovery) => panic!("{}", recovery.reason()),
            }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn register_runtime(database: &mut HostDatabase, runtime: &str, timestamp: i64) {
        database
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse(runtime).unwrap(),
                display_name: runtime.to_string(),
                installation_id: InstallationId::parse(format!("{runtime}-installation")).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(format!("{runtime}@1+sha256:aaaa"))
                    .unwrap(),
                adapter_id: AdapterId::parse(format!("{runtime}-adapter")).unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: "1".to_string(),
                artifact_sha256: "a".repeat(64),
                connection_id: ConnectionId::parse(format!("{runtime}-connection")).unwrap(),
                connection_label: format!("{runtime} connection"),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: timestamp,
                verified_at: timestamp,
            })
            .unwrap();
    }

    fn register_session(
        database: &mut HostDatabase,
        root: &TestDirectory,
        runtime: &str,
        timestamp: i64,
    ) {
        let project_path = root.0.join(format!("{runtime}-project"));
        fs::create_dir_all(&project_path).unwrap();
        database
            .register_session(&SessionRegistration {
                farfold_session_id: FarfoldSessionId::parse(format!("{runtime}-session")).unwrap(),
                runtime_product_id: RuntimeProductId::parse(runtime).unwrap(),
                installation_id: InstallationId::parse(format!("{runtime}-installation")).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(format!("{runtime}@1+sha256:aaaa"))
                    .unwrap(),
                adapter_id: AdapterId::parse(format!("{runtime}-adapter")).unwrap(),
                connection_id: ConnectionId::parse(format!("{runtime}-connection")).unwrap(),
                project_id: ProjectId::parse(format!("{runtime}-project")).unwrap(),
                project_path: project_path.clone(),
                project_name: format!("{runtime} Project"),
                working_copy_id: WorkingCopyId::parse(format!("{runtime}-working-copy")).unwrap(),
                working_copy_path: project_path,
                working_copy_kind: WorkingCopyKind::Root,
                branch_name: Some("main".to_string()),
                native_session_id: NativeSessionId::parse(format!("{runtime}-native-session"))
                    .unwrap(),
                title: format!("{runtime} Session"),
                title_source: SessionTitleSource::Native,
                created_at: timestamp,
                updated_at: timestamp,
            })
            .unwrap();
    }

    #[test]
    fn snapshot_is_global_ordered_and_keeps_binding_dimensions() {
        let root = TestDirectory::new();
        let mut database = root.database();
        register_runtime(&mut database, "pi", 1);
        register_runtime(&mut database, "opencode", 2);
        register_session(&mut database, &root, "pi", 3);
        register_session(&mut database, &root, "opencode", 4);
        database
            .connection
            .execute(
                "UPDATE sessions SET pinned = 1 WHERE farfold_session_id = 'pi-session'",
                [],
            )
            .unwrap();

        let result = snapshot(&mut database).unwrap();

        assert_eq!(result.schema_version, 2);
        assert_eq!(result.sessions.len(), 2);
        assert_eq!(result.sessions[0].farfold_session_id.as_str(), "pi-session");
        assert_eq!(result.sessions[0].runtime_product_id.as_str(), "pi");
        assert_eq!(
            result.sessions[0].working_copy_id.as_str(),
            "pi-working-copy"
        );
        assert_eq!(
            result.sessions[0].native_session_id.as_str(),
            "pi-native-session"
        );
        assert_eq!(result.sessions[1].runtime_product_id.as_str(), "opencode");
    }
}
