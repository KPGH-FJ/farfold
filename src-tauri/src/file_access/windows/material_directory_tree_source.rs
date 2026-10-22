//! Same held source tree, directory-only. Complete names; never skips a file.
#[cfg(test)]
use super::material_directory_carrier::pin_error;
use super::*;
use super::{
    directory::Owner,
    material_directory_carrier::Native,
    material_directory_facts as facts,
    material_pin::MaterialPin,
    material_restore::{self, Namespace},
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_backup_io::{self as transfer, Mode, RetiredContext, Session},
    material_carrier_records::{Error, Resident, Result, check, io_error},
    material_directory_facet as facet,
    material_directory_records::{self as parser, Profile},
};
#[cfg(test)]
use crate::file_access::{
    material_carrier_records::ResidentLease, material_directory_tree_records as tree,
};
use std::{
    io::{Seek, SeekFrom},
    sync::atomic::AtomicBool,
};
pub(super) struct Node {
    #[cfg(test)]
    pub parent: u32,
    pub leaf: Vec<u16>,
    pub pin: MaterialPin,
    pub facts: Option<facts::Facts>,
    pub bytes: u64,
    pub sha256: [u8; 32],
    pub semantic_sha256: [u8; 32],
}
#[cfg(test)]
pub(super) struct Sources {
    pub nodes: Vec<Node>,
    _memory: ResidentLease,
}
pub(super) fn listing(
    pin: &MaterialPin,
    remaining: usize,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<crate::file_access::material_directory_budget::MaterialEntries> {
    pin.entries_with_work(remaining as u64, cancel, work)
        .map_err(directory_error)
}
pub(super) fn directory_error(e: crate::file_access::DirectoryFailure) -> Error {
    use crate::file_access::DirectoryFailure as E;
    match e {
        E::Cancelled => Error::Cancelled,
        E::Limit => Error::Limit,
        E::Changed => Error::Changed,
        E::Io {
            phase,
            nt_status: Some(status),
            ..
        } => Error::NtStatus { phase, status },
        E::Io { phase, code, .. } => Error::Io { phase, code },
        _ => Error::Unsupported,
    }
}
#[cfg(test)]
impl Sources {
    pub fn collect(
        root: MaterialPin,
        leaf: Vec<u16>,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<Self> {
        let memory = resident.lease(tree::MAX_NODES * 4096)?;
        root.directory_carrier_leaf(&leaf).map_err(pin_error)?;
        let mut nodes = Vec::with_capacity(tree::MAX_NODES);
        nodes.push(Node {
            parent: tree::ROOT,
            leaf,
            pin: root,
            facts: None,
            bytes: 0,
            sha256: [0; 32],
            semantic_sha256: [0; 32],
        });
        let mut at = 0;
        while at < nodes.len() {
            check(cancel)?;
            let values = listing(&nodes[at].pin, tree::MAX_NODES - nodes.len(), work, cancel)?;
            for (raw, observed) in values.as_entries() {
                if observed.attributes & FILE_ATTRIBUTE_DIRECTORY == 0
                    || observed.reparse_tag.is_some()
                {
                    return Err(Error::Unsupported);
                }
                let child = nodes[at]
                    .pin
                    .child(raw, observed, cancel)
                    .map_err(pin_error)?;
                if child.opening_metadata().kind != MetadataKind::Directory
                    || nodes.iter().any(|n| n.pin.identity() == child.identity())
                {
                    return Err(Error::Changed);
                }
                nodes.push(Node {
                    parent: at as u32,
                    leaf: raw.clone(),
                    pin: child,
                    facts: None,
                    bytes: 0,
                    sha256: [0; 32],
                    semantic_sha256: [0; 32],
                });
            }
            at += 1;
        }
        Ok(Self {
            nodes,
            _memory: memory,
        })
    }
    pub fn verify(
        &self,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<()> {
        for (index, node) in self.nodes.iter().enumerate() {
            check(cancel)?;
            node.pin
                .verify()
                .map_err(|e| io_error("treeSourceFinal", e))?;
            let expected = node.facts.as_ref().ok_or(Error::Invalid)?;
            if !expected.unchanged(&facts::take(
                Owner::file(&node.pin),
                node.pin.full_security_purpose(),
                work,
                cancel,
                resident,
            )?) {
                return Err(Error::Changed);
            }
            let values = listing(&node.pin, tree::MAX_NODES, work, cancel)?;
            let count = self
                .nodes
                .iter()
                .filter(|n| n.parent == index as u32)
                .count();
            if values.as_entries().len() != count {
                return Err(Error::Changed);
            }
            for child in self.nodes.iter().filter(|n| n.parent == index as u32) {
                let actual = values.as_entries().get(&child.leaf).ok_or(Error::Changed)?;
                if &actual.identity != child.pin.identity()
                    || actual.attributes & FILE_ATTRIBUTE_DIRECTORY == 0
                    || actual.reparse_tag.is_some()
                {
                    return Err(Error::Changed);
                }
            }
        }
        Ok(())
    }
}
pub(super) fn capture_node(
    node: &mut Node,
    ns: &Namespace,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
    context: &mut Option<RetiredContext>,
) -> Result<([u8; 32], u64)> {
    check(cancel)?;
    if context.is_some() {
        return Err(Error::CleanupUnknown);
    }
    let _query = node
        .pin
        .try_observation_owner()
        .map_err(|_| Error::Unsupported)?;
    node.pin
        .verify()
        .map_err(|e| io_error("treeSourceNode", e))?;
    let file = Owner::file(&node.pin);
    let full = node.pin.full_security_purpose();
    let before = facts::take(file, full, work, cancel, resident)?;
    if &before.version != node.pin.opening_metadata() {
        return Err(Error::Changed);
    }
    let mut spool = ns.source_carrier.as_ref().ok_or(Error::Invalid)?;
    spool.set_len(0).map_err(|e| io_error("treeRawReset", e))?;
    spool
        .seek(SeekFrom::Start(0))
        .map_err(|e| io_error("treeRawSeek", e))?;
    let mut native = Native::new(full);
    let mut session = Session::new(file, &mut native, Mode::Read, context);
    let length = transfer::capture(
        &mut session,
        spool,
        work,
        cancel,
        size_of::<WIN32_STREAM_ID>() + 1,
        resident,
    )?;
    drop(session);
    if !native.eof() || native.aborts() != 1 {
        return Err(Error::Invalid);
    }
    material_restore::flushed(spool)?;
    spool
        .seek(SeekFrom::Start(0))
        .map_err(|e| io_error("treeParseSeek", e))?;
    let parsed = parser::parse(
        spool,
        &before.expected,
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
        || parsed.security != before.security
        || parsed.ea.as_ref().is_some_and(|v| v != &before.ea)
        || parsed.has_ea() != (before.ea.count != 0)
        || !before.unchanged(&facts::take(file, full, work, cancel, resident)?)
    {
        return Err(Error::Changed);
    }
    node.semantic_sha256 = parsed.semantic_sha256();
    let meta = facet::Metadata {
        security_full: full,
        raw_leaf: node.leaf.clone(),
        source_volume: before.stamp.identity.device,
        source_id: before.stamp.identity.inode,
        created: before.basic.created,
        accessed: before.basic.accessed,
        modified: before.basic.modified,
        attributes: before.basic.attributes,
    };
    let extent = facet::NativeExtent {
        bytes: parsed.bytes,
        sha256: parsed.sha256,
    };
    spool
        .seek(SeekFrom::Start(0))
        .map_err(|e| io_error("treeFacetRead", e))?;
    let mut output = ns.target_carrier.as_ref().ok_or(Error::Invalid)?;
    output
        .set_len(0)
        .map_err(|e| io_error("treeFacetReset", e))?;
    output
        .seek(SeekFrom::Start(0))
        .map_err(|e| io_error("treeFacetSeek", e))?;
    let stored = facet::append(
        &mut spool,
        &mut output,
        &meta,
        &extent,
        work,
        cancel,
        resident,
    )?;
    material_restore::flushed(output)?;
    output
        .seek(SeekFrom::Start(0))
        .map_err(|e| io_error("treeTypedVerify", e))?;
    let verified = facet::verify_exact(&mut output, work, cancel, resident)?;
    if verified.metadata != meta
        || verified.native.bytes != parsed.bytes
        || verified.native.sha256 != parsed.sha256
        || verified.stored_bytes != stored
        || !before.unchanged(&facts::take(file, full, work, cancel, resident)?)
    {
        return Err(Error::Changed);
    }
    node.pin
        .verify()
        .map_err(|e| io_error("treeSourceNodeAfter", e))?;
    node.bytes = parsed.bytes;
    node.sha256 = parsed.sha256;
    node.facts = Some(before);
    Ok((verified.record_sha256, stored))
}
