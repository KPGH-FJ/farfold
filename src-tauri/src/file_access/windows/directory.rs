//! Complete directory scans serialized by the actual held FileObject owner.
//! No pathname/ID reopen, cloned cursor, 64-bit identity fallback or mutation.
use super::*;
use crate::file_access::directory_page::{self, Entries, Failure, PAGE_BYTES};
use std::sync::atomic::AtomicBool;
use windows_sys::{
    Wdk::Storage::FileSystem::{FileIdExtdDirectoryInformation, NtQueryDirectoryFile},
    Win32::Foundation::STATUS_NO_MORE_FILES,
};

fn io_failure(phase: &'static str, e: io::Error) -> Failure {
    Failure::Io {
        phase,
        code: e.raw_os_error(),
        nt_status: None,
    }
}
fn returned(status: i32, used: usize) -> Result<Option<usize>, Failure> {
    if status == STATUS_NO_MORE_FILES {
        return if used == 0 {
            Ok(None)
        } else {
            Err(Failure::InvalidRecord)
        };
    }
    if status != 0 {
        return Err(Failure::Io {
            phase: "query",
            code: Some(unsafe { RtlNtStatusToDosError(status) } as i32),
            nt_status: Some(status),
        });
    }
    if used == 0 || used > PAGE_BYTES {
        return Err(Failure::InvalidRecord);
    }
    Ok(Some(used))
}
pub(crate) fn entries(
    directory: &PinnedPath,
    remaining: u64,
    cancel: &AtomicBool,
) -> Result<Entries, Failure> {
    collect_from(directory, remaining, cancel)
}
// Sealed to this Windows module: each implementation owns the FileObject and
// its original cursor mutex. No standalone File/lock constructor is exposed.
pub(super) trait Owner {
    fn file(&self) -> &File;
    fn verify(&self) -> io::Result<()>;
    fn directory_scan(&self) -> io::Result<std::sync::MutexGuard<'_, ()>>;
}
impl Owner for PinnedPath {
    fn file(&self) -> &File {
        PinnedPath::file(self)
    }
    fn verify(&self) -> io::Result<()> {
        PinnedPath::verify(self)
    }
    fn directory_scan(&self) -> io::Result<std::sync::MutexGuard<'_, ()>> {
        PinnedPath::directory_scan(self)
    }
}
pub(super) fn collect_from<D: Owner>(
    directory: &D,
    remaining: u64,
    cancel: &AtomicBool,
) -> Result<Entries, Failure> {
    collect_charged_from(directory, remaining, cancel, |_| Ok(()))
}
// This material-only entry still uses the original PinnedPath FileObject and
// its full-scan cursor guard. It grants no new path/purpose/skip authority.
#[cfg(test)]
pub(crate) fn entries_with_work(
    directory: &PinnedPath,
    remaining: u64,
    cancel: &AtomicBool,
    work: &mut crate::file_access::EaWorkBudget,
) -> Result<Entries, Failure> {
    collect_charged_from(directory, remaining, cancel, |used| {
        directory_page::charge_query_bytes(used, work)
    })
}
fn collect_charged_from<D: Owner>(
    directory: &D,
    remaining: u64,
    cancel: &AtomicBool,
    mut charge: impl FnMut(usize) -> Result<(), Failure>,
) -> Result<Entries, Failure> {
    directory_page::cancelled(cancel)?;
    // The real owner, not a numeric filesystem ID or global table, serializes
    // every query from the first NULL-pattern restart through EOF/error.
    let _scan = directory
        .directory_scan()
        .map_err(|e| io_failure("scanLock", e))?;
    directory_page::cancelled(cancel)?;
    directory.verify().map_err(|e| io_failure("verify", e))?;
    let file = directory.file();
    let before = stamp(file).map_err(|e| io_failure("before", e))?;
    if before.regular || before.identity.inode == 0 {
        return Err(Failure::Unsupported);
    }
    let mut buffer = vec![0u64; PAGE_BYTES / size_of::<u64>()];
    let mut first = true;
    let result = directory_page::collect(
        before.identity.device,
        remaining.min(directory_page::MAX_ENTRIES as u64) as usize,
        cancel,
        || {
            directory_page::cancelled(cancel)?;
            let mut status = IO_STATUS_BLOCK::default();
            // SAFETY: this held, non-overlapped handle is synchronous. The
            // call completes before this bounded aligned buffer is reused.
            // NULL pattern includes logical entries; no on-disk-only filter.
            let code = unsafe {
                NtQueryDirectoryFile(
                    handle(file),
                    ptr::null_mut(),
                    None,
                    ptr::null(),
                    &mut status,
                    buffer.as_mut_ptr().cast(),
                    PAGE_BYTES as u32,
                    FileIdExtdDirectoryInformation,
                    false,
                    ptr::null(),
                    first,
                )
            };
            first = false;
            let Some(used) = returned(code, status.Information)? else {
                return Ok(None);
            };
            // Charge BEFORE the page copy and parser, preserving status/EOF.
            charge(used)?;
            // SAFETY: only the documented actual completed byte count is read.
            let bytes = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), used) };
            Ok(Some(bytes.to_vec()))
        },
    )?;
    directory_page::cancelled(cancel)?;
    directory
        .verify()
        .map_err(|e| io_failure("verifyAfter", e))?;
    if stamp(file).map_err(|e| io_failure("after", e))? != before {
        return Err(Failure::Changed);
    }
    Ok(result)
}

