use super::{HostStorageMode, HostStore, now_millis};
use crate::host_ids::{FarfoldSessionId, HostTurnId, RuntimeProductId, WorkingCopyId};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
};
use tauri::State;

const MAX_CHANGE_PATHS: usize = 500;
const MAX_GIT_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct TurnChangeCaptureInput {
    pub(crate) turn_id: HostTurnId,
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) working_copy_id: WorkingCopyId,
    pub(crate) runtime_product_id: RuntimeProductId,
    pub(crate) started_at: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnChangeProvenanceState {
    Capturing,
    Available,
    ProjectLevelOnly,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangePath {
    relative_path: String,
    previous_path: Option<String>,
    change_kind: TurnChangeKind,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangeReview {
    turn_id: HostTurnId,
    farfold_session_id: FarfoldSessionId,
    working_copy_id: WorkingCopyId,
    runtime_product_id: RuntimeProductId,
    provenance_state: TurnChangeProvenanceState,
    baseline_head_oid: Option<String>,
    terminal_head_oid: Option<String>,
    baseline_clean: bool,
    managed_worktree: bool,
    change_path_count: u64,
    terminal_reason: Option<String>,
    started_at: i64,
    completed_at: Option<i64>,
    reviewed_at: Option<i64>,
    changes: Vec<TurnChangePath>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnChangeReviewSnapshotInput {
    farfold_session_id: FarfoldSessionId,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnChangeReviewMarkInput {
    farfold_session_id: FarfoldSessionId,
    turn_id: HostTurnId,
}

#[derive(Debug, Clone)]
struct WorkingCopyAuthority {
    path: PathBuf,
    branch_name: Option<String>,
    managed_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitSnapshot {
    head_oid: String,
    branch_name: String,
    clean: bool,
}

impl TurnChangeProvenanceState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Capturing => "capturing",
            Self::Available => "available",
            Self::ProjectLevelOnly => "project_level_only",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "capturing" => Ok(Self::Capturing),
            "available" => Ok(Self::Available),
            "project_level_only" => Ok(Self::ProjectLevelOnly),
            "failed" => Ok(Self::Failed),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(format!("Unknown Turn Changes provenance state: {value}")),
        }
    }
}

impl TurnChangeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
            Self::Copied => "copied",
            Self::Untracked => "untracked",
            Self::Conflicted => "conflicted",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "added" => Ok(Self::Added),
            "modified" => Ok(Self::Modified),
            "deleted" => Ok(Self::Deleted),
            "renamed" => Ok(Self::Renamed),
            "copied" => Ok(Self::Copied),
            "untracked" => Ok(Self::Untracked),
            "conflicted" => Ok(Self::Conflicted),
            _ => Err(format!("Unknown Turn change kind: {value}")),
        }
    }
}

fn read_working_copy_authority(
    store: &HostStore,
    working_copy_id: &WorkingCopyId,
) -> Result<WorkingCopyAuthority, String> {
    store.with_ready_database(|database| {
        database
            .connection
            .query_row(
                "SELECT w.canonical_path, w.branch_name,
                        CASE WHEN w.kind = 'worktree'
                                  AND m.lifecycle_state = 'ready'
                                  AND r.working_copy_id IS NULL
                             THEN 1 ELSE 0 END
                 FROM working_copies w
                 LEFT JOIN managed_worktrees m ON m.working_copy_id = w.working_copy_id
                 LEFT JOIN managed_worktree_removals r ON r.working_copy_id = w.working_copy_id
                 WHERE w.working_copy_id = ?1",
                [working_copy_id.as_str()],
                |row| {
                    Ok(WorkingCopyAuthority {
                        path: PathBuf::from(row.get::<_, String>(0)?),
                        branch_name: row.get(1)?,
                        managed_ready: row.get::<_, bool>(2)?,
                    })
                },
            )
            .map_err(|error| format!("Cannot read Turn Working Copy authority: {error}"))
    })
}

