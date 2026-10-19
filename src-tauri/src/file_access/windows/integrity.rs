//! Same held FileObject, stored mandatory-label query only. Not full SACL.
use super::*;
use crate::file_access::{
    ea_records::{Failure, WorkBudget, cancelled},
    integrity_records::{self, Observation, QUERY_BYTES},
};
use std::sync::{TryLockError, atomic::AtomicBool};
use windows_sys::Win32::Security::{
    GetKernelObjectSecurity, GetSecurityDescriptorLength, IsValidSecurityDescriptor,
    LABEL_SECURITY_INFORMATION,
};

fn failed(phase: &'static str, value: io::Error) -> Failure {
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
    cancelled(cancel)?;
    let _owner = pin.try_observation_owner().map_err(|e| match e {
        TryLockError::WouldBlock => Failure::Busy,
        TryLockError::Poisoned(_) => Failure::Poisoned,
    })?;
    pin.verify().map_err(|e| failed("labelVerify", e))?;
    let before = stamp(pin.file()).map_err(|e| failed("labelBefore", e))?;
    let metadata = metadata_file(pin.file()).map_err(|_| Failure::Unsupported)?;
    if before.identity.inode == 0
        || !matches!(metadata.kind, MetadataKind::File | MetadataKind::Directory)
    {
        return Err(Failure::Unsupported);
    }
    let result = query(pin.file(), budget, cancel)?;
    cancelled(cancel)?;
    if stamp(pin.file()).map_err(|e| failed("labelAfter", e))? != before
        || metadata_file(pin.file()).map_err(|_| Failure::Unsupported)? != metadata
    {
        return Err(Failure::Changed);
    }
    pin.verify().map_err(|e| failed("labelVerifyAfter", e))?;
    // Raw security bytes are retired before traversal/recursion. Only this
    // bounded label digest leaves; audit/full SACL and restore remain unknown.
    Ok(result)
}

fn query(
    file: &File,
    budget: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Observation, Failure> {
    let capacity = budget.capacity()?.min(QUERY_BYTES);
    if capacity < 20 {
        return Err(Failure::Limit);
    }
    // The caller supplies one finite aligned buffer. No size query/retry or OS
    // allocated descriptor can grow beyond the remaining completed-work offer.
    let mut buffer = vec![0u64; capacity.div_ceil(size_of::<u64>())];
    let mut needed = 0u32;
    cancelled(cancel)?;
    // PinnedPath constructors already request FILE_GENERIC_READ/READ_CONTROL.
    // LABEL read requires READ_CONTROL, not ACCESS_SYSTEM_SECURITY.
    // No rights, shares, token privilege or path-based reopen is added here.
    let ok = unsafe {
        GetKernelObjectSecurity(
            handle(file),
            LABEL_SECURITY_INFORMATION,
            buffer.as_mut_ptr().cast(),
            capacity as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        let failure = io::Error::last_os_error();
        return Err(if failure.raw_os_error() == Some(122) {
            Failure::Limit
        } else {
            failed("labelQuery", failure)
        });
    }
    if needed < 20 || needed as usize > capacity {
        return Err(Failure::InvalidRecord);
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), needed as usize) };
    // Bound all self-relative fields before the native validity/length helpers.
    // This descriptor came from a successful synchronous kernel-object query;
    // no arbitrary foreign pointer or external descriptor is accepted.
    let result = integrity_records::complete(bytes, budget, cancel)?;
    if unsafe { IsValidSecurityDescriptor(buffer.as_mut_ptr().cast()) } == 0
        || unsafe { GetSecurityDescriptorLength(buffer.as_mut_ptr().cast()) } != needed
    {
        return Err(Failure::InvalidRecord);
    }
    Ok(result)
}

#[cfg(test)]
#[path = "integrity_tests.rs"]
mod tests;
