//! Public fixed facts. Configuration values and mutation authority stay private.
pub use crate::acp_client::extension_inventory::{Code, Failure, Result, State};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Inspect,
    SetEnabled,
    Recheck,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Queued,
    Starting,
    Reading,
    Writing,
    Checking,
    Cleaning,
    Complete,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Ack {
    None,
    Ok,
    OkOverridden,
    Rejected,
    Unknown,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    NotDispatched,
    Rejected,
    Verified,
    Observed,
    Mismatch,
    Unknown,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub inventory_request_id: String,
    pub item_id: usize,
    pub name: String,
    pub origin: String,
    pub display_path: String,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub kind: &'static str,
    pub config_display_path: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub review_id: String,
    pub agent_id: String,
    pub cwd: String,
    pub target: Target,
    pub requested_enabled: bool,
    pub reported_enabled: bool,
    pub write_scope: Scope,
    pub observed_at_ms: u64,
    pub valid_for_ms: u32,
    pub rules_before: usize,
    pub rules_after: usize,
    pub mutation: &'static str,
    pub preservation: &'static str,
    pub session_applicability: &'static str,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub observed_at_ms: u64,
    pub configuration: &'static str,
    pub skill: &'static str,
    pub reported_enabled: Option<bool>,
    pub session_applicability: &'static str,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeOperation {
    pub agent_id: String,
    pub request_id: String,
    pub action: Action,
    pub cwd: String,
    pub target: Target,
    pub requested_enabled: bool,
    pub operation_id: Option<String>,
    pub state: State,
    pub phase: Phase,
    pub settled: bool,
    pub write_dispatched: bool,
    pub write_ack: Ack,
    pub outcome: Option<Outcome>,
    pub code: Option<Code>,
    pub review: Option<Review>,
    pub observation: Option<Observation>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cancellation {
    pub agent_id: String,
    pub request_id: String,
    pub cancel_requested: bool,
    pub operation: Option<ChangeOperation>,
}
pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis().min(9_007_199_254_740_991) as u64)
        .unwrap_or_default()
}