fn git_output(path: &Path, arguments: &[&str], operation: &str) -> Result<Output, String> {
    let output = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .env("LC_ALL", "C")
        .output()
        .map_err(|error| format!("Cannot {operation}: {error}"))?;
    if output.stdout.len() > MAX_GIT_OUTPUT_BYTES || output.stderr.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(format!(
            "Cannot {operation}: Git output exceeds the product limit"
        ));
    }
    if !output.status.success() {
        return Err(format!(
            "Cannot {operation}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output)
}

fn utf8_stdout(path: &Path, arguments: &[&str], operation: &str) -> Result<String, String> {
    let output = git_output(path, arguments, operation)?;
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|_| format!("Cannot {operation}: Git returned non-UTF-8 output"))
}

fn require_exact_working_copy(authority: &WorkingCopyAuthority) -> Result<(), String> {
    let metadata = fs::symlink_metadata(&authority.path)
        .map_err(|error| format!("Turn Working Copy is unavailable: {error}"))?;
    if !metadata.is_dir() {
        return Err("Turn Working Copy is not a directory".to_string());
    }
    let canonical = authority
        .path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Turn Working Copy identity: {error}"))?;
    if canonical != authority.path {
        return Err("Turn Working Copy filesystem identity changed".to_string());
    }
    let top_level = PathBuf::from(utf8_stdout(
        &authority.path,
        &["rev-parse", "--show-toplevel"],
        "resolve Turn Git root",
    )?);
    let canonical_top = top_level
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Turn Git root identity: {error}"))?;
    if canonical_top != authority.path {
        return Err("Turn Working Copy is not the exact Git root".to_string());
    }
    Ok(())
}

fn git_snapshot(authority: &WorkingCopyAuthority) -> Result<GitSnapshot, String> {
    require_exact_working_copy(authority)?;
    let head_oid = utf8_stdout(
        &authority.path,
        &["rev-parse", "--verify", "HEAD"],
        "resolve Turn baseline HEAD",
    )?
    .to_ascii_lowercase();
    if !(40..=64).contains(&head_oid.len())
        || !head_oid.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Git returned an invalid Turn HEAD object ID".to_string());
    }
    let branch_name = utf8_stdout(
        &authority.path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        "resolve Turn Working Copy branch",
    )?;
    if authority.branch_name.as_deref() != Some(branch_name.as_str()) {
        return Err("Turn Working Copy branch no longer matches Host authority".to_string());
    }
    let status = git_output(
        &authority.path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignore-submodules=none",
        ],
        "observe Turn Working Copy status",
    )?;
    Ok(GitSnapshot {
        head_oid,
        branch_name,
        clean: status.stdout.is_empty(),
    })
}

fn safe_relative_path(bytes: &[u8]) -> Result<String, String> {
    let value = std::str::from_utf8(bytes)
        .map_err(|_| "Turn change path is not valid UTF-8".to_string())?;
    if value.is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_control)
        || Path::new(value).is_absolute()
        || Path::new(value)
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
    {
        return Err("Turn change path is not safe to present".to_string());
    }
    Ok(value.to_string())
}

fn parse_name_status(output: &[u8]) -> Result<Vec<TurnChangePath>, String> {
    if !output.is_empty() && !output.ends_with(&[0]) {
        return Err("Git returned an incomplete Turn change record".to_string());
    }
    let mut fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut changes = Vec::new();
    while let Some(status) = fields.next() {
        let code = *status
            .first()
            .ok_or_else(|| "Git returned an empty Turn change status".to_string())?;
        let first = safe_relative_path(
            fields
                .next()
                .ok_or_else(|| "Git omitted a Turn change path".to_string())?,
        )?;
        let (relative_path, previous_path, change_kind) = match code {
            b'A' => (first, None, TurnChangeKind::Added),
            b'M' | b'T' => (first, None, TurnChangeKind::Modified),
            b'D' => (first, None, TurnChangeKind::Deleted),
            b'U' => (first, None, TurnChangeKind::Conflicted),
            b'R' | b'C' => {
                let second = safe_relative_path(
                    fields
                        .next()
                        .ok_or_else(|| "Git omitted a renamed Turn change path".to_string())?,
                )?;
                (
                    second,
                    Some(first),
                    if code == b'R' {
                        TurnChangeKind::Renamed
                    } else {
                        TurnChangeKind::Copied
                    },
                )
            }
            _ => {
                return Err(format!(
                    "Git returned unsupported Turn change status {code}"
                ));
            }
        };
        changes.push(TurnChangePath {
            relative_path,
            previous_path,
            change_kind,
        });
        if changes.len() > MAX_CHANGE_PATHS {
            return Err("Turn change set exceeds the product path limit".to_string());
        }
    }
    Ok(changes)
}

