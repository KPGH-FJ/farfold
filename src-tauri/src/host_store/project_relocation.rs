use super::{HostDatabase, HostStore, now_millis};
use crate::{
    host_ids::{ProjectId, WorkingCopyId, derived_host_id},
    host_store::records::WorkingCopyKind,
    opencode_acp::OpenCodeAcpRuntime,
    pi_runtime::{self, PiRuntime},
};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
use tauri::State;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSystemIdentity {
    device: String,
    inode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelocatableWorkingCopy {
    working_copy_id: WorkingCopyId,
    source_path: String,
    kind: WorkingCopyKind,
    updated_at: i64,
    file_system_identity: FileSystemIdentity,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRelocationPreview {
    project_id: ProjectId,
    source_path: String,
    project_updated_at: i64,
    project_file_system_identity: FileSystemIdentity,
    working_copies: Vec<RelocatableWorkingCopy>,
    confirmation_token: String,
    previewed_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivateProjectRelocationInput {
    preview: ProjectRelocationPreview,
    replacement_project_path: String,
    expected_confirmation_token: String,
    confirm_project_id: ProjectId,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelocatedWorkingCopy {
    working_copy_id: WorkingCopyId,
    source_path: String,
    replacement_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivatedProjectRelocation {
    project_id: ProjectId,
    source_path: String,
    replacement_project_path: String,
    working_copies: Vec<RelocatedWorkingCopy>,
    activated_at: i64,
}

#[derive(Debug)]
struct StoredProject {
    project_id: ProjectId,
    canonical_path: String,
    updated_at: i64,
}

#[derive(Debug)]
struct StoredWorkingCopy {
    working_copy_id: WorkingCopyId,
    canonical_path: String,
    kind: WorkingCopyKind,
    updated_at: i64,
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("Cannot inspect {label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label} must be a regular non-symlink directory"));
    }
    path.canonicalize()
        .map_err(|error| format!("Cannot resolve {label}: {error}"))
}

fn file_system_identity(path: &Path, label: &str) -> Result<FileSystemIdentity, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Cannot inspect {label} identity: {error}"))?;
    if !metadata.is_dir() {
        return Err(format!("{label} is not a directory"));
    }
    Ok(FileSystemIdentity {
        device: metadata.dev().to_string(),
        inode: metadata.ino().to_string(),
    })
}

fn read_project(
    transaction: &Transaction<'_>,
    project_id: &ProjectId,
) -> Result<(StoredProject, Vec<StoredWorkingCopy>), String> {
    let project = transaction
        .query_row(
            "SELECT project_id, canonical_path, updated_at
             FROM projects WHERE project_id = ?1",
            [project_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read Project relocation source: {error}"))?
        .ok_or_else(|| "Project does not exist".to_string())?;
    let project = StoredProject {
        project_id: ProjectId::parse(project.0).map_err(|error| error.to_string())?,
        canonical_path: project.1,
        updated_at: project.2,
    };
    let working_copies = {
        let mut statement = transaction
            .prepare(
                "SELECT working_copy_id, canonical_path, kind, updated_at
                 FROM working_copies
                 WHERE project_id = ?1
                 ORDER BY working_copy_id ASC",
            )
            .map_err(|error| format!("Cannot prepare Project Working Copy relocation: {error}"))?;
        let rows = statement
            .query_map([project_id.as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|error| format!("Cannot read Project Working Copies: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot decode Project Working Copies: {error}"))?
            .into_iter()
            .map(|row| {
                Ok(StoredWorkingCopy {
                    working_copy_id: WorkingCopyId::parse(row.0)
                        .map_err(|error| error.to_string())?,
                    canonical_path: row.1,
                    kind: WorkingCopyKind::parse(&row.2)?,
                    updated_at: row.3,
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    if working_copies.is_empty() {
        return Err("Project has no Working Copy identity to relocate".to_string());
    }
    Ok((project, working_copies))
}

fn relocation_token(preview: &ProjectRelocationPreview) -> String {
    let mut parts = vec![
        preview.project_id.as_str().to_string(),
        preview.source_path.clone(),
        preview.project_updated_at.to_string(),
        preview.project_file_system_identity.device.clone(),
        preview.project_file_system_identity.inode.clone(),
    ];
    for working_copy in &preview.working_copies {
        parts.extend([
            working_copy.working_copy_id.as_str().to_string(),
            working_copy.source_path.clone(),
            working_copy.kind.as_str().to_string(),
            working_copy.updated_at.to_string(),
            working_copy.file_system_identity.device.clone(),
            working_copy.file_system_identity.inode.clone(),
        ]);
    }
    let references = parts.iter().map(String::as_str).collect::<Vec<_>>();
    derived_host_id("relocate", &references)
}

fn preview(
    database: &mut HostDatabase,
    project_id: ProjectId,
) -> Result<ProjectRelocationPreview, String> {
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Cannot begin Project relocation preview: {error}"))?;
    let (project, working_copies) = read_project(&transaction, &project_id)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish Project relocation preview: {error}"))?;

    let source_path = canonical_directory(Path::new(&project.canonical_path), "Project")?;
    if source_path.to_string_lossy() != project.canonical_path {
        return Err("Stored Project path no longer resolves to its canonical identity".to_string());
    }
    let mut relocatable_working_copies = Vec::with_capacity(working_copies.len());
    for working_copy in working_copies {
        let path = canonical_directory(Path::new(&working_copy.canonical_path), "Working Copy")?;
        if path.to_string_lossy() != working_copy.canonical_path {
            return Err(
                "Stored Working Copy path no longer resolves to its canonical identity".to_string(),
            );
        }
        relocatable_working_copies.push(RelocatableWorkingCopy {
            working_copy_id: working_copy.working_copy_id,
            source_path: working_copy.canonical_path,
            kind: working_copy.kind,
            updated_at: working_copy.updated_at,
            file_system_identity: file_system_identity(&path, "Working Copy")?,
        });
    }
    let mut result = ProjectRelocationPreview {
        project_id: project.project_id,
        source_path: project.canonical_path,
        project_updated_at: project.updated_at,
        project_file_system_identity: file_system_identity(&source_path, "Project")?,
        working_copies: relocatable_working_copies,
        confirmation_token: String::new(),
        previewed_at: now_millis(),
    };
    result.confirmation_token = relocation_token(&result);
    Ok(result)
}

fn replacement_working_copy_path(
    project_source: &Path,
    project_replacement: &Path,
    working_copy_source: &Path,
) -> Result<PathBuf, String> {
    if let Ok(relative) = working_copy_source.strip_prefix(project_source) {
        return Ok(project_replacement.join(relative));
    }
    Ok(working_copy_source.to_path_buf())
}

fn require_stored_preview(
    project: &StoredProject,
    working_copies: &[StoredWorkingCopy],
    preview: &ProjectRelocationPreview,
) -> Result<(), String> {
    if project.project_id != preview.project_id
        || project.canonical_path != preview.source_path
        || project.updated_at != preview.project_updated_at
        || working_copies.len() != preview.working_copies.len()
    {
        return Err("Project relocation preview is stale; preview again".to_string());
    }
    for (stored, expected) in working_copies.iter().zip(&preview.working_copies) {
        if stored.working_copy_id != expected.working_copy_id
            || stored.canonical_path != expected.source_path
            || stored.kind != expected.kind
            || stored.updated_at != expected.updated_at
        {
            return Err(
                "Project relocation Working Copy preview is stale; preview again".to_string(),
            );
        }
    }
    Ok(())
}

fn activate(
    database: &mut HostDatabase,
    input: ActivateProjectRelocationInput,
) -> Result<ActivatedProjectRelocation, String> {
    if input.preview.project_id != input.confirm_project_id {
        return Err(
            "Project relocation confirmation does not match the requested Project".to_string(),
        );
    }
    if input.expected_confirmation_token != input.preview.confirmation_token
        || relocation_token(&input.preview) != input.preview.confirmation_token
    {
        return Err("Project relocation preview confirmation is invalid".to_string());
    }
    let replacement = canonical_directory(
        Path::new(&input.replacement_project_path),
        "replacement Project",
    )?;
    let replacement_text = replacement.to_string_lossy().into_owned();
    if replacement_text == input.preview.source_path {
        return Err("Replacement Project path is unchanged".to_string());
    }
    if file_system_identity(&replacement, "replacement Project")?
        != input.preview.project_file_system_identity
    {
        return Err("Replacement Project is not the same filesystem directory".to_string());
    }

    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot begin Project relocation: {error}"))?;
    let (project, working_copies) = read_project(&transaction, &input.preview.project_id)?;
    require_stored_preview(&project, &working_copies, &input.preview)?;
    let source_project_path = Path::new(&input.preview.source_path);
    let mut relocated = Vec::with_capacity(working_copies.len());
    for (stored, expected) in working_copies.iter().zip(&input.preview.working_copies) {
        let target = replacement_working_copy_path(
            source_project_path,
            &replacement,
            Path::new(&stored.canonical_path),
        )?;
        let target = canonical_directory(&target, "replacement Working Copy")?;
        if file_system_identity(&target, "replacement Working Copy")?
            != expected.file_system_identity
        {
            return Err(format!(
                "Replacement Working Copy {} is not the same filesystem directory",
                stored.working_copy_id
            ));
        }
        relocated.push(RelocatedWorkingCopy {
            working_copy_id: stored.working_copy_id.clone(),
            source_path: stored.canonical_path.clone(),
            replacement_path: target.to_string_lossy().into_owned(),
        });
    }
    let activated_at = now_millis();
    let project_updates = transaction
        .execute(
            "UPDATE projects SET canonical_path = ?1, updated_at = MAX(updated_at, ?2)
             WHERE project_id = ?3",
            params![
                replacement_text,
                activated_at,
                input.preview.project_id.as_str()
            ],
        )
        .map_err(|error| format!("Cannot update relocated Project: {error}"))?;
    if project_updates != 1 {
        return Err("Project changed during relocation".to_string());
    }
    for working_copy in &relocated {
        let working_copy_updates = transaction
            .execute(
                "UPDATE working_copies
                 SET canonical_path = ?1, updated_at = MAX(updated_at, ?2)
                 WHERE working_copy_id = ?3 AND project_id = ?4",
                params![
                    working_copy.replacement_path,
                    activated_at,
                    working_copy.working_copy_id.as_str(),
                    input.preview.project_id.as_str()
                ],
            )
            .map_err(|error| format!("Cannot update relocated Working Copy: {error}"))?;
        if working_copy_updates != 1 {
            return Err("Working Copy changed during Project relocation".to_string());
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Project relocation: {error}"))?;
    Ok(ActivatedProjectRelocation {
        project_id: input.preview.project_id,
        source_path: input.preview.source_path,
        replacement_project_path: replacement_text,
        working_copies: relocated,
        activated_at,
    })
}

impl HostStore {
    pub fn project_relocation_preview(
        &self,
        project_id: ProjectId,
    ) -> Result<ProjectRelocationPreview, String> {
        self.with_ready_database(|database| preview(database, project_id))
    }
}

#[tauri::command]
pub fn project_relocation_preview(
    store: State<'_, HostStore>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeAcpRuntime>,
    project_id: ProjectId,
) -> Result<ProjectRelocationPreview, String> {
    pi_runtime::with_stopped(&pi, || {
        opencode.with_stopped(|| store.project_relocation_preview(project_id))
    })
}

#[tauri::command]
pub fn project_relocation_activate(
    store: State<'_, HostStore>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeAcpRuntime>,
    input: ActivateProjectRelocationInput,
) -> Result<ActivatedProjectRelocation, String> {
    pi_runtime::with_stopped(&pi, || {
        opencode.with_stopped(|| {
            store.with_ready_database(|database| activate(database, input))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{ActivateProjectRelocationInput, activate, preview};
    use crate::{
        host_ids::ProjectId,
        host_store::{HostDatabase, HostDatabaseOpen},
    };
    use rusqlite::params;
    use std::fs;

    fn ready(opened: HostDatabaseOpen) -> HostDatabase {
        match opened {
            HostDatabaseOpen::Ready(database) => database,
            HostDatabaseOpen::Recovery(recovery) => panic!("{}", recovery.reason()),
        }
    }

    #[test]
    fn relocation_preserves_ids_and_requires_the_same_filesystem_objects() {
        let root =
            std::env::temp_dir().join(format!("farfold-project-relocation-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("before");
        let replacement = root.join("after");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("sentinel"), "preserved").unwrap();
        let source = source.canonicalize().unwrap();
        let mut database = ready(HostDatabaseOpen::open(root.join("host.sqlite3")));
        database
            .connection
            .execute(
                "INSERT INTO projects VALUES ('project-1', ?1, 'Project', 1, 1)",
                params![source.to_string_lossy().as_ref()],
            )
            .unwrap();
        database
            .connection
            .execute(
                "INSERT INTO working_copies VALUES
                    ('working-copy-1', 'project-1', ?1, 'root', NULL, 1, 1)",
                params![source.to_string_lossy().as_ref()],
            )
            .unwrap();
        let project_id = ProjectId::parse("project-1").unwrap();
        let prepared = preview(&mut database, project_id.clone()).unwrap();
        fs::rename(&source, &replacement).unwrap();
        let replacement_canonical = replacement.canonicalize().unwrap();
        database
            .connection
            .execute(
                "UPDATE projects SET updated_at = 2 WHERE project_id = 'project-1'",
                [],
            )
            .unwrap();
        let stale = activate(
            &mut database,
            ActivateProjectRelocationInput {
                preview: prepared.clone(),
                replacement_project_path: replacement.to_string_lossy().into_owned(),
                expected_confirmation_token: prepared.confirmation_token.clone(),
                confirm_project_id: project_id.clone(),
            },
        )
        .unwrap_err();
        assert!(stale.contains("stale"));
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT canonical_path FROM projects WHERE project_id = 'project-1'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            source.to_string_lossy()
        );
        database
            .connection
            .execute(
                "UPDATE projects SET updated_at = 1 WHERE project_id = 'project-1'",
                [],
            )
            .unwrap();
        let activated = activate(
            &mut database,
            ActivateProjectRelocationInput {
                preview: prepared.clone(),
                replacement_project_path: replacement.to_string_lossy().into_owned(),
                expected_confirmation_token: prepared.confirmation_token.clone(),
                confirm_project_id: project_id,
            },
        )
        .unwrap();
        assert_eq!(activated.project_id.as_str(), "project-1");
        assert_eq!(
            activated.working_copies[0].working_copy_id.as_str(),
            "working-copy-1"
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT canonical_path FROM projects WHERE project_id = 'project-1'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            replacement_canonical.to_string_lossy()
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT canonical_path FROM working_copies
                     WHERE working_copy_id = 'working-copy-1'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            replacement_canonical.to_string_lossy()
        );
        assert_eq!(
            fs::read_to_string(replacement.join("sentinel")).unwrap(),
            "preserved"
        );

        let different = root.join("different");
        fs::create_dir(&different).unwrap();
        let error = activate(
            &mut database,
            ActivateProjectRelocationInput {
                preview: prepared.clone(),
                replacement_project_path: different.to_string_lossy().into_owned(),
                expected_confirmation_token: prepared.confirmation_token.clone(),
                confirm_project_id: prepared.project_id,
            },
        )
        .unwrap_err();
        assert!(error.contains("same filesystem directory") || error.contains("stale"));
        drop(database);
        let _ = fs::remove_dir_all(root);
    }
}
