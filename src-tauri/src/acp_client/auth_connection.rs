//! Recheck an account without replacing unrelated directory or API connections.
use std::{path::Path, sync::atomic::Ordering};

use tauri::{AppHandle, Manager as _};

use super::manager::{
    AcpManager, AgentConnectionStatus, CloseReason, ConnectionKey, STATE_READY, validate_cwd_async,
};
use crate::meta_store::MetaStore;

impl AcpManager {
    /// Check the process which accepted protocol authentication. Restarting it
    /// here would discard valid connection-local authentication state.
    pub(crate) async fn refresh_authentication(
        &self,
        agent_id: &str,
        cwd: &Path,
    ) -> Result<AgentConnectionStatus, String> {
        let _configuration = crate::install_job::configuration_guard(agent_id).await;
        let _scope = self.reserve_account_change(agent_id)?;
        let selected = self.live_connection(agent_id, cwd)?;
        let query = selected.handshake.get().and_then(|h| {
            super::account_query::AccountQuery::declared(&h.public_json(), selected.account_query)
        });
        if let Some(query) = query {
            let (result, reply) = tokio::sync::oneshot::channel();
            selected.send(super::manager::ManagerCommand::AccountStatus { query, result })?;
            let identity = reply.await.map_err(|_| "账号连接已结束，请重新检查")??;
            *selected.account.lock().map_err(|_| "账号状态尚未确认")? = identity;
        }
        let connections = self.lock()?;
        let (key, connection) = connections
            .iter()
            .find(|(_, c)| {
                c.connection_id == selected.connection_id
                    && c.state.load(Ordering::SeqCst) == STATE_READY
            })
            .ok_or("账号连接已结束，请重新检查")?;
        let status = Self::status_of(key, connection);
        self.publish_status(status.clone());
        Ok(status)
    }
}

#[tauri::command]
pub async fn auth_refresh(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    source: Option<String>,
) -> Result<AgentConnectionStatus, String> {
    if source.is_some_and(|value| !value.is_empty()) {
        return Err("当前使用 API 配置，请返回 API 设置检查此服务".into());
    }
    let cwd = validate_cwd_async(&cwd).await?;
    app.state::<AcpManager>()
        .refresh_authentication(&agent_id, &cwd)
        .await
}

impl AcpManager {
    pub(crate) async fn recheck_authentication(
        &self,
        agent_id: &str,
        cwd: &Path,
        store: &MetaStore,
    ) -> Result<AgentConnectionStatus, String> {
        // Serialize with account changes, installation and connection creation.
        // Keep this guard until the replacement has completed its handshake.
        let _configuration = crate::install_job::configuration_guard(agent_id).await;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err("应用正在退出，请稍后重试".into());
        }
        if self.candidate_pending(agent_id)? {
            return Err("版本检查进程尚未确认结束，请稍后重试".into());
        }
        let id = agent_id.to_string();
        let row = store
            .run(move |store| {
                store
                    .get_agent(&id)?
                    .ok_or_else(|| "请先重新添加此 Agent".into())
            })
            .await?;
        let key = ConnectionKey {
            agent_id: agent_id.into(),
            cwd: cwd.into(),
            candidate: false,
            conversation_id: None,
            service: None,
        };
        let previous = self.lock()?.get(&key).cloned();
        if let Some(previous) = previous {
            // Reuse account admission to atomically reject work AND effectful
            // operations, including requests whose caller has stopped waiting.
            // Configuration ownership prevents a new login during this check.
            let _idle = if previous.state.load(Ordering::SeqCst) == STATE_READY {
                Some(previous.life.operation("account_change".into())?)
            } else {
                None
            };
            if _idle.is_some() {
                previous
                    .life
                    .close_for(false, None, CloseReason::Configuration)?;
            }
            previous.life.closed().await?;
        }
        self.connect_launch(&row, cwd, store, false, None).await
    }
}

#[tauri::command]
pub async fn auth_recheck(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    source: Option<String>,
) -> Result<AgentConnectionStatus, String> {
    if source.is_some_and(|value| !value.is_empty()) {
        return Err("当前使用 API 配置，请返回 API 设置检查此服务".into());
    }
    let cwd = validate_cwd_async(&cwd).await?;
    let manager = app.state::<AcpManager>();
    manager
        .recheck_authentication(&agent_id, &cwd, &app.state::<MetaStore>())
        .await
}
