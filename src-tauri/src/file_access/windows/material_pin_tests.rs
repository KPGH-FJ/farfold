use super::*;
use crate::file_access::material_carrier_records::RESIDENT_LIMIT;
use std::{io::Write, sync::atomic::AtomicBool};
use windows_sys::Win32::Security::{BACKUP_SECURITY_INFORMATION, GetKernelObjectSecurity};
fn resident() -> Resident {
    Resident::new(RESIDENT_LIMIT)
}
fn ntfs(file: &File) {
    let mut fs = [0u16; 32];
    assert_ne!(
        unsafe {
            GetVolumeInformationByHandleW(
                handle(file),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                fs.as_mut_ptr(),
                32,
            )
        },
        0
    );
    let end = fs.iter().position(|c| *c == 0).unwrap();
    assert_eq!(
        String::from_utf16(&fs[..end]).unwrap(),
        "NTFS",
        "owned NTFS control required"
    );
}
fn root(path: &Path) -> MaterialPin {
    let selected = PinnedPath::directory(&path.canonicalize().unwrap()).unwrap();
    ntfs(selected.file());
    MaterialPin::root(selected, &resident(), &AtomicBool::new(false)).unwrap()
}
fn write_parent(path: &Path) -> File {
    let canonical = path.canonicalize().unwrap();
    let wide: Vec<u16> = canonical.as_os_str().encode_wide().chain(Some(0)).collect();
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY
                | FILE_ADD_FILE
                | FILE_ADD_SUBDIRECTORY
                | FILE_READ_ATTRIBUTES
                | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    assert_ne!(raw, INVALID_HANDLE_VALUE);
    unsafe { File::from_raw_handle(raw) }
}
fn create_owned(parent: &File, raw: &[u16], directory: bool) -> File {
    material_raw_name::check(raw).unwrap();
    let mut encoded = raw.to_vec();
    let unicode = UNICODE_STRING {
        Length: (encoded.len() * 2) as u16,
        MaximumLength: (encoded.len() * 2) as u16,
        Buffer: encoded.as_mut_ptr(),
    };
    let object = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: handle(parent),
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        ..Default::default()
    };
    let mut ios = IO_STATUS_BLOCK::default();
    let mut raw = ptr::null_mut();
    let access = if directory {
        FILE_LIST_DIRECTORY
            | FILE_ADD_FILE
            | FILE_ADD_SUBDIRECTORY
            | FILE_READ_ATTRIBUTES
            | SYNCHRONIZE
    } else {
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE
    };
    assert_eq!(
        unsafe {
            NtCreateFile(
                &mut raw,
                access,
                &object,
                &mut ios,
                ptr::null(),
                if directory {
                    FILE_ATTRIBUTE_DIRECTORY
                } else {
                    FILE_ATTRIBUTE_NORMAL
                },
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_CREATE,
                FILE_OPEN_REPARSE_POINT
                    | FILE_SYNCHRONOUS_IO_NONALERT
                    | if directory {
                        FILE_DIRECTORY_FILE
                    } else {
                        FILE_NON_DIRECTORY_FILE
                    },
                ptr::null(),
                0,
            )
        },
        0
    );
    assert!(!raw.is_null());
    unsafe { File::from_raw_handle(raw) }
}
#[test]
fn actual_ntfs_unpaired_leaf_is_listed_opened_and_keeps_full128_without_string() {
    let temp = tempfile::tempdir().unwrap();
    let writer = write_parent(temp.path());
    let raw = vec![97, 0xd800, 98];
    let mut made = create_owned(&writer, &raw, false);
    let bytes: Vec<u8> = (0..=255).cycle().take(300).collect();
    made.write_all(&bytes).unwrap();
    made.sync_all().unwrap();
    drop(made);
    let pin = root(temp.path());
    let cancel = AtomicBool::new(false);
    let listing = pin.entries(8, &cancel).unwrap();
    assert_eq!(listing.len(), 1);
    assert!(listing.contains_key(&raw));
    let child = pin.child(&raw, &listing[&raw], &cancel).unwrap();
    assert_eq!(child.identity(), &listing[&raw].identity);
    assert!(!child.full_security_purpose());
    assert_eq!(child.opening_metadata().kind, MetadataKind::File);
    assert_eq!(child.inner.guid.volume, pin.inner.guid.volume);
    let actual: FILE_ID_INFO = info(child.file(), FileIdInfo).unwrap();
    assert_eq!(child.identity().device, actual.VolumeSerialNumber);
    assert_eq!(
        child.identity().inode,
        u128::from_le_bytes(actual.FileId.Identifier)
    );
    let mut view = child.file();
    let mut actual = Vec::new();
    std::io::Read::read_to_end(&mut view, &mut actual).unwrap();
    assert_eq!(actual, bytes);
    child.verify().unwrap();
    pin.verify().unwrap();
    drop((child, pin, writer));
    temp.close().unwrap();
}
#[test]
fn same_fullid_cached_metadata_drift_is_not_a_false_version_but_wrong_id_refuses() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("ordinary.bin"), b"owned-data").unwrap();
    let pin = root(temp.path());
    let cancel = AtomicBool::new(false);
    let raw: Vec<u16> = "ordinary.bin".encode_utf16().collect();
    let listing = pin.entries(8, &cancel).unwrap();
    let mut stale = listing[&raw].clone();
    stale.changed = 1;
    stale.modified = 2;
    stale.size += 1; // directory cache is not actual version authority.
    let child = pin.child(&raw, &stale, &cancel).unwrap();
    let current = metadata_file(child.file()).unwrap();
    assert_eq!(child.opening_metadata(), &current);
    let mut wrong = listing[&raw].clone();
    wrong.identity.inode ^= 1u128 << 100;
    assert!(matches!(
        pin.child(&raw, &wrong, &cancel),
        Err(Failure::Changed)
    ));
    let mut forbidden = listing[&raw].clone();
    forbidden.attributes |= FILE_ATTRIBUTE_REPARSE_POINT;
    assert!(matches!(
        pin.child(&raw, &forbidden, &cancel),
        Err(Failure::Unsupported)
    ));
    drop((child, pin));
    temp.close().unwrap();
}
#[test]
fn root_and_child_arc_aliases_share_actual_cursor_owner_and_multipage_restart() {
    let temp = tempfile::tempdir().unwrap();
    let writer = write_parent(temp.path());
    let raw = vec![100, 0xdc00];
    let dir = create_owned(&writer, &raw, true);
    for n in 0..512 {
        let name: Vec<u16> = format!("item-{n:04}-{}", "x".repeat(112))
            .encode_utf16()
            .collect();
        drop(create_owned(&dir, &name, false));
    }
    drop(dir);
    let pin = root(temp.path());
    let alias = pin.clone();
    if let Resource::Root(original) = &pin.inner.resource {
        let held = original.directory_scan().unwrap();
        assert!(matches!(
            alias.try_observation_owner(),
            Err(TryLockError::WouldBlock)
        ));
        drop(held);
    } else {
        panic!("root resource required");
    }
    let cancel = AtomicBool::new(false);
    let list = pin.entries(8, &cancel).unwrap();
    let child = pin.child(&raw, &list[&raw], &cancel).unwrap();
    let same = child.clone();
    let held = child.directory_scan().unwrap();
    assert!(matches!(
        same.try_observation_owner(),
        Err(TryLockError::WouldBlock)
    ));
    drop(held);
    let first = child.entries(512, &cancel).unwrap();
    assert_eq!(first.len(), 512);
    assert_eq!(same.entries(512, &cancel).unwrap(), first);
    assert_eq!(child.entries(512, &cancel).unwrap(), first);
    let corrupt_owner = same.clone();
    assert!(
        std::thread::spawn(move || {
            let _held = corrupt_owner.directory_scan().unwrap();
            panic!("controlled cursor-owner poison");
        })
        .join()
        .is_err()
    );
    assert!(matches!(
        child.entries(512, &cancel),
        Err(crate::file_access::DirectoryFailure::Io {
            phase: "scanLock",
            ..
        })
    ));
    drop((child, same, alias, pin, writer));
    temp.close().unwrap();
}
#[test]
fn invalid_cancelled_and_missing_do_not_become_a_new_source_capability() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("one"), b"one").unwrap();
    let pin = root(temp.path());
    let cancel = AtomicBool::new(false);
    let raw: Vec<u16> = "one".encode_utf16().collect();
    let listing = pin.entries(8, &cancel).unwrap();
    let expected = &listing[&raw];
    assert!(matches!(
        pin.child(&[0], expected, &cancel),
        Err(Failure::Name(material_raw_name::Failure::Invalid))
    ));
    assert!(matches!(
        pin.child(&raw, expected, &AtomicBool::new(true)),
        Err(Failure::Cancelled)
    ));
    let absent: Vec<u16> = "absent-owned".encode_utf16().collect();
    match pin.child(&absent, expected, &cancel) {
        Err(Failure::Io {
            phase,
            code,
            nt_status,
            ..
        }) => {
            assert_eq!(phase, "rawMetadataOpen");
            assert_eq!(code, Some(2));
            assert_eq!(nt_status, Some(0xc0000034u32 as i32));
        }
        _ => panic!("exact missing leaf error expected, never a capability"),
    }
    let selected = PinnedPath::directory(&temp.path().canonicalize().unwrap()).unwrap();
    assert!(matches!(
        MaterialPin::root(selected, &Resident::new(0), &cancel),
        Err(Failure::Limit)
    ));
    pin.verify().unwrap();
    drop(pin);
    temp.close().unwrap();
}
#[test]
fn ancestor_namespace_cannot_be_replaced_until_last_raw_alias_releases_original_pins() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().join("parent");
    std::fs::create_dir(&parent).unwrap();
    std::fs::write(parent.join("leaf"), b"original").unwrap();
    let pin = root(&parent);
    let alias = pin.clone();
    let cancel = AtomicBool::new(false);
    let raw: Vec<u16> = "leaf".encode_utf16().collect();
    let listing = pin.entries(8, &cancel).unwrap();
    let child = pin.child(&raw, &listing[&raw], &cancel).unwrap();
    let moved = temp.path().join("moved");
    assert!(std::fs::rename(&parent, &moved).is_err());
    drop(pin);
    drop(child);
    assert!(std::fs::rename(&parent, &moved).is_err());
    drop(alias);
    std::fs::rename(&parent, &moved).unwrap();
    assert_eq!(std::fs::read(moved.join("leaf")).unwrap(), b"original");
    temp.close().unwrap();
}
#[test]
fn material_case_alias_listing_is_refused_by_real_os_ordinal_policy() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("Owned"), b"owned").unwrap();
    let pin = root(temp.path());
    let cancel = AtomicBool::new(false);
    let actual = pin.entries(8, &cancel).unwrap();
    let original: Vec<u16> = "Owned".encode_utf16().collect();
    let alternate: Vec<u16> = "OWNED".encode_utf16().collect();
    let mut ambiguous = actual.clone();
    ambiguous.insert(alternate, actual[&original].clone());
    // This is a controlled observation fixture, not a claim that this NTFS
    // directory was configured case-sensitive or returned two aliases itself.
    assert!(matches!(
        unique_names(&ambiguous, &resident(), &cancel),
        Err(crate::file_access::DirectoryFailure::Changed)
    ));
    assert!(unique_names(&actual, &resident(), &cancel).is_ok());
    drop(pin);
    temp.close().unwrap();
}
#[test]
#[ignore = "manual: current token already permits full SACL read; no privilege adjustment"]
fn full_security_root_child_retains_actual_security_access_without_ordinary_fallback() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("owned"), b"owned").unwrap();
    let selected =
        PinnedPath::directory_full_security(&temp.path().canonicalize().unwrap()).unwrap();
    let pin = MaterialPin::root(selected, &resident(), &AtomicBool::new(false)).unwrap();
    assert!(pin.full_security_purpose());
    let raw: Vec<u16> = "owned".encode_utf16().collect();
    let cancel = AtomicBool::new(false);
    let listing = pin.entries(8, &cancel).unwrap();
    let child = pin.child(&raw, &listing[&raw], &cancel).unwrap();
    assert!(child.full_security_purpose());
    let mut security = vec![0u64; 65536 / 8];
    let mut returned = 0;
    let ok = unsafe {
        GetKernelObjectSecurity(
            handle(child.file()),
            BACKUP_SECURITY_INFORMATION,
            security.as_mut_ptr().cast(),
            65536,
            &mut returned,
        )
    };
    assert_ne!(
        ok,
        0,
        "actual full security query required: {:?}",
        io::Error::last_os_error().raw_os_error()
    );
    assert!((20..=65536).contains(&returned));
    drop((child, pin));
    temp.close().unwrap();
}
