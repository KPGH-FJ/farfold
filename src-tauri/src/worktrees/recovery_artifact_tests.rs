use super::*;
use std::fs;
#[test]
fn unix_identity_wire_stays_exact_and_foreign_full_ids_never_truncate_or_mix() {
    let unix = FileIdentity::Unix(UnixIdentity { dev: 9, ino: 17 });
    assert_eq!(
        serde_json::to_string(&unix).unwrap(),
        r#"{"dev":9,"ino":17}"#
    );
    assert_eq!(
        serde_json::from_str::<FileIdentity>(r#"{"dev":9,"ino":17}"#).unwrap(),
        unix
    );
    let a = FileIdentity::Windows(WindowsIdentity {
        windows: WindowsId {
            volume: 9u64.to_le_bytes(),
            file_id: 17u128.to_le_bytes(),
        },
    });
    let b = FileIdentity::Windows(WindowsIdentity {
        windows: WindowsId {
            volume: 9u64.to_le_bytes(),
            file_id: ((1u128 << 100) | 17).to_le_bytes(),
        },
    });
    assert_ne!(a, b);
    assert_ne!(a, unix);
    assert_eq!(
        serde_json::from_str::<FileIdentity>(&serde_json::to_string(&b).unwrap()).unwrap(),
        b
    );
    for raw in [
        r#"{"dev":9,"ino":17,"extra":0}"#,
        r#"{"dev":9,"dev":9,"ino":17}"#,
        r#"{"dev":9,"ino":17,"windows":{"volume":[],"fileId":[]}}"#,
        r#"{"windows":null}"#,
        r#"{"windows":{"volume":9,"fileId":17}}"#,
    ] {
        assert!(serde_json::from_str::<FileIdentity>(raw).is_err());
    }
}
struct Owned {
    _temp: tempfile::TempDir,
    parent: PathBuf,
    root: PathBuf,
    parent_stamp: inspect::Stamp,
    root_stamp: inspect::Stamp,
}
impl Owned {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap();
        let root = parent.join("owned-recovery");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("recovery.bundle"), b"controlled-bundle").unwrap();
        fs::write(root.join("manifest.json"), b"{\"controlled\":true}").unwrap();
        Self {
            parent_stamp: inspect::stamp(&parent).unwrap(),
            root_stamp: inspect::stamp(&root).unwrap(),
            parent,
            root,
            _temp: temp,
        }
    }
    fn open(&self) -> Artifacts {
        Artifacts::open(
            &self.root,
            &self.parent,
            &self.parent_stamp,
            &self.root_stamp,
            &AtomicBool::new(false),
        )
        .unwrap()
    }
}
#[test]
fn real_fixed_file_set_captures_current_ids_and_hashes_from_the_same_held_objects() {
    let own = Owned::new();
    let mut set = own.open();
    let cancel = AtomicBool::new(false);
    let first = set.observe(&cancel).unwrap();
    assert_eq!(first.bundle_bytes, 17);
    assert_eq!(
        first.bundle_sha256,
        material_scan::hex(Sha256::digest(b"controlled-bundle"))
    );
    assert_eq!(first.manifest_raw, b"{\"controlled\":true}");
    assert_eq!(
        first.manifest_sha256,
        material_scan::hex(Sha256::digest(&first.manifest_raw))
    );
    set.require_identities(&first.bundle_identity, &first.manifest_identity)
        .unwrap();
    assert!(set.observe(&cancel).unwrap() == first);
    assert!(
        set.require_identities(
            &FileIdentity::Windows(WindowsIdentity {
                windows: WindowsId {
                    volume: [0; 8],
                    file_id: [0; 16]
                }
            }),
            &first.manifest_identity
        )
        .is_err()
    );
}
fn expected(value: &Observation) -> Expected<'_> {
    Expected {
        bundle_identity: &value.bundle_identity,
        manifest_identity: &value.manifest_identity,
        bundle_bytes: value.bundle_bytes,
        bundle_sha256: &value.bundle_sha256,
        manifest_sha256: &value.manifest_sha256,
    }
}
#[test]
fn same_size_edit_never_becomes_verified_and_windows_pins_do_not_silently_widen_shares() {
    let own = Owned::new();
    let mut set = own.open();
    let cancel = AtomicBool::new(false);
    let before = set.observe(&cancel).unwrap();
    let path = own.root.join("recovery.bundle");
    #[cfg(unix)]
    {
        fs::write(&path, b"modified!!-bundle").unwrap();
        assert_eq!(
            set.read_verified(&expected(&before), &cancel)
                .err()
                .unwrap()
                .code,
            "recoveryChanged"
        );
    }
    #[cfg(windows)]
    {
        assert!(fs::write(&path, b"modified!!-bundle").is_err());
        assert!(set.read_verified(&expected(&before), &cancel).unwrap() == before);
    }
    drop(set);
    fs::write(&path, b"modified!!-bundle").unwrap();
    let mut fresh = own.open();
    assert_eq!(
        fresh
            .read_verified(&expected(&before), &cancel)
            .err()
            .unwrap()
            .code,
        "recoveryChanged"
    );
    let after = fresh.observe(&cancel).unwrap();
    assert_ne!(before.bundle_sha256, after.bundle_sha256);
}
#[test]
fn identical_bytes_at_a_replaced_name_are_rejected_by_the_stored_native_identity() {
    let own = Owned::new();
    let cancel = AtomicBool::new(false);
    let before = own.open().observe(&cancel).unwrap();
    let path = own.root.join("recovery.bundle");
    fs::rename(&path, own.root.join("old-bundle")).unwrap();
    fs::write(&path, b"controlled-bundle").unwrap();
    let mut set = own.open();
    let after = set.observe(&cancel).unwrap();
    assert_eq!(after.bundle_sha256, before.bundle_sha256);
    assert_eq!(
        set.require_identities(&before.bundle_identity, &before.manifest_identity)
            .err()
            .unwrap()
            .code,
        "recoveryChanged"
    );
}
#[test]
fn held_parent_root_pair_rejects_namespace_replacement_without_falling_back_to_a_path() {
    let own = Owned::new();
    let set = own.open();
    let moved = own.parent.join("moved");
    #[cfg(windows)]
    {
        assert!(fs::rename(&own.root, &moved).is_err());
        drop(set);
        fs::rename(&own.root, &moved).unwrap();
    }
    #[cfg(unix)]
    {
        let mut set = set;
        fs::rename(&own.root, &moved).unwrap();
        assert!(set.observe(&AtomicBool::new(false)).is_err());
        drop(set);
    }
    fs::create_dir(&own.root).unwrap();
    fs::write(own.root.join("recovery.bundle"), b"controlled-bundle").unwrap();
    fs::write(own.root.join("manifest.json"), b"{\"controlled\":true}").unwrap();
    assert!(
        Artifacts::open(
            &own.root,
            &own.parent,
            &own.parent_stamp,
            &own.root_stamp,
            &AtomicBool::new(false)
        )
        .is_err()
    );
}
#[test]
fn cancellation_and_the_real_reader_cap_refuse_before_publishing_an_observation() {
    let own = Owned::new();
    assert_eq!(
        Artifacts::open(
            &own.root,
            &own.parent,
            &own.parent_stamp,
            &own.root_stamp,
            &AtomicBool::new(true)
        )
        .err()
        .unwrap()
        .code,
        "cancelled"
    );
    let mut set = own.open();
    assert_eq!(
        set.observe(&AtomicBool::new(true)).err().unwrap().code,
        "cancelled"
    );
    // The real reader has two production caps (bundle and manifest), not a
    // test-only scan entry. No oversized sparse file/large allocation required.
    assert_eq!(
        read(&set.bundle, 3, false, &AtomicBool::new(false))
            .err()
            .unwrap()
            .code,
        "recoveryLimit"
    );
}
#[cfg(unix)]
#[test]
fn a_fixed_leaf_symlink_is_not_followed_or_called_a_regular_artifact() {
    let own = Owned::new();
    let outside = own.parent.join("outside");
    fs::write(&outside, b"unselected").unwrap();
    fs::remove_file(own.root.join("recovery.bundle")).unwrap();
    std::os::unix::fs::symlink(&outside, own.root.join("recovery.bundle")).unwrap();
    assert!(
        Artifacts::open(
            &own.root,
            &own.parent,
            &own.parent_stamp,
            &own.root_stamp,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(fs::read(outside).unwrap(), b"unselected");
}
