use super::*;
use crate::acp_client::{lifecycle::ConnectionLife, pump::FailedWorkCloseReceipt};
use std::time::Duration;

struct FailedWorkOwner {
    control: mpsc::UnboundedSender<SessionControl>,
    life: Arc<ConnectionLife>,
}

impl AcpManager {
    fn failed_work_owner(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
    ) -> Result<FailedWorkOwner, String> {
        let connection = self.session_connection(agent_id, cwd, session_id)?;
        if connection.connection_id != connection_id {
            return Err("连接已变化，请重新打开对话".into());
        }
        let sessions = connection.sessions.lock().map_err(|_| "无法读取对话状态")?;
        let entry = sessions
            .get(session_id)
            .filter(|entry| {
                entry.connection_is(connection_id)
                    && entry.preview_token.is_none()
                    && entry.purpose == super::super::open_purpose::OpenPurpose::Conversation
            })
            .ok_or("对话连接已结束，请重新打开")?;
        Ok(FailedWorkOwner {
            control: entry.control.clone(),
            life: connection.life,
        })
    }

    pub(crate) async fn prepare_failed_work_close(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
    ) -> Result<Option<FailedWorkCloseReceipt>, String> {
        let owner = self.failed_work_owner(agent_id, cwd, session_id, connection_id)?;
        let timeout = Duration::from_secs(5);
        let (result, receive) = oneshot::channel();
        owner
            .control
            .send(SessionControl::CheckFailedWorkClose {
                result,
                deadline: tokio::time::Instant::now() + timeout,
            })
            .map_err(|_| "对话连接已结束，请重新打开")?;
        super::super::wait::reply(receive, timeout, "failed work close check").await?
    }

    pub(crate) async fn close_failed_work(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        proof_id: String,
    ) -> Result<FailedWorkCloseReceipt, String> {
        let owner = self.failed_work_owner(agent_id, cwd, session_id, connection_id)?;
        let timeout = Duration::from_secs(5);
        let (result, receive) = oneshot::channel();
        owner
            .control
            .send(SessionControl::CloseFailedWork {
                proof_id,
                result,
                deadline: tokio::time::Instant::now() + timeout,
            })
            .map_err(|_| "对话连接已结束，请重新打开")?;
        let receipt =
            super::super::wait::reply(receive, timeout, "failed work close admission").await??;
        // The admission above only closed the gate. Prompt escrow and the
        // connection owner release capacity at the exact OS process boundary.
        owner.life.closed().await?;
        Ok(receipt)
    }
}
