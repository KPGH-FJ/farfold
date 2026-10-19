//! Test-only observation of one owned process object, never a process killer.
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{GetLastError, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    },
};

#[derive(Debug)]
pub(crate) struct WaitObservation {
    pub return_code: u32,
    pub native_error: Option<u32>,
}
impl WaitObservation {
    pub(crate) fn is_running(&self) -> bool {
        self.return_code == WAIT_TIMEOUT && self.native_error.is_none()
    }
    pub(crate) fn is_exited(&self) -> bool {
        self.return_code == WAIT_OBJECT_0 && self.native_error.is_none()
    }
}

// Non-Clone owner: the same process object survives the cancellation check.
// No terminate, inheritance, retry or privilege access. This diagnostic requires
// SYNCHRONIZE plus read-only membership-query authority in one open. No reduced-
// access fallback or second PID lookup is permitted.
pub(crate) struct HeldProcess {
    handle: OwnedHandle,
}
impl HeldProcess {
    pub(crate) fn open(pid: i32) -> io::Result<Self> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid as u32,
            )
        };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenProcess returned a new non-null handle owned here alone.
        Ok(Self {
            handle: unsafe { OwnedHandle::from_raw_handle(handle) },
        })
    }
    pub(crate) fn observe(&self) -> WaitObservation {
        // Zero timeout is an observation, not a new wait/retry budget. The
        // retained owner cannot close this exact handle during the call.
        let return_code = unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 0) };
        let native_error = if return_code == WAIT_FAILED {
            Some(unsafe { GetLastError() })
        } else {
            None
        };
        WaitObservation {
            return_code,
            native_error,
        }
    }
}

impl AsRawHandle for HeldProcess {
    fn as_raw_handle(&self) -> std::os::windows::io::RawHandle {
        self.handle.as_raw_handle()
    }
}
