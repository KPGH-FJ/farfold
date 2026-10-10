//! Explicit local worktree management; never controls an Agent or rewrites a conversation cwd.
mod git;
mod types;
pub use types::*;
mod checkout;
mod create;
mod inspect;
mod manager;
mod storage;
pub use manager::Worktrees;
#[cfg(test)]
mod checkout_boundary_tests;
#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
mod config_compatibility_tests;
#[cfg(test)]
mod wire_tests;
