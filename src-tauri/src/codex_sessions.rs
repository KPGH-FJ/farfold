//! Codex 0.143.0 native thread identity and history. The Host binds thread.id,
//! never the live tree's sessionId or the unstable rollout path.
use crate::host_ids::{NativeSessionId, NativeTurnId};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeTurn {
    pub id: NativeTurnId,
    pub items: Vec<Value>,
    pub status: String,
    #[serde(flatten)]
    pub native_fields: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeThread {
    pub id: NativeSessionId,
    pub session_id: String,
    pub cwd: PathBuf,
    pub cli_version: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub model_provider: String,
    pub ephemeral: bool,
    pub preview: String,
    pub source: Value,
    pub status: Value,
    pub turns: Vec<NativeTurn>,
    pub name: Option<String>,
    #[serde(flatten)]
    pub native_fields: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSession {
    pub thread: NativeThread,
    pub model: String,
    pub model_provider: String,
    pub reasoning_effort: Option<String>,
    pub cwd: PathBuf,
    pub approval_policy: Value,
    pub approvals_reviewer: Value,
    pub sandbox: Value,
    #[serde(flatten)]
    pub native_fields: Map<String, Value>,
}

impl NativeThread {
    pub(crate) fn verify(
        &self,
        cwd: &Path,
        expected_id: Option<&NativeSessionId>,
    ) -> Result<(), String> {
        NativeSessionId::parse(self.id.as_str()).map_err(|_| "Codex 原生线程身份无效")?;
        NativeSessionId::parse(&self.session_id).map_err(|_| "Codex 原生会话树身份无效")?;
        if expected_id.is_some_and(|id| id != &self.id)
            || self.cwd != cwd
            || self.cwd.canonicalize().ok().as_deref() != Some(cwd)
        {
            return Err("Codex 原生线程身份或工作目录与 Host 绑定不一致".into());
        }
        if self.ephemeral
            || self.cli_version != "0.143.0"
            || self.created_at < 0
            || self.updated_at < self.created_at
        {
            return Err("Codex 返回了临时线程、不兼容版本或无效原生时间".into());
        }
        self.created_at
            .checked_mul(1000)
            .ok_or("Codex 原生时间超出范围")?;
        self.updated_at
            .checked_mul(1000)
            .ok_or("Codex 原生时间超出范围")?;
        let mut ids = std::collections::HashSet::new();
        for turn in &self.turns {
            NativeTurnId::parse(turn.id.as_str()).map_err(|_| "Codex 原生轮次身份无效")?;
            if !ids.insert(&turn.id) {
                return Err("Codex 历史包含重复轮次身份".into());
            }
            if turn
                .native_fields
                .get("itemsView")
                .is_some_and(|v| v != "full")
            {
                return Err("Codex 返回了不完整历史；不能显示为完整恢复".into());
            }
        }
        Ok(())
    }
}

pub(crate) fn read_session(
    value: Value,
    cwd: &Path,
    expected_id: Option<&NativeSessionId>,
) -> Result<NativeSession, String> {
    let session: NativeSession =
        serde_json::from_value(value).map_err(|_| "Codex 原生会话响应与固定协议不符")?;
    session.thread.verify(cwd, expected_id)?;
    if session.cwd != cwd
        || session.model.trim().is_empty()
        || session.model_provider != session.thread.model_provider
    {
        return Err("Codex 会话配置与原生线程不一致".into());
    }
    // Honor policy restrictions instead of manufacturing the requested permissions.
    if session.approval_policy != "on-request"
        || session.approvals_reviewer != "user"
        || !matches!(
            session.sandbox["type"].as_str(),
            Some("workspaceWrite" | "readOnly")
        )
    {
        return Err("Codex 未建立当前支持的用户审批与受限工作目录配置".into());
    }
    if session.thread.status["type"] != "idle" {
        return Err("Codex 线程未处于可继续状态；未创建替代线程".into());
    }
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn native_resume_checks_thread_id_directory_policy_and_complete_history() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().canonicalize().unwrap();
        let native = NativeSessionId::parse("thread-exact").unwrap();
        let value = json!({"thread":{"id":"thread-exact","sessionId":"tree-distinct","cwd":cwd,"cliVersion":"0.143.0","createdAt":1,"updatedAt":2,"ephemeral":false,"modelProvider":"openai","preview":"native","source":"appServer","status":{"type":"idle"},"turns":[{"id":"turn-1","items":[{"type":"futureItem","id":"item-1","opaque":true}],"status":"completed"}]},"model":"native-model","modelProvider":"openai","reasoningEffort":"native-effort","cwd":cwd,"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"}});
        let session = read_session(value.clone(), &cwd, Some(&native)).unwrap();
        assert_eq!(session.thread.id, native);
        assert_eq!(session.thread.session_id, "tree-distinct");
        assert_eq!(session.thread.turns[0].items[0]["opaque"], true);
        for (pointer, replacement) in [
            ("/thread/id", json!("other")),
            ("/thread/cwd", json!("/different")),
            ("/thread/cliVersion", json!("0.144.0")),
            ("/sandbox/type", json!("dangerFullAccess")),
            ("/thread/ephemeral", json!(true)),
            ("/thread/status/type", json!("active")),
        ] {
            let mut wrong = value.clone();
            *wrong.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                read_session(wrong, &cwd, Some(&native)).is_err(),
                "{pointer}"
            );
        }
        let mut partial = value;
        partial["thread"]["turns"][0]["itemsView"] = json!("summary");
        assert!(read_session(partial, &cwd, Some(&native)).is_err());
    }
}
