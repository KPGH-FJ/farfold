//! Current-dialog HTTP changes through the existing official session actor.
//! Descriptors and exact keys stay private; only exact reviewed item handles
//! are returned to the shared UI. A durable guard precedes each mutation.
use super::{manager::AcpManager, pump::SessionControl};
use crate::meta_store::{MetaStore, SessionRow};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::sync::oneshot;

mod types;
pub use types::*;
pub(crate) mod inventory;
mod slot;
pub(crate) use slot::Slot;
mod actor;
pub(crate) use actor::{Request, start};
#[path = "session_tool_changes/commands.rs"]
mod commands;
pub use commands::*;

pub(crate) type BrowserCompletion =
    Arc<dyn Fn(bool, &str) -> Result<(), ChangeError> + Send + Sync>;

const BUDGET: Duration = Duration::from_secs(10);
pub(crate) const LIST: &str = "_goose/unstable/session/extensions/list";
const ADD: &str = "_goose/unstable/session/extensions/add";
const REMOVE: &str = "_goose/unstable/session/extensions/remove";
const TOOLS: &str = "_goose/unstable/tools/list";

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
pub(crate) fn supported(connection: &super::manager::ManagedConnection) -> bool {
    connection.session_tools.management_supported()
        && connection.handshake.get().is_some_and(|h| {
            serde_json::to_value(&h.typed.agent_capabilities)
                .ok()
                .is_some_and(|v| {
                    v.pointer("/mcpCapabilities/http")
                        .and_then(serde_json::Value::as_bool)
                        == Some(true)
                })
        })
}
struct Owner {
    supported: bool,
    life: Arc<super::lifecycle::ConnectionLife>,
    control: tokio::sync::mpsc::UnboundedSender<SessionControl>,
    slot: Arc<Slot>,
    availability: Arc<super::session_tools::Availability>,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
}
impl AcpManager {
    fn change_owner(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
    ) -> Result<Owner, ChangeError> {
        let connection = self
            .session_connection(agent_id, cwd, session_id)
            .map_err(|_| Code::Changed)?;
        if connection.connection_id != connection_id {
            return Err(Code::Changed.into());
        }
        let (control, slot) = {
            let entries = connection.sessions.lock().map_err(|_| Code::Changed)?;
            let entry = entries
                .get(session_id)
                .filter(|e| {
                    e.preview_token.is_none()
                        && e.purpose == super::open_purpose::OpenPurpose::Conversation
                        && !e.control.is_closed()
                })
                .ok_or(Code::Changed)?;
            (entry.control.clone(), entry.tools_report.changes.clone())
        };
        let (manager, agent, directory, session, original, original_control, original_slot) = (
            self.clone(),
            agent_id.to_owned(),
            cwd.to_owned(),
            session_id.to_owned(),
            connection.clone(),
            control.clone(),
            slot.clone(),
        );
        let current = Arc::new(move || {
            manager
                .session_connection(&agent, &directory, &session)
                .is_ok_and(|c| {
                    c.connection_id == original.connection_id
                        && Arc::ptr_eq(&c.state, &original.state)
                        && c.sessions.lock().is_ok_and(|entries| {
                            entries.get(&session).is_some_and(|e| {
                                e.preview_token.is_none()
                                    && e.purpose == super::open_purpose::OpenPurpose::Conversation
                                    && !e.control.is_closed()
                                    && e.control.same_channel(&original_control)
                                    && Arc::ptr_eq(&e.tools_report.changes, &original_slot)
                            })
                        })
                })
        });
        Ok(Owner {
            supported: supported(&connection),
            life: connection.life.clone(),
            control,
            slot,
            availability: connection.session_tools.clone(),
            current,
        })
    }
    #[allow(clippy::too_many_arguments)]
    async fn change_start(
        &self,
        store: &MetaStore,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        operation_id: &str,
        change: Change,
        deadline: tokio::time::Instant,
    ) -> Reply {
        self.change_start_with_browser(
            store,
            agent_id,
            cwd,
            session_id,
            connection_id,
            operation_id,
            change,
            deadline,
            None,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn change_start_with_browser(
        &self,
        store: &MetaStore,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        operation_id: &str,
        change: Change,
        deadline: tokio::time::Instant,
        browser_completion: Option<BrowserCompletion>,
    ) -> Reply {
        if !valid_id(operation_id) {
            return Err(ChangeError::from(Code::InvalidInput).before_dispatch());
        }
        if let Change::AddHttp { name, url } = &change {
            inventory::http_descriptor(name, url).map_err(ChangeError::before_dispatch)?;
        }
        let owner = self
            .change_owner(agent_id, cwd, session_id, connection_id)
            .map_err(ChangeError::before_dispatch)?;
        if let Some(existing) = owner
            .slot
            .existing(operation_id, &change)
            .map_err(ChangeError::before_dispatch)?
        {
            return Ok(existing);
        }
        if !owner.supported {
            return Err(ChangeError::from(Code::Unavailable).before_dispatch());
        }
        let (agent, directory, native) = (
            agent_id.to_owned(),
            cwd.to_string_lossy().into_owned(),
            session_id.to_owned(),
        );
        let row: Option<SessionRow> = store
            .run(move |store| {
                let rows: Vec<_> = store
                    .list_sessions_for(&agent, &directory)?
                    .into_iter()
                    .filter(|r| r.native_session_id.as_deref() == Some(&native))
                    .collect();
                if rows.len() > 1 || rows.iter().any(|row| row.archived) {
                    return Err("对话已变化".into());
                }
                Ok(rows.into_iter().next())
            })
            .await
            .map_err(|_| ChangeError::from(Code::Changed).before_dispatch())?;
        if !(owner.current)() {
            return Err(ChangeError::from(Code::Changed).before_dispatch());
        }
        if matches!(change, Change::AddLocalBrowser { .. })
            && (browser_completion.is_none()
                || row.as_ref().is_none_or(|r| r.config_options.is_none()))
        {
            return Err(ChangeError::from(Code::Changed).before_dispatch());
        }
        let operation = Operation {
            kind: change.kind(),
            operation_id: operation_id.into(),
            agent_id: agent_id.into(),
            cwd: cwd.to_string_lossy().into(),
            native_session_id: session_id.into(),
            connection_id: connection_id.into(),
            state: State::Pending,
            settled: false,
            mutation_sent: false,
            conversation_saved: false,
            persistence: Persistence::Unreported,
            activity: Activity::Unreported,
            items: owner.slot.items().map_err(ChangeError::before_dispatch)?,
            error: None,
        };
        let request = Request {
            browser_completion,
            operation,
            change,
            slot: owner.slot.clone(),
            availability: owner.availability,
            current_owner: owner.current.clone(),
            store: store.clone(),
            row,
        };
        let (result, receive) = oneshot::channel();
        owner
            .control
            .send(SessionControl::ToolsChange {
                request: Box::new(request),
                deadline,
                result,
            })
            .map_err(|_| ChangeError::from(Code::Changed).before_dispatch())?;
        // Keep the admission receiver until this actor explicitly accepts or
        // drops the command. Its deadline still prevents a delayed write.
        // Dropping the receiver on a UI timeout would erase the proof that a
        // queued command was never admitted and leave an unrecoverable UI gate.
        match receive.await {
            Ok(result) => result.map_err(ChangeError::before_dispatch)?,
            Err(_) if owner.life.finished() && !owner.slot.was_admitted(operation_id) => {
                return Err(ChangeError::from(Code::Timeout).before_dispatch());
            }
            Err(_) => return Err(Code::Changed.into()),
        }
        let value = owner.slot.wait(operation_id, deadline).await?;
        if !(owner.current)() {
            return Err(
                ChangeError::from(Code::Changed).with_saved_conversation(value.conversation_saved)
            );
        }
        Ok(value)
    }
    pub(crate) fn change_status(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        operation_id: &str,
    ) -> Reply {
        self.change_owner(agent_id, cwd, session_id, connection_id)?
            .slot
            .snapshot(operation_id)
    }
    fn change_items(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
    ) -> Result<Vec<Item>, ChangeError> {
        self.change_owner(agent_id, cwd, session_id, connection_id)?
            .slot
            .items()
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod wire_tests;
