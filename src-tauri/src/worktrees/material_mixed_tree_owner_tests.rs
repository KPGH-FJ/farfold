//! Prepared owned NTFS controls. FullSecurity cases are manual, no fallback.
use super::{Slot, error};
use crate::file_access::{
    CarrierFailure as E, EaWorkBudget as WorkBudget, MixedInput, MixedMemory, MixedRequest,
    MixedRetirement, MixedSummary, PinnedPath, with_mixed_tree_input,
};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::{FileTimes, OpenOptions},
    io::Cursor,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::OpenOptionsExt,
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};
fn request(path: &Path, full: bool) -> Result<MixedRequest, E> {
    let path = path.canonicalize().unwrap();
    let pin = if full {
        PinnedPath::directory_full_security(&path).unwrap()
    } else {
        PinnedPath::directory(&path).unwrap()
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
        path.file_name().unwrap().encode_wide().collect(),
        &MixedMemory::default(),
        &AtomicBool::new(false),
    )
}
macro_rules! run {
    ($request:expr,$work:expr,$cancel:expr,$consume:expr) => {{
        let slot = Slot::<MixedRetirement>::default();
        let mut value = None;
        let outer = slot.run(|retired| {
            value = Some(with_mixed_tree_input(
                $request,
                &mut WorkBudget::new($work),
                &AtomicBool::new($cancel),
                retired,
                $consume,
            ));
            match value.as_ref().unwrap() {
                Ok(_) => Ok(()),
                Err(_) => Err(error("mixedInputFailed")),
            }
        });
        assert!(
            !slot.occupied(),
            "unknown remains occupied failure, never input success"
        );
        match value {
            Some(v) => v,
            None => panic!("Slot rejected: {outer:?}"),
        }
    }};
}
fn seed(path: &Path) {
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
    ads.push(":mixed:$DATA");
    std::fs::write(PathBuf::from(ads), b"mixed-ads\0\xff").unwrap();
}
struct Fixture {
    dir: tempfile::TempDir,
    root: PathBuf,
    file: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("mixed-root");
        std::fs::create_dir(&root).unwrap();
        let child = root.join("child");
        std::fs::create_dir(&child).unwrap();
        let file = child.join(OsString::from_wide(&[0x61, 0xd800, 0x62]));
        std::fs::write(&file, b"actual-regular\0\xff").unwrap();
        seed(&root);
        seed(&child);
        seed(&file);
        Self { dir, root, file }
    }
    fn preserved(&self) {
        assert_eq!(std::fs::read(&self.file).unwrap(), b"actual-regular\0\xff");
        assert!(self.root.join("child").is_dir());
    }
}
#[test]
fn ordinary_purpose_is_not_upgraded_to_full_mixed_input() {
    let f = Fixture::new();
    assert!(matches!(request(&f.root, false), Err(E::Unsupported)));
    f.preserved();
}
#[test]
#[ignore = "manual: explicit FullSecurity read access must already be available on all source nodes, no adjustment/fallback"]
fn actual_mixed_carrier_retains_every_ffdir_and_ffnode_across_complete_callback() {
    let f = Fixture::new();
    let summary: MixedSummary = run!(
        request(&f.root, true).unwrap(),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
        |mut input: MixedInput<'_>| {
            let first = input.verify()?;
            assert_eq!((first.nodes, first.directories, first.regulars), (3, 2, 1));
            assert!(first.carrier_bytes > 0);
            assert_ne!(first.carrier_sha256, [0; 32]);
            assert_ne!(first.carrier_identity.inode, 0);
            let _memory = input.reserve_output(65536 + 4096)?;
            let mut copied = Vec::with_capacity(3);
            for index in 0..3 {
                let mut bytes = vec![0u8; 16384];
                let (hash, n) = {
                    let mut out = Cursor::new(bytes.as_mut_slice());
                    let hash = input.copy_node(index, &mut out)?;
                    (hash, out.position() as usize)
                };
                bytes.truncate(n);
                let actual: [u8; 32] = Sha256::digest(&bytes).into();
                assert_eq!(hash, actual);
                assert!(bytes.starts_with(if index < 2 {
                    b"FFDIR1\0\0"
                } else {
                    b"FFNODE1\0"
                }));
                copied.push(bytes);
            }
            let mut first_again = vec![0u8; 16384];
            let n = {
                let mut out = Cursor::new(first_again.as_mut_slice());
                input.copy_node(0, &mut out)?;
                out.position() as usize
            };
            first_again.truncate(n);
            assert_eq!(first_again, copied[0]);
            assert_eq!(input.verify()?, first);
            Ok(first)
        }
    )
    .unwrap();
    assert_eq!(summary.nodes, 3);
    f.preserved();
    f.dir.close().unwrap();
}

