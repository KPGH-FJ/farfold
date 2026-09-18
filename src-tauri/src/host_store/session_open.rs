use super::{HostDatabase, HostStore};
use crate::{
    host_ids::{
        AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, RuntimeBuildId,
        RuntimeProductId, WorkingCopyId,
    },
    host_store::records::NativeSessionLocatorKind,
    runtime_registry::{ManagedRuntimeDefinition, OPENCODE_RUNTIME, PI_RUNTIME, RuntimeBinding},
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

/// Raw app_state, never the archive-filtered restore projection. No new persisted clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NavigationExpectation {
    Absent,
    Present {
        last_project_id: Option<crate::host_ids::ProjectId>,
        last_session_id: Option<FarfoldSessionId>,
        updated_at: i64,
    },
}
pub(crate) struct OwnedFocusGuard<'a> {
    pub model: &'a super::native_model_selection::SessionModelSelection,
    pub generation: u64,
    pub profile_home: &'a std::path::Path,
}
pub(crate) struct SessionFocusGuard<'a> {
    pub expected_navigation: &'a NavigationExpectation,
    pub target: &'a SessionOpenTarget,
    pub owned: Option<OwnedFocusGuard<'a>>,
}
fn raw_navigation(connection: &rusqlite::Connection) -> Result<NavigationExpectation, String> {
    let row: Option<(Option<String>, Option<String>, i64)> = connection
        .query_row(
            "SELECT last_project_id,last_session_id,updated_at FROM app_state WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| "Raw navigation unavailable")?;
    match row {
        None => Ok(NavigationExpectation::Absent),
        Some((p, s, updated_at)) => Ok(NavigationExpectation::Present {
            last_project_id: p
                .map(crate::host_ids::ProjectId::parse)
                .transpose()
                .map_err(|e| e.to_string())?,
            last_session_id: s
                .map(FarfoldSessionId::parse)
                .transpose()
                .map_err(|e| e.to_string())?,
            updated_at,
        }),
    }
}

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
    pub locator_value: Option<String>,
}

impl SessionOpenTarget {
    pub(crate) fn pi_session_file(&self) -> Option<&std::path::Path> {
        (self.locator_kind == Some(NativeSessionLocatorKind::PiSessionFile))
            .then(|| self.locator_value.as_deref().map(std::path::Path::new))
            .flatten()
    }
    pub(crate) fn binding(&self) -> RuntimeBinding {
        RuntimeBinding {
            product_id: self.runtime_product_id.clone(),
            installation_id: self.installation_id.clone(),
            runtime_build_id: self.runtime_build_id.clone(),
            adapter_id: self.adapter_id.clone(),
            connection_id: self.connection_id.clone(),
        }
    }

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

    pub(crate) fn project_blockers(&self) -> Vec<SessionOpenBlocker> {
        let mut blockers = Vec::new();
        if self.archived_at.is_some() {
            blockers.push(SessionOpenBlocker::SessionArchived);
        }
        let working_copy_available = self
            .working_copy_path
            .canonicalize()
            .is_ok_and(|path| path == self.working_copy_path && path.is_dir());
        if !working_copy_available {
            blockers.push(SessionOpenBlocker::WorkingCopyUnavailable);
        }
        blockers
    }

