//! Owned-only retained artifact controls. FullSD requests are explicit/manual.
use super::*;
use crate::{
    file_access::{CarrierFailure as E, MixedRequest, PinnedPath},
    worktrees::material_owner::Owner,
};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::OpenOptions,
    io::Cursor,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::OpenOptionsExt,
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

struct Fixture {
    temp: tempfile::TempDir,
    source: PathBuf,
    destination: PathBuf,
    file: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let source = base.join("source");
        let destination = base.join("reserved-operation");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&destination).unwrap();
        let file = source.join(OsString::from_wide(&[65, 0xd800, 66]));
        std::fs::write(&file, b"actual-default-data\0\xff").unwrap();
        Self {
            temp,
            source,
            destination,
            file,
        }
    }
    fn source(&self, memory: &MixedMemory, full: bool) -> std::result::Result<MixedRequest, E> {
        let pin = if full {
            PinnedPath::directory_full_security(&self.source).unwrap()
        } else {
            PinnedPath::directory(&self.source).unwrap()
        };
        let mut fs = [0u16; 32];
        assert_ne!(
            unsafe {
                windows_sys::Win32::Storage::FileSystem::GetVolumeInformationByHandleW(
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
            String::from_utf16(&fs[..fs.iter().position(|v| *v == 0).unwrap()]).unwrap(),
            "NTFS"
        );
        MixedRequest::held(
            pin,
            self.source.file_name().unwrap().encode_wide().collect(),
            memory,
            &AtomicBool::new(false),
        )
    }
    fn destination(&self, memory: &MixedMemory) -> MaterialStoreRequest {
        let parent = self.destination.parent().unwrap();
        let p = PinnedPath::directory(parent).unwrap();
        let d = p
            .child(
                &"reserved-operation".encode_utf16().collect::<Vec<_>>(),
                true,
            )
            .unwrap();
        let ps = inspect::pinned_stamp(&p).unwrap();
        let ds = inspect::pinned_stamp(&d).unwrap();
        reserved(parent, &self.destination, &ps, &ds, memory).unwrap()
    }
    fn preserved(&self) {
        assert_eq!(
            std::fs::read(&self.file).unwrap(),
            b"actual-default-data\0\xff"
        );
    }
}
fn ea_ads(path: &Path) {
    use windows_sys::{
        Wdk::Storage::FileSystem::NtSetEaFile,
        Win32::{
            Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_WRITE_EA,
                SYNCHRONIZE,
            },
            System::IO::IO_STATUS_BLOCK,
        },
    };
    let file = OpenOptions::new()
        .access_mode(FILE_WRITE_EA | SYNCHRONIZE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .unwrap();
    let mut bytes = vec![0u8; 8];
    bytes[5] = 1;
    bytes[6..8].copy_from_slice(&2u16.to_le_bytes());
    bytes.extend(b"X\0\0\xff");
    let mut ios = IO_STATUS_BLOCK::default();
    assert_eq!(
        unsafe {
            NtSetEaFile(
                file.as_raw_handle(),
                &mut ios,
                bytes.as_ptr().cast(),
                bytes.len() as u32,
            )
        },
        0
    );
    drop(file);
    let mut ads = path.as_os_str().to_os_string();
    ads.push(":retained:$DATA");
    std::fs::write(PathBuf::from(ads), b"actual-ads\0\xff").unwrap();
}

#[test]
fn ordinary_source_and_foreign_reserved_stamp_never_gain_full_material_authority() {
    let f = Fixture::new();
    let memory = MixedMemory::default();
    assert!(matches!(f.source(&memory, false), Err(E::Unsupported)));
    let foreign: inspect::Stamp =
        serde_json::from_value(serde_json::json!({"dev":1,"ino":2})).unwrap();
    assert!(
        reserved(
            f.destination.parent().unwrap(),
            &f.destination,
            &foreign,
            &foreign,
            &memory
        )
        .is_err()
    );
    assert!(!f.destination.join("material.bin").exists());
    f.preserved();
}

#[test]
#[ignore = "manual: explicit combined FullSecurity access on every owned source is required; no privilege adjustment/fallback"]
fn actual_mixed_bytes_remain_readable_after_sources_close_and_owned_source_is_removed() {
    let f = Fixture::new();
    ea_ads(&f.source);
    ea_ads(&f.file);
    let memory = MixedMemory::default();
    let source = f.source(&memory, true).unwrap();
    let destination = f.destination(&memory);
    let owner = Owner::default();
    let (_, receipt) = owner
        .sealed_material(source, destination, &AtomicBool::new(false), |sealed| {
            assert!(
                owner.available().is_err(),
                "same original Slot remains reserved through the persistent consumer"
            );
            let before = sealed.verify()?;
            assert_eq!(
                (before.nodes, before.directories, before.regulars),
                (2, 1, 1)
            );
            // A real rename+remove after capture proves the original source handles
            // have closed. Subsequent reads cannot fall back to that source tree.
            let gone = f.source.with_file_name("removed-owned-source");
            std::fs::rename(&f.source, &gone).unwrap();
            std::fs::remove_dir_all(gone).unwrap();
            assert!(!f.source.exists());
            let _memory = sealed.reserve_output(2 * 65536)?;
            let mut typed = vec![0u8; 65536];
            for index in 0..2 {
                let (hash, n) = {
                    let mut output = Cursor::new(typed.as_mut_slice());
                    let hash = sealed.copy_node(index, &mut output)?;
                    (hash, output.position() as usize)
                };
                assert!(typed[..n].starts_with(if index == 0 {
                    b"FFDIR1\0\0"
                } else {
                    b"FFNODE1\0"
                }));
                assert_eq!(hash, <[u8; 32]>::from(Sha256::digest(&typed[..n])));
            }
            assert_eq!(sealed.verify()?, before);
            Ok(())
        })
        .unwrap();
    owner.available().unwrap();
    assert!(!owner.occupied());
    let path = f.destination.join("material.bin");
    assert!(
        receipt.bytes <= 4 * 65536,
        "bounded owned fixture, not an arbitrary material read"
    );
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(bytes.len() as u64, receipt.bytes);
    assert_eq!(<[u8; 32]>::from(Sha256::digest(bytes)), receipt.sha256);
    assert!(!f.destination.join(".material-pending").exists());
    f.temp.close().unwrap();
}

#[test]
#[ignore = "manual: FullSecurity read access required; a managed root.git role proof is intentionally not yet supplied"]
fn root_git_edge_and_existing_final_refuse_without_copying_or_replacing() {
    for git_edge in [false, true] {
        let f = Fixture::new();
        let sentinel = b"preexisting-material";
        if git_edge {
            std::fs::write(f.source.join(".git"), b"owned-admin-edge-control").unwrap();
        } else {
            std::fs::write(f.destination.join("material.bin"), sentinel).unwrap();
        }
        let memory = MixedMemory::default();
        let owner = Owner::default();
        let result = owner.sealed_material(
            f.source(&memory, true).unwrap(),
            f.destination(&memory),
            &AtomicBool::new(false),
            |_| -> std::result::Result<(), E> {
                panic!("refused input must not reach the consumer")
            },
        );
        assert!(result.is_err());
        owner.available().unwrap();
        assert!(!owner.occupied());
        assert!(!f.destination.join(".material-pending").exists());
        if git_edge {
            assert!(!f.destination.join("material.bin").exists());
            assert_eq!(
                std::fs::read(f.source.join(".git")).unwrap(),
                b"owned-admin-edge-control"
            );
        } else {
            assert_eq!(
                std::fs::read(f.destination.join("material.bin")).unwrap(),
                sentinel
            );
        }
        f.preserved();
    }
}

#[test]
#[ignore = "manual: combined FullSecurity source condition; failure after publication never deletes retained material"]
fn callback_error_or_unwind_is_failure_and_leaves_published_actual_bytes_owned() {
    for unwind in [false, true] {
        let f = Fixture::new();
        let memory = MixedMemory::default();
        let owner = Owner::default();
        let result = owner.sealed_material(
            f.source(&memory, true).unwrap(),
            f.destination(&memory),
            &AtomicBool::new(false),
            |sealed| -> std::result::Result<(), E> {
                assert!(sealed.verify()?.bytes > 0);
                if unwind {
                    panic!("controlled retained consumer panic");
                }
                Err(E::Io {
                    phase: "controlledRetainedConsumer",
                    code: Some(42),
                })
            },
        );
        assert!(result.is_err());
        owner.available().unwrap();
        assert!(!owner.occupied());
        let bytes = std::fs::read(f.destination.join("material.bin")).unwrap();
        assert!(bytes.starts_with(b"FFMTREE1"));
        assert!(!f.destination.join(".material-pending").exists());
        f.preserved();
    }
}

// Rebuilding uses actual verified FFMTREE1/FFDIR1/FFNODE1 bytes. These controls
// need existing combined FullSecurity rights on the OWNED source and target.
// No privilege adjustment, permission fallback or synthetic native success.
fn assert_reconstructed(
    value: &crate::file_access::MaterialTreeReceipt,
    expected: (usize, usize, usize),
) {
    assert_eq!((value.nodes, value.directories, value.regulars), expected);
    assert_eq!(
        (value.write_aborts as usize, value.read_aborts as usize),
        (expected.0, expected.0)
    );
    assert!(value.exact_edges_verified && value.all_native_recaptured && value.metadata_finalized);
    assert_eq!(value.target_ids.len(), expected.0);
    for (index, id) in value.target_ids.iter().enumerate() {
        assert_ne!(id.inode, 0);
        assert!(!value.target_ids[..index].contains(id));
    }
}
#[test]
#[ignore = "manual: actual NTFS plus existing combined FullSecurity source/target rights; no privilege adjustment/fallback"]
fn sealed_actual_tree_reconstructs_raw_parent_edges_data_ea_ads_after_source_removal() {
    let f = Fixture::new();
    let sub = f.source.join(OsString::from_wide(&[68, 0xd801, 67]));
    std::fs::create_dir(&sub).unwrap();
    let child = sub.join(OsString::from_wide(&[67, 0xdc00, 68]));
    std::fs::write(&child, b"nested-default\0\xff").unwrap();
    for path in [&f.source, &sub, &f.file, &child] {
        ea_ads(path);
    }
    let source_ids = [
        (&f.source, true),
        (&sub, true),
        (&f.file, false),
        (&child, false),
    ]
    .into_iter()
    .map(|(path, directory)| {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE,
        };
        // The fixture deliberately owns raw, unpaired UTF-16 names. Read their
        // actual identities without broadening production user-path admission.
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES | SYNCHRONIZE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(path)
            .unwrap();
        let stamp = crate::file_access::stamp(&file).unwrap();
        assert_eq!(stamp.regular, !directory);
        stamp.identity
    })
    .collect::<Vec<_>>();
    let memory = MixedMemory::default();
    let owner = Owner::default();
    let (actual, seal) = owner
        .sealed_material(
            f.source(&memory, true).unwrap(),
            f.destination(&memory),
            &AtomicBool::new(false),
            |sealed| {
                assert!(owner.available().is_err());
                let before = sealed.verify()?;
                assert_eq!(
                    (before.nodes, before.directories, before.regulars),
                    (4, 2, 2)
                );
                let gone = f.source.with_file_name("removed-source-before-rebuild");
                std::fs::rename(&f.source, &gone).unwrap();
                std::fs::remove_dir_all(gone).unwrap();
                assert!(!f.source.exists());
                let result = sealed.reconstruct_tree()?;
                assert_reconstructed(&result, (4, 2, 2));
                assert!(result.target_ids.iter().all(|id| !source_ids.contains(id)));
                assert_eq!(sealed.verify()?, before);
                assert!(
                    owner.available().is_err(),
                    "target lifetime stays in the original Slot"
                );
                Ok(result)
            },
        )
        .unwrap();
    assert_reconstructed(&actual, (4, 2, 2));
    owner.available().unwrap();
    assert!(!owner.occupied());
    assert_eq!(
        <[u8; 32]>::from(Sha256::digest(
            std::fs::read(f.destination.join("material.bin")).unwrap()
        )),
        seal.sha256
    );
    assert!(!f.destination.join(".material-pending").exists());
    drop(actual);
    f.temp.close().unwrap();
}

