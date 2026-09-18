//! Runtime-neutral Host operation dispatch.
//!
//! Every Host session/turn command resolves the bound `adapter_id` through
//! [`adapter_for_binding`] (or [`adapter_for_create`] for new Sessions) and
//! delegates to the registered [`HostRuntimeAdapter`]. Adding a Runtime means
//! implementing the trait and registering one entry; `session_controller` and
//! `turn_coordinator` stay free of per-product branches.
//!
//! Adapters own protocol translation and Runtime-specific validation only.
//! Host invariants — `session_open_target`, blocker checks, Turn occupancy and
//! generation verification — are still enforced here the same way the former
//! inline branches did; the move is structural, not semantic.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::host_store::{HostStore, session_open::SessionOpenTarget};
use crate::interaction_registry::InteractionRegistry;
use crate::runtime_registry::{OPENCODE_RUNTIME, PI_ACP_RUNTIME, RuntimeBinding};
use crate::runtime_supervisor::RuntimeSupervisor;
use crate::session_controller::{
    self, HostManagedRuntimeStopResult, HostRuntimeRecoveryInput, HostRuntimeSessionStopInput,
    HostSessionCreateInput, HostSessionOpenResult, SessionStartOptions,
};
use crate::turn_coordinator::{
    HostNativeTurnSubmission, HostTurnAbortInput, HostTurnSubmitInput, TurnCoordinator,
};

/// The Host-level contract every Runtime adapter implements.
///
/// Methods are synchronous: every Host command already runs inside
/// `spawn_blocking` under the session controller's exclusive lock.
pub(crate) trait HostRuntimeAdapter: Send + Sync {
    /// Open an existing persisted Session on its bound Runtime.
    fn open_session(
        &self,
        app: &AppHandle,
        store: &HostStore,
        target: &SessionOpenTarget,
        options: Option<&SessionStartOptions>,
    ) -> Result<HostSessionOpenResult, String>;

    /// Create a new native Session and register it with the Host.
    fn create_session(
        &self,
        app: &AppHandle,
        store: &HostStore,
        turns: &TurnCoordinator,
        input: &HostSessionCreateInput,
    ) -> Result<HostSessionOpenResult, String>;

    /// Stop the Runtime connection bound to this Session.
    fn stop_session(
        &self,
        app: &AppHandle,
        store: &HostStore,
        turns: &TurnCoordinator,
        interactions: &InteractionRegistry,
        target: &SessionOpenTarget,
        session: &HostRuntimeSessionStopInput,
    ) -> Result<HostManagedRuntimeStopResult, String> {
        let _ = (app, store, turns, interactions, target, session);
        Err("Session stop target is not supported".to_string())
    }

    /// Stop a Session for Host recovery while preserving unknown Turn outcomes.
    fn stop_for_recovery(
        &self,
        app: &AppHandle,
        store: &HostStore,
        turns: &TurnCoordinator,
        interactions: &InteractionRegistry,
        target: &SessionOpenTarget,
        recovery: &HostRuntimeRecoveryInput,
    ) -> Result<HostManagedRuntimeStopResult, String> {
        let _ = (app, store, turns, interactions, target, recovery);
        Err("Managed Runtime product is not supported by this build".to_string())
    }

    /// Stop the Runtime itself (no Session-scoped target).
    fn stop_runtime(
        &self,
        app: &AppHandle,
        supervisor: &RuntimeSupervisor,
        turns: &TurnCoordinator,
    ) -> Result<HostManagedRuntimeStopResult, String> {
        let _ = (app, supervisor, turns);
        Err("Managed Runtime product is not supported by this build".to_string())
    }

    /// Submit a Turn through the unified `host_turn_submit` command. The
    /// adapter reads the authoritative Runtime generation itself; the input
    /// deliberately carries no client-supplied generation.
    fn submit_turn(
        &self,
        app: &AppHandle,
        store: &HostStore,
        target: &SessionOpenTarget,
        input: &HostTurnSubmitInput,
    ) -> Result<HostNativeTurnSubmission, String> {
        let _ = (app, store, target, input);
        Err("此 Runtime 适配器不支持统一任务提交".to_string())
    }

    /// Abort the active Turn through the unified `host_turn_abort` command.
    fn abort_turn(
        &self,
        app: &AppHandle,
        store: &HostStore,
        target: &SessionOpenTarget,
        input: &HostTurnAbortInput,
    ) -> Result<bool, String> {
        let _ = (app, store, target, input);
        Err("此 Runtime 适配器不支持统一任务停止".to_string())
    }
}

