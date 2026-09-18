use crate::{
    acp_provider_profile::{
        ManagedAcpProviderBinding, PreparedAcpProfile, PreparedPiProfile, protect_directory,
    },
    acp_runtime::{AcpEventConnection, AcpLifecycle, AcpRuntime},
    acp_session_operations::{AcpSessionOperationKind, AcpSessionOperations},
    acp_transport::{AcpDispatchError, AcpTransport},
    host_ids::{
        ConnectionId, FarfoldSessionId, HostTurnId, NativeSessionId, RuntimeProfileId,
        derived_host_id,
    },
    host_store::{
        HostStore,
        provider_projection::{
            ProviderActiveTaskPolicy, ProviderApplyState, ProviderConnectionSource,
            ProviderRequestState, ProviderSaveState, ProviderTargetProjectionInput,
        },
        records::{
            NativeSessionLocatorKind, RuntimeConnectionKind, RuntimeDistribution,
            RuntimeRegistration,
        },
        runtime_owned_profile::{OwnedProfileLayout, RuntimeOwnedProfile},
        session_binding_index::{
            HostNavigationSnapshot, NativeSessionLocator, NativeSessionRegistrationInput,
            register_native_session, register_native_session_with_locator,
        },
        session_open::SessionOpenTarget,
    },
    managed_provider::ManagedProviderSelection,
    runtime_event_router::RuntimeEventRouter,
    runtime_registry::{
        PI_ACP_RUNTIME, RuntimeBinding, RuntimeIdentity, file_sha256, verify_managed_installation,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

const ADAPTER_VERSION: &str = "0.0.33-farfold.1";
const NODE_SHA256: &str = "5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

pub mod admission;
pub mod configure;
pub mod interactions;
pub mod native_auth;
pub mod sessions;
pub mod turns;
pub mod workspace;

#[cfg(test)]
mod tests;

// Re-export the crate-facing surface so `crate::pi_acp::X` paths stay stable.
pub(crate) use admission::provider_request_receipt;
pub(crate) use interactions::{PiAcpInterventionKind, begin_intervention};
pub(crate) use sessions::{create_host_session, open_host_session};
pub(crate) use turns::{
    PiModelSource, PiPromptModelObservation, begin_prompt_text, cancel_task, capture_prompt_model,
    verify_prompt_target, verify_provider_receipt_target, verify_task_settled, verify_task_target,
};
pub(crate) use workspace::{
    PiAcpStatus, PiAcpWorkspaceInput, PiWorkspaceSection, read_workspace, settlement_gate,
};

pub type PiAcpRuntime = AcpRuntime<PiAcpConnection>;

pub struct PiAcpConnection {
    pub(crate) transport: Arc<AcpTransport>,
    pub(crate) binding: RuntimeBinding,
    pub(crate) generation: u64,
    pub(crate) cwd: PathBuf,
    pub(crate) sessions_root: PathBuf,
    pub(crate) native: Option<PiNativeSession>,
    pub(crate) config_options: Value,
    pub(crate) managed_provider: Option<ManagedAcpProviderBinding>,
    pub(crate) managed_versions: Vec<ManagedAcpProviderBinding>,
    pub(crate) profile_integrity: Option<crate::acp_provider_profile::PiManagedProfileIntegrity>,
    pub(crate) managed_pre_file: Option<Value>,
    pub(crate) initialized_at: i64,
    pub(crate) last_error: Option<String>,
    pub(crate) dropped_events: u64,
    pub(crate) operations: AcpSessionOperations,
    pub(crate) auth_flow: Option<native_auth::AuthFlowBinding>,
    pub(crate) confirmed_native_selection: Option<PiModelSource>,
    pub(crate) native_first_use: Option<PiNativeFirstUseState>,
    pub(crate) settlement_gate: Arc<Mutex<()>>,
    pub(crate) event_pump_stop: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiNativeSession {
    pub(crate) version: u64,
    pub(crate) session_id: String,
    pub(crate) session_file: PathBuf,
    pub(crate) cwd: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PiNativeFirstUseState {
    AuthenticationRequired {
        version: u64,
    },
    ModelSelectionRequired {
        version: u64,
    },
    Ready {
        version: u64,
        provider: String,
        model_id: String,
    },
}

impl PiNativeFirstUseState {
    fn validate(&self) -> Result<(), String> {
        let (version, model) = match self {
            Self::AuthenticationRequired { version } | Self::ModelSelectionRequired { version } => {
                (*version, None)
            }
            Self::Ready {
                version,
                provider,
                model_id,
            } => (*version, Some((provider.as_str(), model_id.as_str()))),
        };
        if version != 1
            || model.is_some_and(|(provider, model)| {
                provider.is_empty()
                    || provider.len() > 200
                    || provider.contains('/')
                    || model.is_empty()
                    || format!("{provider}/{model}").len() > 512
                    || provider.chars().chain(model.chars()).any(char::is_control)
            })
        {
            return Err("Pi 原生首次使用状态无效".into());
        }
        Ok(())
    }

    fn ready_source(&self) -> Option<PiModelSource> {
        match self {
            Self::Ready {
                provider, model_id, ..
            } => Some(PiModelSource::NativeObservation {
                runtime_provider_id: provider.clone(),
                runtime_model_id: format!("{provider}/{model_id}"),
                native_model_id: model_id.clone(),
            }),
            _ => None,
        }
    }
}

pub(crate) struct PiAcpHostSessionResult {
    pub farfold_session_id: FarfoldSessionId,
    pub installation_id: String,
    pub native_session_id: String,
    pub runtime_generation: u64,
    pub runtime_ready_at: i64,
    pub opened_at: i64,
    pub navigation: HostNavigationSnapshot,
}

pub(crate) fn is_acp_binding(binding: &RuntimeBinding) -> bool {
    binding.product_id.as_str() == PI_ACP_RUNTIME.product_id
        && binding.adapter_id.as_str() == PI_ACP_RUNTIME.adapter_id
}

pub(crate) fn is_current_managed_binding(binding: &RuntimeBinding) -> bool {
    is_acp_binding(binding)
        && binding.installation_id.as_str() == PI_ACP_RUNTIME.installation_id
        && binding.runtime_build_id.as_str() == PI_ACP_RUNTIME.runtime_build_id
}

impl AcpEventConnection for PiAcpConnection {
    fn transport(&self) -> Arc<AcpTransport> {
        self.transport.clone()
    }

    fn record_event_error(&mut self, error: String) {
        self.last_error.get_or_insert(error);
    }

    fn update_events(&mut self, router: &RuntimeEventRouter) -> Result<(), String> {
        if let Some(error) = self.transport.failure() {
            self.last_error.get_or_insert(error);
        }
        let (events, dropped) = self.transport.drain_events()?;
        self.dropped_events = self.dropped_events.saturating_add(dropped);
        for event in events {
            if event.get("method").and_then(Value::as_str) == Some("session/update")
                && self.native.as_ref().is_some_and(|native| {
                    event.pointer("/params/sessionId").and_then(Value::as_str)
                        == Some(&native.session_id)
                })
                && event
                    .pointer("/params/update/sessionUpdate")
                    .and_then(Value::as_str)
                    == Some("config_option_update")
                && let Some(options) = event.pointer("/params/update/configOptions")
                && !self.operations.is_config_pending()
            {
                self.config_options = options.clone();
            }
            router.route_acp(
                self.binding.clone(),
                self.generation,
                &self.transport,
                event,
            )?;
        }
        Ok(())
    }
}

fn native_descriptor(
    response: &Value,
    requested: Option<&PiNativeSession>,
    cwd: &Path,
    root: &Path,
) -> Result<PiNativeSession, String> {
    let native: PiNativeSession = serde_json::from_value(
        response
            .pointer("/_meta/farfoldPi/nativeSession")
            .cloned()
            .ok_or("Pi ACP 缺少原生 Session 身份")?,
    )
    .map_err(|error| format!("Pi ACP Session 身份无效：{error}"))?;
    NativeSessionId::parse(&native.session_id).map_err(|error| error.to_string())?;
    if native.version != 1
        || native.cwd != cwd
        || !native.session_file.is_absolute()
        || native
            .session_file
            .extension()
            .is_none_or(|extension| extension != "jsonl")
        || response
            .get("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != native.session_id)
        || (requested.is_none()
            && response.get("sessionId").and_then(Value::as_str) != Some(&native.session_id))
        || requested.is_some_and(|expected| expected != &native)
    {
        return Err("Pi ACP 返回了不同的原生会话或 Working Copy；不会替换绑定".into());
    }
    let parent = native
        .session_file
        .parent()
        .ok_or("Pi Session 路径缺少父目录")?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !parent.starts_with(&root) || native.session_file.is_symlink() {
        return Err("Pi Session 文件不在原 Provider profile 内".into());
    }
    if native.session_file.exists() {
        validate_native_file(&native)?;
    } else if requested.is_some() {
        return Err("Pi 原生 Session 文件尚未落盘或已丢失，不能冷恢复".into());
    }
    Ok(native)
}

fn validate_native_file(native: &PiNativeSession) -> Result<(), String> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&native.session_file)
        .map_err(|_| "Pi 原生 Session 文件不可读")?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Pi Session 不是普通文件".into());
    }
    let mut head = String::new();
    BufReader::new(file.take(65537))
        .read_line(&mut head)
        .map_err(|error| error.to_string())?;
    if head.len() > 65536 {
        return Err("Pi Session 头超出限制".into());
    }
    let value: Value = serde_json::from_str(&head).map_err(|_| "Pi Session 头无效")?;
    if value.get("type").and_then(Value::as_str) != Some("session")
        || value.get("id").and_then(Value::as_str) != Some(&native.session_id)
        || value.get("cwd").and_then(Value::as_str).map(Path::new) != Some(native.cwd.as_path())
    {
        return Err("Pi Session 文件身份与原绑定不符".into());
    }
    Ok(())
}

fn register_observation(
    store: &HostStore,
    connection: &PiAcpConnection,
    title: &str,
) -> Result<FarfoldSessionId, String> {
    let native = connection
        .native
        .as_ref()
        .ok_or("Pi ACP 未绑定原生 Session")?;
    native_descriptor(
        &json!({"sessionId":native.session_id,"_meta":{"farfoldPi":{"nativeSession":native}}}),
        None,
        &connection.cwd,
        &connection.sessions_root,
    )?;
    let now = crate::host_store::now_millis();
    let binding = &connection.binding;
    store.register_runtime(&runtime_registration(binding, now))?;
    let input = NativeSessionRegistrationInput {
        native_session_id: &native.session_id,
        working_copy_path: &connection.cwd,
        title,
        created_at: now as u64,
        updated_at: now as u64,
    };
    if native.session_file.is_file() {
        validate_native_file(native)?;
        register_native_session_with_locator(
            store,
            binding.clone(),
            input,
            NativeSessionLocator {
                kind: NativeSessionLocatorKind::PiSessionFile,
                path: &native.session_file,
                allowed_root: &connection.sessions_root,
            },
        )
        .map(|(id, _)| id)
    } else {
        register_native_session(store, binding.clone(), input).map(|(id, _)| id)
    }
}

fn runtime_registration(binding: &RuntimeBinding, now: i64) -> RuntimeRegistration {
    RuntimeRegistration {
        runtime_product_id: binding.product_id.clone(),
        display_name: "Pi".into(),
        installation_id: binding.installation_id.clone(),
        runtime_build_id: binding.runtime_build_id.clone(),
        adapter_id: binding.adapter_id.clone(),
        distribution: RuntimeDistribution::Managed,
        observed_version: PI_ACP_RUNTIME.version.into(),
        artifact_sha256: PI_ACP_RUNTIME.binary_sha256.into(),
        connection_id: binding.connection_id.clone(),
        connection_label: "Pi ACP managed profile".into(),
        connection_kind: RuntimeConnectionKind::ManagedLocal,
        created_at: now,
        verified_at: now,
    }
}

fn require_live_target(
    connection: &PiAcpConnection,
    target: &SessionOpenTarget,
) -> Result<(), String> {
    require_connection_target(connection, target)?;
    if !connection.transport.is_running()? || connection.transport.failure().is_some() {
        return Err("Pi ACP 原连接已断开；需先确认停止后续接".into());
    }
    Ok(())
}

fn require_connection_target(
    connection: &PiAcpConnection,
    target: &SessionOpenTarget,
) -> Result<(), String> {
    if connection.binding != target.binding()
        || connection.cwd != target.working_copy_path
        || connection
            .native
            .as_ref()
            .is_none_or(|native| native.session_id != target.native_session_id.as_str())
    {
        return Err("Pi ACP 当前连接与所选原生 Session 不一致；不会新建替代会话".into());
    }
    Ok(())
}
