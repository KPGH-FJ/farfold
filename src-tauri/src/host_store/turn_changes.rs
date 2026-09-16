use super::{HostStorageMode, HostStore, now_millis};
use crate::host_ids::{FarfoldSessionId, HostTurnId, RuntimeProductId, WorkingCopyId};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
};
use tauri::State;

const MAX_CHANGE_PATHS: usize = 500;
const MAX_GIT_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_INLINE_FILE_STATE_BYTES: u64 = 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES: u64 = 64 * 1024;
const MAX_DIFF_PREVIEW_BYTES: u64 = 128 * 1024;

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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnChangeFileState {
    Text,
    Binary,
    Large,
    Deleted,
    Missing,
    NotRegular,
    OutsideWorkingCopy,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnChangeCurrentPathState {
    MatchesRecordedPaths,
    ChangedAfterTurn,
    Unavailable,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangePath {
    relative_path: String,
    previous_path: Option<String>,
    change_kind: TurnChangeKind,
    file_state: TurnChangeFileState,
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
    current_path_state: TurnChangeCurrentPathState,
    changes: Vec<TurnChangePath>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangeFilePreview {
    turn_id: HostTurnId,
    farfold_session_id: FarfoldSessionId,
    relative_path: String,
    previous_path: Option<String>,
    change_kind: TurnChangeKind,
    file_state: TurnChangeFileState,
    source: String,
    baseline_head_oid: Option<String>,
    terminal_head_oid: Option<String>,
    current_path_state: TurnChangeCurrentPathState,
    byte_count: Option<u64>,
    max_bytes: u64,
    truncated: bool,
    text: Option<String>,
    detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnChangePathDiffPreview {
    turn_id: HostTurnId,
    farfold_session_id: FarfoldSessionId,
    relative_path: String,
    previous_path: Option<String>,
    change_kind: TurnChangeKind,
    file_state: TurnChangeFileState,
    source: String,
    baseline_head_oid: Option<String>,
    terminal_head_oid: Option<String>,
    current_path_state: TurnChangeCurrentPathState,
    max_bytes: u64,
    truncated: bool,
    text: Option<String>,
    detail: String,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnChangeFilePreviewInput {
    farfold_session_id: FarfoldSessionId,
    turn_id: HostTurnId,
    relative_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnChangePathDiffPreviewInput {
    farfold_session_id: FarfoldSessionId,
    turn_id: HostTurnId,
    relative_path: String,
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

fn read_pipe_bounded<R: Read + Send + 'static>(
    mut reader: R,
    limit: usize,
) -> thread::JoinHandle<Result<Vec<u8>, String>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| format!("Cannot read Git output: {error}"))?;
            if read == 0 {
                return Ok(bytes);
            }
            let remaining = limit.saturating_add(1).saturating_sub(bytes.len());
            if remaining == 0 {
                return Ok(bytes);
            }
            bytes.extend_from_slice(&buffer[..read.min(remaining)]);
            if bytes.len() > limit {
                return Ok(bytes);
            }
        }
    })
}

fn git_diff_output_bounded(
    path: &Path,
    arguments: &[&str],
    operation: &str,
) -> Result<Vec<u8>, String> {
    let mut child = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot {operation}: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Cannot {operation}: missing Git stdout pipe"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Cannot {operation}: missing Git stderr pipe"))?;
    let stdout_reader = read_pipe_bounded(stdout, MAX_DIFF_PREVIEW_BYTES as usize);
    let stderr_reader = read_pipe_bounded(stderr, MAX_GIT_OUTPUT_BYTES);
    let status = child
        .wait()
        .map_err(|error| format!("Cannot {operation}: {error}"))?;
    let stdout = stdout_reader
        .join()
        .map_err(|_| format!("Cannot {operation}: Git stdout reader failed"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| format!("Cannot {operation}: Git stderr reader failed"))??;
    if stderr.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(format!(
            "Cannot {operation}: Git stderr exceeds the product limit"
        ));
    }
    let stdout_truncated = stdout.len() > MAX_DIFF_PREVIEW_BYTES as usize;
    if !status.success() && !stdout_truncated {
        return Err(format!(
            "Cannot {operation}: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    Ok(stdout)
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

fn read_bounded_sample(path: &Path, max_bytes: u64) -> Result<(Vec<u8>, bool), String> {
    let file = fs::File::open(path).map_err(|error| format!("Cannot open Turn path: {error}"))?;
    let mut reader = file.take(max_bytes.saturating_add(1));
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read Turn path: {error}"))?;
    let truncated = bytes.len() as u64 > max_bytes;
    if truncated {
        bytes.truncate(max_bytes as usize);
    }
    Ok((bytes, truncated))
}

fn bounded_bytes(bytes: &[u8], max_bytes: u64) -> (Vec<u8>, bool) {
    let truncated = bytes.len() as u64 > max_bytes;
    let end = if truncated {
        max_bytes as usize
    } else {
        bytes.len()
    };
    (bytes[..end].to_vec(), truncated)
}

fn bounded_utf8_text(bytes: Vec<u8>, truncated: bool) -> Result<String, ()> {
    match String::from_utf8(bytes) {
        Ok(text) => Ok(text),
        Err(error) if truncated && error.utf8_error().error_len().is_none() => {
            let valid_up_to = error.utf8_error().valid_up_to();
            String::from_utf8(error.into_bytes()[..valid_up_to].to_vec()).map_err(|_| ())
        }
        Err(_) => Err(()),
    }
}

fn resolved_change_path(
    authority: &WorkingCopyAuthority,
    change: &TurnChangePath,
) -> Result<(PathBuf, u64), TurnChangeFileState> {
    if change.change_kind == TurnChangeKind::Deleted {
        return Err(TurnChangeFileState::Deleted);
    }
    let candidate = authority.path.join(&change.relative_path);
    let metadata = match fs::symlink_metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(TurnChangeFileState::Missing);
        }
        Err(_) => return Err(TurnChangeFileState::Unknown),
    };
    if !metadata.is_file() && !metadata.file_type().is_symlink() {
        return Err(TurnChangeFileState::NotRegular);
    }
    let resolved = match candidate.canonicalize() {
        Ok(path) => path,
        Err(_) => return Err(TurnChangeFileState::Unknown),
    };
    if !resolved.starts_with(&authority.path) {
        return Err(TurnChangeFileState::OutsideWorkingCopy);
    }
    let metadata = match fs::metadata(&resolved) {
        Ok(metadata) => metadata,
        Err(_) => return Err(TurnChangeFileState::Unknown),
    };
    if !metadata.is_file() {
        return Err(TurnChangeFileState::NotRegular);
    }
    Ok((resolved, metadata.len()))
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
            file_state: TurnChangeFileState::Unknown,
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
                    file_state: TurnChangeFileState::Unknown,
                },
            );
        } else if conflicted {
            merged.insert(
                path.clone(),
                TurnChangePath {
                    relative_path: path,
                    previous_path: None,
                    change_kind: TurnChangeKind::Conflicted,
                    file_state: TurnChangeFileState::Unknown,
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

fn classify_file_state(
    authority: Option<&WorkingCopyAuthority>,
    change: &TurnChangePath,
) -> TurnChangeFileState {
    let Some(authority) = authority else {
        return TurnChangeFileState::Unknown;
    };
    let (resolved, byte_count) = match resolved_change_path(authority, change) {
        Ok(resolved) => resolved,
        Err(state) => return state,
    };
    if byte_count > MAX_INLINE_FILE_STATE_BYTES {
        return TurnChangeFileState::Large;
    }
    match read_bounded_sample(&resolved, MAX_INLINE_FILE_STATE_BYTES) {
        Ok((_, true)) => TurnChangeFileState::Large,
        Ok((bytes, false)) if bytes.contains(&0) => TurnChangeFileState::Binary,
        Ok(_) => TurnChangeFileState::Text,
        Err(_) => TurnChangeFileState::Unknown,
    }
}

fn current_path_state(
    authority: Option<&WorkingCopyAuthority>,
    baseline_head_oid: Option<&str>,
    terminal_head_oid: Option<&str>,
    recorded: &[TurnChangePath],
    provenance_state: TurnChangeProvenanceState,
) -> TurnChangeCurrentPathState {
    if provenance_state != TurnChangeProvenanceState::Available {
        return TurnChangeCurrentPathState::NotApplicable;
    }
    let (Some(authority), Some(baseline_head_oid), Some(terminal_head_oid)) =
        (authority, baseline_head_oid, terminal_head_oid)
    else {
        return TurnChangeCurrentPathState::Unavailable;
    };
    match terminal_changes(authority, baseline_head_oid) {
        Ok((current, mut current_changes)) => {
            for change in &mut current_changes {
                change.file_state = TurnChangeFileState::Unknown;
            }
            let mut recorded_paths = recorded.to_vec();
            for change in &mut recorded_paths {
                change.file_state = TurnChangeFileState::Unknown;
            }
            if current.head_oid == terminal_head_oid && current_changes == recorded_paths {
                TurnChangeCurrentPathState::MatchesRecordedPaths
            } else {
                TurnChangeCurrentPathState::ChangedAfterTurn
            }
        }
        Err(_) => TurnChangeCurrentPathState::Unavailable,
    }
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
                "SELECT review.host_turn_id, review.farfold_session_id, review.working_copy_id,
                        review.runtime_product_id, review.provenance_state,
                        review.baseline_head_oid, review.terminal_head_oid,
                        review.baseline_clean, review.managed_worktree,
                        review.change_path_count, review.terminal_reason, review.started_at,
                        review.completed_at, review.reviewed_at, w.canonical_path, w.branch_name,
                        CASE WHEN w.kind = 'worktree'
                                  AND m.lifecycle_state = 'ready'
                                  AND r.working_copy_id IS NULL
                             THEN 1 ELSE 0 END
                 FROM turn_change_reviews review
                 JOIN working_copies w ON w.working_copy_id = review.working_copy_id
                 LEFT JOIN managed_worktrees m ON m.working_copy_id = w.working_copy_id
                 LEFT JOIN managed_worktree_removals r ON r.working_copy_id = w.working_copy_id
                 WHERE farfold_session_id = ?1
                 ORDER BY review.started_at DESC, review.host_turn_id DESC
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
                    row.get::<_, String>(14)?,
                    row.get::<_, Option<String>>(15)?,
                    row.get::<_, bool>(16)?,
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
                    file_state: TurnChangeFileState::Unknown,
                });
            }
            let authority = WorkingCopyAuthority {
                path: PathBuf::from(raw.14),
                branch_name: raw.15,
                managed_ready: raw.16,
            };
            let authority = authority
                .path
                .canonicalize()
                .ok()
                .filter(|canonical| *canonical == authority.path)
                .map(|_| authority);
            for change in &mut changes {
                change.file_state = classify_file_state(authority.as_ref(), change);
            }
            let current_path_state = current_path_state(
                authority.as_ref(),
                raw.5.as_deref(),
                raw.6.as_deref(),
                &changes,
                TurnChangeProvenanceState::parse(&raw.4)?,
            );
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
                current_path_state,
                changes,
            });
        }
        Ok(reviews)
    })
}