#[test]
#[ignore = "manual: existing full-security source/target rights; no privilege adjustment"]
fn persisted_descriptor_reopens_with_new_owner_after_original_source_and_owner_drop() {
    let f = Fixture::new();
    ea_ads(&f.file);
    let memory = MixedMemory::default();
    let owner = Owner::default();
    let (descriptor, original) = owner
        .sealed_material(
            f.source(&memory, true).unwrap(),
            f.destination(&memory),
            &AtomicBool::new(false),
            |sealed| sealed.descriptor(),
        )
        .unwrap();
    let wire = serde_json::to_vec(&descriptor).unwrap();
    drop((descriptor, owner, memory));
    std::fs::remove_dir_all(&f.source).unwrap();
    let decoded: crate::worktrees::WindowsMaterial = serde_json::from_slice(&wire).unwrap();
    let fresh_owner = Owner::default();
    let fresh_memory = MixedMemory::default();
    let (restored, reopened) = fresh_owner
        .reopen_material(
            f.destination(&fresh_memory),
            &decoded,
            &AtomicBool::new(false),
            |sealed| {
                assert_eq!(sealed.descriptor()?, decoded);
                sealed.reconstruct_tree()
            },
        )
        .unwrap();
    assert_eq!(reopened, original);
    assert_reconstructed(&restored, (2, 1, 1));
    fresh_owner.available().unwrap();
    assert!(!fresh_owner.occupied());
    assert!(!f.source.exists());
    assert_eq!(
        std::fs::read(f.destination.join("material.bin"))
            .unwrap()
            .len() as u64,
        original.bytes
    );
}

