use super::{HostDatabase, HostStore, now_millis};
use crate::{
    host_ids::{
        FarfoldSessionId, NativeSessionId, ProjectId, RuntimeProductId, WorkingCopyId,
        derived_host_id,
    },
    host_store::{
        records::WorkingCopyKind,
        working_copy_manager::{
            WorkingCopyGitStatus, WorkingCopyPathState, observe_working_copy_safety,
        },
    },
    opencode_runtime::{self, OpenCodeRuntime},
    pi_runtime::{self, PiRuntime},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionDeletionBlocker {
    SessionNotArchived,
    OpenAttention,
    AgentRuntimesNotStopped,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletionEffects {
    deletes_farfold_session_metadata: bool,
    deletes_draft: bool,
    deletes_attention_record_count: u64,
    deletes_turn_change_review_count: u64,
    deletes_turn_change_path_count: u64,
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
    confirmation_token: String,
    previewed_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionMetadataInput {
    farfold_session_id: FarfoldSessionId,
    expected_confirmation_token: String,
    confirm_farfold_session_id: FarfoldSessionId,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeletedSessionMetadata {
    farfold_session_id: FarfoldSessionId,
    deleted_at: i64,
    effects: SessionDeletionEffects,
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
    session_updated_at: i64,
    archived_at: Option<i64>,
    draft_updated_at: Option<i64>,
    attention_updated_at: Option<i64>,
    turn_change_review_count: i64,
    turn_change_path_count: i64,
    turn_change_updated_at: Option<i64>,
}

impl HostStore {
    pub fn session_deletion_preview(
        &self,
        farfold_session_id: &FarfoldSessionId,
        runtimes_stopped: bool,
    ) -> Result<SessionDeletionPreview, String> {
        self.with_ready_database(|database| preview(database, farfold_session_id, runtimes_stopped))
    }
}

fn checked_count(value: i64, label: &str) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| format!("Stored {label} is invalid"))
}

fn read_raw(
    connection: &Connection,
    farfold_session_id: &FarfoldSessionId,
) -> Result<RawDeletionPreview, String> {
    connection
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
                   AND sibling.project_id = s.project_id AND sibling.archived_at IS NULL),
                s.updated_at, s.archived_at,
                (SELECT d.updated_at FROM session_drafts d
                 WHERE d.farfold_session_id = s.farfold_session_id),
                (SELECT MAX(a.updated_at) FROM session_attention a
                 WHERE a.farfold_session_id = s.farfold_session_id),
                (SELECT COUNT(*) FROM turn_change_reviews review
                 WHERE review.farfold_session_id = s.farfold_session_id),
                (SELECT COUNT(*) FROM turn_change_paths path
                 JOIN turn_change_reviews review ON review.host_turn_id = path.host_turn_id
                 WHERE review.farfold_session_id = s.farfold_session_id),
                (SELECT MAX(review.updated_at) FROM turn_change_reviews review
                 WHERE review.farfold_session_id = s.farfold_session_id)
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
                    session_updated_at: row.get(16)?,
                    archived_at: row.get(17)?,
                    draft_updated_at: row.get(18)?,
                    attention_updated_at: row.get(19)?,
                    turn_change_review_count: row.get(20)?,
                    turn_change_path_count: row.get(21)?,
                    turn_change_updated_at: row.get(22)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read Session deletion preview: {error}"))?
        .ok_or_else(|| "Farfold Session does not exist".to_string())
}

fn confirmation_token(raw: &RawDeletionPreview) -> String {
    derived_host_id(
        "delete",
        &[
            &raw.farfold_session_id,
            &raw.title,
            &raw.runtime_product_id,
            &raw.native_session_id,
            &raw.project_id,
            &raw.project_name,
            &raw.working_copy_id,
            &raw.working_copy_path,
            &raw.working_copy_kind,
            &raw.session_updated_at.to_string(),
            &raw.archived_at.unwrap_or(-1).to_string(),
            &raw.draft_byte_count.to_string(),
            &raw.draft_updated_at.unwrap_or(-1).to_string(),
            &raw.attention_record_count.to_string(),
            &raw.open_attention_count.to_string(),
            &raw.attention_updated_at.unwrap_or(-1).to_string(),
            &raw.turn_change_review_count.to_string(),
            &raw.turn_change_path_count.to_string(),
            &raw.turn_change_updated_at.unwrap_or(-1).to_string(),
            if raw.has_native_locator { "1" } else { "0" },
            &raw.bound_session_count.to_string(),
            &raw.unarchived_session_count.to_string(),
        ],
    )
}

fn effects(raw: &RawDeletionPreview) -> Result<SessionDeletionEffects, String> {
    Ok(SessionDeletionEffects {
        deletes_farfold_session_metadata: true,
        deletes_draft: raw.draft_updated_at.is_some(),
        deletes_attention_record_count: checked_count(
            raw.attention_record_count,
            "attention count",
        )?,
        deletes_turn_change_review_count: checked_count(
            raw.turn_change_review_count,
            "Turn Changes review count",
        )?,
        deletes_turn_change_path_count: checked_count(
            raw.turn_change_path_count,
            "Turn Changes path count",
        )?,
        deletes_native_locator: raw.has_native_locator,
        retains_native_runtime_session: true,
        retains_project: true,
        retains_working_copy: true,
    })
}

fn preview(
    database: &mut HostDatabase,
    farfold_session_id: &FarfoldSessionId,
    runtimes_stopped: bool,
) -> Result<SessionDeletionPreview, String> {
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Cannot begin Session deletion preview: {error}"))?;
    let raw = read_raw(&transaction, farfold_session_id)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Session deletion preview: {error}"))?;

    let (path_state, git_status) = observe_working_copy_safety(Path::new(&raw.working_copy_path));
    let open_attention_count = checked_count(raw.open_attention_count, "open attention count")?;
    let draft_byte_count = checked_count(raw.draft_byte_count, "draft byte count")?;
    let deletion_effects = effects(&raw)?;
    let mut blockers = Vec::new();
    if !raw.archived {
        blockers.push(SessionDeletionBlocker::SessionNotArchived);
    }
    if open_attention_count > 0 {
        blockers.push(SessionDeletionBlocker::OpenAttention);
    }
    if !runtimes_stopped {
        blockers.push(SessionDeletionBlocker::AgentRuntimesNotStopped);
    }
    let execution_enabled = blockers.is_empty();
    let confirmation_token = confirmation_token(&raw);
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
        effects: deletion_effects,
        blockers,
        execution_enabled,
        confirmation_token,
        previewed_at: now_millis(),
    })
}

