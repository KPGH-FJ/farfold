//! Same-held-base partial stream observation. Never reopens an ADS pathname.
use super::*;
use crate::file_access::{
    ads_records::{Failure, Inventory, Observation, Streams},
    ea_records::{QUERY_BYTES, WorkBudget},
};
use std::{cmp::Ordering as Cmp, ffi::c_void, panic::AssertUnwindSafe, sync::atomic::AtomicBool};
use windows_sys::{
    Wdk::Storage::FileSystem::{
        FILE_STREAM_INFORMATION, FileStreamInformation, NtQueryInformationFile,
    },
    Win32::Globalization::{CSTR_GREATER_THAN, CSTR_LESS_THAN},
};

// Sealed only after the last synchronous abort returned FALSE. No method,
// destructor or later thread may call an API with or dereference this value.
// Keeping the actual returned value is not a claim that Windows freed it.
struct RetiredContext {
    _pointer: *mut c_void,
}
// SAFETY: this type is constructed only after all synchronous calls on the
// active context returned. It is exclusively moved into one runtime slot,
// never accessed by native code again, never dereferenced and never dropped
// through an API. Moving the pointer value does not move its native allocation.
// Active contexts remain raw locals on their original thread, outside this type.
unsafe impl Send for RetiredContext {}

pub(crate) struct RetiredBackup {
    _pin: PinnedPath,
    _context: RetiredContext,
    _abort_error: Option<i32>,
}
trait Api {
    fn read(
        &mut self,
        file: &File,
        bytes: &mut [u8],
        context: &mut *mut c_void,
    ) -> io::Result<usize>;
    fn abort(&mut self, file: &File, context: &mut *mut c_void) -> io::Result<()>;
}
struct Native;
impl Api for Native {
    fn read(
        &mut self,
        file: &File,
        bytes: &mut [u8],
        context: &mut *mut c_void,
    ) -> io::Result<usize> {
        let mut returned = 0;
        // SAFETY: only the synchronous/non-overlapped PinnedPath handle is
        // accepted. bytes is bounded, writable and outlives the complete call.
        let ok = unsafe {
            BackupRead(
                handle(file),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                &mut returned,
                0,
                0,
                context,
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(returned as usize)
        }
    }
    fn abort(&mut self, file: &File, context: &mut *mut c_void) -> io::Result<()> {
        // bAbort TRUE ignores the other parameters. Keep this exact context and
        // the exact held handle; no NULL-root/path reopen/BackupSeek substitute.
        let ok = unsafe {
            BackupRead(
                handle(file),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                1,
                0,
                context,
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}
struct Session<'a, A: Api> {
    file: &'a File,
    api: A,
    context: *mut c_void,
    dispatched: bool,
    finished: bool,
    retired: &'a mut Option<(RetiredContext, Option<i32>)>,
}
impl<A: Api> Session<'_, A> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.dispatched = true;
        self.api.read(self.file, bytes, &mut self.context)
    }
    fn finish(&mut self) -> bool {
        if self.finished {
            return self.retired.is_none();
        }
        // Set before entering the API so Drop can never retry an uncertain abort.
        self.finished = true;
        if !self.dispatched {
            return true;
        }
        if let Err(error) = self.api.abort(self.file, &mut self.context) {
            *self.retired = Some((
                RetiredContext {
                    _pointer: self.context,
                },
                error.raw_os_error(),
            ));
            false
        } else {
            true
        }
    }
}
impl<A: Api> Drop for Session<'_, A> {
    fn drop(&mut self) {
        self.finish();
    }
}
fn io_failure(phase: &'static str, error: io::Error) -> Failure {
    Failure::Io {
        phase,
        code: error.raw_os_error(),
    }
}
fn cancelled(cancel: &AtomicBool) -> Result<(), Failure> {
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        Err(Failure::Cancelled)
    } else {
        Ok(())
    }
}
fn compare(left: &[u16], right: &[u16]) -> Result<Cmp, Failure> {
    if left.is_empty() || right.is_empty() {
        return Ok(left.len().cmp(&right.len()));
    }
    let result = unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            1,
        )
    };
    match result {
        CSTR_LESS_THAN => Ok(Cmp::Less),
        CSTR_EQUAL => Ok(Cmp::Equal),
        CSTR_GREATER_THAN => Ok(Cmp::Greater),
        _ => Err(Failure::Compare),
    }
}
fn inventory(
    pin: &PinnedPath,
    directory: bool,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Inventory, Failure> {
    cancelled(cancel)?;
    let capacity = work.capacity().map_err(|_| Failure::Limit)?;
    if capacity < size_of::<FILE_STREAM_INFORMATION>() {
        return Err(Failure::Limit);
    }
    let mut bytes = vec![0u64; QUERY_BYTES / size_of::<u64>()];
    let mut ios = IO_STATUS_BLOCK::default();
    // Same synchronous handle: no PENDING buffer/worker ownership escapes.
    let status = unsafe {
        NtQueryInformationFile(
            handle(pin.file()),
            &mut ios,
            bytes.as_mut_ptr().cast(),
            capacity as u32,
            FileStreamInformation,
        )
    };
    let allocated = unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<u8>(), capacity) };
    if directory && status == 0 && ios.Information == 0 {
        // This is only an empty-directory candidate. Success still requires a
        // real BackupRead EOF, matching empty recheck, kind/stamp/full128 below.
        Inventory::empty_directory(status, ios.Information, allocated, work, cancel)
    } else {
        let value = Inventory::decode(status, ios.Information, allocated, work, cancel, compare)?;
        if directory {
            value.for_directory()
        } else {
            Ok(value)
        }
    }
}
fn data<A: Api>(
    pin: &PinnedPath,
    expected: &Inventory,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retired: &mut Option<(RetiredContext, Option<i32>)>,
    api: A,
) -> Result<Observation, Failure> {
    let mut reader = Streams::new(expected, work, cancel, size_of::<WIN32_STREAM_ID>() + 1)?;
    let mut session = Session {
        file: pin.file(),
        api,
        context: ptr::null_mut(),
        dispatched: false,
        finished: false,
        retired,
    };
    let mut bytes = [0u8; QUERY_BYTES];
    let result = (|| {
        loop {
            cancelled(cancel)?;
            let offered = reader.offer()?;
            let count = session
                .read(&mut bytes[..offered])
                .map_err(|e| io_failure("read", e))?;
            if count > offered {
                return Err(Failure::InvalidRecord);
            }
            if let Some(observation) = reader.push(&bytes[..count])? {
                return Ok(observation);
            }
        }
    })();
    // This explicit fallible finish happens on success/read/parser/cancel/limit.
    // On unwind the same Session Drop attempts once and reports to its outer sink.
    if !session.finish() {
        return Err(Failure::Unsupported);
    }
    result
}
pub(crate) fn observation(
    pin: PinnedPath,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retired: &mut Option<RetiredBackup>,
) -> Result<(PinnedPath, Observation), Failure> {
    observation_with(pin, work, cancel, retired, Native)
}
fn observation_with<A: Api>(
    pin: PinnedPath,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retired: &mut Option<RetiredBackup>,
    api: A,
) -> Result<(PinnedPath, Observation), Failure> {
    if retired.is_some() {
        return Err(Failure::Unsupported);
    }
    cancelled(cancel)?;
    let query_owner = pin
        .try_observation_owner()
        .map_err(|_| Failure::Unsupported)?;
    let mut failed_context = None;
    // Keep pin/lock/sink outside the unwind boundary: Drop cannot discard a
    // failed abort and the original leaf is moved only after its borrow ends.
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        pin.verify().map_err(|e| io_failure("verify", e))?;
        let before = stamp(pin.file()).map_err(|e| io_failure("before", e))?;
        let metadata = metadata_file(pin.file()).map_err(|_| Failure::Unsupported)?;
        let directory = metadata.kind == MetadataKind::Directory;
        if !directory && metadata.kind != MetadataKind::File {
            return Err(Failure::Unsupported);
        }
        if metadata.attributes() & (0x400 | 0x1000 | 0x4000 | 0x40000 | 0x400000) != 0 {
            return Err(Failure::Unsupported);
        }
        let first = inventory(&pin, directory, work, cancel)?;
        if directory == first.has_default() {
            return Err(Failure::Unsupported);
        }
        if !directory && first.default_size() != Some(before.size) {
            return Err(Failure::Changed);
        }
        let value = data(&pin, &first, work, cancel, &mut failed_context, api)?;
        let after = inventory(&pin, directory, work, cancel)?;
        if first != after
            || stamp(pin.file()).map_err(|e| io_failure("after", e))? != before
            || metadata_file(pin.file()).map_err(|_| Failure::Unsupported)? != metadata
        {
            return Err(Failure::Changed);
        }
        pin.verify().map_err(|e| io_failure("verifyAfter", e))?;
        cancelled(cancel)?;
        Ok(value)
    }))
    .unwrap_or(Err(Failure::Unsupported));
    drop(query_owner);
    if let Some((context, error)) = failed_context {
        *retired = Some(RetiredBackup {
            _pin: pin,
            _context: context,
            _abort_error: error,
        });
        return Err(Failure::Unsupported);
    }
    result.map(|value| (pin, value))
}

#[cfg(test)]
#[path = "streams_tests.rs"]
mod tests;
