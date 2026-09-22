//! ACP client: one `(agent_id, cwd)` connection per agent launch, many
//! sessions per connection.
//!
//! - `manager` — process lifecycle, initialize, command channel, auth.
//! - `pump` — per-session routing/pump internals and event shapes.
//! - `session` — `AcpManager` session API + wire types.
//! - `session_commands` — Tauri commands.
//! - `session_index` — meta_store row ids and merge helpers.
//! - `tap` — content-free protocol diagnostics for diagnostics.

mod failures;
pub mod manager;
mod model_guard;
pub mod pump;
pub mod session;
pub mod session_commands;
pub(crate) mod session_index;
pub(crate) mod tap;
mod terminal_output;

#[cfg(test)]
mod regression_tests;
