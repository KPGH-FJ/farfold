use super::{HostStorageMode, HostStore, now_millis};
use crate::{
    host_ids::{ProjectId, WorkingCopyId, derived_host_id},
    host_store::{
        records::WorkingCopyKind,
        working_copy_manager::{
            WorkingCopyChangeState, WorkingCopyGitStatus, WorkingCopyPathState,
            observe_working_copy_safety, registration_preview,
        },
    },
    session_controller::HostSessionController,
    turn_coordinator::TurnCoordinator,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedWorktreeRemovalState {
    Removing,
    Removed,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedWorktreeRemovalBlocker {
    NotReady,
    RemovalInProgress,
    AlreadyRemoved,
    BoundSessions,
    PathUnavailable,
    IdentityMismatch,
    ChangesPresent,
    GitUnavailable,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreeRemovalPreviewInput {
    working_copy_id: WorkingCopyId,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreeRemovalEffects {
    removes_worktree_directory: bool,
    retains_branch: bool,
    retains_project: bool,
    retains_source_working_copy: bool,
    deletes_farfold_sessions: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreeRemovalPreview {
    working_copy_id: WorkingCopyId,
    project_id: ProjectId,
    working_copy_path: String,
    branch_name: String,
    current_head_oid: Option<String>,
    path_state: WorkingCopyPathState,
    git_status: WorkingCopyGitStatus,
    bound_session_count: u64,
    prior_removal_state: Option<ManagedWorktreeRemovalState>,
    effects: ManagedWorktreeRemovalEffects,
    blockers: Vec<ManagedWorktreeRemovalBlocker>,
    execution_enabled: bool,
    confirmation_token: String,
    previewed_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreeRemoveInput {
    working_copy_id: WorkingCopyId,
    confirm_working_copy_id: WorkingCopyId,
    expected_confirmation_token: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreeRemovalResult {
    working_copy_id: WorkingCopyId,
    working_copy_path: String,
    branch_name: String,
    retained_branch: bool,
    lifecycle_state: ManagedWorktreeRemovalState,
    removed_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManagedWorktreeRemovalReconciliation {
    pub inspected: u64,
    pub recovered_removed: u64,
    pub marked_failed: u64,
}

#[derive(Debug, Clone)]
struct RawManagedWorktree {
    working_copy_id: WorkingCopyId,
    project_id: ProjectId,
    working_copy_path: PathBuf,
    working_copy_kind: WorkingCopyKind,
    branch_name: String,
    working_copy_updated_at: i64,
    project_path: PathBuf,
    source_working_copy_id: WorkingCopyId,
    source_head_oid: String,
    managed_state: String,
    managed_updated_at: i64,
    bound_session_count: u64,
    removal_state: Option<ManagedWorktreeRemovalState>,
    removal_updated_at: Option<i64>,
}

impl ManagedWorktreeRemovalState {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "removing" => Ok(Self::Removing),
            "removed" => Ok(Self::Removed),
            "failed" => Ok(Self::Failed),
            _ => Err(format!("Unknown managed Worktree removal state: {value}")),
        }
    }

    fn token_value(self) -> &'static str {
        match self {
            Self::Removing => "removing",
            Self::Removed => "removed",
            Self::Failed => "failed",
        }
    }
}

fn path_state_token(state: WorkingCopyPathState) -> &'static str {
    match state {
        WorkingCopyPathState::Ready => "ready",
        WorkingCopyPathState::Missing => "missing",
        WorkingCopyPathState::NotDirectory => "not_directory",
        WorkingCopyPathState::IdentityMismatch => "identity_mismatch",
        WorkingCopyPathState::Unavailable => "unavailable",
    }
}

fn change_state_token(state: WorkingCopyChangeState) -> &'static str {
    match state {
        WorkingCopyChangeState::Clean => "clean",
        WorkingCopyChangeState::Dirty => "dirty",
        WorkingCopyChangeState::Conflicted => "conflicted",
        WorkingCopyChangeState::NotGit => "not_git",
        WorkingCopyChangeState::Unavailable => "unavailable",
    }
}

fn read_managed_worktree(
    store: &HostStore,
    working_copy_id: &WorkingCopyId,
) -> Result<RawManagedWorktree, String> {
    store.with_ready_database(|database| {
        let raw = database
            .connection
            .query_row(
                "SELECT
                    w.working_copy_id, w.project_id, w.canonical_path, w.kind,
                    m.branch_name, w.updated_at, p.canonical_path,
                    m.source_working_copy_id, m.source_head_oid,
                    m.lifecycle_state, m.updated_at,
                    (SELECT COUNT(*) FROM sessions s
                     WHERE s.working_copy_id = w.working_copy_id
                       AND s.project_id = w.project_id),
                    r.lifecycle_state, r.updated_at
                 FROM working_copies w
                 JOIN projects p ON p.project_id = w.project_id
                 JOIN managed_worktrees m
                   ON m.working_copy_id = w.working_copy_id
                  AND m.project_id = w.project_id
                 LEFT JOIN managed_worktree_removals r
                   ON r.working_copy_id = w.working_copy_id
                  AND r.project_id = w.project_id
                 WHERE w.working_copy_id = ?1",
                [working_copy_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, i64>(11)?,
                        row.get::<_, Option<String>>(12)?,
                        row.get::<_, Option<i64>>(13)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot read managed Worktree removal target: {error}"))?
            .ok_or_else(|| "Managed Worktree does not exist".to_string())?;
        Ok(RawManagedWorktree {
            working_copy_id: WorkingCopyId::parse(raw.0).map_err(|error| error.to_string())?,
            project_id: ProjectId::parse(raw.1).map_err(|error| error.to_string())?,
            working_copy_path: PathBuf::from(raw.2),
            working_copy_kind: WorkingCopyKind::parse(&raw.3)?,
            branch_name: raw.4,
            working_copy_updated_at: raw.5,
            project_path: PathBuf::from(raw.6),
            source_working_copy_id: WorkingCopyId::parse(raw.7)
                .map_err(|error| error.to_string())?,
            source_head_oid: raw.8,
            managed_state: raw.9,
            managed_updated_at: raw.10,
            bound_session_count: u64::try_from(raw.11)
                .map_err(|_| "Managed Worktree Session count is invalid".to_string())?,
            removal_state: raw
                .12
                .as_deref()
                .map(ManagedWorktreeRemovalState::parse)
                .transpose()?,
            removal_updated_at: raw.13,
        })
    })
}

fn git_stdout(path: &Path, arguments: &[&str], operation: &str) -> Result<String, String> {
    let output = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .env("LC_ALL", "C")
        .output()
        .map_err(|error| format!("Cannot {operation}: {error}"))?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Cannot {operation}: {}", reason.trim()));
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|error| {
            format!("Git returned non-UTF-8 output while attempting to {operation}: {error}")
        })
}

fn branch_exists(path: &Path, branch_name: &str) -> Result<bool, String> {
    let status = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(path)
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch_name}"))
        .env("LC_ALL", "C")
        .status()
        .map_err(|error| format!("Cannot inspect retained Worktree branch: {error}"))?;
    match status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err("Git could not determine whether the Worktree branch exists".to_string()),
    }
}

fn push_blocker(
    blockers: &mut Vec<ManagedWorktreeRemovalBlocker>,
    blocker: ManagedWorktreeRemovalBlocker,
) {
    if !blockers.contains(&blocker) {
        blockers.push(blocker);
    }
}

fn confirmation_token(
    raw: &RawManagedWorktree,
    path_state: WorkingCopyPathState,
    git_status: &WorkingCopyGitStatus,
    current_head_oid: Option<&str>,
) -> String {
    derived_host_id(
        "remove-managed-worktree",
        &[
            raw.working_copy_id.as_str(),
            raw.project_id.as_str(),
            &raw.working_copy_path.to_string_lossy(),
            &raw.branch_name,
            &raw.working_copy_updated_at.to_string(),
            raw.source_working_copy_id.as_str(),
            &raw.source_head_oid,
            &raw.managed_state,
            &raw.managed_updated_at.to_string(),
            &raw.bound_session_count.to_string(),
            raw.removal_state
                .map(ManagedWorktreeRemovalState::token_value)
                .unwrap_or("none"),
            &raw.removal_updated_at.unwrap_or(-1).to_string(),
            path_state_token(path_state),
            change_state_token(git_status.state),
            &git_status.staged_path_count.to_string(),
            &git_status.unstaged_path_count.to_string(),
            &git_status.untracked_path_count.to_string(),
            &git_status.conflicted_path_count.to_string(),
            current_head_oid.unwrap_or("unavailable"),
        ],
    )
}

fn preview_for_root(
    store: &HostStore,
    managed_root: &Path,
    input: &ManagedWorktreeRemovalPreviewInput,
) -> Result<ManagedWorktreeRemovalPreview, String> {
    let managed_root = managed_root
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Farfold application data root: {error}"))?;
    let raw = read_managed_worktree(store, &input.working_copy_id)?;
    let mut blockers = Vec::new();
    if raw.working_copy_kind != WorkingCopyKind::Worktree || raw.managed_state != "ready" {
        push_blocker(&mut blockers, ManagedWorktreeRemovalBlocker::NotReady);
    }
    match raw.removal_state {
        Some(ManagedWorktreeRemovalState::Removing) => push_blocker(
            &mut blockers,
            ManagedWorktreeRemovalBlocker::RemovalInProgress,
        ),
        Some(ManagedWorktreeRemovalState::Removed) => {
            push_blocker(&mut blockers, ManagedWorktreeRemovalBlocker::AlreadyRemoved)
        }
        Some(ManagedWorktreeRemovalState::Failed) | None => {}
    }
    if raw.bound_session_count > 0 {
        push_blocker(&mut blockers, ManagedWorktreeRemovalBlocker::BoundSessions);
    }
    if !raw
        .working_copy_path
        .starts_with(managed_root.join("managed-worktrees"))
    {
        push_blocker(
            &mut blockers,
            ManagedWorktreeRemovalBlocker::IdentityMismatch,
        );
    }
    let (path_state, git_status) = observe_working_copy_safety(&raw.working_copy_path);
    if path_state != WorkingCopyPathState::Ready {
        push_blocker(
            &mut blockers,
            ManagedWorktreeRemovalBlocker::PathUnavailable,
        );
    }
    match git_status.state {
        WorkingCopyChangeState::Clean => {}
        WorkingCopyChangeState::Dirty | WorkingCopyChangeState::Conflicted => {
            push_blocker(&mut blockers, ManagedWorktreeRemovalBlocker::ChangesPresent)
        }
        WorkingCopyChangeState::NotGit | WorkingCopyChangeState::Unavailable => {
            push_blocker(&mut blockers, ManagedWorktreeRemovalBlocker::GitUnavailable)
        }
    }
    let project_ready = raw
        .project_path
        .canonicalize()
        .is_ok_and(|path| path == raw.project_path && path.is_dir());
    if !project_ready {
        push_blocker(&mut blockers, ManagedWorktreeRemovalBlocker::GitUnavailable);
    }
    let mut current_head_oid = None;
    if path_state == WorkingCopyPathState::Ready {
        match registration_preview(&raw.working_copy_path) {
            Ok(registration)
                if registration.project_id == raw.project_id
                    && registration.working_copy_id == raw.working_copy_id
                    && registration.kind == WorkingCopyKind::Worktree
                    && registration.branch_name.as_deref() == Some(raw.branch_name.as_str()) => {}
            _ => push_blocker(
                &mut blockers,
                ManagedWorktreeRemovalBlocker::IdentityMismatch,
            ),
        }
        match git_stdout(
            &raw.working_copy_path,
            &["rev-parse", "--verify", "HEAD"],
            "resolve managed Worktree HEAD",
        ) {
            Ok(head) => current_head_oid = Some(head.to_ascii_lowercase()),
            Err(_) => push_blocker(&mut blockers, ManagedWorktreeRemovalBlocker::GitUnavailable),
        }
    }
    if project_ready {
        match branch_exists(&raw.project_path, &raw.branch_name) {
            Ok(true) => {}
            Ok(false) => push_blocker(
                &mut blockers,
                ManagedWorktreeRemovalBlocker::IdentityMismatch,
            ),
            Err(_) => push_blocker(&mut blockers, ManagedWorktreeRemovalBlocker::GitUnavailable),
        }
    }
    let confirmation_token =
        confirmation_token(&raw, path_state, &git_status, current_head_oid.as_deref());
    Ok(ManagedWorktreeRemovalPreview {
        working_copy_id: raw.working_copy_id,
        project_id: raw.project_id,
        working_copy_path: raw.working_copy_path.to_string_lossy().into_owned(),
        branch_name: raw.branch_name,
        current_head_oid,
        path_state,
        git_status,
        bound_session_count: raw.bound_session_count,
        prior_removal_state: raw.removal_state,
        effects: ManagedWorktreeRemovalEffects {
            removes_worktree_directory: true,
            retains_branch: true,
            retains_project: true,
            retains_source_working_copy: true,
            deletes_farfold_sessions: false,
        },
        execution_enabled: blockers.is_empty(),
        blockers,
        confirmation_token,
        previewed_at: now_millis(),
    })
}

fn reserve_removal(
    store: &HostStore,
    preview: &ManagedWorktreeRemovalPreview,
) -> Result<(), String> {
    let current_head_oid = preview
        .current_head_oid
        .as_deref()
        .ok_or_else(|| "Managed Worktree removal preview has no HEAD".to_string())?;
    store.with_ready_database(|database| {
        let timestamp = now_millis();
        let transaction = database
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin managed Worktree removal: {error}"))?;
        let eligible = transaction
            .query_row(
                "SELECT EXISTS(
                SELECT 1 FROM managed_worktrees m
                JOIN working_copies w ON w.working_copy_id = m.working_copy_id
                 AND w.project_id = m.project_id
                WHERE m.working_copy_id = ?1 AND m.project_id = ?2
                 AND m.lifecycle_state = 'ready' AND w.canonical_path = ?3
                 AND m.branch_name = ?4 AND NOT EXISTS(
                    SELECT 1 FROM sessions s WHERE s.working_copy_id = m.working_copy_id
                     AND s.project_id = m.project_id))",
                params![
                    preview.working_copy_id.as_str(),
                    preview.project_id.as_str(),
                    preview.working_copy_path,
                    preview.branch_name
                ],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("Cannot revalidate managed Worktree removal: {error}"))?;
        if !eligible {
            return Err("Managed Worktree is no longer eligible for removal".to_string());
        }
        let changed = transaction
            .execute(
                "INSERT INTO managed_worktree_removals(
                working_copy_id, project_id, expected_path, expected_branch_name,
                expected_head_oid, retains_branch, lifecycle_state, error_code,
                created_at, updated_at, removed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, 'removing', NULL, ?6, ?6, NULL)
             ON CONFLICT(working_copy_id) DO UPDATE SET
                project_id = excluded.project_id, expected_path = excluded.expected_path,
                expected_branch_name = excluded.expected_branch_name,
                expected_head_oid = excluded.expected_head_oid, retains_branch = 1,
                lifecycle_state = 'removing', error_code = NULL,
                updated_at = excluded.updated_at, removed_at = NULL
             WHERE managed_worktree_removals.lifecycle_state = 'failed'",
                params![
                    preview.working_copy_id.as_str(),
                    preview.project_id.as_str(),
                    preview.working_copy_path,
                    preview.branch_name,
                    current_head_oid,
                    timestamp
                ],
            )
            .map_err(|error| format!("Cannot reserve managed Worktree removal: {error}"))?;
        if changed != 1 {
            return Err("Managed Worktree removal is already terminal or in progress".to_string());
        }
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit managed Worktree removal: {error}"))
    })
}

