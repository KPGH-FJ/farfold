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
mod material_owner;
mod material_scan;
mod read_context;
#[cfg(any(windows, test))]
mod read_policy;
mod recycle;
mod storage;
#[cfg(windows)]
mod windows_git;
#[cfg(windows)]
mod windows_offline_program;
#[cfg(windows)]
mod windows_scope;
#[cfg(all(windows, test))]
mod windows_tests;
#[cfg(all(windows, test))]
pub(crate) use git::source_roots::ManagedRootGitEdge;
pub use manager::Worktrees;

// Existing local-tree reads/adoption are distinct from unimplemented filesystem
// mutations. Refuse before any durable intent or background work on Windows.
fn mutation_supported() -> types::Result<()> {
    if cfg!(windows) {
        Err(types::error("unsupportedGit"))
    } else {
        Ok(())
    }
}
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

mod preparation_types;
pub use preparation_types::*;
mod preparation;
mod preparation_git;
#[cfg(all(test, target_os = "macos"))]
mod preparation_tests;
#[cfg(windows)]
mod preparation_windows;
