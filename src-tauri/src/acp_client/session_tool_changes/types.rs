use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    Inspect,
    AddHttp {
        name: String,
        url: String,
    },
    Remove {
        #[serde(rename = "itemRef")]
        item_ref: String,
    },
}
impl Change {
    pub(super) fn kind(&self) -> &'static str {
        match self {
            Self::Inspect => "inspect",
            Self::AddHttp { .. } => "addHttp",
            Self::Remove { .. } => "remove",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Code {
    Unavailable,
    Changed,
    Busy,
    Timeout,
    InvalidInput,
    InvalidResponse,
    QueryFailed,
    SaveFailed,
    Unknown,
    Limit,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeError {
    pub code: Code,
    pub message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_dispatched: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_saved: Option<bool>,
}
impl ChangeError {
    pub(super) fn before_dispatch(mut self) -> Self {
        self.not_dispatched = Some(true);
        self
    }
    pub(crate) fn with_saved_conversation(mut self, saved: bool) -> Self {
        self.conversation_saved = saved.then_some(true);
        self
    }
}
impl From<Code> for ChangeError {
    fn from(code: Code) -> Self {
        let message = match code {
            Code::Unavailable => "此 Agent 暂不支持在当前对话管理工具",
            Code::Changed => "对话或工具设置已变化，请重新查看",
            Code::Busy => "请先等待当前任务和待处理事项结束",
            Code::Timeout => "尚未开始修改，请稍后重试",
            Code::InvalidInput => "请检查工具名称和 HTTP 地址",
            Code::InvalidResponse => "无法完整核实工具设置，尚未确认修改结果",
            Code::QueryFailed => "无法读取工具设置，请稍后再检查",
            Code::SaveFailed => "无法保存修改状态，尚未确认修改结果",
            Code::Unknown => "工具修改结果尚未确认，请先检查结果，不要重复修改",
            Code::Limit => "当前对话的工具修改次数已达上限",
        };
        Self {
            code,
            message,
            not_dispatched: None,
            conversation_saved: None,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Pending,
    Ready,
    Failed,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Persistence {
    Unreported,
    Confirmed,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Activity {
    Unreported,
    ToolsReported,
    AbsentReported,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub item_ref: String,
    pub name: String,
    pub can_remove: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub kind: &'static str,
    pub operation_id: String,
    pub agent_id: String,
    pub cwd: String,
    pub native_session_id: String,
    pub connection_id: String,
    pub state: State,
    pub settled: bool,
    pub mutation_sent: bool,
    pub conversation_saved: bool,
    pub persistence: Persistence,
    pub activity: Activity,
    pub items: Vec<Item>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ChangeError>,
}
pub type Reply = Result<Operation, ChangeError>;