#[test]
#[ignore = "manual: combined FullSecurity source access required; original links1 rejects inside and outside aliases"]
fn real_inside_and_outside_links_are_not_cloned_as_independent_regular_material() {
    for inside in [false, true] {
        let f = Fixture::new();
        let alias = if inside {
            f.root.join("alias")
        } else {
            f.dir.path().join("outside-alias")
        };
        std::fs::hard_link(&f.file, &alias).unwrap();
        let result: Result<(), E> = run!(
            request(&f.root, true).unwrap(),
            crate::file_access::SHAPE_WORK_LIMIT,
            false,
            |_| panic!("linked source must refuse before callback")
        );
        assert!(matches!(result, Err(E::Unsupported)));
        f.preserved();
        assert_eq!(std::fs::read(alias).unwrap(), b"actual-regular\0\xff");
    }
}
#[test]
#[ignore = "manual: combined FullSecurity source precondition; actual owned write-attributes mutation must succeed"]
fn original_source_witness_must_reject_actual_change_after_consumer_before_cleanup() {
    let f = Fixture::new();
    let changed = std::fs::metadata(&f.file).unwrap().modified().unwrap() + Duration::from_secs(60);
    let writer = OpenOptions::new()
        .access_mode(windows_sys::Win32::Storage::FileSystem::FILE_WRITE_ATTRIBUTES)
        .share_mode(7)
        .open(&f.file)
        .unwrap();
    let result = run!(
        request(&f.root, true).unwrap(),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
        |mut input: MixedInput<'_>| {
            input.verify()?;
            writer
                .set_times(FileTimes::new().set_modified(changed))
                .unwrap();
            assert_eq!(writer.metadata().unwrap().modified().unwrap(), changed);
            Ok(())
        }
    );
    assert!(matches!(result, Err(E::Changed)));
    drop(writer);
    f.preserved();
}
#[test]
#[ignore = "manual: explicit FullSecurity request handles must already be available; no hidden fresh work/cancel downgrade"]
fn cancellation_and_exhausted_shared_work_never_invoke_a_mixed_consumer() {
    for (work, cancel, wanted) in [
        (0, false, E::Limit),
        (crate::file_access::SHAPE_WORK_LIMIT, true, E::Cancelled),
    ] {
        let f = Fixture::new();
        let result: Result<(), E> =
            run!(request(&f.root, true).unwrap(), work, cancel, |_| panic!(
                "not admitted"
            ));
        assert!(matches!(
            (&result, &wanted),
            (Err(E::Limit), E::Limit) | (Err(E::Cancelled), E::Cancelled)
        ));
        f.preserved();
    }
}

#[test]
#[ignore = "manual: combined FullSecurity source access must be available; consumer failure is never success"]
fn actual_consumer_error_and_unwind_preserve_failure_with_original_slot_cleanup() {
    for panic_consumer in [false, true] {
        let f = Fixture::new();
        let result: Result<(), E> = run!(
            request(&f.root, true).unwrap(),
            crate::file_access::SHAPE_WORK_LIMIT,
            false,
            |_| {
                if panic_consumer {
                    panic!("controlled owned consumer panic");
                }
                Err(E::Io {
                    phase: "controlledConsumer",
                    code: Some(42),
                })
            }
        );
        if panic_consumer {
            assert!(matches!(result, Err(E::Unsupported)));
        } else {
            assert!(matches!(
                result,
                Err(E::Io {
                    phase: "controlledConsumer",
                    code: Some(42)
                })
            ));
        }
        f.preserved();
    }
}