    pub(crate) fn blockers(&self) -> Vec<SessionOpenBlocker> {
        let mut blockers = self.project_blockers();
        let definition = self.definition();
        let pi_acp = crate::pi_acp::is_current_managed_binding(&self.binding());
        let codex_acp = self.adapter_id.as_str() == "codex-acp-stdio-v1"
            && self.runtime_product_id.as_str() == "codex";
        if definition.is_none() && !codex_acp && !pi_acp {
            blockers.push(SessionOpenBlocker::RuntimeBuildNotCurrent);
        }
        if definition == Some(PI_RUNTIME) || pi_acp {
            let locator_available = self.locator_kind
                == Some(NativeSessionLocatorKind::PiSessionFile)
                && self.pi_session_file().is_some_and(|path| path.is_file());
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
    pub(crate) fn raw_navigation_expectation(&self) -> Result<NavigationExpectation, String> {
        self.with_ready_database(|db| raw_navigation(&db.connection))
    }
    pub(crate) fn mark_session_opened_guarded(
        &self,
        id: &FarfoldSessionId,
        guard: &SessionFocusGuard<'_>,
    ) -> Result<(i64, super::session_binding_index::HostNavigationSnapshot), String> {
        self.with_ready_database(|db| mark_opened_with_guard(db, id, Some(guard)))
    }
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
    let target = read_target_from_connection(&transaction, farfold_session_id)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Session open preview: {error}"))?;
    Ok(target)
}

// Reads the shared identity within the caller's transaction. Direct installation
// enrichment remains in read_target; model validation only needs persisted identity.
pub(super) fn read_target_from_connection(
    connection: &rusqlite::Connection,
    farfold_session_id: &FarfoldSessionId,
) -> Result<SessionOpenTarget, String> {
    let raw = connection
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
        locator_value: raw.12,
    })
}

