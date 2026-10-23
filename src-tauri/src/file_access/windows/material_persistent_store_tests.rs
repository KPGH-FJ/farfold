//! Real fixed-file IO over synthetic typed framing. No SD/BackupRead success claim.
use super::*;
use crate::file_access::{material_carrier_fragment as regular, material_directory_facet as facet};
use std::io::Cursor;

// This intentionally uses synthetic native bytes. The ordinary controls prove
// retained-file framing/identity/noReplace behavior only; FullSD capture controls
// live in the worktrees consumer and use the actual Mixed producer.
pub(super) fn bytes() -> Vec<u8> {
    let resident = Resident::new(records::RESIDENT_LIMIT);
    let cancel = AtomicBool::new(false);
    let mut work = WorkBudget::new(records::WORK_LIMIT);
    let mut output = Vec::new();
    let mut writer = tree::Writer::begin(&mut output, 2, &mut work, &cancel, &resident).unwrap();
    for (kind, parent, id, name) in [
        (tree::Kind::Directory, tree::ROOT, 1u128 << 100, vec![82]),
        (tree::Kind::Regular, 0, (1u128 << 100) + 1, vec![65, 0xd800]),
    ] {
        let payload = [37u8; 20];
        let hash: [u8; 32] = Sha256::digest(payload).into();
        let mut typed = Vec::new();
        let digest = match kind {
            tree::Kind::Directory => {
                facet::append(
                    &mut Cursor::new(payload),
                    &mut typed,
                    &facet::Metadata {
                        security_full: true,
                        raw_leaf: name,
                        source_volume: 7,
                        source_id: id,
                        created: 1,
                        accessed: 2,
                        modified: 3,
                        attributes: FILE_ATTRIBUTE_DIRECTORY,
                    },
                    &facet::NativeExtent {
                        bytes: 20,
                        sha256: hash,
                    },
                    &mut work,
                    &cancel,
                    &resident,
                )
                .unwrap();
                facet::verify_exact(&mut Cursor::new(&typed), &mut work, &cancel, &resident)
                    .unwrap()
                    .record_sha256
            }
            tree::Kind::Regular => {
                regular::append(
                    &mut Cursor::new(payload),
                    &mut typed,
                    &regular::Metadata {
                        raw_leaf: name,
                        source_volume: 7,
                        source_id: id,
                        created: 1,
                        accessed: 2,
                        modified: 3,
                        attributes: FILE_ATTRIBUTE_ARCHIVE,
                    },
                    &regular::NativeExtent {
                        bytes: 20,
                        sha256: hash,
                    },
                    &mut work,
                    &cancel,
                    &resident,
                )
                .unwrap();
                regular::verify_exact(&mut Cursor::new(&typed), &mut work, &cancel, &resident)
                    .unwrap()
                    .record_sha256
            }
        };
        writer
            .append(
                tree::Entry { kind, parent },
                &mut Cursor::new(&typed),
                typed.len() as u64,
                digest,
                &mut work,
                &cancel,
            )
            .unwrap();
    }
    writer.finish(&mut work, &cancel).unwrap();
    output
}

