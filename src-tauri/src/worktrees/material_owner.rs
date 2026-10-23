//! One runtime reservation and finite retirement, never a pointer ledger/worker.
#[cfg(any(windows, test))]
use super::types::error;
use super::{material_scan, recycle_types::MaterialSummary, types::Result};
#[cfg(any(windows, test))]
use std::{
    mem::ManuallyDrop,
    panic::AssertUnwindSafe,
    sync::{Mutex, TryLockError},
};
use std::{path::Path, sync::atomic::AtomicBool};

#[cfg(any(windows, test))]
struct Slot<T> {
    retired: Mutex<Option<ManuallyDrop<Box<T>>>>,
}
#[cfg(any(windows, test))]
impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self {
            retired: Mutex::new(None),
        }
    }
}
#[cfg(any(windows, test))]
impl<T> Slot<T> {
    fn occupied(&self) -> bool {
        match self.retired.try_lock() {
            Ok(value) => value.is_some(),
            Err(_) => true,
        }
    }
    fn available(&self) -> Result<()> {
        match self.retired.try_lock() {
            Ok(value) if value.is_some() => Err(error("cleanupUnknown")),
            Ok(_) => Ok(()),
            Err(TryLockError::WouldBlock) => Err(error("busy")),
            Err(TryLockError::Poisoned(_)) => Err(error("unknown")),
        }
    }
    fn run<U>(&self, f: impl FnOnce(&mut Option<T>) -> Result<U>) -> Result<U> {
        let mut slot = self.retired.try_lock().map_err(|e| {
            error(match e {
                TryLockError::WouldBlock => "busy",
                TryLockError::Poisoned(_) => "unknown",
            })
        })?;
        if slot.is_some() {
            return Err(error("cleanupUnknown"));
        }
        // This guard is the reservation, acquired before any native context.
        // Contenders fail, not wait. Native verification, including the recycle
        // failure recheck, runs outside the manager state mutex.
        let mut retirement = None;
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| f(&mut retirement)));
        if let Some(owner) = retirement {
            // Explicit bounded retention until process death. Do not call the
            // failed native context again, even during runtime/App teardown.
            // ManuallyDrop preserves the Box allocation/File handles/context;
            // it is not a claim that abort FALSE released anything. One runtime
            // can put at most one owner here and refuses all later reservations.
            *slot = Some(ManuallyDrop::new(Box::new(owner)));
            return Err(error("cleanupUnknown"));
        }
        result.unwrap_or_else(|_| Err(error("unknown")))
    }
}
#[cfg(windows)]
enum Retirement {
    Backup {
        _owner: crate::file_access::RetiredBackup,
    },
    Material {
        _owner: crate::file_access::MaterialStoreRetirement,
    },
    Mixed {
        _owner: crate::file_access::MixedRetirement,
    },
}
#[cfg(windows)]
struct PartialRetirement<'a> {
    destination: &'a mut Option<Retirement>,
    value: Option<crate::file_access::RetiredBackup>,
}
#[cfg(windows)]
struct MixedRetirement<'a> {
    destination: &'a mut Option<Retirement>,
    value: Option<crate::file_access::MixedRetirement>,
}
#[cfg(windows)]
impl Drop for MixedRetirement<'_> {
    fn drop(&mut self) {
        if let Some(value) = self.value.take() {
            *self.destination = Some(Retirement::Mixed { _owner: value });
        }
    }
}
#[cfg(windows)]
impl Drop for PartialRetirement<'_> {
    fn drop(&mut self) {
        if let Some(value) = self.value.take() {
            *self.destination = Some(Retirement::Backup { _owner: value });
        }
    }
}
#[cfg(windows)]
struct PersistentRetirement<'a> {
    destination: &'a mut Option<Retirement>,
    value: Option<crate::file_access::MaterialStoreRetirement>,
}
#[cfg(windows)]
impl Drop for PersistentRetirement<'_> {
    fn drop(&mut self) {
        if let Some(value) = self.value.take() {
            *self.destination = Some(Retirement::Material { _owner: value });
        }
    }
}
#[derive(Default)]
pub(super) struct Owner {
    #[cfg(windows)]
    slot: Slot<Retirement>,
}
impl Owner {
    #[cfg(windows)]
    pub(super) fn capture_complete_tree(
        &self,
        request: crate::file_access::MixedRequest,
        cancel: &AtomicBool,
    ) -> Result<MaterialSummary> {
        let full = request.full_security();
        self.slot.run(|slot| {
            let mut retirement = MixedRetirement {
                destination: slot,
                value: None,
            };
            let value = crate::file_access::with_mixed_tree_input(
                request,
                &mut crate::file_access::EaWorkBudget::new(crate::file_access::MATERIAL_WORK_LIMIT),
                cancel,
                &mut retirement.value,
                |mut input| input.complete_digest(),
            )
            .map_err(|e| {
                error(match e {
                    crate::file_access::CarrierFailure::Cancelled => "cancelled",
                    crate::file_access::CarrierFailure::Limit => "materialLimit",
                    crate::file_access::CarrierFailure::Changed => "materialChanged",
                    crate::file_access::CarrierFailure::CleanupUnknown => "cleanupUnknown",
                    _ => "unsupportedMaterial",
                })
            })?;
            Ok(MaterialSummary {
                profile: Some(if full {
                    super::MaterialProfile::WindowsRetainedTreeV1
                } else {
                    super::MaterialProfile::WindowsOrdinaryRetainedTreeV1
                }),
                entries: value.nodes as u64,
                bytes: value.bytes,
                sha256: material_scan::hex(value.sha256),
            })
        })
    }
    pub(super) fn occupied(&self) -> bool {
        #[cfg(windows)]
        {
            self.slot.occupied()
        }
        #[cfg(not(windows))]
        {
            false
        }
    }
    pub(super) fn available(&self) -> Result<()> {
        #[cfg(windows)]
        {
            self.slot.available()
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }
    #[cfg(windows)]
    pub(super) fn capture_archive_pin(
        &self,
        root: crate::file_access::PinnedPath,
        cancel: &AtomicBool,
    ) -> Result<(crate::file_access::PinnedPath, MaterialSummary)> {
        self.slot.run(|retired| {
            let mut partial = PartialRetirement {
                destination: retired,
                value: None,
            };
            material_scan::capture_archive_pin_owned(root, cancel, &mut partial.value)
        })
    }
    #[cfg(windows)]
    pub(super) fn capture_archive(
        &self,
        root: &Path,
        expected: &super::inspect::Stamp,
        cancel: &AtomicBool,
    ) -> Result<MaterialSummary> {
        self.slot.run(|retired| {
            let mut partial = PartialRetirement {
                destination: retired,
                value: None,
            };
            material_scan::capture_archive_owned(root, expected, cancel, &mut partial.value)
        })
    }
    #[cfg(windows)]
    pub(super) fn capture_security_complete_pin(
        &self,
        root: crate::file_access::PinnedPath,
        cancel: &AtomicBool,
    ) -> Result<(crate::file_access::PinnedPath, MaterialSummary)> {
        self.slot.run(|retired| {
            let mut partial = PartialRetirement {
                destination: retired,
                value: None,
            };
            material_scan::capture_security_complete_pin_owned(root, cancel, &mut partial.value)
        })
    }
    #[cfg(windows)]
    pub(super) fn capture_security_complete(
        &self,
        root: &Path,
        expected: &super::inspect::Stamp,
        cancel: &AtomicBool,
    ) -> Result<MaterialSummary> {
        self.slot.run(|retired| {
            let mut partial = PartialRetirement {
                destination: retired,
                value: None,
            };
            material_scan::capture_security_complete_owned(
                root,
                expected,
                cancel,
                &mut partial.value,
            )
        })
    }
    // First real persistent component, kept test-registered until the rpack
    // managed-Git edge and final reconstruction composer can be promoted together.
    // It uses THIS Owner/Slot, never a separate component-local Slot.
    #[cfg(windows)]
    pub(super) fn sealed_material<T, F>(
        &self,
        source: crate::file_access::MixedRequest,
        destination: crate::file_access::MaterialStoreRequest,
        cancel: &AtomicBool,
        consume: F,
    ) -> Result<(T, crate::file_access::MaterialSealReceipt)>
    where
        F: for<'a> FnOnce(
            &mut crate::file_access::OwnedSealedMaterial<'a>,
        ) -> std::result::Result<T, crate::file_access::CarrierFailure>,
    {
        self.slot.run(|slot| {
            let mut retirement = PersistentRetirement {
                destination: slot,
                value: None,
            };
            let result = crate::file_access::with_sealed_material(
                source,
                destination,
                &mut crate::file_access::EaWorkBudget::new(crate::file_access::MATERIAL_WORK_LIMIT),
                cancel,
                &mut retirement.value,
                consume,
            );
            result.map_err(|e| {
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
    #[cfg(windows)]
    pub(super) fn reopen_material<T, F>(
        &self,
        destination: crate::file_access::MaterialStoreRequest,
        expected: &super::WindowsMaterial,
        cancel: &AtomicBool,
        consume: F,
    ) -> Result<(T, crate::file_access::MaterialSealReceipt)>
    where
        F: for<'a> FnOnce(
            &mut crate::file_access::OwnedSealedMaterial<'a>,
        ) -> std::result::Result<T, crate::file_access::CarrierFailure>,
    {
        self.slot.run(|slot| {
            let mut retirement = PersistentRetirement {
                destination: slot,
                value: None,
            };
            crate::file_access::with_reopened_material(
                destination,
                expected,
                &mut crate::file_access::EaWorkBudget::new(crate::file_access::MATERIAL_WORK_LIMIT),
                cancel,
                &mut retirement.value,
                consume,
            )
            .map_err(|e| {
                error(match e {
                    crate::file_access::CarrierFailure::Cancelled => "cancelled",
                    crate::file_access::CarrierFailure::Limit => "materialLimit",
                    crate::file_access::CarrierFailure::Changed => "materialChanged",
                    crate::file_access::CarrierFailure::CleanupUnknown => "cleanupUnknown",
                    _ => "recoveryInvalid",
                })
            })
        })
    }
    #[cfg(any(not(windows), test))]
    pub(super) fn capture(&self, root: &Path, cancel: &AtomicBool) -> Result<MaterialSummary> {
        #[cfg(windows)]
        {
            self.slot.run(|retired| {
                let mut partial = PartialRetirement {
                    destination: retired,
                    value: None,
                };
                material_scan::capture_owned(root, cancel, &mut partial.value)
            })
        }
        #[cfg(not(windows))]
        {
            material_scan::capture(root, cancel)
        }
    }
}

#[cfg(test)]
#[path = "material_owner_tests.rs"]
mod tests;

#[cfg(all(windows, test))]
#[path = "material_carrier_owner_tests.rs"]
mod carrier_tests;

#[cfg(all(windows, test))]
#[path = "material_backup_shape_owner_tests.rs"]
mod shape_tests;

#[cfg(all(windows, test))]
#[path = "material_directory_carrier_owner_tests.rs"]
mod directory_carrier_tests;

#[cfg(all(windows, test))]
#[path = "material_owned_link_owner_tests.rs"]
mod owned_link_tests;

#[cfg(all(windows, test))]
#[path = "material_directory_restore_owner_tests.rs"]
mod directory_restore_tests;

#[cfg(all(windows, test))]
#[path = "material_directory_tree_owner_tests.rs"]
mod directory_tree_tests;

#[cfg(all(windows, test))]
#[path = "material_regular_shared_owner_tests.rs"]
mod regular_shared_tests;

#[cfg(all(windows, test))]
#[path = "material_mixed_tree_owner_tests.rs"]
mod mixed_tree_tests;

#[cfg(all(windows, test))]
#[path = "material_alias_topology_owner_tests.rs"]
mod alias_topology_tests;

#[cfg(all(windows, test))]
#[path = "material_target_link_group_owner_tests.rs"]
mod target_link_group_tests;

#[cfg(windows)]
#[path = "material_owner_remove.rs"]
mod remove;