fn delete_metadata(
    database: &mut HostDatabase,
    input: DeleteSessionMetadataInput,
) -> Result<DeletedSessionMetadata, String> {
    if input.farfold_session_id != input.confirm_farfold_session_id {
        return Err(
            "Session deletion confirmation does not match the requested Session".to_string(),
        );
    }
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot begin Session metadata deletion: {error}"))?;
    let raw = read_raw(&transaction, &input.farfold_session_id)?;
    if !raw.archived {
        return Err("Farfold Session must be archived before deletion".to_string());
    }
    if raw.open_attention_count != 0 {
        return Err("Farfold Session still has open attention".to_string());
    }
    if confirmation_token(&raw) != input.expected_confirmation_token {
        return Err("Session deletion preview is stale; preview and confirm again".to_string());
    }
    let effects = effects(&raw)?;
    let deleted = transaction
        .execute(
            "DELETE FROM sessions WHERE farfold_session_id = ?1",
            params![input.farfold_session_id.as_str()],
        )
        .map_err(|error| format!("Cannot delete Farfold Session metadata: {error}"))?;
    if deleted != 1 {
        return Err("Farfold Session changed during deletion".to_string());
    }
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Session metadata deletion: {error}"))?;
    Ok(DeletedSessionMetadata {
        farfold_session_id: input.farfold_session_id,
        deleted_at: now_millis(),
        effects,
    })
}

#[tauri::command]
pub fn session_deletion_preview(
    store: State<'_, HostStore>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    farfold_session_id: FarfoldSessionId,
) -> Result<SessionDeletionPreview, String> {
    let runtimes_stopped = pi_runtime::is_stopped(&pi)? && opencode_runtime::is_stopped(&opencode)?;
    store.session_deletion_preview(&farfold_session_id, runtimes_stopped)
}

