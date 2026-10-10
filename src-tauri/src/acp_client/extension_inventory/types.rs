//! Only typed, redacted query facts may leave the one-shot worker.
use serde::Serialize;

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
    pub skills_inventory: &'static str,
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
    pub state: State,
    pub settled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<Code>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<McpInventory>,
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