#[cfg(test)]
#[path = "directory_budget_tests.rs"]
mod material_budget;
#[cfg(test)]
pub(super) use material_budget::collect_budgeted_from;

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::{
        Wdk::Storage::FileSystem::FILE_ID_EXTD_DIR_INFORMATION,
        Win32::Foundation::{
            STATUS_ACCESS_DENIED, STATUS_BUFFER_OVERFLOW, STATUS_INVALID_INFO_CLASS,
        },
    };
    fn ntfs(pin: &PinnedPath) {
        let mut fs = [0u16; 32];
        assert_ne!(
            unsafe {
                GetVolumeInformationByHandleW(
                    handle(pin.file()),
                    ptr::null_mut(),
                    0,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    fs.as_mut_ptr(),
                    fs.len() as u32,
                )
            },
            0
        );
        let end = fs.iter().position(|c| *c == 0).unwrap();
        assert_eq!(
            String::from_utf16(&fs[..end]).unwrap(),
            "NTFS",
            "this control requires an actual owned NTFS temp root"
        );
    }
    #[test]
    fn native_layout_matches_the_portable_wire_parser() {
        assert_eq!(
            offset_of!(FILE_ID_EXTD_DIR_INFORMATION, FileName),
            directory_page::HEADER
        );
        assert_eq!(offset_of!(FILE_ID_EXTD_DIR_INFORMATION, FileNameLength), 60);
        assert_eq!(offset_of!(FILE_ID_EXTD_DIR_INFORMATION, FileId), 72);
        assert_eq!(offset_of!(FILE_ID_EXTD_DIR_INFORMATION, EndOfFile), 40);
        assert_eq!(offset_of!(FILE_ID_EXTD_DIR_INFORMATION, AllocationSize), 48);
        assert_eq!(
            offset_of!(FILE_ID_EXTD_DIR_INFORMATION, ReparsePointTag),
            68
        );
    }
    #[test]
    fn only_exact_empty_eof_is_completion_not_empty_success_or_an_error() {
        assert_eq!(returned(STATUS_NO_MORE_FILES, 0), Ok(None));
        assert_eq!(
            returned(STATUS_NO_MORE_FILES, 1),
            Err(Failure::InvalidRecord)
        );
        assert_eq!(returned(0, 0), Err(Failure::InvalidRecord));
        assert_eq!(returned(0, PAGE_BYTES + 1), Err(Failure::InvalidRecord));
        for code in [
            STATUS_ACCESS_DENIED,
            STATUS_BUFFER_OVERFLOW,
            STATUS_INVALID_INFO_CLASS,
        ] {
            assert!(
                matches!(returned(code, 64), Err(Failure::Io { nt_status: Some(s), .. }) if s == code)
            );
        }
    }
    #[test]
    fn owned_ntfs_multipage_same_owner_scans_restart_and_keep_full_ids_and_raw_names() {
        let temp = tempfile::tempdir().unwrap();
        let mut expected = Vec::new();
        for n in 0..512 {
            let name = format!("Étage-{n:04}-{}-🙂.txt", "x".repeat(112));
            std::fs::write(temp.path().join(&name), b"public-owned-marker").unwrap();
            expected.push(name.encode_utf16().collect::<Vec<_>>());
        }
        expected.sort();
        let pin = PinnedPath::directory(temp.path()).unwrap();
        ntfs(&pin);
        let cancel = AtomicBool::new(false);
        let (a, b) = std::thread::scope(|scope| {
            let first = scope.spawn(|| entries(&pin, 512, &cancel).unwrap());
            let second = scope.spawn(|| entries(&pin, 512, &cancel).unwrap());
            (first.join().unwrap(), second.join().unwrap())
        });
        assert_eq!(a, b);
        assert_eq!(a.keys().cloned().collect::<Vec<_>>(), expected);
        // Same handle is now at EOF. A later call must restart, not appear empty.
        assert_eq!(entries(&pin, 512, &cancel).unwrap(), a);
        // Separately opened PinnedPaths remain separate FileObjects. They do
        // not need a global lock keyed by the same filesystem identity.
        let independent = PinnedPath::directory(temp.path()).unwrap();
        assert_eq!(entries(&independent, 512, &cancel).unwrap(), a);
        for name in ["first", "second"] {
            std::fs::write(temp.path().join(name), b"public-owned-marker").unwrap();
        }
        let c = entries(&pin, 514, &cancel).unwrap();
        let child = PinnedPath::regular(&temp.path().join("first")).unwrap();
        assert_eq!(
            &c[&"first".encode_utf16().collect::<Vec<_>>()].identity,
            child.identity()
        );
        assert_eq!(entries(&pin, 513, &cancel), Err(Failure::Limit));
        let original_id = child.identity().clone();
        drop(child);
        std::fs::hard_link(temp.path().join("first"), temp.path().join("alias")).unwrap();
        let linked = entries(&pin, 515, &cancel).unwrap();
        assert_eq!(
            linked[&"alias".encode_utf16().collect::<Vec<_>>()].identity,
            original_id
        );
        std::fs::rename(temp.path().join("first"), temp.path().join("previous")).unwrap();
        std::fs::write(temp.path().join("first"), b"public-replacement-marker").unwrap();
        let replaced = entries(&pin, 516, &cancel).unwrap();
        assert_ne!(
            replaced[&"first".encode_utf16().collect::<Vec<_>>()].identity,
            original_id
        );
        assert_eq!(
            replaced[&"alias".encode_utf16().collect::<Vec<_>>()].identity,
            original_id
        );
        pin.verify().unwrap();
    }
    #[test]
    fn original_scope_pins_keep_ancestors_and_cancel_before_cursor_open() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("parent");
        let root = parent.join("child");
        std::fs::create_dir_all(&root).unwrap();
        let pin = PinnedPath::directory(&root).unwrap();
        ntfs(&pin);
        assert!(std::fs::rename(&parent, temp.path().join("renamed")).is_err());
        assert_eq!(
            entries(&pin, 0, &AtomicBool::new(true)),
            Err(Failure::Cancelled)
        );
        assert!(
            entries(&pin, 0, &AtomicBool::new(false))
                .unwrap()
                .is_empty()
        );
        let scan = pin.directory_scan().unwrap();
        assert!(std::fs::rename(&parent, temp.path().join("renamed")).is_err());
        drop(scan);
        pin.verify().unwrap();
        drop(pin);
        std::fs::rename(&parent, temp.path().join("renamed")).unwrap();
    }

    #[test]
    fn poisoned_scan_owner_is_failure_and_pre_cancelled_scan_never_queries() {
        let temp = tempfile::tempdir().unwrap();
        let pin = PinnedPath::directory(temp.path()).unwrap();
        ntfs(&pin);
        assert!(std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let _guard = pin.directory_scan().unwrap();
                    panic!("controlled scan-owner poison");
                })
                .join()
                .is_err()
        }));
        assert!(matches!(
            entries(&pin, 0, &AtomicBool::new(false)),
            Err(Failure::Io {
                phase: "scanLock",
                ..
            })
        ));
        // The existing pre-cancel guard runs before acquiring even a poisoned
        // scan owner. This is not a claim of aborting a contended/kernel wait.
        assert_eq!(
            entries(&pin, 0, &AtomicBool::new(true)),
            Err(Failure::Cancelled)
        );
    }
}