fn file_preview_for_turn(
    store: &HostStore,
    input: &TurnChangeFilePreviewInput,
) -> Result<TurnChangeFilePreview, String> {
    let requested_path = safe_relative_path(input.relative_path.as_bytes())?;
    let reviews = snapshots_for_session(store, &input.farfold_session_id)?;
    let review = reviews
        .into_iter()
        .find(|review| review.turn_id == input.turn_id)
        .ok_or_else(|| "Turn Changes review is not available for this Session".to_string())?;
    if review.provenance_state != TurnChangeProvenanceState::Available {
        return Err("Turn Changes review has no path-level preview".to_string());
    }
    let change = review
        .changes
        .iter()
        .find(|change| change.relative_path == requested_path)
        .cloned()
        .ok_or_else(|| "Requested path is not part of this Turn Changes review".to_string())?;
    let authority = read_working_copy_authority(store, &review.working_copy_id)?;
    let base_detail = if review.current_path_state == TurnChangeCurrentPathState::ChangedAfterTurn {
        "当前路径集合已不同于 Turn 终止快照；此预览来自当前磁盘，可能包含 Turn 后变更。"
    } else {
        "此预览来自当前磁盘；Farfold 未保存 Turn 终止时的文件正文。"
    };
    let mut preview = TurnChangeFilePreview {
        turn_id: review.turn_id,
        farfold_session_id: review.farfold_session_id,
        relative_path: change.relative_path.clone(),
        previous_path: change.previous_path.clone(),
        change_kind: change.change_kind,
        file_state: change.file_state,
        source: "current_disk".to_string(),
        baseline_head_oid: review.baseline_head_oid,
        terminal_head_oid: review.terminal_head_oid,
        current_path_state: review.current_path_state,
        byte_count: None,
        max_bytes: MAX_TEXT_PREVIEW_BYTES,
        truncated: false,
        text: None,
        detail: base_detail.to_string(),
    };

    let (resolved, byte_count) = match resolved_change_path(&authority, &change) {
        Ok(resolved) => resolved,
        Err(state) => {
            preview.file_state = state;
            preview.detail = match state {
                TurnChangeFileState::Deleted => "该路径在当前磁盘上已删除。".to_string(),
                TurnChangeFileState::Missing => "该路径在当前磁盘上不存在。".to_string(),
                TurnChangeFileState::NotRegular => "该路径不是可预览的普通文件。".to_string(),
                TurnChangeFileState::OutsideWorkingCopy => {
                    "该路径解析到 Working Copy 外部，Host 已拒绝读取。".to_string()
                }
                _ => "Host 无法安全读取该路径。".to_string(),
            };
            return Ok(preview);
        }
    };
    preview.byte_count = Some(byte_count);
    if byte_count > MAX_INLINE_FILE_STATE_BYTES {
        preview.file_state = TurnChangeFileState::Large;
        preview.detail = "该文件超过 Turn Changes 内联预览上限。".to_string();
        return Ok(preview);
    }
    let (bytes, truncated) = match read_bounded_sample(&resolved, MAX_TEXT_PREVIEW_BYTES) {
        Ok(sample) => sample,
        Err(reason) => {
            preview.file_state = TurnChangeFileState::Unknown;
            preview.detail = reason;
            return Ok(preview);
        }
    };
    preview.truncated = truncated;
    if bytes.contains(&0) {
        preview.file_state = TurnChangeFileState::Binary;
        preview.detail = "该文件看起来是二进制内容，Host 不内联显示。".to_string();
        return Ok(preview);
    }
    let text = match bounded_utf8_text(bytes, truncated) {
        Ok(text) => text,
        Err(_) => {
            preview.file_state = TurnChangeFileState::Binary;
            preview.detail = "该文件不是 UTF-8 文本，Host 不内联显示。".to_string();
            return Ok(preview);
        }
    };
    preview.file_state = TurnChangeFileState::Text;
    preview.text = Some(text);
    if truncated {
        preview.detail = format!("{base_detail} 只显示前 {} 字节。", MAX_TEXT_PREVIEW_BYTES);
    }
    Ok(preview)
}