#[test]
#[ignore = "manual: actual complete source capture; cold reader must reject changed identity/digest/catalog"]
fn cold_descriptor_tamper_never_enters_consumer_or_removes_retained_material() {
    let f = Fixture::new();
    let memory = MixedMemory::default();
    let owner = Owner::default();
    let (descriptor, original) = owner
        .sealed_material(
            f.source(&memory, true).unwrap(),
            f.destination(&memory),
            &AtomicBool::new(false),
            |sealed| sealed.descriptor(),
        )
        .unwrap();
    drop((owner, memory));
    for mutation in 0..4 {
        let mut changed = descriptor.clone();
        match mutation {
            0 => changed.file_id[15] ^= 128,
            1 => changed.sha256[0] ^= 1,
            2 => changed.nodes[0].security.as_mut().unwrap().sha256[0] ^= 1,
            _ => changed.nodes[1].streams[0].bytes += 1,
        }
        let memory = MixedMemory::default();
        let owner = Owner::default();
        assert!(
            owner
                .reopen_material(
                    f.destination(&memory),
                    &changed,
                    &AtomicBool::new(false),
                    |_| -> std::result::Result<(), E> {
                        panic!("invalid stored material reached consumer")
                    }
                )
                .is_err()
        );
        owner.available().unwrap();
        assert!(!owner.occupied());
        assert_eq!(
            <[u8; 32]>::from(Sha256::digest(
                std::fs::read(f.destination.join("material.bin")).unwrap()
            )),
            original.sha256
        );
        f.preserved();
    }
}
struct RestoreReadonly {
    path: PathBuf,
    original: std::fs::Permissions,
}
impl RestoreReadonly {
    fn owned(path: &Path) -> Self {
        let original = std::fs::metadata(path).unwrap().permissions();
        let mut changed = original.clone();
        changed.set_readonly(true);
        std::fs::set_permissions(path, changed).unwrap();
        Self {
            path: path.to_owned(),
            original,
        }
    }
}
impl Drop for RestoreReadonly {
    fn drop(&mut self) {
        if std::fs::set_permissions(&self.path, self.original.clone()).is_err() {
            eprintln!("FARFOLD_OWNED_REBUILD_READONLY_FIXTURE_CLEANUP_UNKNOWN");
        }
    }
}
#[test]
#[ignore = "manual: combined FullSecurity condition; restrictive source DACL is owned-only and restored by its original WRITE_DAC handle"]
fn restored_readonly_and_restrictive_dacl_keep_original_target_delete_rights_until_cleanup() {
    let f = Fixture::new();
    ea_ads(&f.file);
    let readonly = RestoreReadonly::owned(&f.file);
    let parent_dacl = crate::file_access::security_test_fixture::OwnedDacl::directory(&f.source);
    // DELETE may also be granted through FILE_DELETE_CHILD (0x40) on the parent.
    // Both ACLs belong to this temporary fixture and retain restoration handles.
    parent_dacl.set("D:P(D;;0x00000040;;;WD)(A;;FA;;;WD)");
    let dacl = crate::file_access::security_test_fixture::OwnedDacl::new(&f.file);
    dacl.set("D:P(A;;FR;;;WD)");
    // Prove a new DELETE open really is denied; target cleanup must instead use
    // the rights granted on its original FileObject BEFORE restoring this SD.
    let denied = OpenOptions::new()
        .access_mode(windows_sys::Win32::Storage::FileSystem::DELETE)
        .open(&f.file)
        .unwrap_err();
    assert_eq!(denied.raw_os_error(), Some(5));
    let memory = MixedMemory::default();
    let owner = Owner::default();
    let result = owner.sealed_material(
        f.source(&memory, true).unwrap(),
        f.destination(&memory),
        &AtomicBool::new(false),
        |sealed| {
            let before = sealed.verify()?;
            let tree = sealed.reconstruct_tree()?;
            assert_reconstructed(&tree, (2, 1, 1));
            assert_eq!(sealed.verify()?, before);
            Ok(tree)
        },
    );
    dacl.restore();
    parent_dacl.restore();
    drop(readonly);
    let (tree, _) = result.unwrap();
    assert_reconstructed(&tree, (2, 1, 1));
    owner.available().unwrap();
    assert!(!owner.occupied());
    f.preserved();
}
#[test]
#[ignore = "manual: combined FullSecurity source/target rights; repeated rebuilding is refused without detaching the first targets"]
fn one_store_refuses_a_second_reconstruction_while_original_targets_remain_owned() {
    let f = Fixture::new();
    let memory = MixedMemory::default();
    let owner = Owner::default();
    let (_, seal) = owner
        .sealed_material(
            f.source(&memory, true).unwrap(),
            f.destination(&memory),
            &AtomicBool::new(false),
            |sealed| {
                let first = sealed.reconstruct_tree()?;
                assert_reconstructed(&first, (2, 1, 1));
                assert_eq!(sealed.reconstruct_tree().unwrap_err(), E::Invalid);
                assert!(owner.available().is_err());
                assert_eq!(sealed.verify()?.nodes, 2);
                Ok(())
            },
        )
        .unwrap();
    owner.available().unwrap();
    assert!(!owner.occupied());
    assert_eq!(
        <[u8; 32]>::from(Sha256::digest(
            std::fs::read(f.destination.join("material.bin")).unwrap()
        )),
        seal.sha256
    );
    f.preserved();
}
#[test]
#[ignore = "manual: combined FullSecurity source/target rights; controlled callback error/unwind remains failure after real target writes"]
fn callback_error_or_unwind_after_real_reconstruction_cleans_same_slot_and_keeps_material() {
    for unwind in [false, true] {
        let f = Fixture::new();
        let memory = MixedMemory::default();
        let owner = Owner::default();
        let result = owner.sealed_material(
            f.source(&memory, true).unwrap(),
            f.destination(&memory),
            &AtomicBool::new(false),
            |sealed| -> std::result::Result<(), E> {
                let actual = sealed.reconstruct_tree()?;
                assert_reconstructed(&actual, (2, 1, 1));
                assert!(owner.available().is_err());
                if unwind {
                    panic!("controlled failure after actual sealed reconstruction");
                }
                Err(E::Io {
                    phase: "controlledReconstructedConsumer",
                    code: Some(42),
                })
            },
        );
        assert!(result.is_err());
        owner.available().unwrap();
        assert!(!owner.occupied());
        assert!(
            std::fs::read(f.destination.join("material.bin"))
                .unwrap()
                .starts_with(b"FFMTREE1")
        );
        assert!(!f.destination.join(".material-pending").exists());
        f.preserved();
    }
}