struct OpenCodeAcpHostAdapter;
struct PiAcpAdapter;
struct CodexAcpWorkspaceAdapter;

const OPENCODE_ACP_HOST_ADAPTER: OpenCodeAcpHostAdapter = OpenCodeAcpHostAdapter;
const PI_ACP_ADAPTER: PiAcpAdapter = PiAcpAdapter;
const CODEX_ACP_WORKSPACE_ADAPTER: CodexAcpWorkspaceAdapter = CodexAcpWorkspaceAdapter;

/// Resolve the adapter registered for a persisted Session binding.
pub(crate) fn adapter_for_binding(
    binding: &RuntimeBinding,
) -> Result<&'static dyn HostRuntimeAdapter, String> {
    match binding.adapter_id.as_str() {
        crate::opencode_acp::OPENCODE_ACP_ADAPTER_ID => Ok(&OPENCODE_ACP_HOST_ADAPTER),
        crate::pi_acp_interactions::PI_ACP_ADAPTER_ID => Ok(&PI_ACP_ADAPTER),
        crate::runtime_registry::PI_RUNTIME_ADAPTER_ID => Err(
            "此 Pi Session 绑定于已移除的 RPC 适配器，无法续接。请归档后通过 ACP 新建会话。"
                .to_string(),
        ),
        "codex-app-server" => Err(
            "此 Codex Session 绑定于已移除的 Direct 适配器，无法续接。请归档后通过 ACP 自有连接新建会话。"
                .to_string(),
        ),
        "codex-acp-stdio-v1" => Ok(&CODEX_ACP_WORKSPACE_ADAPTER),
        crate::runtime_registry::OPENCODE_RUNTIME_ADAPTER_ID => Err(
            "此 OpenCode Session 绑定于已移除的 Server 适配器，无法续接。请归档后新建 ACP 会话。"
                .to_string(),
        ),
        _ => Err("此 Session 绑定的 Runtime 适配器不受当前版本支持。".to_string()),
    }
}

/// Resolve the adapter a `host_session_create` request targets.
pub(crate) fn adapter_for_create(
    input: &HostSessionCreateInput,
) -> Result<&'static dyn HostRuntimeAdapter, String> {
    match &input.options {
        SessionStartOptions::Pi { adapter_id, .. } => match adapter_id.as_deref() {
            Some(crate::pi_acp_interactions::PI_ACP_ADAPTER_ID) => Ok(&PI_ACP_ADAPTER),
            Some(_) => Err("Pi adapter 与 Provider 启动选项不匹配".to_string()),
            None => Err("Pi 会话创建必须显式选择 Pi ACP 适配器".to_string()),
        },
        SessionStartOptions::OpenCode { adapter_id, .. } => match adapter_id.as_deref() {
            None | Some(crate::opencode_acp::OPENCODE_ACP_ADAPTER_ID) => {
                Ok(&OPENCODE_ACP_HOST_ADAPTER)
            }
            Some(_) => Err("Unknown OpenCode adapter".to_string()),
        },
        SessionStartOptions::Codex { .. } => {
            Err("Codex Session 须通过 ACP 自有连接创建；Direct 启动路径已移除。".to_string())
        }
    }
}

/// Resolve the adapter for a bare (Session-less) Runtime stop request.
pub(crate) fn adapter_for_runtime_stop(
    product_id: &str,
) -> Result<&'static dyn HostRuntimeAdapter, String> {
    match product_id {
        "pi" => Err("Pi ACP 停止必须携带明确的 Session 或恢复目标".to_string()),
        // OpenCode Server was removed; ACP connections stop through the
        // session/recovery targets.
        "opencode" => Err("OpenCode Server 运行时已移除；ACP 会话请使用会话级停止".to_string()),
        _ => Err("Managed Runtime product is not supported by this build".to_string()),
    }
}

impl HostRuntimeAdapter for OpenCodeAcpHostAdapter {
    fn open_session(
        &self,
        app: &AppHandle,
        store: &HostStore,
        target: &SessionOpenTarget,
        options: Option<&SessionStartOptions>,
    ) -> Result<HostSessionOpenResult, String> {
        if options.is_some() {
            return Err("OpenCode 续接沿用原生模型；不接受启动选项覆盖".into());
        }
        session_controller::require_openable_opencode_acp_target(target)?;
        let acp = app.state::<crate::opencode_acp::OpenCodeAcpRuntime>();
        let router = app.state::<crate::runtime_event_router::RuntimeEventRouter>();
        let opened = crate::opencode_acp::open_registered_host_session(
            app.clone(),
            acp.inner().clone(),
            router.inner().clone(),
            store.clone(),
            crate::opencode_acp::OpenCodeAcpHostOpenInput {
                binding: target.binding(),
                farfold_session_id: target.farfold_session_id.clone(),
                working_copy_path: target.working_copy_path.clone(),
                native_session_id: target.native_session_id.to_string(),
            },
        )?;
        Ok(HostSessionOpenResult {
            farfold_session_id: target.farfold_session_id.clone(),
            runtime_product_id: target.runtime_product_id.to_string(),
            installation_id: target.installation_id.to_string(),
            native_session_id: target.native_session_id.to_string(),
            runtime_generation: opened.runtime_generation,
            runtime_ready_at: opened.runtime_ready_at,
            opened_at: opened.opened_at,
            navigation: opened.navigation,
        })
    }