fn merge_untracked_and_conflicts(
    changes: Vec<TurnChangePath>,
    status: &[u8],
) -> Result<Vec<TurnChangePath>, String> {
    if !status.is_empty() && !status.ends_with(&[0]) {
        return Err("Git returned an incomplete Turn status record".to_string());
    }
    let mut merged = changes
        .into_iter()
        .map(|change| (change.relative_path.clone(), change))
        .collect::<BTreeMap<_, _>>();
    let mut records = status
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if record.len() < 4 || record[2] != b' ' {
            return Err("Git returned an invalid Turn status record".to_string());
        }
        let x = record[0];
        let y = record[1];
        let path = safe_relative_path(&record[3..])?;
        let conflicted = matches!(
            (x, y),
            (b'D', b'D')
                | (b'A', b'U')
                | (b'U', b'D')
                | (b'U', b'A')
                | (b'D', b'U')
                | (b'A', b'A')
                | (b'U', b'U')
        );
        if x == b'?' && y == b'?' {
            merged.insert(
                path.clone(),
                TurnChangePath {
                    relative_path: path,
                    previous_path: None,
                    change_kind: TurnChangeKind::Untracked,
                },
            );
        } else if conflicted {
            merged.insert(
                path.clone(),
                TurnChangePath {
                    relative_path: path,
                    previous_path: None,
                    change_kind: TurnChangeKind::Conflicted,
                },
            );
        }
        if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            records
                .next()
                .ok_or_else(|| "Git omitted a renamed Turn status path".to_string())?;
        }
        if merged.len() > MAX_CHANGE_PATHS {
            return Err("Turn change set exceeds the product path limit".to_string());
        }
    }
    Ok(merged.into_values().collect())
}

fn terminal_changes(
    authority: &WorkingCopyAuthority,
    baseline_head_oid: &str,
) -> Result<(GitSnapshot, Vec<TurnChangePath>), String> {
    let before = git_snapshot(authority)?;
    let diff = git_output(
        &authority.path,
        &[
            "diff",
            "--name-status",
            "-z",
            "--find-renames=50%",
            baseline_head_oid,
            "--",
        ],
        "observe Turn changes",
    )?;
    let status = git_output(
        &authority.path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignore-submodules=none",
        ],
        "observe Turn terminal status",
    )?;
    let after = git_snapshot(authority)?;
    if before.head_oid != after.head_oid || before.branch_name != after.branch_name {
        return Err("Turn Working Copy changed while terminal provenance was captured".to_string());
    }
    let changes = merge_untracked_and_conflicts(parse_name_status(&diff.stdout)?, &status.stdout)?;
    Ok((after, changes))
}

fn insert_begin_record(
    store: &HostStore,
    input: &TurnChangeCaptureInput,
    state: TurnChangeProvenanceState,
    baseline_head_oid: Option<&str>,
    baseline_clean: bool,
    managed_worktree: bool,
    reason: Option<&str>,
) -> Result<(), String> {
    store.with_ready_database(|database| {
        database
            .connection
            .execute(
                "INSERT INTO turn_change_reviews(
                    host_turn_id, farfold_session_id, working_copy_id, runtime_product_id,
                    provenance_state, baseline_head_oid, terminal_head_oid, baseline_clean,
                    managed_worktree, change_path_count, terminal_reason, started_at,
                    completed_at, reviewed_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, 0, ?9, ?10, NULL, NULL, ?10)",
                params![
                    input.turn_id.as_str(),
                    input.farfold_session_id.as_str(),
                    input.working_copy_id.as_str(),
                    input.runtime_product_id.as_str(),
                    state.as_str(),
                    baseline_head_oid,
                    baseline_clean,
                    managed_worktree,
                    reason,
                    input.started_at,
                ],
            )
            .map_err(|error| format!("Cannot record Turn Changes baseline: {error}"))?;
        Ok(())
    })
}

