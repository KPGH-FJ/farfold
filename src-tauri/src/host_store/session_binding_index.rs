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
    runtime_registry::RuntimeBinding,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_DRAFT_BYTES: usize = 256 * 1024;

pub(crate) fn register_native_session(
    store: &HostStore,
    definition: impl Into<RuntimeBinding>,
    input: NativeSessionRegistrationInput<'_>,
) -> Result<(FarfoldSessionId, WriteOutcome), String> {
    let registration = native_session_registration(definition, input)?;
    let farfold_session_id = registration.farfold_session_id.clone();
    let outcome = store.register_active_session(&registration)?;
    Ok((farfold_session_id, outcome))
}

pub(crate) struct NativeSessionLocator<'a> {
    pub kind: NativeSessionLocatorKind,
    pub path: &'a std::path::Path,
    pub allowed_root: &'a std::path::Path,
}

pub(crate) struct NativeSessionRegistrationInput<'a> {
    pub native_session_id: &'a str,
    pub working_copy_path: &'a std::path::Path,
    pub title: &'a str,
    pub created_at: u64,
    pub updated_at: u64,
}

pub(crate) fn register_native_session_with_locator(
    store: &HostStore,
    definition: impl Into<RuntimeBinding>,
    input: NativeSessionRegistrationInput<'_>,
    locator: NativeSessionLocator<'_>,
) -> Result<(FarfoldSessionId, WriteOutcome), String> {
    let registration = native_session_registration(definition, input)?;
    let farfold_session_id = registration.farfold_session_id.clone();
    // Observing a native file is not a user navigation action.
    let outcome = store.register_session_with_native_locator(
        &registration,
        &NativeSessionLocatorRegistration {
            kind: locator.kind,
            locator_value: locator.path.to_string_lossy().into_owned(),
            allowed_root: Some(locator.allowed_root.to_path_buf()),
        },
    )?;
    Ok((farfold_session_id, outcome))
}

