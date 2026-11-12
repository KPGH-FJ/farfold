//! Explicit browser-tool attachment, separate from page permission. Only the
//! original operation is observed after an uncertain result; no resend loop.
use super::*;
use crate::{
    acp_client::{manager::AcpManager, session_tool_changes as changes},
    meta_store::MetaStore,
};
use std::time::Duration;

#[derive(Clone)]
pub(super) struct Attempt {
    manager: AcpManager,
    store: MetaStore,
    pub(super) target: ShareTarget,
    connection_id: String,
    operation_id: String,
    descriptor: serde_json::Value,
    pub(super) confirmed: bool,
    exact_key: Option<String>,
    remove_operation: Option<String>,
    pub(super) safe_failed: bool,
    pub(super) removed: bool,
    pub(super) unknown: bool,
}
pub(super) enum Transport {
    Stdio,
    #[cfg(target_os = "macos")]
    Local(transport::PeerCheck),
}
pub(super) enum Launch {
    Stdio(transport::HelperLaunch),
    #[cfg(target_os = "macos")]
    Local(transport::LocalEndpoint),
}
#[allow(clippy::too_many_arguments)]
pub(super) fn start_transport(
    source: Transport,
    app: AppHandle,
    page: SharedPage,
    ready: transport::Callback,
    closed: transport::Closed,
    permission: transport::Permission,
    invalidated: transport::Invalidated,
) -> Result<(TransportHandle, Launch), String> {
    match source {
        Transport::Stdio => transport::start(app, page, ready, closed, permission, invalidated)
            .map(|(h, l)| (h, Launch::Stdio(l))),
        #[cfg(target_os = "macos")]
        Transport::Local(peer) => {
            transport::start_uds(app, page, ready, closed, permission, invalidated, peer)
                .map(|(h, l)| (h, Launch::Local(l)))
        }
    }
}
fn confirm(owner: &ToolSession) {
    let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner());
    if state.ended || state.phase == CLOSED {
        return;
    }
    let ready = state.ready
        && (state.phase == CONNECTING
            || (state.phase == STOPPING
                && state.retiring.is_none()
                && state
                    .connection
                    .as_ref()
                    .is_some_and(|a| a.remove_operation.is_none())));
    let Some(attempt) = &mut state.connection else {
        return;
    };
    if attempt.removed || attempt.safe_failed || (attempt.confirmed && !attempt.unknown && !ready) {
        return;
    }
    attempt.confirmed = true;
    attempt.unknown = false;
    if ready {
        state.phase = READY;
    }
    state.revision = state.revision.saturating_add(1);
    drop(state);
    owner.changed();
}
fn safe_failure(owner: &Arc<ToolSession>) {
    let changed = {
        let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut state.connection {
            Some(a) if !a.safe_failed => {
                a.safe_failed = true;
                true
            }
            _ => false,
        }
    };
    if changed {
        owner.revoke();
        detach(owner);
    }
}
fn observe(owner: &Arc<ToolSession>, reply: &changes::Reply) {
    match reply {
        Ok(value)
            if value.state == changes::State::Ready
                && value.persistence == changes::Persistence::Confirmed =>
        {
            confirm(owner)
        }
        Ok(value)
            if value.state == changes::State::Failed && value.settled && !value.mutation_sent =>
        {
            safe_failure(owner)
        }
        Err(error) if error.not_dispatched == Some(true) => safe_failure(owner),
        Ok(value)
            if value.state == changes::State::Unknown || (value.settled && value.mutation_sent) =>
        {
            mark_unknown(owner)
        }
        Err(_) => mark_unknown(owner),
        _ => {}
    }
}
fn mark_unknown(owner: &ToolSession) {
    let changed = {
        let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut state.connection {
            Some(a) if !a.unknown && !a.removed && !a.safe_failed => {
                a.unknown = true;
                state.revision = state.revision.saturating_add(1);
                true
            }
            _ => false,
        }
    };
    if changed {
        owner.changed();
    }
}
fn detach(owner: &Arc<ToolSession>) {
    let attempt = owner.state.lock().ok().and_then(|s| s.connection.clone());
    if let Some(a) = attempt {
        let expected: Arc<dyn SessionMcpOwner> = owner.clone();
        let _ = a.manager.browser_uds_detach(
            &a.target.agent_id,
            Path::new(&a.target.cwd),
            &a.target.native_session_id,
            &a.connection_id,
            &expected,
        );
    }
}
pub(super) async fn refresh_status(
    app: &AppHandle,
    sharing: &BrowserSharing,
    target: &ShareTarget,
    task: &str,
    label: &str,
    info: &mut ShareInfo,
) -> Result<(), String> {
    if let Some(owner) = sharing.entry(target, task)? {
        let attempt = owner
            .state
            .lock()
            .map_err(|_| "无法读取网页连接")?
            .connection
            .clone();
        if let Some(a) = attempt {
            if !a.confirmed || a.remove_operation.is_some() {
                let reply = a.manager.change_status(
                    &target.agent_id,
                    Path::new(&target.cwd),
                    &target.native_session_id,
                    &a.connection_id,
                    a.remove_operation.as_deref().unwrap_or(&a.operation_id),
                );
                if a.remove_operation.is_some() {
                    match &reply {
                        Ok(value)
                            if value.state == changes::State::Ready
                                && value.persistence == changes::Persistence::Confirmed =>
                        {
                            removed(&owner)
                        }
                        Ok(value) if value.state == changes::State::Pending => {}
                        _ => mark_unknown(&owner),
                    }
                } else {
                    observe(&owner, &reply);
                }
            }
            *info = owner.info(task, label);
            return Ok(());
        }
        return Ok(());
    }
    let manager = app.state::<AcpManager>();
    let store = app.state::<MetaStore>();
    let eligibility = manager
        .browser_uds_eligibility(
            &store,
            &target.agent_id,
            Path::new(&target.cwd),
            &target.native_session_id,
        )
        .await;
    info.connection_available = Some(eligibility.connection_id.is_some());
    info.connection_reason = Some(eligibility.reason);
    info.connection_id = eligibility.connection_id;
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn browser_share_connect(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserSharing>,
    task_key: String,
    label: String,
    target: ShareTarget,
    connection_id: String,
    operation_id: String,
) -> Result<ShareInfo, String> {
    require_main(&webview)?;
    connect(
        &app,
        &state,
        &target,
        &task_key,
        &label,
        &connection_id,
        &operation_id,
    )
    .await
}
async fn connect(
    app: &AppHandle,
    sharing: &BrowserSharing,
    target: &ShareTarget,
    task: &str,
    label: &str,
    connection_id: &str,
    operation_id: &str,
) -> Result<ShareInfo, String> {
    if sharing.entry(target, task)?.is_some() {
        return Err("网页工具连接已开始，请检查原结果".into());
    }
    let page = app.state::<BrowserWorkspace>().permission_page(task)?;
    if page.label != label || page.phase != "ready" {
        return Err("网页已变化，请重新查看".into());
    }
    let manager = app.state::<AcpManager>().inner().clone();
    let store = app.state::<MetaStore>().inner().clone();
    let eligibility = manager
        .browser_uds_eligibility(
            &store,
            &target.agent_id,
            Path::new(&target.cwd),
            &target.native_session_id,
        )
        .await;
    if eligibility.connection_id.as_deref() != Some(connection_id) {
        return Err("请先打开已保存的对话，等待当前任务结束后再连接网页工具".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (operation_id, manager, store);
        Err("当前接入尚未支持连接网页工具".into())
    }
    #[cfg(target_os = "macos")]
    {
        let identity = manager.browser_uds_owner(
            &target.agent_id,
            Path::new(&target.cwd),
            &target.native_session_id,
            connection_id,
        )?;
        let peer = identity.clone();
        let attempt = Attempt {
            manager: manager.clone(),
            store: store.clone(),
            target: target.clone(),
            connection_id: connection_id.into(),
            operation_id: operation_id.into(),
            descriptor: serde_json::Value::Null,
            confirmed: false,
            exact_key: None,
            remove_operation: None,
            safe_failed: false,
            removed: false,
            unknown: false,
        };
        let (owner, launch) = sharing.prepare_inner(
            app,
            &target.agent_id,
            Path::new(&target.cwd),
            Some(attempt),
            Transport::Local(Arc::new(move |stream| peer.peer(stream))),
        )?;
        let Launch::Local(endpoint) = launch else {
            unreachable!("requested direct transport")
        };
        let descriptor = match identity.descriptor(&endpoint.name, &endpoint.path, endpoint.uri) {
            Ok(value) => value,
            Err(error) => {
                safe_failure(&owner);
                return Err(error);
            }
        };
        {
            let mut state = owner.state.lock().map_err(|_| "无法准备网页工具")?;
            state
                .connection
                .as_mut()
                .expect("direct attempt")
                .descriptor = descriptor.clone();
        }
        if let Err(error) = identity.attach(owner.clone()) {
            safe_failure(&owner);
            return Err(error.message.into());
        }
        let completion_owner = owner.clone();
        let completion = Arc::new(move |saved: bool, key: &str| {
            if saved {
                confirm(&completion_owner);
                return Ok(());
            }
            if !completion_owner
                .transport
                .get()
                .is_some_and(TransportHandle::locally_ready)
            {
                return Err(changes::Code::InvalidResponse.into());
            }
            if key.is_empty() {
                return Err(changes::Code::InvalidResponse.into());
            }
            let mut state = completion_owner
                .state
                .lock()
                .map_err(|_| changes::Code::Changed)?;
            state
                .connection
                .as_mut()
                .ok_or(changes::Code::Changed)?
                .exact_key = Some(key.into());
            Ok(())
        });
        let reply = manager
            .change_start_with_browser(
                &store,
                &target.agent_id,
                Path::new(&target.cwd),
                &target.native_session_id,
                connection_id,
                operation_id,
                changes::Change::AddLocalBrowser { descriptor },
                tokio::time::Instant::now() + Duration::from_secs(10),
                Some(completion),
            )
            .await;
        observe(&owner, &reply);
        Ok(owner.info(task, label))
    }
}

/// Idle shutdown will remove exact owned descriptors before ending processes.
/// An error does not claim persistent removal and may be handled by the existing
/// explicit "end active work" exit policy; local page output is always revoked.
pub(crate) async fn prepare_shutdown(app: &AppHandle) -> Result<(), String> {
    let sharing = app.state::<BrowserSharing>();
    let owners: Vec<_> = sharing
        .entries()
        .into_iter()
        .filter(|owner| {
            owner
                .state
                .lock()
                .map(|s| s.connection.is_some())
                .unwrap_or(true)
        })
        .collect();
    // Every local permission/output owner is retired before any bounded remote
    // cleanup can fail. Confirmed forced exit never skips a later page grant.
    retire_connections(&owners);
    let outcome = tokio::time::timeout(Duration::from_secs(12), async {
        let mut first = None;
        for owner in &owners {
            if let Err(error) = close_owner(owner).await
                && first.is_none()
            {
                first = Some(error);
            }
        }
        first.map_or(Ok(()), Err)
    })
    .await;
    if outcome.is_err() {
        for owner in &owners {
            let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner());
            if !state.ended {
                state.phase = STOP_FAILED;
            }
            drop(state);
            owner.changed();
        }
    }
    outcome.map_err(|_| "网页工具关闭尚未确认，请检查原结果".to_owned())?
}
pub(super) async fn close_owner(owner: &Arc<ToolSession>) -> Result<(), String> {
    let _operation = owner.operation.lock().await;
    let Some(mut attempt) = owner
        .state
        .lock()
        .map_err(|_| "无法读取网页连接")?
        .connection
        .clone()
    else {
        return Ok(());
    };
    owner.stop_locked().await?;
    retire_connections(std::slice::from_ref(owner));
    if attempt.safe_failed || attempt.removed {
        return Ok(());
    }
    if !attempt.confirmed {
        mark_unknown(owner);
        return Err("网页工具连接结果尚未确认，请先检查原结果".into());
    }
    let key = attempt.exact_key.clone().ok_or("网页工具归属尚未确认")?;
    if attempt.remove_operation.is_none() {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| "无法准备关闭网页工具")?;
        let id: String = bytes.iter().map(|v| format!("{v:02x}")).collect();
        attempt.remove_operation = Some(id.clone());
        owner
            .state
            .lock()
            .map_err(|_| "无法读取网页连接")?
            .connection
            .as_mut()
            .ok_or("网页连接已变化")?
            .remove_operation = Some(id);
    }
    let operation = attempt.remove_operation.as_ref().expect("assigned");
    let completed_owner = owner.clone();
    let completion = Arc::new(move |saved: bool, _key: &str| {
        if saved {
            removed(&completed_owner);
        }
        Ok(())
    });
    let reply = attempt
        .manager
        .change_start_with_browser(
            &attempt.store,
            &attempt.target.agent_id,
            Path::new(&attempt.target.cwd),
            &attempt.target.native_session_id,
            &attempt.connection_id,
            operation,
            changes::Change::RemoveLocalBrowser {
                key,
                descriptor: attempt.descriptor.clone(),
            },
            tokio::time::Instant::now() + Duration::from_secs(10),
            Some(completion),
        )
        .await;
    match reply {
        Ok(value)
            if value.state == changes::State::Ready
                && value.persistence == changes::Persistence::Confirmed =>
        {
            removed(owner);
            Ok(())
        }
        Err(error) if error.not_dispatched == Some(true) => {
            restore_after_unsent_remove(owner);
            Err(error.message.into())
        }
        Ok(value)
            if value.state == changes::State::Failed && !value.mutation_sent && value.settled =>
        {
            restore_after_unsent_remove(owner);
            Err("网页工具尚未关闭，请等待当前任务结束".into())
        }
        _ => {
            mark_unknown(owner);
            Err("网页工具关闭尚未确认，请检查原结果，不要重复修改".into())
        }
    }
}

fn removed(owner: &Arc<ToolSession>) {
    let changed = {
        let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut state.connection {
            Some(a) if !a.removed => {
                a.removed = true;
                a.unknown = false;
                true
            }
            _ => false,
        }
    };
    if changed {
        owner.revoke();
        detach(owner);
    }
}
fn restore_after_unsent_remove(owner: &ToolSession) {
    if let Ok(mut state) = owner.state.lock() {
        if let Some(attempt) = &mut state.connection {
            attempt.remove_operation = None;
            attempt.unknown = false;
        }
        if !state.ended && state.ready {
            state.phase = READY;
        }
    }
    owner.changed();
}
fn retire_connections(owners: &[Arc<ToolSession>]) {
    for owner in owners {
        let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.cancel_permission("网页读取已停止");
        if let Some(page) = owner.page.lock().unwrap_or_else(|e| e.into_inner()).take() {
            page.revoke();
            state.retiring = Some(page);
        }
        state.retire_screenshot();
        state.phase = STOPPING;
        state.revision = state.revision.saturating_add(1);
        drop(state);
        owner.changed();
    }
}
#[cfg(test)]
#[path = "connect_tests.rs"]
mod tests;
