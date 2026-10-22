//! Owned temporary Windows ACL fixture; compiled only in tests.
use std::{
    fs::{File, OpenOptions},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
    ptr,
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        DACL_SECURITY_INFORMATION, GetKernelObjectSecurity, SetKernelObjectSecurity,
    },
    Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, READ_CONTROL, SYNCHRONIZE,
        WRITE_DAC,
    },
};

pub(crate) struct OwnedDacl {
    file: File,
    original: Vec<u64>,
    restored: bool,
}
impl OwnedDacl {
    // Every caller supplies its own freshly created tempfile, never a user file.
    pub(crate) fn new(path: &Path) -> Self {
        Self::open(path, 0)
    }
    pub(crate) fn directory(path: &Path) -> Self {
        Self::open(
            path,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        )
    }
    fn open(path: &Path, flags: u32) -> Self {
        let file = OpenOptions::new()
            .access_mode(READ_CONTROL | WRITE_DAC | SYNCHRONIZE)
            .custom_flags(flags)
            .open(path)
            .unwrap();
        let mut original = vec![0u64; 65536 / 8];
        let mut needed = 0;
        assert_ne!(
            unsafe {
                GetKernelObjectSecurity(
                    file.as_raw_handle(),
                    DACL_SECURITY_INFORMATION,
                    original.as_mut_ptr().cast(),
                    65536,
                    &mut needed,
                )
            },
            0
        );
        assert!((20..=65536).contains(&needed));
        Self {
            file,
            original,
            restored: false,
        }
    }
    pub(crate) fn set(&self, text: &str) {
        let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        assert_ne!(ok, 0);
        let result = unsafe {
            SetKernelObjectSecurity(
                self.file.as_raw_handle(),
                DACL_SECURITY_INFORMATION,
                descriptor,
            )
        };
        unsafe {
            LocalFree(descriptor);
        }
        assert_ne!(result, 0);
    }
    fn restore_once(&mut self) -> bool {
        if self.restored {
            return true;
        }
        self.restored = true;
        unsafe {
            SetKernelObjectSecurity(
                self.file.as_raw_handle(),
                DACL_SECURITY_INFORMATION,
                self.original.as_mut_ptr().cast(),
            ) != 0
        }
    }
    pub(crate) fn restore(mut self) {
        assert!(self.restore_once(), "owned fixture DACL restore");
    }
}
impl Drop for OwnedDacl {
    fn drop(&mut self) {
        // The same WRITE_DAC handle survives ACL changes and restores the exact
        // original owned-file DACL before tempfile removal, including on unwind.
        if !self.restore_once() {
            // An already failing test must not double-panic in cleanup. Normal
            // controls call restore() explicitly and require its success.
            eprintln!("FARFOLD_OWNED_DACL_RESTORE_FAILED");
        }
    }
}