#[test]
#[ignore = "manual: explicit combined FullSecurity access; persisted target must survive original Store and Owner release"]
fn cold_material_restores_an_absent_selected_target_and_retains_actual_files_after_release() {
    let f = Fixture::new();
    ea_ads(&f.source);
    ea_ads(&f.file);
    let memory = MixedMemory::default();
    let owner = Owner::default();
    let (descriptor, _) = owner
        .sealed_material(
            f.source(&memory, true).unwrap(),
            f.destination(&memory),
            &AtomicBool::new(false),
            |sealed| sealed.descriptor(),
        )
        .unwrap();
    let wire = serde_json::to_vec(&descriptor).unwrap();
    drop((owner, memory, descriptor));
    std::fs::remove_dir_all(&f.source).unwrap();
    let memory = MixedMemory::default();
    let owner = Owner::default();
    let descriptor = serde_json::from_slice(&wire).unwrap();
    let parent = f.destination.parent().unwrap();
    let pin = PinnedPath::directory(parent).unwrap();
    let target = crate::file_access::MaterialTargetRequest::new(
        parent,
        pin.identity(),
        "selected-target".encode_utf16().collect(),
        &memory,
    )
    .unwrap();
    let (tree, _) = owner
        .reopen_material(
            f.destination(&memory),
            &descriptor,
            &AtomicBool::new(false),
            |sealed| sealed.reconstruct_target(target),
        )
        .unwrap();
    assert_reconstructed(&tree, (2, 1, 1));
    assert!(tree.retained);
    owner.available().unwrap();
    drop((owner, memory, tree));
    let restored = parent.join("selected-target");
    let file = restored.join(f.file.file_name().unwrap());
    assert_eq!(std::fs::read(&file).unwrap(), b"actual-default-data\0\xff");
    let mut ads = file.as_os_str().to_os_string();
    ads.push(":retained:$DATA");
    assert_eq!(
        std::fs::read(PathBuf::from(ads)).unwrap(),
        b"actual-ads\0\xff"
    );
    assert_eq!(std::fs::read_dir(&restored).unwrap().count(), 1);
    assert!(f.destination.join("material.bin").exists());
    assert!(!f.source.exists());
    // A second operation cannot overwrite or adopt the already delivered root.
    let memory = MixedMemory::default();
    let owner = Owner::default();
    let target = crate::file_access::MaterialTargetRequest::new(
        parent,
        pin.identity(),
        "selected-target".encode_utf16().collect(),
        &memory,
    )
    .unwrap();
    assert!(
        owner
            .reopen_material(
                f.destination(&memory),
                &descriptor,
                &AtomicBool::new(false),
                |sealed| sealed.reconstruct_target(target),
            )
            .is_err()
    );
    owner.available().unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), b"actual-default-data\0\xff");
}
