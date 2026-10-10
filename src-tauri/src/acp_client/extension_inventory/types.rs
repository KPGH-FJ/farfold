//! Only typed, redacted query facts may leave the one-shot worker.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Code {
    NotReviewed,
    EntryUnverified,
    PlatformUnsupported,
    EnvironmentUnavailable,
    SelectionChanged,
    CwdUnavailable,
    Busy,
    SpawnFailed,
    QueryFailed,
    InvalidOutput,
    OutputLimit,
    TimedOut,
    Cancelled,
    PendingCleanup,
    UnknownRequest,
    InvalidRequest,
    RequestConflict,
    Unavailable,
    TargetUnavailable,
    TargetChanged,
    TargetEnabled,
    InventoryIncomplete,
    ReviewExpired,
    ReviewConsumed,
    ConfigurationUnsupported,
    ConfigurationChanged,
    ConfigurationReadOnly,
    ConfigurationRejected,
    WriteUncertain,
    NameConflict,
    InvalidName,
    InvalidExecutablePath,
    InvalidArguments,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct Failure {
    pub code: Code,
}
impl From<Code> for Failure {
    fn from(code: Code) -> Self {
        Self { code }
    }
}
pub type Result<T> = std::result::Result<T, Failure>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCapability {
    pub availability: &'static str,
    pub source: Option<&'static str>,
    pub reason: Option<Code>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCapabilities {
    pub selection_id: Option<String>,
    pub mcp_inventory: InventoryCapability,
    pub skills_inventory: InventoryCapability,
    pub skill_enablement: InventoryCapability,
    pub mcp_enablement: InventoryCapability,
    pub mcp_addition: InventoryCapability,
    pub mcp_removal: InventoryCapability,
    pub tool_inventory: &'static str,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Running,
    Cancelling,
    PendingCleanup,
    Ready,
    Failed,
    Cancelled,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryOperation {
    pub request_id: String,
    pub agent_id: String,
    pub cwd: String,
    pub kind: Kind,
    pub state: State,
    pub settled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<Code>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<InventorySnapshot>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cancellation {
    pub request_id: String,
    pub agent_id: String,
    pub cancel_requested: bool,
    pub operation: Option<InventoryOperation>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInventory {
    pub observed_at_ms: u64,
    pub scope: &'static str,
    pub source: &'static str,
    pub complete: bool,
    pub session_applicability: &'static str,
    pub items: Vec<McpInventoryItem>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInventoryItem {
    pub enablement: SkillEnablement,
    pub id: usize,
    pub name: Option<String>,
    pub transport: &'static str,
    pub reported_enabled: bool,
    pub reported_auth: &'static str,
    pub origin: &'static str,
    pub configuration_layer: &'static str,
    pub connection: &'static str,
    pub tools: &'static str,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Mcp,
    Skills,
}
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum InventorySnapshot {
    Mcp(McpInventory),
    Skills(SkillsInventory),
}
impl From<McpInventory> for InventorySnapshot {
    fn from(value: McpInventory) -> Self {
        Self::Mcp(value)
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsInventory {
    pub observed_at_ms: u64,
    pub scope: &'static str,
    pub source: &'static str,
    pub complete: bool,
    pub session_applicability: &'static str,
    pub error_count: usize,
    pub items: Vec<SkillInventoryItem>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInventoryItem {
    pub id: usize,
    pub name: Option<String>,
    pub description: Option<String>,
    pub description_truncated: bool,
    pub description_redacted: bool,
    pub reported_enabled: bool,
    pub origin: &'static str,
    pub plugin_reported: bool,
    pub enablement: SkillEnablement,
}
#[derive(Clone, Debug, Serialize)]
pub struct SkillEnablement {
    pub availability: &'static str,
    pub reason: Option<&'static str>,
}
