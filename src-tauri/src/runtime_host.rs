use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::capability_authority::adapter_capability_flags;
use crate::host_ids::{AdapterId, ConnectionId, InstallationId, RuntimeBuildId, RuntimeProductId};
use crate::host_store::{
    HostStore, now_millis,
    records::{RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration},
};
use crate::interaction_registry::InteractionRegistry;
use crate::pi_runtime::{self, PiCommand, PiRuntime, ProjectReadiness, RuntimeStatus};
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
    Supported,
    Unsupported,
}

impl RuntimeCapabilityLevel {
    fn from_support(supported: bool) -> Self {
        if supported {
            Self::Supported
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

pub(crate) fn register_verified_runtime(
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
        adapter_capability_flags(OPENCODE_RUNTIME);
    RuntimeDescriptor {
        discovery: discovery(OPENCODE_RUNTIME),
        capabilities: RuntimeCapabilitySnapshot {
            runtime: identity,
            base: RuntimeCapabilityLevel::from_support(base),
            contributes_to_life_model: RuntimeCapabilityLevel::from_support(
                contributes_to_life_model,
            ),
            uses_life_model: RuntimeCapabilityLevel::from_support(uses_life_model),
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
    let (base, contributes_to_life_model, uses_life_model) = adapter_capability_flags(PI_RUNTIME);
    RuntimeDescriptor {
        discovery: discovery(PI_RUNTIME),
        capabilities: RuntimeCapabilitySnapshot {
            runtime: identity,
            base: RuntimeCapabilityLevel::from_support(base),
            contributes_to_life_model: RuntimeCapabilityLevel::from_support(
                contributes_to_life_model,
            ),
            uses_life_model: RuntimeCapabilityLevel::from_support(uses_life_model),
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

#[tauri::command]
pub fn runtime_send(
    runtime: State<'_, PiRuntime>,
    interactions: State<'_, InteractionRegistry>,
    command: PiCommand,
) -> Result<(), String> {
    if matches!(
        command,
        PiCommand::GetMessages { .. } | PiCommand::GetEntries { .. }
    ) {
        return Err("Pi history must use the bounded correlated history channel".to_string());
    }
    if command_requires_host_session_authority(&command) {
        return Err(format!(
            "Pi {} must pass through the Host Session command authority",
            command.kind()
        ));
    }
    let Some(interaction_id) = command.extension_response_id().map(str::to_string) else {
        return pi_runtime::send_command(&runtime, command);
    };
    let generation = pi_runtime::running_generation(&runtime)?;
    interactions.begin_response(PI_RUNTIME, generation, &interaction_id, None)?;
    let result = pi_runtime::send_command(&runtime, command);
    interactions.finish_response(PI_RUNTIME, generation, &interaction_id, result.is_ok())?;
    result
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum PiHistoryQuery {
    GetMessages {},
    GetEntries { since: Option<String> },
}

#[tauri::command]
pub async fn runtime_history(
    app: AppHandle,
    query: PiHistoryQuery,
) -> Result<serde_json::Value, String> {
    // Bulk native snapshots are responses, not replayable live events. Reuse the
    // Runtime's existing generation-bound correlation; never retain them in the ring.
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<PiRuntime>();
        let generation = pi_runtime::running_generation(&runtime)?;
        let id = Some(pi_runtime::next_request_id(&runtime, "history"));
        let command = match query {
            PiHistoryQuery::GetMessages {} => PiCommand::GetMessages { id },
            PiHistoryQuery::GetEntries { since } => PiCommand::GetEntries { id, since },
        };
        let response =
            pi_runtime::correlated_request(&runtime, command, std::time::Duration::from_secs(30))?;
        if pi_runtime::running_generation(&runtime)? != generation {
            return Err("Pi history belongs to an expired Runtime generation".to_string());
        }
        Ok(response)
    })
    .await
    .map_err(|_| "Pi history read was interrupted".to_string())?
}

fn command_requires_host_session_authority(command: &PiCommand) -> bool {
    command.is_turn_submission() || command.is_abort() || command.is_lifecycle_mutation()
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
pub fn runtime_project_readiness(project_path: String) -> Result<ProjectReadiness, String> {
    pi_runtime::pi_runtime_project_readiness(project_path)
}

#[cfg(test)]
mod tests {
    use super::{
        RuntimeCapabilityLevel, command_requires_host_session_authority, descriptor,
        opencode_descriptor, register_verified_runtime,
    };
    use crate::{
        host_store::HostStore,
        pi_runtime::PiCommand,
        runtime_registry::{OPENCODE_RUNTIME, ObservedRuntimeInstallation, PI_RUNTIME},
    };
    use std::{fs, path::PathBuf};

    #[test]
    fn history_channel_only_accepts_native_read_queries() {
        for input in [
            serde_json::json!({"type":"prompt", "message":"hello"}),
            serde_json::json!({"type":"get_messages", "path":"/tmp/other"}),
            serde_json::json!({"type":"get_entries", "since":"entry", "id":"external"}),
        ] {
            assert!(serde_json::from_value::<super::PiHistoryQuery>(input).is_err());
        }
        assert!(
            serde_json::from_value::<super::PiHistoryQuery>(
                serde_json::json!({"type":"get_entries", "since":"entry"})
            )
            .is_ok()
        );
    }

    #[test]
    fn raw_pi_channel_excludes_turn_abort_and_lifecycle_mutations() {
        assert!(command_requires_host_session_authority(
            &PiCommand::Prompt {
                id: None,
                message: "hello".to_string(),
            }
        ));
        assert!(command_requires_host_session_authority(&PiCommand::Abort {
            id: None,
        }));
        assert!(command_requires_host_session_authority(
            &PiCommand::NewSession { id: None }
        ));
        assert!(!command_requires_host_session_authority(
            &PiCommand::GetState { id: None }
        ));
        assert!(command_requires_host_session_authority(
            &PiCommand::Prompt {
                id: None,
                message: "/farfold-lifemodel-clear".to_string(),
            }
        ));
        assert!(command_requires_host_session_authority(
            &PiCommand::Prompt {
                id: None,
                message: "/farfold-lifemodel-context attacker-controlled".to_string(),
            }
        ));
    }

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
    fn descriptor_reports_adapter_support_independently_of_release_acceptance() {
        let descriptor = descriptor();
        assert_eq!(
            descriptor.capabilities.base,
            RuntimeCapabilityLevel::Supported
        );
        assert_eq!(
            descriptor.capabilities.contributes_to_life_model,
            RuntimeCapabilityLevel::Supported
        );
        assert_eq!(
            descriptor.capabilities.uses_life_model,
            RuntimeCapabilityLevel::Supported
        );
    }

    #[test]
    fn descriptor_version_matches_the_fetch_pin() {
        let fetch_script = include_str!("../../scripts/fetch-pi-sidecar.sh");
        assert!(fetch_script.contains(&format!("PI_VERSION=\"{}\"", PI_RUNTIME.version)));
    }

    #[test]
    fn opencode_descriptor_reports_adapter_support_without_release_promotion() {
        let descriptor = opencode_descriptor();
        assert_eq!(descriptor.discovery.identity.product_id, "opencode");
        assert_eq!(
            descriptor.discovery.identity.installation_id,
            "bundled-opencode-1.15.13-arm64"
        );
        assert_eq!(
            descriptor.capabilities.base,
            RuntimeCapabilityLevel::Supported
        );
        assert_eq!(
            descriptor.capabilities.contributes_to_life_model,
            RuntimeCapabilityLevel::Supported
        );
        assert_eq!(
            descriptor.capabilities.uses_life_model,
            RuntimeCapabilityLevel::Supported
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
