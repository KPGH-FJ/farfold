//! Ordinary nodes use the same carrier, native context and source owner.
use super::super::*;
use super::super::{
    directory::Owner,
    material_carrier_native as native,
    material_directory_carrier::Native,
    material_mixed_tree_source::Node,
    material_ordinary_security as security,
    material_pin::MaterialPin,
    material_regular_shared::Io,
    material_restore::{self, Namespace},
};
use super::{NativeProof, SecurityEvidence};
use crate::file_access::{
    ea_records::{self, WorkBudget},
    material_backup_io::{self as transfer, Mode, Session},
    material_carrier_fragment as fragment,
    material_carrier_records::{
        self as records, Error, Resident, ResidentLease, Result, charge, check, io_error,
    },
    material_directory_facet as facet,
    material_directory_records::{self as dirs, Profile},
    material_mixed_tree_records::Kind,
    material_ordinary_security_records::{Owned, Summary},
};
use sha2::{Digest, Sha256};
use std::{io::Seek, sync::atomic::AtomicBool};
pub(in super::super) struct Facts {
    pub version: EntryMetadata,
    pub stamp: Stamp,
    pub basic: native::Basic,
    pub expected: records::Expected,
    pub ea: ea_records::Observation,
    pub security: Owned,
    _memory: ResidentLease,
}
impl Facts {
    pub(in super::super) fn take(
        file: &File,
        kind: Kind,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<Self> {
        let memory = resident.lease(records::CATALOG_RESIDENT + 2 * records::BLOCK)?;
        check(cancel)?;
        let stamp_before = stamp(file).map_err(|e| io_error("ordinaryStamp", e))?;
        let version = metadata_file(file).map_err(|_| Error::Invalid)?;
        let basic: FILE_BASIC_INFO =
            info(file, FileBasicInfo).map_err(|e| io_error("ordinaryBasic", e))?;
        let directory = kind == Kind::Directory;
        let allowed = FILE_ATTRIBUTE_READONLY
            | FILE_ATTRIBUTE_HIDDEN
            | FILE_ATTRIBUTE_SYSTEM
            | FILE_ATTRIBUTE_ARCHIVE
            | FILE_ATTRIBUTE_NORMAL
            | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED
            | if directory {
                FILE_ATTRIBUTE_DIRECTORY
            } else {
                0
            };
        if stamp_before.identity.inode == 0
            || stamp_before.links != 1
            || stamp_before.regular == directory
            || version.kind
                != if directory {
                    MetadataKind::Directory
                } else {
                    MetadataKind::File
                }
            || basic.FileAttributes & !allowed != 0
            || (basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
            || basic.CreationTime <= 0
            || basic.LastAccessTime <= 0
            || basic.LastWriteTime <= 0
        {
            return Err(Error::Unsupported);
        }
        let inventory = if directory {
            native::directory_inventory(file, work, cancel)?
        } else {
            native::inventory(file, work, cancel)?
        };
        if directory == inventory.has_default()
            || (!directory && inventory.default_size() != Some(stamp_before.size))
        {
            #[cfg(test)]
            eprintln!(
                "FARFOLD_ORDINARY_DIAGNOSTIC phase=source-inventory directory={directory} has_default={} default_matches_size={}",
                inventory.has_default(),
                inventory.default_size() == Some(stamp_before.size),
            );
            return Err(Error::Changed);
        }
        let expected = inventory.carrier_data();
        let ea = native::ea(file, work, cancel)?;
        let security = security::capture(file, work, cancel, resident)?;
        if stamp(file).map_err(|e| io_error("ordinaryAfter", e))? != stamp_before
            || metadata_file(file).map_err(|_| Error::Invalid)? != version
        {
            #[cfg(test)]
            eprintln!("FARFOLD_ORDINARY_DIAGNOSTIC phase=source-facts-after");
            return Err(Error::Changed);
        }
        Ok(Self {
            version,
            stamp: stamp_before,
            basic: native::Basic {
                created: basic.CreationTime,
                accessed: basic.LastAccessTime,
                modified: basic.LastWriteTime,
                attributes: basic.FileAttributes,
            },
            expected,
            ea,
            security,
            _memory: memory,
        })
    }
    pub(in super::super) fn matches(&self, other: &Self) -> bool {
        self.version == other.version
            && self.stamp == other.stamp
            && self.expected == other.expected
            && self.ea == other.ea
            && self.security.summary.same_facets(&other.security.summary)
    }
}
pub(super) struct Witness {
    pin: MaterialPin,
    kind: Kind,
    version: EntryMetadata,
    stamp: Stamp,
    expected: [u8; 32],
    ea: ea_records::Observation,
    security: Summary,
    _memory: ResidentLease,
}
fn inventory_hash(
    expected: &records::Expected,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<[u8; 32]> {
    let mut hash = Sha256::new();
    for (name, bytes) in expected {
        check(cancel)?;
        charge(work, name.len() * 2 + 16)?;
        hash.update((name.len() as u64).to_le_bytes());
        for unit in name {
            hash.update(unit.to_le_bytes());
        }
        hash.update(bytes.to_le_bytes());
    }
    Ok(hash.finalize().into())
}
impl Witness {
    pub(super) fn verify(
        &self,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<()> {
        self.pin
            .verify()
            .map_err(|e| io_error("ordinaryWitness", e))?;
        let _guard = self
            .pin
            .try_observation_owner()
            .map_err(|_| Error::Unsupported)?;
        let f = Facts::take(Owner::file(&self.pin), self.kind, work, cancel, resident)?;
        if self.version != f.version
            || self.stamp != f.stamp
            || self.ea != f.ea
            || self.expected != inventory_hash(&f.expected, work, cancel)?
            || !self.security.same_facets(&f.security.summary)
        {
            return Err(Error::Changed);
        }
        Ok(())
    }
}
pub(super) struct Captured {
    pub bytes: u64,
    pub sha256: [u8; 32],
    pub native_bytes: u64,
    pub native_sha256: [u8; 32],
    pub basic: native::Basic,
    pub security: Owned,
    pub proof: NativeProof,
    pub witness: Witness,
}
pub(super) fn capture(node: &Node, ns: &Namespace, io: &mut Io<'_>) -> Result<Captured> {
    #[cfg(test)]
    eprintln!(
        "FARFOLD_ORDINARY_DIAGNOSTIC phase=capture-enter directory={}",
        node.kind == Kind::Directory,
    );
    let Io {
        work,
        cancel,
        resident,
        context,
    } = io;
    check(cancel)?;
    if context.is_some() || node.pin.full_security_purpose() {
        return Err(Error::Unsupported);
    }
    node.pin
        .verify()
        .map_err(|e| io_error("ordinarySource", e))?;
    let _guard = node
        .pin
        .try_observation_owner()
        .map_err(|_| Error::Unsupported)?;
    let source = Owner::file(&node.pin);
    let facts = Facts::take(source, node.kind, work, cancel, resident)?;
    let spool = ns.source_carrier.as_ref().ok_or(Error::Invalid)?;
    if stamp(spool).map_err(|e| io_error("ordinarySpool", e))?.size != 0 {
        return Err(Error::Invalid);
    }
    let mut api = Native::new(false);
    let mut session = Session::new(source, &mut api, Mode::Read, context);
    let captured = transfer::capture(
        &mut session,
        spool,
        work,
        cancel,
        size_of::<WIN32_STREAM_ID>() + 1,
        resident,
    );
    drop(session);
    let native_bytes = captured?;
    if context.is_some() || !api.eof() || api.aborts() != 1 {
        return Err(Error::CleanupUnknown);
    }
    material_restore::flushed(spool)?;
    let mut input = spool;
    input
        .rewind()
        .map_err(|e| io_error("ordinaryParseSeek", e))?;
    let (native_sha256, payload_semantic) = match node.kind {
        Kind::Regular => {
            let p = records::parse_profile(input, &facts.expected, false, work, cancel, resident)?;
            if p.bytes != native_bytes || p.has_ea() != (facts.ea.count != 0) {
                #[cfg(test)]
                eprintln!(
                    "FARFOLD_ORDINARY_DIAGNOSTIC phase=capture-regular-native native_length_equal={} ea_presence_equal={}",
                    p.bytes == native_bytes,
                    p.has_ea() == (facts.ea.count != 0),
                );
                return Err(Error::Changed);
            }
            (p.sha256, p.semantic_sha256())
        }
        Kind::Directory => {
            let p = dirs::parse(
                input,
                &facts.expected,
                Profile::PayloadOnly,
                work,
                cancel,
                resident,
            )?;
            if p.bytes != native_bytes
                || p.has_ea() != (facts.ea.count != 0)
                || p.ea.as_ref().is_some_and(|e| e != &facts.ea)
            {
                return Err(Error::Changed);
            }
            (p.sha256, p.semantic_sha256())
        }
    };
    let after = Facts::take(source, node.kind, work, cancel, resident)?;
    if !facts.matches(&after) {
        #[cfg(test)]
        eprintln!(
            "FARFOLD_ORDINARY_DIAGNOSTIC phase=capture-after version_equal={} stamp_equal={} streams_equal={} ea_equal={} security_equal={}",
            facts.version == after.version,
            facts.stamp == after.stamp,
            facts.expected == after.expected,
            facts.ea == after.ea,
            facts.security.summary.same_facets(&after.security.summary),
        );
        return Err(Error::Changed);
    }
    drop(after);
    let mut typed = ns.target_carrier.as_ref().ok_or(Error::Invalid)?;
    typed
        .set_len(0)
        .map_err(|e| io_error("ordinaryTypedReset", e))?;
    typed
        .rewind()
        .map_err(|e| io_error("ordinaryTypedSeek", e))?;
    input.rewind().map_err(|e| io_error("ordinaryRawSeek", e))?;
    let (bytes, sha256) = match node.kind {
        Kind::Regular => {
            let meta = fragment::Metadata {
                raw_leaf: node.leaf.clone(),
                source_volume: facts.stamp.identity.device,
                source_id: facts.stamp.identity.inode,
                created: facts.basic.created,
                accessed: facts.basic.accessed,
                modified: facts.basic.modified,
                attributes: facts.basic.attributes,
            };
            let extent = fragment::NativeExtent {
                bytes: native_bytes,
                sha256: native_sha256,
            };
            let bytes = fragment::append(
                &mut input, &mut typed, &meta, &extent, work, cancel, resident,
            )?;
            typed
                .rewind()
                .map_err(|e| io_error("ordinaryTypedVerify", e))?;
            let v = fragment::verify_exact(&mut typed, work, cancel, resident)?;
            if v.metadata != meta
                || v.native.bytes != native_bytes
                || v.native.sha256 != native_sha256
            {
                return Err(Error::Changed);
            }
            (bytes, v.record_sha256)
        }
        Kind::Directory => {
            let meta = facet::Metadata {
                security_full: false,
                raw_leaf: node.leaf.clone(),
                source_volume: facts.stamp.identity.device,
                source_id: facts.stamp.identity.inode,
                created: facts.basic.created,
                accessed: facts.basic.accessed,
                modified: facts.basic.modified,
                attributes: facts.basic.attributes,
            };
            let extent = facet::NativeExtent {
                bytes: native_bytes,
                sha256: native_sha256,
            };
            let bytes = facet::append(
                &mut input, &mut typed, &meta, &extent, work, cancel, resident,
            )?;
            typed
                .rewind()
                .map_err(|e| io_error("ordinaryTypedVerify", e))?;
            let v = facet::verify_exact(&mut typed, work, cancel, resident)?;
            if v.metadata != meta
                || v.native.bytes != native_bytes
                || v.native.sha256 != native_sha256
            {
                return Err(Error::Changed);
            }
            (bytes, v.record_sha256)
        }
    };
    material_restore::flushed(typed)?;
    let proof = NativeProof::from_facts(
        &facts.stamp.identity,
        node.kind,
        facts.security.summary.bind_payload(payload_semantic),
        &facts.expected,
        &facts.ea,
        SecurityEvidence::Ordinary(&facts.security.summary),
        resident,
    )?;
    let witness = Witness {
        pin: node.pin.clone(),
        kind: node.kind,
        version: facts.version.clone(),
        stamp: facts.stamp.clone(),
        expected: inventory_hash(&facts.expected, work, cancel)?,
        ea: facts.ea.clone(),
        security: facts.security.summary.clone(),
        _memory: resident.lease(4096)?,
    };
    #[cfg(test)]
    eprintln!(
        "FARFOLD_ORDINARY_DIAGNOSTIC phase=capture-complete directory={} native_bytes={native_bytes}",
        node.kind == Kind::Directory,
    );
    Ok(Captured {
        bytes,
        sha256,
        native_bytes,
        native_sha256,
        basic: facts.basic,
        security: facts.security,
        proof,
        witness,
    })
}
