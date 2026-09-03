use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::capability_authority::release_capability_flags;
use crate::host_ids::{AdapterId, ConnectionId, InstallationId, RuntimeBuildId, RuntimeProductId};
use crate::host_store::{
    HostStore, now_millis,
    records::{RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration},
};
use crate::interaction_registry::InteractionRegistry;
use crate::pi_runtime::{
    self, PiCommand, PiRuntime, ProjectReadiness, RuntimeStatus, SessionSummary, StartOptions,
};
use crate::runtime_registry::{
    ManagedRuntimeDefinition, OPENCODE_RUNTIME, ObservedRuntimeInstallation, PI_RUNTIME,
    RuntimeIdentity, opencode_identity, pi_identity, verify_managed_installation,
};
use crate::runtime_supervisor::{self, RuntimeSupervisor};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiscovery {
    identity: RuntimeIdentity,
    runtime_build_id: &'static str,
    default_connection_id: &'static str,
    display_name: &'static str,
    version: &'static str,
    artifact_sha256: &'static str,
    distribution: &'static str,
    protocol: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeCapabilityLevel {
    Verified,
    Unsupported,
}

impl RuntimeCapabilityLevel {
    fn from_certification(certified: bool) -> Self {
        if certified {
            Self::Verified
        } else {
            Self::Unsupported
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilitySnapshot {
    runtime: RuntimeIdentity,
    base: RuntimeCapabilityLevel,
    contributes_to_life_model: RuntimeCapabilityLevel,
    uses_life_model: RuntimeCapabilityLevel,
    native_features: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    discovery: RuntimeDiscovery,
    capabilities: RuntimeCapabilitySnapshot,
}

fn discovery(definition: ManagedRuntimeDefinition) -> RuntimeDiscovery {
    RuntimeDiscovery {
        identity: definition.identity(),
        runtime_build_id: definition.runtime_build_id,
        default_connection_id: definition.default_connection_id,
        display_name: definition.display_name,
        version: definition.version,
        artifact_sha256: definition.binary_sha256,
        distribution: definition.distribution,
        protocol: definition.protocol,
    }
}

fn register_verified_runtime(
    store: &HostStore,
    observed: &ObservedRuntimeInstallation,
) -> Result<(), String> {
    let definition = observed.definition;
    let timestamp = now_millis();
    store.register_runtime(&RuntimeRegistration {
        runtime_product_id: RuntimeProductId::parse(definition.product_id)
            .map_err(|error| error.to_string())?,
        display_name: definition.display_name.to_string(),
        installation_id: InstallationId::parse(definition.installation_id)
            .map_err(|error| error.to_string())?,
        runtime_build_id: RuntimeBuildId::parse(definition.runtime_build_id)
            .map_err(|error| error.to_string())?,
        adapter_id: AdapterId::parse(definition.adapter_id).map_err(|error| error.to_string())?,
        distribution: RuntimeDistribution::Managed,
        observed_version: observed.observed_version.clone(),
        artifact_sha256: observed.artifact_sha256.clone(),
        connection_id: ConnectionId::parse(definition.default_connection_id)
            .map_err(|error| error.to_string())?,
        connection_label: format!("{} native configuration", definition.display_name),
        connection_kind: RuntimeConnectionKind::ManagedLocal,
        created_at: timestamp,
        verified_at: timestamp,
    })?;
    Ok(())
}

fn opencode_descriptor() -> RuntimeDescriptor {
    let identity = opencode_identity();
    let (base, contributes_to_life_model, uses_life_model) =
        release_capability_flags(OPENCODE_RUNTIME);
    RuntimeDescriptor {
        discovery: discovery(OPENCODE_RUNTIME),
        capabilities: RuntimeCapabilitySnapshot {
            runtime: identity,
            base: RuntimeCapabilityLevel::from_certification(base),
            contributes_to_life_model: RuntimeCapabilityLevel::from_certification(
                contributes_to_life_model,
            ),
            uses_life_model: RuntimeCapabilityLevel::from_certification(uses_life_model),
            native_features: vec![
                "provider_model",
                "tools",
                "permissions",
                "abort",
                "native_session_resume",
                "server_restart_recovery",
                "life_model_source_contribution",
                "life_model_context_injection",
            ],
        },
    }
}

fn descriptor() -> RuntimeDescriptor {
    let identity = pi_identity();
    let (base, contributes_to_life_model, uses_life_model) = release_capability_flags(PI_RUNTIME);
    RuntimeDescriptor {
        discovery: discovery(PI_RUNTIME),
        capabilities: RuntimeCapabilitySnapshot {
            runtime: identity,
            base: RuntimeCapabilityLevel::from_certification(base),
            contributes_to_life_model: RuntimeCapabilityLevel::from_certification(
                contributes_to_life_model,
            ),
            uses_life_model: RuntimeCapabilityLevel::from_certification(uses_life_model),
            native_features: vec![
                "provider_model",
                "project_resources",
                "skills",
                "extensions",
                "tools",
                "compaction",
                "steering",
                "follow_up",
                "abort",
                "resume",
            ],
        },
    }
}

#[tauri::command]
pub fn runtime_discover(
    app: AppHandle,
    store: State<'_, HostStore>,
) -> Result<RuntimeDescriptor, String> {
    let observed = verify_managed_installation(&app, PI_RUNTIME)?;
    register_verified_runtime(&store, &observed)?;
    Ok(descriptor())
}

#[tauri::command]
pub fn opencode_runtime_discover(
    app: AppHandle,
    store: State<'_, HostStore>,
) -> Result<RuntimeDescriptor, String> {
    let observed = verify_managed_installation(&app, OPENCODE_RUNTIME)?;
    register_verified_runtime(&store, &observed)?;
    Ok(opencode_descriptor())
}

// PiRuntime owns process lifecycle, native Sessions, and the event queue. The Host store owns
// Farfold's immutable binding and the validated locator needed to ask Pi to resume that Session.
#[tauri::command]
pub fn runtime_start(
    app: AppHandle,
    supervisor: State<'_, RuntimeSupervisor>,
    runtime: State<'_, PiRuntime>,
    options: StartOptions,
) -> Result<RuntimeStatus, String> {
    runtime_supervisor::pi_start(app, &supervisor, &runtime, options)
}

#[tauri::command]
pub fn runtime_send(
    runtime: State<'_, PiRuntime>,
    interactions: State<'_, InteractionRegistry>,
    command: PiCommand,
) -> Result<(), String> {
    let Some(interaction_id) = command.extension_response_id().map(str::to_string) else {
        return pi_runtime::pi_runtime_send(runtime, command);
    };
    let generation = pi_runtime::running_generation(&runtime)?;
    interactions.begin_response(PI_RUNTIME, generation, &interaction_id, None)?;
    let result = pi_runtime::pi_runtime_send(runtime, command);
    interactions.finish_response(PI_RUNTIME, generation, &interaction_id, result.is_ok())?;
    result
}

#[tauri::command]
pub fn runtime_stop(
    app: AppHandle,
    supervisor: State<'_, RuntimeSupervisor>,
    runtime: State<'_, PiRuntime>,
) -> Result<RuntimeStatus, String> {
    runtime_supervisor::pi_stop(app, &supervisor, &runtime)
}

#[tauri::command]
pub fn runtime_status(
    app: AppHandle,
    supervisor: State<'_, RuntimeSupervisor>,
    runtime: State<'_, PiRuntime>,
) -> Result<RuntimeStatus, String> {
    runtime_supervisor::pi_status(app, &supervisor, &runtime)
}

#[tauri::command]
pub fn runtime_list_sessions(app: AppHandle) -> Result<Vec<SessionSummary>, String> {
    pi_runtime::pi_runtime_list_sessions(app)
}

#[tauri::command]
pub fn runtime_project_readiness(project_path: String) -> Result<ProjectReadiness, String> {
    pi_runtime::pi_runtime_project_readiness(project_path)
}

#[tauri::command]
pub fn runtime_remember_session(
    app: AppHandle,
    runtime: State<'_, PiRuntime>,
    store: State<'_, HostStore>,
    session_file: String,
) -> Result<bool, String> {
    let observed = verify_managed_installation(&app, PI_RUNTIME)?;
    register_verified_runtime(&store, &observed)?;
    let changed = pi_runtime::pi_runtime_remember_session(runtime, store.clone(), session_file)?;
    let profile_path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Farfold data directory: {error}"))?;
    crate::host_store::legacy::finalize_pi_pointer_if_bound(&store, &profile_path)?;
    Ok(changed)
}

#[tauri::command]
pub fn runtime_poll_events(runtime: State<'_, PiRuntime>) -> Result<Vec<Value>, String> {
    pi_runtime::pi_runtime_poll_events(runtime)
}

#[cfg(test)]
mod tests {
    use super::{
        RuntimeCapabilityLevel, descriptor, opencode_descriptor, register_verified_runtime,
    };
    use crate::{
        host_store::HostStore,
        runtime_registry::{OPENCODE_RUNTIME, ObservedRuntimeInstallation, PI_RUNTIME},
    };
    use std::{fs, path::PathBuf};

    #[test]
    fn descriptor_separates_product_installation_and_adapter_identity() {
        let descriptor = descriptor();
        assert_eq!(descriptor.discovery.identity.product_id, "pi");
        assert_eq!(descriptor.discovery.identity.installation_id, "bundled-pi");
        assert_eq!(descriptor.discovery.identity.adapter_id, "pi-rpc-jsonl");
        assert_eq!(descriptor.discovery.version, PI_RUNTIME.version);
        assert_eq!(
            descriptor.discovery.runtime_build_id,
            PI_RUNTIME.runtime_build_id
        );
        assert_eq!(
            descriptor.discovery.default_connection_id,
            PI_RUNTIME.default_connection_id
        );
    }

    #[test]
    fn descriptor_reports_only_native_app_verified_life_model_capabilities() {
        let descriptor = descriptor();
        assert_eq!(
            descriptor.capabilities.base,
            RuntimeCapabilityLevel::Verified
        );
        assert_eq!(
            descriptor.capabilities.contributes_to_life_model,
            RuntimeCapabilityLevel::Verified
        );
        assert_eq!(
            descriptor.capabilities.uses_life_model,
            RuntimeCapabilityLevel::Verified
        );
    }

    #[test]
    fn descriptor_version_matches_the_fetch_pin() {
        let fetch_script = include_str!("../../scripts/fetch-pi-sidecar.sh");
        assert!(fetch_script.contains(&format!("PI_VERSION=\"{}\"", PI_RUNTIME.version)));
    }

    #[test]
    fn opencode_descriptor_marks_independently_verified_life_model_capabilities() {
        let descriptor = opencode_descriptor();
        assert_eq!(descriptor.discovery.identity.product_id, "opencode");
        assert_eq!(
            descriptor.discovery.identity.installation_id,
            "bundled-opencode-1.15.13-arm64"
        );
        assert_eq!(
            descriptor.capabilities.base,
            RuntimeCapabilityLevel::Verified
        );
        assert_eq!(
            descriptor.capabilities.contributes_to_life_model,
            RuntimeCapabilityLevel::Verified
        );
        assert_eq!(
            descriptor.capabilities.uses_life_model,
            RuntimeCapabilityLevel::Verified
        );
    }

    #[test]
    fn opencode_descriptor_version_matches_the_fetch_pin() {
        let fetch_script = include_str!("../../scripts/fetch-opencode-sidecar.sh");
        assert!(fetch_script.contains(&format!(
            "OPENCODE_VERSION=\"{}\"",
            OPENCODE_RUNTIME.version
        )));
    }

    #[test]
    fn verified_runtime_registration_is_idempotent_and_rejects_changed_build_metadata() {
        let root = std::env::temp_dir().join(format!(
            "farfold-runtime-registration-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = HostStore::open(root.join("host.sqlite3"));
        let observed = ObservedRuntimeInstallation {
            definition: PI_RUNTIME,
            binary_path: PathBuf::from("unused-in-registration"),
            observed_version: PI_RUNTIME.version.to_string(),
            artifact_sha256: PI_RUNTIME.binary_sha256.to_string(),
        };

        register_verified_runtime(&store, &observed).unwrap();
        register_verified_runtime(&store, &observed).unwrap();

        let changed = ObservedRuntimeInstallation {
            observed_version: "different-version".to_string(),
            ..observed
        };
        let error = register_verified_runtime(&store, &changed).unwrap_err();
        assert!(error.contains("different metadata"));
        drop(store);
        let _ = fs::remove_dir_all(root);
    }
}
