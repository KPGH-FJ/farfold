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

mod remove_types;
pub use remove_types::*;
mod recovery_pack;
mod recovery_roots;
#[cfg(test)]
mod recovery_tests;

mod removal;
mod remove_validation;

mod recover;

#[cfg(test)]
mod recover_tests;

#[cfg(test)]
mod remove_boundary_tests;

#[cfg(test)]
mod remove_wire_tests;