#[tauri::command]
pub fn session_metadata_delete(
    store: State<'_, HostStore>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: DeleteSessionMetadataInput,
) -> Result<DeletedSessionMetadata, String> {
    pi_runtime::with_stopped(&pi, || {
        opencode_runtime::with_stopped(&opencode, || {
            store.with_ready_database(|database| delete_metadata(database, input))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{DeleteSessionMetadataInput, SessionDeletionBlocker, delete_metadata, preview};
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
                    ('attention-1', 'session-1', 'outcome_unknown', 1, NULL, 'open', 3, 3);
                 INSERT INTO turn_change_reviews(
                    host_turn_id, farfold_session_id, working_copy_id, runtime_product_id,
                    provenance_state, baseline_clean, managed_worktree, change_path_count,
                    started_at, completed_at, updated_at
                 ) VALUES (
                    'turn-1', 'session-1', 'working-copy-1', 'pi',
                    'available', 1, 1, 1, 3, 3, 3
                 );
                 INSERT INTO turn_change_paths VALUES
                    ('turn-1', 'changed.txt', NULL, 'modified');",
            )
            .unwrap();
        let native_session_file = root.join("native-session.jsonl");
        fs::write(&native_session_file, "native history\n").unwrap();
        database
            .connection
            .execute(
                "INSERT INTO session_native_locators VALUES
                    ('session-1', 'pi_session_file', ?1, 3, 3)",
                params![native_session_file.to_string_lossy().as_ref()],
            )
            .unwrap();
        let result = preview(&mut database, &session_id, false).unwrap();
        assert_eq!(result.draft_byte_count, 5);
        assert_eq!(result.open_attention_count, 1);
        assert_eq!(
            result.blockers,
            vec![
                SessionDeletionBlocker::SessionNotArchived,
                SessionDeletionBlocker::OpenAttention,
                SessionDeletionBlocker::AgentRuntimesNotStopped,
            ]
        );
        assert!(!result.execution_enabled);
        assert!(result.effects.deletes_farfold_session_metadata);
        assert!(result.effects.deletes_draft);
        assert_eq!(result.effects.deletes_attention_record_count, 1);
        assert_eq!(result.effects.deletes_turn_change_review_count, 1);
        assert_eq!(result.effects.deletes_turn_change_path_count, 1);
        assert!(result.effects.deletes_native_locator);
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
        let archived = preview(&mut database, &session_id, true).unwrap();
        assert!(archived.blockers.is_empty());
        assert!(archived.execution_enabled);
        database
            .connection
            .execute(
                "UPDATE session_drafts SET body = 'changed draft', updated_at = 5
                 WHERE farfold_session_id = ?1",
                params![session_id.as_str()],
            )
            .unwrap();
        let stale_error = delete_metadata(
            &mut database,
            DeleteSessionMetadataInput {
                farfold_session_id: session_id.clone(),
                expected_confirmation_token: archived.confirmation_token,
                confirm_farfold_session_id: session_id.clone(),
            },
        )
        .unwrap_err();
        assert!(stale_error.contains("stale"));
        let refreshed = preview(&mut database, &session_id, true).unwrap();
        let deleted = delete_metadata(
            &mut database,
            DeleteSessionMetadataInput {
                farfold_session_id: session_id.clone(),
                expected_confirmation_token: refreshed.confirmation_token,
                confirm_farfold_session_id: session_id.clone(),
            },
        )
        .unwrap();
        assert_eq!(deleted.farfold_session_id, session_id);
        assert!(deleted.effects.deletes_draft);
        assert_eq!(deleted.effects.deletes_attention_record_count, 1);
        assert_eq!(deleted.effects.deletes_turn_change_review_count, 1);
        assert_eq!(deleted.effects.deletes_turn_change_path_count, 1);
        assert_eq!(
            database
                .connection
                .query_row("SELECT COUNT(*) FROM sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT COUNT(*) FROM turn_change_reviews", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT COUNT(*) FROM turn_change_paths", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT COUNT(*) FROM session_native_locators", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT COUNT(*) FROM session_drafts", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT COUNT(*) FROM session_attention", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT COUNT(*) FROM projects", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(native_session_file.is_file());
        assert_eq!(
            database
                .connection
                .query_row("SELECT COUNT(*) FROM working_copies", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        drop(database);
        let _ = fs::remove_dir_all(root);
    }
}
