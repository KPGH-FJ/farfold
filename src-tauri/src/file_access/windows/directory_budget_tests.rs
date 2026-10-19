use super::*;

#[cfg(test)]
pub(in crate::file_access::windows) fn collect_budgeted_from<D: Owner>(
    directory: &D,
    remaining: u64,
    cancel: &AtomicBool,
    resident: &crate::file_access::material_carrier_records::Resident,
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
