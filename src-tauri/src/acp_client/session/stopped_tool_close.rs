use super::*;
use crate::acp_client::pump::{SessionMap, StoppedToolCloseReceipt, UnconfirmedStopCloseReceipt};

struct StoppedCloseRoute {
    control: mpsc::UnboundedSender<SessionControl>,
    sessions: SessionMap,
}

impl AcpManager {
    fn stopped_close_control(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        require_reload: bool,
    ) -> Result<Option<StoppedCloseRoute>, String> {
        let connection = self.session_connection(agent_id, cwd, session_id)?;
        if connection.connection_id != connection_id {
            return Err("连接已变化，请重新打开对话".into());
        }
        if !connection.handshake.get().is_some_and(|handshake| {
            let capabilities = &handshake.typed.agent_capabilities;
            (!require_reload || capabilities.load_session)
                && capabilities.session_capabilities.close.is_some()
        }) {
            return Ok(None);
        }
        let sessions = connection.sessions.lock().map_err(|_| "无法读取对话状态")?;
        Ok(sessions
            .get(session_id)
            .filter(|entry| {
                entry.connection_is(connection_id)
                    && entry.preview_token.is_none()
                    && entry.purpose == super::super::open_purpose::OpenPurpose::Conversation
            })
            .map(|entry| StoppedCloseRoute {
                control: entry.control.clone(),
                sessions: connection.sessions.clone(),
            }))
    }

    pub(crate) async fn check_unapproved_stopped_close(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
    ) -> Result<Option<StoppedToolCloseReceipt>, String> {
        let Some(route) =
            self.stopped_close_control(agent_id, cwd, session_id, connection_id, false)?
        else {
            return Ok(None);
        };
        let timeout = std::time::Duration::from_secs(5);
        let (result, receive) = oneshot::channel();
        route
            .control
            .send(SessionControl::CheckUnapprovedStoppedClose {
                result,
                deadline: tokio::time::Instant::now() + timeout,
            })
            .map_err(|_| "对话连接已结束，请重新打开")?;
        super::super::wait::reply(receive, timeout, "stopped tool close check").await?
    }

    pub(crate) async fn close_unapproved_stopped(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        tool_call_id: String,
        proof_id: String,
    ) -> Result<StoppedToolCloseReceipt, String> {
        let route = self
            .stopped_close_control(agent_id, cwd, session_id, connection_id, false)?
            .ok_or("当前无法确认关闭，请等待步骤结果")?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        let (result, receive) = oneshot::channel();
        route
            .control
            .send(SessionControl::CloseUnapprovedStopped {
                tool_call_id,
                proof_id,
                result,
                deadline,
            })
            .map_err(|_| "对话连接已结束，请重新打开")?;
        let Ok(Ok(receipt)) = tokio::time::timeout_at(deadline, receive).await else {
            return Err("关闭结果尚未确认，请等待".into());
        };
        let receipt = receipt?;
        // The pump delivers its receipt under this lock before releasing the route and work.
        drop(
            route
                .sessions
                .lock()
                .map_err(|_| "关闭结果尚未确认，请等待")?,
        );
        Ok(receipt)
    }

    pub(crate) async fn check_unconfirmed_stop_close(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
    ) -> Result<Option<UnconfirmedStopCloseReceipt>, String> {
        let Some(route) =
            self.stopped_close_control(agent_id, cwd, session_id, connection_id, true)?
        else {
            return Ok(None);
        };
        let timeout = std::time::Duration::from_secs(5);
        let (result, receive) = oneshot::channel();
        route
            .control
            .send(SessionControl::CheckUnconfirmedStopClose {
                result,
                deadline: tokio::time::Instant::now() + timeout,
            })
            .map_err(|_| "对话连接已结束，请重新打开")?;
        super::super::wait::reply(receive, timeout, "unconfirmed stop close check").await?
    }

    pub(crate) async fn close_unconfirmed_stop(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        proof_id: String,
    ) -> Result<UnconfirmedStopCloseReceipt, String> {
        let route = self
            .stopped_close_control(agent_id, cwd, session_id, connection_id, true)?
            .ok_or("当前无法确认关闭，请等待原请求的结果")?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        let (result, receive) = oneshot::channel();
        route
            .control
            .send(SessionControl::CloseUnconfirmedStop {
                proof_id,
                result,
                deadline,
            })
            .map_err(|_| "对话连接已结束，请重新打开")?;
        let Ok(Ok(receipt)) = tokio::time::timeout_at(deadline, receive).await else {
            return Err("关闭结果尚未确认，请等待".into());
        };
        let receipt = receipt?;
        // Observe release after the pump's commit under the same owner lock.
        drop(
            route
                .sessions
                .lock()
                .map_err(|_| "关闭结果尚未确认，请等待")?,
        );
        Ok(receipt)
    }
}
