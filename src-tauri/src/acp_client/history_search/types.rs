use serde::{Deserialize, Serialize};
pub type Result<T> = std::result::Result<T, Failure>;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Code {
    InvalidRequest,
    RequestConflict,
    RequestCapacity,
    Busy,
    Unavailable,
    NotReviewed,
    PlatformUnsupported,
    EntryUnverified,
    EnvironmentUnavailable,
    SelectionChanged,
    IndexChanged,
    NoNativeHistory,
    AlreadyOpen,
    CwdUnavailable,
    Unsupported,
    InvalidOutput,
    QueryFailed,
    OutputLimit,
    ResultLimit,
    TimedOut,
    Cancelled,
    PendingCleanup,
    CoverageUnconfirmed,
    SourceUnconfirmed,
    SourceChanged,
    SourceTooLarge,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: Code,
}
impl From<Code> for Failure {
    fn from(code: Code) -> Self {
        Self { code }
    }
}
impl From<super::super::extension_inventory::Failure> for Failure {
    fn from(value: super::super::extension_inventory::Failure) -> Self {
        use super::super::extension_inventory::Code as C;
        Self::from(match value.code {
            C::Busy => Code::Busy,
            C::Cancelled => Code::Cancelled,
            C::TimedOut => Code::TimedOut,
            C::PendingCleanup => Code::PendingCleanup,
            C::OutputLimit => Code::OutputLimit,
            C::InvalidOutput => Code::InvalidOutput,
            C::PlatformUnsupported => Code::PlatformUnsupported,
            C::EntryUnverified => Code::EntryUnverified,
            C::NotReviewed => Code::NotReviewed,
            C::EnvironmentUnavailable => Code::EnvironmentUnavailable,
            C::CwdUnavailable => Code::CwdUnavailable,
            _ => Code::QueryFailed,
        })
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionRow {
    pub row_id: String,
    pub availability: &'static str,
    pub code: Option<Code>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub agent_id: String,
    pub selection_id: Option<String>,
    pub valid_for_ms: u64,
    pub source: Option<&'static str>,
    #[serde(flatten)]
    pub sdk_scope: Option<SdkScope>,
    pub scope: &'static str,
    pub availability: &'static str,
    pub code: Option<Code>,
    pub rows: Vec<SelectionRow>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub agent_id: String,
    pub request_id: String,
    pub selection_id: String,
    pub query: String,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start: usize,
    pub end: usize,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub row_id: String,
    #[serde(flatten)]
    pub locator: Locator,
    pub role: &'static str,
    pub text: String,
    pub text_truncated: bool,
    pub matches: Vec<Range>,
    pub matches_truncated: bool,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Locator {
    TurnItem {
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "itemId")]
        item_id: String,
        #[serde(rename = "partIndex")]
        part_index: usize,
    },
    Message {
        #[serde(rename = "messageLocator")]
        message_locator: MessageLocator,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageLocator {
    pub kind: String,
    pub message_id: String,
    pub part_index: usize,
}
#[derive(Clone, Debug, Serialize)]
pub struct SdkScope {
    pub coverage: &'static str,
    pub relation: &'static str,
    pub continuation: &'static str,
    pub branch: &'static str,
}
impl SdkScope {
    pub fn partial() -> Self {
        Self {
            coverage: "partial",
            relation: "registeredExactId",
            continuation: "unverified",
            branch: "unverified",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RowState {
    Queued,
    Reading,
    Complete,
    Partial,
    Failed,
    Skipped,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub row_id: String,
    pub state: RowState,
    pub pages_read: usize,
    pub text_blocks_read: usize,
    pub matched_text_blocks: usize,
    pub code: Option<Code>,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Running,
    Cancelling,
    PendingCleanup,
    Completed,
    Cancelled,
    Failed,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOperation {
    pub agent_id: String,
    pub request_id: String,
    pub selection_id: String,
    pub row_ids: Vec<String>,
    pub query: String,
    pub revision: u64,
    pub state: State,
    pub settled: bool,
    pub code: Option<Code>,
    pub source: &'static str,
    #[serde(flatten)]
    pub sdk_scope: Option<SdkScope>,
    pub scope: &'static str,
    pub match_mode: &'static str,
    pub exclusions: [&'static str; 4],
    pub rows: Vec<Row>,
    pub hits: Vec<Hit>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Reply {
    Operation {
        operation: Box<SearchOperation>,
    },
    #[serde(rename_all = "camelCase")]
    Absent {
        agent_id: String,
        request_id: String,
        scope: &'static str,
        admission_closed: bool,
    },
}
pub(super) fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
pub(super) fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control)
}
