//! Real component consumer while public recovery/Manifest1 stays CLOSED.
//! Manual positives require existing token rights; no privilege adjustment/skip.
use super::{Slot, error};
use crate::file_access::{
    CarrierFailure, CarrierReceipt, CarrierRequest, CarrierRetirement, PinnedPath, stamp,
};
use std::{
    ffi::OsStr,
    fs::OpenOptions,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    sync::atomic::AtomicBool,
};
use windows_sys::{
    Wdk::Storage::FileSystem::NtSetEaFile,
    Win32::{
        Storage::FileSystem::{FILE_WRITE_EA, SYNCHRONIZE},
        System::IO::IO_STATUS_BLOCK,
    },
};
struct Fixture {
    directory: tempfile::TempDir,
    original_permissions: std::fs::Permissions,
}
impl Fixture {
    fn new(data: &[u8]) -> Self {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("owned.bin"), data).unwrap();
        let original_permissions = std::fs::metadata(directory.path().join("owned.bin"))
            .unwrap()
            .permissions();
        Self {
            directory,
            original_permissions,
        }
    }
    fn path(&self) -> std::path::PathBuf {
        self.directory.path().join("owned.bin")
    }
    fn request(&self) -> CarrierRequest {
        let canonical = self.directory.path().canonicalize().unwrap();
        // Failure is a real unavailable current-token condition, NOT success.
        let parent = PinnedPath::directory_full_security(&canonical).unwrap();
        let leaf: Vec<u16> = OsStr::new("owned.bin").encode_wide().collect();
        let child = parent.child(&leaf, false).unwrap();
        let identity = stamp(child.file()).unwrap().identity;
        drop(child);
        CarrierRequest::held_regular(parent, leaf, identity).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Own fixture only; preserve cleanup on a failing READONLY control.
        if self.path().exists()
            && std::fs::set_permissions(self.path(), self.original_permissions.clone()).is_err()
        {
            eprintln!("FARFOLD_OWNED_CARRIER_FIXTURE_CLEANUP_UNKNOWN");
        }
    }
}
fn run(request: CarrierRequest) -> CarrierReceipt {
    let slot = Slot::<CarrierRetirement>::default();
    let mut actual = None;
    slot.run(|retired| {
        actual = Some(crate::file_access::carrier_roundtrip(
            request,
            &AtomicBool::new(false),
            retired,
        ));
        match actual.as_ref().unwrap() {
            Ok(_) => Ok(()),
            Err(_) => Err(error("carrierFailed")),
        }
    })
    .unwrap();
    assert!(!slot.occupied());
    let receipt = actual.unwrap().unwrap();
    assert!(receipt.target_recaptured && receipt.owned_handles_closed_and_disposition_accepted);
    receipt
}
fn add_ea(fixture: &Fixture) {
    let file = OpenOptions::new()
        .access_mode(FILE_WRITE_EA | SYNCHRONIZE)
        .open(fixture.path())
        .unwrap();
    let value = b"\0\xffEA-owned";
    let name = b"OWNED";
    let mut record = vec![0u8; 8];
    record[5] = name.len() as u8;
    record[6..8].copy_from_slice(&(value.len() as u16).to_le_bytes());
    record.extend(name);
    record.push(0);
    record.extend(value);
    let mut ios = IO_STATUS_BLOCK::default();
    assert_eq!(
        unsafe {
            NtSetEaFile(
                file.as_raw_handle(),
                &mut ios,
                record.as_ptr().cast(),
                record.len() as u32,
            )
        },
        0
    );
}
#[test]
fn ordinary_read_capability_cannot_mint_full_security_restore_request() {
    let fixture = Fixture::new(b"source");
    let parent = PinnedPath::directory(&fixture.directory.path().canonicalize().unwrap()).unwrap();
    let leaf: Vec<u16> = "owned.bin".encode_utf16().collect();
    let identity = parent.child(&leaf, false).unwrap().identity().clone();
    assert!(matches!(
        CarrierRequest::held_regular(parent, leaf, identity),
        Err(CarrierFailure::Unsupported)
    ));
}
#[test]
#[ignore = "manual: current token must already permit full SACL read/write; no privilege changes"]
fn full_security_single_owned_node_has_actual_native_capture_write_recapture() {
    let bytes: Vec<u8> = (0..=255).cycle().take(300).collect();
    let fixture = Fixture::new(&bytes);
    std::fs::write(
        format!("{}:alpha:$DATA", fixture.path().display()),
        b"named\0one",
    )
    .unwrap();
    std::fs::write(
        format!("{}:\u{03a9}:$DATA", fixture.path().display()),
        b"named\xfftwo",
    )
    .unwrap();
    add_ea(&fixture);
    let receipt = run(fixture.request());
    assert_ne!(receipt.source, receipt.target);
    assert_eq!(receipt.data_streams, 3);
    assert_eq!(receipt.ea_count, 1);
    assert!(receipt.carrier_bytes > 300);
    assert_ne!(receipt.carrier_sha256, [0; 32]);
    assert_ne!(receipt.full_security_sha256, [0; 32]);
    assert_eq!(std::fs::read(fixture.path()).unwrap(), bytes);
    assert_eq!(
        std::fs::read(format!("{}:alpha:$DATA", fixture.path().display())).unwrap(),
        b"named\0one"
    );
    assert_eq!(
        std::fs::read(format!("{}:\u{03a9}:$DATA", fixture.path().display())).unwrap(),
        b"named\xfftwo"
    );
}
#[test]
#[ignore = "manual: current token must already permit full SACL read/write; no privilege changes"]
fn empty_default_readonly_owned_file_roundtrips_without_padding() {
    let fixture = Fixture::new(&[]);
    let mut permissions = std::fs::metadata(fixture.path()).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(fixture.path(), permissions).unwrap();
    let receipt = run(fixture.request());
    assert_eq!(receipt.data_streams, 1);
    assert!(receipt.carrier_bytes > 20);
    assert!(
        std::fs::metadata(fixture.path())
            .unwrap()
            .permissions()
            .readonly()
    );
}
#[test]
#[ignore = "manual: current token must already permit full SACL read; no privilege changes"]
fn source_full128_mismatch_rejects_before_creating_target() {
    let fixture = Fixture::new(b"source");
    let parent =
        PinnedPath::directory_full_security(&fixture.directory.path().canonicalize().unwrap())
            .unwrap();
    let leaf: Vec<u16> = "owned.bin".encode_utf16().collect();
    let mut identity = parent.child(&leaf, false).unwrap().identity().clone();
    identity.inode ^= 1u128 << 100;
    let request = CarrierRequest::held_regular(parent, leaf, identity).unwrap();
    let mut retired = None;
    assert!(matches!(
        crate::file_access::carrier_roundtrip(request, &AtomicBool::new(false), &mut retired),
        Err(CarrierFailure::Changed)
    ));
    assert!(retired.is_none());
    assert_eq!(std::fs::read(fixture.path()).unwrap(), b"source");
}
#[test]
#[ignore = "manual: current token must already permit full SACL read; no privilege changes"]
fn hardlinked_source_is_not_silently_flattened_into_single_node_profile() {
    let fixture = Fixture::new(b"source");
    std::fs::hard_link(fixture.path(), fixture.directory.path().join("second.bin")).unwrap();
    let mut retired = None;
    assert!(matches!(
        crate::file_access::carrier_roundtrip(
            fixture.request(),
            &AtomicBool::new(false),
            &mut retired
        ),
        Err(CarrierFailure::Unsupported)
    ));
    assert!(retired.is_none());
    assert_eq!(
        std::fs::read(fixture.directory.path().join("second.bin")).unwrap(),
        b"source"
    );
}