    fn create_session(
        &self,
        app: &AppHandle,
        store: &HostStore,
        turns: &TurnCoordinator,
        input: &HostSessionCreateInput,
    ) -> Result<HostSessionOpenResult, String> {
        let SessionStartOptions::OpenCode {
            managed_provider, ..
        } = &input.options
        else {
            return Err("Session start options do not select OpenCode".to_string());
        };
        let (runtime_binding, binary_path) = crate::opencode_acp::verified_acp_creation_target(
            store,
            &input.installation_id,
            &input.connection_id,
        )?;
        turns.require_runtime_idle(
            runtime_binding.product_id.as_str(),
            runtime_binding.installation_id.as_str(),
        )?;
        let acp = app.state::<crate::opencode_acp::OpenCodeAcpRuntime>();
        let router = app.state::<crate::runtime_event_router::RuntimeEventRouter>();
        let created = crate::opencode_acp::create_registered_host_session(
            app.clone(),
            acp.inner().clone(),
            router.inner().clone(),
            store.clone(),
            crate::opencode_acp::OpenCodeAcpHostCreateInput {
                binding: runtime_binding,
                binary_path,
                working_copy_path: PathBuf::from(&input.working_copy_path),
                managed_provider: managed_provider.clone(),
            },
        )?;
        Ok(HostSessionOpenResult {
            farfold_session_id: created.farfold_session_id,
            runtime_product_id: OPENCODE_RUNTIME.product_id.to_string(),
            installation_id: created.installation_id,
            native_session_id: created.native_session_id,
            runtime_generation: created.runtime_generation,
            runtime_ready_at: created.runtime_ready_at,
            opened_at: created.opened_at,
            navigation: created.navigation,
        })
    }

    fn stop_session(
        &self,
        app: &AppHandle,
        _store: &HostStore,
        turns: &TurnCoordinator,
        interactions: &InteractionRegistry,
        target: &SessionOpenTarget,
        session: &HostRuntimeSessionStopInput,
    ) -> Result<HostManagedRuntimeStopResult, String> {
        if !crate::opencode_acp::is_acp_binding(&target.binding())
            || target.native_session_id != session.native_session_id
        {
            return Err("停止目标与原生 Session 绑定不一致".into());
        }
        turns.require_runtime_idle(
            target.runtime_product_id.as_str(),
            target.installation_id.as_str(),
        )?;
        let runtime = app.state::<crate::opencode_acp::OpenCodeAcpRuntime>();
        let stopped = crate::opencode_acp::stop_idle_host_session(
            &runtime,
            &target.binding(),
            &target.working_copy_path,
            &target.native_session_id,
            session.runtime_generation,
        )?;
        interactions.advance_generation(target.binding(), stopped.generation)?;
        Ok(HostManagedRuntimeStopResult::OpenCodeAcp(Box::new(stopped)))
    }

    fn stop_for_recovery(
        &self,
        app: &AppHandle,
        _store: &HostStore,
        turns: &TurnCoordinator,
        interactions: &InteractionRegistry,
        target: &SessionOpenTarget,
        recovery: &HostRuntimeRecoveryInput,
    ) -> Result<HostManagedRuntimeStopResult, String> {
        if target.native_session_id != recovery.native_session_id {
            return Err("恢复请求与持久会话绑定不一致。".into());
        }
        let turn = turns.require_opencode_recovery(
            &recovery.farfold_session_id,
            &recovery.native_session_id,
            recovery.runtime_generation,
            &recovery.turn_id,
        )?;
        let runtime = app.state::<crate::opencode_acp::OpenCodeAcpRuntime>();
        let stopped = crate::opencode_acp::stop_session_for_host_recovery(
            &runtime,
            &target.binding(),
            &target.working_copy_path,
            &target.native_session_id,
            recovery.runtime_generation,
        )?;
        interactions.advance_generation(target.binding(), stopped.generation)?;
        turns.finish_opencode_recovery(&turn)?;
        Ok(HostManagedRuntimeStopResult::OpenCodeAcp(Box::new(stopped)))
    }

