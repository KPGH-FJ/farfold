//! Two actual regular byte consumers, not persistent tree/alias recovery.
use super::{Slot, error};
use crate::file_access::{
    CarrierFailure as E, EaWorkBudget as WorkBudget, PinnedPath, RegularSharedMemory,
    RegularSharedReceipt, RegularSharedRequest, RegularSharedRetirement, regular_shared_capture,
};
use std::{
    ffi::OsString,
    os::windows::{ffi::OsStringExt, io::AsRawHandle},
    path::PathBuf,
    sync::atomic::AtomicBool,
};
struct Fixture {
    dir: tempfile::TempDir,
    leaves: [Vec<u16>; 2],
    paths: [PathBuf; 2],
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let leaves = [
            "one.bin".encode_utf16().collect::<Vec<_>>(),
            vec![116, 119, 111, 0xd800, 46, 98, 105, 110],
        ];
        let paths = [
            dir.path().join(OsString::from_wide(&leaves[0])),
            dir.path().join(OsString::from_wide(&leaves[1])),
        ];
        std::fs::write(&paths[0], b"first-source").unwrap();
        std::fs::write(&paths[1], b"second\0source\xff").unwrap();
        Self { dir, leaves, paths }
    }
    fn request(&self, full: bool, memory: &RegularSharedMemory) -> Result<RegularSharedRequest, E> {
        let path = self.dir.path().canonicalize().unwrap();
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
        RegularSharedRequest::held(pin, self.leaves.clone(), memory, &AtomicBool::new(false))
    }
    fn preserved(&self) {
        assert_eq!(std::fs::read(&self.paths[0]).unwrap(), b"first-source");
        assert_eq!(
            std::fs::read(&self.paths[1]).unwrap(),
            b"second\0source\xff"
        );
    }
}
fn run(request: RegularSharedRequest, work: u64) -> Result<RegularSharedReceipt, E> {
    let slot = Slot::<RegularSharedRetirement>::default();
    let mut value = None;
    let outer = slot.run(|retired| {
        value = Some(regular_shared_capture(
            request,
            &mut WorkBudget::new(work),
            &AtomicBool::new(false),
            retired,
        ));
        match value.as_ref().unwrap() {
            Ok(_) => Ok(()),
            Err(_) => Err(error("sharedCaptureFailed")),
        }
    });
    assert!(
        !slot.occupied(),
        "unknown read/namespace cleanup must remain a failed occupied owner"
    );
    match value {
        Some(v) => v,
        None => panic!("Slot refused {outer:?}"),
    }
}
#[test]
fn ordinary_parent_cannot_mint_two_full_security_shared_capture_sources() {
    let f = Fixture::new();
    assert!(matches!(
        f.request(false, &RegularSharedMemory::default()),
        Err(E::Unsupported)
    ));
    f.preserved();
}
#[test]
#[ignore = "manual: full security read permission must already be present; no adjustment or PayloadOnly fallback"]
fn two_regular_sources_share_actual_spool_pool_budget_and_consume_complete_ffnode_bytes() {
    let f = Fixture::new();
    let r = run(
        f.request(true, &RegularSharedMemory::default()).unwrap(),
        crate::file_access::SHAPE_WORK_LIMIT,
    )
    .unwrap();
    assert_ne!(r.sources[0], r.sources[1]);
    assert_ne!(r.carrier_identity.inode, 0);
    assert!(r.budget_before > r.after_first && r.after_first > r.after_second);
    assert!(r.native_bytes.iter().all(|v| *v > 20));
    assert!(r.native_sha256.iter().all(|v| *v != [0; 32]));
    assert!(r.typed_sha256.iter().all(|v| *v != [0; 32]));
    assert_ne!(r.native_sha256[0], r.native_sha256[1]);
    assert!(r.owned_carriers_closed);
    f.preserved();
}
#[test]
#[ignore = "manual: full security source handles must already be available; no permission fallback"]
fn shared_zero_work_is_not_replaced_by_a_fresh_per_node_budget() {
    let f = Fixture::new();
    assert!(matches!(
        run(f.request(true, &RegularSharedMemory::default()).unwrap(), 0),
        Err(E::Limit)
    ));
    f.preserved();
}
#[test]
#[ignore = "manual: full security source handles must already be available; aliases are unsupported, never flattened"]
fn shared_capture_retains_the_original_links_one_guard_before_any_alias_success() {
    let f = Fixture::new();
    std::fs::remove_file(&f.paths[1]).unwrap();
    std::fs::hard_link(&f.paths[0], &f.paths[1]).unwrap();
    assert!(matches!(
        run(
            f.request(true, &RegularSharedMemory::default()).unwrap(),
            crate::file_access::SHAPE_WORK_LIMIT
        ),
        Err(E::Unsupported)
    ));
    assert_eq!(std::fs::read(&f.paths[0]).unwrap(), b"first-source");
    assert_eq!(std::fs::read(&f.paths[1]).unwrap(), b"first-source");
}
