//! Exact-handle disposition, followed by actual close and held-parent absence.
//! No POSIX unlink, pathname deletion, recursive sweep or retry of an unknown close.
use super::*;
use crate::file_access::material_carrier_records::{Error, Result, io_error};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::IntoRawHandle;
use windows_sys::Win32::Foundation::CloseHandle;

pub(crate) struct DeleteStoppedHandle {
    _opaque: usize,
    _close_error: Option<i32>,
}
pub(super) fn close_deleted(
    file: File,
    parent: &File,
    leaf: &[u16],
    stopped: &mut Vec<DeleteStoppedHandle>,
) -> Result<()> {
    let disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_FORCE_IMAGE_SECTION_CHECK
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    if unsafe {
        SetFileInformationByHandle(
            handle(&file),
            FileDispositionInfoEx,
            (&disposition as *const FILE_DISPOSITION_INFO_EX).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } == 0
    {
        return Err(io_error("removeDisposition", io::Error::last_os_error()));
    }
    let raw = file.into_raw_handle();
    if unsafe { CloseHandle(raw) } == 0 {
        let code = io::Error::last_os_error().raw_os_error();
        stopped.push(DeleteStoppedHandle {
            _opaque: raw as usize,
            _close_error: code,
        });
        return Err(Error::CleanupUnknown);
    }
    // A successful disposition/close is not a vanished-name receipt. Another
    // compatible handle or mapping may still keep the object delete-pending.
    match metadata_child(parent, &std::ffi::OsString::from_wide(leaf)) {
        Ok(None) => Ok(()),
        _ => Err(Error::CleanupUnknown),
    }
}

#[cfg(test)]
#[path = "worktree_delete_file_tests.rs"]
mod tests;
