//! Explicit current-token full-security query. No privilege adjustment/fallback.
use super::*;
use crate::file_access::{
    ea_records::{Failure as RecordFailure, WorkBudget, cancelled},
    full_security_records::{self, Decoded, QUERY_BYTES},
};
use std::sync::{TryLockError, atomic::AtomicBool};
use windows_sys::Win32::{
    Security::{
        BACKUP_SECURITY_INFORMATION, GetKernelObjectSecurity, GetSecurityDescriptorLength,
        IsValidSecurityDescriptor,
    },
    System::SystemServices::ACCESS_SYSTEM_SECURITY,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Failure {
    // 5 is ambiguous: this does not attribute which of the combined requested
    // rights was denied. 1314 is retained as the actual privilege condition.
    AccessCondition {
        phase: &'static str,
        code: i32,
        required_access: u32,
    },
    Record(RecordFailure),
}
impl From<RecordFailure> for Failure {
    fn from(value: RecordFailure) -> Self {
        Self::Record(value)
    }
}
impl Failure {
    pub(super) fn native(phase: &'static str, value: io::Error) -> Self {
        match value.raw_os_error() {
            Some(code @ (5 | 1314)) => Self::AccessCondition {
                phase,
                code,
                required_access: READ_CONTROL | ACCESS_SYSTEM_SECURITY,
            },
            code => Self::Record(RecordFailure::Io { phase, code }),
        }
    }
    pub(crate) fn child_open(value: io::Error) -> Self {
        Self::native("fullSecurityChildOpen", value)
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Observation {
    decoded: Decoded,
    // Private, produced only after a full native request on the qualified pin,
    // returned-span bounds and native validity/length/identity checks succeed.
    requested_information: u32,
}
impl Observation {
    pub(crate) fn requested_information(&self) -> u32 {
        self.requested_information
    }
    pub(crate) fn aces(&self) -> u64 {
        self.decoded.aces
    }
    pub(crate) fn returned_bytes(&self) -> u64 {
        self.decoded.returned_bytes
    }
    pub(crate) fn sha256(&self) -> &[u8; 32] {
        &self.decoded.sha256
    }
}
pub(crate) fn observation(
    pin: &PinnedPath,
    budget: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Observation, Failure> {
    cancelled(cancel)?;
    if !pin.full_security_purpose() {
        return Err(RecordFailure::Unsupported.into());
    }
    let _owner = pin.try_observation_owner().map_err(|e| match e {
        TryLockError::WouldBlock => RecordFailure::Busy,
        TryLockError::Poisoned(_) => RecordFailure::Poisoned,
    })?;
    pin.verify()
        .map_err(|e| Failure::native("fullSecurityVerify", e))?;
    let before = stamp(pin.file()).map_err(|e| Failure::native("fullSecurityBefore", e))?;
    let metadata = metadata_file(pin.file()).map_err(|_| RecordFailure::Unsupported)?;
    if before.identity.inode == 0
        || !matches!(metadata.kind, MetadataKind::File | MetadataKind::Directory)
    {
        return Err(RecordFailure::Unsupported.into());
    }
    let capacity = budget.capacity()?.min(QUERY_BYTES);
    if capacity < 20 {
        return Err(RecordFailure::Limit.into());
    }
    let mut buffer = vec![0u64; capacity.div_ceil(size_of::<u64>())];
    let mut needed = 0u32;
    cancelled(cancel)?;
    // Same strong FileObject used by data/EA/streams; no second pathname open.
    let ok = unsafe {
        GetKernelObjectSecurity(
            handle(pin.file()),
            BACKUP_SECURITY_INFORMATION,
            buffer.as_mut_ptr().cast(),
            capacity as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        let value = io::Error::last_os_error();
        return Err(if value.raw_os_error() == Some(122) {
            RecordFailure::Limit.into()
        } else {
            Failure::native("fullSecurityQuery", value)
        });
    }
    if needed < 20 || needed as usize > capacity {
        return Err(RecordFailure::InvalidRecord.into());
    }
    let raw = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), needed as usize) };
    // Every referenced SID/ACL/known ACE span is bounded before native helpers.
    let decoded = full_security_records::complete(raw, budget, cancel)?;
    if unsafe { IsValidSecurityDescriptor(buffer.as_mut_ptr().cast()) } == 0
        || unsafe { GetSecurityDescriptorLength(buffer.as_mut_ptr().cast()) } != needed
    {
        return Err(RecordFailure::InvalidRecord.into());
    }
    cancelled(cancel)?;
    if stamp(pin.file()).map_err(|e| Failure::native("fullSecurityAfter", e))? != before
        || metadata_file(pin.file()).map_err(|_| RecordFailure::Unsupported)? != metadata
    {
        return Err(RecordFailure::Changed.into());
    }
    pin.verify()
        .map_err(|e| Failure::native("fullSecurityVerifyAfter", e))?;
    // buffer drops here before recursion; both actual queries consume work.
    Ok(Observation {
        decoded,
        requested_information: BACKUP_SECURITY_INFORMATION,
    })
}
#[cfg(test)]
#[path = "security_full_tests.rs"]
mod tests;
