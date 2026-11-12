//! Explicit, already-saved conversation attachment through the reviewed official
//! HTTP socket field. No process credential, extra Agent loop, or history save.
use super::{manager::AcpManager, session_tool_changes as changes, transient_mcp::SessionMcpOwner};
use crate::meta_store::MetaStore;
use std::{
    path::Path,
    sync::{Arc, atomic::Ordering},
};
#[cfg(target_os = "macos")]
use {super::transient_mcp::SessionMcpLease, std::path::PathBuf};

pub(crate) struct Eligibility {
    pub(crate) connection_id: Option<String>,
    pub(crate) reason: &'static str,
}
impl AcpManager {
    pub(crate) async fn browser_uds_eligibility(
        &self,
        store: &MetaStore,
        agent: &str,
        cwd: &Path,
        native: &str,
    ) -> Eligibility {
        let unavailable = |reason| Eligibility {
            connection_id: None,
            reason,
        };
        if !cfg!(target_os = "macos") {
            return unavailable("source_not_reviewed");
        }
        let Ok(connection) = self.session_connection(agent, cwd, native) else {
            return unavailable("connection_changed");
        };
        if !changes::supported(&connection) || connection.process_identity.get().is_none() {
            return unavailable("source_not_reviewed");
        }
        if connection.state.load(Ordering::Acquire) != super::lifecycle::READY {
            return unavailable("connection_changed");
        }
        if !connection.sessions.lock().is_ok_and(|entries| {
            entries.get(native).is_some_and(|e| {
                e.preview_token.is_none()
                    && e.purpose == super::open_purpose::OpenPurpose::Conversation
                    && !e.control.is_closed()
                    && e._mcp_lease.is_none()
                    && !e.tools_report.changes.busy()
            })
        }) {
            return unavailable("connection_busy");
        }
        let (agent, directory, native) = (
            agent.to_owned(),
            cwd.to_string_lossy().into_owned(),
            native.to_owned(),
        );
        let valid = store
            .run(move |s| {
                let rows: Vec<_> = s
                    .list_sessions_for(&agent, &directory)?
                    .into_iter()
                    .filter(|r| r.native_session_id.as_deref() == Some(&native))
                    .collect();
                if rows.len() != 1 || rows[0].archived || rows[0].config_options.is_none() {
                    return Ok("saved_conversation_required");
                }
                if s.mcp_pending(&rows[0].id)?.is_some() {
                    return Ok("tool_change_pending");
                }
                Ok("available")
            })
            .await;
        match valid {
            Ok("available") => {}
            Ok(reason) => return unavailable(reason),
            Err(_) => return unavailable("status_failed"),
        }
        Eligibility {
            connection_id: Some(connection.connection_id),
            reason: "available",
        }
    }

    pub(crate) fn browser_uds_detach(
        &self,
        agent: &str,
        cwd: &Path,
        native: &str,
        connection_id: &str,
        owner: &Arc<dyn SessionMcpOwner>,
    ) -> Result<(), String> {
        let connection = self.session_connection(agent, cwd, native)?;
        if connection.connection_id != connection_id {
            return Err("当前对话已变化".into());
        }
        let lease = {
            let mut entries = connection.sessions.lock().map_err(|_| "无法读取对话状态")?;
            let entry = entries.get_mut(native).ok_or("当前对话已变化")?;
            if !entry.browser_requests.detach(owner) {
                return Err("网页工具归属已变化".into());
            }
            entry._mcp_lease.take()
        };
        drop(lease);
        Ok(())
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn browser_uds_owner(
        &self,
        agent: &str,
        cwd: &Path,
        native: &str,
        connection_id: &str,
    ) -> Result<Owner, String> {
        let connection = self.session_connection(agent, cwd, native)?;
        if connection.connection_id != connection_id || !changes::supported(&connection) {
            return Err("当前对话已变化".into());
        }
        let identity = *connection
            .process_identity
            .get()
            .ok_or("尚未确认对话连接")?;
        Ok(Owner {
            manager: self.clone(),
            agent: agent.into(),
            cwd: cwd.into(),
            native: native.into(),
            connection,
            identity,
        })
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
pub(crate) struct Owner {
    manager: AcpManager,
    agent: String,
    cwd: PathBuf,
    native: String,
    connection: super::manager::ManagedConnection,
    identity: super::browser_process::Identity,
}
#[cfg(target_os = "macos")]
impl Owner {
    pub(crate) fn descriptor(
        &self,
        name: &str,
        path: &Path,
        uri: &str,
    ) -> Result<serde_json::Value, String> {
        if !self.current() || !path.is_absolute() || uri != "http://127.0.0.1:0/mcp" {
            return Err("网页连接已变化".into());
        }
        Ok(
            serde_json::json!({"type":"mcp","server":{"type":"http","name":name,"url":uri,"headers":[]},"socket":path}),
        )
    }

    fn current(&self) -> bool {
        self.connection.state.load(Ordering::Acquire) == super::lifecycle::READY
            && !self.connection.life.finished()
            && self
                .manager
                .session_connection(&self.agent, &self.cwd, &self.native)
                .is_ok_and(|c| {
                    c.connection_id == self.connection.connection_id
                        && Arc::ptr_eq(&c.state, &self.connection.state)
                })
    }
    pub(crate) fn peer(&self, stream: &std::os::unix::net::UnixStream) -> bool {
        self.current() && self.identity.peer(stream)
    }
    pub(crate) fn attach(
        &self,
        owner: Arc<dyn SessionMcpOwner>,
    ) -> Result<(), changes::ChangeError> {
        if !self.current() {
            return Err(changes::Code::Changed.into());
        }
        let mut entries = self
            .connection
            .sessions
            .lock()
            .map_err(|_| changes::Code::Changed)?;
        let entry = entries
            .get_mut(&self.native)
            .filter(|e| {
                e.preview_token.is_none()
                    && e.purpose == super::open_purpose::OpenPurpose::Conversation
                    && !e.control.is_closed()
            })
            .ok_or(changes::Code::Changed)?;
        if entry._mcp_lease.is_some() {
            return Err(changes::Code::Changed.into());
        }
        let lease =
            SessionMcpLease::bind(owner, &self.native).map_err(|_| changes::Code::Changed)?;
        entry
            .browser_requests
            .attach(&lease)
            .map_err(|_| changes::Code::Changed)?;
        entry._mcp_lease = Some(lease);
        entry.browser_unavailable = None;
        Ok(())
    }
}
