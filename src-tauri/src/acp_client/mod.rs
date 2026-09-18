//! ACP client layer built on the official `agent-client-protocol` crate.
//!
//! [`manager::AcpManager`] owns one agent process per `(agent_id, cwd)` pair:
//! spawn → `initialize` handshake → idle on a command channel for
//! `authenticate`/shutdown and session work. All agent differences are
//! expressed through protocol data (`agentCapabilities`, `configOptions`,
//! `authMethods`); this module holds no agent-specific logic.

pub mod manager;