    fn stop_runtime(
        &self,
        _app: &AppHandle,
        _supervisor: &RuntimeSupervisor,
        _turns: &TurnCoordinator,
    ) -> Result<HostManagedRuntimeStopResult, String> {
        Err("OpenCode ACP 连接通过会话级停止关闭".to_string())
    }

    fn submit_turn(
        &self,
        app: &AppHandle,
        store: &HostStore,
        _target: &SessionOpenTarget,
        input: &HostTurnSubmitInput,
    ) -> Result<HostNativeTurnSubmission, String> {
        crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
            &app.state::<session_controller::HostSessionController>(),
            store,
            &app.state::<crate::opencode_acp::OpenCodeAcpRuntime>(),
            &app.state::<TurnCoordinator>(),
            crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                farfold_session_id: input.farfold_session_id.clone(),
                native_session_id: input.native_session_id.clone(),
                text: input.text.clone(),
                provider_connection_id: input.provider_connection_id.clone(),
                provider_config_version_id: input.provider_config_version_id.clone(),
                runtime_provider_id: input.runtime_provider_id.clone(),
                runtime_model_id: input.runtime_model_id.clone(),
            },
        )
    }

    fn abort_turn(
        &self,
        app: &AppHandle,
        store: &HostStore,
        _target: &SessionOpenTarget,
        input: &HostTurnAbortInput,
    ) -> Result<bool, String> {
        crate::turn_coordinator::host_opencode_acp_turn_abort_blocking(
            &app.state::<session_controller::HostSessionController>(),
            store,
            &app.state::<crate::opencode_acp::OpenCodeAcpRuntime>(),
            &app.state::<InteractionRegistry>(),
            &app.state::<TurnCoordinator>(),
            crate::turn_coordinator::HostOpenCodeAcpTurnAbortInput {
                farfold_session_id: input.farfold_session_id.clone(),
                native_session_id: input.native_session_id.clone(),
            },
        )
    }
}

impl HostRuntimeAdapter for PiAcpAdapter {
    fn open_session(
        &self,
        app: &AppHandle,
        _store: &HostStore,
        target: &SessionOpenTarget,
        options: Option<&SessionStartOptions>,
    ) -> Result<HostSessionOpenResult, String> {
        let trust = options
            .map(|options| {
                if let SessionStartOptions::Pi {
                    managed_provider,
                    native_first_use,
                    ..
                } = options
                    && (managed_provider.is_some() || *native_first_use)
                {
                    return Err("Pi ACP 续接不能覆盖原绑定的 Provider 或首次使用状态".into());
                }
                options.for_binding(PI_ACP_RUNTIME)
            })
            .transpose()?
            .flatten();
        crate::pi_acp::open_host_session(app, target, trust.as_deref())
            .map(session_controller::pi_acp_open_result)
    }

    fn create_session(
        &self,
        app: &AppHandle,
        _store: &HostStore,
        _turns: &TurnCoordinator,
        input: &HostSessionCreateInput,
    ) -> Result<HostSessionOpenResult, String> {
        let SessionStartOptions::Pi {
            project_trust,
            managed_provider,
            native_first_use,
            ..
        } = &input.options
        else {
            return Err("Pi ACP 新建入口未通过校验".into());
        };
        input.validate()?;
        let selection = if *native_first_use {
            None
        } else {
            Some(
                managed_provider
                    .clone()
                    .ok_or("Pi ACP 新会话需要已保存的 Provider 版本")?,
            )
        };
        crate::pi_acp::create_host_session(
            app,
            Path::new(&input.working_copy_path),
            selection,
            project_trust.as_deref(),
        )
        .map(session_controller::pi_acp_open_result)
    }

    fn stop_session(
        &self,
        app: &AppHandle,
        _store: &HostStore,
        turns: &TurnCoordinator,
        _interactions: &InteractionRegistry,
        target: &SessionOpenTarget,
        session: &HostRuntimeSessionStopInput,
    ) -> Result<HostManagedRuntimeStopResult, String> {
        if !crate::pi_acp::is_acp_binding(&target.binding())
            || target.native_session_id != session.native_session_id
        {
            return Err("Pi ACP 停止目标与原生 Session 不一致".into());
        }
        turns.require_runtime_idle(
            target.runtime_product_id.as_str(),
            target.installation_id.as_str(),
        )?;
        let runtime = app.state::<crate::pi_acp::PiAcpRuntime>();
        let router = app.state::<crate::runtime_event_router::RuntimeEventRouter>();
        let stopped = runtime.stop_idle_session(&router, target, session.runtime_generation)?;
        Ok(HostManagedRuntimeStopResult::PiAcp(Box::new(stopped)))
    }

