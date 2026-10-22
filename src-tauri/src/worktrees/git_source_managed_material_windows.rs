//! One opaque source-role capability; same original owner, no second controller.
use super::*;
use crate::file_access::{CarrierFailure as E, DirectoryObservation, EaWorkBudget};
use std::fs::File;
type MaterialResult<T> = std::result::Result<T, E>;
// Private constructor and fields: no path/string/metadata receipt can forge this.
// The owner does not point back to Sources/Store. An unknown original Slot may
// therefore retain this exact SourceOwner without a reference cycle/lifetime.
pub(crate) struct ManagedRootGitEdge {
    owner: EdgeOwner,
}
// The original common metadata/program owner outlives private registration
// disposal and the final root close, including an unknown-close retirement.
pub(crate) struct ManagedRemovalHold {
    _common: Arc<super::super::super::windows_git::RemovalContext>,
}
enum EdgeOwner {
    Source(Arc<SourceOwner>),
    Recovery(Arc<super::recovered::RecoveryOwner>),
    Deletion(Arc<super::deletion::DeletionOwner>),
}
impl SourceGraph {
    pub(in crate::worktrees) fn managed_root_git_edge(&self) -> ManagedRootGitEdge {
        ManagedRootGitEdge {
            owner: EdgeOwner::Source(Arc::clone(&self.owner)),
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
    pub(super) fn deletion(owner: Arc<super::deletion::DeletionOwner>) -> Self {
        Self {
            owner: EdgeOwner::Deletion(owner),
        }
    }
    pub(crate) fn deletion_purpose(&self) -> bool {
        matches!(self.owner, EdgeOwner::Deletion(_))
    }
    pub(crate) fn remove(
        self,
        retained: &mut Option<ManagedRemovalHold>,
        stopped: &mut Vec<crate::file_access::DeleteStoppedHandle>,
        work: &mut EaWorkBudget,
        cancel: &AtomicBool,
    ) -> MaterialResult<()> {
        match self.owner {
            EdgeOwner::Deletion(owner) => {
                *retained = Some(ManagedRemovalHold {
                    _common: owner.common_owner(),
                });
                owner.remove(stopped, work, cancel)
            }
            _ => Err(E::Unsupported),
        }
    }
    pub(super) fn recovered(owner: Arc<super::recovered::RecoveryOwner>) -> Self {
        Self {
            owner: EdgeOwner::Recovery(owner),
        }
    }
    pub(crate) fn verify(
        &self,
        work: &mut EaWorkBudget,
        cancel: &AtomicBool,
    ) -> MaterialResult<()> {
        cancelled(cancel).map_err(mapped)?;
        let owner = match &self.owner {
            EdgeOwner::Source(owner) => owner,
            EdgeOwner::Recovery(owner) => return owner.recheck_with(cancel, work).map_err(mapped),
            EdgeOwner::Deletion(owner) => return owner.recheck(work, cancel).map_err(mapped),
        };
        // Separate bounded leaf-body reads from actual directory query spans.
        // read() offers at most before.size+1 for an unchanged bounded leaf.
        // No entry-count or guessed "one page per directory" byte estimate.
        let mut bytes = 0usize;
        for leaf in &owner.inventory.leaves {
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
        owner
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
        match &self.owner {
            EdgeOwner::Source(owner) => &owner.managed_root_git,
            EdgeOwner::Recovery(owner) => &owner.managed_root_git,
            EdgeOwner::Deletion(owner) => return owner.matches(root, raw, listed),
        }
        .matches_material_edge(root, raw, listed)
        .map_err(mapped)
    }
}