fn diff_preview_for_turn(
    store: &HostStore,
    input: &TurnChangePathDiffPreviewInput,
) -> Result<TurnChangePathDiffPreview, String> {
    let requested_path = safe_relative_path(input.relative_path.as_bytes())?;
    let reviews = snapshots_for_session(store, &input.farfold_session_id)?;
    let review = reviews
        .into_iter()
        .find(|review| review.turn_id == input.turn_id)
        .ok_or_else(|| "Turn Changes review is not available for this Session".to_string())?;
    if review.provenance_state != TurnChangeProvenanceState::Available {
        return Err("Turn Changes review has no path-level diff".to_string());
    }
    let change = review
        .changes
        .iter()
        .find(|change| change.relative_path == requested_path)
        .cloned()
        .ok_or_else(|| "Requested path is not part of this Turn Changes review".to_string())?;
    let baseline_head_oid = review
        .baseline_head_oid
        .clone()
        .ok_or_else(|| "Turn Changes review has no baseline HEAD".to_string())?;
    let authority = read_working_copy_authority(store, &review.working_copy_id)?;
    let base_detail = if review.current_path_state == TurnChangeCurrentPathState::ChangedAfterTurn {
        "当前路径集合已不同于 Turn 终止快照；此 diff 比较记录基线与当前磁盘，可能包含 Turn 后变更。"
    } else {
        "此 diff 比较记录基线与当前磁盘；Farfold 未保存 Turn 终止时的文件正文。"
    };
    let mut preview = TurnChangePathDiffPreview {
        turn_id: review.turn_id,
        farfold_session_id: review.farfold_session_id,
        relative_path: change.relative_path.clone(),
        previous_path: change.previous_path.clone(),
        change_kind: change.change_kind,
        file_state: change.file_state,
        source: "current_disk_against_baseline".to_string(),
        baseline_head_oid: review.baseline_head_oid,
        terminal_head_oid: review.terminal_head_oid,
        current_path_state: review.current_path_state,
        max_bytes: MAX_DIFF_PREVIEW_BYTES,
        truncated: false,
        text: None,
        detail: base_detail.to_string(),
    };

    if change.change_kind == TurnChangeKind::Untracked {
        let (resolved, byte_count) = match resolved_change_path(&authority, &change) {
            Ok(resolved) => resolved,
            Err(state) => {
                preview.file_state = state;
                preview.detail = "当前磁盘上没有可生成新增 diff 的文本文件。".to_string();
                return Ok(preview);
            }
        };
        if byte_count > MAX_INLINE_FILE_STATE_BYTES {
            preview.file_state = TurnChangeFileState::Large;
            preview.detail = "未跟踪文件超过 Turn Changes diff 预览上限。".to_string();
            return Ok(preview);
        }
        let (bytes, truncated) = match read_bounded_sample(&resolved, MAX_DIFF_PREVIEW_BYTES) {
            Ok(sample) => sample,
            Err(reason) => {
                preview.file_state = TurnChangeFileState::Unknown;
                preview.detail = reason;
                return Ok(preview);
            }
        };
        if bytes.contains(&0) {
            preview.file_state = TurnChangeFileState::Binary;
            preview.detail = "未跟踪文件看起来是二进制内容，Host 不内联显示 diff。".to_string();
            return Ok(preview);
        }
        let text = match bounded_utf8_text(bytes, truncated) {
            Ok(text) => text,
            Err(_) => {
                preview.file_state = TurnChangeFileState::Binary;
                preview.detail = "未跟踪文件不是 UTF-8 文本，Host 不内联显示 diff。".to_string();
                return Ok(preview);
            }
        };
        preview.file_state = TurnChangeFileState::Text;
        preview.truncated = truncated;
        let diff_body = text
            .lines()
            .map(|line| format!("+{line}"))
            .collect::<Vec<_>>()
            .join("\n");
        preview.text = Some(format!(
            "diff --git a/{0} b/{0}\nnew file (untracked, current disk)\n--- /dev/null\n+++ b/{0}\n@@\n{1}{2}",
            change.relative_path,
            diff_body,
            if text.ends_with('\n') { "\n+" } else { "" }
        ));
        if truncated {
            preview.detail = format!("{base_detail} 只显示前 {} 字节。", MAX_DIFF_PREVIEW_BYTES);
        }
        return Ok(preview);
    }
    if matches!(
        change.file_state,
        TurnChangeFileState::Binary
            | TurnChangeFileState::Large
            | TurnChangeFileState::NotRegular
            | TurnChangeFileState::OutsideWorkingCopy
    ) {
        preview.detail = "该路径不适合内联显示 diff；请在外部工具中审阅磁盘事实。".to_string();
        return Ok(preview);
    }

    let mut arguments = vec![
        "diff".to_string(),
        "--patch".to_string(),
        "--no-ext-diff".to_string(),
        "--find-renames=50%".to_string(),
        "--unified=80".to_string(),
        baseline_head_oid,
        "--".to_string(),
    ];
    if let Some(previous_path) = &change.previous_path {
        arguments.push(previous_path.clone());
    }
    arguments.push(change.relative_path.clone());
    let refs = arguments.iter().map(String::as_str).collect::<Vec<&str>>();
    let output = git_diff_output_bounded(&authority.path, &refs, "build Turn diff preview")?;
    let (bytes, truncated) = bounded_bytes(&output, MAX_DIFF_PREVIEW_BYTES);
    let text = bounded_utf8_text(bytes, truncated)
        .map_err(|_| "Git returned non-UTF-8 diff output".to_string())?;
    preview.truncated = truncated;
    preview.text = Some(text);
    if truncated {
        preview.detail = format!("{base_detail} 只显示前 {} 字节。", MAX_DIFF_PREVIEW_BYTES);
    }
    Ok(preview)
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

#[tauri::command]
pub fn turn_change_file_preview(
    store: State<'_, HostStore>,
    input: TurnChangeFilePreviewInput,
) -> Result<TurnChangeFilePreview, String> {
    file_preview_for_turn(&store, &input)
}

#[tauri::command]
pub fn turn_change_path_diff_preview(
    store: State<'_, HostStore>,
    input: TurnChangePathDiffPreviewInput,
) -> Result<TurnChangePathDiffPreview, String> {
    diff_preview_for_turn(&store, &input)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_DIFF_PREVIEW_BYTES, MAX_INLINE_FILE_STATE_BYTES, MAX_TEXT_PREVIEW_BYTES,
        TurnChangeCaptureInput, TurnChangeFilePreviewInput, TurnChangeFileState, TurnChangeKind,
        TurnChangePathDiffPreviewInput, TurnChangeProvenanceState, begin_capture,
        diff_preview_for_turn, file_preview_for_turn, finish_capture,
        reconcile_interrupted_captures, snapshots_for_session,
    };
    use crate::{
        host_ids::{FarfoldSessionId, HostTurnId, RuntimeProductId, WorkingCopyId},
        host_store::HostStore,
    };
    use rusqlite::params;
    use std::{
        fs,
        os::unix::fs::symlink,
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
                database.connection.execute("INSERT INTO sessions (farfold_session_id, runtime_product_id, installation_id, runtime_build_id, adapter_id, connection_id, project_id, working_copy_id, native_session_id, title, title_source, pinned, archived_at, created_at, updated_at, last_opened_at) VALUES (?1, 'pi', 'managed-pi', 'pi-build', 'pi-adapter', 'pi-local', 'project-turn-changes', ?2, 'native-turn-changes', 'Turn', 'first_user', 0, NULL, ?3, ?3, ?3)", params![session_id.as_str(), working_copy_id.as_str(), now]).unwrap();
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
        assert_eq!(reviews[0].changes[0].file_state, TurnChangeFileState::Text);
        assert_eq!(reviews[0].changes[1].relative_path, "tracked.txt");
        assert_eq!(reviews[0].changes[1].change_kind, TurnChangeKind::Modified);
        assert_eq!(reviews[0].changes[1].file_state, TurnChangeFileState::Text);
    }

    #[test]
    fn review_classifies_non_text_paths_and_late_path_changes() {
        let fixture = Fixture::new(true);
        let outside = fixture.container.join("outside.txt");
        fs::write(&outside, "outside\n").unwrap();
        fs::write(fixture.root.join("removed.txt"), "remove\n").unwrap();
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&fixture.root)
                .args(["add", "removed.txt"])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&fixture.root)
                .args(["commit", "-m", "track removed"])
                .status()
                .unwrap()
                .success()
        );

        let input = fixture.input("turn-review-file-states");
        begin_capture(&fixture.store, &input).unwrap();
        fs::write(fixture.root.join("binary.bin"), [0_u8, 1, 2, 3]).unwrap();
        fs::write(
            fixture.root.join("large.log"),
            vec![b'x'; MAX_INLINE_FILE_STATE_BYTES as usize + 1],
        )
        .unwrap();
        symlink(&outside, fixture.root.join("escape.txt")).unwrap();
        fs::remove_file(fixture.root.join("removed.txt")).unwrap();
        finish_capture(&fixture.store, &input.turn_id, "completed").unwrap();

        let reviews = snapshots_for_session(&fixture.store, &fixture.session_id).unwrap();
        let review = &reviews[0];
        assert_eq!(review.change_path_count, 4);
        let states = review
            .changes
            .iter()
            .map(|change| (change.relative_path.as_str(), change.file_state))
            .collect::<Vec<_>>();
        assert!(states.contains(&("binary.bin", TurnChangeFileState::Binary)));
        assert!(states.contains(&("escape.txt", TurnChangeFileState::OutsideWorkingCopy)));
        assert!(states.contains(&("large.log", TurnChangeFileState::Large)));
        assert!(states.contains(&("removed.txt", TurnChangeFileState::Deleted)));

        fs::write(fixture.root.join("late.txt"), "after turn\n").unwrap();
        let changed = snapshots_for_session(&fixture.store, &fixture.session_id).unwrap();
        assert_eq!(
            changed[0].current_path_state,
            super::TurnChangeCurrentPathState::ChangedAfterTurn
        );
    }

    #[test]
    fn file_preview_reads_current_text_only_for_recorded_turn_paths() {
        let fixture = Fixture::new(true);
        let outside = fixture.container.join("outside-preview.txt");
        fs::write(&outside, "outside\n").unwrap();
        let input = fixture.input("turn-review-preview");
        begin_capture(&fixture.store, &input).unwrap();
        fs::write(fixture.root.join("new.txt"), "new current content\n").unwrap();
        fs::write(
            fixture.root.join("long.txt"),
            vec![b'a'; MAX_TEXT_PREVIEW_BYTES as usize + 8],
        )
        .unwrap();
        symlink(&outside, fixture.root.join("escape.txt")).unwrap();
        finish_capture(&fixture.store, &input.turn_id, "completed").unwrap();

        let preview = file_preview_for_turn(
            &fixture.store,
            &TurnChangeFilePreviewInput {
                farfold_session_id: fixture.session_id.clone(),
                turn_id: input.turn_id.clone(),
                relative_path: "new.txt".to_string(),
            },
        )
        .unwrap();
        assert_eq!(preview.source, "current_disk");
        assert_eq!(preview.file_state, TurnChangeFileState::Text);
        assert_eq!(preview.text.as_deref(), Some("new current content\n"));
        assert!(!preview.truncated);
        assert!(preview.detail.contains("当前磁盘"));

        let long_preview = file_preview_for_turn(
            &fixture.store,
            &TurnChangeFilePreviewInput {
                farfold_session_id: fixture.session_id.clone(),
                turn_id: input.turn_id.clone(),
                relative_path: "long.txt".to_string(),
            },
        )
        .unwrap();
        assert_eq!(long_preview.file_state, TurnChangeFileState::Text);
        assert!(long_preview.truncated);
        assert_eq!(
            long_preview.text.as_ref().map(|text| text.len()),
            Some(MAX_TEXT_PREVIEW_BYTES as usize)
        );

        let escape_preview = file_preview_for_turn(
            &fixture.store,
            &TurnChangeFilePreviewInput {
                farfold_session_id: fixture.session_id.clone(),
                turn_id: input.turn_id.clone(),
                relative_path: "escape.txt".to_string(),
            },
        )
        .unwrap();
        assert_eq!(
            escape_preview.file_state,
            TurnChangeFileState::OutsideWorkingCopy
        );
        assert!(escape_preview.text.is_none());

        assert!(
            file_preview_for_turn(
                &fixture.store,
                &TurnChangeFilePreviewInput {
                    farfold_session_id: fixture.session_id.clone(),
                    turn_id: input.turn_id.clone(),
                    relative_path: "../outside-preview.txt".to_string(),
                },
            )
            .is_err()
        );
    }

    #[test]
    fn file_preview_keeps_truncated_utf8_text_when_cut_inside_a_character() {
        let fixture = Fixture::new(true);
        let input = fixture.input("turn-review-preview-utf8");
        begin_capture(&fixture.store, &input).unwrap();
        let mut text = "a".repeat(MAX_TEXT_PREVIEW_BYTES as usize - 1);
        text.push('你');
        fs::write(fixture.root.join("utf8.txt"), text).unwrap();
        finish_capture(&fixture.store, &input.turn_id, "completed").unwrap();

        let preview = file_preview_for_turn(
            &fixture.store,
            &TurnChangeFilePreviewInput {
                farfold_session_id: fixture.session_id.clone(),
                turn_id: input.turn_id.clone(),
                relative_path: "utf8.txt".to_string(),
            },
        )
        .unwrap();

        assert_eq!(preview.file_state, TurnChangeFileState::Text);
        assert!(preview.truncated);
        let expected = "a".repeat(MAX_TEXT_PREVIEW_BYTES as usize - 1);
        assert_eq!(preview.text.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn diff_preview_compares_baseline_to_current_disk_for_tracked_and_untracked_text() {
        let fixture = Fixture::new(true);
        let input = fixture.input("turn-review-diff");
        begin_capture(&fixture.store, &input).unwrap();
        fs::write(fixture.root.join("tracked.txt"), "before\nafter\n").unwrap();
        fs::write(fixture.root.join("new.txt"), "new artifact\n").unwrap();
        finish_capture(&fixture.store, &input.turn_id, "completed").unwrap();

        let tracked = diff_preview_for_turn(
            &fixture.store,
            &TurnChangePathDiffPreviewInput {
                farfold_session_id: fixture.session_id.clone(),
                turn_id: input.turn_id.clone(),
                relative_path: "tracked.txt".to_string(),
            },
        )
        .unwrap();
        assert_eq!(tracked.source, "current_disk_against_baseline");
        assert_eq!(tracked.file_state, TurnChangeFileState::Text);
        let tracked_text = tracked.text.as_deref().unwrap();
        assert!(tracked_text.contains("diff --git"));
        assert!(tracked_text.contains("+after"));
        assert!(tracked.detail.contains("当前磁盘"));

        let untracked = diff_preview_for_turn(
            &fixture.store,
            &TurnChangePathDiffPreviewInput {
                farfold_session_id: fixture.session_id.clone(),
                turn_id: input.turn_id.clone(),
                relative_path: "new.txt".to_string(),
            },
        )
        .unwrap();
        assert_eq!(untracked.file_state, TurnChangeFileState::Text);
        let untracked_text = untracked.text.as_deref().unwrap();
        assert!(untracked_text.contains("new file (untracked, current disk)"));
        assert!(untracked_text.contains("+new artifact"));
    }

    #[test]
    fn diff_preview_rejects_large_tracked_paths_without_collecting_git_output() {
        let fixture = Fixture::new(true);
        let input = fixture.input("turn-review-large-diff");
        begin_capture(&fixture.store, &input).unwrap();
        fs::write(
            fixture.root.join("tracked.txt"),
            vec![b'x'; MAX_INLINE_FILE_STATE_BYTES as usize + 1],
        )
        .unwrap();
        finish_capture(&fixture.store, &input.turn_id, "completed").unwrap();

        let preview = diff_preview_for_turn(
            &fixture.store,
            &TurnChangePathDiffPreviewInput {
                farfold_session_id: fixture.session_id.clone(),
                turn_id: input.turn_id.clone(),
                relative_path: "tracked.txt".to_string(),
            },
        )
        .unwrap();

        assert_eq!(preview.file_state, TurnChangeFileState::Large);
        assert!(preview.text.is_none());
        assert!(preview.detail.contains("不适合内联显示 diff"));
    }

    #[test]
    fn diff_preview_bounds_tracked_git_stdout_before_collecting_the_full_patch() {
        let fixture = Fixture::new(true);
        let input = fixture.input("turn-review-bounded-tracked-diff");
        begin_capture(&fixture.store, &input).unwrap();
        let text = (0..20_000)
            .map(|index| format!("line {index}\n"))
            .collect::<String>();
        assert!(text.len() as u64 > MAX_DIFF_PREVIEW_BYTES);
        assert!(text.len() as u64 <= MAX_INLINE_FILE_STATE_BYTES);
        fs::write(fixture.root.join("tracked.txt"), text).unwrap();
        finish_capture(&fixture.store, &input.turn_id, "completed").unwrap();

        let preview = diff_preview_for_turn(
            &fixture.store,
            &TurnChangePathDiffPreviewInput {
                farfold_session_id: fixture.session_id.clone(),
                turn_id: input.turn_id.clone(),
                relative_path: "tracked.txt".to_string(),
            },
        )
        .unwrap();

        assert_eq!(preview.file_state, TurnChangeFileState::Text);
        assert!(preview.truncated);
        assert_eq!(
            preview.text.as_ref().map(|text| text.len()),
            Some(MAX_DIFF_PREVIEW_BYTES as usize)
        );
        assert!(preview.detail.contains("只显示前"));
    }

    #[test]
    fn diff_preview_keeps_truncated_utf8_untracked_text() {
        let fixture = Fixture::new(true);
        let input = fixture.input("turn-review-diff-utf8");
        begin_capture(&fixture.store, &input).unwrap();
        let mut text = "a".repeat(MAX_DIFF_PREVIEW_BYTES as usize - 1);
        text.push('你');
        fs::write(fixture.root.join("utf8-new.txt"), text).unwrap();
        finish_capture(&fixture.store, &input.turn_id, "completed").unwrap();

        let preview = diff_preview_for_turn(
            &fixture.store,
            &TurnChangePathDiffPreviewInput {
                farfold_session_id: fixture.session_id.clone(),
                turn_id: input.turn_id.clone(),
                relative_path: "utf8-new.txt".to_string(),
            },
        )
        .unwrap();

        assert_eq!(preview.file_state, TurnChangeFileState::Text);
        assert!(preview.truncated);
        assert!(preview.text.as_deref().unwrap().contains("+aaa"));
        assert!(!preview.text.as_deref().unwrap().contains('你'));
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
