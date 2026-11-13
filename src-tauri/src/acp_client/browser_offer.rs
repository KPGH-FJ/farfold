//! Select transport before preparing an offer, then check the immutable actual
//! launch before any official session request may carry that offer.
use super::{LaunchKind, reviewed_launch};
use crate::acp_client::{
    manager::{LaunchIdentity, ManagedConnection},
    transient_mcp::{McpUnavailable, TransientMcpOpen, launch_rejection, safe_open_error},
};
use crate::meta_store::AgentRow;
use std::path::Path;

pub(crate) fn prepare(
    app: &tauri::AppHandle,
    sharing: &crate::browser_sharing::BrowserSharing,
    agent: &AgentRow,
    cwd: &Path,
) -> Result<TransientMcpOpen, String> {
    let launch = reviewed_launch(agent).ok_or_else(safe_open_error)?;
    if launch.authenticated_channel() {
        #[cfg(target_os = "macos")]
        return crate::acp_client::browser_process::prepare(app, sharing, &agent.id, cwd);
        #[cfg(not(target_os = "macos"))]
        return Err(safe_open_error());
    }
    sharing.prepare(app, &agent.id, cwd)
}

pub(crate) fn rejection(
    agent: &AgentRow,
    connection: &ManagedConnection,
    offer: Option<&TransientMcpOpen>,
) -> Option<McpUnavailable> {
    let launch = connection.browser_launch;
    if let Some(reason) = launch_rejection(launch, connection.mcp_spawn_facts.get().copied()) {
        return Some(reason);
    }
    // Authenticated no-secret channels cannot be interchanged with bearer
    // stdio. In particular a reviewed source is not permission to serialize an
    // old credential offer into its diagnostic/configuration objects.
    let authenticated = launch.is_some_and(LaunchKind::authenticated_channel);
    if offer.is_some_and(|offer| offer.authenticated_channel() != authenticated) {
        return Some(McpUnavailable::LaunchUnconfirmed);
    }
    // A prepared offer endorses this exact selected entrypoint. A fresh lookup
    // may otherwise launch another reviewed program with the same basename.
    // Canonical LaunchIdentity preserves ordinary executable symlink behavior.
    if (authenticated || launch == Some(LaunchKind::OpenCode))
        && (reviewed_launch(agent) != launch
            || connection.launch_identity.is_none()
            || connection.launch_identity
                != LaunchIdentity::from_launch(&agent.command, &agent.args))
    {
        return Some(McpUnavailable::LaunchUnconfirmed);
    }
    if offer.is_some_and(|offer| !offer.bind_process(connection)) {
        return Some(McpUnavailable::LaunchUnconfirmed);
    }
    None
}
