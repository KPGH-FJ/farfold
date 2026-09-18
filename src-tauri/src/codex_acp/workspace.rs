//! Ordinary workspace's read-only facade. No launch/auth/task command is exposed.
//! Cached observations are NOT fresh admission or production capabilities.
use super::*;
use crate::{
    acp_runtime::AcpLifecycle,
    host_ids::{FarfoldSessionId, WorkingCopyId},
    host_store::{HostStore, records::NativeSessionLocatorKind},
    runtime_registry::RuntimeBinding,
};
use tauri::{AppHandle, Manager};

pub const BLOCKED_REASON: &str =
    "Codex ACP 需要自有环境连接；连接未建立或结果未知时不会创建、打开或恢复会话。";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    create_session: bool,
    open_session: bool,
    authenticate: bool,
    select_model: bool,
    submit_turn: bool,
    reply_interaction: bool,
    steer: bool,
    interrupt: bool,
}
impl Capabilities {
    fn closed() -> Self {
        Self {
            create_session: false,
            open_session: false,
            authenticate: false,
            select_model: false,
            submit_turn: false,
            reply_interaction: false,
            steer: false,
            interrupt: false,
        }
    }
    /// Capabilities are the Host's current truth, never a cached claim.
    fn for_connection(c: &Connection, bound: bool) -> Self {
        let ok = c.transport.failure().is_none() && !c.turns.unknown;
        let idle = c.turns.active.is_none()
            && !c.control.operations.is_pending()
            && c.control.workspace_phase() != Some(configure::Phase::Unknown);
        let account_ok = c
            .admission
            .as_ref()
            .and_then(|a| a.account.as_ref())
            .is_some_and(|a| a.kind != "unauthenticated");
        let choice_ready = account_ok
            && c.admission
                .as_ref()
                .is_some_and(|a| a.selection.is_some() && a.catalog_hash.is_some());
        let admitted = c.admission.as_ref().is_some_and(|a| a.actual.is_some());
        let live_turn = c
            .turns
            .active
            .as_ref()
            .is_some_and(|a| a.native_id.is_some() && !a.interrupt_requested);
        Self {
            create_session: ok && idle && !bound && choice_ready,
            open_session: ok && idle && bound && admitted,
            authenticate: ok && !c.control.operations.is_pending(),
            select_model: ok && idle && !bound,
            submit_turn: ok && idle && bound && admitted,
            reply_interaction: ok && c.turns.active.is_some(),
            steer: ok && live_turn,
            interrupt: ok && live_turn,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    farfold_session_id: FarfoldSessionId,
    runtime: RuntimeBinding,
    working_copy_id: WorkingCopyId,
    cwd: PathBuf,
    native_thread_id: String,
    native_tree_id: String,
}
fn target(store: &HostStore, id: &FarfoldSessionId) -> Result<Target, String> {
    let t = store.session_open_target(id)?;
    if !is_binding(&t.binding())
        || t.locator_kind != Some(NativeSessionLocatorKind::CodexTreeSessionId)
    {
        return Err("Codex ACP workspace requires its original persisted adapter binding".into());
    }
    Ok(Target {
        farfold_session_id: id.clone(),
        runtime: t.binding(),
        working_copy_id: t.working_copy_id,
        cwd: t.working_copy_path,
        native_thread_id: t.native_session_id.to_string(),
        native_tree_id: t
            .locator_value
            .ok_or("Original native tree identity missing")?,
    })
}
pub(crate) fn is_binding(binding: &RuntimeBinding) -> bool {
    binding.product_id.as_str() == "codex" && binding.adapter_id.as_str() == "codex-acp-stdio-v1"
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Disconnected,
    Connected,
    Unknown,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTurn {
    context: turns::Context,
    native_turn_id: Option<String>,
    stop_requested: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    target: Option<Target>,
    scope: Option<Scope>,
    connection_state: ConnectionState,
    capabilities: Capabilities,
    blocked_reason: &'static str,
    // Safe state only: no login ID, URL, code, key, account identity or raw error.
    configure_phase: Option<configure::Phase>,
    admission: Option<admission::Snapshot>,
    active_turn: Option<ActiveTurn>,
}

impl configure::Runtime {
    pub fn workspace_snapshot(
        &self,
        store: &HostStore,
        id: Option<&FarfoldSessionId>,
    ) -> Result<Snapshot, String> {
        self.controller.exclusive(|| {
            let target = id.map(|id| target(store, id)).transpose()?;
            let mut snapshot = Snapshot {
                target,
                scope: None,
                connection_state: ConnectionState::Disconnected,
                capabilities: Capabilities::closed(),
                blocked_reason: BLOCKED_REASON,
                configure_phase: None,
                admission: None,
                active_turn: None,
            };
            let handle = match &*self
                .inner
                .state
                .lock()
                .map_err(|_| "ACP lifecycle unavailable")?
            {
                AcpLifecycle::Stopped => return Ok(snapshot),
                AcpLifecycle::Running(handle) => handle.clone(),
            };
            let c = handle.lock().map_err(|_| "ACP workspace unavailable")?;
            if let Some(t) = &snapshot.target {
                if c.scope.binding()? != t.runtime {
                    return Ok(snapshot);
                }
            } else if c.threads.bound.is_some() {
                // The unbound new-Session page never borrows another Session's state.
                return Ok(snapshot);
            }
            snapshot.scope = Some(c.scope.clone());
            if c.transport.failure().is_some()
                || c.turns.unknown
                || snapshot.target.as_ref().is_some_and(|t| {
                    turns::target(store, &c, &c.scope, &t.farfold_session_id).is_err()
                })
            {
                snapshot.connection_state = ConnectionState::Unknown;
                return Ok(snapshot);
            }
            snapshot.connection_state = ConnectionState::Connected;
            snapshot.configure_phase = c.control.workspace_phase();
            snapshot.admission = c.admission.clone();
            snapshot.active_turn = c.turns.active.as_ref().and_then(|active| {
                snapshot.target.as_ref().and_then(|t| {
                    (active.context.farfold_session_id == t.farfold_session_id).then(|| {
                        ActiveTurn {
                            context: active.context.clone(),
                            native_turn_id: active.native_id.clone(),
                            stop_requested: active.interrupt_requested,
                        }
                    })
                })
            });
            snapshot.capabilities = Capabilities::for_connection(&c, snapshot.target.is_some());
            Ok(snapshot)
        })
    }

    pub(crate) fn require_workspace_open(
        &self,
        store: &HostStore,
        id: &FarfoldSessionId,
    ) -> Result<(), String> {
        // Resolve the original shared target even when unavailable; never call direct Codex.
        self.workspace_snapshot(store, Some(id))?;
        Err("Codex ACP 会话只能通过自有 ACP Session 入口打开".into())
    }
}

#[tauri::command]
pub async fn host_codex_acp_workspace(
    app: AppHandle,
    farfold_session_id: Option<FarfoldSessionId>,
) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<configure::Runtime>()
            .workspace_snapshot(&app.state::<HostStore>(), farfold_session_id.as_ref())
            .map_err(|_| "Codex ACP 状态无法核对；未尝试旧连接或原生操作".to_string())
    })
    .await
    .map_err(|_| "Codex ACP 状态读取被中断".to_string())?
}

#[cfg(test)]
mod tests;
