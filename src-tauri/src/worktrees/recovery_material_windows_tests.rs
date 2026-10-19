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
