//! Transient, fixed-name metadata observations; never environment readiness.
use super::types::Location;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreparationRole {
    Manifest,
    Lock,
    DependencyDirectory,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreparationNodeKind {
    Missing,
    File,
    Directory,
    Symlink,
    Other,
    Unreadable,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationFact {
    pub name: &'static str,
    pub role: PreparationRole,
    pub node_kind: PreparationNodeKind,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationGit {
    pub kind: &'static str,
    pub other_worktree_count: usize,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationCoverage {
    pub scope: &'static str,
    pub checked_names: usize,
    pub complete: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationInspection {
    pub inspection_id: String,
    pub location: Location,
    pub project_relative_path: String,
    pub project_path: String,
    pub observed_at_ms: u64,
    pub git: PreparationGit,
    pub facts: Vec<PreparationFact>,
    pub coverage: PreparationCoverage,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationValidation {
    pub inspection_id: String,
    pub valid: bool,
}

pub(super) const FIXED_NAMES: [(&str, PreparationRole); 22] = [
    ("package.json", PreparationRole::Manifest),
    ("pyproject.toml", PreparationRole::Manifest),
    ("requirements.txt", PreparationRole::Manifest),
    ("Pipfile", PreparationRole::Manifest),
    ("Cargo.toml", PreparationRole::Manifest),
    ("go.mod", PreparationRole::Manifest),
    ("package-lock.json", PreparationRole::Lock),
    ("npm-shrinkwrap.json", PreparationRole::Lock),
    ("pnpm-lock.yaml", PreparationRole::Lock),
    ("yarn.lock", PreparationRole::Lock),
    ("bun.lock", PreparationRole::Lock),
    ("bun.lockb", PreparationRole::Lock),
    ("uv.lock", PreparationRole::Lock),
    ("poetry.lock", PreparationRole::Lock),
    ("Pipfile.lock", PreparationRole::Lock),
    ("Cargo.lock", PreparationRole::Lock),
    ("go.sum", PreparationRole::Lock),
    ("node_modules", PreparationRole::DependencyDirectory),
    (".venv", PreparationRole::DependencyDirectory),
    ("venv", PreparationRole::DependencyDirectory),
    ("target", PreparationRole::DependencyDirectory),
    ("vendor", PreparationRole::DependencyDirectory),
];
