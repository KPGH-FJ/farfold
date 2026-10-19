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
        // Contenders fail, not wait. Windows mutation stays closed; its existing
        // locked finish-recycle verification must move before opening that gate.
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
#[derive(Default)]
pub(super) struct Owner {
    #[cfg(windows)]
    slot: Slot<crate::file_access::RetiredBackup>,
}
impl Owner {
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
    pub(super) fn capture_security_complete(
        &self,
        root: &Path,
        expected: &super::inspect::Stamp,
        cancel: &AtomicBool,
    ) -> Result<MaterialSummary> {
        self.slot.run(|retired| {
            material_scan::capture_security_complete_owned(root, expected, cancel, retired)
        })
    }
    #[cfg(any(not(windows), test))]
    pub(super) fn capture(&self, root: &Path, cancel: &AtomicBool) -> Result<MaterialSummary> {
        #[cfg(windows)]
        {
            self.slot
                .run(|retired| material_scan::capture_owned(root, cancel, retired))
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
#[path = "material_owned_link_owner_tests.rs"]
mod owned_link_tests;