fn set_removal_state(
    store: &HostStore,
    working_copy_id: &WorkingCopyId,
    state: ManagedWorktreeRemovalState,
    error_code: Option<&str>,
) -> Result<i64, String> {
    let timestamp = now_millis();
    store.with_ready_database(|database| {
        let changed = database
            .connection
            .execute(
                "UPDATE managed_worktree_removals SET lifecycle_state = ?2, error_code = ?3,
             updated_at = ?4, removed_at = CASE WHEN ?2 = 'removed' THEN ?4 ELSE NULL END
             WHERE working_copy_id = ?1 AND lifecycle_state = 'removing'",
                params![
                    working_copy_id.as_str(),
                    state.token_value(),
                    error_code,
                    timestamp
                ],
            )
            .map_err(|error| format!("Cannot update managed Worktree removal: {error}"))?;
        if changed == 1 {
            Ok(timestamp)
        } else {
            Err("Managed Worktree removal changed unexpectedly".to_string())
        }
    })
}

fn bounded_stderr(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .trim()
        .chars()
        .take(800)
        .collect()
}

fn remove_for_root(
    store: &HostStore,
    turns: &TurnCoordinator,
    managed_root: &Path,
    input: ManagedWorktreeRemoveInput,
) -> Result<ManagedWorktreeRemovalResult, String> {
    if input.confirm_working_copy_id != input.working_copy_id {
        return Err("Managed Worktree removal confirmation does not match the target".to_string());
    }
    let preview = preview_for_root(
        store,
        managed_root,
        &ManagedWorktreeRemovalPreviewInput {
            working_copy_id: input.working_copy_id.clone(),
        },
    )?;
    if preview.confirmation_token != input.expected_confirmation_token {
        return Err("Managed Worktree removal preview is stale; preview again".to_string());
    }
    if !preview.execution_enabled {
        return Err(format!(
            "Managed Worktree removal is blocked: {:?}",
            preview.blockers
        ));
    }
    turns.require_working_copy_idle(&preview.working_copy_id)?;
    let raw = read_managed_worktree(store, &preview.working_copy_id)?;
    reserve_removal(store, &preview)?;
    let output = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(&raw.project_path)
        .args(["worktree", "remove", "--"])
        .arg(&raw.working_copy_path)
        .env("LC_ALL", "C")
        .output();
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            set_removal_state(
                store,
                &preview.working_copy_id,
                ManagedWorktreeRemovalState::Failed,
                Some("git_remove_start_failed"),
            )?;
            return Err(format!("Cannot start managed Worktree removal: {error}"));
        }
    };
    let destination_missing = fs::symlink_metadata(&raw.working_copy_path)
        .is_err_and(|error| error.kind() == ErrorKind::NotFound);
    let retained_branch = branch_exists(&raw.project_path, &raw.branch_name);
    if !(output.status.success() || destination_missing && retained_branch == Ok(true)) {
        set_removal_state(
            store,
            &preview.working_copy_id,
            ManagedWorktreeRemovalState::Failed,
            Some("git_remove_failed"),
        )?;
        return Err(format!(
            "Git could not remove managed Worktree: {}",
            bounded_stderr(&output.stderr)
        ));
    }
    if !destination_missing {
        set_removal_state(
            store,
            &preview.working_copy_id,
            ManagedWorktreeRemovalState::Failed,
            Some("destination_remains_after_remove"),
        )?;
        return Err("Managed Worktree destination remains after Git removal".to_string());
    }
    match retained_branch {
        Ok(true) => {}
        Ok(false) => {
            set_removal_state(
                store,
                &preview.working_copy_id,
                ManagedWorktreeRemovalState::Failed,
                Some("retained_branch_missing"),
            )?;
            return Err("Managed Worktree branch is missing after directory removal".to_string());
        }
        Err(error) => {
            set_removal_state(
                store,
                &preview.working_copy_id,
                ManagedWorktreeRemovalState::Failed,
                Some("retained_branch_unavailable"),
            )?;
            return Err(error);
        }
    }
    let removed_at = set_removal_state(
        store,
        &preview.working_copy_id,
        ManagedWorktreeRemovalState::Removed,
        None,
    )?;
    Ok(ManagedWorktreeRemovalResult {
        working_copy_id: preview.working_copy_id,
        working_copy_path: preview.working_copy_path,
        branch_name: preview.branch_name,
        retained_branch: true,
        lifecycle_state: ManagedWorktreeRemovalState::Removed,
        removed_at,
    })
}

