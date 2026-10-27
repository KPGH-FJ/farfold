//! Retire only a confirmed, unaliased helper stdout pipe after selected spawn.
//! EOF is independent of the original Child and Job, which remain owned elsewhere.

use windows_sys::Win32::Foundation::{
    CloseHandle, GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAG_PROTECT_FROM_CLOSE,
    INVALID_HANDLE_VALUE, SetHandleInformation,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle,
};
use windows_sys::Win32::System::Pipes::GetNamedPipeInfo;

// This borrows a process-standard handle. It never creates another writer and
// never closes on Drop. A failed spawn restores its original inheritance bit.
pub(crate) struct StdoutHandoff {
    handle: HANDLE,
    restore_inheritance: bool,
}

pub(crate) fn prepare() -> Option<StdoutHandoff> {
    unsafe {
        let output = GetStdHandle(STD_OUTPUT_HANDLE);
        if output.is_null()
            || output == INVALID_HANDLE_VALUE
            || output == GetStdHandle(STD_INPUT_HANDLE)
            || output == GetStdHandle(STD_ERROR_HANDLE)
            || GetFileType(output) != FILE_TYPE_PIPE
        {
            return None;
        }
        // FILE_TYPE_PIPE also includes sockets. An unconfirmed endpoint, or a
        // pipe without the required query rights, keeps its original behavior.
        if GetNamedPipeInfo(
            output,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
        {
            return None;
        }
        let mut flags = 0;
        if GetHandleInformation(output, &mut flags) == 0
            || flags & HANDLE_FLAG_PROTECT_FROM_CLOSE != 0
        {
            return None;
        }
        let restore_inheritance = flags & HANDLE_FLAG_INHERIT != 0;
        // Stdio::inherit duplicates the selected standard reference itself.
        // Do not also let the helper's original writer leak into that process.
        if restore_inheritance && SetHandleInformation(output, HANDLE_FLAG_INHERIT, 0) == 0 {
            return None;
        }
        Some(StdoutHandoff {
            handle: output,
            restore_inheritance,
        })
    }
}

impl StdoutHandoff {
    pub(crate) fn retire_after_spawn(mut self) {
        unsafe {
            if GetStdHandle(STD_OUTPUT_HANDLE) != self.handle
                || GetStdHandle(STD_INPUT_HANDLE) == self.handle
                || GetStdHandle(STD_ERROR_HANDLE) == self.handle
                || SetStdHandle(STD_OUTPUT_HANDLE, std::ptr::null_mut()) == 0
            {
                return;
            }
            if CloseHandle(self.handle) == 0 {
                // Never retry a raw close or abandon the selected Child. Its
                // stderr remains available for the original wait diagnostics.
                let _ = SetStdHandle(STD_OUTPUT_HANDLE, self.handle);
                return;
            }
            self.restore_inheritance = false;
        }
    }
}

impl Drop for StdoutHandoff {
    fn drop(&mut self) {
        if self.restore_inheritance {
            unsafe {
                let _ = SetHandleInformation(self.handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
            }
        }
    }
}
