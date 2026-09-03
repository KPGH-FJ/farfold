use super::{HostDatabase, HostStore, now_millis};
use crate::{
    host_ids::{FarfoldSessionId, NativeSessionId, ProjectId, RuntimeProductId, WorkingCopyId},
    host_store::{
        records::WorkingCopyKind,
        working_copy_manager::{
            WorkingCopyGitStatus, WorkingCopyPathState, observe_working_copy_safety,
        },
    },
};
use rusqlite::{OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::path::Path;
use tauri::State;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionDeletionBlocker {
    SessionNotArchived,
    OpenAttention,
    ActiveTurnVerificationRequired,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletionEffects {
    deletes_farfold_session_metadata: bool,
    deletes_draft: bool,
    deletes_attention_record_count: u64,
    deletes_native_locator: bool,
    retains_native_runtime_session: bool,
    retains_project: bool,
    retains_working_copy: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletionWorkingCopy {
    working_copy_id: WorkingCopyId,
    canonical_path: String,
    kind: WorkingCopyKind,
    path_state: WorkingCopyPathState,
    git_status: WorkingCopyGitStatus,
    bound_session_count: u64,
    unarchived_session_count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletionPreview {
    farfold_session_id: FarfoldSessionId,
    title: String,
    runtime_product_id: RuntimeProductId,
    native_session_id: NativeSessionId,
    project_id: ProjectId,
    project_name: String,
    archived: bool,
    open_attention_count: u64,
    draft_byte_count: u64,
    working_copy: SessionDeletionWorkingCopy,
    effects: SessionDeletionEffects,
    blockers: Vec<SessionDeletionBlocker>,
    execution_enabled: bool,
    previewed_at: i64,
}

struct RawDeletionPreview {
    farfold_session_id: String,
    title: String,
    runtime_product_id: String,
    native_session_id: String,
    project_id: String,
    project_name: String,
    archived: bool,
    working_copy_id: String,
    working_copy_path: String,
    working_copy_kind: String,
    draft_byte_count: i64,
    attention_record_count: i64,
    open_attention_count: i64,
    has_native_locator: bool,
    bound_session_count: i64,
    unarchived_session_count: i64,
}

impl HostStore {
    pub fn session_deletion_preview(
        &self,
        farfold_session_id: &FarfoldSessionId,
    ) -> Result<SessionDeletionPreview, String> {
        self.with_ready_database(|database| preview(database, farfold_session_id))
    }
}

fn checked_count(value: i64, label: &str) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| format!("Stored {label} is invalid"))
}

fn preview(
    database: &mut HostDatabase,
    farfold_session_id: &FarfoldSessionId,
) -> Result<SessionDeletionPreview, String> {
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Cannot begin Session deletion preview: {error}"))?;
    let raw = transaction
        .query_row(
            "SELECT
                s.farfold_session_id, s.title, s.runtime_product_id, s.native_session_id,
                s.project_id, p.display_name, s.archived_at IS NOT NULL,
                s.working_copy_id, w.canonical_path, w.kind,
                COALESCE((SELECT length(CAST(d.body AS BLOB)) FROM session_drafts d
                          WHERE d.farfold_session_id = s.farfold_session_id), 0),
                (SELECT COUNT(*) FROM session_attention a
                 WHERE a.farfold_session_id = s.farfold_session_id),
                (SELECT COUNT(*) FROM session_attention a
                 WHERE a.farfold_session_id = s.farfold_session_id AND a.status = 'open'),
                EXISTS(SELECT 1 FROM session_native_locators l
                       WHERE l.farfold_session_id = s.farfold_session_id),
                (SELECT COUNT(*) FROM sessions sibling
                 WHERE sibling.working_copy_id = s.working_copy_id
                   AND sibling.project_id = s.project_id),
                (SELECT COUNT(*) FROM sessions sibling
                 WHERE sibling.working_copy_id = s.working_copy_id
                   AND sibling.project_id = s.project_id AND sibling.archived_at IS NULL)
             FROM sessions s
             JOIN projects p ON p.project_id = s.project_id
             JOIN working_copies w
               ON w.working_copy_id = s.working_copy_id AND w.project_id = s.project_id
             WHERE s.farfold_session_id = ?1",
            [farfold_session_id.as_str()],
            |row| {
                Ok(RawDeletionPreview {
                    farfold_session_id: row.get(0)?,
                    title: row.get(1)?,
                    runtime_product_id: row.get(2)?,
                    native_session_id: row.get(3)?,
                    project_id: row.get(4)?,
                    project_name: row.get(5)?,
                    archived: row.get(6)?,
                    working_copy_id: row.get(7)?,
                    working_copy_path: row.get(8)?,
                    working_copy_kind: row.get(9)?,
                    draft_byte_count: row.get(10)?,
                    attention_record_count: row.get(11)?,
                    open_attention_count: row.get(12)?,
                    has_native_locator: row.get(13)?,
                    bound_session_count: row.get(14)?,
                    unarchived_session_count: row.get(15)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read Session deletion preview: {error}"))?
        .ok_or_else(|| "Farfold Session does not exist".to_string())?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Session deletion preview: {error}"))?;

    let (path_state, git_status) = observe_working_copy_safety(Path::new(&raw.working_copy_path));
    let attention_record_count = checked_count(raw.attention_record_count, "attention count")?;
    let open_attention_count = checked_count(raw.open_attention_count, "open attention count")?;
    let draft_byte_count = checked_count(raw.draft_byte_count, "draft byte count")?;
    let mut blockers = Vec::new();
    if !raw.archived {
        blockers.push(SessionDeletionBlocker::SessionNotArchived);
    }
    if open_attention_count > 0 {
        blockers.push(SessionDeletionBlocker::OpenAttention);
    }
    blockers.push(SessionDeletionBlocker::ActiveTurnVerificationRequired);
    Ok(SessionDeletionPreview {
        farfold_session_id: FarfoldSessionId::parse(raw.farfold_session_id)
            .map_err(|error| error.to_string())?,
        title: raw.title,
        runtime_product_id: RuntimeProductId::parse(raw.runtime_product_id)
            .map_err(|error| error.to_string())?,
        native_session_id: NativeSessionId::parse(raw.native_session_id)
            .map_err(|error| error.to_string())?,
        project_id: ProjectId::parse(raw.project_id).map_err(|error| error.to_string())?,
        project_name: raw.project_name,
        archived: raw.archived,
        open_attention_count,
        draft_byte_count,
        working_copy: SessionDeletionWorkingCopy {
            working_copy_id: WorkingCopyId::parse(raw.working_copy_id)
                .map_err(|error| error.to_string())?,
            canonical_path: raw.working_copy_path,
            kind: WorkingCopyKind::parse(&raw.working_copy_kind)?,
            path_state,
            git_status,
            bound_session_count: checked_count(raw.bound_session_count, "bound Session count")?,
            unarchived_session_count: checked_count(
                raw.unarchived_session_count,
                "unarchived Session count",
            )?,
        },
        effects: SessionDeletionEffects {
            deletes_farfold_session_metadata: true,
            deletes_draft: draft_byte_count > 0,
            deletes_attention_record_count: attention_record_count,
            deletes_native_locator: raw.has_native_locator,
            retains_native_runtime_session: true,
            retains_project: true,
            retains_working_copy: true,
        },
        blockers,
        execution_enabled: false,
        previewed_at: now_millis(),
    })
}

#[tauri::command]
pub fn session_deletion_preview(
    store: State<'_, HostStore>,
    farfold_session_id: FarfoldSessionId,
) -> Result<SessionDeletionPreview, String> {
    store.session_deletion_preview(&farfold_session_id)
}

#[cfg(test)]
mod tests {
    use super::{SessionDeletionBlocker, preview};
    use crate::{
        host_ids::{
            AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
            RuntimeBuildId, RuntimeProductId, WorkingCopyId,
        },
        host_store::{
            HostDatabaseOpen,
            records::{
                RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration,
                SessionRegistration, SessionTitleSource, WorkingCopyKind,
            },
        },
    };
    use rusqlite::params;
    use std::fs;

    #[test]
    fn deletion_preview_is_bounded_and_keeps_external_assets() {
        let root = std::env::temp_dir().join(format!(
            "farfold-session-delete-preview-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let mut database = match HostDatabaseOpen::open(root.join("host.sqlite3")) {
            HostDatabaseOpen::Ready(database) => database,
            HostDatabaseOpen::Recovery(recovery) => panic!("{}", recovery.reason()),
        };
        database
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse("pi").unwrap(),
                display_name: "Pi".to_string(),
                installation_id: InstallationId::parse("pi-installation").unwrap(),
                runtime_build_id: RuntimeBuildId::parse("pi@1+sha256:aaaa").unwrap(),
                adapter_id: AdapterId::parse("pi-adapter").unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: "1".to_string(),
                artifact_sha256: "a".repeat(64),
                connection_id: ConnectionId::parse("pi-connection").unwrap(),
                connection_label: "Pi native configuration".to_string(),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: 1,
                verified_at: 1,
            })
            .unwrap();
        let session_id = FarfoldSessionId::parse("session-1").unwrap();
        database
            .register_session(&SessionRegistration {
                farfold_session_id: session_id.clone(),
                runtime_product_id: RuntimeProductId::parse("pi").unwrap(),
                installation_id: InstallationId::parse("pi-installation").unwrap(),
                runtime_build_id: RuntimeBuildId::parse("pi@1+sha256:aaaa").unwrap(),
                adapter_id: AdapterId::parse("pi-adapter").unwrap(),
                connection_id: ConnectionId::parse("pi-connection").unwrap(),
                project_id: ProjectId::parse("project-1").unwrap(),
                project_path: project.clone(),
                project_name: "Project".to_string(),
                working_copy_id: WorkingCopyId::parse("working-copy-1").unwrap(),
                working_copy_path: project.clone(),
                working_copy_kind: WorkingCopyKind::Root,
                branch_name: None,
                native_session_id: NativeSessionId::parse("native-1").unwrap(),
                title: "Session".to_string(),
                title_source: SessionTitleSource::Native,
                created_at: 2,
                updated_at: 2,
            })
            .unwrap();
        database
            .connection
            .execute_batch(
                "INSERT INTO session_drafts VALUES ('session-1', 'draft', 3);
                 INSERT INTO session_attention VALUES
                    ('attention-1', 'session-1', 'outcome_unknown', 1, NULL, 'open', 3, 3);",
            )
            .unwrap();
        let result = preview(&mut database, &session_id).unwrap();
        assert_eq!(result.draft_byte_count, 5);
        assert_eq!(result.open_attention_count, 1);
        assert_eq!(
            result.blockers,
            vec![
                SessionDeletionBlocker::SessionNotArchived,
                SessionDeletionBlocker::OpenAttention,
                SessionDeletionBlocker::ActiveTurnVerificationRequired,
            ]
        );
        assert!(!result.execution_enabled);
        assert!(result.effects.deletes_farfold_session_metadata);
        assert!(result.effects.deletes_draft);
        assert_eq!(result.effects.deletes_attention_record_count, 1);
        assert!(result.effects.retains_native_runtime_session);
        assert!(result.effects.retains_project);
        assert!(result.effects.retains_working_copy);
        assert!(project.is_dir());
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM sessions WHERE farfold_session_id = ?1",
                    params![session_id.as_str()],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        database
            .connection
            .execute(
                "UPDATE sessions SET archived_at = 4, updated_at = 4
                 WHERE farfold_session_id = ?1",
                params![session_id.as_str()],
            )
            .unwrap();
        database
            .connection
            .execute(
                "UPDATE session_attention SET status = 'closed', updated_at = 4
                 WHERE farfold_session_id = ?1",
                params![session_id.as_str()],
            )
            .unwrap();
        let archived = preview(&mut database, &session_id).unwrap();
        assert_eq!(
            archived.blockers,
            vec![SessionDeletionBlocker::ActiveTurnVerificationRequired]
        );
        assert!(!archived.execution_enabled);
        drop(database);
        let _ = fs::remove_dir_all(root);
    }
}