fn mark_opened(
    database: &mut HostDatabase,
    farfold_session_id: &FarfoldSessionId,
) -> Result<(i64, super::session_binding_index::HostNavigationSnapshot), String> {
    mark_opened_with_guard(database, farfold_session_id, None)
}
fn mark_opened_with_guard(
    database: &mut HostDatabase,
    farfold_session_id: &FarfoldSessionId,
    guard: Option<&SessionFocusGuard<'_>>,
) -> Result<(i64, super::session_binding_index::HostNavigationSnapshot), String> {
    let observed_at = super::now_millis();
    let schema_version = database
        .schema_version()
        .map_err(|error| format!("Cannot read Host schema version: {error}"))?;
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot begin Session activation: {error}"))?;
    if let Some(guard) = guard {
        if raw_navigation(&transaction)? != *guard.expected_navigation {
            return Err("Navigation changed before original focus commit".into());
        }
        let target = read_target_from_connection(&transaction, farfold_session_id)?;
        if &target != guard.target || target.archived_at.is_some() {
            return Err("Original focus target changed before commit".into());
        }
        if let Some(owned) = &guard.owned {
            let model = super::native_model_selection::read_from_connection(
                &transaction,
                farfold_session_id,
            )?;
            model.verify(&target, &owned.model.profile_id)?;
            if &model != owned.model {
                return Err("Original focus model changed before commit".into());
            }
            let launch = super::runtime_owned_profile::current_launch_from(
                &transaction,
                &target.binding(),
                &model.profile_id,
                owned.generation,
            )?;
            if launch.home != owned.profile_home
                || launch.cwd != model.cwd
                || launch.working_copy_id != model.working_copy_id
            {
                return Err("Original owned focus launch changed before commit".into());
            }
        } else if target.adapter_id.as_str() == "codex-acp-stdio-v1" {
            return Err("ACP focus requires original owned identity".into());
        }
    }
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
    use std::fs;

    fn test_directory(name: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(&format!("farfold-session-open-{name}-"))
            .tempdir()
            .unwrap()
    }

    fn register_pi_session(
        database: &mut crate::host_store::HostDatabase,
        root: &std::path::Path,
        name: &str,
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
        let session_file = root.join(format!("{name}.jsonl"));
        fs::write(&session_file, b"{}\n").unwrap();
        let session_id = FarfoldSessionId::parse(format!("pi-open-{name}")).unwrap();
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
                    native_session_id: NativeSessionId::parse(format!("native-{name}")).unwrap(),
                    title: "Open me".to_string(),
                    title_source: SessionTitleSource::Native,
                    created_at: 2,
                    updated_at: 2,
                },
                &NativeSessionLocatorRegistration {
                    kind: NativeSessionLocatorKind::PiSessionFile,
                    locator_value: session_file.to_string_lossy().into_owned(),
                    allowed_root: Some(root.to_path_buf()),
                },
            )
            .unwrap();
        session_id
    }

    #[test]
    fn preview_resolves_only_the_exact_current_binding_and_live_paths() {
        let directory = test_directory("exact");
        let root = directory.path().canonicalize().unwrap();
        let database_path = root.join("host.sqlite3");
        let HostDatabaseOpen::Ready(mut database) = HostDatabaseOpen::open(database_path) else {
            panic!("database should open");
        };
        let session_id = register_pi_session(&mut database, &root, "session");

        let target = read_target(&mut database, &session_id).unwrap();
        let preview = target.preview();
        assert!(preview.can_open);
        assert!(preview.blockers.is_empty());
        assert_eq!(preview.farfold_session_id, session_id);
        assert_eq!(preview.native_session_id.as_str(), "native-session");

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
        assert!(
            noncurrent.project_blockers().is_empty(),
            "project artifacts do not require launching an installed Runtime"
        );
        assert_eq!(
            noncurrent.preview().blockers,
            vec![SessionOpenBlocker::RuntimeBuildNotCurrent]
        );

        fs::remove_file(root.join("session.jsonl")).unwrap();
        assert!(
            read_target(&mut database, &session_id)
                .unwrap()
                .project_blockers()
                .is_empty()
        );
        let mut unavailable = noncurrent.clone();
        unavailable.archived_at = Some(3);
        unavailable.working_copy_path = root.join("missing-workspace");
        assert_eq!(
            unavailable.project_blockers(),
            vec![
                SessionOpenBlocker::SessionArchived,
                SessionOpenBlocker::WorkingCopyUnavailable
            ]
        );
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
    fn focus_survives_reopen_without_rebinding_and_rejects_retired_sessions() {
        let directory = test_directory("focus");
        let root = directory.path().canonicalize().unwrap();
        let database_path = root.join("host.sqlite3");
        let HostDatabaseOpen::Ready(mut database) = HostDatabaseOpen::open(database_path.clone())
        else {
            panic!("database should open");
        };
        let first = register_pi_session(&mut database, &root, "first");
        let second = register_pi_session(&mut database, &root, "second");
        mark_opened(&mut database, &first).unwrap();
        let (revision, navigation) = mark_opened(&mut database, &second).unwrap();
        assert_eq!(
            serde_json::to_value(navigation).unwrap()["restoreState"]["lastSessionId"],
            second.as_str()
        );
        drop(database);
        let HostDatabaseOpen::Ready(mut database) = HostDatabaseOpen::open(database_path) else {
            panic!("database should reopen");
        };
        let restored: String = database
            .connection
            .query_row(
                "SELECT last_session_id FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(restored, second.as_str());
        let target = read_target(&mut database, &second).unwrap();
        assert_eq!(target.native_session_id.as_str(), "native-second");
        assert_eq!(target.title, "Open me");
        database
            .connection
            .execute(
                "UPDATE sessions SET archived_at = 3 WHERE farfold_session_id = ?1",
                [first.as_str()],
            )
            .unwrap();
        assert!(mark_opened(&mut database, &first).is_err());
        assert!(mark_opened(&mut database, &FarfoldSessionId::parse("unknown").unwrap()).is_err());
        let unchanged: (String, i64) = database
            .connection
            .query_row(
                "SELECT last_session_id, updated_at FROM app_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(unchanged, (second.as_str().to_string(), revision));
    }

    #[test]
    fn late_focus_must_not_overwrite_a_newer_persisted_navigation() {
        let directory = test_directory("late-focus");
        let root = directory.path().canonicalize().unwrap();
        let HostDatabaseOpen::Ready(mut database) =
            HostDatabaseOpen::open(root.join("host.sqlite3"))
        else {
            panic!("database should open");
        };
        let first = register_pi_session(&mut database, &root, "first");
        let second = register_pi_session(&mut database, &root, "second");
        mark_opened(&mut database, &first).unwrap();
        let expected_navigation = super::raw_navigation(&database.connection).unwrap();
        let original_target = read_target(&mut database, &first).unwrap();
        let before: (String, i64) = database
            .connection
            .query_row(
                "SELECT last_session_id,updated_at FROM app_state WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        mark_opened(&mut database, &second).unwrap();
        let expected_newer: (String, i64) = database
            .connection
            .query_row(
                "SELECT last_session_id,updated_at FROM app_state WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_ne!(before, expected_newer);
        let last_opened: i64 = database
            .connection
            .query_row(
                "SELECT last_opened_at FROM sessions WHERE farfold_session_id=?1",
                [first.as_str()],
                |r| r.get(0),
            )
            .unwrap();
        let guard = super::SessionFocusGuard {
            expected_navigation: &expected_navigation,
            target: &original_target,
            owned: None,
        };
        assert!(super::mark_opened_with_guard(&mut database, &first, Some(&guard)).is_err());
        let after: (String, i64) = database
            .connection
            .query_row(
                "SELECT last_session_id,updated_at FROM app_state WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            after, expected_newer,
            "late original focus must not overwrite B"
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT last_opened_at FROM sessions WHERE farfold_session_id=?1",
                    [first.as_str()],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            last_opened
        );
    }

    #[test]
    fn guarded_focus_distinguishes_absent_and_raw_null_state_and_keeps_legacy_path() {
        let directory = test_directory("raw-focus");
        let root = directory.path().canonicalize().unwrap();
        let HostDatabaseOpen::Ready(mut db) = HostDatabaseOpen::open(root.join("host.sqlite3"))
        else {
            panic!("ready")
        };
        let id = register_pi_session(&mut db, &root, "session");
        db.connection
            .execute("DELETE FROM app_state WHERE singleton=1", [])
            .unwrap();
        let target = read_target(&mut db, &id).unwrap();
        let absent = super::raw_navigation(&db.connection).unwrap();
        assert_eq!(absent, super::NavigationExpectation::Absent);
        let guard = super::SessionFocusGuard {
            expected_navigation: &absent,
            target: &target,
            owned: None,
        };
        let (revision, nav) = super::mark_opened_with_guard(&mut db, &id, Some(&guard)).unwrap();
        assert_eq!(
            serde_json::to_value(nav).unwrap()["restoreState"]["lastSessionId"],
            id.as_str()
        );
        assert!(super::mark_opened_with_guard(&mut db, &id, Some(&guard)).is_err());
        assert_eq!(
            db.connection
                .query_row(
                    "SELECT updated_at FROM app_state WHERE singleton=1",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            revision
        );
        db.connection.execute("UPDATE app_state SET last_project_id=NULL,last_session_id=NULL,updated_at=7 WHERE singleton=1",[]).unwrap();
        let nullable = super::raw_navigation(&db.connection).unwrap();
        assert_ne!(nullable, absent);
        let guard = super::SessionFocusGuard {
            expected_navigation: &nullable,
            target: &target,
            owned: None,
        };
        assert!(super::mark_opened_with_guard(&mut db, &id, Some(&guard)).is_ok());
        // Existing callers without a guard still perform sequential ordinary focus.
        assert!(mark_opened(&mut db, &id).is_ok());
        db.connection
            .execute(
                "UPDATE sessions SET archived_at=3 WHERE farfold_session_id=?1",
                [id.as_str()],
            )
            .unwrap();
        let raw = serde_json::to_value(super::raw_navigation(&db.connection).unwrap()).unwrap();
        assert_eq!(
            raw["lastSessionId"],
            id.as_str(),
            "do not normalize archived target out of raw CAS token"
        );
        let nav = super::super::session_binding_index::navigation_snapshot_from_connection(
            &db.connection,
            15,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(nav).unwrap()["restoreState"]["lastSessionId"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn preview_rejects_archived_session() {
        let directory = test_directory("blocked");
        let root = directory.path().canonicalize().unwrap();
        let database_path = root.join("host.sqlite3");
        let HostDatabaseOpen::Ready(mut database) = HostDatabaseOpen::open(database_path) else {
            panic!("database should open");
        };
        let session_id = register_pi_session(&mut database, &root, "session");
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