    fn stop_for_recovery(
        &self,
        app: &AppHandle,
        _store: &HostStore,
        turns: &TurnCoordinator,
        _interactions: &InteractionRegistry,
        target: &SessionOpenTarget,
        recovery: &HostRuntimeRecoveryInput,
    ) -> Result<HostManagedRuntimeStopResult, String> {
        if !crate::pi_acp::is_acp_binding(&target.binding())
            || target.native_session_id != recovery.native_session_id
        {
            return Err("Pi ACP 恢复目标与原生 Session 不一致".into());
        }
        let turn =
            turns.require_bound_recovery(target, recovery.runtime_generation, &recovery.turn_id)?;
        let runtime = app.state::<crate::pi_acp::PiAcpRuntime>();
        let router = app.state::<crate::runtime_event_router::RuntimeEventRouter>();
        let stopped = runtime.stop_for_recovery(&router, target, recovery.runtime_generation)?;
        turns.finish_bound_recovery(&turn)?;
        Ok(HostManagedRuntimeStopResult::PiAcp(Box::new(stopped)))
    }

    fn submit_turn(
        &self,
        app: &AppHandle,
        store: &HostStore,
        _target: &SessionOpenTarget,
        input: &HostTurnSubmitInput,
    ) -> Result<HostNativeTurnSubmission, String> {
        if input.provider_connection_id.is_some()
            || input.provider_config_version_id.is_some()
            || input.runtime_provider_id.is_some()
            || input.runtime_model_id.is_some()
        {
            return Err("Pi ACP 不接受 OpenCode 的 Provider 绑定参数".into());
        }
        let runtime = app.state::<crate::pi_acp::PiAcpRuntime>();
        crate::turn_coordinator::host_pi_acp_turn_submit_blocking(
            &app.state::<session_controller::HostSessionController>(),
            store,
            &runtime,
            &app.state::<crate::runtime_event_router::RuntimeEventRouter>(),
            &app.state::<TurnCoordinator>(),
            &app.state::<InteractionRegistry>(),
            crate::turn_coordinator::HostPiAcpTurnSubmitInput {
                farfold_session_id: input.farfold_session_id.clone(),
                native_session_id: input.native_session_id.clone(),
                runtime_generation: runtime.current_generation()?,
                text: input.text.clone(),
            },
        )
    }

    fn abort_turn(
        &self,
        app: &AppHandle,
        store: &HostStore,
        _target: &SessionOpenTarget,
        input: &HostTurnAbortInput,
    ) -> Result<bool, String> {
        let turns = app.state::<TurnCoordinator>();
        let runtime = app.state::<crate::pi_acp::PiAcpRuntime>();
        let active = turns
            .active_for_session(&input.farfold_session_id)?
            .ok_or("Pi ACP 当前没有可停止的任务")?;
        crate::turn_coordinator::host_pi_acp_turn_abort_blocking(
            &app.state::<session_controller::HostSessionController>(),
            store,
            &runtime,
            &turns,
            &app.state::<crate::runtime_event_router::RuntimeEventRouter>(),
            &app.state::<InteractionRegistry>(),
            crate::turn_coordinator::HostPiAcpTurnAbortInput {
                farfold_session_id: input.farfold_session_id.clone(),
                native_session_id: input.native_session_id.clone(),
                runtime_generation: active.runtime_generation(),
                turn_id: active.id().clone(),
            },
        )
    }
}

impl HostRuntimeAdapter for CodexAcpWorkspaceAdapter {
    fn open_session(
        &self,
        app: &AppHandle,
        store: &HostStore,
        target: &SessionOpenTarget,
        _options: Option<&SessionStartOptions>,
    ) -> Result<HostSessionOpenResult, String> {
        app.state::<crate::codex_acp::configure::Runtime>()
            .require_workspace_open(store, &target.farfold_session_id)?;
        Err(crate::codex_acp::workspace::BLOCKED_REASON.into())
    }

    fn create_session(
        &self,
        _app: &AppHandle,
        _store: &HostStore,
        _turns: &TurnCoordinator,
        _input: &HostSessionCreateInput,
    ) -> Result<HostSessionOpenResult, String> {
        Err("Codex 动态连接未通过校验".into())
    }
}
