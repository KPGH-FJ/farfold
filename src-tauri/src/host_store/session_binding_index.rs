use super::{HostDatabase, HostStore, now_millis};
use crate::{
    host_ids::{
        AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
        RuntimeBuildId, RuntimeProductId, WorkingCopyId, derived_host_id,
    },
    host_store::{
        records::{
            NativeSessionLocatorKind, NativeSessionLocatorRegistration, SessionRegistration,
            SessionTitleSource, WorkingCopyKind, WriteOutcome,
        },
        working_copy_manager::registration_preview,
    },
    runtime_registry::ManagedRuntimeDefinition,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_DRAFT_BYTES: usize = 256 * 1024;

pub(crate) fn register_managed_session(
    store: &HostStore,
    definition: ManagedRuntimeDefinition,
    input: ManagedSessionRegistrationInput<'_>,
) -> Result<(FarfoldSessionId, WriteOutcome), String> {
    let registration = managed_session_registration(definition, input)?;
    let farfold_session_id = registration.farfold_session_id.clone();
    let outcome = store.register_session(&registration)?;
    Ok((farfold_session_id, outcome))
}

pub(crate) struct ManagedNativeLocator<'a> {
    pub kind: NativeSessionLocatorKind,
    pub path: &'a std::path::Path,
    pub allowed_root: &'a std::path::Path,
}

pub(crate) struct ManagedSessionRegistrationInput<'a> {
    pub native_session_id: &'a str,
    pub working_copy_path: &'a std::path::Path,
    pub title: &'a str,
    pub created_at: u64,
    pub updated_at: u64,
}

pub(crate) fn register_managed_session_with_locator(
    store: &HostStore,
    definition: ManagedRuntimeDefinition,
    input: ManagedSessionRegistrationInput<'_>,
    locator: ManagedNativeLocator<'_>,
) -> Result<(FarfoldSessionId, WriteOutcome), String> {
    let registration = managed_session_registration(definition, input)?;
    let farfold_session_id = registration.farfold_session_id.clone();
    let outcome = store.register_session_with_native_locator(
        &registration,
        &NativeSessionLocatorRegistration {
            kind: locator.kind,
            locator_path: locator.path.to_path_buf(),
            allowed_root: locator.allowed_root.to_path_buf(),
        },
    )?;
    Ok((farfold_session_id, outcome))
}

