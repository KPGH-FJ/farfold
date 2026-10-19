//! One opaque source-role capability; same original owner, no second controller.
use super::*;
use crate::file_access::{CarrierFailure as E, DirectoryObservation, EaWorkBudget};
use std::fs::File;
type MaterialResult<T> = std::result::Result<T, E>;
// Private constructor and fields: no path/string/metadata receipt can forge this.
// The owner does not point back to Sources/Store. An unknown original Slot may
// therefore retain this exact SourceOwner without a reference cycle/lifetime.
pub(crate) struct ManagedRootGitEdge {
    owner: Arc<SourceOwner>,
}
impl SourceGraph {
    pub(in crate::worktrees) fn managed_root_git_edge(&self) -> ManagedRootGitEdge {
        ManagedRootGitEdge {
            owner: Arc::clone(&self.owner),
        }
    }
}
fn mapped(failure: super::super::super::types::Failure) -> E {
    match failure.code {
        "cancelled" => E::Cancelled,
        "recoveryLimit" => E::Limit,
        "recoveryChanged" | "changed" => E::Changed,
        _ => E::Unsupported,
    }
}
impl ManagedRootGitEdge {
    pub(crate) fn verify(
        &self,
        work: &mut EaWorkBudget,
        cancel: &AtomicBool,
    ) -> MaterialResult<()> {
        cancelled(cancel).map_err(mapped)?;
        // Separate bounded leaf-body reads from actual directory query spans.
        // read() offers at most before.size+1 for an unchanged bounded leaf.
        // No entry-count or guessed "one page per directory" byte estimate.
        let mut bytes = 0usize;
        for leaf in &self.owner.inventory.leaves {
            if leaf.sha256.is_some() {
                bytes = bytes
                    .checked_add(
                        usize::try_from(leaf.before.size)
                            .map_err(|_| E::Limit)?
                            .checked_add(1)
                            .ok_or(E::Limit)?,
                    )
                    .ok_or(E::Limit)?;
            }
        }
        work.charge(bytes).map_err(|_| E::Limit)?;
        self.owner
            .recheck_with(cancel, |pin, remaining| {
                crate::file_access::directory_entries_with_work(pin, remaining, cancel, work)
                    .map_err(directory_error)
            })
            .map_err(mapped)
    }
    pub(crate) fn matches(
        &self,
        root: &File,
        raw: &[u16],
        listed: &DirectoryObservation,
    ) -> MaterialResult<()> {
        self.owner
            .managed_root_git
            .matches_material_edge(root, raw, listed)
            .map_err(mapped)
    }
}
