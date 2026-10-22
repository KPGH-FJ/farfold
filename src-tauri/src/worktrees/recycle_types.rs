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
// A default-data observation is not an independent Windows recovery profile.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum MaterialProfile {
    #[serde(rename = "windowsDefaultDataV1")]
    WindowsDefaultDataV1,
    #[serde(rename = "windowsDefaultDataEaV1")]
    WindowsDefaultDataEaV1,
    #[serde(rename = "windowsDefaultDataEaStreamsV1")]
    WindowsDefaultDataEaStreamsV1,
    // Partial owner/group/DACL only; SACL and restoration are not observed.
    #[serde(rename = "windowsDefaultDataEaStreamsOwnerGroupDaclV1")]
    WindowsDefaultDataEaStreamsOwnerGroupDaclV1,
    // Observed complete in-tree name membership is not a restore/snapshot proof.
    #[serde(rename = "windowsDefaultDataEaStreamsOwnerGroupDaclLinksV1")]
    WindowsDefaultDataEaStreamsOwnerGroupDaclLinksV1,
    // Stored mandatory label only; audit/full SACL and restore remain unknown.
    #[serde(rename = "windowsDefaultDataEaStreamsOwnerGroupDaclLinksLabelV1")]
    WindowsDefaultDataEaStreamsOwnerGroupDaclLinksLabelV1,
    // Full requested descriptor facet, still not full material or restoration.
    #[serde(rename = "windowsDefaultDataEaStreamsLinksFullSecurityV1")]
    WindowsDefaultDataEaStreamsLinksFullSecurityV1,
    // Complete retained FFMTREE1 bytes plus the single v2 manifest catalog.
    // Unlike the observations above, bytes/hash describe the whole carrier.
    #[serde(rename = "windowsRetainedTreeV1")]
    WindowsRetainedTreeV1,
}
// Missing is the historical Unix representation; an explicit null is not
// silently downgraded to that representation.
fn material_profile<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<MaterialProfile>, D::Error> {
    MaterialProfile::deserialize(d).map(Some)
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialSummary {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "material_profile"
    )]
    pub profile: Option<MaterialProfile>,
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