fn managed_session_registration(
    definition: ManagedRuntimeDefinition,
    input: ManagedSessionRegistrationInput<'_>,
) -> Result<SessionRegistration, String> {
    let working_copy = registration_preview(input.working_copy_path)?;
    let native_session_id =
        NativeSessionId::parse(input.native_session_id).map_err(|error| error.to_string())?;
    let farfold_session_id = FarfoldSessionId::parse(derived_host_id(
        "session",
        &[
            definition.product_id,
            definition.installation_id,
            definition.default_connection_id,
            native_session_id.as_str(),
        ],
    ))
    .map_err(|error| error.to_string())?;
    let created_at = i64::try_from(input.created_at)
        .map_err(|_| "Native Session creation time is out of range".to_string())?;
    let updated_at = i64::try_from(input.updated_at)
        .map_err(|_| "Native Session update time is out of range".to_string())?;
    let title = input.title.trim();
    let title = if title.is_empty() {
        format!("{} Session", definition.display_name)
    } else {
        title.to_string()
    };
    Ok(SessionRegistration {
        farfold_session_id: farfold_session_id.clone(),
        runtime_product_id: RuntimeProductId::parse(definition.product_id)
            .map_err(|error| error.to_string())?,
        installation_id: InstallationId::parse(definition.installation_id)
            .map_err(|error| error.to_string())?,
        runtime_build_id: RuntimeBuildId::parse(definition.runtime_build_id)
            .map_err(|error| error.to_string())?,
        adapter_id: AdapterId::parse(definition.adapter_id).map_err(|error| error.to_string())?,
        connection_id: ConnectionId::parse(definition.default_connection_id)
            .map_err(|error| error.to_string())?,
        project_id: working_copy.project_id,
        project_path: working_copy.project_path.into(),
        project_name: working_copy.project_name,
        working_copy_id: working_copy.working_copy_id,
        working_copy_path: working_copy.working_copy_path.into(),
        working_copy_kind: working_copy.kind,
        branch_name: working_copy.branch_name,
        native_session_id,
        title,
        title_source: SessionTitleSource::Native,
        created_at,
        updated_at,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeSessionResume {
    pub project_path: std::path::PathBuf,
    pub locator_path: std::path::PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBindingIndexSnapshot {
    schema_version: i64,
    pub(crate) sessions: Vec<SessionBinding>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBinding {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) runtime_product_id: RuntimeProductId,
    pub(crate) installation_id: InstallationId,
    pub(crate) runtime_build_id: RuntimeBuildId,
    pub(crate) adapter_id: AdapterId,
    pub(crate) connection_id: ConnectionId,
    pub(crate) project_id: ProjectId,
    pub(crate) project_path: String,
    pub(crate) project_name: String,
    pub(crate) working_copy_id: WorkingCopyId,
    pub(crate) working_copy_path: String,
    pub(crate) working_copy_kind: WorkingCopyKind,
    pub(crate) branch_name: Option<String>,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) title: String,
    pub(crate) title_source: SessionTitleSource,
    pub(crate) pinned: bool,
    pub(crate) archived_at: Option<i64>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) last_opened_at: i64,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionMetadataInput {
    farfold_session_id: FarfoldSessionId,
    title: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    farfold_session_id: FarfoldSessionId,
    title: String,
    title_source: SessionTitleSource,
    pinned: bool,
    archived_at: Option<i64>,
    updated_at: i64,
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

    pub fn update_session_metadata(
        &self,
        input: UpdateSessionMetadataInput,
    ) -> Result<SessionMetadata, String> {
        self.with_ready_database(|database| update_metadata(database, input))
    }

    pub(crate) fn latest_native_session_resume(
        &self,
        definition: ManagedRuntimeDefinition,
        kind: NativeSessionLocatorKind,
    ) -> Result<Option<NativeSessionResume>, String> {
        self.with_ready_database(|database| {
            latest_native_session_resume(database, definition, kind)
        })
    }
}

fn latest_native_session_resume(
    database: &mut HostDatabase,
    definition: ManagedRuntimeDefinition,
    kind: NativeSessionLocatorKind,
) -> Result<Option<NativeSessionResume>, String> {
    database
        .connection
        .query_row(
            "SELECT p.canonical_path, l.locator_value
             FROM sessions s
             JOIN projects p ON p.project_id = s.project_id
             JOIN session_native_locators l ON l.farfold_session_id = s.farfold_session_id
             WHERE s.runtime_product_id = ?1
               AND s.installation_id = ?2
               AND s.runtime_build_id = ?3
               AND s.adapter_id = ?4
               AND s.connection_id = ?5
               AND s.archived_at IS NULL
               AND l.locator_kind = ?6
             ORDER BY s.last_opened_at DESC, s.created_at DESC, s.farfold_session_id ASC
             LIMIT 1",
            params![
                definition.product_id,
                definition.installation_id,
                definition.runtime_build_id,
                definition.adapter_id,
                definition.default_connection_id,
                kind.as_str()
            ],
            |row| {
                Ok(NativeSessionResume {
                    project_path: std::path::PathBuf::from(row.get::<_, String>(0)?),
                    locator_path: std::path::PathBuf::from(row.get::<_, String>(1)?),
                })
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read native Session resume binding: {error}"))
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

fn update_metadata(
    database: &mut HostDatabase,
    mut input: UpdateSessionMetadataInput,
) -> Result<SessionMetadata, String> {
    if input.title.is_none() && input.pinned.is_none() && input.archived.is_none() {
        return Err("Session metadata update has no changes".to_string());
    }
    if let Some(title) = &mut input.title {
        *title = title.trim().to_string();
        if title.is_empty() {
            return Err("Session title cannot be empty".to_string());
        }
        if title.len() > 500 {
            return Err("Session title is too long".to_string());
        }
        if title.contains('\0') {
            return Err("Session title contains a null byte".to_string());
        }
    }
    let updated_at = now_millis();
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot begin Session metadata update: {error}"))?;
    let changed = transaction
        .execute(
            "UPDATE sessions SET
                title = COALESCE(?2, title),
                title_source = CASE WHEN ?2 IS NULL THEN title_source ELSE 'manual' END,
                pinned = COALESCE(?3, pinned),
                archived_at = CASE
                    WHEN ?4 IS NULL THEN archived_at
                    WHEN ?4 THEN ?5
                    ELSE NULL
                END,
                updated_at = MAX(updated_at, ?5)
             WHERE farfold_session_id = ?1",
            params![
                input.farfold_session_id.as_str(),
                input.title,
                input.pinned,
                input.archived,
                updated_at
            ],
        )
        .map_err(|error| format!("Cannot update Session metadata: {error}"))?;
    if changed == 0 {
        return Err("Farfold Session does not exist".to_string());
    }
    let raw = transaction
        .query_row(
            "SELECT title, title_source, pinned, archived_at, updated_at
             FROM sessions WHERE farfold_session_id = ?1",
            [input.farfold_session_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .map_err(|error| format!("Cannot read updated Session metadata: {error}"))?;
    let metadata = SessionMetadata {
        farfold_session_id: input.farfold_session_id,
        title: raw.0,
        title_source: SessionTitleSource::parse(&raw.1)?,
        pinned: raw.2 != 0,
        archived_at: raw.3,
        updated_at: raw.4,
    };
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Session metadata update: {error}"))?;
    Ok(metadata)
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

#[tauri::command]
pub fn session_metadata_update(
    store: State<'_, HostStore>,
    input: UpdateSessionMetadataInput,
) -> Result<SessionMetadata, String> {
    store.update_session_metadata(input)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_DRAFT_BYTES, ManagedNativeLocator, ManagedSessionRegistrationInput,
        SetSessionDraftInput, UpdateSessionMetadataInput, clear_draft, read_draft,
        register_managed_session, register_managed_session_with_locator, snapshot, update_metadata,
        write_draft,
    };
    use crate::{
        host_ids::{
            AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
            RuntimeBuildId, RuntimeProductId, WorkingCopyId,
        },
        host_store::{
            HostDatabase, HostDatabaseOpen, HostStore,
            records::{
                NativeSessionLocatorKind, RuntimeConnectionKind, RuntimeDistribution,
                RuntimeRegistration, SessionRegistration, SessionTitleSource, WorkingCopyKind,
                WriteOutcome,
            },
        },
        runtime_registry::PI_RUNTIME,
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

        assert_eq!(result.schema_version, 3);
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

    #[test]
    fn metadata_update_is_atomic_and_preserves_the_immutable_binding() {
        let root = TestDirectory::new();
        let mut database = root.database();
        register_runtime(&mut database, "pi", 1);
        register_session(&mut database, &root, "pi", 2);
        let session_id = FarfoldSessionId::parse("pi-session").unwrap();

        let updated = update_metadata(
            &mut database,
            UpdateSessionMetadataInput {
                farfold_session_id: session_id,
                title: Some("  User title  ".to_string()),
                pinned: Some(true),
                archived: Some(true),
            },
        )
        .unwrap();

        assert_eq!(updated.title, "User title");
        assert_eq!(updated.title_source, SessionTitleSource::Manual);
        assert!(updated.pinned);
        assert!(updated.archived_at.is_some());
        let binding = snapshot(&mut database).unwrap().sessions.remove(0);
        assert_eq!(binding.native_session_id.as_str(), "pi-native-session");
        assert_eq!(binding.installation_id.as_str(), "pi-installation");
        assert_eq!(binding.working_copy_id.as_str(), "pi-working-copy");
        assert_eq!(binding.title, "User title");
        assert!(binding.archived_at.is_some());
        assert!(root.0.join("pi-project").is_dir());
    }

    #[test]
    fn metadata_update_rejects_empty_change_invalid_title_and_unknown_session() {
        let root = TestDirectory::new();
        let mut database = root.database();
        let unknown = FarfoldSessionId::parse("unknown-session").unwrap();
        let no_change = update_metadata(
            &mut database,
            UpdateSessionMetadataInput {
                farfold_session_id: unknown.clone(),
                title: None,
                pinned: None,
                archived: None,
            },
        )
        .unwrap_err();
        assert!(no_change.contains("no changes"));
        let invalid_title = update_metadata(
            &mut database,
            UpdateSessionMetadataInput {
                farfold_session_id: unknown.clone(),
                title: Some("   ".to_string()),
                pinned: None,
                archived: None,
            },
        )
        .unwrap_err();
        assert!(invalid_title.contains("cannot be empty"));
        let missing = update_metadata(
            &mut database,
            UpdateSessionMetadataInput {
                farfold_session_id: unknown,
                title: None,
                pinned: Some(true),
                archived: None,
            },
        )
        .unwrap_err();
        assert_eq!(missing, "Farfold Session does not exist");
    }

    #[test]
    fn managed_session_registration_derives_stable_full_binding() {
        let root = TestDirectory::new();
        let project = root.0.join("managed-project");
        fs::create_dir_all(&project).unwrap();
        let store = HostStore::open(root.0.join("managed.sqlite3"));
        store
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse(PI_RUNTIME.product_id).unwrap(),
                display_name: PI_RUNTIME.display_name.to_string(),
                installation_id: InstallationId::parse(PI_RUNTIME.installation_id).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(PI_RUNTIME.runtime_build_id).unwrap(),
                adapter_id: AdapterId::parse(PI_RUNTIME.adapter_id).unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: PI_RUNTIME.version.to_string(),
                artifact_sha256: PI_RUNTIME.binary_sha256.to_string(),
                connection_id: ConnectionId::parse(PI_RUNTIME.default_connection_id).unwrap(),
                connection_label: "Pi native configuration".to_string(),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: 1,
                verified_at: 1,
            })
            .unwrap();

        let first = register_managed_session(
            &store,
            PI_RUNTIME,
            ManagedSessionRegistrationInput {
                native_session_id: "pi-native-session",
                working_copy_path: &project,
                title: "Managed Session",
                created_at: 2,
                updated_at: 3,
            },
        )
        .unwrap();
        let second = register_managed_session(
            &store,
            PI_RUNTIME,
            ManagedSessionRegistrationInput {
                native_session_id: "pi-native-session",
                working_copy_path: &project,
                title: "Managed Session",
                created_at: 2,
                updated_at: 3,
            },
        )
        .unwrap();
        assert_eq!(first.0, second.0);
        assert_eq!(first.1, WriteOutcome::Inserted);
        assert_eq!(second.1, WriteOutcome::AlreadyPresent);
        let binding = store
            .session_binding_index_snapshot()
            .unwrap()
            .sessions
            .remove(0);
        assert_eq!(binding.farfold_session_id, first.0);
        assert_eq!(
            binding.runtime_build_id.as_str(),
            PI_RUNTIME.runtime_build_id
        );
        assert_eq!(binding.native_session_id.as_str(), "pi-native-session");
    }

    #[test]
    fn latest_native_resume_is_scoped_to_the_verified_runtime_tuple() {
        let root = TestDirectory::new();
        let project = root.0.join("managed-project");
        let session_root = root.0.join("sessions");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&session_root).unwrap();
        let session_file = session_root.join("pi-native-session.jsonl");
        fs::write(&session_file, "{}\n").unwrap();
        let store = HostStore::open(root.0.join("managed.sqlite3"));
        store
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse(PI_RUNTIME.product_id).unwrap(),
                display_name: PI_RUNTIME.display_name.to_string(),
                installation_id: InstallationId::parse(PI_RUNTIME.installation_id).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(PI_RUNTIME.runtime_build_id).unwrap(),
                adapter_id: AdapterId::parse(PI_RUNTIME.adapter_id).unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: PI_RUNTIME.version.to_string(),
                artifact_sha256: PI_RUNTIME.binary_sha256.to_string(),
                connection_id: ConnectionId::parse(PI_RUNTIME.default_connection_id).unwrap(),
                connection_label: "Pi native configuration".to_string(),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: 1,
                verified_at: 1,
            })
            .unwrap();

        register_managed_session_with_locator(
            &store,
            PI_RUNTIME,
            ManagedSessionRegistrationInput {
                native_session_id: "pi-native-session",
                working_copy_path: &project,
                title: "Managed Session",
                created_at: 2,
                updated_at: 3,
            },
            ManagedNativeLocator {
                kind: NativeSessionLocatorKind::PiSessionFile,
                path: &session_file,
                allowed_root: &session_root,
            },
        )
        .unwrap();

        let resume = store
            .latest_native_session_resume(PI_RUNTIME, NativeSessionLocatorKind::PiSessionFile)
            .unwrap()
            .unwrap();
        assert_eq!(resume.project_path, project.canonicalize().unwrap());
        assert_eq!(resume.locator_path, session_file.canonicalize().unwrap());
    }
}
