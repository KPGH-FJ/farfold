//! A visible page retains only the exact connection it is displaying.
use super::AcpManager;
use std::path::Path;
use tauri::{AppHandle, Manager as _, Window};

impl AcpManager {
    #[cfg(test)]
    pub(crate) fn hold_connection(
        &self,
        agent_id: &str,
        cwd: &Path,
        service_context: Option<&str>,
        window: &str,
        owner: &str,
        retain: bool,
    ) -> Result<bool, String> {
        self.hold_connection_exact(agent_id, cwd, service_context, None, window, owner, retain)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn hold_connection_exact(
        &self,
        agent_id: &str,
        cwd: &Path,
        service_context: Option<&str>,
        connection_id: Option<&str>,
        window: &str,
        owner: &str,
        retain: bool,
    ) -> Result<bool, String> {
        let connections = self.lock()?;
        let Some((_, connection)) = connections.iter().find(|(key, connection)| {
            key.agent_id == agent_id
                && key.cwd == cwd
                && !key.candidate
                && key.service.as_deref() == service_context
                && connection_id.map_or(key.conversation_id.is_none(), |id| {
                    connection.connection_id == id
                })
        }) else {
            return Ok(false);
        };
        connection.life.hold_view(window, owner, retain)
    }

    pub fn release_window_holds(&self, window: &str) -> Result<(), String> {
        // Closing the real window and cancelling pure waiters precede the
        // connection-map guard; queue wakes never run under that map lock.
        self.history_admission
            .close_window(window)
            .map_err(super::super::cold_history_open::error)?;
        for connection in self.lock()?.values() {
            connection.life.release_views(window)?;
        }
        Ok(())
    }
}

/// Holds neither credentials nor messages and never establishes a connection.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_connection_hold(
    app: AppHandle,
    window: Window,
    agent_id: String,
    cwd: String,
    service_context: Option<String>,
    connection_id: Option<String>,
    owner: String,
    retain: bool,
) -> Result<bool, String> {
    // Status supplies the exact, already canonical directory. It may disappear
    // while the page is open; releasing its existing owner must still work.
    let cwd = Path::new(&cwd);
    if !cwd.is_absolute() {
        return Err("无法识别工作文件夹，请重新打开页面".into());
    }
    app.state::<AcpManager>().hold_connection_exact(
        &agent_id,
        cwd,
        service_context.as_deref(),
        connection_id.as_deref(),
        window.label(),
        &owner,
        retain,
    )
}