pub(crate) fn begin_capture(
    store: &HostStore,
    input: &TurnChangeCaptureInput,
) -> Result<(), String> {
    let authority = read_working_copy_authority(store, &input.working_copy_id)?;
    if !authority.managed_ready {
        return insert_begin_record(
            store,
            input,
            TurnChangeProvenanceState::ProjectLevelOnly,
            None,
            false,
            false,
            Some("working_copy_not_managed"),
        );
    }
    match git_snapshot(&authority) {
        Ok(snapshot) if snapshot.clean => insert_begin_record(
            store,
            input,
            TurnChangeProvenanceState::Capturing,
            Some(&snapshot.head_oid),
            true,
            true,
            None,
        ),
        Ok(snapshot) => insert_begin_record(
            store,
            input,
            TurnChangeProvenanceState::ProjectLevelOnly,
            Some(&snapshot.head_oid),
            false,
            true,
            Some("working_copy_not_clean_at_turn_start"),
        ),
        Err(_) => insert_begin_record(
            store,
            input,
            TurnChangeProvenanceState::ProjectLevelOnly,
            None,
            false,
            true,
            Some("baseline_capture_unavailable"),
        ),
    }
}

pub(crate) fn cancel_capture(store: &HostStore, turn_id: &HostTurnId) -> Result<(), String> {
    store.with_ready_database(|database| {
        database
            .connection
            .execute(
                "DELETE FROM turn_change_reviews
                 WHERE host_turn_id = ?1 AND completed_at IS NULL",
                [turn_id.as_str()],
            )
            .map_err(|error| format!("Cannot cancel Turn Changes capture: {error}"))?;
        Ok(())
    })
}

