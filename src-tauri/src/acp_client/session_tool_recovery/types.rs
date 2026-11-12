use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Resolution {
    #[default]
    ConfirmResult,
    AcceptCurrent,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub agent_id: String,
    pub cwd: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub target: Target,
    pub pending: bool,
    pub operation_id: Option<String>,
    pub action: Option<&'static str>,
    /// none | busy | closing | unchanged | applied | changed
    pub outcome: &'static str,
    pub can_confirm: bool,
    pub review_id: Option<String>,
    pub connection_id: Option<String>,
    pub resolution: Option<Resolution>,
    pub configuration: Option<super::review::Configuration>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    pub target: Target,
    pub resolved: bool,
    pub operation_id: String,
    pub review_id: String,
    pub connection_id: String,
    pub requires_reopen: bool,
    pub resolution: Resolution,
}
