use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;

use crate::host_ids::{
    FarfoldSessionId, NativeSessionId, ProviderConfigVersionId, ProviderConnectionId,
};
use crate::host_store::session_binding_index::HostNavigationSnapshot;
use crate::runtime_registry::{RuntimeBinding, RuntimeIdentity};

pub type OpenCodeAcpManagedProviderBinding = crate::acp_provider_profile::ManagedAcpProviderBinding;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeAcpStartInput {
    pub binary_path: PathBuf,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeAcpManagedSessionInput {
    #[cfg(test)]
    pub binary_path: PathBuf,
    #[cfg(test)]
    pub cwd: PathBuf,
    pub provider_connection_id: ProviderConnectionId,
    pub provider_config_version_id: ProviderConfigVersionId,
    pub operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeAcpLoadInput {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeAcpStatus {
    pub state: &'static str,
    pub running: bool,
    /// A native Session is bound to this connection, so prompts and client
    /// requests can reach the Runtime. The Host still verifies binding,
    /// generation and Working Copy before dispatching a Turn.
    pub ready: bool,
    pub(crate) generation: u64,
    pub runtime: RuntimeIdentity,
    pub runtime_build_id: String,
    pub runtime_connection_id: String,
    pub cwd: Option<PathBuf>,
    pub binary_path: Option<PathBuf>,
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    pub protocol_version: Option<u64>,
    pub question_bridge: bool,
    pub load_session: bool,
    pub config_options: Value,
    pub managed_provider: Option<OpenCodeAcpManagedProviderBinding>,
    pub session_id: Option<String>,
    pub last_error: Option<String>,
    pub dropped_events: u64,
    pub initialized_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeAcpSessionResult {
    pub session_id: String,
    pub farfold_session_id: Option<FarfoldSessionId>,
    pub opened_at: Option<i64>,
    pub config_options: Value,
    pub navigation: Option<HostNavigationSnapshot>,
    pub status: OpenCodeAcpStatus,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedManagedAcpProvider {
    pub binding: OpenCodeAcpManagedProviderBinding,
    pub profile_root: PathBuf,
    pub config_root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OpenCodeAcpLaunchRecord {
    pub kind: String,
    pub adapter_id: String,
    pub binary_path: PathBuf,
    pub version: String,
    pub sha256: String,
    #[serde(default)]
    pub question_bridge: bool,
}

pub(crate) struct OpenCodeAcpHostOpenResult {
    pub runtime_generation: u64,
    pub runtime_ready_at: i64,
    pub opened_at: i64,
    pub navigation: HostNavigationSnapshot,
}

pub(crate) struct OpenCodeAcpHostCreateResult {
    pub farfold_session_id: FarfoldSessionId,
    pub installation_id: String,
    pub native_session_id: String,
    pub runtime_generation: u64,
    pub runtime_ready_at: i64,
    pub opened_at: i64,
    pub navigation: HostNavigationSnapshot,
}

pub(crate) struct OpenCodeAcpHostCreateInput {
    pub binding: RuntimeBinding,
    pub binary_path: PathBuf,
    pub working_copy_path: PathBuf,
    pub managed_provider: Option<crate::managed_provider::ManagedProviderSelection>,
}

pub(crate) struct OpenCodeAcpHostOpenInput {
    pub binding: RuntimeBinding,
    pub farfold_session_id: FarfoldSessionId,
    pub working_copy_path: PathBuf,
    pub native_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeAcpPermissionResponseInput {
    pub farfold_session_id: FarfoldSessionId,
    pub native_session_id: NativeSessionId,
    pub runtime_generation: u64,
    pub request_id: String,
    pub option_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeAcpQuestionResponseInput {
    pub farfold_session_id: FarfoldSessionId,
    pub native_session_id: NativeSessionId,
    pub runtime_generation: u64,
    pub request_id: String,
    pub action: String,
    #[serde(default)]
    pub content: Option<Map<String, Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeAcpSetConfigOptionInput {
    pub farfold_session_id: FarfoldSessionId,
    pub native_session_id: NativeSessionId,
    pub config_id: String,
    pub value: Value,
    #[serde(default)]
    pub value_type: Option<String>,
}
