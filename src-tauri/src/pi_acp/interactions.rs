use super::*;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PiAcpDialogResponseInput {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) runtime_generation: u64,
    pub(crate) request_id: String,
    pub(crate) native_request_id: String,
    pub(crate) answer: crate::pi_acp_interactions::PiAcpDialogAnswer,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PiAcpInterventionKind {
    Steer,
    FollowUp,
}

impl PiAcpInterventionKind {
    pub(crate) fn delivery(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "follow_up",
        }
    }

    fn method(self) -> &'static str {
        match self {
            Self::Steer => "_pi/steer",
            Self::FollowUp => "_pi/follow_up",
        }
    }
}

pub(crate) fn begin_intervention(
    runtime: &PiAcpRuntime,
    target: &SessionOpenTarget,
    generation: u64,
    kind: PiAcpInterventionKind,
    message: &str,
) -> Result<crate::acp_transport::AcpPendingResponse, AcpDispatchError> {
    let handle = runtime
        .connection()
        .map_err(|_| AcpDispatchError::NotSent("Pi ACP 未连接"))?;
    let connection = handle
        .lock()
        .map_err(|_| AcpDispatchError::NotSent("Pi ACP 连接不可用"))?;
    require_live_target(&connection, target)
        .map_err(|_| AcpDispatchError::NotSent("Pi 插话目标已失效"))?;
    if connection.generation != generation || connection.operations.is_pending() {
        return Err(AcpDispatchError::NotSent(
            "Pi 插话属于旧连接代次或切换中的会话",
        ));
    }
    connection.transport.begin_request_unbounded(
        kind.method(),
        json!({"sessionId":target.native_session_id,"message":message}),
    )
}

pub(crate) fn respond_dialog(
    controller: &crate::session_controller::HostSessionController,
    runtime: &PiAcpRuntime,
    store: &HostStore,
    router: &RuntimeEventRouter,
    interactions: &crate::interaction_registry::InteractionRegistry,
    input: PiAcpDialogResponseInput,
) -> Result<(), String> {
    controller.exclusive(|| {
        let target = store.session_open_target(&input.farfold_session_id)?;
        if target.native_session_id != input.native_session_id {
            return Err("Pi 对话回答不属于此原生会话".into());
        }
        let handle = runtime.connection()?;
        let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
        require_live_target(&connection, &target)?;
        if connection.generation != input.runtime_generation || connection.operations.is_pending() {
            return Err("Pi 对话回答属于旧连接代次或切换中的会话".into());
        }
        connection.update_events(router)?;
        let dialog = interactions
            .pi_acp_dialog_by_native_id(
                &connection.binding,
                connection.generation,
                input.native_session_id.as_str(),
                &input.native_request_id,
            )?
            .filter(|dialog| dialog.request_key == input.request_id)
            .ok_or("Pi 原生对话已撤销、已回复或请求身份不匹配")?;
        let answer = dialog.answer(&input.answer)?;
        interactions.begin_response(
            connection.binding.clone(),
            connection.generation,
            &input.request_id,
            Some(input.native_session_id.as_str()),
        )?;
        let result = connection
            .transport
            .respond_client_request(&input.request_id, answer);
        interactions.finish_response(
            connection.binding.clone(),
            connection.generation,
            &input.request_id,
            !matches!(result, Err(AcpDispatchError::NotSent(_))),
        )?;
        result.map_err(|error| error.to_string())
    })
}

#[tauri::command]
pub async fn pi_acp_respond_dialog(
    app: AppHandle,
    input: PiAcpDialogResponseInput,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        respond_dialog(
            &app.state::<crate::session_controller::HostSessionController>(),
            &app.state::<PiAcpRuntime>(),
            &app.state::<HostStore>(),
            &app.state::<RuntimeEventRouter>(),
            &app.state::<crate::interaction_registry::InteractionRegistry>(),
            input,
        )
    })
    .await
    .map_err(|_| "Pi 原生对话回答被中断".to_string())?
}
