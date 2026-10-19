//! Synchronous BackupRead/Write ownership seam; no Windows protocol imitation.
use super::{
    ea_records::WorkBudget,
    material_carrier_records::{BLOCK, Error, Resident, Result, charge, check, io_error},
};
use std::{
    ffi::c_void,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    ptr,
    sync::atomic::AtomicBool,
};
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Read,
    Write,
}
pub(super) trait Api {
    fn read(
        &mut self,
        file: &File,
        bytes: &mut [u8],
        context: &mut *mut c_void,
    ) -> std::io::Result<usize>;
    fn write(
        &mut self,
        file: &File,
        bytes: &[u8],
        context: &mut *mut c_void,
    ) -> std::io::Result<usize>;
    fn abort(&mut self, mode: Mode, file: &File, context: &mut *mut c_void) -> std::io::Result<()>;
}
// Only the stopped opaque value is Send. It has NO accessor/destructor/native call.
// Active context stays in Session on the one synchronous calling thread.
// usize deliberately prevents accidental reconstruction as an API argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum OperationOutcome {
    Incomplete,
    Succeeded,
    Failed(Error),
    Unwinding,
}
pub(super) struct RetiredContext {
    _mode: Mode,
    _opaque: usize,
    operation: OperationOutcome,
    abort_error: Option<i32>,
}
impl RetiredContext {
    pub(super) fn operation_error(&self) -> Option<&Error> {
        match &self.operation {
            OperationOutcome::Failed(e) => Some(e),
            _ => None,
        }
    }
}
pub(super) struct Session<'a, A: Api> {
    file: &'a File,
    api: &'a mut A,
    mode: Mode,
    context: *mut c_void,
    attempted: bool,
    finished: bool,
    operation: OperationOutcome,
    retired: &'a mut Option<RetiredContext>,
}
impl<'a, A: Api> Session<'a, A> {
    pub fn new(
        file: &'a File,
        api: &'a mut A,
        mode: Mode,
        retired: &'a mut Option<RetiredContext>,
    ) -> Self {
        Self {
            file,
            api,
            mode,
            context: ptr::null_mut(),
            attempted: false,
            finished: false,
            operation: OperationOutcome::Incomplete,
            retired,
        }
    }
    fn read(&mut self, bytes: &mut [u8]) -> Result<usize> {
        self.attempted = true;
        self.api
            .read(self.file, bytes, &mut self.context)
            .map_err(|e| io_error("backupRead", e))
    }
    fn write(&mut self, bytes: &[u8]) -> Result<usize> {
        self.attempted = true;
        self.api
            .write(self.file, bytes, &mut self.context)
            .map_err(|e| io_error("backupWrite", e))
    }
    fn completed<T>(&mut self, result: &Result<T>) {
        self.operation = match result {
            Ok(_) => OperationOutcome::Succeeded,
            Err(error) => OperationOutcome::Failed(error.clone()),
        };
    }
    pub fn finish(&mut self) -> bool {
        if self.finished {
            return self.retired.is_none();
        }
        self.finished = true;
        if !self.attempted {
            return true;
        }
        // Provisional retention also survives a Rust trait-fake panic. Native
        // APIs are synchronous C calls, not Rust-unwind callbacks.
        *self.retired = Some(RetiredContext {
            _mode: self.mode,
            _opaque: self.context as usize,
            operation: self.operation.clone(),
            abort_error: None,
        });
        match self.api.abort(self.mode, self.file, &mut self.context) {
            Ok(()) => {
                *self.retired = None;
                true
            }
            Err(e) => {
                *self.retired = Some(RetiredContext {
                    _mode: self.mode,
                    _opaque: self.context as usize,
                    operation: self.operation.clone(),
                    abort_error: e.raw_os_error(),
                });
                false
            }
        }
    }
}
impl<A: Api> Drop for Session<'_, A> {
    fn drop(&mut self) {
        if !self.finished && std::thread::panicking() {
            self.operation = OperationOutcome::Unwinding;
        }
        self.finish();
    }
}
pub(super) fn capture<A: Api>(
    session: &mut Session<'_, A>,
    spool: &File,
    budget: &mut WorkBudget,
    cancel: &AtomicBool,
    minimum: usize,
    resident: &Resident,
) -> Result<u64> {
    let _memory = resident.lease(BLOCK)?;
    if minimum == 0 || minimum > BLOCK {
        return Err(Error::Invalid);
    }
    let mut output = spool;
    let mut scratch = vec![0u8; BLOCK];
    let mut total = 0u64;
    let result = (|| loop {
        check(cancel)?;
        let offer = budget.remaining().min(BLOCK as u64) as usize;
        if offer < minimum {
            return Err(Error::Limit);
        }
        let count = session.read(&mut scratch[..offer])?;
        if count > offer {
            return Err(Error::Invalid);
        }
        charge(budget, count)?;
        if count == 0 {
            return Ok(total);
        } // ONLY native TRUE + returned zero.
        // Both the native read and actual carrier output consume shared work.
        charge(budget, count)?;
        output
            .write_all(&scratch[..count])
            .map_err(|e| io_error("carrierWrite", e))?;
        total = total.checked_add(count as u64).ok_or(Error::Limit)?;
    })();
    session.completed(&result);
    if !session.finish() {
        return Err(Error::CleanupUnknown);
    }
    result
}
pub(super) fn restore<A: Api>(
    session: &mut Session<'_, A>,
    spool: &File,
    length: u64,
    budget: &mut WorkBudget,
    cancel: &AtomicBool,
    minimum: usize,
    resident: &Resident,
) -> Result<()> {
    let _memory = resident.lease(BLOCK)?;
    if minimum == 0 || minimum > BLOCK {
        return Err(Error::Invalid);
    }
    let mut input = spool;
    let mut scratch = vec![0u8; BLOCK];
    let mut written = 0u64;
    let result = (|| {
        while written < length {
            check(cancel)?;
            let left = length - written;
            if left < minimum as u64 {
                return Err(Error::Unsupported);
            }
            let mut offered = left.min(BLOCK as u64) as usize;
            if left > BLOCK as u64 && left - (BLOCK as u64) < minimum as u64 {
                offered = (left - minimum as u64) as usize;
            }
            if offered < minimum || budget.remaining() < (offered as u64) * 2 {
                return Err(Error::Limit);
            }
            input
                .seek(SeekFrom::Start(written))
                .map_err(|e| io_error("carrierSeek", e))?;
            // A short native write rereads the exact unconsumed offset. No
            // padding, data omission, zero-progress spin or error retry occurs.
            charge(budget, offered)?;
            input
                .read_exact(&mut scratch[..offered])
                .map_err(|e| io_error("carrierRead", e))?;
            let count = session.write(&scratch[..offered])?;
            if count == 0 || count > offered {
                return Err(Error::Invalid);
            }
            charge(budget, count)?;
            written += count as u64;
        }
        Ok(())
    })();
    session.completed(&result);
    if !session.finish() {
        return Err(Error::CleanupUnknown);
    }
    result
}
#[cfg(test)]
#[path = "material_backup_io_tests.rs"]
mod tests;
