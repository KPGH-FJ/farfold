use super::{HostDatabase, HostStore, now_millis};
use crate::{
    host_ids::{ProjectId, WorkingCopyId, derived_host_id},
    host_store::records::WorkingCopyKind,
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

use crate::{session_controller::HostSessionController, turn_coordinator::TurnCoordinator};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkingCopyPathState {
    Ready,
    Missing,
    NotDirectory,
    IdentityMismatch,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkingCopyGitState {
    Git,
    NotGit,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkingCopyChangeState {
    Clean,
    Dirty,
    Conflicted,
    NotGit,
    Unavailable,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyGitStatus {
    state: WorkingCopyChangeState,
    staged_path_count: u64,
    unstaged_path_count: u64,
    untracked_path_count: u64,
    conflicted_path_count: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedWorktreeState {
    Creating,
    Ready,
    Orphaned,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreePreviewInput {
    source_working_copy_id: WorkingCopyId,
    branch_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreePreview {
    source_working_copy_id: WorkingCopyId,
    project_id: ProjectId,
    source_path: String,
    source_branch_name: Option<String>,
    source_head_oid: String,
    source_git_status: WorkingCopyGitStatus,
    branch_name: String,
    working_copy_id: WorkingCopyId,
    working_copy_path: String,
    requires_local_changes_choice: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LocalChangesChoice {
    UseHeadOnly,
    Cancel,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreeCreateInput {
    preview: ManagedWorktreePreview,
    local_changes_choice: Option<LocalChangesChoice>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWorktreeCreateResult {
    working_copy_id: WorkingCopyId,
    project_id: ProjectId,
    working_copy_path: String,
    branch_name: String,
    source_head_oid: String,
    lifecycle_state: ManagedWorktreeState,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyRegistrationPreview {
    pub(crate) project_id: ProjectId,
    pub(crate) project_path: String,
    pub(crate) project_name: String,
    pub(crate) working_copy_id: WorkingCopyId,
    pub(crate) working_copy_path: String,
    pub(crate) kind: WorkingCopyKind,
    pub(crate) branch_name: Option<String>,
    pub(crate) git_state: WorkingCopyGitState,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopySnapshot {
    working_copies: Vec<WorkingCopyRecord>,
    observed_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingCopyRecord {
    working_copy_id: WorkingCopyId,
    project_id: ProjectId,
    canonical_path: String,
    kind: WorkingCopyKind,
    branch_name: Option<String>,
    path_state: WorkingCopyPathState,
    git_status: WorkingCopyGitStatus,
    bound_session_count: u64,
    unarchived_session_count: u64,
    created_at: i64,
    updated_at: i64,
    managed_state: Option<ManagedWorktreeState>,
    managed_source_working_copy_id: Option<WorkingCopyId>,
    managed_source_head_oid: Option<String>,
    managed_error_code: Option<String>,
}

struct RawWorkingCopyRecord {
    working_copy_id: String,
    project_id: String,
    canonical_path: String,
    kind: String,
    branch_name: Option<String>,
    bound_session_count: i64,
    unarchived_session_count: i64,
    created_at: i64,
    updated_at: i64,
    managed_state: Option<String>,
    managed_source_working_copy_id: Option<String>,
    managed_source_head_oid: Option<String>,
    managed_error_code: Option<String>,
}

impl ManagedWorktreeState {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "creating" => Ok(Self::Creating),
            "ready" => Ok(Self::Ready),
            "orphaned" => Ok(Self::Orphaned),
            _ => Err(format!("Unknown managed Worktree state: {value}")),
        }
    }
}

impl TryFrom<RawWorkingCopyRecord> for WorkingCopyRecord {
    type Error = String;

    fn try_from(raw: RawWorkingCopyRecord) -> Result<Self, Self::Error> {
        let path_state = observe_path(Path::new(&raw.canonical_path));
        let git_status = observe_git_status(Path::new(&raw.canonical_path), path_state);
        Ok(Self {
            working_copy_id: WorkingCopyId::parse(raw.working_copy_id)
                .map_err(|error| error.to_string())?,
            project_id: ProjectId::parse(raw.project_id).map_err(|error| error.to_string())?,
            path_state,
            git_status,
            canonical_path: raw.canonical_path,
            kind: WorkingCopyKind::parse(&raw.kind)?,
            branch_name: raw.branch_name,
            bound_session_count: u64::try_from(raw.bound_session_count)
                .map_err(|_| "Working Copy Session count is invalid".to_string())?,
            unarchived_session_count: u64::try_from(raw.unarchived_session_count)
                .map_err(|_| "Working Copy active Session count is invalid".to_string())?,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            managed_state: raw
                .managed_state
                .as_deref()
                .map(ManagedWorktreeState::parse)
                .transpose()?,
            managed_source_working_copy_id: raw
                .managed_source_working_copy_id
                .map(WorkingCopyId::parse)
                .transpose()
                .map_err(|error| error.to_string())?,
            managed_source_head_oid: raw.managed_source_head_oid,
            managed_error_code: raw.managed_error_code,
        })
    }
}

fn unavailable_git_status() -> WorkingCopyGitStatus {
    WorkingCopyGitStatus {
        state: WorkingCopyChangeState::Unavailable,
        staged_path_count: 0,
        unstaged_path_count: 0,
        untracked_path_count: 0,
        conflicted_path_count: 0,
    }
}

fn observe_git_status(path: &Path, path_state: WorkingCopyPathState) -> WorkingCopyGitStatus {
    if path_state != WorkingCopyPathState::Ready {
        return unavailable_git_status();
    }
    let output = match Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(path)
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignore-submodules=none",
        ])
        .env("LC_ALL", "C")
        .output()
    {
        Ok(output) => output,
        Err(_) => return unavailable_git_status(),
    };
    if !output.status.success() {
        return if contains_git_marker(path) {
            unavailable_git_status()
        } else {
            WorkingCopyGitStatus {
                state: WorkingCopyChangeState::NotGit,
                staged_path_count: 0,
                unstaged_path_count: 0,
                untracked_path_count: 0,
                conflicted_path_count: 0,
            }
        };
    }
    parse_porcelain_status(&output.stdout).unwrap_or_else(unavailable_git_status)
}

pub(crate) fn observe_working_copy_safety(
    path: &Path,
) -> (WorkingCopyPathState, WorkingCopyGitStatus) {
    let path_state = observe_path(path);
    let git_status = observe_git_status(path, path_state);
    (path_state, git_status)
}

fn parse_porcelain_status(output: &[u8]) -> Option<WorkingCopyGitStatus> {
    if !output.is_empty() && !output.ends_with(&[0]) {
        return None;
    }
    let mut staged_path_count = 0_u64;
    let mut unstaged_path_count = 0_u64;
    let mut untracked_path_count = 0_u64;
    let mut conflicted_path_count = 0_u64;
    let mut records = output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if record.len() < 3 || record[2] != b' ' {
            return None;
        }
        let x = record[0];
        let y = record[1];
        let conflict = matches!(
            (x, y),
            (b'D', b'D')
                | (b'A', b'U')
                | (b'U', b'D')
                | (b'U', b'A')
                | (b'D', b'U')
                | (b'A', b'A')
                | (b'U', b'U')
        );
        if conflict {
            conflicted_path_count = conflicted_path_count.checked_add(1)?;
        } else if x == b'?' && y == b'?' {
            untracked_path_count = untracked_path_count.checked_add(1)?;
        } else if x == b'!' && y == b'!' {
            // Ignored records are not requested, but tolerate them if Git emits one.
        } else {
            if x != b' ' {
                staged_path_count = staged_path_count.checked_add(1)?;
            }
            if y != b' ' {
                unstaged_path_count = unstaged_path_count.checked_add(1)?;
            }
        }
        if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            records.next()?;
        }
    }
    let state = if conflicted_path_count > 0 {
        WorkingCopyChangeState::Conflicted
    } else if staged_path_count > 0 || unstaged_path_count > 0 || untracked_path_count > 0 {
        WorkingCopyChangeState::Dirty
    } else {
        WorkingCopyChangeState::Clean
    };
    Some(WorkingCopyGitStatus {
        state,
        staged_path_count,
        unstaged_path_count,
        untracked_path_count,
        conflicted_path_count,
    })
}

fn observe_path(expected: &Path) -> WorkingCopyPathState {
    let metadata = match fs::symlink_metadata(expected) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return WorkingCopyPathState::Missing,
        Err(_) => return WorkingCopyPathState::Unavailable,
    };
    if !metadata.is_dir() {
        return WorkingCopyPathState::NotDirectory;
    }
    match expected.canonicalize() {
        Ok(observed) if observed == expected => WorkingCopyPathState::Ready,
        Ok(_) => WorkingCopyPathState::IdentityMismatch,
        Err(_) => WorkingCopyPathState::Unavailable,
    }
}

fn contains_git_marker(path: &Path) -> bool {
    path.ancestors()
        .any(|ancestor| fs::symlink_metadata(ancestor.join(".git")).is_ok())
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Working Copy: {error}"))?;
    if !path.is_dir() {
        return Err("Working Copy is not a directory".to_string());
    }
    Ok(path)
}

fn git_lines(path: &Path, arguments: &[&str]) -> Result<Option<Vec<String>>, String> {
    let output = match Command::new("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .env("LC_ALL", "C")
        .output()
    {
        Ok(output) => output,
        Err(_) if !contains_git_marker(path) => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect Git Working Copy: {error}")),
    };
    if !output.status.success() {
        if contains_git_marker(path) {
            let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!("Cannot inspect Git Working Copy: {reason}"));
        }
        return Ok(None);
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("Git returned non-UTF-8 Working Copy identity: {error}"))?;
    Ok(Some(stdout.lines().map(str::to_string).collect()))
}

fn git_branch(path: &Path) -> Result<Option<String>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .env("LC_ALL", "C")
        .output()
        .map_err(|error| format!("Cannot inspect Git branch: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let branch = String::from_utf8(output.stdout)
        .map_err(|error| format!("Git returned a non-UTF-8 branch name: {error}"))?;
    Ok(Some(branch.trim().to_string()).filter(|branch| !branch.is_empty()))
}

pub(crate) fn registration_preview(path: &Path) -> Result<WorkingCopyRegistrationPreview, String> {
    let requested = canonical_directory(path)?;
    let identity = git_lines(
        &requested,
        &["rev-parse", "--show-toplevel", "--git-common-dir"],
    )?;
    let (project_path, working_copy_path, kind, branch_name, git_state) = match identity {
        None => (
            requested.clone(),
            requested,
            WorkingCopyKind::Root,
            None,
            WorkingCopyGitState::NotGit,
        ),
        Some(lines) if lines.len() == 2 => {
            let working_copy_path = canonical_directory(Path::new(&lines[0]))?;
            if !requested.starts_with(&working_copy_path) {
                return Err("Git Working Copy root does not contain the requested path".to_string());
            }
            let common = PathBuf::from(&lines[1]);
            let common = if common.is_absolute() {
                common
            } else {
                working_copy_path.join(common)
            }
            .canonicalize()
            .map_err(|error| format!("Cannot resolve Git common directory: {error}"))?;
            if common.file_name().is_none_or(|name| name != ".git") {
                return Err("Git common directory is not a supported checkout identity".to_string());
            }
            let project_path = common
                .parent()
                .ok_or_else(|| "Git common directory has no Project root".to_string())?
                .to_path_buf();
            let kind = if project_path == working_copy_path {
                WorkingCopyKind::Root
            } else {
                WorkingCopyKind::Worktree
            };
            let branch_name = git_branch(&working_copy_path)?;
            (
                project_path,
                working_copy_path,
                kind,
                branch_name,
                WorkingCopyGitState::Git,
            )
        }
        Some(_) => return Err("Git returned an invalid Working Copy identity".to_string()),
    };
    let project_path_text = project_path.to_string_lossy().into_owned();
    let working_copy_path_text = working_copy_path.to_string_lossy().into_owned();
    let project_id = ProjectId::parse(derived_host_id("project", &[&project_path_text]))
        .map_err(|error| error.to_string())?;
    let working_copy_id = WorkingCopyId::parse(derived_host_id(
        "working-copy",
        &[project_id.as_str(), &working_copy_path_text],
    ))
    .map_err(|error| error.to_string())?;
    let project_name = project_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Project")
        .to_string();
    Ok(WorkingCopyRegistrationPreview {
        project_id,
        project_path: project_path_text,
        project_name,
        working_copy_id,
        working_copy_path: working_copy_path_text,
        kind,
        branch_name,
        git_state,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StoredWorkingCopy {
    working_copy_id: WorkingCopyId,
    project_id: ProjectId,
    canonical_path: PathBuf,
}

fn read_stored_working_copy(
    store: &HostStore,
    working_copy_id: &WorkingCopyId,
) -> Result<StoredWorkingCopy, String> {
    store.with_ready_database(|database| {
        let raw = database
            .connection
            .query_row(
                "SELECT working_copy_id, project_id, canonical_path
                 FROM working_copies WHERE working_copy_id = ?1",
                [working_copy_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot read source Working Copy: {error}"))?
            .ok_or_else(|| format!("Unknown source Working Copy: {working_copy_id}"))?;
        Ok(StoredWorkingCopy {
            working_copy_id: WorkingCopyId::parse(raw.0).map_err(|error| error.to_string())?,
            project_id: ProjectId::parse(raw.1).map_err(|error| error.to_string())?,
            canonical_path: PathBuf::from(raw.2),
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

fn validate_new_branch(path: &Path, branch_name: &str) -> Result<(), String> {
    if branch_name.trim() != branch_name || branch_name.is_empty() || branch_name.len() > 200 {
        return Err(
            "Managed Worktree branch must contain between 1 and 200 trimmed bytes".to_string(),
        );
    }
    git_stdout(
        path,
        &["check-ref-format", "--branch", branch_name],
        "validate managed Worktree branch",
    )?;
    let exists = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(path)
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch_name}"))
        .env("LC_ALL", "C")
        .status()
        .map_err(|error| format!("Cannot inspect managed Worktree branch: {error}"))?;
    match exists.code() {
        Some(0) => Err(format!(
            "Managed Worktree branch already exists: {branch_name}"
        )),
        Some(1) => Ok(()),
        _ => Err("Git could not determine whether the managed Worktree branch exists".to_string()),
    }
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
        .map_err(|error| format!("Cannot inspect managed Worktree branch: {error}"))?;
    match status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err("Git could not determine whether the managed Worktree branch exists".to_string()),
    }
}

fn branch_slug(branch_name: &str) -> String {
    let slug = branch_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    slug.trim_matches('-').chars().take(48).collect::<String>()
}

fn preview_for_root(
    store: &HostStore,
    managed_root: &Path,
    input: &ManagedWorktreePreviewInput,
) -> Result<ManagedWorktreePreview, String> {
    let managed_root = canonical_directory(managed_root)?;
    let source = read_stored_working_copy(store, &input.source_working_copy_id)?;
    let source_path = canonical_directory(&source.canonical_path)?;
    if source_path != source.canonical_path {
        return Err("Stored source Working Copy identity changed".to_string());
    }
    let registration = registration_preview(&source_path)?;
    if registration.git_state != WorkingCopyGitState::Git
        || registration.working_copy_id != source.working_copy_id
        || registration.project_id != source.project_id
    {
        return Err("Source Working Copy no longer matches its Host identity".to_string());
    }
    validate_new_branch(&source_path, &input.branch_name)?;
    let source_head_oid = git_stdout(
        &source_path,
        &["rev-parse", "--verify", "HEAD"],
        "resolve source Working Copy HEAD",
    )?;
    if !(40..=64).contains(&source_head_oid.len())
        || !source_head_oid.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Git returned an invalid source HEAD object ID".to_string());
    }
    let source_git_status = observe_git_status(&source_path, WorkingCopyPathState::Ready);
    if matches!(
        source_git_status.state,
        WorkingCopyChangeState::NotGit | WorkingCopyChangeState::Unavailable
    ) {
        return Err("Source Working Copy Git status is unavailable".to_string());
    }
    let seed = derived_host_id(
        "managed-worktree",
        &[source.project_id.as_str(), &input.branch_name],
    );
    let suffix = seed.rsplit('-').next().unwrap_or(&seed);
    let slug = branch_slug(&input.branch_name);
    let directory_name = format!(
        "{}-{}",
        if slug.is_empty() { "worktree" } else { &slug },
        &suffix[..12]
    );
    let working_copy_path = managed_root
        .join("managed-worktrees")
        .join(source.project_id.as_str())
        .join(directory_name);
    if fs::symlink_metadata(&working_copy_path).is_ok() {
        return Err("Managed Worktree destination already exists".to_string());
    }
    let working_copy_path_text = working_copy_path.to_string_lossy().into_owned();
    let working_copy_id = WorkingCopyId::parse(derived_host_id(
        "working-copy",
        &[source.project_id.as_str(), &working_copy_path_text],
    ))
    .map_err(|error| error.to_string())?;
    let collision = store.with_ready_database(|database| {
        database
            .connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM working_copies
                    WHERE working_copy_id = ?1 OR canonical_path = ?2
                 ) OR EXISTS(
                    SELECT 1 FROM managed_worktrees
                    WHERE project_id = ?3 AND branch_name = ?4
                 )",
                params![
                    working_copy_id.as_str(),
                    working_copy_path_text,
                    source.project_id.as_str(),
                    input.branch_name
                ],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("Cannot check managed Worktree reservation: {error}"))
    })?;
    if collision {
        return Err("Managed Worktree identity or branch is already reserved".to_string());
    }
    Ok(ManagedWorktreePreview {
        source_working_copy_id: source.working_copy_id,
        project_id: source.project_id,
        source_path: source_path.to_string_lossy().into_owned(),
        source_branch_name: registration.branch_name,
        source_head_oid: source_head_oid.to_ascii_lowercase(),
        source_git_status: source_git_status.clone(),
        branch_name: input.branch_name.clone(),
        working_copy_id,
        working_copy_path: working_copy_path_text,
        requires_local_changes_choice: source_git_status.state != WorkingCopyChangeState::Clean,
    })
}

fn reserve_managed_worktree(
    store: &HostStore,
    preview: &ManagedWorktreePreview,
    local_changes_choice: &str,
) -> Result<(), String> {
    store.with_ready_database(|database| {
        let timestamp = now_millis();
        let transaction = database
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin managed Worktree reservation: {error}"))?;
        let source = transaction
            .query_row(
                "SELECT project_id, canonical_path FROM working_copies
                 WHERE working_copy_id = ?1",
                [preview.source_working_copy_id.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| format!("Cannot re-read source Working Copy: {error}"))?;
        if source
            != (
                preview.project_id.as_str().to_string(),
                preview.source_path.clone(),
            )
        {
            return Err("Source Working Copy changed after preview".to_string());
        }
        transaction
            .execute(
                "INSERT INTO working_copies(
                    working_copy_id, project_id, canonical_path, kind, branch_name,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 'worktree', ?4, ?5, ?5)",
                params![
                    preview.working_copy_id.as_str(),
                    preview.project_id.as_str(),
                    preview.working_copy_path,
                    preview.branch_name,
                    timestamp
                ],
            )
            .map_err(|error| format!("Cannot reserve managed Working Copy: {error}"))?;
        transaction
            .execute(
                "INSERT INTO managed_worktrees(
                    working_copy_id, project_id, source_working_copy_id, source_head_oid,
                    branch_name, local_changes_choice, lifecycle_state, error_code,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'creating', NULL, ?7, ?7)",
                params![
                    preview.working_copy_id.as_str(),
                    preview.project_id.as_str(),
                    preview.source_working_copy_id.as_str(),
                    preview.source_head_oid,
                    preview.branch_name,
                    local_changes_choice,
                    timestamp
                ],
            )
            .map_err(|error| format!("Cannot reserve managed Worktree lifecycle: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit managed Worktree reservation: {error}"))
    })
}

fn remove_empty_reservation(
    store: &HostStore,
    working_copy_id: &WorkingCopyId,
) -> Result<(), String> {
    store.with_ready_database(|database| {
        database
            .connection
            .execute(
                "DELETE FROM working_copies
                 WHERE working_copy_id = ?1
                   AND NOT EXISTS(
                       SELECT 1 FROM sessions WHERE working_copy_id = ?1
                   )",
                [working_copy_id.as_str()],
            )
            .map_err(|error| format!("Cannot remove empty managed Worktree reservation: {error}"))
            .and_then(|changed| {
                if changed == 1 {
                    Ok(())
                } else {
                    Err("Managed Worktree reservation is no longer empty".to_string())
                }
            })
    })
}

fn cancel_reserved_creation(
    store: &HostStore,
    working_copy_id: &WorkingCopyId,
    reason: String,
) -> String {
    match remove_empty_reservation(store, working_copy_id) {
        Ok(()) => reason,
        Err(cleanup) => format!("{reason}; reservation cleanup also failed: {cleanup}"),
    }
}

fn set_managed_state(
    store: &HostStore,
    working_copy_id: &WorkingCopyId,
    state: &str,
    error_code: Option<&str>,
) -> Result<(), String> {
    store.with_ready_database(|database| {
        let changed = database
            .connection
            .execute(
                "UPDATE managed_worktrees
                 SET lifecycle_state = ?2, error_code = ?3, updated_at = ?4
                 WHERE working_copy_id = ?1 AND lifecycle_state = 'creating'",
                params![working_copy_id.as_str(), state, error_code, now_millis()],
            )
            .map_err(|error| format!("Cannot update managed Worktree lifecycle: {error}"))?;
        if changed == 1 {
            Ok(())
        } else {
            Err("Managed Worktree lifecycle changed unexpectedly".to_string())
        }
    })
}

fn preserve_or_remove_failed_creation(
    store: &HostStore,
    preview: &ManagedWorktreePreview,
    reason: String,
) -> String {
    let destination_exists = fs::symlink_metadata(&preview.working_copy_path).is_ok();
    let branch_may_exist =
        branch_exists(Path::new(&preview.source_path), &preview.branch_name).unwrap_or(true);
    let cleanup = if destination_exists || branch_may_exist {
        set_managed_state(
            store,
            &preview.working_copy_id,
            "orphaned",
            Some("creation_failed_with_git_assets"),
        )
    } else {
        remove_empty_reservation(store, &preview.working_copy_id)
    };
    match cleanup {
        Ok(()) => reason,
        Err(cleanup) => {
            format!("{reason}; managed Worktree recovery record also failed: {cleanup}")
        }
    }
}

fn create_for_root(
    store: &HostStore,
    turns: &TurnCoordinator,
    managed_root: &Path,
    input: ManagedWorktreeCreateInput,
) -> Result<ManagedWorktreeCreateResult, String> {
    if input.local_changes_choice == Some(LocalChangesChoice::Cancel) {
        return Err("Managed Worktree creation was cancelled before mutation".to_string());
    }
    let fresh = preview_for_root(
        store,
        managed_root,
        &ManagedWorktreePreviewInput {
            source_working_copy_id: input.preview.source_working_copy_id.clone(),
            branch_name: input.preview.branch_name.clone(),
        },
    )?;
    if fresh != input.preview {
        return Err("Managed Worktree preview is stale; preview again before creating".to_string());
    }
    turns.require_working_copy_idle(&fresh.source_working_copy_id)?;
    let local_changes_choice = if fresh.requires_local_changes_choice {
        match input.local_changes_choice {
            Some(LocalChangesChoice::UseHeadOnly) => "use_head_only",
            None => {
                return Err(
                    "Dirty source Working Copy requires explicit use_head_only confirmation"
                        .to_string(),
                );
            }
            Some(LocalChangesChoice::Cancel) => unreachable!("cancel handled before preview"),
        }
    } else {
        "clean"
    };
    reserve_managed_worktree(store, &fresh, local_changes_choice)?;
    let destination = PathBuf::from(&fresh.working_copy_path);
    let parent = destination
        .parent()
        .ok_or_else(|| "Managed Worktree destination has no parent".to_string())?;
    if let Err(error) = fs::create_dir_all(parent) {
        return Err(preserve_or_remove_failed_creation(
            store,
            &fresh,
            format!("Cannot create managed Worktree parent: {error}"),
        ));
    }
    let canonical_root = canonical_directory(managed_root)
        .map_err(|error| preserve_or_remove_failed_creation(store, &fresh, error))?;
    let canonical_parent = canonical_directory(parent)
        .map_err(|error| preserve_or_remove_failed_creation(store, &fresh, error))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(preserve_or_remove_failed_creation(
            store,
            &fresh,
            "Managed Worktree parent escaped the application data root".to_string(),
        ));
    }
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(cancel_reserved_creation(
            store,
            &fresh.working_copy_id,
            "Managed Worktree destination appeared after preview".to_string(),
        ));
    }
    let branch_now_exists = branch_exists(Path::new(&fresh.source_path), &fresh.branch_name)
        .map_err(|error| cancel_reserved_creation(store, &fresh.working_copy_id, error))?;
    if branch_now_exists {
        return Err(cancel_reserved_creation(
            store,
            &fresh.working_copy_id,
            "Managed Worktree branch appeared after preview".to_string(),
        ));
    }
    let current_head = git_stdout(
        Path::new(&fresh.source_path),
        &["rev-parse", "--verify", "HEAD"],
        "revalidate source Working Copy HEAD",
    )
    .map_err(|error| cancel_reserved_creation(store, &fresh.working_copy_id, error))?;
    let current_status =
        observe_git_status(Path::new(&fresh.source_path), WorkingCopyPathState::Ready);
    if !current_head.eq_ignore_ascii_case(&fresh.source_head_oid)
        || current_status != fresh.source_git_status
    {
        return Err(cancel_reserved_creation(
            store,
            &fresh.working_copy_id,
            "Source Working Copy changed immediately before creation; preview again".to_string(),
        ));
    }
    let output = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(&fresh.source_path)
        .args(["worktree", "add", "--no-track", "-b"])
        .arg(&fresh.branch_name)
        .arg(&destination)
        .arg(&fresh.source_head_oid)
        .env("LC_ALL", "C")
        .output()
        .map_err(|error| {
            preserve_or_remove_failed_creation(
                store,
                &fresh,
                format!("Cannot start managed Worktree creation: {error}"),
            )
        })?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr);
        return Err(preserve_or_remove_failed_creation(
            store,
            &fresh,
            format!("Git could not create managed Worktree: {}", reason.trim()),
        ));
    }
    let observed = registration_preview(&destination)
        .map_err(|error| preserve_or_remove_failed_creation(store, &fresh, error))?;
    if observed.project_id != fresh.project_id
        || observed.working_copy_id != fresh.working_copy_id
        || observed.kind != WorkingCopyKind::Worktree
        || observed.branch_name.as_deref() != Some(fresh.branch_name.as_str())
    {
        return Err(preserve_or_remove_failed_creation(
            store,
            &fresh,
            "Created Worktree does not match the reserved Host identity".to_string(),
        ));
    }
    set_managed_state(store, &fresh.working_copy_id, "ready", None).map_err(|error| {
        let recovery = set_managed_state(
            store,
            &fresh.working_copy_id,
            "orphaned",
            Some("ready_commit_failed"),
        );
        match recovery {
            Ok(()) => error,
            Err(recovery) => format!("{error}; orphan recovery also failed: {recovery}"),
        }
    })?;
    Ok(ManagedWorktreeCreateResult {
        working_copy_id: fresh.working_copy_id,
        project_id: fresh.project_id,
        working_copy_path: fresh.working_copy_path,
        branch_name: fresh.branch_name,
        source_head_oid: fresh.source_head_oid,
        lifecycle_state: ManagedWorktreeState::Ready,
    })
}

impl HostStore {
    pub fn working_copy_snapshot(&self) -> Result<WorkingCopySnapshot, String> {
        self.with_ready_database(snapshot)
    }
}

fn snapshot(database: &mut HostDatabase) -> Result<WorkingCopySnapshot, String> {
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Cannot begin Working Copy snapshot: {error}"))?;
    let raw_working_copies = {
        let mut statement = transaction
            .prepare(
                "SELECT
                    w.working_copy_id,
                    w.project_id,
                    w.canonical_path,
                    w.kind,
                    w.branch_name,
                    COUNT(s.farfold_session_id),
                    COALESCE(SUM(CASE
                        WHEN s.farfold_session_id IS NOT NULL AND s.archived_at IS NULL THEN 1
                        ELSE 0
                    END), 0),
                    w.created_at,
                    w.updated_at,
                    m.lifecycle_state,
                    m.source_working_copy_id,
                    m.source_head_oid,
                    m.error_code
                 FROM working_copies w
                 LEFT JOIN sessions s
                  ON s.working_copy_id = w.working_copy_id
                  AND s.project_id = w.project_id
                 LEFT JOIN managed_worktrees m
                   ON m.working_copy_id = w.working_copy_id
                 GROUP BY
                    w.working_copy_id,
                    w.project_id,
                    w.canonical_path,
                    w.kind,
                    w.branch_name,
                    w.created_at,
                    w.updated_at,
                    m.lifecycle_state,
                    m.source_working_copy_id,
                    m.source_head_oid,
                    m.error_code
                 ORDER BY w.project_id ASC, w.canonical_path ASC",
            )
            .map_err(|error| format!("Cannot prepare Working Copy snapshot: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(RawWorkingCopyRecord {
                    working_copy_id: row.get(0)?,
                    project_id: row.get(1)?,
                    canonical_path: row.get(2)?,
                    kind: row.get(3)?,
                    branch_name: row.get(4)?,
                    bound_session_count: row.get(5)?,
                    unarchived_session_count: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                    managed_state: row.get(9)?,
                    managed_source_working_copy_id: row.get(10)?,
                    managed_source_head_oid: row.get(11)?,
                    managed_error_code: row.get(12)?,
                })
            })
            .map_err(|error| format!("Cannot read Working Copy snapshot: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot decode Working Copy snapshot: {error}"))?
    };
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Working Copy snapshot: {error}"))?;
    let working_copies = raw_working_copies
        .into_iter()
        .map(WorkingCopyRecord::try_from)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WorkingCopySnapshot {
        working_copies,
        observed_at: now_millis(),
    })
}

#[tauri::command]
pub fn working_copy_snapshot(store: State<'_, HostStore>) -> Result<WorkingCopySnapshot, String> {
    store.working_copy_snapshot()
}

#[tauri::command]
pub fn working_copy_registration_preview(
    project_path: String,
) -> Result<WorkingCopyRegistrationPreview, String> {
    registration_preview(Path::new(&project_path))
}

#[tauri::command]
pub fn managed_worktree_creation_preview(
    app: AppHandle,
    store: State<'_, HostStore>,
    input: ManagedWorktreePreviewInput,
) -> Result<ManagedWorktreePreview, String> {
    let managed_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Farfold application data root: {error}"))?;
    preview_for_root(&store, &managed_root, &input)
}

#[tauri::command]
pub fn managed_worktree_create(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    input: ManagedWorktreeCreateInput,
) -> Result<ManagedWorktreeCreateResult, String> {
    controller.exclusive(|| {
        let managed_root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Cannot resolve Farfold application data root: {error}"))?;
        create_for_root(&store, &turns, &managed_root, input)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        LocalChangesChoice, ManagedWorktreeCreateInput, ManagedWorktreePreviewInput,
        ManagedWorktreeState, WorkingCopyChangeState, WorkingCopyGitState, WorkingCopyPathState,
        create_for_root, observe_git_status, observe_path, parse_porcelain_status,
        preview_for_root, registration_preview, snapshot,
    };
    use crate::host_store::{CURRENT_SCHEMA_VERSION, HostDatabaseOpen, HostStore};
    use crate::turn_coordinator::TurnCoordinator;
    use rusqlite::params;
    use std::{fs, path::Path, process::Command};

    fn initialize_git_source(container: &Path) -> std::path::PathBuf {
        let source = container.join("source");
        fs::create_dir_all(&source).unwrap();
        assert!(
            Command::new("git")
                .arg("init")
                .arg(&source)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args([
                    "-c",
                    "user.name=Farfold",
                    "-c",
                    "user.email=farfold@example.invalid"
                ])
                .arg("-C")
                .arg(&source)
                .args(["commit", "--allow-empty", "-m", "initial"])
                .status()
                .unwrap()
                .success()
        );
        source.canonicalize().unwrap()
    }

    fn register_source(store: &HostStore, source: &Path) -> super::WorkingCopyRegistrationPreview {
        let preview = registration_preview(source).unwrap();
        store
            .with_ready_database(|database| {
                database
                    .connection
                    .execute(
                        "INSERT INTO projects(
                            project_id, canonical_path, display_name, created_at, updated_at
                         ) VALUES (?1, ?2, ?3, 1, 1)",
                        params![
                            preview.project_id.as_str(),
                            preview.project_path,
                            preview.project_name
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
                            preview.working_copy_id.as_str(),
                            preview.project_id.as_str(),
                            preview.working_copy_path,
                            preview.branch_name
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        preview
    }

    fn remove_managed_worktree(source: &Path, destination: &Path, branch: &str) {
        let _ = Command::new("git")
            .arg("-C")
            .arg(source)
            .args(["worktree", "remove", "--force"])
            .arg(destination)
            .status();
        let _ = Command::new("git")
            .arg("-C")
            .arg(source)
            .args(["branch", "-D", branch])
            .status();
    }

    #[test]
    fn porcelain_parser_counts_categories_and_skips_rename_source_path() {
        let status = parse_porcelain_status(
            b"M  staged.txt\0 M unstaged.txt\0?? untracked.txt\0UU conflict.txt\0R  to.txt\0from.txt\0",
        )
        .unwrap();
        assert_eq!(status.state, WorkingCopyChangeState::Conflicted);
        assert_eq!(status.staged_path_count, 2);
        assert_eq!(status.unstaged_path_count, 1);
        assert_eq!(status.untracked_path_count, 1);
        assert_eq!(status.conflicted_path_count, 1);
        assert!(parse_porcelain_status(b"invalid\0").is_none());
    }

    #[test]
    fn clean_managed_worktree_is_created_at_exact_head_and_recorded_ready() {
        let container = std::env::temp_dir().join(format!(
            "farfold-managed-worktree-clean-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&container);
        fs::create_dir_all(container.join("app-data")).unwrap();
        let source = initialize_git_source(&container);
        let store = HostStore::open(container.join("host.sqlite3"));
        let registered = register_source(&store, &source);
        let preview = preview_for_root(
            &store,
            &container.join("app-data"),
            &ManagedWorktreePreviewInput {
                source_working_copy_id: registered.working_copy_id,
                branch_name: "farfold/clean-test".to_string(),
            },
        )
        .unwrap();
        assert!(!preview.requires_local_changes_choice);

        let result = create_for_root(
            &store,
            &TurnCoordinator::default(),
            &container.join("app-data"),
            ManagedWorktreeCreateInput {
                preview: preview.clone(),
                local_changes_choice: None,
            },
        )
        .unwrap();
        assert_eq!(result.lifecycle_state, ManagedWorktreeState::Ready);
        assert_eq!(result.source_head_oid, preview.source_head_oid);
        assert_eq!(
            super::git_stdout(
                Path::new(&result.working_copy_path),
                &["rev-parse", "HEAD"],
                "read created Worktree HEAD"
            )
            .unwrap(),
            preview.source_head_oid
        );
        let copies = store.working_copy_snapshot().unwrap();
        let created = copies
            .working_copies
            .iter()
            .find(|copy| copy.working_copy_id == result.working_copy_id)
            .unwrap();
        assert_eq!(created.managed_state, Some(ManagedWorktreeState::Ready));
        assert_eq!(
            created.managed_source_working_copy_id.as_ref(),
            Some(&preview.source_working_copy_id)
        );
        assert_eq!(
            created.managed_source_head_oid,
            Some(preview.source_head_oid)
        );
        assert_eq!(created.managed_error_code, None);

        remove_managed_worktree(
            &source,
            Path::new(&result.working_copy_path),
            &result.branch_name,
        );
        drop(store);
        let _ = fs::remove_dir_all(container);
    }

    #[test]
    fn dirty_source_requires_explicit_head_only_and_never_copies_local_files() {
        let container = std::env::temp_dir().join(format!(
            "farfold-managed-worktree-dirty-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&container);
        fs::create_dir_all(container.join("app-data")).unwrap();
        let source = initialize_git_source(&container);
        fs::write(source.join("untracked-local.txt"), b"local only").unwrap();
        let store = HostStore::open(container.join("host.sqlite3"));
        let registered = register_source(&store, &source);
        let preview = preview_for_root(
            &store,
            &container.join("app-data"),
            &ManagedWorktreePreviewInput {
                source_working_copy_id: registered.working_copy_id,
                branch_name: "farfold/dirty-test".to_string(),
            },
        )
        .unwrap();
        assert!(preview.requires_local_changes_choice);
        assert_eq!(
            preview.source_git_status.state,
            WorkingCopyChangeState::Dirty
        );

        let blocked = create_for_root(
            &store,
            &TurnCoordinator::default(),
            &container.join("app-data"),
            ManagedWorktreeCreateInput {
                preview: preview.clone(),
                local_changes_choice: None,
            },
        )
        .unwrap_err();
        assert!(blocked.contains("explicit use_head_only"));
        assert!(!Path::new(&preview.working_copy_path).exists());

        let result = create_for_root(
            &store,
            &TurnCoordinator::default(),
            &container.join("app-data"),
            ManagedWorktreeCreateInput {
                preview,
                local_changes_choice: Some(LocalChangesChoice::UseHeadOnly),
            },
        )
        .unwrap();
        assert!(
            !Path::new(&result.working_copy_path)
                .join("untracked-local.txt")
                .exists()
        );

        remove_managed_worktree(
            &source,
            Path::new(&result.working_copy_path),
            &result.branch_name,
        );
        drop(store);
        let _ = fs::remove_dir_all(container);
    }

    #[test]
    fn changed_head_invalidates_preview_before_reservation_or_git_mutation() {
        let container = std::env::temp_dir().join(format!(
            "farfold-managed-worktree-stale-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&container);
        fs::create_dir_all(container.join("app-data")).unwrap();
        let source = initialize_git_source(&container);
        let store = HostStore::open(container.join("host.sqlite3"));
        let registered = register_source(&store, &source);
        let preview = preview_for_root(
            &store,
            &container.join("app-data"),
            &ManagedWorktreePreviewInput {
                source_working_copy_id: registered.working_copy_id,
                branch_name: "farfold/stale-test".to_string(),
            },
        )
        .unwrap();
        fs::write(source.join("committed.txt"), b"new head").unwrap();
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&source)
                .args(["add", "committed.txt"])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args([
                    "-c",
                    "user.name=Farfold",
                    "-c",
                    "user.email=farfold@example.invalid"
                ])
                .arg("-C")
                .arg(&source)
                .args(["commit", "-m", "change head"])
                .status()
                .unwrap()
                .success()
        );

        let error = create_for_root(
            &store,
            &TurnCoordinator::default(),
            &container.join("app-data"),
            ManagedWorktreeCreateInput {
                preview: preview.clone(),
                local_changes_choice: None,
            },
        )
        .unwrap_err();
        assert!(error.contains("preview is stale"));
        assert!(!Path::new(&preview.working_copy_path).exists());
        assert!(!super::branch_exists(&source, &preview.branch_name).unwrap());
        assert_eq!(
            store.working_copy_snapshot().unwrap().working_copies.len(),
            1
        );

        drop(store);
        let _ = fs::remove_dir_all(container);
    }

    #[test]
    fn failed_creation_preserves_orphan_evidence_only_when_git_assets_exist() {
        let container = std::env::temp_dir().join(format!(
            "farfold-managed-worktree-orphan-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&container);
        fs::create_dir_all(container.join("app-data")).unwrap();
        let source = initialize_git_source(&container);
        let store = HostStore::open(container.join("host.sqlite3"));
        let registered = register_source(&store, &source);
        let preview = preview_for_root(
            &store,
            &container.join("app-data"),
            &ManagedWorktreePreviewInput {
                source_working_copy_id: registered.working_copy_id,
                branch_name: "farfold/orphan-test".to_string(),
            },
        )
        .unwrap();
        super::reserve_managed_worktree(&store, &preview, "clean").unwrap();
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&source)
                .args(["branch", &preview.branch_name, &preview.source_head_oid])
                .status()
                .unwrap()
                .success()
        );

        let error = super::preserve_or_remove_failed_creation(
            &store,
            &preview,
            "simulated failure".to_string(),
        );
        assert_eq!(error, "simulated failure");
        let copies = store.working_copy_snapshot().unwrap();
        let orphan = copies
            .working_copies
            .iter()
            .find(|copy| copy.working_copy_id == preview.working_copy_id)
            .unwrap();
        assert_eq!(orphan.managed_state, Some(ManagedWorktreeState::Orphaned));
        assert_eq!(
            orphan.managed_error_code.as_deref(),
            Some("creation_failed_with_git_assets")
        );

        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&source)
                .args(["branch", "-D", &preview.branch_name])
                .status()
                .unwrap()
                .success()
        );
        drop(store);
        let _ = fs::remove_dir_all(container);
    }

    #[test]
    fn path_observation_does_not_confuse_presence_with_directory_readiness() {
        let root = std::env::temp_dir().join(format!(
            "farfold-working-copy-observation-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let directory = root.join("ready");
        let file = root.join("file");
        let missing = root.join("missing");
        fs::create_dir(&directory).unwrap();
        fs::write(&file, b"not a directory").unwrap();

        assert_eq!(observe_path(&directory), WorkingCopyPathState::Ready);
        assert_eq!(observe_path(&file), WorkingCopyPathState::NotDirectory);
        assert_eq!(observe_path(&missing), WorkingCopyPathState::Missing);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_reports_unbound_copy_and_detects_path_loss() {
        let root = std::env::temp_dir().join(format!(
            "farfold-working-copy-snapshot-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let project = root.join("project");
        fs::create_dir(&project).unwrap();
        let mut database = match HostDatabaseOpen::open(root.join("host.sqlite3")) {
            HostDatabaseOpen::Ready(database) => database,
            HostDatabaseOpen::Recovery(recovery) => panic!("{}", recovery.reason()),
        };
        database
            .connection
            .execute(
                "INSERT INTO projects(
                    project_id, canonical_path, display_name, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["project-1", project.to_string_lossy(), "Project", 1, 1],
            )
            .unwrap();
        database
            .connection
            .execute(
                "INSERT INTO working_copies(
                    working_copy_id, project_id, canonical_path, kind, branch_name,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    "working-copy-1",
                    "project-1",
                    project.to_string_lossy(),
                    "root",
                    "main",
                    1,
                    1
                ],
            )
            .unwrap();

        let ready = snapshot(&mut database).unwrap();
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(ready.working_copies.len(), 1);
        assert_eq!(
            ready.working_copies[0].path_state,
            WorkingCopyPathState::Ready
        );
        assert_eq!(ready.working_copies[0].bound_session_count, 0);
        assert_eq!(ready.working_copies[0].unarchived_session_count, 0);
        assert_eq!(
            ready.working_copies[0].git_status.state,
            WorkingCopyChangeState::NotGit
        );

        fs::remove_dir(&project).unwrap();
        let missing = snapshot(&mut database).unwrap();
        assert_eq!(
            missing.working_copies[0].path_state,
            WorkingCopyPathState::Missing
        );
        assert_eq!(
            missing.working_copies[0].git_status.state,
            WorkingCopyChangeState::Unavailable
        );
        drop(database);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn registration_preview_distinguishes_root_checkout_and_linked_worktree() {
        let root =
            std::env::temp_dir().join(format!("farfold-working-copy-git-{}", std::process::id()));
        let linked = root.with_extension("linked");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&linked);
        fs::create_dir_all(&root).unwrap();
        assert!(
            Command::new("git")
                .arg("init")
                .arg(&root)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args([
                    "-c",
                    "user.name=Farfold",
                    "-c",
                    "user.email=farfold@example.invalid"
                ])
                .arg("-C")
                .arg(&root)
                .args(["commit", "--allow-empty", "-m", "initial"])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["worktree", "add", "-b", "linked-test"])
                .arg(&linked)
                .status()
                .unwrap()
                .success()
        );

        let root_preview = registration_preview(&root).unwrap();
        let linked_preview = registration_preview(&linked).unwrap();
        assert_eq!(
            root_preview.kind,
            crate::host_store::records::WorkingCopyKind::Root
        );
        assert_eq!(
            linked_preview.kind,
            crate::host_store::records::WorkingCopyKind::Worktree
        );
        assert_eq!(root_preview.git_state, WorkingCopyGitState::Git);
        let clean = observe_git_status(&root, WorkingCopyPathState::Ready);
        assert_eq!(clean.state, WorkingCopyChangeState::Clean);
        fs::write(root.join("untracked.txt"), b"new").unwrap();
        let dirty = observe_git_status(&root, WorkingCopyPathState::Ready);
        assert_eq!(dirty.state, WorkingCopyChangeState::Dirty);
        assert_eq!(dirty.untracked_path_count, 1);
        assert_eq!(root_preview.project_id, linked_preview.project_id);
        assert_ne!(root_preview.working_copy_id, linked_preview.working_copy_id);
        assert_eq!(linked_preview.branch_name.as_deref(), Some("linked-test"));

        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&linked)
                .args(["checkout", "--detach"])
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(registration_preview(&linked).unwrap().branch_name, None);

        let _ = fs::remove_dir_all(&linked);
        let _ = fs::remove_dir_all(&root);
    }
}
