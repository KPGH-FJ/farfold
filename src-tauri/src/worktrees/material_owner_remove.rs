//! Complete material comparison and removal share the original reservation.
use super::*;
impl Owner {
    pub(in crate::worktrees) fn remove_complete_tree(
        &self,
        request: crate::file_access::MixedRequest,
        cancel: &AtomicBool,
        before: impl FnOnce(MaterialSummary) -> Result<()>,
    ) -> Result<()> {
        self.slot.run(|slot| {
            let mut retirement = MixedRetirement {
                destination: slot,
                value: None,
            };
            let mut original_failure = None;
            let result = crate::file_access::with_mixed_tree_input_then(
                request,
                &mut crate::file_access::EaWorkBudget::new(crate::file_access::MATERIAL_WORK_LIMIT),
                cancel,
                &mut retirement.value,
                |mut input| input.complete_removal_digest(),
                |removal, value| {
                    removal.remove(value, || {
                        let summary = MaterialSummary {
                            profile: Some(super::super::MaterialProfile::WindowsRetainedTreeV1),
                            entries: value.content.nodes as u64,
                            bytes: value.content.bytes,
                            sha256: material_scan::hex(value.content.sha256),
                        };
                        before(summary).map_err(|failure| {
                            original_failure = Some(failure);
                            crate::file_access::CarrierFailure::Unsupported
                        })
                    })
                },
            );
            if let Some(failure) = original_failure {
                return Err(failure);
            }
            result.map(|_| ()).map_err(|e| {
                error(match e {
                    crate::file_access::CarrierFailure::Cancelled => "cancelled",
                    crate::file_access::CarrierFailure::Limit => "materialLimit",
                    crate::file_access::CarrierFailure::Changed => "materialChanged",
                    crate::file_access::CarrierFailure::CleanupUnknown => "cleanupUnknown",
                    _ => "unsupportedMaterial",
                })
            })
        })
    }
}
