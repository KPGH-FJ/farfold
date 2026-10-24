//! Charge and revalidate a cold-history request before MCP or connection setup.
use super::{
    history_admission::{Charge, Failure, Permit},
    history_admission_commands::{HistoryAdmissionState, HistoryRequest},
    manager::AcpManager,
};
use crate::{
    credentials::ServiceSelection,
    meta_store::{AgentRow, MetaStore, SessionRow},
};
use serde_json::Value;
use std::path::Path;

pub(super) fn same_launch(a: &AgentRow, b: &AgentRow) -> bool {
    a.id == b.id
        && a.source == b.source
        && a.command == b.command
        && a.args == b.args
        && a.env == b.env
}
fn same_saved_target(a: Option<&SessionRow>, b: Option<&SessionRow>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.id == b.id
                && a.agent_id == b.agent_id
                && a.cwd == b.cwd
                && a.native_session_id == b.native_session_id
                && a.archived == b.archived
                && a.config_options == b.config_options
        }
        _ => false,
    }
}
pub(super) fn error(failure: Failure) -> String {
    match failure {
        Failure::Full => "等待读取的对话较多，请稍后重试",
        Failure::Payload => "读取所需设置较大，暂时无法开始；原记录与设置已保留。",
        Failure::Closed => "应用正在退出，本次读取尚未开始",
        Failure::Cancelled => "已取消等待读取",
        Failure::Invalid | Failure::Unavailable | Failure::Timeout => {
            "无法确认读取状态，请重新打开"
        }
    }
    .into()
}
fn agent_charge(c: &mut Charge, row: &AgentRow) -> Result<(), Failure> {
    c.add(std::mem::size_of::<AgentRow>())?;
    for s in [&row.id, &row.name, &row.source, &row.command] {
        c.text(s)?;
    }
    for arg in &row.args {
        c.text(arg)?;
    }
    for (name, value) in &row.env {
        c.text(name)?;
        c.text(value)?;
    }
    if let Some(version) = &row.version {
        c.text(version)?;
    }
    if let Some(handshake) = &row.handshake {
        c.json(handshake)?;
    }
    Ok(())
}
fn session_charge(c: &mut Charge, row: &SessionRow) -> Result<(), Failure> {
    c.add(std::mem::size_of::<SessionRow>())?;
    for s in [&row.id, &row.agent_id, &row.cwd] {
        c.text(s)?;
    }
    for s in [&row.native_session_id, &row.title].into_iter().flatten() {
        c.text(s)?;
    }
    if let Some(value) = &row.config_options {
        c.json(value)?;
    }
    Ok(())
}
impl AcpManager {
    /// Production command preparation and controlled probes share this exact
    /// ordering. No transport/connection factory is invoked for a queued item.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn prepare_history_open<T>(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        native: Option<&str>,
        config: &[(String, Value)],
        store: &MetaStore,
        selection: Option<&ServiceSelection>,
        request: Option<HistoryRequest>,
        prepare: impl FnOnce() -> T,
    ) -> Result<(Option<Permit>, T), String> {
        let history = if let Some(native) = native {
            let mut request = request.ok_or("无法确认读取许可，本次尚未开始")?;
            request.preparation_bytes = std::mem::size_of_val(&prepare);
            Some(
                self.admit_cold_history(agent, cwd, native, config, store, selection, request)
                    .await?,
            )
        } else {
            None
        };
        Ok((history, prepare()))
    }
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn admit_cold_history(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        native: &str,
        config: &[(String, Value)],
        store: &MetaStore,
        selection: Option<&ServiceSelection>,
        request: HistoryRequest,
    ) -> Result<Permit, String> {
        if !request.owner.belongs_to(&agent.id) {
            return Err(error(Failure::Invalid));
        }
        let policy = self.history_admission.policy();
        let row_id =
            super::session_index::session_row_id(&agent.id, &cwd.to_string_lossy(), native);
        let expected = {
            let id = row_id.clone();
            store.run(move |s| s.get_session(&id)).await?
        };
        let saved_identity = {
            let recorded = super::service_connection::recorded_service(
                expected
                    .as_ref()
                    .and_then(|row| row.config_options.as_ref()),
            )?;
            let (_, identity) = super::service_connection::selection_for_open(
                true,
                recorded.as_ref(),
                selection.cloned(),
            )?;
            identity
        };
        if let Some(identity) = saved_identity.clone() {
            store
                .run(move |store| crate::credentials::validate_service_identity(store, &identity))
                .await?;
        }
        let mut charge = Charge::new(policy.bytes);
        let charged = (|| {
            request.owner.charge(&mut charge)?;
            charge.add(std::mem::size_of::<HistoryRequest>())?;
            charge.add(request.preparation_bytes)?;
            charge.add(std::mem::size_of::<Vec<(String, Value)>>())?;
            charge.text(&row_id)?;
            agent_charge(&mut charge, agent)?;
            if let Some(identity) = &saved_identity {
                charge.add(std::mem::size_of::<crate::credentials::ServiceIdentity>())?;
                for value in [&identity.id, &identity.fingerprint, &identity.model] {
                    charge.text(value)?;
                }
            }
            charge.text(&cwd.to_string_lossy())?;
            charge.text(native)?;
            for (key, value) in config {
                charge.text(key)?;
                charge.json(value)?;
            }
            if let Some(row) = &expected {
                session_charge(&mut charge, row)?;
            }
            if let Some(s) = selection {
                charge.add(std::mem::size_of::<ServiceSelection>())?;
                charge.text(&s.id)?;
                charge.text(&s.model)?;
                if let Some(revision) = &s.revision {
                    charge.text(revision)?;
                }
            }
            Ok::<_, Failure>(charge.finish())
        })()
        .map_err(error)?;
        let waiting = self
            .history_admission
            .enqueue(request.owner, charged)
            .map_err(error)?;
        if waiting.queued() {
            (request.progress)(HistoryAdmissionState::Waiting)
                .map_err(|_| "未能传递读取状态，本次尚未开始")?;
        }
        let permit = waiting.acquire().await.map_err(error)?;
        (request.progress)(HistoryAdmissionState::Starting)
            .map_err(|_| "未能传递读取状态，本次尚未开始")?;
        let id = agent.id.clone();
        let current = store
            .run(move |s| Ok((s.get_agent(&id)?, s.get_session(&row_id)?)))
            .await?;
        if current
            .0
            .as_ref()
            .is_none_or(|row| !same_launch(agent, row))
            || !same_saved_target(current.1.as_ref(), expected.as_ref())
        {
            return Err("读取设置已变化，本次尚未开始，请重新打开".into());
        }
        // Reuse existing restoration authority before transport preparation.
        // This reads only service metadata; credential delivery stays in the
        // existing configuration-guarded connection path.
        if let Some(identity) = saved_identity {
            store
                .run(move |store| crate::credentials::validate_service_identity(store, &identity))
                .await?;
        }
        Ok(permit)
    }
}
