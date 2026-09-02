use super::{HostDatabase, HostStore};
use crate::{
    host_ids::{ProjectId, WorkingCopyId, derived_host_id},
    host_store::records::WorkingCopyKind,
};
use rusqlite::TransactionBehavior;
use serde::Serialize;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::State;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
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
    bound_session_count: u64,
    unarchived_session_count: u64,
    created_at: i64,
    updated_at: i64,
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
}

impl TryFrom<RawWorkingCopyRecord> for WorkingCopyRecord {
    type Error = String;

    fn try_from(raw: RawWorkingCopyRecord) -> Result<Self, Self::Error> {
        Ok(Self {
            working_copy_id: WorkingCopyId::parse(raw.working_copy_id)
                .map_err(|error| error.to_string())?,
            project_id: ProjectId::parse(raw.project_id).map_err(|error| error.to_string())?,
            path_state: observe_path(Path::new(&raw.canonical_path)),
            canonical_path: raw.canonical_path,
            kind: WorkingCopyKind::parse(&raw.kind)?,
            branch_name: raw.branch_name,
            bound_session_count: u64::try_from(raw.bound_session_count)
                .map_err(|_| "Working Copy Session count is invalid".to_string())?,
            unarchived_session_count: u64::try_from(raw.unarchived_session_count)
                .map_err(|_| "Working Copy active Session count is invalid".to_string())?,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
        })
    }
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
    let working_copies = {
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
                    w.updated_at
                 FROM working_copies w
                 LEFT JOIN sessions s
                   ON s.working_copy_id = w.working_copy_id
                  AND s.project_id = w.project_id
                 GROUP BY
                    w.working_copy_id,
                    w.project_id,
                    w.canonical_path,
                    w.kind,
                    w.branch_name,
                    w.created_at,
                    w.updated_at
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
                })
            })
            .map_err(|error| format!("Cannot read Working Copy snapshot: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot decode Working Copy snapshot: {error}"))?
            .into_iter()
            .map(WorkingCopyRecord::try_from)
            .collect::<Result<Vec<_>, _>>()?
    };
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Working Copy snapshot: {error}"))?;
    Ok(WorkingCopySnapshot { working_copies })
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

#[cfg(test)]
mod tests {
    use super::{
        WorkingCopyGitState, WorkingCopyPathState, observe_path, registration_preview, snapshot,
    };
    use crate::host_store::{CURRENT_SCHEMA_VERSION, HostDatabaseOpen};
    use rusqlite::params;
    use std::{fs, process::Command};

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

        fs::remove_dir(&project).unwrap();
        let missing = snapshot(&mut database).unwrap();
        assert_eq!(
            missing.working_copies[0].path_state,
            WorkingCopyPathState::Missing
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
