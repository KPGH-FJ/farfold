use serde::Serialize;
use serde_json::Value;

pub(super) const INPUT_LIMIT: usize = 16 * 1024 * 1024;
pub(super) const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
pub(super) const RECORD_LIMIT: usize = 4096;
pub(super) const ANCHOR_LIMIT: usize = 512;
pub(super) const TOOL_LIMIT: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Reason {
    Unavailable,
    Changed,
    Invalid,
    Limit,
    Cancelled,
}
pub(super) type Result<T> = std::result::Result<T, Reason>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Anchor {
    pub role: &'static str,
    pub text: String,
}
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Content {
    Text {
        text: String,
    },
    Image {
        #[serde(rename = "mimeType")]
        mime_type: String,
        data: String,
    },
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tool {
    pub tool_call_id: String,
    pub name: String,
    pub arguments: Value,
    pub call_after_anchor: usize,
    pub result_after_anchor: usize,
    pub outcome: &'static str,
    pub content: Vec<Content>,
    pub raw_call: Value,
    pub raw_result: Value,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParsedHistory {
    pub anchors: Vec<Anchor>,
    pub tools: Vec<Tool>,
}
