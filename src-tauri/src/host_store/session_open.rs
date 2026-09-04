use super::{HostDatabase, HostStore};
use crate::{
    host_ids::{
        AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, RuntimeBuildId,
        RuntimeProductId, WorkingCopyId,
    },
    host_store::records::NativeSessionLocatorKind,
    runtime_registry::{ManagedRuntimeDefinition, OPENCODE_RUNTIME, PI_RUNTIME},
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionOpenPreviewInput {
    farfold_session_id: FarfoldSessionId,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionOpenBlocker {
    SessionArchived,
    RuntimeBuildNotCurrent,
    WorkingCopyUnavailable,
    NativeLocatorUnavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenPreview {
    farfold_session_id: FarfoldSessionId,
    runtime_product_id: RuntimeProductId,
    installation_id: InstallationId,
    runtime_build_id: RuntimeBuildId,
    adapter_id: AdapterId,
    connection_id: ConnectionId,
    working_copy_id: WorkingCopyId,
    working_copy_path: String,
    native_session_id: NativeSessionId,
    title: String,
    can_open: bool,
    blockers: Vec<SessionOpenBlocker>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionOpenTarget {
    pub farfold_session_id: FarfoldSessionId,
    pub runtime_product_id: RuntimeProductId,
    pub installation_id: InstallationId,
    pub runtime_build_id: RuntimeBuildId,
    pub adapter_id: AdapterId,
    pub connection_id: ConnectionId,
    pub working_copy_id: WorkingCopyId,
    pub working_copy_path: PathBuf,
    pub native_session_id: NativeSessionId,
    pub title: String,
    pub archived_at: Option<i64>,
    pub locator_kind: Option<NativeSessionLocatorKind>,
    pub locator_path: Option<PathBuf>,
}

impl SessionOpenTarget {
    pub(crate) fn definition(&self) -> Option<ManagedRuntimeDefinition> {
        [PI_RUNTIME, OPENCODE_RUNTIME]
            .into_iter()
            .find(|definition| {
                self.runtime_product_id.as_str() == definition.product_id
                    && self.installation_id.as_str() == definition.installation_id
                    && self.runtime_build_id.as_str() == definition.runtime_build_id
                    && self.adapter_id.as_str() == definition.adapter_id
                    && self.connection_id.as_str() == definition.default_connection_id
            })
    }

    pub(crate) fn blockers(&self) -> Vec<SessionOpenBlocker> {
        let mut blockers = Vec::new();
        if self.archived_at.is_some() {
            blockers.push(SessionOpenBlocker::SessionArchived);
        }
        let definition = self.definition();
        if definition.is_none() {
            blockers.push(SessionOpenBlocker::RuntimeBuildNotCurrent);
        }
        let working_copy_available = self
            .working_copy_path
            .canonicalize()
            .is_ok_and(|path| path == self.working_copy_path && path.is_dir());
        if !working_copy_available {
            blockers.push(SessionOpenBlocker::WorkingCopyUnavailable);
        }
        if definition == Some(PI_RUNTIME) {
            let locator_available = self.locator_kind
                == Some(NativeSessionLocatorKind::PiSessionFile)
                && self
                    .locator_path
                    .as_ref()
                    .is_some_and(|path| path.is_file());
            if !locator_available {
                blockers.push(SessionOpenBlocker::NativeLocatorUnavailable);
            }
        }
        blockers
    }

    fn preview(&self) -> SessionOpenPreview {
        let blockers = self.blockers();
        SessionOpenPreview {
            farfold_session_id: self.farfold_session_id.clone(),
            runtime_product_id: self.runtime_product_id.clone(),
            installation_id: self.installation_id.clone(),
            runtime_build_id: self.runtime_build_id.clone(),
            adapter_id: self.adapter_id.clone(),
            connection_id: self.connection_id.clone(),
            working_copy_id: self.working_copy_id.clone(),
            working_copy_path: self.working_copy_path.to_string_lossy().into_owned(),
            native_session_id: self.native_session_id.clone(),
            title: self.title.clone(),
            can_open: blockers.is_empty(),
            blockers,
        }
    }
}

impl HostStore {
    pub(crate) fn session_open_target(
        &self,
        farfold_session_id: &FarfoldSessionId,
    ) -> Result<SessionOpenTarget, String> {
        self.with_ready_database(|database| read_target(database, farfold_session_id))
    }

    pub fn session_open_preview(
        &self,
        farfold_session_id: &FarfoldSessionId,
    ) -> Result<SessionOpenPreview, String> {
        self.session_open_target(farfold_session_id)
            .map(|target| target.preview())
    }

    pub(crate) fn mark_session_opened(
        &self,
        farfold_session_id: &FarfoldSessionId,
    ) -> Result<(i64, super::session_binding_index::HostNavigationSnapshot), String> {
        self.with_ready_database(|database| mark_opened(database, farfold_session_id))
    }
}

fn parse_locator_kind(value: Option<String>) -> Result<Option<NativeSessionLocatorKind>, String> {
    value
        .map(|value| NativeSessionLocatorKind::parse(&value))
        .transpose()
}

fn read_target(
    database: &mut HostDatabase,
    farfold_session_id: &FarfoldSessionId,
) -> Result<SessionOpenTarget, String> {
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Cannot begin Session open preview: {error}"))?;
    let raw = transaction
        .query_row(
            "SELECT
                s.farfold_session_id,
                s.runtime_product_id,
                s.installation_id,
                s.runtime_build_id,
                s.adapter_id,
                s.connection_id,
                s.working_copy_id,
                w.canonical_path,
                s.native_session_id,
                s.title,
                s.archived_at,
                l.locator_kind,
                l.locator_value
             FROM sessions s
             JOIN working_copies w ON w.working_copy_id = s.working_copy_id
             LEFT JOIN session_native_locators l
               ON l.farfold_session_id = s.farfold_session_id
             WHERE s.farfold_session_id = ?1",
            params![farfold_session_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, Option<String>>(12)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read Session open target: {error}"))?
        .ok_or_else(|| format!("Unknown Farfold Session: {farfold_session_id}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Session open preview: {error}"))?;
    Ok(SessionOpenTarget {
        farfold_session_id: FarfoldSessionId::parse(raw.0).map_err(|error| error.to_string())?,
        runtime_product_id: RuntimeProductId::parse(raw.1).map_err(|error| error.to_string())?,
        installation_id: InstallationId::parse(raw.2).map_err(|error| error.to_string())?,
        runtime_build_id: RuntimeBuildId::parse(raw.3).map_err(|error| error.to_string())?,
        adapter_id: AdapterId::parse(raw.4).map_err(|error| error.to_string())?,
        connection_id: ConnectionId::parse(raw.5).map_err(|error| error.to_string())?,
        working_copy_id: WorkingCopyId::parse(raw.6).map_err(|error| error.to_string())?,
        working_copy_path: PathBuf::from(raw.7),
        native_session_id: NativeSessionId::parse(raw.8).map_err(|error| error.to_string())?,
        title: raw.9,
        archived_at: raw.10,
        locator_kind: parse_locator_kind(raw.11)?,
        locator_path: raw.12.map(PathBuf::from),
    })
}

fn mark_opened(
    database: &mut HostDatabase,
    farfold_session_id: &FarfoldSessionId,
) -> Result<(i64, super::session_binding_index::HostNavigationSnapshot), String> {
    let observed_at = super::now_millis();
    let schema_version = database
        .schema_version()
        .map_err(|error| format!("Cannot read Host schema version: {error}"))?;
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot begin Session activation: {error}"))?;
    let (project_id, created_at) = transaction
        .query_row(
            "SELECT project_id, created_at
             FROM sessions
             WHERE farfold_session_id = ?1 AND archived_at IS NULL",
            [farfold_session_id.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Cannot validate Session activation: {error}"))?
        .ok_or_else(|| "Cannot activate an unknown or archived Farfold Session".to_string())?;
    let previous_updated_at = transaction
        .query_row(
            "SELECT updated_at FROM app_state WHERE singleton = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read active Session revision: {error}"))?
        .unwrap_or_default();
    let opened_at = observed_at
        .max(created_at)
        .max(previous_updated_at.saturating_add(1));
    transaction
        .execute(
            "UPDATE sessions
             SET last_opened_at = MAX(last_opened_at, ?2)
             WHERE farfold_session_id = ?1",
            params![farfold_session_id.as_str(), opened_at],
        )
        .map_err(|error| format!("Cannot mark Session opened: {error}"))?;
    transaction
        .execute(
            "INSERT INTO app_state(singleton, last_project_id, last_session_id, updated_at)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(singleton) DO UPDATE SET
                last_project_id = excluded.last_project_id,
                last_session_id = excluded.last_session_id,
                updated_at = excluded.updated_at",
            params![project_id, farfold_session_id.as_str(), opened_at],
        )
        .map_err(|error| format!("Cannot update active Session state: {error}"))?;
    let navigation = super::session_binding_index::navigation_snapshot_from_connection(
        &transaction,
        schema_version,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Session activation: {error}"))?;
    Ok((opened_at, navigation))
}

#[tauri::command]
pub fn host_session_open_preview(
    store: State<'_, HostStore>,
    input: SessionOpenPreviewInput,
) -> Result<SessionOpenPreview, String> {
    store.session_open_preview(&input.farfold_session_id)
}

#[cfg(test)]
mod tests {
    use super::{SessionOpenBlocker, mark_opened, read_target};
    use crate::{
        host_ids::{
            AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
            RuntimeBuildId, RuntimeProductId, WorkingCopyId,
        },
        host_store::{
            HostDatabaseOpen,
            records::{
                NativeSessionLocatorKind, NativeSessionLocatorRegistration, RuntimeConnectionKind,
                RuntimeDistribution, RuntimeRegistration, SessionRegistration, SessionTitleSource,
                WorkingCopyKind,
            },
        },
        runtime_registry::PI_RUNTIME,
    };
    use std::{fs, path::PathBuf};

    fn test_directory(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "farfold-session-open-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    fn register_pi_session(
        database: &mut crate::host_store::HostDatabase,
        root: &std::path::Path,
    ) -> FarfoldSessionId {
        database
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse(PI_RUNTIME.product_id).unwrap(),
                display_name: "Pi".to_string(),
                installation_id: InstallationId::parse(PI_RUNTIME.installation_id).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(PI_RUNTIME.runtime_build_id).unwrap(),
                adapter_id: AdapterId::parse(PI_RUNTIME.adapter_id).unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: PI_RUNTIME.version.to_string(),
                artifact_sha256: PI_RUNTIME.binary_sha256.to_string(),
                connection_id: ConnectionId::parse(PI_RUNTIME.default_connection_id).unwrap(),
                connection_label: "Managed Pi".to_string(),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: 1,
                verified_at: 1,
            })
            .unwrap();
        let session_file = root.join("session.jsonl");
        fs::write(&session_file, b"{}\n").unwrap();
        let session_id = FarfoldSessionId::parse("pi-open-session").unwrap();
        database
            .register_session_with_native_locator(
                &SessionRegistration {
                    farfold_session_id: session_id.clone(),
                    runtime_product_id: RuntimeProductId::parse(PI_RUNTIME.product_id).unwrap(),
                    installation_id: InstallationId::parse(PI_RUNTIME.installation_id).unwrap(),
                    runtime_build_id: RuntimeBuildId::parse(PI_RUNTIME.runtime_build_id).unwrap(),
                    adapter_id: AdapterId::parse(PI_RUNTIME.adapter_id).unwrap(),
                    connection_id: ConnectionId::parse(PI_RUNTIME.default_connection_id).unwrap(),
                    project_id: ProjectId::parse("project-open").unwrap(),
                    project_path: root.to_path_buf(),
                    project_name: "Open".to_string(),
                    working_copy_id: WorkingCopyId::parse("working-copy-open").unwrap(),
                    working_copy_path: root.to_path_buf(),
                    working_copy_kind: WorkingCopyKind::Root,
                    branch_name: None,
                    native_session_id: NativeSessionId::parse("native-open").unwrap(),
                    title: "Open me".to_string(),
                    title_source: SessionTitleSource::Native,
                    created_at: 2,
                    updated_at: 2,
                },
                &NativeSessionLocatorRegistration {
                    kind: NativeSessionLocatorKind::PiSessionFile,
                    locator_path: session_file,
                    allowed_root: root.to_path_buf(),
                },
            )
            .unwrap();
        session_id
    }

    #[test]
    fn preview_resolves_only_the_exact_current_binding_and_live_paths() {
        let root = test_directory("exact");
        let database_path = root.join("host.sqlite3");
        let HostDatabaseOpen::Ready(mut database) = HostDatabaseOpen::open(database_path) else {
            panic!("database should open");
        };
        let session_id = register_pi_session(&mut database, &root);

        let target = read_target(&mut database, &session_id).unwrap();
        let preview = target.preview();
        assert!(preview.can_open);
        assert!(preview.blockers.is_empty());
        assert_eq!(preview.farfold_session_id, session_id);
        assert_eq!(preview.native_session_id.as_str(), "native-open");

        let (_, navigation) = mark_opened(&mut database, &session_id).unwrap();
        let navigation = serde_json::to_value(navigation).unwrap();
        assert_eq!(
            navigation["restoreState"]["lastSessionId"],
            session_id.as_str()
        );
        assert_eq!(
            navigation["sessionIndex"]["sessions"][0]["lastOpenedAt"],
            navigation["restoreState"]["updatedAt"]
        );

        let mut noncurrent = target.clone();
        noncurrent.runtime_build_id = RuntimeBuildId::parse("pi@old+sha256:deadbeef").unwrap();
        assert_eq!(
            noncurrent.preview().blockers,
            vec![SessionOpenBlocker::RuntimeBuildNotCurrent]
        );

        fs::remove_file(root.join("session.jsonl")).unwrap();
        assert_eq!(
            read_target(&mut database, &session_id)
                .unwrap()
                .preview()
                .blockers,
            vec![SessionOpenBlocker::NativeLocatorUnavailable]
        );
        assert!(
            read_target(
                &mut database,
                &FarfoldSessionId::parse("unknown-session").unwrap()
            )
            .is_err()
        );
    }

    #[test]
    fn preview_rejects_archived_session() {
        let root = test_directory("blocked");
        let database_path = root.join("host.sqlite3");
        let HostDatabaseOpen::Ready(mut database) = HostDatabaseOpen::open(database_path) else {
            panic!("database should open");
        };
        let session_id = register_pi_session(&mut database, &root);
        database
            .connection
            .execute(
                "UPDATE sessions SET archived_at = 3 WHERE farfold_session_id = ?1",
                [session_id.as_str()],
            )
            .unwrap();
        assert_eq!(
            read_target(&mut database, &session_id)
                .unwrap()
                .preview()
                .blockers,
            vec![SessionOpenBlocker::SessionArchived]
        );
    }
}
