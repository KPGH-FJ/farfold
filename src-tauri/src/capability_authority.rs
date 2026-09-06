use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{
    host_store::HostStore,
    lifemodel,
    opencode_runtime::{self, OpenCodeRuntime},
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
pub struct ReleaseCertification {
    certified: bool,
    evidence_code: &'static str,
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
    release_certification: CapabilitySet<ReleaseCertification>,
    installation_compatibility: CapabilitySet<InstallationCompatibility>,
    live_readiness: CapabilitySet<LiveReadiness>,
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

fn release_certification(
    _definition: ManagedRuntimeDefinition,
) -> CapabilitySet<ReleaseCertification> {
    // Historical QA belongs to its exact installed binary. This internal candidate
    // has not completed installed acceptance; source support must not promote it.
    CapabilitySet::uniform(ReleaseCertification {
        certified: false,
        evidence_code: "internal_installed_acceptance_pending",
    })
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
        release_certification: release_certification(definition),
        installation_compatibility: installation_compatibility(app, definition),
        live_readiness: live_readiness(running, lifemodel_enabled),
    }
}

#[tauri::command]
pub async fn runtime_capability_snapshot(
    app: AppHandle,
    runtime: ManagedRuntimeKey,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    host_store: State<'_, HostStore>,
) -> Result<RuntimeCapabilityAuthoritySnapshot, String> {
    let running = match runtime {
        ManagedRuntimeKey::Pi => pi_runtime::is_running(&pi)?,
        ManagedRuntimeKey::Opencode => opencode_runtime::is_running(&opencode)?,
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
    use super::{live_readiness, release_certification};

    #[test]
    fn release_certification_is_independent_from_live_readiness() {
        let release = release_certification(crate::runtime_registry::PI_RUNTIME);
        let live = live_readiness(false, true);
        let support = super::adapter_support(crate::runtime_registry::PI_RUNTIME);
        assert!(support.base && support.contributes_to_life_model && support.uses_life_model);

        assert!(!release.base.certified);
        assert!(!release.contributes_to_life_model.certified);
        assert!(!release.uses_life_model.certified);
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
}
