use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::pi_runtime::{
    self, PiCommand, PiRuntime, ProjectReadiness, RuntimeStatus, SessionSummary, StartOptions,
};

const PI_RUNTIME_VERSION: &str = "0.84.3";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdentity {
    pub(crate) product_id: String,
    pub(crate) installation_id: String,
    pub(crate) adapter_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiscovery {
    identity: RuntimeIdentity,
    display_name: &'static str,
    version: &'static str,
    distribution: &'static str,
    protocol: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
// The shared descriptor contract must keep an explicit negative state even when
// every currently shipped Adapter has passed all three independent gates.
#[allow(dead_code)]
pub enum RuntimeCapabilityLevel {
    Verified,
    Unsupported,
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

fn pi_identity() -> RuntimeIdentity {
    RuntimeIdentity {
        product_id: "pi".to_string(),
        installation_id: "bundled-pi".to_string(),
        adapter_id: "pi-rpc-jsonl".to_string(),
    }
}

pub(crate) fn opencode_identity() -> RuntimeIdentity {
    RuntimeIdentity {
        product_id: "opencode".to_string(),
        installation_id: "bundled-opencode-1.15.13-arm64".to_string(),
        adapter_id: "opencode-server-http-sse-v1".to_string(),
    }
}

fn opencode_descriptor() -> RuntimeDescriptor {
    let identity = opencode_identity();
    RuntimeDescriptor {
        discovery: RuntimeDiscovery {
            identity: identity.clone(),
            display_name: "OpenCode",
            version: crate::opencode_runtime::OPENCODE_RUNTIME_VERSION,
            distribution: "bundled",
            protocol: "opencode-server-http-sse",
        },
        capabilities: RuntimeCapabilitySnapshot {
            runtime: identity,
            base: RuntimeCapabilityLevel::Verified,
            contributes_to_life_model: RuntimeCapabilityLevel::Verified,
            uses_life_model: RuntimeCapabilityLevel::Verified,
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
    RuntimeDescriptor {
        discovery: RuntimeDiscovery {
            identity: identity.clone(),
            display_name: "Pi",
            version: PI_RUNTIME_VERSION,
            distribution: "bundled",
            protocol: "pi-rpc-jsonl",
        },
        capabilities: RuntimeCapabilitySnapshot {
            runtime: identity,
            base: RuntimeCapabilityLevel::Verified,
            contributes_to_life_model: RuntimeCapabilityLevel::Verified,
            uses_life_model: RuntimeCapabilityLevel::Verified,
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
    crate::opencode_runtime::verify_installation(&app)?;
    Ok(opencode_descriptor())
}

// These commands form a stateless host boundary. PiRuntime remains the only owner of
// process lifecycle, native sessions, persistence pointers, and the event queue.
#[tauri::command]
pub fn runtime_start(
    app: AppHandle,
    runtime: State<'_, PiRuntime>,
    options: StartOptions,
) -> Result<RuntimeStatus, String> {
    pi_runtime::pi_runtime_start(app, runtime, options)
}

#[tauri::command]
pub fn runtime_send(runtime: State<'_, PiRuntime>, command: PiCommand) -> Result<(), String> {
    pi_runtime::pi_runtime_send(runtime, command)
}

#[tauri::command]
pub fn runtime_stop(
    app: AppHandle,
    runtime: State<'_, PiRuntime>,
) -> Result<RuntimeStatus, String> {
    pi_runtime::pi_runtime_stop(app, runtime)
}

#[tauri::command]
pub fn runtime_status(
    app: AppHandle,
    runtime: State<'_, PiRuntime>,
) -> Result<RuntimeStatus, String> {
    pi_runtime::pi_runtime_status(app, runtime)
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
    use super::{PI_RUNTIME_VERSION, RuntimeCapabilityLevel, descriptor, opencode_descriptor};

    #[test]
    fn descriptor_separates_product_installation_and_adapter_identity() {
        let descriptor = descriptor();
        assert_eq!(descriptor.discovery.identity.product_id, "pi");
        assert_eq!(descriptor.discovery.identity.installation_id, "bundled-pi");
        assert_eq!(descriptor.discovery.identity.adapter_id, "pi-rpc-jsonl");
        assert_eq!(descriptor.discovery.version, PI_RUNTIME_VERSION);
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
        assert!(fetch_script.contains(&format!("PI_VERSION=\"{PI_RUNTIME_VERSION}\"")));
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
            crate::opencode_runtime::OPENCODE_RUNTIME_VERSION
        )));
    }
}
