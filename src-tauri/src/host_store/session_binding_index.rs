use super::{HostDatabase, HostStore, now_millis};
use crate::{
    host_ids::{
        AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
        RuntimeBuildId, RuntimeProductId, WorkingCopyId,
    },
    host_store::records::{SessionTitleSource, WorkingCopyKind},
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_DRAFT_BYTES: usize = 256 * 1024;

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSessionDraftInput {
    farfold_session_id: FarfoldSessionId,
    body: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDraft {
    farfold_session_id: FarfoldSessionId,
    body: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClearSessionDraftResult {
    farfold_session_id: FarfoldSessionId,
    removed: bool,
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
        self.with_ready_database(snapshot)
    }

    pub fn session_draft(
        &self,
        farfold_session_id: &FarfoldSessionId,
    ) -> Result<Option<SessionDraft>, String> {
        self.with_ready_database(|database| read_draft(database, farfold_session_id))
    }

    pub fn set_session_draft(&self, input: SetSessionDraftInput) -> Result<SessionDraft, String> {
        if input.body.len() > MAX_DRAFT_BYTES {
            return Err(format!(
                "Session draft exceeds the {MAX_DRAFT_BYTES}-byte limit"
            ));
        }
        self.with_ready_database(|database| write_draft(database, input))
    }

    pub fn clear_session_draft(
        &self,
        farfold_session_id: FarfoldSessionId,
    ) -> Result<ClearSessionDraftResult, String> {
        self.with_ready_database(|database| clear_draft(database, farfold_session_id))
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

fn read_draft(
    database: &mut HostDatabase,
    farfold_session_id: &FarfoldSessionId,
) -> Result<Option<SessionDraft>, String> {
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Cannot begin Session draft read: {error}"))?;
    let draft = transaction
        .query_row(
            "SELECT body, updated_at
             FROM session_drafts
             WHERE farfold_session_id = ?1",
            [farfold_session_id.as_str()],
            |row| {
                Ok(SessionDraft {
                    farfold_session_id: farfold_session_id.clone(),
                    body: row.get(0)?,
                    updated_at: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read Session draft: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Session draft read: {error}"))?;
    Ok(draft)
}

fn write_draft(
    database: &mut HostDatabase,
    input: SetSessionDraftInput,
) -> Result<SessionDraft, String> {
    let updated_at = now_millis();
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot begin Session draft update: {error}"))?;
    transaction
        .execute(
            "INSERT INTO session_drafts(farfold_session_id, body, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(farfold_session_id) DO UPDATE SET
                body = excluded.body,
                updated_at = excluded.updated_at",
            params![input.farfold_session_id.as_str(), input.body, updated_at],
        )
        .map_err(|error| format!("Cannot update Session draft: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Session draft update: {error}"))?;
    Ok(SessionDraft {
        farfold_session_id: input.farfold_session_id,
        body: input.body,
        updated_at,
    })
}

fn clear_draft(
    database: &mut HostDatabase,
    farfold_session_id: FarfoldSessionId,
) -> Result<ClearSessionDraftResult, String> {
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot begin Session draft clear: {error}"))?;
    let removed = transaction
        .execute(
            "DELETE FROM session_drafts WHERE farfold_session_id = ?1",
            [farfold_session_id.as_str()],
        )
        .map_err(|error| format!("Cannot clear Session draft: {error}"))?
        > 0;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Session draft clear: {error}"))?;
    Ok(ClearSessionDraftResult {
        farfold_session_id,
        removed,
    })
}

#[tauri::command]
pub fn session_binding_index_snapshot(
    store: State<'_, HostStore>,
) -> Result<SessionBindingIndexSnapshot, String> {
    store.session_binding_index_snapshot()
}

#[tauri::command]
pub fn session_draft_get(
    store: State<'_, HostStore>,
    farfold_session_id: FarfoldSessionId,
) -> Result<Option<SessionDraft>, String> {
    store.session_draft(&farfold_session_id)
}

#[tauri::command]
pub fn session_draft_set(
    store: State<'_, HostStore>,
    input: SetSessionDraftInput,
) -> Result<SessionDraft, String> {
    store.set_session_draft(input)
}

#[tauri::command]
pub fn session_draft_clear(
    store: State<'_, HostStore>,
    farfold_session_id: FarfoldSessionId,
) -> Result<ClearSessionDraftResult, String> {
    store.clear_session_draft(farfold_session_id)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_DRAFT_BYTES, SetSessionDraftInput, clear_draft, read_draft, snapshot, write_draft,
    };
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

    #[test]
    fn draft_write_is_durable_scoped_and_clear_is_idempotent() {
        let root = TestDirectory::new();
        let mut database = root.database();
        register_runtime(&mut database, "pi", 1);
        register_session(&mut database, &root, "pi", 2);
        let session_id = FarfoldSessionId::parse("pi-session").unwrap();

        let written = write_draft(
            &mut database,
            SetSessionDraftInput {
                farfold_session_id: session_id.clone(),
                body: "unfinished user input".to_string(),
            },
        )
        .unwrap();
        assert_eq!(written.body, "unfinished user input");
        assert_eq!(
            read_draft(&mut database, &session_id).unwrap(),
            Some(written)
        );
        assert!(
            clear_draft(&mut database, session_id.clone())
                .unwrap()
                .removed
        );
        assert!(
            !clear_draft(&mut database, session_id.clone())
                .unwrap()
                .removed
        );
        assert_eq!(read_draft(&mut database, &session_id).unwrap(), None);
    }

    #[test]
    fn draft_rejects_unknown_session_and_bounded_api_rejects_oversize() {
        let root = TestDirectory::new();
        let mut database = root.database();
        let unknown = FarfoldSessionId::parse("unknown-session").unwrap();
        let error = write_draft(
            &mut database,
            SetSessionDraftInput {
                farfold_session_id: unknown.clone(),
                body: "draft".to_string(),
            },
        )
        .unwrap_err();
        assert!(error.contains("FOREIGN KEY constraint failed"));

        let store = crate::host_store::HostStore::open(root.0.join("bounded.sqlite3"));
        let error = store
            .set_session_draft(SetSessionDraftInput {
                farfold_session_id: unknown,
                body: "x".repeat(MAX_DRAFT_BYTES + 1),
            })
            .unwrap_err();
        assert!(error.contains("exceeds"));
    }
}
