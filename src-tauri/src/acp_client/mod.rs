//! ACP client: one `(agent_id, cwd)` connection per agent launch, many
//! sessions per connection.
//!
//! - `manager` — process lifecycle, initialize, command channel, auth.
//! - `pump` — per-session routing/pump internals and event shapes.
//! - `fs_ops` — `fs/read_text_file`/`fs/write_text_file` client capability.
//! - `terminal_ops` — `terminal/*` client capability over `PtyManager`.
//! - `session` — `AcpManager` session API + wire types.
//! - `session_commands` — Tauri commands.
//! - `session_index` — meta_store row ids and merge helpers.
//! - `tap` — content-free protocol diagnostics for diagnostics.

pub(crate) mod fs_ops;
pub mod manager;
pub mod pump;
pub mod session;
pub mod session_commands;
pub(crate) mod session_index;
pub(crate) mod tap;
pub(crate) mod terminal_ops;

#[cfg(test)]
mod regression_tests;
