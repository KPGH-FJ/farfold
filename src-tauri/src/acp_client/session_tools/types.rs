use serde::Serialize;
use serde_json::Value;

pub(super) const MAX_ITEMS: usize = 256;
const MAX_NAME: usize = 256;
const MAX_DESCRIPTION: usize = 2048;

#[derive(Debug, Clone, Serialize)]
pub struct Capability {
    pub source: &'static str,
    pub scope: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Code {
    Unavailable,
    Changed,
    Busy,
    Timeout,
    InvalidResponse,
    QueryFailed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolsError {
    pub code: Code,
    pub message: &'static str,
}
impl From<Code> for ToolsError {
    fn from(code: Code) -> Self {
        Self {
            code,
            message: match code {
                Code::Unavailable => "当前对话未提供工具报告读取方式",
                Code::Changed => "对话或连接已变化，请重新检查",
                Code::Busy => "当前正在处理其他操作，请稍后读取工具报告",
                Code::Timeout => "工具报告尚未读取完成，请稍后查看",
                Code::InvalidResponse => "未能核对返回的工具报告",
                Code::QueryFailed => "暂时无法读取工具报告",
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    AlwaysAllow,
    AskBefore,
    NeverAllow,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub name: String,
    pub description: Option<String>,
    pub permission: Option<Permission>,
    pub name_truncated: bool,
    pub description_truncated: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// This is receipt/projection time, never the Agent's collection time.
    pub observed_at_ms: u64,
    /// The official implementation may omit failed clients or pages, even on
    /// success. Zero items therefore cannot establish that no tools exist.
    pub completeness: &'static str,
    pub reported_item_count: usize,
    pub items_truncated: bool,
    pub items: Vec<Item>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Pending,
    Ready,
    Failed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub operation_id: String,
    pub agent_id: String,
    pub cwd: String,
    pub native_session_id: String,
    pub connection_id: String,
    pub state: State,
    pub settled: bool,
    pub report: Option<Report>,
    pub error: Option<ToolsError>,
}
pub type Reply = Result<Operation, ToolsError>;

pub(super) fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn bounded(value: &str, limit: usize) -> (String, bool) {
    let mut chars = value.chars();
    let text = chars.by_ref().take(limit).collect();
    (text, chars.next().is_some())
}
pub(super) fn parse(value: &Value) -> Result<Report, ToolsError> {
    let tools = value
        .as_object()
        .and_then(|o| o.get("tools"))
        .and_then(Value::as_array)
        .ok_or(Code::InvalidResponse)?;
    let mut items = Vec::with_capacity(tools.len().min(MAX_ITEMS));
    // This bounds the post-SDK projection, not transport allocation or the
    // provider's completeness. Never serialize schemas or unknown fields.
    for raw in tools.iter().take(MAX_ITEMS) {
        let object = raw.as_object().ok_or(Code::InvalidResponse)?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
            .ok_or(Code::InvalidResponse)?;
        let description = match object.get("description") {
            None | Some(Value::Null) => None,
            Some(Value::String(s))
                if !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t') =>
            {
                Some(s.as_str())
            }
            _ => return Err(Code::InvalidResponse.into()),
        };
        let permission = match object.get("permission") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(match s.as_str() {
                "always_allow" => Permission::AlwaysAllow,
                "ask_before" => Permission::AskBefore,
                "never_allow" => Permission::NeverAllow,
                _ => return Err(Code::InvalidResponse.into()),
            }),
            _ => return Err(Code::InvalidResponse.into()),
        };
        let (name, name_truncated) = bounded(name, MAX_NAME);
        let (description, description_truncated) = match description {
            Some(s) => {
                let (text, truncated) = bounded(s, MAX_DESCRIPTION);
                (Some(text), truncated)
            }
            None => (None, false),
        };
        items.push(Item {
            name,
            description,
            permission,
            name_truncated,
            description_truncated,
        });
    }
    Ok(Report {
        observed_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Code::QueryFailed)?
            .as_millis()
            .try_into()
            .map_err(|_| Code::QueryFailed)?,
        completeness: "unreported",
        reported_item_count: tools.len(),
        items_truncated: tools.len() > MAX_ITEMS,
        items,
    })
}
