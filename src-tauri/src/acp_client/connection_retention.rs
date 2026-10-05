//! A visible page retains only the exact connection it is displaying.
use super::{AcpManager, ConnectionKey};
use std::path::Path;
use tauri::{AppHandle, Manager as _, Window};

impl AcpManager {
    pub(crate) fn hold_connection(
        &self,
        agent_id: &str,
        cwd: &Path,
        service_context: Option<&str>,
        window: &str,
        owner: &str,
        retain: bool,
    ) -> Result<bool, String> {
        let key = ConnectionKey {
            agent_id: agent_id.into(),
            cwd: cwd.into(),
            candidate: false,
            service: service_context.map(str::to_owned),
        };
        let connections = self.lock()?;
        let Some(connection) = connections.get(&key) else {
            return Ok(false);
        };
        connection.life.hold_view(window, owner, retain)
    }

    pub fn release_window_holds(&self, window: &str) -> Result<(), String> {
        for connection in self.lock()?.values() {
            connection.life.release_views(window)?;
        }
        Ok(())
    }
}

/// Holds neither credentials nor messages and never establishes a connection.
#[tauri::command]
pub async fn agent_connection_hold(
    app: AppHandle,
    window: Window,
    agent_id: String,
    cwd: String,
    service_context: Option<String>,
    owner: String,
    retain: bool,
) -> Result<bool, String> {
    // Status supplies the exact, already canonical directory. It may disappear
    // while the page is open; releasing its existing owner must still work.
    let cwd = Path::new(&cwd);
    if !cwd.is_absolute() {
        return Err("无法识别工作文件夹，请重新打开页面".into());
    }
    app.state::<AcpManager>().hold_connection(
        &agent_id,
        cwd,
        service_context.as_deref(),
        window.label(),
        &owner,
        retain,
    )
}
