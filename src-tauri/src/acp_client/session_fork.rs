//! One explicit official current-context fork. Only index metadata is stored.
use super::{
    manager::{AcpManager, ManagedConnection},
    pump::{SessionControl, SessionSink},
    session::SessionOpenResult,
};
use crate::meta_store::{AgentRow, MetaStore};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, Webview, ipc::Channel};
use tokio::sync::{oneshot, watch};

mod coordinator;
pub(crate) use coordinator::{preflight, start};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOperations {
    pub fork_current_context: bool,
}

pub(crate) fn capabilities(connection: &ManagedConnection, session_id: &str) -> SessionOperations {
    let workspace_known = connection.sessions.lock().ok().is_some_and(|entries| {
        entries
            .get(session_id)
            .is_some_and(|entry| entry.workspace.as_ref().is_some_and(Vec::is_empty))
    });
    SessionOperations {
        fork_current_context: workspace_known
            && connection.handshake.get().is_some_and(|h| {
                let caps = &h.typed.agent_capabilities;
                caps.load_session
                    && caps.session_capabilities.fork.is_some()
                    && caps.session_capabilities.close.is_some()
            }),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkResult {
    pub status: &'static str,
    pub operation_id: String,
    pub parent_connection_id: String,
    pub parent_session_id: String,
    pub cwd: String,
    pub child_session_id: Option<String>,
    pub indexed: bool,
    pub source_released: bool,
    pub session: Option<SessionOpenResult>,
    pub reason: Option<&'static str>,
}

impl ForkResult {
    fn before_dispatch(
        operation_id: String,
        connection_id: &str,
        parent: &str,
        cwd: &Path,
        failure: AdmissionFailure,
    ) -> Self {
        Self {
            status: if failure.uncertain {
                "unknown"
            } else {
                "rejected"
            },
            operation_id,
            parent_connection_id: connection_id.into(),
            parent_session_id: parent.into(),
            cwd: cwd.to_string_lossy().into_owned(),
            child_session_id: None,
            indexed: false,
            source_released: !failure.uncertain,
            session: None,
            reason: Some(failure.reason),
        }
    }
}

#[derive(Debug)]
pub(crate) struct AdmissionFailure {
    uncertain: bool,
    reason: &'static str,
}
impl AdmissionFailure {
    pub(crate) fn rejected(reason: &'static str) -> Self {
        Self {
            uncertain: false,
            reason,
        }
    }
    fn unknown() -> Self {
        Self {
            uncertain: true,
            reason: "pending",
        }
    }
}
impl From<String> for AdmissionFailure {
    fn from(_: String) -> Self {
        Self::rejected("unavailable")
    }
}
impl From<&str> for AdmissionFailure {
    fn from(_: &str) -> Self {
        Self::rejected("unavailable")
    }
}

pub(crate) struct ForkRequest {
    pub manager: AcpManager,
    pub row: AgentRow,
    pub cwd: PathBuf,
    pub parent: String,
    pub connection: ManagedConnection,
    pub operation_id: String,
    pub open_token: String,
    pub events: SessionSink,
    pub delivery_failed: Arc<AtomicBool>,
    pub parent_opening: super::lifecycle::OpenReservation,
    pub(super) history: Option<super::history_admission::Permit>,
}

fn opened_result(
    opened: super::pump::OpenedSession,
    connection: ManagedConnection,
    cwd: &Path,
) -> SessionOpenResult {
    let session_operations = capabilities(&connection, &opened.session_id);
    let source = connection.service;
    SessionOpenResult {
        session_operations,
        connection_id: opened.connection_id,
        native_session_id: opened.session_id,
        cwd: cwd.to_string_lossy().into_owned(),
        config_options: opened.config_options.unwrap_or(Value::Null),
        config_options_modern: opened.config_options_modern,
        config_check: opened.config_check,
        permission_config_id: opened.permission_config_id,
        permission_state: opened.permission_state,
        permission_effect: opened.permission_effect,
        modes: (!opened.config_options_modern)
            .then(|| opened.response.get("modes").cloned())
            .flatten(),
        models: opened.response.get("models").cloned(),
        meta: opened.response.get("_meta").cloned(),
        resumed: true,
        warnings: opened.warnings,
        service: source.as_ref().map(|s| s.identity.clone()),
        service_context: source.map(|s| s.revision),
    }
}

struct Holds {
    _work: super::lifecycle::WorkLease,
    _operation: super::lifecycle::OperationLease,
    _parent: super::lifecycle::OpenReservation,
    child: Option<super::lifecycle::OpenReservation>,
}

/// One transient operation owned by its parent pump, including failed delivery.
pub(crate) struct SourceFork {
    pub busy: AtomicBool,
    result: Mutex<ForkResult>,
    updated: watch::Sender<ForkResult>,
    publishing: Mutex<()>,
    parent_events: SessionSink,
    child_events: SessionSink,
    holds: Mutex<Option<Holds>>,
}

impl SourceFork {
    fn observe_parent(
        self: &Arc<Self>,
        life: Arc<super::lifecycle::ConnectionLife>,
    ) -> tokio::task::JoinHandle<()> {
        // Delivery and the parent pump may both disappear while the exact
        // process is still closing. This task owns the remaining identity
        // holders until the complete operation settles or that owner ends.
        let state = self.clone();
        super::manager::runtime().spawn(async move {
            let mut updated = state.updated.subscribe();
            loop {
                updated.borrow_and_update();
                if !state.busy.load(Ordering::SeqCst) {
                    return;
                }
                if life.finished() {
                    let source_released = state.result.lock().expect("fork state").source_released;
                    if !source_released {
                        state.owner_ended();
                        return;
                    }
                    // Source close is not destination completion. The source
                    // end future is permanently ready now; wait only on state.
                    if updated.changed().await.is_err() {
                        return;
                    }
                } else {
                    tokio::select! {
                        _=life.terminated()=>{},
                        result=updated.changed()=>if result.is_err() {return;},
                    }
                }
            }
        })
    }
    fn publish(&self, state: &'static str) {
        // Concurrent process-end/progress publishers must not deliver a stale
        // snapshot after the operation's terminal result on this channel.
        let _publishing = self.publishing.lock().expect("fork publication");
        let (value, settled) = {
            let value = self.result.lock().expect("fork state");
            (value.clone(), !self.busy.load(Ordering::SeqCst))
        };
        let state = if settled { "finished" } else { state };
        self.updated.send_replace(value.clone());
        (self.child_events)(
            serde_json::json!({"kind":"forkResult","operationId":value.operation_id,
            "result":value,"settled":settled}),
        );
        (self.parent_events)(
            serde_json::json!({"kind":"forkActivity", "connectionId":value.parent_connection_id,
            "sessionId":value.parent_session_id, "operationId":value.operation_id, "state":state,
            "childSessionId":value.child_session_id, "indexed":value.indexed,
            "sourceReleased":value.source_released, "reason":value.reason}),
        );
    }
    fn owner_ended(&self) {
        let mut value = self.result.lock().expect("fork state");
        if value.source_released {
            return;
        }
        self.holds.lock().expect("fork holds").take();
        self.busy.store(false, Ordering::SeqCst);
        value.reason = Some("owner_ended");
        if value.child_session_id.is_some() {
            value.status = "created_unavailable";
        }
        drop(value);
        self.publish("finished");
    }
    fn fail(&self, reason: &'static str) {
        let released = {
            let mut value = self.result.lock().expect("fork state");
            if value.reason == Some("owner_ended") {
                drop(value);
                self.publish("finished");
                return;
            }
            value.status = if value.child_session_id.is_some() {
                "created_unavailable"
            } else {
                "unknown"
            };
            value.reason = Some(reason);
            let released = value.source_released;
            if released {
                self.holds.lock().expect("fork holds").take();
                self.busy.store(false, Ordering::SeqCst);
            }
            released
        };
        self.publish(if released { "finished" } else { "unknown" });
    }
    pub(crate) async fn wait(&self, duration: Duration) -> ForkResult {
        let mut changed = self.updated.subscribe();
        let wait = async {
            loop {
                // Watch only supplies wakeups; a process-end result may have
                // advanced under the state lock before its publication runs.
                changed.borrow_and_update();
                let value = self.result.lock().expect("fork state").clone();
                if value.reason.is_some() || value.status == "ready" {
                    return value;
                }
                if changed.changed().await.is_err() {
                    return self.result.lock().expect("fork state").clone();
                }
            }
        };
        match tokio::time::timeout(duration, wait).await {
            Ok(value) => value,
            Err(_) => {
                // Only delivery expires; the same official request keeps running.
                let mut value = self.result.lock().expect("fork state");
                if value.status == "ready" || !self.busy.load(Ordering::SeqCst) {
                    return value.clone();
                }
                value.reason = Some("pending");
                drop(value);
                self.publish("unknown");
                self.result.lock().expect("fork state").clone()
            }
        }
    }
}

#[cfg(test)]
mod owner_tests;

impl AcpManager {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn fork_current(
        &self,
        row: AgentRow,
        cwd: &Path,
        parent: &str,
        connection_id: &str,
        operation_id: String,
        open_token: String,
        events: SessionSink,
        delivery_failed: Arc<AtomicBool>,
        store: &MetaStore,
        history: Option<super::history_admission::Permit>,
    ) -> Result<ForkResult, String> {
        let result = self
            .begin_fork(
                row,
                cwd,
                parent,
                connection_id,
                operation_id.clone(),
                open_token,
                events,
                delivery_failed,
                store,
                history,
            )
            .await;
        Ok(match result {
            Ok(source) => source.wait(Duration::from_secs(120)).await,
            Err(failure) => {
                ForkResult::before_dispatch(operation_id, connection_id, parent, cwd, failure)
            }
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn begin_fork(
        &self,
        row: AgentRow,
        cwd: &Path,
        parent: &str,
        connection_id: &str,
        operation_id: String,
        open_token: String,
        events: SessionSink,
        delivery_failed: Arc<AtomicBool>,
        store: &MetaStore,
        history: Option<super::history_admission::Permit>,
    ) -> Result<Arc<SourceFork>, AdmissionFailure> {
        let connection = self.session_connection(&row.id, cwd, parent)?;
        if connection.connection_id != connection_id {
            return Err(AdmissionFailure::rejected("unavailable"));
        }
        if !capabilities(&connection, parent).fork_current_context {
            return Err(AdmissionFailure::rejected("unsupported"));
        }
        let parent_opening = self.opening_sessions.reserve(&row.id, cwd, parent)?;
        let control = {
            let entries = connection.sessions.lock().map_err(|_| "无法读取对话状态")?;
            let entry = entries.get(parent).ok_or("对话已关闭，请重新打开")?;
            if entry.preview_token.is_some() {
                return Err("请先打开已有对话后再复制".into());
            }
            entry.control.clone()
        };
        let request = ForkRequest {
            manager: self.clone(),
            row,
            cwd: cwd.to_path_buf(),
            parent: parent.into(),
            connection,
            operation_id,
            open_token,
            events,
            delivery_failed,
            parent_opening,
            history,
        };
        crate::work_policy::admit(store, &request.row.id.clone(), cwd, || async {
            let (reply, receive) = oneshot::channel();
            if control
                .send(SessionControl::Fork {
                    request: Box::new(request),
                    result: reply,
                    deadline: tokio::time::Instant::now() + Duration::from_secs(60),
                })
                .is_err()
            {
                return Ok(Err(AdmissionFailure::rejected("unavailable")));
            }
            Ok(
                match tokio::time::timeout(Duration::from_secs(60), receive).await {
                    Ok(Ok(Ok(state))) => Ok(state),
                    Ok(Ok(Err(failure))) => Err(failure),
                    _ => Err(AdmissionFailure::unknown()),
                },
            )
        })
        .await
        .map_err(|error| {
            AdmissionFailure::rejected(if error == "WORK_DISABLED" {
                "work_disabled"
            } else {
                "unavailable"
            })
        })?
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn session_fork_current(
    app: AppHandle,
    webview: Webview,
    window: tauri::Window,
    agent_id: String,
    cwd: String,
    parent_session_id: String,
    connection_id: String,
    operation_id: String,
    open_token: String,
    admission_channel: Channel<super::history_admission_commands::HistoryAdmissionPhase>,
    channel: Channel<Value>,
) -> Result<ForkResult, String> {
    if !crate::browser_workspace::caller_allowed(&webview) {
        return Err("请从主界面复制对话".into());
    }
    if [
        operation_id.as_str(),
        open_token.as_str(),
        parent_session_id.as_str(),
        connection_id.as_str(),
    ]
    .iter()
    .any(|s| s.is_empty() || s.len() > 512 || s.chars().any(char::is_control))
    {
        return Ok(ForkResult::before_dispatch(
            operation_id,
            &connection_id,
            &parent_session_id,
            Path::new(&cwd),
            AdmissionFailure::rejected("unavailable"),
        ));
    }
    let manager = app.state::<AcpManager>();
    let store = app.state::<MetaStore>();
    let mut request = super::history_admission_commands::HistoryRequest::from_window(
        &manager,
        &window,
        &open_token,
        &agent_id,
        admission_channel,
    )?;
    let mut preparation =
        super::history_admission_commands::HistoryPreparation::new(request.progress.clone());
    let row = match super::manager::require_agent_row(&app, &agent_id).await {
        Ok(row) => row,
        Err(_) => {
            return Ok(ForkResult::before_dispatch(
                operation_id,
                &connection_id,
                &parent_session_id,
                Path::new(&cwd),
                AdmissionFailure::rejected("unavailable"),
            ));
        }
    };
    let cwd = match super::manager::validate_cwd_async(&cwd).await {
        Ok(path) => path,
        Err(_) => {
            return Ok(ForkResult::before_dispatch(
                operation_id,
                &connection_id,
                &parent_session_id,
                Path::new(&cwd),
                AdmissionFailure::rejected("unavailable"),
            ));
        }
    };
    // Reserve outside the cwd work-policy lock and before official fork.
    // Source load and final independent load share this same Slot.
    request.preparation_bytes = std::mem::size_of::<ForkRequest>()
        .checked_add(connection_id.len())
        .and_then(|v| v.checked_add(operation_id.len()))
        .ok_or("读取所需设置较大，暂时无法开始；原记录与设置已保留。")?;
    let history = match manager
        .admit_cold_history(&row, &cwd, &parent_session_id, &[], &store, None, request)
        .await
    {
        Ok(history) => history,
        Err(_) => {
            return Ok(ForkResult::before_dispatch(
                operation_id,
                &connection_id,
                &parent_session_id,
                &cwd,
                AdmissionFailure::rejected("unavailable"),
            ));
        }
    };
    preparation.ready();
    let failed = Arc::new(AtomicBool::new(false));
    let delivery_failed = failed.clone();
    let events: SessionSink = Arc::new(move |event| {
        if channel.send(event).is_err() {
            failed.store(true, Ordering::SeqCst);
        }
    });
    app.state::<AcpManager>()
        .fork_current(
            row,
            &cwd,
            &parent_session_id,
            &connection_id,
            operation_id,
            open_token,
            events,
            delivery_failed,
            &app.state::<MetaStore>(),
            Some(history),
        )
        .await
}
