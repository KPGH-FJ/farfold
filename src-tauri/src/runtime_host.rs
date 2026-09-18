use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectResource {
    kind: String,
    entries: usize,
    sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReadiness {
    project_path: String,
    context_files: Vec<String>,
    protected_resources: Vec<ProjectResource>,
}

fn project_source(depth: usize, name: &str) -> String {
    format!("{}{}", "../".repeat(depth), name)
}

fn count_directory_entries(path: &Path, directories_only: bool) -> usize {
    std::fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| !directories_only || kind.is_dir())
                .unwrap_or(false)
        })
        .count()
}

fn project_readiness(path: &Path) -> Result<ProjectReadiness, String> {
    let project = path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Project: {error}"))?;
    if !project.is_dir() {
        return Err(format!("Project is not a directory: {}", project.display()));
    }

    let mut context_files = Vec::new();
    let mut agent_skill_sources = Vec::new();
    let mut agent_skill_entries = 0;
    for (depth, directory) in project.ancestors().enumerate() {
        if directory.join("AGENTS.override.md").is_file() {
            context_files.push(project_source(depth, "AGENTS.override.md"));
        } else {
            for name in ["AGENTS.md", "CLAUDE.md"] {
                if directory.join(name).is_file() {
                    context_files.push(project_source(depth, name));
                }
            }
        }

        let agent_skills = directory.join(".agents/skills");
        if agent_skills.is_dir() {
            agent_skill_entries += count_directory_entries(&agent_skills, true);
            agent_skill_sources.push(project_source(depth, ".agents/skills"));
        }
    }
    context_files.reverse();

    let mut protected_resources = Vec::new();
    for (kind, name, directories_only) in [
        ("settings", ".pi/settings.json", false),
        ("skill", ".pi/skills", true),
        ("extension", ".pi/extensions", false),
        ("prompt", ".pi/prompts", false),
        ("theme", ".pi/themes", false),
        ("system", ".pi/SYSTEM.md", false),
        ("append-system", ".pi/APPEND_SYSTEM.md", false),
    ] {
        let candidate = project.join(name);
        let entries = if candidate.is_file() {
            Some(1)
        } else if candidate.is_dir() {
            Some(count_directory_entries(&candidate, directories_only))
        } else {
            None
        };
        if let Some(entries) = entries {
            protected_resources.push(ProjectResource {
                kind: kind.to_string(),
                entries,
                sources: vec![name.to_string()],
            });
        }
    }
    if !agent_skill_sources.is_empty() {
        protected_resources.push(ProjectResource {
            kind: "agent-skill".to_string(),
            entries: agent_skill_entries,
            sources: agent_skill_sources,
        });
    }
    Ok(ProjectReadiness {
        project_path: project.to_string_lossy().into_owned(),
        context_files,
        protected_resources,
    })
}

#[tauri::command]
pub fn runtime_project_readiness(project_path: String) -> Result<ProjectReadiness, String> {
    project_readiness(Path::new(&project_path))
}
