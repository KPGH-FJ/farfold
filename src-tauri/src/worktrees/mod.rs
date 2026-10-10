//! Explicit local worktree management; never controls an Agent or rewrites a conversation cwd.
mod git;
mod types;
pub use types::*;
mod recycle_types;
pub use recycle_types::*;
mod checkout;
mod create;
mod inspect;
mod manager;
mod material_scan;
mod recycle;
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

#[cfg(test)]
pub(crate) mod recycle_tests;
