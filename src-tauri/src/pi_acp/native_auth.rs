use super::admission::*;
use super::turns::*;
use super::workspace::*;
use super::*;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    ApiKey,
    Oauth,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthOperation {
    #[default]
    Login,
    Logout,
}

// Deliberately no Debug: reply values and SDK interaction text are ephemeral secrets.
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AuthCommand {
    Start {
        provider_id: String,
        auth_type: AuthType,
        #[serde(default)]
        operation: AuthOperation,
    },
    Status {
        flow_id: String,
    },
    Cancel {
        flow_id: String,
    },
    Reply {
        flow_id: String,
        prompt_id: String,
        value: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAuthInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    runtime_generation: u64,
    command: AuthCommand,
}

#[derive(Clone)]
pub(crate) struct AuthFlowBinding {
    flow_id: String,
    provider_id: String,
    auth_type: AuthType,
    operation: AuthOperation,
    token: Option<u64>,
    source: Option<PiModelSource>,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    Running,
    Cancelling,
    Succeeded,
    Cancelled,
    Failed,
    Unknown,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialState {
    NotAttempted,
    Committed,
    Unknown,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RefreshState {
    NotAttempted,
    Confirmed,
    Unknown,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Choice {
    id: String,
    label: String,
    description: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum AuthPrompt {
    Text {
        message: String,
        placeholder: Option<String>,
    },
    Secret {
        message: String,
        placeholder: Option<String>,
    },
    ManualCode {
        message: String,
        placeholder: Option<String>,
    },
    Select {
        message: String,
        options: Vec<Choice>,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PromptEnvelope {
    id: String,
    value: AuthPrompt,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct InfoLink {
    url: String,
    label: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum AuthNotice {
    Info {
        message: String,
        links: Option<Vec<InfoLink>>,
    },
    Progress {
        message: String,
    },
    AuthUrl {
        url: String,
        instructions: Option<String>,
    },
    DeviceCode {
        user_code: String,
        verification_uri: String,
        interval_seconds: Option<f64>,
        expires_in_seconds: Option<f64>,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthSnapshot {
    version: u64,
    session_id: String,
    flow_id: String,
    provider_id: String,
    auth_type: AuthType,
    operation: AuthOperation,
    state: AuthState,
    credential_state: CredentialState,
    refresh_state: RefreshState,
    prompt: Option<PromptEnvelope>,
    notice: Option<AuthNotice>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
}

impl AuthSnapshot {
    fn confirmed(&self) -> bool {
        self.state == AuthState::Succeeded
    }
    fn not_attempted(&self) -> bool {
        matches!(self.state, AuthState::Failed | AuthState::Cancelled)
            && self.credential_state == CredentialState::NotAttempted
    }
    fn validate(&self, native: &NativeSessionId, binding: &AuthFlowBinding) -> Result<(), String> {
        let valid_url = |value: &str| {
            tauri::Url::parse(value).is_ok_and(|url| {
                url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
            })
        };
        let valid_notice = match &self.notice {
            Some(AuthNotice::AuthUrl { url, .. }) => valid_url(url),
            Some(AuthNotice::DeviceCode {
                verification_uri, ..
            }) => valid_url(verification_uri),
            Some(AuthNotice::Info {
                links: Some(links), ..
            }) => links.len() <= 16 && links.iter().all(|link| valid_url(&link.url)),
            _ => true,
        };
        let terminal = !matches!(self.state, AuthState::Running | AuthState::Cancelling);
        if self.version != 1
            || self.session_id != native.as_str()
            || !valid_id(&self.flow_id)
            || (!binding.flow_id.is_empty() && self.flow_id != binding.flow_id)
            || self.provider_id != binding.provider_id
            || self.auth_type != binding.auth_type
            || self.operation != binding.operation
            || !valid_notice
            || (terminal && (self.prompt.is_some() || self.notice.is_some()))
            || (self.confirmed()
                && (self.credential_state != CredentialState::Committed
                    || self.refresh_state != RefreshState::Confirmed))
            || (matches!(self.state, AuthState::Failed | AuthState::Cancelled)
                && !self.not_attempted())
            || self
                .prompt
                .as_ref()
                .is_some_and(|prompt| !valid_id(&prompt.id))
        {
            return Err("Pi 认证响应身份或提交状态不一致".into());
        }
        Ok(())
    }
}

pub(super) fn authenticate(
    controller: &crate::session_controller::HostSessionController,
    runtime: &PiAcpRuntime,
    store: &HostStore,
    router: &RuntimeEventRouter,
    turns: &crate::turn_coordinator::TurnCoordinator,
    input: NativeAuthInput,
) -> Result<AuthSnapshot, String> {
    match &input.command {
        AuthCommand::Start { provider_id, .. }
            if !valid_id(provider_id) || provider_id.starts_with("farfold-managed-") =>
        {
            return Err("Pi 原生认证 Provider 身份无效".into());
        }
        AuthCommand::Status { flow_id } | AuthCommand::Cancel { flow_id } if !valid_id(flow_id) => {
            return Err("Pi 认证流程身份无效".into());
        }
        AuthCommand::Reply {
            flow_id,
            prompt_id,
            value,
        } if !valid_id(flow_id) || !valid_id(prompt_id) || value.len() > 65536 => {
            return Err("Pi 认证回复无效或超过限制".into());
        }
        _ => {}
    }
    let gate = settlement_gate(runtime)?;
    let _guard = gate.lock().map_err(|_| "Pi 认证操作锁不可用")?;
    let starting = matches!(input.command, AuthCommand::Start { .. });
    let (target, binding, handle, dispatched) = controller.exclusive(|| {
        let target = store.session_open_target(&input.farfold_session_id)?;
        if target.native_session_id != input.native_session_id
            || turns.has_active_session(&input.farfold_session_id)?
        {
            return Err("Pi 认证目标不匹配或任务尚未结束".into());
        }
        let handle = runtime.connection()?;
        let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
        require_live_target(&connection, &target)?;
        if connection.generation != input.runtime_generation {
            return Err("Pi 认证代次已失效".into());
        }
        connection.update_events(router)?;
        let binding = match &input.command {
            AuthCommand::Start {
                provider_id,
                auth_type,
                operation,
            } => {
                let source = if connection
                    .native_first_use
                    .as_ref()
                    .is_some_and(|state| state.ready_source().is_none())
                {
                    None
                } else {
                    Some(verify_prompt_connection(
                        &connection,
                        &target,
                        input.runtime_generation,
                    )?)
                };
                if connection.profile_integrity.is_none() {
                    return Err("Pi 认证需要稳定自有 profile".into());
                }
                let unresolved = connection.transport.has_unresolved_work()?;
                let token = connection.operations.begin(
                    AcpSessionOperationKind::Configure,
                    Some(input.native_session_id.to_string()),
                    Some(input.native_session_id.as_str()),
                    unresolved,
                )?;
                AuthFlowBinding {
                    flow_id: String::new(),
                    provider_id: provider_id.clone(),
                    auth_type: *auth_type,
                    operation: *operation,
                    token: Some(token),
                    source,
                }
            }
            AuthCommand::Status { flow_id }
            | AuthCommand::Cancel { flow_id }
            | AuthCommand::Reply { flow_id, .. } => connection
                .auth_flow
                .as_ref()
                .filter(|flow| &flow.flow_id == flow_id)
                .cloned()
                .ok_or("Pi 认证回复属于旧流程")?,
        };
        let mut params = serde_json::to_value(&input.command).map_err(|_| "Pi 认证请求编码失败")?;
        params["sessionId"] = json!(input.native_session_id);
        let dispatched = connection
            .transport
            .begin_request_unbounded("_pi/auth", params);
        drop(connection);
        Ok((target, binding, handle, dispatched))
    })?;
    let response = dispatched.and_then(|pending| pending.wait_timeout(REQUEST_TIMEOUT));
    let result = (|| {
        if starting
            && matches!(
                response,
                Err(AcpDispatchError::NotSent(_))
                    | Err(AcpDispatchError::Rejected {
                        code: -32602..=-32600,
                        ..
                    })
            )
        {
            controller.exclusive(|| {
                let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
                require_live_target(&connection, &target)?;
                connection
                    .operations
                    .complete(binding.token.ok_or("Pi 认证操作身份缺失")?)?;
                Ok(())
            })?;
            return Err("Pi 认证未发送或已在开始前拒绝".into());
        }
        let response = response.map_err(|_| "Pi 认证请求结果未知；不会自动重发")?;
        if response.to_string().len() > 128 * 1024 {
            return Err("Pi 认证响应超过限制".into());
        }
        let snapshot: AuthSnapshot =
            serde_json::from_value(response).map_err(|_| "Pi 认证响应格式无效")?;
        snapshot.validate(&input.native_session_id, &binding)?;
        let state = if snapshot.confirmed() && binding.token.is_some() {
            Some(read_workspace_snapshot(
                runtime,
                store,
                router,
                PiAcpWorkspaceInput {
                    farfold_session_id: input.farfold_session_id.clone(),
                    native_session_id: input.native_session_id.clone(),
                    runtime_generation: input.runtime_generation,
                    section: PiWorkspaceSection::State,
                },
            )?)
        } else {
            None
        };
        let configuration = if state.is_some() {
            Some(read_workspace_snapshot(
                runtime,
                store,
                router,
                PiAcpWorkspaceInput {
                    farfold_session_id: input.farfold_session_id.clone(),
                    native_session_id: input.native_session_id.clone(),
                    runtime_generation: input.runtime_generation,
                    section: PiWorkspaceSection::Configuration,
                },
            )?)
        } else {
            None
        };
        controller.exclusive(|| {
            let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
            require_live_target(&connection, &target)?;
            if connection.generation != input.runtime_generation {
                return Err("Pi 认证回执属于旧代次".into());
            }
            let mut binding = binding;
            binding.flow_id = snapshot.flow_id.clone();
            if let Some(state) = state {
                let native = connection.native.as_ref().ok_or("Pi 原生身份缺失")?;
                verify_idle_native_session(&state, native)?;
                connection
                    .profile_integrity
                    .as_ref()
                    .ok_or("Pi profile 校验缺失")?
                    .verify()?;
                let options = configuration
                    .as_ref()
                    .ok_or("Pi 认证刷新后的模型目录缺失")?;
                if let Some(source) = &binding.source {
                    if idle_model_source(&state, native, &connection.managed_versions)? != *source {
                        return Err("Pi 认证刷新后当前模型发生变化，需重新核对".into());
                    }
                    if observed_model_source(options, &connection.managed_versions)? != *source {
                        return Err("Pi 认证刷新后的模型目录与实际模型不一致".into());
                    }
                } else if connection
                    .native_first_use
                    .as_ref()
                    .is_none_or(|first_use| first_use.ready_source().is_some())
                {
                    return Err("Pi 原生首次使用认证状态已失效".into());
                }
                connection.config_options = options.clone();
                if connection.native_first_use.is_some() {
                    connection.native_first_use = Some(match binding.operation {
                        AuthOperation::Login => {
                            PiNativeFirstUseState::ModelSelectionRequired { version: 1 }
                        }
                        AuthOperation::Logout => {
                            PiNativeFirstUseState::AuthenticationRequired { version: 1 }
                        }
                    });
                    connection.confirmed_native_selection = None;
                }
            }
            if (snapshot.confirmed() || snapshot.not_attempted())
                && let Some(token) = binding.token.take()
            {
                connection.operations.complete(token)?;
            }
            if snapshot.state == AuthState::Unknown {
                connection.last_error =
                    Some("Pi 认证或刷新结果未确认；请断开后恢复核对，不会自动重试".into());
            }
            connection.auth_flow = Some(binding);
            Ok(())
        })?;
        Ok(snapshot)
    })();
    if result.is_err()
        && let Ok(mut connection) = handle.lock()
        && connection.operations.is_config_pending()
    {
        connection.last_error = Some("Pi 认证操作未确认；凭据可能已改变，请断开后恢复核对".into());
    }
    result
}

#[tauri::command]
pub async fn pi_acp_native_auth(
    app: AppHandle,
    input: NativeAuthInput,
) -> Result<AuthSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        authenticate(
            &app.state::<crate::session_controller::HostSessionController>(),
            &app.state::<PiAcpRuntime>(),
            &app.state::<HostStore>(),
            &app.state::<RuntimeEventRouter>(),
            &app.state::<crate::turn_coordinator::TurnCoordinator>(),
            input,
        )
    })
    .await
    .map_err(|_| "Pi 认证操作被中断".to_string())?
}
