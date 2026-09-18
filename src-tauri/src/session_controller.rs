use crate::{
    host_ids::{FarfoldSessionId, HostTurnId, NativeSessionId},
    host_store::{
        HostStore,
        session_binding_index::{
            HostNavigationSnapshot, SessionMetadataUpdateResult, UpdateSessionMetadataInput,
        },
        session_open::{SessionOpenBlocker, SessionOpenTarget},
    },
    interaction_registry::InteractionRegistry,
    runtime_registry::{
        ManagedRuntimeDefinition, OPENCODE_ACP_RUNTIME, OPENCODE_RUNTIME, PI_ACP_RUNTIME,
    },
    runtime_supervisor::RuntimeSupervisor,
    turn_coordinator::TurnCoordinator,
};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct HostSessionController {
    lifecycle_command: Mutex<Option<String>>,
}

impl HostSessionController {
    pub(crate) fn exclusive<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self
            .lifecycle_command
            .lock()
            .map_err(|_| "Host Session controller is unavailable".to_string())?;
        if guard.is_some() {
            return Err("Host lifecycle is paused for maintenance".to_string());
        }
        operation()
    }

    pub(crate) fn inspect<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self
            .lifecycle_command
            .lock()
            .map_err(|_| "Host Session controller is unavailable".to_string())?;
        operation()
    }

    pub(crate) fn begin_maintenance<T>(
        &self,
        token: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        if token.len() != 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Host maintenance token is invalid".to_string());
        }
        let mut state = self
            .lifecycle_command
            .lock()
            .map_err(|_| "Host Session controller is unavailable".to_string())?;
        if state.is_some() {
            return Err("Host lifecycle maintenance is already active".to_string());
        }
        let value = operation()?;
        *state = Some(token.to_string());
        Ok(value)
    }

    pub(crate) fn finish_maintenance<T>(
        &self,
        token: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self
            .lifecycle_command
            .lock()
            .map_err(|_| "Host Session controller is unavailable".to_string())?;
        if state.as_deref() != Some(token) {
            return Err("Host lifecycle maintenance token does not match".to_string());
        }
        let value = operation()?;
        *state = None;
        Ok(value)
    }

    pub(crate) fn with_maintenance<T>(
        &self,
        token: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self
            .lifecycle_command
            .lock()
            .map_err(|_| "Host Session controller is unavailable".to_string())?;
        if state.as_deref() != Some(token) {
            return Err("Host lifecycle maintenance token does not match".to_string());
        }
        operation()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSessionOpenInput {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) options: Option<SessionStartOptions>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "runtimeProductId",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionStartOptions {
    #[serde(rename = "pi")]
    Pi {
        project_trust: Option<String>,
        #[serde(default)]
        adapter_id: Option<String>,
        managed_provider: Option<crate::managed_provider::ManagedProviderSelection>,
        #[serde(default)]
        native_first_use: bool,
    },
    #[serde(rename = "opencode")]
    OpenCode {
        #[serde(default)]
        adapter_id: Option<String>,
        managed_provider: Option<crate::managed_provider::ManagedProviderSelection>,
    },
    #[serde(rename = "codex")]
    #[allow(dead_code)]
    Codex {
        generation: u64,
        catalog_model_id: String,
        reasoning_effort: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSessionCreateInput {
    pub(crate) installation_id: String,
    pub(crate) connection_id: String,
    pub(crate) working_copy_path: String,
    pub(crate) options: SessionStartOptions,
}

impl SessionStartOptions {
    pub(crate) fn definition(&self) -> Result<ManagedRuntimeDefinition, String> {
        let definition = match self {
            SessionStartOptions::Pi {
                project_trust,
                adapter_id,
                managed_provider,
                ..
            } => {
                if project_trust
                    .as_deref()
                    .is_some_and(|value| !matches!(value, "saved" | "approve" | "ignore"))
                {
                    return Err("Unknown Pi project resource choice".to_string());
                }
                let _ = managed_provider;
                match adapter_id.as_deref() {
                    None => PI_ACP_RUNTIME,
                    Some(value) if value == PI_ACP_RUNTIME.adapter_id => PI_ACP_RUNTIME,
                    Some(_) => {
                        return Err("此 Pi 启动选项使用已移除的 RPC 适配器，不能继续".into());
                    }
                }
            }
            SessionStartOptions::OpenCode { adapter_id, .. } => match adapter_id.as_deref() {
                // The OpenCode Server adapter was removed; only the ACP adapter
                // remains a valid start option.
                None => OPENCODE_ACP_RUNTIME,
                Some(value) if value == OPENCODE_ACP_RUNTIME.adapter_id => OPENCODE_ACP_RUNTIME,
                Some(_) => return Err("Unknown OpenCode adapter".to_string()),
            },
            SessionStartOptions::Codex { .. } => {
                return Err("Codex 必须使用已登记的动态安装连接".into());
            }
        };
        Ok(definition)
    }

    pub(crate) fn for_binding(
        &self,
        definition: ManagedRuntimeDefinition,
    ) -> Result<Option<String>, String> {
        if self.definition()? != definition {
            return Err("Session options do not match its persisted Runtime binding".to_string());
        }
        Ok(match self {
            Self::Pi { project_trust, .. } => project_trust.clone(),
            Self::OpenCode { .. } => None,
            Self::Codex { .. } => return Err("Codex 续接不能覆盖原生模型选择".into()),
        })
    }
}

impl HostSessionCreateInput {
    pub(crate) fn validate(&self) -> Result<ManagedRuntimeDefinition, String> {
        let definition = self.options.definition()?;
        if definition == PI_ACP_RUNTIME
            && let SessionStartOptions::Pi {
                managed_provider,
                native_first_use,
                ..
            } = &self.options
            && (*native_first_use == managed_provider.is_some())
        {
            return Err("Pi ACP 新会话必须选择已保存的 Provider 或原生账号首次使用".into());
        }
        if self.installation_id != definition.installation_id
            || self.connection_id != definition.default_connection_id
        {
            return Err(
                "Session start options do not match the selected Runtime connection".to_string(),
            );
        }
        if !Path::new(&self.working_copy_path).is_absolute() {
            return Err(
                "Select an absolute Working Copy path before starting a Session".to_string(),
            );
        }
        Ok(definition)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostManagedRuntimeStopInput {
    runtime_product_id: String,
    recovery: Option<HostRuntimeRecoveryInput>,
    session: Option<HostRuntimeSessionStopInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRuntimeSessionStopInput {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) runtime_generation: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRuntimeRecoveryInput {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) runtime_generation: u64,
    pub(crate) turn_id: HostTurnId,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "runtimeProductId", content = "status")]
pub enum HostManagedRuntimeStopResult {
    #[serde(rename = "pi")]
    PiAcp(Box<crate::pi_acp::PiAcpStatus>),
    #[serde(rename = "opencode")]
    OpenCodeAcp(Box<crate::opencode_acp::OpenCodeAcpStatus>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSessionOpenResult {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) runtime_product_id: String,
    pub(crate) installation_id: String,
    pub(crate) native_session_id: String,
    pub(crate) runtime_generation: u64,
    // Runtime ready, before native identity/history verification and Host registration.
    pub(crate) runtime_ready_at: i64,
    pub(crate) opened_at: i64,
    pub(crate) navigation: HostNavigationSnapshot,
}

pub(crate) fn pi_acp_open_result(
    result: crate::pi_acp::PiAcpHostSessionResult,
) -> HostSessionOpenResult {
    HostSessionOpenResult {
        farfold_session_id: result.farfold_session_id,
        runtime_product_id: "pi".into(),
        installation_id: result.installation_id,
        native_session_id: result.native_session_id,
        runtime_generation: result.runtime_generation,
        runtime_ready_at: result.runtime_ready_at,
        opened_at: result.opened_at,
        navigation: result.navigation,
    }
}

pub(crate) fn require_openable(target: &SessionOpenTarget) -> Result<(), String> {
    require_session_target(target.blockers())
}

pub(crate) fn require_session_target(blockers: Vec<SessionOpenBlocker>) -> Result<(), String> {
    if blockers.is_empty() {
        return Ok(());
    }
    let names = blockers
        .iter()
        .map(|blocker| match blocker {
            SessionOpenBlocker::SessionArchived => "session_archived",
            SessionOpenBlocker::RuntimeBuildNotCurrent => "runtime_build_not_current",
            SessionOpenBlocker::WorkingCopyUnavailable => "working_copy_unavailable",
            SessionOpenBlocker::NativeLocatorUnavailable => "native_locator_unavailable",
        })
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!("Farfold Session cannot be opened: {names}"))
}

pub(crate) fn require_openable_opencode_acp_target(
    target: &SessionOpenTarget,
) -> Result<(), String> {
    require_session_target(
        target
            .blockers()
            .into_iter()
            .filter(|blocker| {
                *blocker
                    != crate::host_store::session_open::SessionOpenBlocker::RuntimeBuildNotCurrent
            })
            .collect(),
    )
}

fn open_session(
    app: &AppHandle,
    store: &HostStore,
    input: HostSessionOpenInput,
) -> Result<HostSessionOpenResult, String> {
    let target = store.session_open_target(&input.farfold_session_id)?;
    crate::host_runtime_adapter::adapter_for_binding(&target.binding())?.open_session(
        app,
        store,
        &target,
        input.options.as_ref(),
    )
}

#[tauri::command]
pub async fn host_session_open(
    app: AppHandle,
    input: HostSessionOpenInput,
) -> Result<HostSessionOpenResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let store = app.state::<HostStore>();
        let turns = app.state::<TurnCoordinator>();
        crate::performance_trace::measure(
            &app,
            crate::performance_trace::Operation::HostSessionOpen,
            || {
                controller.exclusive(|| {
                    let target = store.session_open_target(&input.farfold_session_id)?;
                    turns.require_runtime_idle(
                        target.runtime_product_id.as_str(),
                        target.installation_id.as_str(),
                    )?;
                    open_session(&app, &store, input)
                })
            },
        )
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[tauri::command]
pub async fn host_session_create(
    app: AppHandle,
    input: HostSessionCreateInput,
) -> Result<HostSessionOpenResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let store = app.state::<HostStore>();
        let turns = app.state::<TurnCoordinator>();
        controller.exclusive(|| {
            crate::host_runtime_adapter::adapter_for_create(&input)?
                .create_session(&app, &store, &turns, &input)
        })
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[tauri::command]
pub async fn host_session_focus(
    app: tauri::AppHandle,
    farfold_session_id: FarfoldSessionId,
) -> Result<HostNavigationSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let store = app.state::<HostStore>();
        controller.exclusive(|| {
            store
                .mark_session_opened(&farfold_session_id)
                .map(|(_, navigation)| navigation)
        })
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[tauri::command]
pub async fn host_session_metadata_update(
    app: tauri::AppHandle,
    input: UpdateSessionMetadataInput,
) -> Result<SessionMetadataUpdateResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let store = app.state::<HostStore>();
        let pi_acp = app.state::<crate::pi_acp::PiAcpRuntime>();
        let opencode_acp = app.state::<crate::opencode_acp::OpenCodeAcpRuntime>();
        controller.exclusive(|| {
            if let Some(session_id) = input.archive_target() {
                let target = store.session_open_target(session_id)?;
                if target.runtime_product_id.as_str() == "codex" {
                    // ACP-bound Codex Sessions block archiving while a live
                    // owned connection exists; removed-Direct bindings can
                    // never run again but share the same product check.
                    app.state::<TurnCoordinator>().require_runtime_idle(
                        target.runtime_product_id.as_str(),
                        target.installation_id.as_str(),
                    )?;
                    if !app
                        .state::<crate::codex_acp::configure::Runtime>()
                        .is_stopped()?
                    {
                        return Err(
                            "Codex ACP 仍在连接中。请先断开自有连接，再归档或删除会话。"
                                .to_string(),
                        );
                    }
                    return store.update_session_metadata(input);
                }
                // Archiving must not depend on an unrelated Runtime's connection or
                // task. The bound Runtime still has to be quiescent before hiding it.
                if target.runtime_product_id.as_str() == OPENCODE_RUNTIME.product_id {
                    // ACP-bound Sessions block archiving while their connection is
                    // live; removed-Server bindings can never run again.
                    if crate::opencode_acp::is_acp_binding(&target.binding())
                        && !opencode_acp.is_stopped()?
                    {
                        return Err(
                            "OpenCode ACP 仍在连接中。请先打开要操作的对话并断开，再归档或切换；运行中的任务请先停止或等待完成。"
                                .to_string(),
                        );
                    }
                } else if target.runtime_product_id.as_str()
                    == crate::runtime_registry::PI_RUNTIME_PRODUCT_ID
                {
                    // ACP-bound Sessions block archiving while their connection is
                    // live; removed-RPC bindings can never run again.
                    if crate::pi_acp::is_acp_binding(&target.binding()) && !pi_acp.is_stopped()? {
                        return Err(
                            "Pi ACP 仍在连接中。请先打开要操作的对话并断开，再归档或切换；运行中的任务请先停止或等待完成。"
                                .to_string(),
                        );
                    }
                }
            }
            store.update_session_metadata(input)
        })
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[tauri::command]
pub async fn host_managed_runtime_stop(
    app: AppHandle,
    input: HostManagedRuntimeStopInput,
) -> Result<HostManagedRuntimeStopResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<HostSessionController>();
        let supervisor = app.state::<RuntimeSupervisor>();
        let interactions = app.state::<InteractionRegistry>();
        let turns = app.state::<TurnCoordinator>();
        let store = app.state::<HostStore>();
        controller.exclusive(|| {
            if let Some(session) = &input.session {
                let target = store.session_open_target(&session.farfold_session_id)?;
                return crate::host_runtime_adapter::adapter_for_binding(&target.binding())?
                    .stop_session(&app, &store, &turns, &interactions, &target, session);
            }
            if let Some(recovery) = &input.recovery {
                let target = store.session_open_target(&recovery.farfold_session_id)?;
                return crate::host_runtime_adapter::adapter_for_binding(&target.binding())?
                    .stop_for_recovery(&app, &store, &turns, &interactions, &target, recovery);
            }
            crate::host_runtime_adapter::adapter_for_runtime_stop(input.runtime_product_id.trim())?
                .stop_runtime(&app, &supervisor, &turns)
        })
    })
    .await
    .map_err(|_| "Host background operation was interrupted".to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn resume_options_cannot_change_the_persisted_runtime_or_inject_pi_trust() {
        use super::{OPENCODE_ACP_RUNTIME, PI_ACP_RUNTIME, SessionStartOptions};
        let pi = SessionStartOptions::Pi {
            project_trust: Some("approve".into()),
            adapter_id: None,
            managed_provider: None,
            native_first_use: false,
        };
        assert_eq!(
            pi.for_binding(PI_ACP_RUNTIME).unwrap().as_deref(),
            Some("approve")
        );
        assert!(pi.for_binding(OPENCODE_ACP_RUNTIME).is_err());
        assert!(
            (SessionStartOptions::OpenCode {
                adapter_id: None,
                managed_provider: None
            })
            .for_binding(PI_ACP_RUNTIME)
            .is_err()
        );
        assert!(
            SessionStartOptions::Pi {
                project_trust: Some("anything".into()),
                adapter_id: None,
                managed_provider: None,
                native_first_use: false,
            }
            .for_binding(PI_ACP_RUNTIME)
            .is_err()
        );
        assert!(
            serde_json::from_value::<super::HostSessionOpenInput>(serde_json::json!({
                "farfoldSessionId":"session-1", "projectTrust":"approve"
            }))
            .is_err(),
            "obsolete untyped public input is removed"
        );
    }

    #[test]
    fn legacy_pi_creation_and_rpc_adapter_ids_fail_closed() {
        for adapter in [None, Some("pi-rpc-jsonl")] {
            let options = serde_json::json!({"runtimeProductId":"pi", "adapterId":adapter, "projectTrust":"saved"});
            let input: super::HostSessionCreateInput = serde_json::from_value(serde_json::json!({
                "installationId":"bundled-pi", "connectionId":"pi-local-native-config-v1",
                "workingCopyPath":"/tmp/project", "options":options
            }))
            .unwrap();
            assert!(input.validate().is_err());
        }
        let rpc_options = serde_json::json!({"runtimeProductId":"pi", "adapterId":"pi-rpc-jsonl", "projectTrust":"saved", "nativeFirstUse":true});
        let rpc: super::HostSessionCreateInput = serde_json::from_value(serde_json::json!({
            "installationId":"bundled-pi-acp", "connectionId":"pi-acp-managed-local-v1",
            "workingCopyPath":"/tmp/project", "options":rpc_options
        }))
        .unwrap();
        assert!(rpc.options.definition().unwrap_err().contains("RPC"));
        assert!(
            rpc.options
                .for_binding(crate::runtime_registry::PI_ACP_RUNTIME)
                .is_err()
        );
    }

    #[test]
    fn session_creation_requires_matching_installation_connection_and_native_options() {
        use super::{HostSessionCreateInput, OPENCODE_ACP_RUNTIME, PI_ACP_RUNTIME};
        use serde_json::json;
        for (definition, options) in [
            (
                PI_ACP_RUNTIME,
                json!({"runtimeProductId": "pi", "projectTrust": "approve", "adapterId": "pi-acp-stdio-v1", "nativeFirstUse": true}),
            ),
            (
                OPENCODE_ACP_RUNTIME,
                json!({
                    "runtimeProductId": "opencode",
                    "adapterId": "opencode-acp-stdio-v1",
                }),
            ),
        ] {
            let input = json!({
                "installationId": definition.installation_id,
                "connectionId": definition.default_connection_id,
                "workingCopyPath": "/tmp/project with spaces",
                "options": options,
            });
            let parsed: HostSessionCreateInput = serde_json::from_value(input.clone()).unwrap();
            assert_eq!(parsed.validate().unwrap(), definition);
            for field in ["installationId", "connectionId"] {
                let mut mismatched = input.clone();
                mismatched[field] = json!("different-connection");
                let parsed: HostSessionCreateInput = serde_json::from_value(mismatched).unwrap();
                assert!(parsed.validate().is_err());
            }
            let mut relative = input.clone();
            relative["workingCopyPath"] = json!("relative");
            let parsed: HostSessionCreateInput = serde_json::from_value(relative).unwrap();
            assert!(parsed.validate().is_err());
            let mut forged = input;
            forged["nativeSessionId"] = json!("caller-cannot-choose-native-id");
            assert!(serde_json::from_value::<HostSessionCreateInput>(forged).is_err());
        }
    }

    #[test]
    fn session_creation_rejects_unknown_runtime_and_cross_runtime_options() {
        use super::SessionStartOptions;
        use serde_json::json;
        for options in [
            json!({"runtimeProductId": "unknown"}),
            json!({"runtimeProductId": "opencode", "projectTrust": "approve"}),
            json!({"runtimeProductId": "pi", "nativeSessionId": "forged"}),
        ] {
            assert!(serde_json::from_value::<SessionStartOptions>(options).is_err());
        }
        let unknown_adapter: SessionStartOptions = serde_json::from_value(
            json!({"runtimeProductId": "opencode", "adapterId": "unknown-adapter"}),
        )
        .unwrap();
        assert!(unknown_adapter.definition().is_err());
    }

    use super::HostSessionController;
    use crate::{
        host_ids::{AdapterId, ConnectionId, InstallationId, RuntimeBuildId, RuntimeProductId},
        host_store::{
            HostStore,
            records::{RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration},
            session_binding_index::{
                NativeSessionLocator, NativeSessionRegistrationInput, register_native_session,
                register_native_session_with_locator,
            },
            session_open::SessionOpenBlocker,
        },
        runtime_registry::{PI_ACP_RUNTIME, RuntimeBinding},
    };
    use std::{fs, path::PathBuf};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "farfold-session-controller-{}-{}",
                std::process::id(),
                std::thread::current().name().unwrap_or("test")
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn register_pi_runtime(store: &HostStore) {
        store
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse(PI_ACP_RUNTIME.product_id).unwrap(),
                display_name: PI_ACP_RUNTIME.display_name.to_string(),
                installation_id: InstallationId::parse(PI_ACP_RUNTIME.installation_id).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(PI_ACP_RUNTIME.runtime_build_id).unwrap(),
                adapter_id: AdapterId::parse(PI_ACP_RUNTIME.adapter_id).unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: PI_ACP_RUNTIME.version.to_string(),
                artifact_sha256: PI_ACP_RUNTIME.binary_sha256.to_string(),
                connection_id: ConnectionId::parse(PI_ACP_RUNTIME.default_connection_id).unwrap(),
                connection_label: "Pi native configuration".to_string(),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: 1,
                verified_at: 1,
            })
            .unwrap();
    }

    #[test]
    fn lifecycle_commands_are_serialized_and_require_quiescence() {
        let controller = HostSessionController::default();
        assert_eq!(controller.exclusive(|| Ok(7)).unwrap(), 7);
    }

    #[test]
    fn lifecycle_maintenance_blocks_ordinary_commands_until_finished() {
        let controller = HostSessionController::default();
        let token = "a".repeat(64);
        assert_eq!(controller.begin_maintenance(&token, || Ok(7)).unwrap(), 7);
        assert!(controller.exclusive(|| Ok(())).is_err());
        assert_eq!(controller.inspect(|| Ok(8)).unwrap(), 8);
        assert!(
            controller
                .finish_maintenance(&"b".repeat(64), || Ok(()))
                .is_err()
        );
        controller.finish_maintenance(&token, || Ok(())).unwrap();
        assert!(controller.exclusive(|| Ok(())).is_ok());
    }

    #[test]
    fn empty_pi_session_is_bound_before_its_native_jsonl_exists() {
        let root = TestDirectory::new();
        let project = root.0.join("project");
        let session_dir = root.0.join("sessions");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&session_dir).unwrap();
        let store = HostStore::open(root.0.join("host.sqlite3"));
        register_pi_runtime(&store);
        let session_file = session_dir.join("pi-empty-native-session.jsonl");

        let (farfold_session_id, _) = register_native_session(
            &store,
            RuntimeBinding::from(PI_ACP_RUNTIME),
            NativeSessionRegistrationInput {
                native_session_id: "pi-empty-native-session",
                working_copy_path: &project,
                title: "新对话",
                created_at: 2,
                updated_at: 2,
            },
        )
        .unwrap();
        let navigation = store.navigation_snapshot().unwrap();
        assert!(!navigation.session_index.sessions[0].native_locator_registered);
        assert_eq!(
            serde_json::to_value(navigation.restore_state.unwrap()).unwrap()["lastSessionId"],
            farfold_session_id.as_str()
        );
        let target = store.session_open_target(&farfold_session_id).unwrap();
        assert_eq!(target.native_session_id.as_str(), "pi-empty-native-session");
        assert_eq!(
            target.blockers(),
            vec![SessionOpenBlocker::NativeLocatorUnavailable]
        );

        let (other_id, _) = register_native_session(
            &store,
            RuntimeBinding::from(PI_ACP_RUNTIME),
            NativeSessionRegistrationInput {
                native_session_id: "another-focused-session",
                working_copy_path: &project,
                title: "Another focused conversation",
                created_at: 3,
                updated_at: 3,
            },
        )
        .unwrap();

        fs::write(&session_file, "native Pi data").unwrap();
        let (upgraded_session_id, _) = register_native_session_with_locator(
            &store,
            PI_ACP_RUNTIME,
            NativeSessionRegistrationInput {
                native_session_id: "pi-empty-native-session",
                working_copy_path: &project,
                title: "新对话",
                created_at: 2,
                updated_at: 3,
            },
            NativeSessionLocator {
                kind: crate::host_store::records::NativeSessionLocatorKind::PiSessionFile,
                path: &session_file,
                allowed_root: &session_dir,
            },
        )
        .unwrap();
        assert_eq!(upgraded_session_id, farfold_session_id);
        let upgraded = store.navigation_snapshot().unwrap();
        assert!(
            upgraded
                .session_index
                .sessions
                .iter()
                .find(|session| session.farfold_session_id == farfold_session_id)
                .unwrap()
                .native_locator_registered
        );
        assert_eq!(
            serde_json::to_value(upgraded.restore_state.unwrap()).unwrap()["lastSessionId"],
            other_id.as_str(),
            "background native persistence must not steal navigation focus"
        );
        assert!(
            store
                .session_open_target(&farfold_session_id)
                .unwrap()
                .blockers()
                .is_empty()
        );
    }

    #[test]
    fn idempotent_pi_registration_must_not_replace_a_durable_title_with_empty_state() {
        let root = TestDirectory::new();
        let project = root.0.join("project");
        let session_dir = root.0.join("sessions");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&session_dir).unwrap();
        let store = HostStore::open(root.0.join("host.sqlite3"));
        register_pi_runtime(&store);
        let session_file = session_dir.join("persisted.jsonl");
        fs::write(&session_file, "native Pi data").unwrap();
        register_native_session_with_locator(
            &store,
            PI_ACP_RUNTIME,
            NativeSessionRegistrationInput {
                native_session_id: "pi-persisted-native-session",
                working_copy_path: &project,
                title: "Actual first user message",
                created_at: 2,
                updated_at: 3,
            },
            NativeSessionLocator {
                kind: crate::host_store::records::NativeSessionLocatorKind::PiSessionFile,
                path: &session_file,
                allowed_root: &session_dir,
            },
        )
        .unwrap();
        // An older observation for the already-bound Session cannot clobber the
        // durable title recorded by the newer registration.
        register_native_session_with_locator(
            &store,
            PI_ACP_RUNTIME,
            NativeSessionRegistrationInput {
                native_session_id: "pi-persisted-native-session",
                working_copy_path: &project,
                title: "新对话",
                created_at: 2,
                updated_at: 2,
            },
            NativeSessionLocator {
                kind: crate::host_store::records::NativeSessionLocatorKind::PiSessionFile,
                path: &session_file,
                allowed_root: &session_dir,
            },
        )
        .unwrap();
        let snapshot = store.navigation_snapshot().unwrap();
        assert_eq!(
            snapshot.session_index.sessions[0].title,
            "Actual first user message"
        );
        assert!(snapshot.session_index.sessions[0].native_locator_registered);
    }
}
