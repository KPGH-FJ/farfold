//! ACP client: one `(agent_id, cwd)` connection per agent launch, many
//! sessions per connection.
//!
//! - `manager` — process lifecycle, initialize, command channel, auth.
//! - `pump` — per-session routing/pump internals and event shapes.
//! - `session` — `AcpManager` session API + wire types.
//! - `session_commands` — Tauri commands.
//! - `session_index` — meta_store row ids and merge helpers.
//! - `tap` — raw protocol tap for diagnostics.

pub mod manager;
pub mod pump;
pub mod session;
pub mod session_commands;
pub(crate) mod session_index;
pub(crate) mod tap;