pub fn reconcile_managed_worktree_removals_on_startup(
    store: &HostStore,
) -> Result<ManagedWorktreeRemovalReconciliation, String> {
    if store.status()?.mode == HostStorageMode::Recovery {
        return Ok(ManagedWorktreeRemovalReconciliation::default());
    }
    let pending = store.with_ready_database(|database| {
        let mut statement = database.connection.prepare(
            "SELECT r.working_copy_id, r.expected_path, r.expected_branch_name, p.canonical_path
             FROM managed_worktree_removals r
             JOIN working_copies w ON w.working_copy_id = r.working_copy_id
              AND w.project_id = r.project_id
             JOIN projects p ON p.project_id = r.project_id
             WHERE r.lifecycle_state = 'removing'
             ORDER BY r.created_at ASC, r.working_copy_id ASC",
        ).map_err(|error| format!("Cannot prepare Worktree removal reconciliation: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| format!("Cannot read Worktree removal reconciliation: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot decode Worktree removal reconciliation: {error}"))
    })?;
    let mut decisions = Vec::with_capacity(pending.len());
    for (working_copy_id, expected_path, branch_name, project_path) in pending {
        let destination_missing = fs::symlink_metadata(&expected_path)
            .is_err_and(|error| error.kind() == ErrorKind::NotFound);
        let retained_branch = branch_exists(Path::new(&project_path), &branch_name);
        let (state, error_code) = if destination_missing && retained_branch == Ok(true) {
            (ManagedWorktreeRemovalState::Removed, None)
        } else {
            let code = if destination_missing && retained_branch == Ok(false) {
                "retained_branch_missing"
            } else if retained_branch.is_err() {
                "removal_reconciliation_git_unavailable"
            } else {
                "removal_interrupted_before_completion"
            };
            (ManagedWorktreeRemovalState::Failed, Some(code))
        };
        decisions.push((working_copy_id, state, error_code));
    }
    store.with_ready_database(|database| {
        let transaction = database
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin Worktree removal reconciliation: {error}"))?;
        let timestamp = now_millis();
        let mut report = ManagedWorktreeRemovalReconciliation {
            inspected: decisions.len() as u64,
            ..ManagedWorktreeRemovalReconciliation::default()
        };
        for (working_copy_id, state, error_code) in decisions {
            let changed = transaction
                .execute(
                    "UPDATE managed_worktree_removals SET lifecycle_state = ?2, error_code = ?3,
                 updated_at = ?4, removed_at = CASE WHEN ?2 = 'removed' THEN ?4 ELSE NULL END
                 WHERE working_copy_id = ?1 AND lifecycle_state = 'removing'",
                    params![working_copy_id, state.token_value(), error_code, timestamp],
                )
                .map_err(|error| format!("Cannot reconcile managed Worktree removal: {error}"))?;
            if changed != 1 {
                return Err("Managed Worktree removal changed during reconciliation".to_string());
            }
            match state {
                ManagedWorktreeRemovalState::Removed => report.recovered_removed += 1,
                ManagedWorktreeRemovalState::Failed => report.marked_failed += 1,
                ManagedWorktreeRemovalState::Removing => unreachable!(),
            }
        }
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Worktree removal reconciliation: {error}"))?;
        Ok(report)
    })
}

#[tauri::command]
pub fn managed_worktree_removal_preview(
    app: AppHandle,
    store: State<'_, HostStore>,
    input: ManagedWorktreeRemovalPreviewInput,
) -> Result<ManagedWorktreeRemovalPreview, String> {
    let managed_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Farfold application data root: {error}"))?;
    preview_for_root(&store, &managed_root, &input)
}

#[tauri::command]
pub fn managed_worktree_remove(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    input: ManagedWorktreeRemoveInput,
) -> Result<ManagedWorktreeRemovalResult, String> {
    controller.exclusive(|| {
        let managed_root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Cannot resolve Farfold application data root: {error}"))?;
        remove_for_root(&store, &turns, &managed_root, input)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        ManagedWorktreeRemovalBlocker, ManagedWorktreeRemovalPreviewInput,
        ManagedWorktreeRemovalState, ManagedWorktreeRemoveInput, preview_for_root,
        reconcile_managed_worktree_removals_on_startup, remove_for_root, reserve_removal,
    };
    use crate::{
        host_store::{HostStore, working_copy_manager::registration_preview},
        turn_coordinator::TurnCoordinator,
    };
    use rusqlite::params;
    use std::{fs, path::PathBuf, process::Command};

    struct ManagedFixture {
        container: PathBuf,
        app_data: PathBuf,
        source: PathBuf,
        destination: PathBuf,
        branch_name: String,
        working_copy_id: crate::host_ids::WorkingCopyId,
        store: HostStore,
    }

    fn git_ok(command: &mut Command) {
        assert!(command.status().unwrap().success());
    }

    fn fixture(name: &str) -> ManagedFixture {
        let container = std::env::temp_dir().join(format!(
            "farfold-managed-removal-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&container);
        let app_data = container.join("app-data");
        let source = container.join("source");
        fs::create_dir_all(&app_data).unwrap();
        fs::create_dir_all(&source).unwrap();
        git_ok(Command::new("git").arg("init").arg(&source));
        git_ok(
            Command::new("git")
                .args([
                    "-c",
                    "user.name=Farfold",
                    "-c",
                    "user.email=farfold@example.invalid",
                ])
                .arg("-C")
                .arg(&source)
                .args(["commit", "--allow-empty", "-m", "initial"]),
        );
        let source = source.canonicalize().unwrap();
        let source_registration = registration_preview(&source).unwrap();
        let branch_name = format!("farfold/remove-{name}");
        let destination = app_data
            .join("managed-worktrees")
            .join(source_registration.project_id.as_str())
            .join(format!("remove-{name}"));
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        let source_head = Command::new("git")
            .arg("-C")
            .arg(&source)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let source_head = String::from_utf8(source_head.stdout)
            .unwrap()
            .trim()
            .to_string();
        git_ok(
            Command::new("git")
                .arg("-C")
                .arg(&source)
                .args(["worktree", "add", "--no-track", "-b"])
                .arg(&branch_name)
                .arg(&destination)
                .arg(&source_head),
        );
        let destination = destination.canonicalize().unwrap();
        let destination_registration = registration_preview(&destination).unwrap();
        let store = HostStore::open(container.join("host.sqlite3"));
        store
            .with_ready_database(|database| {
                database
                    .connection
                    .execute(
                        "INSERT INTO projects(
                            project_id, canonical_path, display_name, created_at, updated_at
                         ) VALUES (?1, ?2, ?3, 1, 1)",
                        params![
                            source_registration.project_id.as_str(),
                            source_registration.project_path,
                            source_registration.project_name
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                database
                    .connection
                    .execute(
                        "INSERT INTO working_copies(
                            working_copy_id, project_id, canonical_path, kind, branch_name,
                            created_at, updated_at
                         ) VALUES (?1, ?2, ?3, 'root', ?4, 1, 1)",
                        params![
                            source_registration.working_copy_id.as_str(),
                            source_registration.project_id.as_str(),
                            source_registration.working_copy_path,
                            source_registration.branch_name
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                database
                    .connection
                    .execute(
                        "INSERT INTO working_copies(
                            working_copy_id, project_id, canonical_path, kind, branch_name,
                            created_at, updated_at
                         ) VALUES (?1, ?2, ?3, 'worktree', ?4, 1, 1)",
                        params![
                            destination_registration.working_copy_id.as_str(),
                            destination_registration.project_id.as_str(),
                            destination_registration.working_copy_path,
                            branch_name
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                database
                    .connection
                    .execute(
                        "INSERT INTO managed_worktrees(
                            working_copy_id, project_id, source_working_copy_id,
                            source_head_oid, branch_name, local_changes_choice,
                            lifecycle_state, error_code, created_at, updated_at
                         ) VALUES (?1, ?2, ?3, ?4, ?5, 'clean', 'ready', NULL, 1, 1)",
                        params![
                            destination_registration.working_copy_id.as_str(),
                            destination_registration.project_id.as_str(),
                            source_registration.working_copy_id.as_str(),
                            source_head,
                            branch_name
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        ManagedFixture {
            container,
            app_data,
            source,
            destination,
            branch_name,
            working_copy_id: destination_registration.working_copy_id,
            store,
        }
    }

    fn clean_fixture(fixture: ManagedFixture) {
        if fixture.destination.exists() {
            let _ = Command::new("git")
                .arg("-C")
                .arg(&fixture.source)
                .args(["worktree", "remove", "--force"])
                .arg(&fixture.destination)
                .status();
        }
        let _ = Command::new("git")
            .arg("-C")
            .arg(&fixture.source)
            .args(["branch", "-D", &fixture.branch_name])
            .status();
        drop(fixture.store);
        let _ = fs::remove_dir_all(fixture.container);
    }

    fn preview(fixture: &ManagedFixture) -> super::ManagedWorktreeRemovalPreview {
        preview_for_root(
            &fixture.store,
            &fixture.app_data,
            &ManagedWorktreeRemovalPreviewInput {
                working_copy_id: fixture.working_copy_id.clone(),
            },
        )
        .unwrap()
    }

    fn bind_session(fixture: &ManagedFixture) {
        fixture
            .store
            .with_ready_database(|database| {
                let project_id = database
                    .connection
                    .query_row(
                        "SELECT project_id FROM working_copies WHERE working_copy_id = ?1",
                        [fixture.working_copy_id.as_str()],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|error| error.to_string())?;
                database
                    .connection
                    .execute(
                        "INSERT INTO runtime_products VALUES ('pi', 'Pi', 1, 1)",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                database
                    .connection
                    .execute(
                        "INSERT INTO runtime_installations
                         VALUES ('managed-pi', 'pi', 'managed', 1, 1)",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                database
                    .connection
                    .execute(
                        "INSERT INTO runtime_builds
                         VALUES (
                            'pi-build', 'managed-pi', 'pi', 'pi-rpc-jsonl', '0.84.3',
                            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                            1, 1
                         )",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                database
                    .connection
                    .execute(
                        "INSERT INTO runtime_connections
                         VALUES ('pi-local', 'managed-pi', 'pi', 'Pi native', 'managed_local', 1, 1)",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                database
                    .connection
                    .execute(
                        "INSERT INTO sessions(
                            farfold_session_id, runtime_product_id, installation_id,
                            runtime_build_id, adapter_id, connection_id, project_id,
                            working_copy_id, native_session_id, title, title_source,
                            pinned, archived_at, created_at, updated_at, last_opened_at
                         ) VALUES (
                            'bound-session', 'pi', 'managed-pi', 'pi-build', 'pi-rpc-jsonl',
                            'pi-local', ?1, ?2, 'native-session', 'Bound Session', 'manual',
                            0, NULL, 1, 1, 1
                         )",
                        params![project_id, fixture.working_copy_id.as_str()],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn clean_unbound_worktree_removal_retains_branch_and_tombstone() {
        let fixture = fixture("clean");
        let preview = preview(&fixture);
        assert!(preview.execution_enabled);
        assert!(preview.blockers.is_empty());
        assert!(preview.effects.retains_branch);
        let result = remove_for_root(
            &fixture.store,
            &TurnCoordinator::default(),
            &fixture.app_data,
            ManagedWorktreeRemoveInput {
                working_copy_id: fixture.working_copy_id.clone(),
                confirm_working_copy_id: fixture.working_copy_id.clone(),
                expected_confirmation_token: preview.confirmation_token,
            },
        )
        .unwrap();
        assert_eq!(result.lifecycle_state, ManagedWorktreeRemovalState::Removed);
        assert!(result.retained_branch);
        assert!(!fixture.destination.exists());
        assert!(super::branch_exists(&fixture.source, &fixture.branch_name).unwrap());
        fixture
            .store
            .with_ready_database(|database| {
                let row = database
                    .connection
                    .query_row(
                        "SELECT lifecycle_state, error_code, removed_at IS NOT NULL
                         FROM managed_worktree_removals WHERE working_copy_id = ?1",
                        [fixture.working_copy_id.as_str()],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, Option<String>>(1)?,
                                row.get::<_, bool>(2)?,
                            ))
                        },
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(row, ("removed".to_string(), None, true));
                Ok(())
            })
            .unwrap();
        clean_fixture(fixture);
    }

    #[test]
    fn dirty_worktree_is_blocked_without_filesystem_mutation() {
        let fixture = fixture("dirty");
        fs::write(fixture.destination.join("untracked.txt"), b"preserve me").unwrap();
        let preview = preview(&fixture);
        assert!(!preview.execution_enabled);
        assert!(
            preview
                .blockers
                .contains(&ManagedWorktreeRemovalBlocker::ChangesPresent)
        );
        assert!(fixture.destination.join("untracked.txt").exists());
        clean_fixture(fixture);
    }

    #[test]
    fn any_bound_session_blocks_worktree_removal() {
        let fixture = fixture("bound");
        bind_session(&fixture);
        let preview = preview(&fixture);
        assert!(!preview.execution_enabled);
        assert_eq!(preview.bound_session_count, 1);
        assert!(
            preview
                .blockers
                .contains(&ManagedWorktreeRemovalBlocker::BoundSessions)
        );
        assert!(fixture.destination.exists());
        clean_fixture(fixture);
    }

    #[test]
    fn changed_head_rejects_a_stale_removal_preview() {
        let fixture = fixture("stale");
        let preview = preview(&fixture);
        fs::write(fixture.destination.join("committed.txt"), b"new head").unwrap();
        git_ok(
            Command::new("git")
                .args([
                    "-c",
                    "user.name=Farfold",
                    "-c",
                    "user.email=farfold@example.invalid",
                ])
                .arg("-C")
                .arg(&fixture.destination)
                .args(["add", "committed.txt"]),
        );
        git_ok(
            Command::new("git")
                .args([
                    "-c",
                    "user.name=Farfold",
                    "-c",
                    "user.email=farfold@example.invalid",
                ])
                .arg("-C")
                .arg(&fixture.destination)
                .args(["commit", "-m", "advance"]),
        );
        let error = remove_for_root(
            &fixture.store,
            &TurnCoordinator::default(),
            &fixture.app_data,
            ManagedWorktreeRemoveInput {
                working_copy_id: fixture.working_copy_id.clone(),
                confirm_working_copy_id: fixture.working_copy_id.clone(),
                expected_confirmation_token: preview.confirmation_token,
            },
        )
        .unwrap_err();
        assert!(error.contains("preview is stale"));
        assert!(fixture.destination.exists());
        clean_fixture(fixture);
    }

    #[test]
    fn startup_reconciliation_finishes_only_an_already_removed_directory() {
        let fixture = fixture("reconcile-removed");
        let preview = preview(&fixture);
        reserve_removal(&fixture.store, &preview).unwrap();
        git_ok(
            Command::new("git")
                .arg("-C")
                .arg(&fixture.source)
                .args(["worktree", "remove", "--"])
                .arg(&fixture.destination),
        );
        let report = reconcile_managed_worktree_removals_on_startup(&fixture.store).unwrap();
        assert_eq!(report.inspected, 1);
        assert_eq!(report.recovered_removed, 1);
        assert_eq!(report.marked_failed, 0);
        assert!(super::branch_exists(&fixture.source, &fixture.branch_name).unwrap());
        clean_fixture(fixture);
    }

    #[test]
    fn startup_reconciliation_never_resumes_a_destructive_removal() {
        let fixture = fixture("reconcile-present");
        let preview = preview(&fixture);
        reserve_removal(&fixture.store, &preview).unwrap();
        let report = reconcile_managed_worktree_removals_on_startup(&fixture.store).unwrap();
        assert_eq!(report.inspected, 1);
        assert_eq!(report.recovered_removed, 0);
        assert_eq!(report.marked_failed, 1);
        assert!(fixture.destination.exists());
        fixture
            .store
            .with_ready_database(|database| {
                let row = database
                    .connection
                    .query_row(
                        "SELECT lifecycle_state, error_code
                         FROM managed_worktree_removals WHERE working_copy_id = ?1",
                        [fixture.working_copy_id.as_str()],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(
                    row,
                    (
                        "failed".to_string(),
                        "removal_interrupted_before_completion".to_string()
                    )
                );
                Ok(())
            })
            .unwrap();
        clean_fixture(fixture);
    }
}
