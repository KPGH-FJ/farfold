//! Mandatory old native parsers before BackupWrite and actual recapture after.
use super::super::material_mixed_tree_input::NativeProof;
use super::super::{
    material_carrier_native as regular, material_directory_carrier::Native,
    material_directory_facts as directory, material_restore,
};
use super::super::{material_regular_shared::Io, material_restore::sealed_tree::HeldTarget};
use super::*;
pub(super) struct Input<'a> {
    pub(super) sealed: &'a File,
    pub(super) node: &'a tree::Node,
    pub(super) proof: &'a NativeProof,
}
use crate::file_access::{
    material_backup_io::{self as transfer, Mode, Session},
    material_directory_records::{self as dirs, Profile},
};
use std::io::{Read, Seek, SeekFrom};
#[cfg(test)]
#[path = "material_sealed_restore_failure_tests.rs"]
mod failure_diagnostics;
#[cfg(test)]
#[path = "material_security_last_native_tests.rs"]
mod security_order_tests;
#[path = "material_short_default_restore.rs"]
mod short_default;

// Borrow the physical sealed FileObject through the exact already-verified
// native extent inside FFDIR1/FFNODE1. This is not another file/path capability.
pub(super) struct Range<'a> {
    file: &'a File,
    start: u64,
    length: u64,
    position: u64,
}
impl<'a> Range<'a> {
    pub(super) fn new(file: &'a File, node: &tree::Node) -> Result<Self> {
        let end = node
            .native_start
            .checked_add(node.native_bytes)
            .ok_or(Error::Limit)?;
        if end
            > stamp(file)
                .map_err(|e| io_error("restoreRangeStamp", e))?
                .size
        {
            return Err(Error::Changed);
        }
        let mut input = file;
        if input
            .seek(SeekFrom::Start(node.native_start))
            .map_err(|e| io_error("restoreRangeSeek", e))?
            != node.native_start
        {
            return Err(Error::Changed);
        }
        Ok(Self {
            file,
            start: node.native_start,
            length: node.native_bytes,
            position: 0,
        })
    }
}
impl Read for Range<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let offer = (self.length - self.position).min(out.len() as u64) as usize;
        let mut file = self.file;
        let n = file.read(&mut out[..offer])?;
        if n > offer {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.position = self
            .position
            .checked_add(n as u64)
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
        Ok(n)
    }
}
impl Seek for Range<'_> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let at = match from {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::Current(n) => self.position as i128 + n as i128,
            SeekFrom::End(n) => self.length as i128 + n as i128,
        };
        if at < 0 || at > self.length as i128 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let absolute = self
            .start
            .checked_add(at as u64)
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let mut file = self.file;
        if file.seek(SeekFrom::Start(absolute))? != absolute {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.position = at as u64;
        Ok(self.position)
    }
}
fn semantic(proof: &NativeProof, payload: [u8; 32]) -> [u8; 32] {
    proof
        .ordinary_security
        .as_ref()
        .map_or(payload, |s| s.bind_payload(payload))
}
pub(super) fn needs_write(proof: &NativeProof) -> bool {
    proof.ordinary_security.is_none()
        || proof.ea.count != 0
        || proof
            .expected
            .iter()
            .any(|(name, bytes)| !name.is_empty() || *bytes != 0)
}
fn apply_security(
    sealed: &File,
    target: &File,
    node: &tree::Node,
    proof: &NativeProof,
    io: &mut Io<'_>,
) -> Result<()> {
    let Some(section) = &node.ordinary_security else {
        return Ok(());
    };
    let wanted = proof.ordinary_security.as_ref().ok_or(Error::Changed)?;
    if &section.summary != wanted {
        return Err(Error::Changed);
    }
    let len = usize::try_from(section.summary.bytes).map_err(|_| Error::Limit)?;
    let _memory = io.resident.lease(len)?;
    charge(io.work, len)?;
    check(io.cancel)?;
    let mut raw = vec![0; len];
    let mut source = sealed;
    source
        .seek(SeekFrom::Start(section.start))
        .map_err(|e| io_error("ordinaryRestoreSeek", e))?;
    source
        .read_exact(&mut raw)
        .map_err(|e| io_error("ordinaryRestoreRead", e))?;
    super::super::super::material_ordinary_security::restore(
        target,
        &raw,
        wanted,
        io.work,
        io.cancel,
        io.resident,
    )
}
enum Parsed {
    Regular(records::Parsed),
    Directory(dirs::Parsed),
}
pub(super) fn validate(
    file: &File,
    node: &tree::Node,
    proof: &NativeProof,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<()> {
    Parsed::parse(Range::new(file, node)?, node, proof, work, cancel, resident).map(|_| ())
}
impl Parsed {
    fn security_record(&self) -> Result<std::ops::Range<u64>> {
        match self {
            Self::Regular(value) => value.security_record.clone(),
            Self::Directory(value) => value.security_record.clone(),
        }
        .ok_or(Error::Changed)
    }
    fn parse(
        input: impl Read,
        node: &tree::Node,
        proof: &NativeProof,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<Self> {
        if !proof.matches(node) {
            return Err(Error::Changed);
        }
        let value = match node.kind {
            tree::Kind::Regular => Self::Regular(records::parse_profile(
                input,
                &proof.expected,
                proof.ordinary_security.is_none(),
                work,
                cancel,
                resident,
            )?),
            tree::Kind::Directory => Self::Directory(dirs::parse(
                input,
                &proof.expected,
                if proof.ordinary_security.is_none() {
                    Profile::WithFullSecurity
                } else {
                    Profile::PayloadOnly
                },
                work,
                cancel,
                resident,
            )?),
        };
        match &value {
            Self::Regular(v)
                if semantic(proof, v.semantic_sha256()) == proof.semantic_sha256
                    && v.bytes == node.native_bytes
                    && v.sha256 == node.native_sha256
                    && v.security == proof.security
                    && v.has_ea() == (proof.ea.count != 0) => {}
            Self::Directory(v)
                if semantic(proof, v.semantic_sha256()) == proof.semantic_sha256
                    && v.bytes == node.native_bytes
                    && v.sha256 == node.native_sha256
                    && v.security == proof.security
                    && v.has_ea() == (proof.ea.count != 0)
                    && v.ea.as_ref().is_none_or(|e| e == &proof.ea) => {}
            _ => return Err(Error::Changed),
        }
        Ok(value)
    }
    fn recaptured(
        &self,
        spool: &File,
        proof: &NativeProof,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<()> {
        let mut input = spool;
        input
            .rewind()
            .map_err(|e| io_error("restoreRecaptureParseSeek", e))?;
        match self {
            Self::Regular(source) => {
                let actual = records::parse_profile(
                    input,
                    &proof.expected,
                    proof.ordinary_security.is_none(),
                    work,
                    cancel,
                    resident,
                )?;
                if !source.same_contents(&actual) {
                    return Err(Error::Changed);
                }
            }
            Self::Directory(source) => {
                let actual = dirs::parse(
                    input,
                    &proof.expected,
                    if proof.ordinary_security.is_none() {
                        Profile::WithFullSecurity
                    } else {
                        Profile::PayloadOnly
                    },
                    work,
                    cancel,
                    resident,
                )?;
                if !source.same_contents(&actual) {
                    return Err(Error::Changed);
                }
            }
        }
        Ok(())
    }
}
pub(super) fn facts(
    file: &File,
    node: &tree::Node,
    proof: &NativeProof,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<()> {
    if !proof.matches(node) {
        return Err(Error::Changed);
    }
    if let Some(expected) = &proof.ordinary_security {
        let actual = super::super::super::material_mixed_tree_input::ordinary::Facts::take(
            file, node.kind, work, cancel, resident,
        )?;
        return if actual.expected == proof.expected
            && actual.ea == proof.ea
            && actual.security.summary.same_facets(expected)
        {
            Ok(())
        } else {
            Err(Error::Changed)
        };
    }
    match node.kind {
        tree::Kind::Regular => {
            let actual = regular::facts(file, work, cancel, resident)?;
            if actual.expected != proof.expected
                || actual.ea != proof.ea
                || Some(actual.security) != proof.security
            {
                return Err(Error::Changed);
            }
        }
        tree::Kind::Directory => {
            let actual = directory::take(file, true, work, cancel, resident)?;
            if actual.expected != proof.expected
                || actual.ea != proof.ea
                || actual.security != proof.security
            {
                return Err(Error::Changed);
            }
        }
    }
    Ok(())
}
pub(super) fn restore(
    input: Input<'_>,
    target: HeldTarget<'_>,
    spool: &File,
    io: &mut Io<'_>,
) -> Result<(u32, u32, u32)> {
    let Input {
        sealed,
        node,
        proof,
    } = input;
    let target_identity = stamp(target.file)
        .map_err(|e| io_error("restoreTargetEntry", e))?
        .identity;
    if target.kind != node.kind || &target_identity != target.identity {
        return Err(Error::Changed);
    }
    if io.context.is_some() {
        return Err(Error::CleanupUnknown);
    }
    validate(sealed, node, proof, io.work, io.cancel, io.resident)?;
    apply_security(sealed, target.file, node, proof, io).inspect_err(|_error| {
        #[cfg(test)]
        eprintln!("FARFOLD_ORDINARY_DIAGNOSTIC phase=restore-apply-security error={_error:?}");
    })?;
    let work = &mut *io.work;
    let cancel = io.cancel;
    let resident = io.resident;
    let context = &mut *io.context;
    let target = target.file;
    check(cancel)?;
    if context.is_some() {
        return Err(Error::CleanupUnknown);
    }
    let source = Parsed::parse(
        Range::new(sealed, node)?,
        node,
        proof,
        work,
        cancel,
        resident,
    )?;
    let minimum = size_of::<WIN32_STREAM_ID>() + 1;
    let write = needs_write(proof);
    let full = proof.ordinary_security.is_none();
    let direct = write && node.native_bytes < minimum as u64;
    if direct {
        let Parsed::Regular(parsed) = &source else {
            return Err(Error::Unsupported);
        };
        if full
            || proof.ea.count != 0
            || proof.expected.len() != 1
            || !proof.expected.contains_key(&Vec::new())
        {
            return Err(Error::Unsupported);
        }
        short_default::restore(
            Range::new(sealed, node)?,
            target,
            parsed,
            work,
            cancel,
            resident,
        )?;
    }
    let mut api = Native::new(full);
    if write && !direct {
        let mut session = Session::new(target, &mut api, Mode::Write, context);
        let input = Range::new(sealed, node)?;
        let result = if full {
            let input = transfer::security_last::SecurityLast::new(
                input,
                node.native_bytes,
                source.security_record()?,
            )
            .map_err(|e| io_error("restoreSecurityRecordRange", e))?;
            transfer::restore(
                &mut session,
                input,
                node.native_bytes,
                work,
                cancel,
                minimum,
                resident,
            )
        } else {
            transfer::restore(
                &mut session,
                input,
                node.native_bytes,
                work,
                cancel,
                minimum,
                resident,
            )
        };
        drop(session);
        #[cfg(test)]
        if full
            && matches!(
                &result,
                Err(Error::Io {
                    phase: "backupWrite",
                    ..
                })
            )
        {
            eprintln!(
                "FARFOLD_RESTORE_FAILURE_TRANSFER inputOrder=security-last sourceSecurityRecord={:?} successfulPrefixIsLogical=true",
                source.security_record().ok()
            );
            // Diagnostics observe the failed intermediate target only after
            // the original BackupWrite context cleanup. They never retry it or
            // change the original error, cleanup, or acceptance assertions.
            if context.is_none() && api.aborts() == 1 {
                failure_diagnostics::observe(sealed, node, proof, target, cancel, resident);
            } else {
                eprintln!("FARFOLD_RESTORE_FAILURE_READBACK skipped=cleanup-not-confirmed");
            }
        }
        result?;
    }
    if context.is_some() || api.aborts() != u32::from(write && !direct) {
        return Err(Error::CleanupUnknown);
    }
    material_restore::flushed(target)?;
    facts(target, node, proof, work, cancel, resident)?;
    let mut output = spool;
    output
        .set_len(0)
        .map_err(|e| io_error("restoreRecaptureReset", e))?;
    output
        .rewind()
        .map_err(|e| io_error("restoreRecaptureSeek", e))?;
    let mut read = Native::new(full);
    let mut session = Session::new(target, &mut read, Mode::Read, context);
    let result = transfer::capture(&mut session, spool, work, cancel, minimum, resident);
    drop(session);
    let length = result?;
    if context.is_some() || !read.eof() || read.aborts() != 1 {
        return Err(Error::CleanupUnknown);
    }
    material_restore::flushed(spool)?;
    if spool
        .metadata()
        .map_err(|e| io_error("restoreRecaptureLength", e))?
        .len()
        != length
    {
        return Err(Error::Changed);
    }
    source.recaptured(spool, proof, work, cancel, resident)?;
    facts(target, node, proof, work, cancel, resident)?;
    Ok((api.aborts(), read.aborts(), u32::from(direct)))
}
pub(super) fn finalize(
    target: &File,
    node: &tree::Node,
    proof: &NativeProof,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<()> {
    check(cancel)?;
    let attrs = if node.kind == tree::Kind::Directory {
        let value = node.metadata.attributes & !FILE_ATTRIBUTE_DIRECTORY;
        if value == 0 {
            FILE_ATTRIBUTE_NORMAL
        } else {
            value
        }
    } else {
        node.metadata.attributes
    };
    let basic = FILE_BASIC_INFO {
        CreationTime: node.metadata.created,
        LastAccessTime: node.metadata.accessed,
        LastWriteTime: node.metadata.modified,
        ChangeTime: 0,
        FileAttributes: attrs,
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
        return Err(io_error("sealedTreeFinalize", io::Error::last_os_error()));
    }
    material_restore::flushed(target)?;
    verify_final(target, node, proof, work, cancel, resident)
}
pub(super) fn verify_final(
    target: &File,
    node: &tree::Node,
    proof: &NativeProof,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<()> {
    facts(target, node, proof, work, cancel, resident)?;
    let basic: FILE_BASIC_INFO =
        info(target, FileBasicInfo).map_err(|e| io_error("sealedTreeFinalBasic", e))?;
    if basic.CreationTime != node.metadata.created
        || basic.LastAccessTime != node.metadata.accessed
        || basic.LastWriteTime != node.metadata.modified
        || basic.FileAttributes != node.metadata.attributes
    {
        #[cfg(test)]
        eprintln!(
            "FARFOLD_ORDINARY_DIAGNOSTIC phase=restore-final-basic created_equal={} accessed_equal={} modified_equal={} attributes_equal={}",
            basic.CreationTime == node.metadata.created,
            basic.LastAccessTime == node.metadata.accessed,
            basic.LastWriteTime == node.metadata.modified,
            basic.FileAttributes == node.metadata.attributes,
        );
        return Err(Error::Changed);
    }
    Ok(())
}
