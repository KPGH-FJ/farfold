//! Disconnect targets runtime process identities; account-wide disconnect remains explicit.
use super::*;

impl AcpManager {
    #[cfg(test)]
    pub async fn disconnect(&self, agent_id: &str, cwd: &Path) -> Result<bool, String> {
        self.disconnect_selected(agent_id, Some(cwd), None).await
    }

    pub(crate) async fn disconnect_selected(
        &self,
        agent_id: &str,
        cwd: Option<&Path>,
        connection_id: Option<&str>,
    ) -> Result<bool, String> {
        // Prevent a new process appearing between the all-Agent snapshot and
        // the confirmed termination of the processes the user chose to stop.
        let _configuration = crate::install_job::configuration_guard(agent_id).await;
        let connections: Vec<_> = self
            .lock()?
            .iter()
            .filter(|(key, connection)| {
                key.agent_id == agent_id
                    && !key.candidate
                    && cwd.is_none_or(|cwd| key.cwd == cwd)
                    && connection_id.is_none_or(|id| connection.connection_id == id)
            })
            .map(|(_, connection)| connection.clone())
            .collect();
        if connections
            .iter()
            .any(|connection| connection.life.work.load(Ordering::SeqCst) > 0)
        {
            return Err("此 Agent 仍有进行中的任务或待处理事项，请先完成后再执行此操作".into());
        }
        for connection in &connections {
            connection.life.close(false, None)?;
        }
        for connection in &connections {
            connection.life.closed().await?;
        }
        Ok(!connections.is_empty())
    }

    /// Program, install, removal and data-clearing changes end this Agent's
    /// safe idle connections themselves and wait for confirmed termination.
    /// The caller already holds the per-Agent configuration reservation, so no
    /// new connection can appear between this snapshot and the confirmed
    /// termination below. Work, operations or unconfirmed results still block.
    pub(crate) async fn release_for_configuration(&self, agent_id: &str) -> Result<(), String> {
        let connections: Vec<_> = self
            .lock()?
            .iter()
            .filter(|(key, _)| key.agent_id == agent_id && !key.candidate)
            .map(|(_, connection)| connection.life.clone())
            .collect();
        for life in &connections {
            life.release_for_configuration()?;
        }
        for life in &connections {
            // A finished process is already reaped; a stale failure outcome
            // must not block changes. Only unconfirmed termination waits.
            if !life.finished() {
                life.closed().await?;
            }
        }
        Ok(())
    }
}
