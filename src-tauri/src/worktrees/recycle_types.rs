use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecycleAction {
    Archive,
    Restore,
}
impl RecycleAction {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Archive => "archive",
            Self::Restore => "restore",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Archive {
    pub id: String,
    pub revision: u64,
    pub original_path: String,
    pub retained_path: String,
    pub repository_root: String,
    pub branch: Option<String>,
    pub head_oid: String,
    pub ownership: String,
    pub availability: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftBaseline {
    pub unsent_work: Option<String>,
    pub agent_setup: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecycleInput {
    pub inspection_id: String,
    pub action: RecycleAction,
    pub expected_draft_baseline: DraftBaseline,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialSummary {
    pub entries: u64,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleImpact {
    pub conversations: usize,
    pub unsent: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleInspection {
    pub inspection_id: String,
    pub action: RecycleAction,
    pub record_id: String,
    pub revision: u64,
    pub original_path: String,
    pub retained_path: String,
    pub repository_root: String,
    pub head_oid: String,
    pub branch: Option<String>,
    pub blockers: Vec<String>,
    pub impact: RecycleImpact,
    pub material: MaterialSummary,
    pub draft_baseline: DraftBaseline,
}
