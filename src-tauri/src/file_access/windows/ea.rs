//! One complete EA observation on the actual synchronous held FileObject.
use super::*;
use crate::file_access::ea_records::{self, Failure, Observation, QUERY_BYTES, WorkBudget};
use std::sync::{TryLockError, atomic::AtomicBool};
use windows_sys::Wdk::Storage::FileSystem::NtQueryEaFile;

fn io_failure(phase: &'static str, value: io::Error) -> Failure {
    Failure::Io {
        phase,
        code: value.raw_os_error(),
    }
}
pub(crate) fn observation(
    pin: &PinnedPath,
    budget: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Observation, Failure> {
    ea_records::cancelled(cancel)?;
    let _owner = pin.try_observation_owner().map_err(|e| match e {
        TryLockError::WouldBlock => Failure::Busy,
        TryLockError::Poisoned(_) => Failure::Poisoned,
    })?;
    ea_records::cancelled(cancel)?;
    pin.verify().map_err(|e| io_failure("verify", e))?;
    let file = pin.file();
    let before = stamp(file).map_err(|e| io_failure("before", e))?;
    let metadata = metadata_file(file).map_err(|_| Failure::Unsupported)?;
    if before.identity.inode == 0
        || !matches!(metadata.kind, MetadataKind::File | MetadataKind::Directory)
    {
        return Err(Failure::Unsupported);
    }
    let capacity = budget.capacity()?;
    let mut buffer = vec![0u64; QUERY_BYTES / size_of::<u64>()];
    let mut ios = IO_STATUS_BLOCK::default();
    ea_records::cancelled(cancel)?;
    // SAFETY: only PinnedPath can supply this handle. Its existing constructors
    // use FILE_SYNCHRONOUS_IO_NONALERT or non-overlapped CreateFileW; all I/O on
    // that FileObject completes before return. No async handle/timeout escape.
    // Same owner mutex also serializes the shared directory/EA cursor.
    let status = unsafe {
        NtQueryEaFile(
            handle(file),
            &mut ios,
            buffer.as_mut_ptr().cast(),
            capacity as u32,
            false,
            ptr::null(),
            0,
            ptr::null(),
            true,
        )
    };
    // On this synchronous contract an unknown/PENDING result is not an empty
    // observation. Non-PENDING returned status, not ios.Status, is authoritative.
    let bytes = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), capacity) };
    let result = ea_records::complete(status, ios.Information, bytes, budget, cancel)?;
    ea_records::cancelled(cancel)?;
    if stamp(file).map_err(|e| io_failure("after", e))? != before
        || metadata_file(file).map_err(|_| Failure::Unsupported)? != metadata
    {
        return Err(Failure::Changed);
    }
    pin.verify().map_err(|e| io_failure("verifyAfter", e))?;
    // All record slices/maps/values are local to complete(), and the aligned
    // buffer dies here. Only count/length/digest leaves, never a parent EA Vec.
    Ok(result)
}

#[cfg(test)]
#[path = "ea_tests.rs"]
mod tests;
