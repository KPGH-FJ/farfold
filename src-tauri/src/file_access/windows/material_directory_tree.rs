//! Directory-only multi-node actual consumer. One Namespace, one caller Slot.
//! No regular/alias success tags, full TreeFacet, Manifest2 or public mutation.
use super::*;
use super::{
    material_directory_carrier::{Native, pin_error},
    material_directory_facts as facts,
    material_directory_tree_source::{self as source, Sources},
    material_pin::MaterialPin,
    material_restore::{self, Namespace},
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_backup_io::{self as transfer, Mode, RetiredContext, Session},
    material_carrier_records::{
        self as records, Error, Resident, ResidentLease, Result, check, io_error,
    },
    material_directory_records::{self as parser, Profile},
    material_directory_tree_records as tree,
};
use std::{
    io::{Read, Seek, SeekFrom},
    panic::AssertUnwindSafe,
    sync::atomic::AtomicBool,
};
pub(crate) struct DirectoryTreeMemory(Resident);
impl Default for DirectoryTreeMemory {
    fn default() -> Self {
        Self(Resident::new(records::RESIDENT_LIMIT))
    }
}
pub(crate) struct DirectoryTreeRequest {
    root: MaterialPin,
    leaf: Vec<u16>,
    resident: Resident,
    _memory: ResidentLease,
}
impl DirectoryTreeRequest {
    pub(crate) fn held(
        pin: PinnedPath,
        leaf: Vec<u16>,
        memory: &DirectoryTreeMemory,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        let reserved = memory.0.lease(2048)?;
        let root = MaterialPin::root(pin, &memory.0, cancel).map_err(pin_error)?;
        root.directory_carrier_leaf(&leaf).map_err(pin_error)?;
        Ok(Self {
            root,
            leaf,
            resident: memory.0.clone(),
            _memory: reserved,
        })
    }
}
pub(crate) struct DirectoryTreeRetirement {
    _sources: Option<Sources>,
    _namespace: Option<Namespace>,
    _context: Option<RetiredContext>,
    _operation_error: Option<Error>,
    _cleanup_error: Error,
    _resident: Resident,
    _memory: ResidentLease,
    _namespace_memory: Option<ResidentLease>,
}
#[derive(Debug)]
pub(crate) struct DirectoryTreeReceipt {
    pub directories: usize,
    pub tree_bytes: u64,
    pub tree_sha256: [u8; 32],
    pub explicit_full_security: bool,
    pub metadata_order: Vec<u32>,
    pub owned_targets_and_carriers_closed: bool,
    _memory: ResidentLease,
}
struct Range<'a> {
    file: &'a File,
    start: u64,
    length: u64,
    position: u64,
}
impl<'a> Range<'a> {
    fn new(file: &'a File, node: &tree::Node) -> Result<Self> {
        let end = node
            .native_start
            .checked_add(node.native_bytes)
            .ok_or(Error::Limit)?;
        let typed_end = node
            .typed_start
            .checked_add(node.typed_bytes)
            .ok_or(Error::Limit)?;
        if end.checked_add(40) != Some(typed_end)
            || typed_end
                > file
                    .metadata()
                    .map_err(|e| io_error("treePayloadLength", e))?
                    .len()
        {
            return Err(Error::Changed);
        }
        let mut value = Self {
            file,
            start: node.native_start,
            length: node.native_bytes,
            position: 0,
        };
        value
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("treePayloadStart", e))?;
        Ok(value)
    }
}
impl Read for Range<'_> {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        let offer = (self.length - self.position).min(b.len() as u64) as usize;
        let mut file = self.file;
        let n = file.read(&mut b[..offer])?;
        if n > offer {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.position += n as u64;
        Ok(n)
    }
}
impl Seek for Range<'_> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let p = match from {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::Current(n) => self.position as i128 + n as i128,
            SeekFrom::End(n) => self.length as i128 + n as i128,
        };
        if p < 0 || p > self.length as i128 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let absolute = self
            .start
            .checked_add(p as u64)
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let mut file = self.file;
        if file.seek(SeekFrom::Start(absolute))? != absolute {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.position = p as u64;
        Ok(self.position)
    }
}
fn equal(a: &[u16], b: &[u16]) -> Result<bool> {
    let result =
        unsafe { CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1) };
    if result == 0 {
        Err(io_error("treeNameCompare", io::Error::last_os_error()))
    } else {
        Ok(result == CSTR_EQUAL)
    }
}
fn profile(full: bool) -> Profile {
    if full {
        Profile::WithFullSecurity
    } else {
        Profile::PayloadOnly
    }
}
fn same_facets(a: &facts::Facts, b: &facts::Facts) -> bool {
    a.expected == b.expected && a.ea == b.ea && a.security == b.security
}
struct Restoring<'a> {
    index: usize,
    record: &'a tree::Node,
    original: &'a facts::Facts,
    expected: &'a parser::Parsed,
}
fn restore_one(
    ns: &Namespace,
    node: Restoring<'_>,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
    context: &mut Option<RetiredContext>,
) -> Result<()> {
    let Restoring {
        index,
        record,
        original,
        expected,
    } = node;
    let full = record.metadata.security_full;
    let target = ns.tree_directory(index)?;
    let container = ns.tree_carrier.as_ref().ok_or(Error::Invalid)?;
    let minimum = size_of::<WIN32_STREAM_ID>() + 1;
    let identity = stamp(target)
        .map_err(|e| io_error("treeTargetIdentity", e))?
        .identity;
    if identity == original.stamp.identity {
        return Err(Error::Changed);
    }
    ns.tree_directory_empty(index, work, cancel, resident)?;
    let mut native = Native::new(full);
    let mut session = Session::new(target, &mut native, Mode::Write, context);
    transfer::restore(
        &mut session,
        Range::new(container, record)?,
        record.native_bytes,
        work,
        cancel,
        minimum,
        resident,
    )?;
    drop(session);
    if native.aborts() != u32::from(record.native_bytes != 0) {
        return Err(Error::Invalid);
    }
    material_restore::flushed(target)?;
    let before = facts::take(target, full, work, cancel, resident)?;
    if !same_facets(original, &before) {
        return Err(Error::Changed);
    }
    let mut spool = ns.source_carrier.as_ref().ok_or(Error::Invalid)?;
    spool
        .set_len(0)
        .map_err(|e| io_error("treeRecaptureReset", e))?;
    spool
        .seek(SeekFrom::Start(0))
        .map_err(|e| io_error("treeRecaptureSeek", e))?;
    let mut read = Native::new(full);
    let mut session = Session::new(target, &mut read, Mode::Read, context);
    let bytes = transfer::capture(&mut session, spool, work, cancel, minimum, resident)?;
    drop(session);
    if !read.eof() || read.aborts() != 1 {
        return Err(Error::Invalid);
    }
    material_restore::flushed(spool)?;
    spool
        .seek(SeekFrom::Start(0))
        .map_err(|e| io_error("treeRecaptureParse", e))?;
    let actual = parser::parse(
        spool,
        &before.expected,
        profile(full),
        work,
        cancel,
        resident,
    )?;
    if actual.bytes != bytes
        || !expected.same_contents(&actual)
        || !before.unchanged(&facts::take(target, full, work, cancel, resident)?)
    {
        return Err(Error::Changed);
    }
    ns.tree_directory_empty(index, work, cancel, resident)
}
fn finalize(
    target: &File,
    original: &facts::Facts,
    full: bool,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<(EntryMetadata, Stamp)> {
    check(cancel)?;
    let id = stamp(target)
        .map_err(|e| io_error("treeFinalizeId", e))?
        .identity;
    let basic = FILE_BASIC_INFO {
        CreationTime: original.basic.created,
        LastAccessTime: original.basic.accessed,
        LastWriteTime: original.basic.modified,
        ChangeTime: 0,
        FileAttributes: if original.basic.attributes & !FILE_ATTRIBUTE_DIRECTORY == 0 {
            FILE_ATTRIBUTE_NORMAL
        } else {
            original.basic.attributes & !FILE_ATTRIBUTE_DIRECTORY
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
        return Err(io_error("treeFinalize", io::Error::last_os_error()));
    }
    material_restore::flushed(target)?;
    let actual = facts::take(target, full, work, cancel, resident)?;
    if actual.stamp.identity != id
        || actual.basic != original.basic
        || !same_facets(&actual, original)
    {
        return Err(Error::Changed);
    }
    Ok((actual.version, actual.stamp))
}
pub(crate) fn directory_tree_roundtrip(
    request: DirectoryTreeRequest,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retirement: &mut Option<DirectoryTreeRetirement>,
) -> Result<DirectoryTreeReceipt> {
    if retirement.is_some() {
        return Err(Error::CleanupUnknown);
    }
    let DirectoryTreeRequest {
        root,
        leaf,
        resident,
        _memory,
    } = request;
    let mut sources = None;
    let mut namespace = None;
    let mut context = None;
    let mut namespace_memory = None;
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        check(cancel)?;
        if work.remaining() > records::WORK_LIMIT {
            return Err(Error::Limit);
        }
        let full = root.full_security_purpose();
        sources = Some(Sources::collect(root, leaf, work, cancel, &resident)?);
        let nodes = sources.as_mut().ok_or(Error::Invalid)?;
        // All actual source kinds/topology are checked BEFORE a destination exists.
        namespace_memory = Some(resident.lease(4 * records::BLOCK)?);
        namespace = Some(Namespace::reserve()?);
        let ns = namespace.as_mut().ok_or(Error::Invalid)?;
        ns.open_directory_namespace()?;
        ns.prepare_directory_tree(&resident)?;
        let mut output = ns.tree_carrier.as_ref().ok_or(Error::Invalid)?;
        let mut writer = tree::Writer::begin(
            &mut output,
            nodes.nodes.len(),
            full,
            work,
            cancel,
            &resident,
        )?;
        for node in &mut nodes.nodes {
            let (record, stored) =
                source::capture_node(node, ns, work, cancel, &resident, &mut context)?;
            let mut typed = ns.target_carrier.as_ref().ok_or(Error::Invalid)?;
            typed
                .seek(SeekFrom::Start(0))
                .map_err(|e| io_error("treeAppendSeek", e))?;
            writer.append(node.parent, &mut typed, stored, record, work, cancel)?;
        }
        let digest = writer.finish(work, cancel)?;
        material_restore::flushed(output)?;
        nodes.verify(work, cancel, &resident)?;
        output
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("treeVerifySeek", e))?;
        let verified = tree::verify_exact(&mut output, work, cancel, &resident, equal)?;
        if verified.sha256 != digest
            || verified.nodes.len() != nodes.nodes.len()
            || verified.full != full
        {
            return Err(Error::Changed);
        }
        for (index, record) in verified.nodes.iter().enumerate() {
            check(cancel)?;
            let node = &nodes.nodes[index];
            let facts = node.facts.as_ref().ok_or(Error::Invalid)?;
            if record.parent != node.parent
                || record.metadata.raw_leaf != node.leaf
                || record.metadata.source_volume != node.pin.identity().device
                || record.metadata.source_id != node.pin.identity().inode
                || record.native_bytes != node.bytes
                || record.native_sha256 != node.sha256
                || record.metadata.created != facts.basic.created
                || record.metadata.accessed != facts.basic.accessed
                || record.metadata.modified != facts.basic.modified
                || record.metadata.attributes != facts.basic.attributes
            {
                return Err(Error::Changed);
            }
            let minimum = size_of::<WIN32_STREAM_ID>() + 1;
            if record.native_bytes != 0 && record.native_bytes < minimum as u64 {
                return Err(Error::Unsupported);
            }
            let expected = parser::parse(
                Range::new(ns.tree_carrier.as_ref().ok_or(Error::Invalid)?, record)?,
                &facts.expected,
                profile(full),
                work,
                cancel,
                &resident,
            )?;
            if expected.bytes != record.native_bytes
                || expected.sha256 != record.native_sha256
                || expected.security != facts.security
                || expected.ea.as_ref().is_some_and(|v| v != &facts.ea)
                || expected.has_ea() != (facts.ea.count != 0)
            {
                return Err(Error::Changed);
            }
            ns.create_tree_directory(record.parent, &record.metadata.raw_leaf, full)?;
            restore_one(
                ns,
                Restoring {
                    index,
                    record,
                    original: facts,
                    expected: &expected,
                },
                work,
                cancel,
                &resident,
                &mut context,
            )?;
        }
        ns.verify_tree_edges(work, cancel, &resident)?;
        nodes.verify(work, cancel, &resident)?;
        let _final_memory = resident.lease(tree::MAX_NODES * 2048)?;
        let mut finalized = Vec::with_capacity(nodes.nodes.len());
        let mut order = Vec::with_capacity(nodes.nodes.len());
        // Descendants first, each parent after EVERY child payload/creation finished.
        for index in (0..nodes.nodes.len()).rev() {
            let facts = nodes.nodes[index].facts.as_ref().ok_or(Error::Invalid)?;
            finalized.push((
                index,
                finalize(
                    ns.tree_directory(index)?,
                    facts,
                    full,
                    work,
                    cancel,
                    &resident,
                )?,
            ));
            order.push(index as u32);
        }
        // No destination enumeration/data reads after directory metadata finalization.
        // Same held no-share-write/delete parents remain authoritative for the edges.
        nodes.verify(work, cancel, &resident)?;
        for (index, (version, stamp_before)) in finalized {
            let file = ns.tree_directory(index)?;
            let basic: FILE_BASIC_INFO =
                info(file, FileBasicInfo).map_err(|e| io_error("treeFinalBasic", e))?;
            let expected = &nodes.nodes[index]
                .facts
                .as_ref()
                .ok_or(Error::Invalid)?
                .basic;
            if metadata_file(file).map_err(|_| Error::Invalid)? != version
                || stamp(file).map_err(|e| io_error("treeFinalTarget", e))? != stamp_before
                || basic.CreationTime != expected.created
                || basic.LastAccessTime != expected.accessed
                || basic.LastWriteTime != expected.modified
                || basic.FileAttributes != expected.attributes
            {
                return Err(Error::Changed);
            }
        }
        ns.verify()?;
        check(cancel)?;
        Ok((
            nodes.nodes.len(),
            verified.bytes,
            verified.sha256,
            full,
            order,
        ))
    }))
    .unwrap_or(Err(Error::Unsupported));
    let cleanup = if context.is_none() {
        namespace.as_mut().map_or(Ok(()), Namespace::cleanup)
    } else {
        Err(Error::CleanupUnknown)
    };
    if let Err(cleanup_error) = cleanup {
        let operation_error = context
            .as_ref()
            .and_then(RetiredContext::operation_error)
            .cloned()
            .or_else(|| result.err());
        *retirement = Some(DirectoryTreeRetirement {
            _sources: sources,
            _namespace: namespace,
            _context: context,
            _operation_error: operation_error,
            _cleanup_error: cleanup_error,
            _resident: resident,
            _memory,
            _namespace_memory: namespace_memory,
        });
        return Err(Error::CleanupUnknown);
    }
    drop(namespace);
    drop(namespace_memory);
    result.map(
        |(directories, tree_bytes, tree_sha256, explicit_full_security, metadata_order)| {
            DirectoryTreeReceipt {
                directories,
                tree_bytes,
                tree_sha256,
                explicit_full_security,
                metadata_order,
                owned_targets_and_carriers_closed: true,
                _memory,
            }
        },
    )
}