pub(crate) fn finish_capture(
    store: &HostStore,
    turn_id: &HostTurnId,
    terminal_reason: &str,
) -> Result<(), String> {
    let record = store.with_ready_database(|database| {
        database
            .connection
            .query_row(
                "SELECT working_copy_id, provenance_state, baseline_head_oid
                 FROM turn_change_reviews WHERE host_turn_id = ?1",
                [turn_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot read Turn Changes capture: {error}"))
    })?;
    let Some((working_copy_id, state, baseline_head_oid)) = record else {
        return Ok(());
    };
    let state = TurnChangeProvenanceState::parse(&state)?;
    let completed_at = now_millis();
    if state != TurnChangeProvenanceState::Capturing {
        return store.with_ready_database(|database| {
            database
                .connection
                .execute(
                    "UPDATE turn_change_reviews
                     SET terminal_reason = COALESCE(terminal_reason, ?2), completed_at = ?3,
                         updated_at = ?3
                     WHERE host_turn_id = ?1 AND completed_at IS NULL",
                    params![turn_id.as_str(), terminal_reason, completed_at],
                )
                .map_err(|error| format!("Cannot finish project-level Turn Changes: {error}"))?;
            Ok(())
        });
    }
    let working_copy_id =
        WorkingCopyId::parse(working_copy_id).map_err(|error| error.to_string())?;
    let baseline_head_oid = baseline_head_oid
        .ok_or_else(|| "Capturing Turn Changes has no baseline HEAD".to_string())?;
    let capture = read_working_copy_authority(store, &working_copy_id).and_then(|authority| {
        if !authority.managed_ready {
            return Err("Managed Working Copy is no longer ready".to_string());
        }
        terminal_changes(&authority, &baseline_head_oid)
    });
    match capture {
        Ok((terminal, changes)) => store.with_ready_database(|database| {
            let transaction = database
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| format!("Cannot begin Turn Changes completion: {error}"))?;
            for change in &changes {
                transaction
                    .execute(
                        "INSERT INTO turn_change_paths(
                            host_turn_id, relative_path, previous_path, change_kind
                         ) VALUES (?1, ?2, ?3, ?4)",
                        params![
                            turn_id.as_str(),
                            change.relative_path,
                            change.previous_path,
                            change.change_kind.as_str(),
                        ],
                    )
                    .map_err(|error| format!("Cannot record Turn change path: {error}"))?;
            }
            transaction
                .execute(
                    "UPDATE turn_change_reviews
                     SET provenance_state = 'available', terminal_head_oid = ?2,
                         change_path_count = ?3, terminal_reason = ?4,
                         completed_at = ?5, updated_at = ?5
                     WHERE host_turn_id = ?1 AND provenance_state = 'capturing'
                       AND completed_at IS NULL",
                    params![
                        turn_id.as_str(),
                        terminal.head_oid,
                        changes.len() as i64,
                        terminal_reason,
                        completed_at,
                    ],
                )
                .map_err(|error| format!("Cannot complete Turn Changes review: {error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("Cannot commit Turn Changes review: {error}"))
        }),
        Err(_) => store.with_ready_database(|database| {
            database
                .connection
                .execute(
                    "UPDATE turn_change_reviews
                     SET provenance_state = 'project_level_only',
                         terminal_reason = 'terminal_capture_unavailable', completed_at = ?2,
                         updated_at = ?2
                     WHERE host_turn_id = ?1 AND provenance_state = 'capturing'
                       AND completed_at IS NULL",
                    params![turn_id.as_str(), completed_at],
                )
                .map_err(|error| format!("Cannot downgrade Turn Changes review: {error}"))?;
            Ok(())
        }),
    }
}

pub fn reconcile_interrupted_captures(store: &HostStore) -> Result<u64, String> {
    if store.status()?.mode == HostStorageMode::Recovery {
        return Ok(0);
    }
    store.with_ready_database(|database| {
        let timestamp = now_millis();
        let changed = database
            .connection
            .execute(
                "UPDATE turn_change_reviews
                 SET provenance_state = 'interrupted',
                     terminal_reason = 'application_restarted_before_terminal_capture',
                     completed_at = ?1, updated_at = ?1
                 WHERE provenance_state = 'capturing' AND completed_at IS NULL",
                [timestamp],
            )
            .map_err(|error| format!("Cannot reconcile interrupted Turn Changes: {error}"))?;
        u64::try_from(changed).map_err(|_| "Interrupted Turn count is invalid".to_string())
    })
}

fn snapshots_for_session(
    store: &HostStore,
    farfold_session_id: &FarfoldSessionId,
) -> Result<Vec<TurnChangeReview>, String> {
    store.with_ready_database(|database| {
        let mut statement = database
            .connection
            .prepare(
                "SELECT host_turn_id, farfold_session_id, working_copy_id, runtime_product_id,
                        provenance_state, baseline_head_oid, terminal_head_oid, baseline_clean,
                        managed_worktree, change_path_count, terminal_reason, started_at,
                        completed_at, reviewed_at
                 FROM turn_change_reviews
                 WHERE farfold_session_id = ?1
                 ORDER BY started_at DESC, host_turn_id DESC
                 LIMIT 20",
            )
            .map_err(|error| format!("Cannot prepare Turn Changes snapshot: {error}"))?;
        let rows = statement
            .query_map([farfold_session_id.as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, bool>(7)?,
                    row.get::<_, bool>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                ))
            })
            .map_err(|error| format!("Cannot read Turn Changes snapshot: {error}"))?;
        let mut reviews = Vec::new();
        for row in rows {
            let raw =
                row.map_err(|error| format!("Cannot decode Turn Changes snapshot: {error}"))?;
            let mut paths = database
                .connection
                .prepare(
                    "SELECT relative_path, previous_path, change_kind
                     FROM turn_change_paths WHERE host_turn_id = ?1
                     ORDER BY relative_path ASC",
                )
                .map_err(|error| format!("Cannot prepare Turn change paths: {error}"))?;
            let path_rows = paths
                .query_map([raw.0.as_str()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| format!("Cannot read Turn change paths: {error}"))?;
            let mut changes = Vec::new();
            for path in path_rows {
                let (relative_path, previous_path, kind) =
                    path.map_err(|error| format!("Cannot decode Turn change path: {error}"))?;
                changes.push(TurnChangePath {
                    relative_path,
                    previous_path,
                    change_kind: TurnChangeKind::parse(&kind)?,
                });
            }
            reviews.push(TurnChangeReview {
                turn_id: HostTurnId::parse(raw.0).map_err(|error| error.to_string())?,
                farfold_session_id: FarfoldSessionId::parse(raw.1)
                    .map_err(|error| error.to_string())?,
                working_copy_id: WorkingCopyId::parse(raw.2).map_err(|error| error.to_string())?,
                runtime_product_id: RuntimeProductId::parse(raw.3)
                    .map_err(|error| error.to_string())?,
                provenance_state: TurnChangeProvenanceState::parse(&raw.4)?,
                baseline_head_oid: raw.5,
                terminal_head_oid: raw.6,
                baseline_clean: raw.7,
                managed_worktree: raw.8,
                change_path_count: u64::try_from(raw.9)
                    .map_err(|_| "Turn change path count is invalid".to_string())?,
                terminal_reason: raw.10,
                started_at: raw.11,
                completed_at: raw.12,
                reviewed_at: raw.13,
                changes,
            });
        }
        Ok(reviews)
    })
}

#[tauri::command]
pub fn turn_change_review_snapshot(
    store: State<'_, HostStore>,
    input: TurnChangeReviewSnapshotInput,
) -> Result<Vec<TurnChangeReview>, String> {
    snapshots_for_session(&store, &input.farfold_session_id)
}

#[tauri::command]
pub fn turn_change_review_mark(
    store: State<'_, HostStore>,
    input: TurnChangeReviewMarkInput,
) -> Result<bool, String> {
    store.with_ready_database(|database| {
        let timestamp = now_millis();
        let changed = database
            .connection
            .execute(
                "UPDATE turn_change_reviews SET reviewed_at = COALESCE(reviewed_at, ?3),
                                                updated_at = MAX(updated_at, ?3)
                 WHERE host_turn_id = ?1 AND farfold_session_id = ?2
                   AND completed_at IS NOT NULL",
                params![
                    input.turn_id.as_str(),
                    input.farfold_session_id.as_str(),
                    timestamp,
                ],
            )
            .map_err(|error| format!("Cannot mark Turn Changes reviewed: {error}"))?;
        Ok(changed == 1)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        TurnChangeCaptureInput, TurnChangeKind, TurnChangeProvenanceState, begin_capture,
        finish_capture, reconcile_interrupted_captures, snapshots_for_session,
    };
    use crate::{
        host_ids::{FarfoldSessionId, HostTurnId, RuntimeProductId, WorkingCopyId},
        host_store::HostStore,
    };
    use rusqlite::params;
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        container: PathBuf,
        root: PathBuf,
        store: HostStore,
        session_id: FarfoldSessionId,
        working_copy_id: WorkingCopyId,
    }

    impl Fixture {
        fn new(managed: bool) -> Self {
            let container = std::env::temp_dir().join(format!(
                "farfold-turn-changes-{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            let root = container.join("worktree");
            fs::create_dir_all(&root).unwrap();
            for args in [
                vec!["init"],
                vec!["config", "user.name", "Farfold Test"],
                vec!["config", "user.email", "farfold@example.invalid"],
            ] {
                assert!(
                    Command::new("git")
                        .arg("-C")
                        .arg(&root)
                        .args(args)
                        .status()
                        .unwrap()
                        .success()
                );
            }
            fs::write(root.join("tracked.txt"), "before\n").unwrap();
            assert!(
                Command::new("git")
                    .arg("-C")
                    .arg(&root)
                    .args(["add", "tracked.txt"])
                    .status()
                    .unwrap()
                    .success()
            );
            assert!(
                Command::new("git")
                    .arg("-C")
                    .arg(&root)
                    .args(["commit", "-m", "initial"])
                    .status()
                    .unwrap()
                    .success()
            );
            let canonical = root.canonicalize().unwrap();
            let branch = String::from_utf8(
                Command::new("git")
                    .arg("-C")
                    .arg(&canonical)
                    .args(["branch", "--show-current"])
                    .output()
                    .unwrap()
                    .stdout,
            )
            .unwrap()
            .trim()
            .to_string();
            let head = String::from_utf8(
                Command::new("git")
                    .arg("-C")
                    .arg(&canonical)
                    .args(["rev-parse", "HEAD"])
                    .output()
                    .unwrap()
                    .stdout,
            )
            .unwrap()
            .trim()
            .to_string();
            let store = HostStore::open(container.join("farfold.sqlite3"));
            let session_id = FarfoldSessionId::parse("session-turn-changes").unwrap();
            let working_copy_id = WorkingCopyId::parse("copy-turn-changes").unwrap();
            store.with_ready_database(|database| {
                let now = crate::host_store::now_millis();
                database.connection.execute("INSERT INTO runtime_products VALUES ('pi', 'Pi', ?1, ?1)", [now]).unwrap();
                database.connection.execute("INSERT INTO runtime_installations VALUES ('managed-pi', 'pi', 'managed', ?1, ?1)", [now]).unwrap();
                database.connection.execute("INSERT INTO runtime_builds VALUES ('pi-build', 'managed-pi', 'pi', 'pi-adapter', '1', ?1, ?2, ?2)", params!["a".repeat(64), now]).unwrap();
                database.connection.execute("INSERT INTO runtime_connections VALUES ('pi-local', 'managed-pi', 'pi', 'Pi', 'managed_local', ?1, ?1)", [now]).unwrap();
                database.connection.execute("INSERT INTO projects VALUES ('project-turn-changes', ?1, 'Project', ?2, ?2)", params![canonical.to_string_lossy(), now]).unwrap();
                database.connection.execute("INSERT INTO working_copies VALUES (?1, 'project-turn-changes', ?2, ?3, ?4, ?5, ?5)", params![working_copy_id.as_str(), canonical.to_string_lossy(), if managed { "worktree" } else { "root" }, if managed { Some(branch.as_str()) } else { None }, now]).unwrap();
                if managed {
                    database.connection.execute("INSERT INTO managed_worktrees VALUES (?1, 'project-turn-changes', ?1, ?2, ?3, 'clean', 'ready', NULL, ?4, ?4)", params![working_copy_id.as_str(), head, branch, now]).unwrap();
                }
                database.connection.execute("INSERT INTO sessions VALUES (?1, 'pi', 'managed-pi', 'pi-build', 'pi-adapter', 'pi-local', 'project-turn-changes', ?2, 'native-turn-changes', 'Turn', 'first_user', 0, NULL, ?3, ?3, ?3)", params![session_id.as_str(), working_copy_id.as_str(), now]).unwrap();
                Ok(())
            }).unwrap();
            Self {
                container,
                root: canonical,
                store,
                session_id,
                working_copy_id,
            }
        }

        fn input(&self, turn: &str) -> TurnChangeCaptureInput {
            TurnChangeCaptureInput {
                turn_id: HostTurnId::parse(turn).unwrap(),
                farfold_session_id: self.session_id.clone(),
                working_copy_id: self.working_copy_id.clone(),
                runtime_product_id: RuntimeProductId::parse("pi").unwrap(),
                started_at: crate::host_store::now_millis(),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.container);
        }
    }

    #[test]
    fn clean_managed_worktree_produces_a_bounded_path_review() {
        let fixture = Fixture::new(true);
        let input = fixture.input("turn-review-1");
        begin_capture(&fixture.store, &input).unwrap();
        fs::write(fixture.root.join("tracked.txt"), "after\n").unwrap();
        fs::write(fixture.root.join("new.txt"), "new\n").unwrap();
        finish_capture(&fixture.store, &input.turn_id, "completed").unwrap();

        let reviews = snapshots_for_session(&fixture.store, &fixture.session_id).unwrap();
        assert_eq!(reviews.len(), 1);
        assert_eq!(
            reviews[0].provenance_state,
            TurnChangeProvenanceState::Available
        );
        assert_eq!(reviews[0].change_path_count, 2);
        assert_eq!(reviews[0].changes[0].relative_path, "new.txt");
        assert_eq!(reviews[0].changes[0].change_kind, TurnChangeKind::Untracked);
        assert_eq!(reviews[0].changes[1].relative_path, "tracked.txt");
        assert_eq!(reviews[0].changes[1].change_kind, TurnChangeKind::Modified);
    }

    #[test]
    fn root_checkout_is_never_claimed_as_per_turn_provenance() {
        let fixture = Fixture::new(false);
        let input = fixture.input("turn-review-2");
        begin_capture(&fixture.store, &input).unwrap();
        finish_capture(&fixture.store, &input.turn_id, "completed").unwrap();

        let reviews = snapshots_for_session(&fixture.store, &fixture.session_id).unwrap();
        assert_eq!(
            reviews[0].provenance_state,
            TurnChangeProvenanceState::ProjectLevelOnly
        );
        assert_eq!(
            reviews[0].terminal_reason.as_deref(),
            Some("working_copy_not_managed")
        );
        assert!(reviews[0].changes.is_empty());
    }

    #[test]
    fn cold_start_marks_unfinished_capture_interrupted_without_inventing_changes() {
        let fixture = Fixture::new(true);
        let input = fixture.input("turn-review-3");
        begin_capture(&fixture.store, &input).unwrap();
        assert_eq!(reconcile_interrupted_captures(&fixture.store).unwrap(), 1);

        let reviews = snapshots_for_session(&fixture.store, &fixture.session_id).unwrap();
        assert_eq!(
            reviews[0].provenance_state,
            TurnChangeProvenanceState::Interrupted
        );
        assert!(reviews[0].changes.is_empty());
    }
}
