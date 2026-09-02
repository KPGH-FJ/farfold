use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::capability_authority::release_capability_flags;
use crate::pi_runtime::{
    self, PiCommand, PiRuntime, ProjectReadiness, RuntimeStatus, SessionSummary, StartOptions,
};
use crate::runtime_registry::{
    ManagedRuntimeDefinition, OPENCODE_RUNTIME, PI_RUNTIME, RuntimeIdentity, opencode_identity,
    pi_identity, verify_managed_installation,
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
pub fn runtime_discover() -> RuntimeDescriptor {
    descriptor()
}

#[tauri::command]
pub fn opencode_runtime_discover(app: AppHandle) -> Result<RuntimeDescriptor, String> {
    verify_managed_installation(&app, OPENCODE_RUNTIME)?;
    Ok(opencode_descriptor())
}

// These commands form a stateless host boundary. PiRuntime remains the only owner of
// process lifecycle, native sessions, persistence pointers, and the event queue.
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
pub fn runtime_send(runtime: State<'_, PiRuntime>, command: PiCommand) -> Result<(), String> {
    pi_runtime::pi_runtime_send(runtime, command)
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
    session_file: String,
) -> Result<bool, String> {
    pi_runtime::pi_runtime_remember_session(app, runtime, session_file)
}

#[tauri::command]
pub fn runtime_poll_events(runtime: State<'_, PiRuntime>) -> Result<Vec<Value>, String> {
    pi_runtime::pi_runtime_poll_events(runtime)
}

#[cfg(test)]
mod tests {
    use super::{RuntimeCapabilityLevel, descriptor, opencode_descriptor};
    use crate::runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME};

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
}
