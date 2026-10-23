use super::*;

#[cfg(test)]
pub(in crate::file_access::windows) fn collect_budgeted_from<D: Owner>(
    directory: &D,
    remaining: u64,
    cancel: &AtomicBool,
    resident: &crate::file_access::material_carrier_records::Resident,
) -> Result<crate::file_access::material_directory_budget::MaterialEntries, Failure> {
    collect_charged_from(directory, remaining, cancel, resident, || Ok(()))
}

pub(in crate::file_access::windows) fn collect_budgeted_with_work_from<D: Owner>(
    directory: &D,
    remaining: u64,
    cancel: &AtomicBool,
    resident: &crate::file_access::material_carrier_records::Resident,
    work: &mut crate::file_access::EaWorkBudget,
) -> Result<crate::file_access::material_directory_budget::MaterialEntries, Failure> {
    collect_charged_from(directory, remaining, cancel, resident, || {
        work.charge(PAGE_BYTES).map_err(|_| Failure::Limit)
    })
}

fn collect_charged_from<D: Owner>(
    directory: &D,
    remaining: u64,
    cancel: &AtomicBool,
    resident: &crate::file_access::material_carrier_records::Resident,
    mut before_query: impl FnMut() -> Result<(), Failure>,
) -> Result<crate::file_access::material_directory_budget::MaterialEntries, Failure> {
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
    // No native buffer exists until collect has admitted both page buffers.
    let mut buffer: Option<Vec<u64>> = None;
    let mut first = true;
    let result = crate::file_access::material_directory_budget::collect(
        before.identity.device,
        remaining.min(directory_page::MAX_ENTRIES as u64) as usize,
        cancel,
        resident,
        move || {
            directory_page::cancelled(cancel)?;
            // Admit each actual native request before allocation/dispatch.
            // EOF and failed queries consume their offered page too; no refund
            // or per-child worst-case prepayment based on an unrelated limit.
            before_query()?;
            let buffer = buffer.get_or_insert_with(|| vec![0u64; PAGE_BYTES / size_of::<u64>()]);
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
mod tests {
    use super::*;
    use crate::file_access::{EaWorkBudget, material_carrier_records::Resident};
    use std::{fs, fs::OpenOptions, os::windows::fs::OpenOptionsExt, sync::Mutex};

    #[test]
    fn actual_small_listing_charges_data_and_eof_instead_of_admitted_child_capacity() {
        let temp = crate::test_support::tempdir().unwrap();
        fs::write(temp.path().join("one"), b"owned").unwrap();
        let pin = PinnedPath::directory(temp.path()).unwrap();
        let cancel = AtomicBool::new(false);
        let resident = Resident::new(1024 * 1024);
        let mut work = EaWorkBudget::new((2 * PAGE_BYTES) as u64);
        let entries =
            collect_budgeted_with_work_from(&pin, 4096, &cancel, &resident, &mut work).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(work.remaining(), 0);
        drop(entries);
        assert!(resident.lease(1024 * 1024).is_ok());
    }

    #[test]
    fn exhausted_before_eof_refuses_and_same_actual_cursor_restarts_on_next_operation() {
        let temp = crate::test_support::tempdir().unwrap();
        fs::write(temp.path().join("one"), b"owned").unwrap();
        let pin = PinnedPath::directory(temp.path()).unwrap();
        let cancel = AtomicBool::new(false);
        let resident = Resident::new(1024 * 1024);
        let mut short = EaWorkBudget::new(PAGE_BYTES as u64);
        assert_eq!(
            collect_budgeted_with_work_from(&pin, 4096, &cancel, &resident, &mut short),
            Err(Failure::Limit)
        );
        assert_eq!(short.remaining(), 0);
        assert!(resident.lease(1024 * 1024).is_ok());
        let mut work = EaWorkBudget::new((2 * PAGE_BYTES) as u64);
        assert_eq!(
            collect_budgeted_with_work_from(&pin, 4096, &cancel, &resident, &mut work)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(work.remaining(), 0);
    }

    #[test]
    fn resident_and_cancellation_refuse_before_any_query_work_is_charged() {
        let temp = crate::test_support::tempdir().unwrap();
        let pin = PinnedPath::directory(temp.path()).unwrap();
        let mut work = EaWorkBudget::new(PAGE_BYTES as u64);
        assert_eq!(
            collect_budgeted_with_work_from(
                &pin,
                4096,
                &AtomicBool::new(false),
                &Resident::new(2 * PAGE_BYTES - 1),
                &mut work
            ),
            Err(Failure::Limit)
        );
        assert_eq!(work.remaining(), PAGE_BYTES as u64);
        assert_eq!(
            collect_budgeted_with_work_from(
                &pin,
                4096,
                &AtomicBool::new(true),
                &Resident::new(1024 * 1024),
                &mut work
            ),
            Err(Failure::Cancelled)
        );
        assert_eq!(work.remaining(), PAGE_BYTES as u64);
    }

    struct NoListAccess {
        file: File,
        scan: Mutex<()>,
    }
    impl Owner for NoListAccess {
        fn file(&self) -> &File {
            &self.file
        }
        fn verify(&self) -> io::Result<()> {
            stamp(&self.file).map(|_| ())
        }
        fn directory_scan(&self) -> io::Result<std::sync::MutexGuard<'_, ()>> {
            self.scan
                .lock()
                .map_err(|_| io::Error::other("owned test cursor poisoned"))
        }
    }
    #[test]
    fn actual_failed_native_query_still_consumes_one_prepaid_page() {
        let temp = crate::test_support::tempdir().unwrap();
        let owner = NoListAccess {
            file: OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES | SYNCHRONIZE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(temp.path())
                .unwrap(),
            scan: Mutex::new(()),
        };
        let resident = Resident::new(1024 * 1024);
        let mut work = EaWorkBudget::new(PAGE_BYTES as u64);
        assert!(matches!(
            collect_budgeted_with_work_from(
                &owner,
                4096,
                &AtomicBool::new(false),
                &resident,
                &mut work
            ),
            Err(Failure::Io { phase: "query", .. })
        ));
        assert_eq!(work.remaining(), 0);
        assert!(resident.lease(1024 * 1024).is_ok());
    }

    #[test]
    fn actual_multiple_pages_charge_each_request_and_keep_the_full_raw_namespace() {
        let temp = crate::test_support::tempdir().unwrap();
        let mut expected = Vec::new();
        for n in 0..512 {
            let name = format!("{n:04}-{}", "x".repeat(200));
            fs::write(temp.path().join(&name), b"owned").unwrap();
            expected.push(name.encode_utf16().collect::<Vec<_>>());
        }
        let pin = PinnedPath::directory(temp.path()).unwrap();
        let resident = Resident::new(8 * 1024 * 1024);
        let mut work = EaWorkBudget::new((16 * PAGE_BYTES) as u64);
        let values = collect_budgeted_with_work_from(
            &pin,
            4096,
            &AtomicBool::new(false),
            &resident,
            &mut work,
        )
        .unwrap();
        assert_eq!(values.keys().cloned().collect::<Vec<_>>(), expected);
        let paid = 16 * PAGE_BYTES as u64 - work.remaining();
        assert!(paid > 2 * PAGE_BYTES as u64);
        assert_eq!(paid % PAGE_BYTES as u64, 0);
        drop(values);
        assert!(resident.lease(8 * 1024 * 1024).is_ok());
    }
}