pub(super) struct Fixture {
    pub(super) store: Store,
    pub(super) root: std::path::PathBuf,
    _temp: tempfile::TempDir,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap();
        let root = parent.join("reserved-operation");
        std::fs::create_dir(&root).unwrap();
        Self::in_reserved_directory(temp, root)
    }
    fn in_reserved_directory(temp: tempfile::TempDir, root: std::path::PathBuf) -> Self {
        let parent = root.parent().unwrap();
        let parent_pin = PinnedPath::directory(parent).unwrap();
        let root_pin = parent_pin
            .child(
                &"reserved-operation".encode_utf16().collect::<Vec<_>>(),
                true,
            )
            .unwrap();
        let mut fs = [0u16; 32];
        assert_ne!(
            unsafe {
                GetVolumeInformationByHandleW(
                    handle(root_pin.file()),
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
        assert_eq!(
            String::from_utf16(&fs[..fs.iter().position(|v| *v == 0).unwrap()]).unwrap(),
            "NTFS"
        );
        let request = MaterialStoreRequest::reserved(
            parent,
            &root,
            parent_pin.identity(),
            root_pin.identity(),
            &MixedMemory::default(),
        )
        .unwrap();
        drop(root_pin);
        drop(parent_pin);
        Self {
            store: Store {
                file: None,
                stopped: None,
                uncertain: false,
                mixed: None,
                verified: None,
                copied: None,
                published: false,
                reading: false,
                sealed_stamp: None,
                restore: None,
                request,
            },
            root,
            _temp: temp,
        }
    }
    pub(super) fn pending(&mut self, bytes: &[u8]) {
        let resident = &self.store.request.resident;
        let verified = tree::verify_exact(
            &mut Cursor::new(bytes),
            &mut WorkBudget::new(records::WORK_LIMIT),
            &AtomicBool::new(false),
            resident,
            same,
        )
        .unwrap();
        self.store.copied = Some(MixedBytes {
            content: crate::file_access::material_mixed_semantic::summarize(
                &verified.nodes,
                verified.nodes.len(),
                |index| verified.nodes[index].native_sha256,
                &mut WorkBudget::new(records::WORK_LIMIT),
                &AtomicBool::new(false),
            )
            .unwrap(),
            summary: super::super::material_mixed_tree_input::MixedSummary {
                nodes: 2,
                directories: 1,
                regulars: 1,
                carrier_bytes: bytes.len() as u64,
                carrier_sha256: verified.sha256,
                carrier_identity: self.store.request.root.identity().clone(),
            },
            whole_sha256: Sha256::digest(bytes).into(),
            native_catalog: None,
        });
        drop(verified);
        self.store.open(true).unwrap();
        self.store.file.as_mut().unwrap().write_all(bytes).unwrap();
        self.store.file.as_ref().unwrap().sync_all().unwrap();
    }
    pub(super) fn publish_reopen(&mut self) -> MaterialSealReceipt {
        self.store
            .verify(
                &mut WorkBudget::new(records::WORK_LIMIT),
                &AtomicBool::new(false),
            )
            .unwrap();
        self.store.publish().unwrap();
        self.store.close().unwrap();
        self.store.open(false).unwrap();
        self.store
            .verify(
                &mut WorkBudget::new(records::WORK_LIMIT),
                &AtomicBool::new(false),
            )
            .unwrap()
    }
}

#[test]
fn actual_material_publish_requires_creation_writer_handoff_and_keeps_original_pin() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().canonicalize().unwrap();
    let parent_pin = PinnedPath::directory(&parent).unwrap();
    let owner = super::super::worktree_checkout::WorktreeCheckout::<'static>::create_under(
        &parent_pin,
        "reserved-operation",
    )
    .unwrap();
    let identity = owner.root().identity().clone();
    let mut fixture = Fixture::in_reserved_directory(temp, parent.join("reserved-operation"));
    let payload = bytes();
    fixture.pending(&payload);
    fixture
        .store
        .verify(
            &mut WorkBudget::new(records::WORK_LIMIT),
            &AtomicBool::new(false),
        )
        .unwrap();
    // This is the original production failure, using the actual Nt rename.
    // No flag/permission relaxation or path-based substitute is involved.
    assert!(matches!(fixture.store.publish(), Err(Error::NtStatus {
        phase: "materialPublish", status
    }) if status as u32 == 0xc0000043));
    assert!(!fixture.store.published);
    assert_eq!(fixture.store.request.root.identity(), &identity);
    assert!(!fixture.root.join("material.bin").exists());
    let original = fixture.store.file.as_mut().unwrap();
    original.rewind().unwrap();
    let mut retained = Vec::new();
    original.read_to_end(&mut retained).unwrap();
    assert_eq!(retained, payload);
    fixture.store.dispose_pending().unwrap();
    assert!(!fixture.root.join(".material-pending").exists());

    // The test explicitly starts a new owned payload after the empty-directory
    // handoff. Production has no retry: it performs this handoff before writing.
    let pin = owner
        .into_reserved_directory(&AtomicBool::new(false))
        .unwrap();
    assert_eq!(pin.identity(), &identity);
    assert!(
        crate::file_access::same_object(pin.file(), fixture.store.request.root.file()).unwrap()
    );
    fixture.store.sealed_stamp = None;
    fixture.pending(&payload);
    let receipt = fixture.publish_reopen();
    assert!(fixture.store.published);
    assert_eq!(receipt.bytes, payload.len() as u64);
    assert_eq!(receipt.sha256, <[u8; 32]>::from(Sha256::digest(&payload)));
    assert_eq!(
        std::fs::read(fixture.root.join("material.bin")).unwrap(),
        payload
    );
    assert!(!fixture.root.join(".material-pending").exists());
    pin.verify().unwrap();
    parent_pin.verify().unwrap();
    assert_eq!(pin.identity(), &identity);
    drop(pin);
    drop(parent_pin);
}

#[test]
fn actual_fixed_file_survives_close_and_independent_reopen_without_memory_payload() {
    let mut fixture = Fixture::new();
    let payload = bytes();
    let expected: [u8; 32] = Sha256::digest(&payload).into();
    let length = payload.len();
    fixture.pending(&payload);
    drop(payload);
    let receipt = fixture.publish_reopen();
    assert_eq!(
        (receipt.nodes, receipt.directories, receipt.regulars),
        (2, 1, 1)
    );
    assert_eq!((receipt.bytes, receipt.sha256), (length as u64, expected));
    assert_ne!(receipt.identity.inode, 0);
    assert_eq!(
        receipt.identity.device,
        fixture.store.request.root.identity().device
    );
    let _memory = fixture
        .store
        .request
        .resident
        .lease(2 * records::BLOCK)
        .unwrap();
    let mut copied = Vec::with_capacity(records::BLOCK);
    let mut work = WorkBudget::new(records::WORK_LIMIT);
    let cancel = AtomicBool::new(false);
    let hash = OwnedSealedMaterial {
        store: &mut fixture.store,
        work: &mut work,
        cancel: &cancel,
    }
    .copy_node(1, &mut copied)
    .unwrap();
    assert!(copied.starts_with(b"FFNODE1\0"));
    assert_eq!(hash, <[u8; 32]>::from(Sha256::digest(&copied)));
    drop(copied);
    fixture.store.dispose_pending().unwrap();
    assert!(!fixture.root.join(".material-pending").exists());
    assert_eq!(
        <[u8; 32]>::from(Sha256::digest(
            std::fs::read(fixture.root.join("material.bin")).unwrap()
        )),
        expected
    );
}

