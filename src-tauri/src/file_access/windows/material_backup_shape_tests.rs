//! Test-registered ordinary BackupRead(FALSE) shape observer. NO restore profile.
//! Does not use or weaken the full-security regular carrier parser.
use super::material_restore::Namespace;
use super::*;
use crate::file_access::{
    ea_records::WorkBudget,
    material_backup_io::{self as transfer, Api, Mode, RetiredContext, Session},
    material_carrier_records::{
        self as records, BLOCK, CATALOG_RESIDENT, Error, Resident, Result, WORK_LIMIT, charge,
        check, io_error,
    },
};
use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    io::{Read, Seek, SeekFrom},
    panic::AssertUnwindSafe,
    sync::atomic::AtomicBool,
};
pub(crate) const SHAPE_WORK_LIMIT: u64 = WORK_LIMIT;
// Share the existing logical resident leases across every observation in one
// owned case, without widening the original Resident's module visibility.
pub(crate) struct ShapeMemory(Resident);
impl Default for ShapeMemory {
    fn default() -> Self {
        Self(Resident::new(records::RESIDENT_LIMIT))
    }
}
pub(crate) struct ShapeRequest {
    pin: PinnedPath,
}
impl ShapeRequest {
    pub(crate) fn held_ordinary(pin: PinnedPath) -> Result<Self> {
        if pin.full_security_purpose() {
            return Err(Error::Unsupported);
        }
        Ok(Self { pin })
    }
}
#[derive(Debug)]
pub(crate) struct ShapeFrame {
    pub id: u32,
    pub flags: u32,
    pub size: u64,
    pub name: Vec<u16>,
    pub body_sha256: [u8; 32],
    // Pure counted units for later OWNED-sample analysis, not a parsed path.
    // Never logged/forwarded to BackupWrite/used as destination authority.
    link_body_units: Option<Vec<u16>>,
}
pub(crate) struct ShapeObservation {
    _memory: records::ResidentLease,
    pub identity: Identity,
    pub directory: bool,
    pub links: u64,
    pub bytes: u64,
    pub frames: Vec<ShapeFrame>,
    pub native_reads: u64,
    pub native_eof: bool,
    pub abort_calls: u32,
    pub owned_carrier_closed: bool,
}
impl ShapeObservation {
    pub(crate) fn safe_fields(&self) -> serde_json::Value {
        serde_json::json!({"kind":if self.directory {"directory"} else {"file"},
            "volume":self.identity.device,"fullId":format!("{:032x}",self.identity.inode),
            "links":self.links,"bytes":self.bytes,"nativeReads":self.native_reads,
            "nativeEOF":self.native_eof,"abortCalls":self.abort_calls,
            "ownedCarrierClosed":self.owned_carrier_closed,"processSecurity":false,
            "profile":"ordinary-shape-only-not-restorable",
            "frames":self.frames.iter().map(|f| {
                let mut name=Sha256::new();for unit in &f.name {name.update(unit.to_le_bytes());}
                serde_json::json!({"id":f.id,"flags":f.flags,"size":f.size,"nameUnits":f.name.len(),
                    "nameSHA256":name.finalize().iter().map(|b|format!("{b:02x}")).collect::<String>(),"bodySHA256":f.body_sha256.iter().map(|b|format!("{b:02x}")).collect::<String>(),"linkCountedUnits":f.link_body_units.as_ref().map(Vec::len),
                    "unknownId":!matches!(f.id,1..=5),
                    "linkUnitShape":f.link_body_units.as_ref().map(|u|serde_json::json!({
                        "terminatesNul":u.last()==Some(&0),"containsNul":u.contains(&0),
                        "leadingSeparator":u.first().is_some_and(|v|matches!(*v,47|92)),
                        "driveColonAt1":u.get(1)==Some(&58),
                        "dosExtendedPrefix":u.starts_with(&[92,92,63,92]),
                        "nativeDosPrefix":u.starts_with(&[92,63,63,92])}))})
            }).collect::<Vec<_>>()})
    }
}
pub(crate) struct ShapeRetirement {
    _source: PinnedPath,
    _namespace: Option<Namespace>,
    _context: Option<RetiredContext>,
    _operation_error: Option<Error>,
    _cleanup_error: Error,
}
#[derive(Default)]
struct Ordinary {
    reads: u64,
    eof: bool,
    aborts: u32,
}
impl Api for Ordinary {
    fn read(&mut self, file: &File, bytes: &mut [u8], ctx: &mut *mut c_void) -> io::Result<usize> {
        self.reads = self
            .reads
            .checked_add(1)
            .ok_or_else(|| io::Error::other("shape read count overflow"))?;
        let mut returned = 0;
        let ok = unsafe {
            BackupRead(
                handle(file),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                &mut returned,
                0,
                0,
                ctx,
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            eprintln!(
                "FARFOLD_BACKUP_SHAPE_NATIVE read_error code={:?}",
                error.raw_os_error()
            );
            return Err(error);
        }
        self.eof = returned == 0;
        Ok(returned as usize)
    }
    fn write(&mut self, _file: &File, _bytes: &[u8], _ctx: &mut *mut c_void) -> io::Result<usize> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn abort(&mut self, mode: Mode, file: &File, ctx: &mut *mut c_void) -> io::Result<()> {
        if mode != Mode::Read {
            return Err(io::ErrorKind::Unsupported.into());
        }
        self.aborts = self
            .aborts
            .checked_add(1)
            .ok_or_else(|| io::Error::other("shape abort count overflow"))?;
        if unsafe { BackupRead(handle(file), ptr::null_mut(), 0, ptr::null_mut(), 1, 0, ctx) } == 0
        {
            let error = io::Error::last_os_error();
            eprintln!(
                "FARFOLD_BACKUP_SHAPE_NATIVE abort_error code={:?}",
                error.raw_os_error()
            );
            Err(error)
        } else {
            Ok(())
        }
    }
}
// Bounded framing only. Every ID/flag is observed, not admitted for preservation.
// The sum of frame headers/names/retained LINK sample bytes is <=one64KiB page.
// Bodies are streamed/hash-checked under the SAME shared WorkBudget.
fn framed<R: Read>(
    mut input: R,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Vec<ShapeFrame>> {
    fn exact<R: Read>(r: &mut R, b: &mut [u8], w: &mut WorkBudget, c: &AtomicBool) -> Result<()> {
        let mut at = 0;
        while at < b.len() {
            check(c)?;
            if w.remaining() == 0 {
                return Err(Error::Limit);
            }
            let offered = (b.len() - at).min(w.remaining() as usize);
            let n = r
                .read(&mut b[at..at + offered])
                .map_err(|e| io_error("shapeRead", e))?;
            if n == 0 || n > offered {
                return Err(Error::Invalid);
            }
            charge(w, n)?;
            at += n;
        }
        Ok(())
    }
    const MAX: usize = BLOCK / 20;
    let mut frames = Vec::with_capacity(MAX);
    let mut catalog = 0usize;
    let mut scratch = vec![0u8; BLOCK];
    loop {
        check(cancel)?;
        if work.remaining() == 0 {
            return Err(Error::Limit);
        }
        let mut head = [0u8; 20];
        let n = input
            .read(&mut head[..1])
            .map_err(|e| io_error("shapeHeader", e))?;
        if n == 0 {
            return Ok(frames);
        }
        if n != 1 {
            return Err(Error::Invalid);
        }
        charge(work, n)?;
        exact(&mut input, &mut head[1..], work, cancel)?;
        let id = u32::from_le_bytes(head[..4].try_into().expect("fixed"));
        let flags = u32::from_le_bytes(head[4..8].try_into().expect("fixed"));
        let size = u64::from_le_bytes(head[8..16].try_into().expect("fixed"));
        let name_bytes = u32::from_le_bytes(head[16..20].try_into().expect("fixed")) as usize;
        if !name_bytes.is_multiple_of(2) || name_bytes > BLOCK || size > records::STREAM_LIMIT {
            return Err(Error::Limit);
        }
        catalog = catalog.checked_add(20 + name_bytes).ok_or(Error::Limit)?;
        if catalog > BLOCK || frames.len() == MAX {
            return Err(Error::Limit);
        }
        exact(&mut input, &mut scratch[..name_bytes], work, cancel)?;
        let name = scratch[..name_bytes]
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        let mut link = if id == 5 && size.is_multiple_of(2) {
            let n = usize::try_from(size).map_err(|_| Error::Limit)?;
            catalog = catalog.checked_add(n).ok_or(Error::Limit)?;
            if catalog > BLOCK {
                return Err(Error::Limit);
            }
            Some(Vec::with_capacity(n / 2))
        } else {
            None
        };
        let mut hash = Sha256::new();
        let mut remaining = size;
        while remaining != 0 {
            let offered = remaining.min(BLOCK as u64) as usize;
            exact(&mut input, &mut scratch[..offered], work, cancel)?;
            hash.update(&scratch[..offered]);
            if let Some(units) = &mut link {
                units.extend(
                    scratch[..offered]
                        .chunks_exact(2)
                        .map(|b| u16::from_le_bytes([b[0], b[1]])),
                );
            }
            remaining -= offered as u64;
        }
        frames.push(ShapeFrame {
            id,
            flags,
            size,
            name,
            body_sha256: hash.finalize().into(),
            link_body_units: link,
        });
    }
}
pub(crate) fn observe(
    request: ShapeRequest,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    memory: &ShapeMemory,
    retirement: &mut Option<ShapeRetirement>,
) -> Result<ShapeObservation> {
    let resident = &memory.0;
    if retirement.is_some() {
        return Err(Error::CleanupUnknown);
    }
    let pin = request.pin;
    let mut namespace = None;
    let mut context = None;
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        check(cancel)?;
        if work.remaining() > WORK_LIMIT {
            return Err(Error::Limit);
        }
        let _query = pin
            .try_observation_owner()
            .map_err(|_| Error::Unsupported)?;
        pin.verify().map_err(|e| io_error("shapeSourceVerify", e))?;
        let before = metadata_file(pin.file()).map_err(|error| {
            eprintln!("FARFOLD_BACKUP_SHAPE_METADATA before {error:?}");
            Error::Unsupported
        })?;
        let before_stamp = stamp(pin.file()).map_err(|e| io_error("shapeSourceStamp", e))?;
        const ORDINARY: u32 = FILE_ATTRIBUTE_READONLY
            | FILE_ATTRIBUTE_HIDDEN
            | FILE_ATTRIBUTE_SYSTEM
            | FILE_ATTRIBUTE_ARCHIVE
            | FILE_ATTRIBUTE_NORMAL
            | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED
            | FILE_ATTRIBUTE_DIRECTORY;
        if !matches!(before.kind, MetadataKind::File | MetadataKind::Directory)
            || before.attributes() & !ORDINARY != 0
        {
            return Err(Error::Unsupported);
        }
        let memory = resident.lease(CATALOG_RESIDENT)?;
        let _scratch = resident.lease(2 * BLOCK)?;
        namespace = Some(Namespace::reserve()?);
        let ns = namespace.as_mut().ok_or(Error::Invalid)?;
        ns.open()?;
        let spool = ns.source_carrier.as_ref().ok_or(Error::Invalid)?;
        let mut api = Ordinary::default();
        let mut session = Session::new(pin.file(), &mut api, Mode::Read, &mut context);
        let bytes = transfer::capture(
            &mut session,
            spool,
            work,
            cancel,
            size_of::<WIN32_STREAM_ID>() + 1,
            resident,
        )?;
        drop(session);
        if !api.eof || api.aborts != 1 {
            return Err(Error::Invalid);
        }
        let mut input = spool;
        input
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("shapeSeek", e))?;
        let frames = framed(input, work, cancel)?;
        if metadata_file(pin.file()).map_err(|error| {
            eprintln!("FARFOLD_BACKUP_SHAPE_METADATA after {error:?}");
            Error::Unsupported
        })? != before
            || stamp(pin.file()).map_err(|e| io_error("shapeAfter", e))? != before_stamp
        {
            return Err(Error::Changed);
        }
        pin.verify().map_err(|e| io_error("shapeSourceAfter", e))?;
        ns.verify()?;
        check(cancel)?;
        Ok(ShapeObservation {
            _memory: memory,
            identity: before_stamp.identity,
            directory: !before_stamp.regular,
            links: before_stamp.links,
            bytes,
            frames,
            native_reads: api.reads,
            native_eof: api.eof,
            abort_calls: api.aborts,
            owned_carrier_closed: false,
        })
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
        *retirement = Some(ShapeRetirement {
            _source: pin,
            _namespace: namespace,
            _context: context,
            _operation_error: operation_error,
            _cleanup_error: cleanup_error,
        });
        return Err(Error::CleanupUnknown);
    }
    result.map(|mut value| {
        value.owned_carrier_closed = true;
        value
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: u32, flags: u32, name: &[u16], body: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend(id.to_le_bytes());
        bytes.extend(flags.to_le_bytes());
        bytes.extend((body.len() as u64).to_le_bytes());
        bytes.extend((name.len() as u32 * 2).to_le_bytes());
        for u in name {
            bytes.extend(u.to_le_bytes());
        }
        bytes.extend(body);
        bytes
    }
    #[test]
    fn observation_retains_unknown_header_and_raw_link_units_without_minting_a_profile() {
        let mut bytes = record(99, 0x80000000, &[0xd800], b"unknown");
        bytes.extend(record(5, 0, &[], &[65, 0, 0, 216]));
        let values = framed(
            &bytes[..],
            &mut WorkBudget::new(WORK_LIMIT),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0].id, 99);
        assert_eq!(values[0].flags, 0x80000000);
        assert_eq!(values[0].name, vec![0xd800]);
        assert_eq!(values[1].link_body_units, Some(vec![65, 0xd800]));
        assert_eq!(
            values[0].body_sha256,
            <[u8; 32]>::from(Sha256::digest(b"unknown"))
        );
    }
    #[test]
    fn framing_truncation_cancel_and_shared_byte_limit_never_become_completion() {
        let bytes = record(1, 0, &[], b"body");
        for length in 1..bytes.len() {
            assert!(matches!(
                framed(
                    &bytes[..length],
                    &mut WorkBudget::new(WORK_LIMIT),
                    &AtomicBool::new(false)
                ),
                Err(Error::Invalid)
            ));
        }
        assert!(matches!(
            framed(&bytes[..], &mut WorkBudget::new(1), &AtomicBool::new(false)),
            Err(Error::Limit)
        ));
        assert!(matches!(
            framed(
                &bytes[..],
                &mut WorkBudget::new(WORK_LIMIT),
                &AtomicBool::new(true)
            ),
            Err(Error::Cancelled)
        ));
        assert!(
            framed(&[][..], &mut WorkBudget::new(1), &AtomicBool::new(false))
                .unwrap()
                .is_empty()
        );
    }
}
