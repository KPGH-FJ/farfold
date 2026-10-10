use super::recycle_types::{DraftBaseline, MaterialSummary, RecycleImpact};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recovery {
    pub id: String,
    pub revision: u64,
    pub archive_id: String,
    pub archive_revision: u64,
    pub original_path: String,
    pub retained_path: String,
    pub repository_root: String,
    pub head_oid: String,
    pub branch: Option<String>,
    pub path: String,
    pub bundle_bytes: u64,
    pub bundle_sha256: String,
    pub manifest_sha256: String,
    pub roots_sha256: String,
    pub content_sha256: String,
    pub root_count: u64,
    pub object_count: u64,
    pub object_format: String,
    pub availability: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Removed {
    pub record_id: String,
    pub revision: u64,
    pub original_path: String,
    pub retained_path: String,
    pub recovery_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootsSummary {
    pub count: u64,
    pub sha256: String,
    pub object_format: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveInspection {
    pub inspection_id: String,
    pub action: &'static str,
    pub record_id: String,
    pub revision: u64,
    pub original_path: String,
    pub retained_path: String,
    pub repository_root: String,
    pub head_oid: String,
    pub branch: Option<String>,
    pub blockers: Vec<String>,
    pub impact: RecycleImpact,
    pub draft_baseline: DraftBaseline,
    pub roots: RootsSummary,
    pub content: MaterialSummary,
    pub local_tracking: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveInput {
    pub inspection_id: String,
    pub expected_draft_baseline: DraftBaseline,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveConfirmation {
    pub record_id: String,
    pub expected_revision: u64,
    pub recovery_id: String,
    pub recovery_sha256: String,
    pub manifest_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoverInput {
    pub recovery_id: String,
    pub expected_revision: u64,
    pub parent_path: String,
    pub directory_name: String,
}