#[test]
fn actual_no_replace_collision_preserves_sentinel_and_discards_only_owned_pending() {
    let mut fixture = Fixture::new();
    let sentinel = b"original-material-sentinel";
    std::fs::write(fixture.root.join("material.bin"), sentinel).unwrap();
    fixture.pending(&bytes());
    assert!(matches!(fixture.store.publish(), Err(Error::NtStatus {
        phase: "materialPublish", status
    }) if status as u32 == 0xc0000035));
    assert!(!fixture.store.published);
    fixture.store.dispose_pending().unwrap();
    assert_eq!(
        std::fs::read(fixture.root.join("material.bin")).unwrap(),
        sentinel
    );
    assert!(!fixture.root.join(".material-pending").exists());
}

#[test]
fn actual_truncation_corruption_suffix_and_wrong_whole_hash_refuse_before_publish() {
    for variant in 0..4 {
        let mut fixture = Fixture::new();
        fixture.pending(&bytes());
        let file = fixture.store.file.as_mut().unwrap();
        match variant {
            0 => file.set_len(10).unwrap(),
            1 => {
                file.seek(SeekFrom::Start(32)).unwrap();
                file.write_all(&[255]).unwrap();
            }
            2 => {
                file.seek(SeekFrom::End(0)).unwrap();
                file.write_all(&[0]).unwrap();
            }
            3 => fixture.store.copied.as_mut().unwrap().whole_sha256[0] ^= 1,
            _ => unreachable!(),
        }
        assert!(
            fixture
                .store
                .verify(
                    &mut WorkBudget::new(records::WORK_LIMIT),
                    &AtomicBool::new(false)
                )
                .is_err()
        );
        assert!(!fixture.store.published);
        fixture.store.dispose_pending().unwrap();
        assert!(!fixture.root.join("material.bin").exists());
        assert!(!fixture.root.join(".material-pending").exists());
    }
}

#[test]
fn cancelled_and_exhausted_verification_never_publish_or_leave_pending() {
    for (cancel, limit, wanted) in [
        (true, records::WORK_LIMIT, Error::Cancelled),
        (false, 0, Error::Limit),
    ] {
        let mut fixture = Fixture::new();
        fixture.pending(&bytes());
        assert_eq!(
            fixture
                .store
                .verify(&mut WorkBudget::new(limit), &AtomicBool::new(cancel))
                .unwrap_err(),
            wanted
        );
        fixture.store.dispose_pending().unwrap();
        assert!(!fixture.root.join("material.bin").exists());
        assert!(!fixture.root.join(".material-pending").exists());
    }
}

#[test]
fn reader_pins_real_file_and_full_version_rejects_actual_write_attributes_change() {
    use std::{
        fs::{FileTimes, OpenOptions},
        os::windows::fs::OpenOptionsExt,
        time::Duration,
    };
    let mut fixture = Fixture::new();
    fixture.pending(&bytes());
    let receipt = fixture.publish_reopen();
    let path = fixture.root.join("material.bin");
    let rejected = OpenOptions::new()
        .write(true)
        .share_mode(7)
        .open(&path)
        .unwrap_err();
    assert_eq!(rejected.raw_os_error(), Some(32));
    // READ-only sharing does permit independent write-attributes handles. Their
    // real version change must be caught, rather than called immutable.
    let attributes = OpenOptions::new()
        .access_mode(FILE_WRITE_ATTRIBUTES)
        .share_mode(7)
        .open(&path)
        .unwrap();
    let modified = attributes.metadata().unwrap().modified().unwrap() + Duration::from_secs(60);
    attributes
        .set_times(FileTimes::new().set_modified(modified))
        .unwrap();
    drop(attributes);
    assert_ne!(
        stamp(fixture.store.file.as_ref().unwrap()).unwrap(),
        receipt.stamp
    );
    assert_eq!(
        fixture
            .store
            .verify(
                &mut WorkBudget::new(records::WORK_LIMIT),
                &AtomicBool::new(false)
            )
            .unwrap_err(),
        Error::Changed
    );
    fixture.store.dispose_pending().unwrap();
    assert!(path.is_file());
}
