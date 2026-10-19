//! Ordinary shape-only native controls. No SACL privilege/restore fallback.
use super::{Slot, error};
use crate::file_access::{
    EaWorkBudget, PinnedPath, SHAPE_WORK_LIMIT, ShapeFailure, ShapeMemory, ShapeObservation,
    ShapeRequest, ShapeRetirement, backup_shape_observe, ea_observation, stamp,
};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
    sync::atomic::AtomicBool,
};
use windows_sys::{
    Wdk::Storage::FileSystem::NtSetEaFile,
    Win32::{
        Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_WRITE_EA, SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};
fn ntfs(pin: &PinnedPath) {
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationByHandleW;
    let mut fs = [0u16; 32];
    assert_ne!(
        unsafe {
            GetVolumeInformationByHandleW(
                pin.file().as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                fs.as_mut_ptr(),
                32,
            )
        },
        0
    );
    assert_eq!(
        String::from_utf16(&fs[..fs.iter().position(|c| *c == 0).unwrap()]).unwrap(),
        "NTFS"
    );
}
fn pin(path: &Path, directory: bool) -> PinnedPath {
    let path = path.canonicalize().unwrap();
    let pin = if directory {
        PinnedPath::directory(&path)
    } else {
        PinnedPath::regular(&path)
    }
    .unwrap();
    ntfs(&pin);
    pin
}
fn ea(path: &Path) {
    let writer = OpenOptions::new()
        .access_mode(FILE_WRITE_EA | SYNCHRONIZE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .unwrap();
    let name = b"OWNED-SHAPE";
    let value = b"EA\0\xff";
    let mut raw = vec![0u8; 8];
    raw[5] = name.len() as u8;
    raw[6..8].copy_from_slice(&(value.len() as u16).to_le_bytes());
    raw.extend(name);
    raw.push(0);
    raw.extend(value);
    let mut ios = IO_STATUS_BLOCK::default();
    assert_eq!(
        unsafe {
            NtSetEaFile(
                writer.as_raw_handle(),
                &mut ios,
                raw.as_ptr().cast(),
                raw.len() as u32,
            )
        },
        0
    );
}
fn observed(
    slot: &Slot<ShapeRetirement>,
    pin: PinnedPath,
    work: &mut EaWorkBudget,
    cancel: &AtomicBool,
    resident: &ShapeMemory,
) -> std::result::Result<ShapeObservation, ShapeFailure> {
    let request = ShapeRequest::held_ordinary(pin).unwrap();
    let mut result = None;
    let outer = slot.run(|retired| {
        result = Some(backup_shape_observe(
            request, work, cancel, resident, retired,
        ));
        match result.as_ref().unwrap() {
            Ok(_) => Ok(()),
            Err(_) => Err(error("shapeObservationFailed")),
        }
    });
    if slot.occupied() {
        panic!("shape cleanupUnknown: original owner remains in existing Slot");
    }
    match result {
        Some(result) => {
            if let Err(error) = &result {
                eprintln!("FARFOLD_BACKUP_SHAPE_ERROR {error:?}");
            }
            result
        }
        None => panic!("existing Slot refused observation: {outer:?}"),
    }
}
fn run(
    slot: &Slot<ShapeRetirement>,
    pin: PinnedPath,
    work: &mut EaWorkBudget,
    resident: &ShapeMemory,
) -> ShapeObservation {
    let value = observed(slot, pin, work, &AtomicBool::new(false), resident).unwrap();
    assert!(value.native_eof && value.abort_calls == 1 && value.owned_carrier_closed);
    eprintln!("FARFOLD_BACKUP_ORDINARY_SHAPE {}", value.safe_fields());
    value
}
#[test]
fn ordinary_owned_empty_directory_shape_reaches_real_eof_and_abort_without_full_security() {
    let temp = tempfile::tempdir().unwrap();
    let slot = Slot::<ShapeRetirement>::default();
    let mut work = EaWorkBudget::new(SHAPE_WORK_LIMIT);
    let resident = ShapeMemory::default();
    let expected = stamp(pin(temp.path(), true).file()).unwrap().identity;
    let value = run(&slot, pin(temp.path(), true), &mut work, &resident);
    assert!(value.directory);
    assert_eq!(value.identity, expected);
    // Empty frame sequence is an observation only, never a complete directory
    // carrier profile. Native TRUE+zero+successful once-abort are still required.
    drop(value);
    assert!(!slot.occupied());
    temp.close().unwrap();
}
#[test]
fn ordinary_owned_directory_ea_and_named_data_have_actual_bounded_record_shapes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owned-dir");
    std::fs::create_dir(&path).unwrap();
    let named = b"directory-named\0\xff";
    let stream = format!("{}:shape:$DATA", path.display());
    std::fs::write(&stream, named).unwrap();
    ea(&path);
    let source = pin(&path, true);
    let slot = Slot::<ShapeRetirement>::default();
    let mut work = EaWorkBudget::new(SHAPE_WORK_LIMIT);
    assert_eq!(
        ea_observation(&source, &mut work, &AtomicBool::new(false))
            .unwrap()
            .count,
        1
    );
    let value = run(&slot, source, &mut work, &ShapeMemory::default());
    let expected: Vec<u16> = ":shape:$DATA".encode_utf16().collect();
    assert!(value.frames.iter().any(|r| r.id == 4
        && r.name == expected
        && r.size == named.len() as u64
        && r.body_sha256 == <[u8; 32]>::from(Sha256::digest(named))));
    assert!(value.frames.iter().any(|r| r.id == 2 && r.size > 0));
    assert_eq!(std::fs::read(&stream).unwrap(), named);
    drop(value);
    temp.close().unwrap();
}
#[test]
fn ordinary_owned_hardlink_aliases_observe_native_link_records_without_assuming_they_exist() {
    let temp = tempfile::tempdir().unwrap();
    let a = temp.path().join("first.bin");
    let b = temp.path().join("second.bin");
    let body: Vec<u8> = (0..=255).cycle().take(300).collect();
    std::fs::write(&a, &body).unwrap();
    ea(&a);
    let named = b"hardlink-named";
    std::fs::write(format!("{}:shape:$DATA", a.display()), named).unwrap();
    std::fs::hard_link(&a, &b).unwrap();
    let first = pin(&a, false);
    let second = pin(&b, false);
    let first_stamp = stamp(first.file()).unwrap();
    let second_stamp = stamp(second.file()).unwrap();
    assert_eq!(first_stamp.identity, second_stamp.identity);
    assert_eq!(first_stamp.links, 2);
    assert_eq!(second_stamp.links, 2);
    let slot = Slot::<ShapeRetirement>::default();
    let mut work = EaWorkBudget::new(SHAPE_WORK_LIMIT);
    let resident = ShapeMemory::default();
    let ea_before = ea_observation(&first, &mut work, &AtomicBool::new(false)).unwrap();
    assert_eq!(ea_before.count, 1);
    let one = run(&slot, first, &mut work, &resident);
    let two = run(&slot, second, &mut work, &resident);
    assert_eq!(one.identity, two.identity);
    assert_eq!(one.links, 2);
    assert_eq!(two.links, 2);
    let hash: [u8; 32] = Sha256::digest(&body).into();
    for value in [&one, &two] {
        assert!(
            value
                .frames
                .iter()
                .any(|r| r.id == 1 && r.name.is_empty() && r.size == 300 && r.body_sha256 == hash)
        );
        assert!(value.frames.iter().any(|r| r.id == 2 && r.size > 0));
        let expected: Vec<u16> = ":shape:$DATA".encode_utf16().collect();
        assert!(value.frames.iter().any(|r| r.id == 4
            && r.name == expected
            && r.size == named.len() as u64
            && r.body_sha256 == <[u8; 32]>::from(Sha256::digest(named))));
    }
    // A zero BACKUP_LINK count remains a real observed result. Neither these
    // bytes nor an absolute LINK payload may create/reconstruct an alias.
    eprintln!(
        "FARFOLD_BACKUP_LINK_SHAPE {}",
        serde_json::json!({"knownOwnedAliases":2,"fullIdEqual":true,
        "firstLinkRecords":one.frames.iter().filter(|r|r.id==5).count(),
        "secondLinkRecords":two.frames.iter().filter(|r|r.id==5).count(),"explicitRelativeAliasImplemented":false})
    );
    assert_eq!(std::fs::read(&a).unwrap(), body);
    assert_eq!(std::fs::read(&b).unwrap(), body);
    drop((one, two));
    temp.close().unwrap();
}
#[test]
fn ordinary_shape_pre_cancel_and_insufficient_shared_work_refuse_without_weakening_source() {
    let temp = tempfile::tempdir().unwrap();
    let slot = Slot::<ShapeRetirement>::default();
    let resident = ShapeMemory::default();
    assert!(matches!(
        observed(
            &slot,
            pin(temp.path(), true),
            &mut EaWorkBudget::new(SHAPE_WORK_LIMIT),
            &AtomicBool::new(true),
            &resident
        ),
        Err(ShapeFailure::Cancelled)
    ));
    assert!(!slot.occupied());
    assert!(matches!(
        observed(
            &slot,
            pin(temp.path(), true),
            &mut EaWorkBudget::new(1),
            &AtomicBool::new(false),
            &resident
        ),
        Err(ShapeFailure::Limit)
    ));
    assert!(!slot.occupied());
    assert!(std::fs::read_dir(temp.path()).unwrap().next().is_none());
    temp.close().unwrap();
}
