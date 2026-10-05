//! ACP client: one process per active conversation, with separate reusable
//! preparation connections for authentication and history discovery.
//!
//! - `manager` — process lifecycle, initialize, command channel, auth.
//! - `pump` — per-session routing/pump internals and event shapes.
//! - `session` — `AcpManager` session API + wire types.
//! - `session_commands` — Tauri commands.
//! - `session_index` — meta_store row ids and merge helpers.
//! - `tap` — content-free protocol diagnostics for diagnostics.

pub(crate) mod account_status;
mod api_key_auth;
pub(crate) mod auth_compat;
pub mod auth_connection;
pub(crate) mod auth_route;
pub(crate) mod browser_capability;
mod dependency_environment;
pub(crate) mod directory_presentation;
mod failures;
pub(crate) mod first_release;
pub(crate) mod handshake;
mod initialization;
pub(crate) mod installation_parameters;
mod lifecycle;
pub mod manager;
mod model_guard;
mod mutation;
mod operations;
mod permission_guard;
pub mod preparation;
pub mod preparation_actions;
mod process;
pub mod pump;
pub(crate) mod recipes;
pub(crate) mod service_config;
pub mod service_connection;
pub mod session;
pub mod session_commands;
mod session_config;
pub mod session_discovery;
pub(crate) mod session_index;
pub(crate) mod startup_diagnostics;
pub(crate) mod tap;
mod terminal_output;
mod tool_activity;
pub(crate) mod transient_mcp;
pub(crate) mod versions;

#[cfg(test)]
mod regression_tests;

mod wait;

#[cfg(test)]
mod config_guard_tests;

#[cfg(test)]
mod category_guard_tests;

#[cfg(test)]
mod lifecycle_tests;

#[cfg(test)]
mod discovery_tests;

#[cfg(test)]
mod route_registration_tests;

#[cfg(test)]
mod permission_guard_tests;

#[cfg(test)]
mod permission_request_tests;

#[cfg(test)]
mod archive_tests;

#[cfg(test)]
mod tool_activity_tests;

#[cfg(test)]
mod transient_mcp_route_tests;