fn native_session_registration(
    definition: impl Into<RuntimeBinding>,
    input: NativeSessionRegistrationInput<'_>,
) -> Result<SessionRegistration, String> {
    let definition = definition.into();
    let working_copy = registration_preview(input.working_copy_path)?;
    let native_session_id =
        NativeSessionId::parse(input.native_session_id).map_err(|error| error.to_string())?;
    let farfold_session_id = native_session_host_id(&definition, &native_session_id)?;
    let created_at = i64::try_from(input.created_at)
        .map_err(|_| "Native Session creation time is out of range".to_string())?;
    let updated_at = i64::try_from(input.updated_at)
        .map_err(|_| "Native Session update time is out of range".to_string())?;
    let title = input.title.trim();
    let title = if title.is_empty() {
        format!(
            "{} Session",
            match definition.product_id.as_str() {
                "pi" => "Pi",
                "opencode" => "OpenCode",
                "codex" => "Codex",
                other => other,
            }
        )
    } else {
        title.to_string()
    };
    Ok(SessionRegistration {
        farfold_session_id: farfold_session_id.clone(),
        runtime_product_id: definition.product_id,
        installation_id: definition.installation_id,
        runtime_build_id: definition.runtime_build_id,
        adapter_id: definition.adapter_id,
        connection_id: definition.connection_id,
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

pub(crate) fn native_session_host_id(
    definition: &RuntimeBinding,
    native_session_id: &NativeSessionId,
) -> Result<FarfoldSessionId, String> {
    FarfoldSessionId::parse(derived_host_id(
        "session",
        &[
            definition.product_id.as_str(),
            definition.installation_id.as_str(),
            definition.connection_id.as_str(),
            native_session_id.as_str(),
        ],
    ))
    .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppRestoreState {
    last_project_id: Option<ProjectId>,
    last_session_id: Option<FarfoldSessionId>,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBindingIndexSnapshot {
    schema_version: i64,
    pub(crate) sessions: Vec<SessionBinding>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostNavigationSnapshot {
    pub(crate) session_index: SessionBindingIndexSnapshot,
    pub(crate) restore_state: Option<AppRestoreState>,
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
    pub(crate) native_locator_registered: bool,
    pub(crate) title: String,
    pub(crate) title_source: SessionTitleSource,
    pub(crate) pinned: bool,
    pub(crate) archived_at: Option<i64>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) last_opened_at: i64,
    pub(crate) unreviewed_change_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSessionMetadataInput {
    farfold_session_id: FarfoldSessionId,
    title: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
}

impl UpdateSessionMetadataInput {
    pub(crate) fn archive_target(&self) -> Option<&FarfoldSessionId> {
        (self.archived == Some(true)).then_some(&self.farfold_session_id)
    }
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadataUpdateResult {
    metadata: SessionMetadata,
    navigation: HostNavigationSnapshot,
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
    native_locator_registered: i64,
    title: String,
    title_source: String,
    pinned: i64,
    archived_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    last_opened_at: i64,
    unreviewed_change_count: i64,
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
            native_locator_registered: raw.native_locator_registered != 0,
            title: raw.title,
            title_source: SessionTitleSource::parse(&raw.title_source)?,
            pinned: raw.pinned != 0,
            archived_at: raw.archived_at,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            last_opened_at: raw.last_opened_at,
            unreviewed_change_count: u64::try_from(raw.unreviewed_change_count)
                .map_err(|_| "Unreviewed Turn Changes count is invalid".to_string())?,
        })
    }
}

impl HostStore {
    pub fn session_binding_index_snapshot(&self) -> Result<SessionBindingIndexSnapshot, String> {
        self.with_ready_database(snapshot)
    }

    pub fn app_restore_state(&self) -> Result<Option<AppRestoreState>, String> {
        self.with_ready_database(read_app_restore_state)
    }

    pub fn navigation_snapshot(&self) -> Result<HostNavigationSnapshot, String> {
        self.with_ready_database(read_navigation_snapshot)
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
    ) -> Result<SessionMetadataUpdateResult, String> {
        self.with_ready_database(|database| update_metadata(database, input))
    }
}

fn read_app_restore_state(database: &mut HostDatabase) -> Result<Option<AppRestoreState>, String> {
    read_app_restore_state_from(&database.connection)
}

fn read_app_restore_state_from(
    connection: &rusqlite::Connection,
) -> Result<Option<AppRestoreState>, String> {
    let raw = connection
        .query_row(
            "SELECT
                a.last_project_id,
                CASE
                    WHEN s.farfold_session_id IS NOT NULL AND s.archived_at IS NULL
                    THEN a.last_session_id
                    ELSE NULL
                END,
                a.updated_at
             FROM app_state a
             LEFT JOIN sessions s ON s.farfold_session_id = a.last_session_id
             WHERE a.singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read Host restore state: {error}"))?;
    raw.map(|(project_id, session_id, updated_at)| {
        Ok(AppRestoreState {
            last_project_id: project_id
                .map(ProjectId::parse)
                .transpose()
                .map_err(|error| error.to_string())?,
            last_session_id: session_id
                .map(FarfoldSessionId::parse)
                .transpose()
                .map_err(|error| error.to_string())?,
            updated_at,
        })
    })
    .transpose()
}

fn snapshot(database: &mut HostDatabase) -> Result<SessionBindingIndexSnapshot, String> {
    let schema_version = database
        .schema_version()
        .map_err(|error| format!("Cannot read Session binding schema version: {error}"))?;
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Cannot begin Session binding snapshot: {error}"))?;
    let sessions = read_session_bindings(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Session binding snapshot: {error}"))?;
    Ok(SessionBindingIndexSnapshot {
        schema_version,
        sessions,
    })
}

fn read_session_bindings(connection: &rusqlite::Connection) -> Result<Vec<SessionBinding>, String> {
    let sessions = {
        let mut statement = connection
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
                    EXISTS(
                        SELECT 1
                        FROM session_native_locators locator
                        WHERE locator.farfold_session_id = s.farfold_session_id
                    ),
                    s.title,
                    s.title_source,
                    s.pinned,
                    s.archived_at,
                    s.created_at,
                    s.updated_at,
                    s.last_opened_at,
                    (
                        SELECT COUNT(*)
                        FROM turn_change_reviews review
                        WHERE review.farfold_session_id = s.farfold_session_id
                          AND review.completed_at IS NOT NULL
                          AND review.reviewed_at IS NULL
                    )
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
                    native_locator_registered: row.get(14)?,
                    title: row.get(15)?,
                    title_source: row.get(16)?,
                    pinned: row.get(17)?,
                    archived_at: row.get(18)?,
                    created_at: row.get(19)?,
                    updated_at: row.get(20)?,
                    last_opened_at: row.get(21)?,
                    unreviewed_change_count: row.get(22)?,
                })
            })
            .map_err(|error| format!("Cannot read Session binding snapshot: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot decode Session binding snapshot: {error}"))?
            .into_iter()
            .map(SessionBinding::try_from)
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(sessions)
}

fn read_navigation_snapshot(database: &mut HostDatabase) -> Result<HostNavigationSnapshot, String> {
    let schema_version = database
        .schema_version()
        .map_err(|error| format!("Cannot read Session binding schema version: {error}"))?;
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Cannot begin Host navigation snapshot: {error}"))?;
    let snapshot = navigation_snapshot_from_connection(&transaction, schema_version)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Host navigation snapshot: {error}"))?;
    Ok(snapshot)
}

pub(super) fn navigation_snapshot_from_connection(
    connection: &rusqlite::Connection,
    schema_version: i64,
) -> Result<HostNavigationSnapshot, String> {
    Ok(HostNavigationSnapshot {
        session_index: SessionBindingIndexSnapshot {
            schema_version,
            sessions: read_session_bindings(connection)?,
        },
        restore_state: read_app_restore_state_from(connection)?,
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
) -> Result<SessionMetadataUpdateResult, String> {
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
    let schema_version = database
        .schema_version()
        .map_err(|error| format!("Cannot read Host schema version: {error}"))?;
    let archive_requested = input.archived == Some(true);
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
    if archive_requested {
        let fallback = transaction
            .query_row(
                "SELECT farfold_session_id, project_id
                 FROM sessions
                 WHERE archived_at IS NULL AND farfold_session_id <> ?1
                 ORDER BY last_opened_at DESC, updated_at DESC, farfold_session_id ASC
                 LIMIT 1",
                [input.farfold_session_id.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| format!("Cannot select fallback Session after archive: {error}"))?;
        let (fallback_session_id, fallback_project_id) = fallback
            .map(|(session_id, project_id)| (Some(session_id), Some(project_id)))
            .unwrap_or((None, None));
        transaction
            .execute(
                "UPDATE app_state SET
                    last_session_id = ?1,
                    last_project_id = COALESCE(?2, last_project_id),
                    updated_at = MAX(updated_at, ?3)
                 WHERE singleton = 1 AND last_session_id = ?4",
                params![
                    fallback_session_id,
                    fallback_project_id,
                    updated_at,
                    input.farfold_session_id.as_str()
                ],
            )
            .map_err(|error| format!("Cannot update restore state after archive: {error}"))?;
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
    let navigation = navigation_snapshot_from_connection(&transaction, schema_version)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Session metadata update: {error}"))?;
    Ok(SessionMetadataUpdateResult {
        metadata,
        navigation,
    })
}

#[tauri::command]
pub fn session_binding_index_snapshot(
    store: State<'_, HostStore>,
) -> Result<SessionBindingIndexSnapshot, String> {
    store.session_binding_index_snapshot()
}

#[tauri::command]
pub fn host_navigation_snapshot(
    store: State<'_, HostStore>,
) -> Result<HostNavigationSnapshot, String> {
    store.navigation_snapshot()
}

#[tauri::command]
pub fn app_restore_state(store: State<'_, HostStore>) -> Result<Option<AppRestoreState>, String> {
    store.app_restore_state()
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
        MAX_DRAFT_BYTES, NativeSessionRegistrationInput, SetSessionDraftInput,
        UpdateSessionMetadataInput, clear_draft, read_app_restore_state, read_draft,
        read_navigation_snapshot, register_native_session, snapshot, update_metadata, write_draft,
    };
    use crate::{
        host_ids::{
            AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
            RuntimeBuildId, RuntimeProductId, WorkingCopyId,
        },
        host_store::{
            CURRENT_SCHEMA_VERSION, HostDatabase, HostDatabaseOpen, HostStore,
            records::{
                RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration,
                SessionRegistration, SessionTitleSource, WorkingCopyKind, WriteOutcome,
            },
        },
        runtime_registry::PI_ACP_RUNTIME,
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

    fn session_registration(
        root: &TestDirectory,
        runtime: &str,
        timestamp: i64,
    ) -> SessionRegistration {
        let project_path = root.0.join(format!("{runtime}-project"));
        fs::create_dir_all(&project_path).unwrap();
        SessionRegistration {
            farfold_session_id: FarfoldSessionId::parse(format!("{runtime}-session")).unwrap(),
            runtime_product_id: RuntimeProductId::parse(runtime).unwrap(),
            installation_id: InstallationId::parse(format!("{runtime}-installation")).unwrap(),
            runtime_build_id: RuntimeBuildId::parse(format!("{runtime}@1+sha256:aaaa")).unwrap(),
            adapter_id: AdapterId::parse(format!("{runtime}-adapter")).unwrap(),
            connection_id: ConnectionId::parse(format!("{runtime}-connection")).unwrap(),
            project_id: ProjectId::parse(format!("{runtime}-project")).unwrap(),
            project_path: project_path.clone(),
            project_name: format!("{runtime} Project"),
            working_copy_id: WorkingCopyId::parse(format!("{runtime}-working-copy")).unwrap(),
            working_copy_path: project_path,
            working_copy_kind: WorkingCopyKind::Root,
            branch_name: Some("main".to_string()),
            native_session_id: NativeSessionId::parse(format!("{runtime}-native-session")).unwrap(),
            title: format!("{runtime} Session"),
            title_source: SessionTitleSource::Native,
            created_at: timestamp,
            updated_at: timestamp,
        }
    }

    fn register_session(
        database: &mut HostDatabase,
        root: &TestDirectory,
        runtime: &str,
        timestamp: i64,
    ) {
        database
            .register_session(&session_registration(root, runtime, timestamp))
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
        database
            .connection
            .execute(
                "INSERT INTO turn_change_reviews(
                    host_turn_id, farfold_session_id, working_copy_id, runtime_product_id,
                    provenance_state, baseline_clean, managed_worktree, change_path_count,
                    started_at, completed_at, updated_at
                 ) VALUES (
                    'turn-for-sidebar', 'pi-session', 'pi-working-copy', 'pi',
                    'available', 1, 1, 1, 5, 6, 6
                 )",
                [],
            )
            .unwrap();

        let result = snapshot(&mut database).unwrap();
        let navigation = read_navigation_snapshot(&mut database).unwrap();

        assert_eq!(result.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(navigation.session_index, result);
        assert!(navigation.restore_state.is_none());
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
        assert_eq!(result.sessions[0].unreviewed_change_count, 1);
        assert_eq!(result.sessions[1].unreviewed_change_count, 0);
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

        assert_eq!(updated.metadata.title, "User title");
        assert_eq!(updated.metadata.title_source, SessionTitleSource::Manual);
        assert!(updated.metadata.pinned);
        assert!(updated.metadata.archived_at.is_some());
        assert_eq!(updated.navigation.session_index.sessions.len(), 1);
        let binding = snapshot(&mut database).unwrap().sessions.remove(0);
        assert_eq!(binding.native_session_id.as_str(), "pi-native-session");
        assert_eq!(binding.installation_id.as_str(), "pi-installation");
        assert_eq!(binding.working_copy_id.as_str(), "pi-working-copy");
        assert_eq!(binding.title, "User title");
        assert!(binding.archived_at.is_some());
        assert!(root.0.join("pi-project").is_dir());
    }

    #[test]
    fn archiving_active_session_selects_unarchived_restore_fallback_atomically() {
        let root = TestDirectory::new();
        let mut database = root.database();
        register_runtime(&mut database, "pi", 1);
        register_runtime(&mut database, "opencode", 2);
        database
            .register_active_session(&session_registration(&root, "pi", 3))
            .unwrap();
        database
            .register_active_session(&session_registration(&root, "opencode", 4))
            .unwrap();
        let opencode_session = FarfoldSessionId::parse("opencode-session").unwrap();
        let pi_session = FarfoldSessionId::parse("pi-session").unwrap();

        assert_eq!(
            read_app_restore_state(&mut database)
                .unwrap()
                .unwrap()
                .last_session_id,
            Some(opencode_session.clone())
        );
        update_metadata(
            &mut database,
            UpdateSessionMetadataInput {
                farfold_session_id: opencode_session,
                title: None,
                pinned: None,
                archived: Some(true),
            },
        )
        .unwrap();
        let fallback = read_app_restore_state(&mut database).unwrap().unwrap();
        assert_eq!(fallback.last_session_id, Some(pi_session.clone()));
        assert_eq!(fallback.last_project_id.unwrap().as_str(), "pi-project");

        update_metadata(
            &mut database,
            UpdateSessionMetadataInput {
                farfold_session_id: pi_session,
                title: None,
                pinned: None,
                archived: Some(true),
            },
        )
        .unwrap();
        let no_session = read_app_restore_state(&mut database).unwrap().unwrap();
        assert_eq!(no_session.last_session_id, None);
        assert_eq!(no_session.last_project_id.unwrap().as_str(), "pi-project");
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
    fn native_session_registration_derives_stable_full_binding() {
        let root = TestDirectory::new();
        let project = root.0.join("managed-project");
        fs::create_dir_all(&project).unwrap();
        let store = HostStore::open(root.0.join("managed.sqlite3"));
        store
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse(PI_ACP_RUNTIME.product_id).unwrap(),
                display_name: PI_ACP_RUNTIME.display_name.to_string(),
                installation_id: InstallationId::parse(PI_ACP_RUNTIME.installation_id).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(PI_ACP_RUNTIME.runtime_build_id).unwrap(),
                adapter_id: AdapterId::parse(PI_ACP_RUNTIME.adapter_id).unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: PI_ACP_RUNTIME.version.to_string(),
                artifact_sha256: PI_ACP_RUNTIME.binary_sha256.to_string(),
                connection_id: ConnectionId::parse(PI_ACP_RUNTIME.default_connection_id).unwrap(),
                connection_label: "Pi native configuration".to_string(),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: 1,
                verified_at: 1,
            })
            .unwrap();

        let first = register_native_session(
            &store,
            PI_ACP_RUNTIME,
            NativeSessionRegistrationInput {
                native_session_id: "pi-native-session",
                working_copy_path: &project,
                title: "Managed Session",
                created_at: 2,
                updated_at: 3,
            },
        )
        .unwrap();
        let second = register_native_session(
            &store,
            PI_ACP_RUNTIME,
            NativeSessionRegistrationInput {
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
            PI_ACP_RUNTIME.runtime_build_id
        );
        assert_eq!(binding.native_session_id.as_str(), "pi-native-session");
        let restore = store
            .with_ready_database(read_app_restore_state)
            .unwrap()
            .unwrap();
        assert_eq!(restore.last_project_id, Some(binding.project_id));
        assert_eq!(restore.last_session_id, Some(first.0));
    }

    #[test]
    fn native_registration_separates_dynamic_installations_and_keeps_existing_ids() {
        use crate::runtime_registry::RuntimeBinding;
        let root = TestDirectory::new();
        let build = |binding: RuntimeBinding| {
            super::native_session_registration(
                binding,
                NativeSessionRegistrationInput {
                    native_session_id: "same-native-id",
                    working_copy_path: &root.0,
                    title: "Observed native title",
                    created_at: 2,
                    updated_at: 3,
                },
            )
            .unwrap()
        };
        let pi = build(PI_ACP_RUNTIME.into());
        assert_eq!(
            pi.farfold_session_id.as_str(),
            crate::host_ids::derived_host_id(
                "session",
                &[
                    PI_ACP_RUNTIME.product_id,
                    PI_ACP_RUNTIME.installation_id,
                    PI_ACP_RUNTIME.default_connection_id,
                    "same-native-id"
                ]
            )
        );
        let binding = RuntimeBinding {
            product_id: RuntimeProductId::parse("codex").unwrap(),
            installation_id: InstallationId::parse("selected-codex-a").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("codex@0.143.0+sha256:test").unwrap(),
            adapter_id: AdapterId::parse("codex-acp-stdio-v1").unwrap(),
            connection_id: ConnectionId::parse("codex-private-a").unwrap(),
        };
        let first = build(binding.clone());
        let mut other = binding.clone();
        other.installation_id = InstallationId::parse("selected-codex-b").unwrap();
        assert_ne!(first.farfold_session_id, build(other).farfold_session_id);
        let mut other = binding.clone();
        other.connection_id = ConnectionId::parse("codex-private-b").unwrap();
        assert_ne!(first.farfold_session_id, build(other).farfold_session_id);
        assert_ne!(first.farfold_session_id, pi.farfold_session_id);
        assert_eq!(first.runtime_build_id, binding.runtime_build_id);
        assert_eq!(first.adapter_id, binding.adapter_id);
        assert_eq!(first.title, "Observed native title");
    }
}
