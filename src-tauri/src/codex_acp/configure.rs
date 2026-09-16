use super::*;
use crate::{
    acp_runtime::{AcpLifecycle, AcpRuntime},
    acp_session_operations::AcpSessionOperations,
    session_controller::HostSessionController,
};
use std::sync::Mutex;
#[cfg(test)]
use std::sync::atomic::Ordering;

// No Debug: keys and temporary instructions must not enter diagnostics.
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommandInput {
    Browser,
    Device,
    ApiKey {
        key: String,
    },
    Logout,
    Status {
        operation_id: u64,
        login_id: Option<String>,
    },
    Cancel {
        operation_id: u64,
        login_id: Option<String>,
    },
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Starting,
    Waiting,
    Confirming,
    Canceling,
    Confirmed,
    Canceled,
    Failed,
    Unknown,
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Instructions {
    Browser {
        auth_url: String,
    },
    Device {
        verification_url: String,
        user_code: String,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialState {
    NotAttempted,
    Committed,
    Removed,
    Unknown,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountState {
    Unconfirmed,
    Unauthenticated,
    ApiKey,
    Chatgpt,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub scope: Scope,
    pub operation_id: u64,
    pub phase: Phase,
    pub login_id: Option<String>,
    pub credential_state: CredentialState,
    pub account_state: AccountState,
    pub payload: Option<Instructions>,
}
impl Snapshot {
    fn validate(&self, flow: &Flow, scope: &Scope) -> Result<(), String> {
        if &self.scope != scope
            || self.operation_id != flow.id
            || flow
                .login_id
                .as_ref()
                .is_some_and(|id| self.login_id.as_ref() != Some(id))
        {
            return Err("Codex Configure receipt identity mismatch".into());
        }
        if let Some(id) = &self.login_id
            && (id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)))
        {
            return Err("Codex login identity invalid".into());
        }
        if self.payload.is_some() && self.phase != Phase::Waiting {
            return Err("Instructions outside a waiting Configure operation".into());
        }
        if self.phase == Phase::Waiting && (self.payload.is_none() || self.login_id.is_none()) {
            return Err("Waiting login instructions missing".into());
        }
        if flow.device.is_some()
            && matches!(
                self.phase,
                Phase::Waiting | Phase::Confirming | Phase::Confirmed
            )
            && self.login_id.is_none()
        {
            return Err("Native login identity missing".into());
        }
        if flow.device.is_none() && (self.login_id.is_some() || self.payload.is_some()) {
            return Err("Non-browser operation returned login instructions".into());
        }
        if let Some(payload) = &self.payload {
            if !matches!(
                (flow.device, payload),
                (Some(false), Instructions::Browser { .. })
                    | (Some(true), Instructions::Device { .. })
            ) {
                return Err("Login instructions do not match the requested type".into());
            }
            let url = match payload {
                Instructions::Browser { auth_url } => auth_url,
                Instructions::Device {
                    verification_url,
                    user_code,
                } => {
                    if user_code.is_empty()
                        || user_code.len() > 128
                        || !user_code
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    {
                        return Err("Device instruction invalid".into());
                    }
                    verification_url
                }
            };
            let parsed = reqwest::Url::parse(url).map_err(|_| "Login instruction invalid")?;
            if url.len() > 8192
                || parsed.scheme() != "https"
                || !matches!(parsed.host_str(), Some("auth.openai.com" | "chatgpt.com"))
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.port().is_some()
            {
                return Err("Login instruction invalid".into());
            }
        }
        if self.phase == Phase::Confirmed
            && !flow.terminal
            && (self.account_state != flow.expected_account
                || self.payload.is_some()
                || (flow.expected_account == AccountState::Unauthenticated
                    && !matches!(self.credential_state, CredentialState::Removed))
                || (flow.expected_account != AccountState::Unauthenticated
                    && !matches!(self.credential_state, CredentialState::Committed)))
        {
            return Err("Account confirmation missing".into());
        }
        Ok(())
    }
}
struct Flow {
    expected_account: AccountState,
    device: Option<bool>,
    id: u64,
    login_id: Option<String>,
    phase: Phase,
    in_flight: bool,
    terminal: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Browser,
    Device,
    ApiKey,
    Logout,
}
// Private same-process metadata only: never cached instructions or account readiness.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredOperation {
    kind: OperationKind,
    operation_id: u64,
    login_id: Option<String>,
    phase: Phase,
    in_flight: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    scope: Scope,
    operation: Option<DiscoveredOperation>,
}
#[derive(Default)]
pub(super) struct Control {
    pub(super) operations: AcpSessionOperations,
    flow: Option<Flow>,
}
impl Control {
    pub(super) fn admission_blocked(&self) -> bool {
        self.flow
            .as_ref()
            .is_some_and(|f| f.in_flight || !f.terminal || f.phase == Phase::Unknown)
    }
    pub(super) fn workspace_phase(&self) -> Option<Phase> {
        self.flow.as_ref().map(|flow| flow.phase)
    }
}

/// Shared Host authority. Ordinary operation registration is hard-closed before dispatch.
#[derive(Default)]
pub struct Runtime {
    pub(super) inner: AcpRuntime<Connection>,
    pub(super) controller: HostSessionController,
}
impl Runtime {
    pub fn discover_configure(&self, scope: &Scope) -> Result<Discovery, String> {
        self.controller.exclusive(|| {
            let handle = self.connection()?;
            let connection = handle.lock().map_err(|_| "ACP connection unavailable")?;
            if &connection.scope != scope {
                return Err("Stale Configure discovery target".into());
            }
            let control = &connection.control;
            let operation = match &control.flow {
                None if control.operations.is_pending() => {
                    return Err("Configure ownership cannot be confirmed".into());
                }
                None => None,
                Some(flow) => {
                    let kind = match (&flow.expected_account, flow.device) {
                        (AccountState::Chatgpt, Some(false)) => OperationKind::Browser,
                        (AccountState::Chatgpt, Some(true)) => OperationKind::Device,
                        (AccountState::ApiKey, None) => OperationKind::ApiKey,
                        (AccountState::Unauthenticated, None) => OperationKind::Logout,
                        _ => return Err("Configure kind cannot be confirmed".into()),
                    };
                    if flow.id == 0 || (!flow.terminal && !control.operations.is_config_pending()) {
                        return Err("Configure ownership cannot be confirmed".into());
                    }
                    if flow.login_id.as_ref().is_some_and(|id| {
                        id.is_empty()
                            || id.len() > 128
                            || !id
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                    }) || (flow.device.is_none() && flow.login_id.is_some())
                        || (flow.device.is_some()
                            && matches!(
                                flow.phase,
                                Phase::Waiting | Phase::Confirming | Phase::Confirmed
                            )
                            && flow.login_id.is_none())
                    {
                        return Err("Configure login identity cannot be confirmed".into());
                    }
                    Some(DiscoveredOperation {
                        kind,
                        operation_id: flow.id,
                        login_id: flow.login_id.clone(),
                        phase: flow.phase,
                        in_flight: flow.in_flight,
                    })
                }
            };
            Ok(Discovery {
                scope: scope.clone(),
                operation,
            })
        })
    }
    pub(super) fn connection(&self) -> Result<Arc<Mutex<Connection>>, String> {
        match &*self
            .inner
            .state
            .lock()
            .map_err(|_| "ACP lifecycle unavailable")?
        {
            AcpLifecycle::Running(c) => Ok(c.clone()),
            AcpLifecycle::Stopped => Err("Codex ACP is stopped".into()),
        }
    }
    #[cfg(test)]
    pub fn start(&self, mut launch: Launch) -> Result<Scope, String> {
        self.start_connection(|| {
            launch.scope.generation = self
                .inner
                .generation
                .fetch_add(1, Ordering::Relaxed)
                .checked_add(1)
                .ok_or("Generation exhausted")?;
            Connection::start(launch)
        })
    }
    pub fn start_owned(
        &self,
        store: &crate::host_store::HostStore,
        input: super::profile::OwnedRequest,
    ) -> Result<Scope, String> {
        self.start_connection(|| {
            let (launch, lease) = super::profile::prepare(store, input)?;
            Connection::start_inner(launch, Some(lease))
        })
    }
    pub(super) fn start_connection(
        &self,
        start: impl FnOnce() -> Result<Connection, String>,
    ) -> Result<Scope, String> {
        self.controller.exclusive(|| {
            let _gate = self
                .inner
                .start_lock
                .lock()
                .map_err(|_| "ACP startup unavailable")?;
            if matches!(
                *self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| "ACP lifecycle unavailable")?,
                AcpLifecycle::Running(_)
            ) {
                return Err("Codex ACP connection already exists".into());
            }
            let connection = start()?;
            let scope = connection.scope.clone();
            *self
                .inner
                .state
                .lock()
                .map_err(|_| "ACP lifecycle unavailable")? =
                AcpLifecycle::Running(Arc::new(Mutex::new(connection)));
            Ok(scope)
        })
    }
    pub fn stop(&self, scope: &Scope) -> Result<(), String> {
        self.controller.exclusive(|| {
            let handle = self.connection()?;
            let mut connection = handle.lock().map_err(|_| "ACP connection unavailable")?;
            if &connection.scope != scope {
                return Err("Stale Codex stop target".into());
            }
            connection.transport.begin_stop()?;
            connection.turns.mark_unknown()?;
            connection.stop()?;
            *self
                .inner
                .state
                .lock()
                .map_err(|_| "ACP lifecycle unavailable")? = AcpLifecycle::Stopped;
            Ok(())
        })
    }
    pub fn read(&self, scope: &Scope, method: ReadMethod) -> Result<Value, String> {
        let handle = self.connection()?;
        let connection = handle.lock().map_err(|_| "ACP connection unavailable")?;
        if connection.control.operations.is_pending() {
            return Err("Codex Configure operation pending".into());
        }
        connection.read(scope, method)
    }
    pub fn configure(&self, scope: &Scope, command: CommandInput) -> Result<Snapshot, String> {
        let starting = matches!(
            command,
            CommandInput::Browser
                | CommandInput::Device
                | CommandInput::ApiKey { .. }
                | CommandInput::Logout
        );
        if let CommandInput::ApiKey { key } = &command
            && (key.is_empty() || key.len() > 65536 || key.contains(['\n', '\r', '\0']))
        {
            return Err("Invalid temporary secret".into());
        }
        let (handle, token, request_id, pending) = self.controller.exclusive(|| {
            let handle = self.connection()?;
            let mut connection = handle.lock().map_err(|_| "ACP connection unavailable")?;
            if &connection.scope != scope {
                return Err("Stale Codex Configure target".into());
            }
            let token = if starting {
                connection.admission = None;
                if connection
                    .control
                    .flow
                    .as_ref()
                    .is_some_and(|flow| flow.in_flight || flow.phase == Phase::Unknown)
                {
                    return Err("Codex Configure outcome pending or unknown".into());
                }
                let unresolved = connection.transport.has_unresolved_work()?;
                let id = connection
                    .control
                    .operations
                    .begin_connection_config(unresolved)?;
                connection.control.flow = Some(Flow {
                    expected_account: match command {
                        CommandInput::ApiKey { .. } => AccountState::ApiKey,
                        CommandInput::Logout => AccountState::Unauthenticated,
                        _ => AccountState::Chatgpt,
                    },
                    device: match command {
                        CommandInput::Browser => Some(false),
                        CommandInput::Device => Some(true),
                        _ => None,
                    },
                    id,
                    login_id: None,
                    phase: Phase::Starting,
                    in_flight: true,
                    terminal: false,
                });
                id
            } else {
                let (id, login_id) = match &command {
                    CommandInput::Status {
                        operation_id,
                        login_id,
                    }
                    | CommandInput::Cancel {
                        operation_id,
                        login_id,
                    } => (*operation_id, login_id),
                    _ => unreachable!(),
                };
                let flow = connection
                    .control
                    .flow
                    .as_mut()
                    .ok_or("No Configure operation")?;
                if flow.id != id
                    || &flow.login_id != login_id
                    || flow.in_flight
                    || (flow.terminal && !matches!(command, CommandInput::Status { .. }))
                {
                    return Err("Stale or occupied Configure operation".into());
                }
                flow.in_flight = true;
                id
            };
            let request_id = connection.control.operations.begin_config()?;
            let mut input =
                serde_json::to_value(command).map_err(|_| "Configure encoding failed")?;
            input["operationId"] = json!(token);
            let pending = connection.transport.begin_request_unbounded(
                "_codex/configure",
                json!({"scope":scope,"command":input}),
            );
            drop(connection);
            Ok((handle, token, request_id, pending))
        })?;
        let response = pending.and_then(|request| request.wait_timeout(Duration::from_secs(15)));
        self.controller.exclusive(|| {
            let current = self.connection()?;
            if !Arc::ptr_eq(&current, &handle) {
                return Err("Codex Configure generation retired".into());
            }
            let mut connection = handle.lock().map_err(|_| "ACP connection unavailable")?;
            if &connection.scope != scope
                || !connection.control.operations.is_current_config(request_id)
            {
                return Err("Codex Configure request retired".into());
            }
            let rejected = matches!(
                &response,
                Err(crate::acp_transport::AcpDispatchError::NotSent(_)
                    | crate::acp_transport::AcpDispatchError::Rejected {
                        code: -32602..=-32600,
                        ..
                    })
            );
            if starting && rejected {
                connection.control.operations.complete(token)?;
                connection.control.flow = None;
                return Err("Codex Configure not sent or explicitly rejected".into());
            }
            let result = (|| {
                let response = response.map_err(|_| "Codex Configure outcome unknown; no retry")?;
                let snapshot: Snapshot = serde_json::from_value(response)
                    .map_err(|_| "Codex Configure malformed receipt")?;
                let flow = connection
                    .control
                    .flow
                    .as_ref()
                    .ok_or("Configure operation lost")?;
                snapshot.validate(flow, scope)?;
                Ok(snapshot)
            })();
            match result {
                Ok(snapshot) => {
                    let terminal = matches!(
                        snapshot.phase,
                        Phase::Confirmed | Phase::Canceled | Phase::Failed
                    );
                    let flow = connection
                        .control
                        .flow
                        .as_mut()
                        .ok_or("Configure operation lost")?;
                    let was_terminal = flow.terminal;
                    flow.in_flight = false;
                    flow.login_id = snapshot.login_id.clone();
                    flow.phase = snapshot.phase;
                    flow.terminal = was_terminal || terminal;
                    if terminal && !was_terminal {
                        connection.control.operations.complete(token)?;
                    }
                    Ok(snapshot)
                }
                Err(error) => {
                    if let Some(flow) = &mut connection.control.flow {
                        flow.in_flight = false;
                        flow.phase = Phase::Unknown;
                    }
                    Err(error)
                }
            }
        })
    }
}

#[cfg(test)]
pub(super) mod tests;
