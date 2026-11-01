//! ACP client: one process per active conversation, with separate reusable
//! preparation connections for authentication and history discovery.
//!
//! - `manager` — process lifecycle, initialize, command channel, auth.
//! - `pump` — per-session routing/pump internals and event shapes.
//! - `session` — `AcpManager` session API + wire types.
//! - `session_commands` — Tauri commands.
//! - `session_index` — meta_store row ids and merge helpers.
//! - `tap` — content-free protocol diagnostics for diagnostics.

mod account_launch;
mod account_logout;
mod account_observer;
mod account_query;
pub(crate) mod account_status;
mod active_prompt;
pub mod active_prompt_commands;
#[cfg(test)]
mod active_prompt_tests;
mod api_key_auth;
mod async_tasks;
pub(crate) mod auth_compat;
pub mod auth_connection;
pub(crate) mod auth_route;
pub(crate) mod browser_capability;
mod cold_history_open;
mod compaction_activity;
pub mod delivery_flow;
pub mod delivery_observation;
mod dependency_environment;
pub(crate) mod directory_presentation;
mod elicitation;
pub mod extension_inventory;
mod failures;
pub(crate) mod first_release;
pub(crate) mod handshake;
mod history_admission;
pub mod history_admission_commands;
pub mod history_search;
pub mod identity_read;
mod initialization;
pub(crate) mod installation_parameters;
mod lifecycle;
pub mod manager;
mod model_guard;
mod mutation;
mod open_purpose;
mod operations;
mod permission_effect;
mod permission_guard;
pub mod plugin_management;
pub mod preparation;
pub mod preparation_actions;
mod process;
mod prompt_charge;
mod prompt_wait;
pub mod pump;
pub(crate) mod recipes;
mod reported_output;
pub(crate) mod service_config;
pub mod service_connection;
mod service_delivery;
pub mod session;
pub mod session_commands;
mod session_config;
pub mod session_discovery;
pub mod session_fork;
pub(crate) mod session_index;
pub mod skill_management;
pub(crate) mod startup_diagnostics;
pub(crate) mod tap;
mod terminal_output;
mod tool_activity;
pub(crate) mod transient_mcp;
pub(crate) mod versions;

#[cfg(test)]
mod regression_tests;

mod wait;
pub mod workspace_access;

#[cfg(test)]
mod config_guard_tests;

#[cfg(test)]
mod category_guard_tests;

#[cfg(test)]
mod lifecycle_tests;

#[cfg(test)]
mod discovery_tests;

#[cfg(test)]
mod history_replay_identity_tests;

#[cfg(test)]
mod usage_wire_tests;

#[cfg(test)]
mod elicitation_wire_tests;

#[cfg(test)]
mod elicitation_request_tests;

#[cfg(test)]
mod route_registration_tests;

#[cfg(test)]
mod permission_guard_tests;

#[cfg(test)]
mod permission_scope_guard_tests;

#[cfg(test)]
mod permission_effect_tests;

#[cfg(test)]
mod prompt_config_race_tests;

#[cfg(test)]
mod permission_request_tests;

#[cfg(test)]
mod cancellation_tests;

#[cfg(test)]
mod cancel_starvation_tests;

#[cfg(test)]
mod boolean_configuration_tests;

#[cfg(test)]
mod archive_tests;

#[cfg(test)]
mod tool_activity_tests;

#[cfg(test)]
mod transient_mcp_route_tests;

#[cfg(test)]
mod compaction_wire_tests;

#[cfg(test)]
mod compaction_activity_wire_tests;

#[cfg(all(test, target_os = "macos"))]
mod installed_initialize_probe;

#[cfg(test)]
mod async_task_wire_tests;

#[cfg(test)]
mod event_transport_baseline_tests;

#[cfg(test)]
mod load_prefix_consumption_tests;

mod ingress_permit;
mod process_bridge;
mod session_routes;
mod transient_pressure;

#[cfg(test)]
mod flow_pressure_tests;
