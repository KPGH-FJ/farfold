use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{
    host_store::HostStore,
    lifemodel,
    pi_runtime::{self, PiRuntime},
    runtime_registry::{
        ManagedRuntimeDefinition, ManagedRuntimeKey, RuntimeIdentity, verify_managed_installation,
    },
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySet<T> {
    base: T,
    contributes_to_life_model: T,
    uses_life_model: T,
}

impl<T: Clone> CapabilitySet<T> {
    fn uniform(value: T) -> Self {
        Self {
            base: value.clone(),
            contributes_to_life_model: value.clone(),
            uses_life_model: value,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallationCompatibility {
    compatible: bool,
    observed_version: Option<String>,
    artifact_sha256: Option<String>,
    reason_code: Option<&'static str>,
    detail: Option<String>,
    recovery_action: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveReadiness {
    ready: bool,
    reason_code: Option<&'static str>,
    recovery_action: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilityAuthoritySnapshot {
    runtime: RuntimeIdentity,
    runtime_build_id: &'static str,
    adapter_support: CapabilitySet<bool>,
    installation_compatibility: CapabilitySet<InstallationCompatibility>,
    live_readiness: CapabilitySet<LiveReadiness>,
    retention_capabilities: Vec<RuntimeRetentionCapability>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetentionStatus {
    Accepted,
    Partial,
    AdapterGap,
    VersionBlocked,
    Unknown,
    OutOfScope,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRetentionCapability {
    pub(crate) key: &'static str,
    label: &'static str,
    pub(crate) status: RetentionStatus,
    pub(crate) detail: &'static str,
}

fn adapter_support(definition: ManagedRuntimeDefinition) -> CapabilitySet<bool> {
    match definition.product_id {
        "pi" | "opencode" => CapabilitySet {
            base: true,
            contributes_to_life_model: true,
            uses_life_model: true,
        },
        _ => CapabilitySet::uniform(false),
    }
}

pub(crate) fn adapter_capability_flags(definition: ManagedRuntimeDefinition) -> (bool, bool, bool) {
    let support = adapter_support(definition);
    (
        support.base,
        support.contributes_to_life_model,
        support.uses_life_model,
    )
}

fn installation_compatibility(
    app: &AppHandle,
    definition: ManagedRuntimeDefinition,
) -> CapabilitySet<InstallationCompatibility> {
    match verify_managed_installation(app, definition) {
        Ok(observed) => CapabilitySet::uniform(InstallationCompatibility {
            compatible: true,
            observed_version: Some(observed.observed_version),
            artifact_sha256: Some(observed.artifact_sha256),
            reason_code: None,
            detail: None,
            recovery_action: None,
        }),
        Err(detail) => CapabilitySet::uniform(InstallationCompatibility {
            compatible: false,
            observed_version: None,
            artifact_sha256: None,
            reason_code: Some("managed_runtime_artifact_mismatch"),
            detail: Some(detail),
            recovery_action: Some("reinstall_verified_runtime_artifact"),
        }),
    }
}

fn live_readiness(running: bool, lifemodel_enabled: bool) -> CapabilitySet<LiveReadiness> {
    if !running {
        return CapabilitySet::uniform(LiveReadiness {
            ready: false,
            reason_code: Some("runtime_not_running"),
            recovery_action: Some("start_runtime_for_bound_project"),
        });
    }
    CapabilitySet {
        base: LiveReadiness {
            ready: true,
            reason_code: None,
            recovery_action: None,
        },
        contributes_to_life_model: LiveReadiness {
            ready: true,
            reason_code: None,
            recovery_action: None,
        },
        uses_life_model: if lifemodel_enabled {
            LiveReadiness {
                ready: true,
                reason_code: None,
                recovery_action: None,
            }
        } else {
            LiveReadiness {
                ready: false,
                reason_code: Some("lifemodel_disabled"),
                recovery_action: Some("enable_lifemodel"),
            }
        },
    }
}

pub(crate) fn retention_capabilities(
    definition: ManagedRuntimeDefinition,
) -> Vec<RuntimeRetentionCapability> {
    match definition.product_id {
        "pi" => vec![
            RuntimeRetentionCapability {
                key: "launch",
                label: "安装与启动",
                status: RetentionStatus::Accepted,
                detail: "0.84.3 随包运行；ACP 候选仍需单独核验。",
            },
            RuntimeRetentionCapability {
                key: "task",
                label: "正常任务",
                status: RetentionStatus::Accepted,
                detail: "RPC 文件任务与流式事件已有安装证据。",
            },
            RuntimeRetentionCapability {
                key: "intervention",
                label: "插话与跟进",
                status: RetentionStatus::Accepted,
                detail: "保留原生 steer 与 follow-up；ACP 候选不能降级。",
            },
            RuntimeRetentionCapability {
                key: "stop",
                label: "停止",
                status: RetentionStatus::Accepted,
                detail: "原生 abort 已验收；停止不代表撤销文件修改。",
            },
            RuntimeRetentionCapability {
                key: "interaction",
                label: "权限与提问",
                status: RetentionStatus::AdapterGap,
                detail: "Extension UI 已有工程证据；ACP input/editor 候选有缺口。",
            },
            RuntimeRetentionCapability {
                key: "provider",
                label: "Provider 与模型",
                status: RetentionStatus::Partial,
                detail: "私有模型投影已验证；共享一次配置仍待实现。",
            },
            RuntimeRetentionCapability {
                key: "resume",
                label: "会话恢复",
                status: RetentionStatus::Accepted,
                detail: "原生 JSONL 身份和冷启动恢复已有安装证据。",
            },
            RuntimeRetentionCapability {
                key: "artifacts",
                label: "成果审阅",
                status: RetentionStatus::Partial,
                detail: "文件定位可用；完整 diff 与归因仍是后续范围。",
            },
        ],
        "opencode" => vec![
            RuntimeRetentionCapability {
                key: "launch",
                label: "安装与启动",
                status: RetentionStatus::Accepted,
                detail: "1.15.13 随包运行；ACP 固定版本需重新选择。",
            },
            RuntimeRetentionCapability {
                key: "task",
                label: "正常任务",
                status: RetentionStatus::Accepted,
                detail: "Server 文件任务与流式事件已有安装证据。",
            },
            RuntimeRetentionCapability {
                key: "intervention",
                label: "插话与跟进",
                status: RetentionStatus::Unknown,
                detail: "不把再次 prompt 直接当作等价即时插话。",
            },
            RuntimeRetentionCapability {
                key: "stop",
                label: "停止",
                status: RetentionStatus::VersionBlocked,
                detail: "固定 1.15.13 ACP service 取消路径返回不支持。",
            },
            RuntimeRetentionCapability {
                key: "interaction",
                label: "权限与提问",
                status: RetentionStatus::Partial,
                detail: "原生权限已验收；自由文本提问映射未确认。",
            },
            RuntimeRetentionCapability {
                key: "provider",
                label: "Provider 与模型",
                status: RetentionStatus::Partial,
                detail: "API key 配置可用；共享一次配置仍待实现。",
            },
            RuntimeRetentionCapability {
                key: "resume",
                label: "会话恢复",
                status: RetentionStatus::Accepted,
                detail: "原生 Session ID 冷启动恢复已有安装证据。",
            },
            RuntimeRetentionCapability {
                key: "artifacts",
                label: "成果审阅",
                status: RetentionStatus::Partial,
                detail: "文件定位可用；完整 diff 与权限归因仍待补齐。",
            },
        ],
        _ => vec![RuntimeRetentionCapability {
            key: "launch",
            label: "安装与启动",
            status: RetentionStatus::OutOfScope,
            detail: "该 Runtime 尚未纳入 managed capability authority。",
        }],
    }
}

fn snapshot(
    app: &AppHandle,
    definition: ManagedRuntimeDefinition,
    running: bool,
    lifemodel_enabled: bool,
) -> RuntimeCapabilityAuthoritySnapshot {
    RuntimeCapabilityAuthoritySnapshot {
        runtime: definition.identity(),
        runtime_build_id: definition.runtime_build_id,
        adapter_support: adapter_support(definition),
        installation_compatibility: installation_compatibility(app, definition),
        live_readiness: live_readiness(running, lifemodel_enabled),
        retention_capabilities: retention_capabilities(definition),
    }
}

#[tauri::command]
pub async fn runtime_capability_snapshot(
    app: AppHandle,
    runtime: ManagedRuntimeKey,
    pi: State<'_, PiRuntime>,
    opencode_acp: State<'_, crate::opencode_acp::OpenCodeAcpRuntime>,
    host_store: State<'_, HostStore>,
) -> Result<RuntimeCapabilityAuthoritySnapshot, String> {
    let running = match runtime {
        ManagedRuntimeKey::Pi => pi_runtime::is_running(&pi)?,
        // The OpenCode Server adapter was removed; its managed installation
        // can no longer run. The ACP installation reports its live connection.
        ManagedRuntimeKey::Opencode => false,
        ManagedRuntimeKey::OpencodeAcp => !opencode_acp.is_stopped()?,
    };
    let lifemodel_enabled = lifemodel::is_enabled(&host_store)?;
    tauri::async_runtime::spawn_blocking(move || {
        snapshot(&app, runtime.definition(), running, lifemodel_enabled)
    })
    .await
    .map_err(|error| format!("Cannot inspect Runtime capabilities: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{RetentionStatus, live_readiness};

    #[test]
    fn source_support_does_not_imply_live_readiness() {
        let live = live_readiness(false, true);
        let support = super::adapter_support(crate::runtime_registry::PI_RUNTIME);
        assert!(support.base && support.contributes_to_life_model && support.uses_life_model);

        assert!(!live.base.ready);
        assert!(!live.contributes_to_life_model.ready);
        assert!(!live.uses_life_model.ready);
    }

    #[test]
    fn each_capability_remains_an_independent_field() {
        let live = live_readiness(true, false);

        assert!(live.base.ready);
        assert!(live.contributes_to_life_model.ready);
        assert!(!live.uses_life_model.ready);
    }

    #[test]
    fn pi_retention_preserves_native_intervention_and_marks_acp_interaction_gap() {
        let capabilities = super::retention_capabilities(crate::runtime_registry::PI_RUNTIME);
        let intervention = capabilities
            .iter()
            .find(|item| item.key == "intervention")
            .unwrap();
        let interaction = capabilities
            .iter()
            .find(|item| item.key == "interaction")
            .unwrap();

        assert_eq!(intervention.status, RetentionStatus::Accepted);
        assert!(intervention.detail.contains("steer"));
        assert_eq!(interaction.status, RetentionStatus::AdapterGap);
        assert!(interaction.detail.contains("ACP input/editor"));
    }

    #[test]
    fn opencode_retention_keeps_acp_cancel_blocked() {
        let capabilities = super::retention_capabilities(crate::runtime_registry::OPENCODE_RUNTIME);
        let stop = capabilities.iter().find(|item| item.key == "stop").unwrap();

        assert_eq!(stop.status, RetentionStatus::VersionBlocked);
        assert!(stop.detail.contains("取消路径返回不支持"));
    }
}
