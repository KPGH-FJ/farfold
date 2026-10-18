//! Whitelisted facts only. CLI output and authority remain private in RAM.
pub use crate::acp_client::extension_inventory::{Code, Failure, Result, State};
pub use crate::acp_client::skill_management::{Ack, Outcome, Phase};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Inventory,
    Inspect,
    Install,
    Remove,
    Recheck,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Availability {
    pub availability: &'static str,
    pub reason: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginItem {
    pub id: usize,
    pub name: Option<String>,
    pub marketplace_name: Option<String>,
    pub version: Option<String>,
    pub reported_installed: bool,
    pub reported_enabled: bool,
    pub source: &'static str,
    pub install_policy: &'static str,
    pub auth_policy: &'static str,
    pub install: Availability,
    pub remove: Availability,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalog {
    pub observed_at_ms: u64,
    pub scope: &'static str,
    pub source: &'static str,
    pub complete: bool,
    pub session_applicability: &'static str,
    pub items: Vec<PluginItem>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReview {
    pub review_id: String,
    pub agent_id: String,
    pub cwd: String,
    pub target: PluginItem,
    pub install: bool,
    pub observed_at_ms: u64,
    pub valid_for_ms: u32,
    pub scope: &'static str,
    pub session_applicability: &'static str,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginObservation {
    pub observed_at_ms: u64,
    pub reported_installed: bool,
    pub reported_enabled: bool,
    pub session_applicability: &'static str,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOperation {
    pub agent_id: String,
    pub request_id: String,
    pub cwd: String,
    pub action: Action,
    pub state: State,
    pub phase: Phase,
    pub settled: bool,
    pub code: Option<Code>,
    pub write_dispatched: bool,
    pub write_ack: Ack,
    pub outcome: Option<Outcome>,
    pub catalog: Option<PluginCatalog>,
    pub review: Option<PluginReview>,
    pub observation: Option<PluginObservation>,
    pub target: Option<PluginItem>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cancellation {
    pub agent_id: String,
    pub request_id: String,
    pub cancel_requested: bool,
    pub operation: Option<PluginOperation>,
}
pub(super) const SCOPE: &str = "officialSharedPluginConfiguration";
pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis().min(9_007_199_254_740_991) as u64)
        .unwrap_or_default()
}
