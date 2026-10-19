//! Verified typed bytes -> one fixed newly owned directory -> actual recapture.
//! No raw path, source writes, child topology, LINK replay, or public restore.
use super::*;
use super::{
    material_directory_carrier::{
        self as capture, Captured, DirectoryConsumer, DirectoryReceipt, DirectoryRequest,
        DirectoryRetirement, Native,
    },
    material_directory_facts as facts,
    material_restore::{self, Namespace},
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_backup_io::{self as transfer, Mode, RetiredContext, Session},
    material_carrier_records::{
        self as records, Error, Resident, ResidentLease, Result, check, io_error,
    },
    material_directory_facet as facet,
    material_directory_records::{self as parser, Profile},
};
use std::{
    io::{Read, Seek, SeekFrom},
    sync::atomic::AtomicBool,
};
#[derive(Debug)]
pub(crate) struct DirectoryRestoreReceipt {
    pub capture: DirectoryReceipt,
    pub target: Identity,
    pub target_recaptured: bool,
    pub metadata_finalized: bool,
    pub write_aborts: u32,
    pub recapture_aborts: u32,
    _memory: ResidentLease,
}
struct Restorer {
    result: Option<(Identity, u32, u32, ResidentLease)>,
}
// Logical range over the SAME exclusive owned typed FileObject. No DATA Vec,
// padding, pathname, shortened success or unrelated file descriptor is used.
struct Payload<'a> {
    file: &'a File,
    start: u64,
    length: u64,
    position: u64,
}
impl<'a> Payload<'a> {
    fn verified(file: &'a File, record: &facet::Verified) -> Result<Self> {
        let start = record.native_offset()?;
        let end = start
            .checked_add(record.native.bytes)
            .and_then(|v| v.checked_add(40))
            .ok_or(Error::Limit)?;
        if file
            .metadata()
            .map_err(|e| io_error("directoryTypedLength", e))?
            .len()
            != end
        {
            return Err(Error::Changed);
        }
        let mut physical = file;
        if physical
            .seek(SeekFrom::Start(start))
            .map_err(|e| io_error("directoryTypedStart", e))?
            != start
        {
            return Err(Error::Changed);
        }
        Ok(Self {
            file,
            start,
            length: record.native.bytes,
            position: 0,
        })
    }
}
impl Read for Payload<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let n = (self.length - self.position).min(out.len() as u64) as usize;
        let mut file = self.file;
        let got = file.read(&mut out[..n])?;
        self.position = self
            .position
            .checked_add(got as u64)
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        Ok(got)
    }
}
impl Seek for Payload<'_> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let offset = match from {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::Current(n) => self.position as i128 + n as i128,
            SeekFrom::End(n) => self.length as i128 + n as i128,
        };
        if offset < 0 || offset > self.length as i128 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let absolute = self
            .start
            .checked_add(offset as u64)
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let mut file = self.file;
        if file.seek(SeekFrom::Start(absolute))? != absolute {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.position = offset as u64;
        Ok(self.position)
    }
}
impl DirectoryConsumer for Restorer {
    fn consume(
        &mut self,
        ns: &mut Namespace,
        source: Captured<'_>,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
        context: &mut Option<RetiredContext>,
    ) -> Result<()> {
        check(cancel)?;
        let full = source.metadata.security_full;
        let verified = {
            let mut typed = ns.target_carrier.as_ref().ok_or(Error::Invalid)?;
            typed
                .seek(SeekFrom::Start(0))
                .map_err(|e| io_error("directoryRestoreVerify", e))?;
            facet::verify_exact(&mut typed, work, cancel, resident)?
        };
        if verified.metadata != *source.metadata
            || verified.native.bytes != source.parsed.bytes
            || verified.native.sha256 != source.parsed.sha256
        {
            return Err(Error::Changed);
        }
        let minimum = size_of::<WIN32_STREAM_ID>() + 1;
        // Explicit current native-write admission. Never pad a legitimate short EA
        // stream to meet API minimum or mistake empty directory for a DATA record.
        if verified.native.bytes != 0 && verified.native.bytes < (minimum as u64) {
            return Err(Error::Unsupported);
        }
        ns.create_directory_target(full)?;
        ns.verify_directory_empty(work, cancel, resident)?;
        let typed = ns.target_carrier.as_ref().ok_or(Error::Invalid)?;
        let target = ns.directory_target()?;
        let target_id = stamp(target)
            .map_err(|e| io_error("restoredDirectoryStamp", e))?
            .identity;
        if target_id == source.facts.stamp.identity {
            return Err(Error::Changed);
        }
        let payload = Payload::verified(typed, &verified)?;
        let mut write = Native::new(full);
        let mut session = Session::new(target, &mut write, Mode::Write, context);
        transfer::restore(
            &mut session,
            payload,
            verified.native.bytes,
            work,
            cancel,
            minimum,
            resident,
        )?;
        drop(session);
        if write.aborts() != u32::from(verified.native.bytes != 0) {
            return Err(Error::Invalid);
        }
        material_restore::flushed(target)?;
        let target_before = facts::take(target, full, work, cancel, resident)?;
        if target_before.expected != source.facts.expected
            || target_before.ea != source.facts.ea
            || target_before.security != source.facts.security
        {
            return Err(Error::Changed);
        }
        // Reuse only the original owned raw spool, after its source data is fully
        // verified and stored in the independent typed file. No source is truncated.
        let mut spool = ns.source_carrier.as_ref().ok_or(Error::Invalid)?;
        spool
            .set_len(0)
            .map_err(|e| io_error("directoryRecaptureTruncate", e))?;
        spool
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("directoryRecaptureSeek", e))?;
        let mut read = Native::new(full);
        let mut session = Session::new(target, &mut read, Mode::Read, context);
        let length = transfer::capture(&mut session, spool, work, cancel, minimum, resident)?;
        drop(session);
        if !read.eof() || read.aborts() != 1 {
            return Err(Error::Invalid);
        }
        material_restore::flushed(spool)?;
        spool
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("directoryRecaptureParse", e))?;
        let parsed = parser::parse(
            spool,
            &target_before.expected,
            if full {
                Profile::WithFullSecurity
            } else {
                Profile::PayloadOnly
            },
            work,
            cancel,
            resident,
        )?;
        if parsed.bytes != length
            || !source.parsed.same_contents(&parsed)
            || !target_before.unchanged(&facts::take(target, full, work, cancel, resident)?)
        {
            return Err(Error::Changed);
        }
        ns.verify_directory_empty(work, cancel, resident)?;
        check(cancel)?;
        // LAST in this childless target: write/abort/recapture/empty checks all ended.
        // DIRECTORY is object kind, not a settable attribute; actual kind stays checked.
        let basic = FILE_BASIC_INFO {
            CreationTime: source.metadata.created,
            LastAccessTime: source.metadata.accessed,
            LastWriteTime: source.metadata.modified,
            ChangeTime: 0,
            FileAttributes: if source.metadata.attributes & !FILE_ATTRIBUTE_DIRECTORY == 0 {
                FILE_ATTRIBUTE_NORMAL
            } else {
                source.metadata.attributes & !FILE_ATTRIBUTE_DIRECTORY
            },
        };
        if unsafe {
            SetFileInformationByHandle(
                handle(target),
                FileBasicInfo,
                (&basic as *const FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io_error("directoryFinalize", io::Error::last_os_error()));
        }
        material_restore::flushed(target)?;
        let final_facts = facts::take(target, full, work, cancel, resident)?;
        if final_facts.expected != source.facts.expected
            || final_facts.ea != source.facts.ea
            || final_facts.security != source.facts.security
            || final_facts.stamp.identity != target_id
            || final_facts.basic.created != source.metadata.created
            || final_facts.basic.accessed != source.metadata.accessed
            || final_facts.basic.modified != source.metadata.modified
            || final_facts.basic.attributes != source.metadata.attributes
        {
            return Err(Error::Changed);
        }
        ns.verify()?;
        check(cancel)?;
        self.result = Some((
            target_id,
            write.aborts(),
            read.aborts(),
            resident.lease(1024)?,
        ));
        Ok(())
    }
}
pub(crate) fn directory_roundtrip(
    request: DirectoryRequest,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retirement: &mut Option<DirectoryRetirement>,
) -> Result<DirectoryRestoreReceipt> {
    let mut consumer = Restorer { result: None };
    let captured =
        capture::capture_with_consumer(request, work, cancel, retirement, Some(&mut consumer))?;
    let (target, write_aborts, recapture_aborts, memory) =
        consumer.result.take().ok_or(Error::Invalid)?;
    Ok(DirectoryRestoreReceipt {
        capture: captured,
        target,
        target_recaptured: true,
        metadata_finalized: true,
        write_aborts,
        recapture_aborts,
        _memory: memory,
    })
}
#[cfg(test)]
#[path = "material_directory_restore_transfer_tests.rs"]
mod tests;
