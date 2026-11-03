//! Real ordinary-profile material and public recovery; disposable owned NTFS only.
use super::*;
use crate::file_access::{
    CarrierFailure as E, MaterialStoreRequest, MaterialTargetRequest, MixedMemory, MixedRequest,
    PinnedPath,
};
use crate::meta_store::MetaStore;
use std::{
    cell::Cell,
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

struct Fixture {
    _temp: tempfile::TempDir,
    base: PathBuf,
    source: PathBuf,
    artifact: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = crate::test_support::tempdir().unwrap();
        let base = PathBuf::from(inspect::canonical(temp.path()).unwrap());
        let source = base.join("ordinary source");
        let artifact = base.join("reserved artifact");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&artifact).unwrap();
        Self {
            _temp: temp,
            base,
            source,
            artifact,
        }
    }
    fn input(&self, memory: &MixedMemory) -> MixedRequest {
        Self::input_at(&self.source, memory)
    }
    fn input_at(root: &Path, memory: &MixedMemory) -> MixedRequest {
        MixedRequest::held_ordinary(
            PinnedPath::directory(root).unwrap(),
            root.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .encode_utf16()
                .collect(),
            memory,
            &AtomicBool::new(false),
        )
        .unwrap()
    }
    fn output(&self, memory: &MixedMemory) -> MaterialStoreRequest {
        self.output_at(&self.artifact, memory)
    }
    fn output_at(&self, artifact: &Path, memory: &MixedMemory) -> MaterialStoreRequest {
        let parent = PinnedPath::directory(&self.base).unwrap();
        let output = PinnedPath::directory(artifact).unwrap();
        recovery_pack::material::reserved(
            &self.base,
            artifact,
            &inspect::pinned_stamp(&parent).unwrap(),
            &inspect::pinned_stamp(&output).unwrap(),
            memory,
        )
        .unwrap()
    }
    fn seal(&self) -> WindowsMaterial {
        self.seal_at(&self.source, &self.artifact)
    }
    fn seal_at(&self, source: &Path, artifact: &Path) -> WindowsMaterial {
        let memory = MixedMemory::default();
        let owner = material_owner::Owner::default();
        // Keep failures attributable to the actual boundary, without logging any
        // material, descriptor, ACL, path or user data. This separate read-only
        // capture distinguishes source/native parsing from persistent storage.
        owner
            .capture_complete_tree(Self::input_at(source, &memory), &AtomicBool::new(false))
            .unwrap_or_else(|failure| {
                panic!(
                    "ordinary material phase=source-capture code={}",
                    failure.code
                )
            });
        let phase = Cell::new("seal-before-consumer");
        let (descriptor, _) = owner
            .sealed_material(
                Self::input_at(source, &memory),
                self.output_at(artifact, &memory),
                &AtomicBool::new(false),
                |sealed| {
                    phase.set("descriptor");
                    let descriptor = sealed.descriptor()?;
                    assert_eq!(descriptor.version, 2);
                    assert!(
                        descriptor
                            .nodes
                            .iter()
                            .all(|n| n.security.is_none() && n.ordinary_security.is_some())
                    );
                    phase.set("independent-reconstruction");
                    let actual = sealed.reconstruct_tree()?;
                    receipt(&actual, &descriptor);
                    phase.set("seal-after-consumer");
                    Ok(descriptor)
                },
            )
            .unwrap_or_else(|failure| {
                panic!(
                    "ordinary material phase={} code={}",
                    phase.get(),
                    failure.code
                )
            });
        assert!(
            source.exists(),
            "first independent reconstruction never needs original deletion"
        );
        owner.available().unwrap();
        // Force the persisted JSON path; no original proof objects become authority.
        serde_json::from_slice(&serde_json::to_vec(&descriptor).unwrap()).unwrap()
    }
    fn restore(
        &self,
        descriptor: &WindowsMaterial,
        leaf: &str,
    ) -> std::result::Result<PathBuf, Failure> {
        let memory = MixedMemory::default();
        let owner = material_owner::Owner::default();
        let parent = PinnedPath::directory(&self.base).unwrap();
        let target = MaterialTargetRequest::new(
            &self.base,
            parent.identity(),
            leaf.encode_utf16().collect(),
            &memory,
        )
        .unwrap();
        let result = owner.reopen_material(
            self.output(&memory),
            descriptor,
            &AtomicBool::new(false),
            |sealed| sealed.reconstruct_target(target),
        );
        owner.available().unwrap();
        let (actual, _) = result?;
        receipt(&actual, descriptor);
        assert!(actual.retained);
        Ok(self.base.join(leaf))
    }
    fn cold(&self) -> PathBuf {
        let descriptor = self.seal();
        fs::remove_dir_all(&self.source).unwrap();
        let target = self.restore(&descriptor, "cold restored").unwrap();
        assert!(!self.source.exists());
        assert!(self.artifact.join("material.bin").is_file());
        target
    }
}

pub(super) fn assert_recovery_material_identity() {
    let fixture = Fixture::new();
    fs::write(fixture.source.join("same"), b"x").unwrap();
    let sealed = fixture.seal();
    // Restore alongside the original. The native receipt also asserts that
    // every restored object has a different FileID from its source.
    let target = fixture.restore(&sealed, "restored sibling").unwrap();
    let reseal = |leaf| {
        let artifact = fixture.base.join(leaf);
        fs::create_dir(&artifact).unwrap();
        fixture.seal_at(&target, &artifact)
    };
    // The persistent store hashes normalized native material. Re-seal the
    // restored tree in the same mode to compare those semantic digests.
    let restored = reseal("restored material");
    let same_node_semantics = restored
        .nodes
        .iter()
        .map(|node| node.semantic_sha256)
        .eq(sealed.nodes.iter().map(|node| node.semantic_sha256));
    assert_eq!(
        restored.content, sealed.content,
        "resealed per-node native semantics equal: {same_node_semantics}"
    );

    fs::create_dir(target.join("ignored-empty")).unwrap();
    let changed = reseal("changed material");
    assert_eq!(changed.content.nodes, restored.content.nodes + 1);
    assert_ne!(changed.content.sha256, restored.content.sha256);
}

fn receipt(actual: &crate::file_access::MaterialTreeReceipt, expected: &WindowsMaterial) {
    let writes = expected
        .nodes
        .iter()
        .filter(|n| n.ea.count != 0 || n.streams.iter().any(|s| !s.name.is_empty() || s.bytes != 0))
        .count();
    assert_eq!(actual.nodes, expected.nodes.len());
    assert_eq!(
        actual.write_aborts as usize + actual.direct_data_writes as usize,
        writes
    );
    assert_eq!(actual.read_aborts as usize, expected.nodes.len());
    assert!(
        actual.exact_edges_verified && actual.all_native_recaptured && actual.metadata_finalized
    );
    for (n, id) in expected.nodes.iter().zip(&actual.target_ids) {
        assert_ne!(n.source_file_id, id.inode.to_le_bytes());
    }
}
fn ea(path: &Path) {
    use std::{
        fs::OpenOptions,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    };
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
}
fn ea_digest(path: &Path, directory: bool) -> [u8; 32] {
    let pin = if directory {
        PinnedPath::directory(path)
    } else {
        PinnedPath::regular(path)
    }
    .unwrap();
    crate::file_access::ea_observation(
        &pin,
        &mut crate::file_access::EaWorkBudget::new(crate::file_access::MATERIAL_WORK_LIMIT),
        &AtomicBool::new(false),
    )
    .unwrap()
    .sha256
}
fn ads(path: &Path) -> PathBuf {
    let mut raw = path.as_os_str().to_os_string();
    raw.push(":owned:$DATA");
    PathBuf::from(raw)
}
#[test]
fn ordinary_empty_directory_has_zero_writes_but_actual_readback() {
    let f = Fixture::new();
    let target = f.cold();
    assert_eq!(fs::read_dir(target).unwrap().count(), 0);
}
#[test]
fn ordinary_empty_file_preserves_empty_default_without_fake_native_write() {
    let f = Fixture::new();
    fs::write(f.source.join("empty"), []).unwrap();
    let target = f.cold();
    assert_eq!(fs::metadata(target.join("empty")).unwrap().len(), 0);
}
#[test]
fn ordinary_zero_through_five_byte_files_keep_exact_cold_material_and_real_write_counts() {
    fn counts(actual: &crate::file_access::MaterialTreeReceipt, size: usize) {
        assert_eq!(actual.nodes, 2);
        assert_eq!(actual.read_aborts, 2, "each actual native read is retired");
        assert_eq!(
            actual.direct_data_writes,
            u32::from((1..=4).contains(&size))
        );
        assert_eq!(actual.write_aborts, u32::from(size == 5));
    }
    for size in 0..=5 {
        let f = Fixture::new();
        let payload = &[0, 255, 3, 128, 5][..size];
        fs::write(f.source.join("short.bin"), payload).unwrap();
        let descriptor: WindowsMaterial = {
            let memory = MixedMemory::default();
            let owner = material_owner::Owner::default();
            let (descriptor, _) = owner
                .sealed_material(
                    f.input(&memory),
                    f.output(&memory),
                    &AtomicBool::new(false),
                    |sealed| {
                        let descriptor = sealed.descriptor()?;
                        assert_eq!(descriptor.nodes.len(), 2);
                        assert!(
                            descriptor
                                .nodes
                                .iter()
                                .all(|n| n.security.is_none() && n.ordinary_security.is_some())
                        );
                        let actual = sealed.reconstruct_tree()?;
                        receipt(&actual, &descriptor);
                        counts(&actual, size);
                        assert!(!actual.retained);
                        Ok(descriptor)
                    },
                )
                .unwrap();
            owner.available().unwrap();
            assert_eq!(fs::read(f.source.join("short.bin")).unwrap(), payload);
            serde_json::from_slice(&serde_json::to_vec(&descriptor).unwrap()).unwrap()
        };
        // Only the owned fixture original is removed. A new owner and pool must
        // reopen the persisted material; no original proof or file is retained.
        fs::remove_dir_all(&f.source).unwrap();
        let memory = MixedMemory::default();
        let owner = material_owner::Owner::default();
        let parent = PinnedPath::directory(&f.base).unwrap();
        let target = MaterialTargetRequest::new(
            &f.base,
            parent.identity(),
            "cold short".encode_utf16().collect(),
            &memory,
        )
        .unwrap();
        let (actual, _) = owner
            .reopen_material(
                f.output(&memory),
                &descriptor,
                &AtomicBool::new(false),
                |sealed| sealed.reconstruct_target(target),
            )
            .unwrap();
        owner.available().unwrap();
        receipt(&actual, &descriptor);
        counts(&actual, size);
        assert!(actual.retained);
        assert!(!f.source.exists());
        assert!(f.artifact.join("material.bin").is_file());
        assert_eq!(
            fs::read(f.base.join("cold short").join("short.bin")).unwrap(),
            payload
        );
    }
}
#[test]
fn ordinary_file_only_ea_roundtrips_exact_native_observation() {
    let f = Fixture::new();
    let file = f.source.join("ea");
    fs::write(&file, []).unwrap();
    ea(&file);
    let expected = ea_digest(&file, false);
    let target = f.cold();
    assert_eq!(ea_digest(&target.join("ea"), false), expected);
}
#[test]
fn ordinary_directory_only_ea_roundtrips_exact_native_observation() {
    let f = Fixture::new();
    ea(&f.source);
    let expected = ea_digest(&f.source, true);
    let target = f.cold();
    assert_eq!(ea_digest(&target, true), expected);
}
#[test]
fn ordinary_file_only_ads_keeps_zero_default_and_all_named_bytes() {
    let f = Fixture::new();
    let file = f.source.join("ads");
    fs::write(&file, []).unwrap();
    fs::write(ads(&file), b"named\0\xff").unwrap();
    let target = f.cold();
    assert!(fs::read(target.join("ads")).unwrap().is_empty());
    assert_eq!(fs::read(ads(&target.join("ads"))).unwrap(), b"named\0\xff");
}
#[test]
fn ordinary_directory_only_ads_roundtrips_without_default_stream() {
    let f = Fixture::new();
    fs::write(ads(&f.source), b"directory\0\xff").unwrap();
    let target = f.cold();
    assert_eq!(fs::read(ads(&target)).unwrap(), b"directory\0\xff");
    assert_eq!(fs::read_dir(target).unwrap().count(), 0);
}
fn security(path: &Path, sddl: &str, label: bool) {
    use std::{
        fs::OpenOptions,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
                SE_FILE_OBJECT, SetSecurityInfo,
            },
            DACL_SECURITY_INFORMATION, GetKernelObjectSecurity, GetSecurityDescriptorDacl,
            GetSecurityDescriptorSacl, IsValidAcl, LABEL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION,
        },
        Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_READ_ATTRIBUTES, GetFileInformationByHandle, READ_CONTROL, SYNCHRONIZE, WRITE_DAC,
            WRITE_OWNER,
        },
    };
    // The writer rights remain facet-specific. READ_CONTROL is for the actual
    // same-handle readback below; READ_ATTRIBUTES is for its object-identity check.
    // Neither requests ACCESS_SYSTEM_SECURITY nor changes a token privilege.
    let file = OpenOptions::new()
        .access_mode(
            READ_CONTROL
                | FILE_READ_ATTRIBUTES
                | SYNCHRONIZE
                | if label { WRITE_OWNER } else { WRITE_DAC },
        )
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .unwrap();
    let identity = || {
        let mut value = BY_HANDLE_FILE_INFORMATION::default();
        assert_ne!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut value) },
            0
        );
        (
            value.dwVolumeSerialNumber,
            value.nFileIndexHigh,
            value.nFileIndexLow,
        )
    };
    let before = identity();
    let wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut raw = ptr::null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut raw,
                ptr::null_mut(),
            )
        },
        0
    );
    let mut present = 0;
    let mut defaulted = 0;
    let mut acl = ptr::null_mut();
    let ok = unsafe {
        if label {
            GetSecurityDescriptorSacl(raw, &mut present, &mut acl, &mut defaulted)
        } else {
            GetSecurityDescriptorDacl(raw, &mut present, &mut acl, &mut defaulted)
        }
    };
    assert_ne!(ok, 0);
    assert_ne!(present, 0);
    assert!(!acl.is_null());
    assert_ne!(unsafe { IsValidAcl(acl) }, 0);
    let expected =
        unsafe { std::slice::from_raw_parts(acl.cast::<u8>(), (*acl).AclSize as usize).to_vec() };
    let status = unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            if label {
                LABEL_SECURITY_INFORMATION
            } else {
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION
            },
            ptr::null_mut(),
            ptr::null_mut(),
            if label { ptr::null() } else { acl },
            if label { acl } else { ptr::null() },
        )
    };
    assert!(unsafe { LocalFree(raw) }.is_null());
    assert_eq!(status, 0, "ordinary fixture phase=set-security");
    let mut observed = vec![0u64; 65536 / 8];
    let mut needed = 0;
    assert_ne!(
        unsafe {
            GetKernelObjectSecurity(
                file.as_raw_handle(),
                if label {
                    LABEL_SECURITY_INFORMATION
                } else {
                    DACL_SECURITY_INFORMATION
                },
                observed.as_mut_ptr().cast(),
                65536,
                &mut needed,
            )
        },
        0,
        "ordinary fixture phase=readback-security"
    );
    assert!((20..=65536).contains(&needed));
    let mut actual_acl = ptr::null_mut();
    let read = unsafe {
        if label {
            GetSecurityDescriptorSacl(
                observed.as_mut_ptr().cast(),
                &mut present,
                &mut actual_acl,
                &mut defaulted,
            )
        } else {
            GetSecurityDescriptorDacl(
                observed.as_mut_ptr().cast(),
                &mut present,
                &mut actual_acl,
                &mut defaulted,
            )
        }
    };
    assert_ne!(read, 0);
    assert_ne!(present, 0);
    assert!(!actual_acl.is_null());
    assert_ne!(unsafe { IsValidAcl(actual_acl) }, 0);
    let actual = unsafe {
        std::slice::from_raw_parts(actual_acl.cast::<u8>(), (*actual_acl).AclSize as usize)
    };
    assert!(actual == expected, "ordinary fixture exact ACL readback");
    assert!(identity() == before, "ordinary fixture exact object");
}
fn facet(path: &Path, label: bool) -> [u8; 32] {
    let pin = PinnedPath::directory(path).unwrap();
    let mut work = crate::file_access::EaWorkBudget::new(crate::file_access::MATERIAL_WORK_LIMIT);
    let cancel = AtomicBool::new(false);
    if label {
        crate::file_access::integrity_observation(&pin, &mut work, &cancel)
            .unwrap()
            .sha256
    } else {
        crate::file_access::security_observation(&pin, &mut work, &cancel)
            .unwrap()
            .sha256
    }
}
#[test]
fn ordinary_protected_dacl_restores_exact_readable_facet() {
    let f = Fixture::new();
    security(&f.source, "D:P(A;;FA;;;WD)", false);
    let expected = facet(&f.source, false);
    let target = f.cold();
    assert_eq!(facet(&target, false), expected);
}
#[test]
fn ordinary_low_integrity_label_is_restored_and_read_back() {
    let f = Fixture::new();
    security(&f.source, "S:(ML;;NW;;;LW)", true);
    let expected = facet(&f.source, true);
    let target = f.cold();
    assert_eq!(facet(&target, true), expected);
}
#[test]
fn ordinary_cold_target_collision_retains_foreign_object_and_original() {
    let f = Fixture::new();
    let descriptor = f.seal();
    let target = f.base.join("collision");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("foreign"), b"never replace").unwrap();
    assert!(f.restore(&descriptor, "collision").is_err());
    assert_eq!(fs::read(target.join("foreign")).unwrap(), b"never replace");
    assert!(f.source.exists());
}
#[test]
fn ordinary_descriptor_profile_tamper_refuses_before_target_or_source_change() {
    let f = Fixture::new();
    let mut descriptor = f.seal();
    descriptor.version = 1;
    assert!(!descriptor.validate());
    assert!(f.restore(&descriptor, "tampered").is_err());
    assert!(!f.base.join("tampered").exists());
    assert!(f.source.exists());
    let memory = MixedMemory::default();
    assert!(matches!(
        MixedRequest::held(
            PinnedPath::directory(&f.source).unwrap(),
            vec![65],
            &memory,
            &AtomicBool::new(false)
        ),
        Err(E::Unsupported)
    ));
}
fn public_cold(delete: bool) {
    let f = recovery_public_windows_tests::backup(delete);
    let manifest: recovery_pack::Manifest = serde_json::from_slice(
        &fs::read(Path::new(&f.recovery().path).join("manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        manifest.content.profile,
        Some(MaterialProfile::WindowsOrdinaryRetainedTreeV1)
    );
    assert_eq!(manifest.windows_material.as_ref().unwrap().version, 2);
    let original = Path::new(&f.recovery().retained_path);
    assert_eq!(original.exists(), !delete);
    if delete {
        fs::remove_dir_all(f.main()).unwrap();
    }
    let store = MetaStore::open(f.database()).unwrap();
    let manager = Worktrees::default();
    let listing = manager.list(&store).unwrap();
    let cold = listing
        .recoveries
        .iter()
        .find(|r| r.id == f.recovery().id)
        .unwrap();
    assert_eq!(cold.availability, "unknown");
    let checked = manager
        .recovery_check(&store, &cold.id, cold.revision)
        .unwrap();
    let recovery = checked.recoveries.iter().find(|r| r.id == cold.id).unwrap();
    assert_eq!(recovery.availability, "verified");
    if listing
        .operation
        .as_ref()
        .is_some_and(|o| o.state == "unknown")
    {
        manager
            .acknowledge(&store, "33333333-3333-4333-8333-333333333333")
            .unwrap();
    }
    let id = "88888888-8888-4888-8888-888888888888";
    manager
        .prepare_recover(
            &store,
            id,
            RecoverInput {
                recovery_id: recovery.id.clone(),
                expected_revision: recovery.revision,
                parent_path: f.parent().to_str().unwrap().into(),
                directory_name: "ordinary public cold".into(),
            },
        )
        .unwrap();
    manager.start(&store, id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let o = tests::op(manager.status(&store, id).unwrap());
        if o.settled && !o.maintenance_active {
            assert_eq!(o.state, "ready", "{o:?}");
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    let target = f.parent().join("ordinary public cold");
    assert!(target.join(".git").is_dir());
    assert_eq!(
        fs::read(target.join("payload.txt")).unwrap(),
        b"retained\ncontent\n"
    );
    assert_eq!(
        fs::read(target.join("payload.txt:retained:$DATA")).unwrap(),
        b"actual named stream"
    );
    assert_eq!(fs::read(target.join("untracked.bin")).unwrap(), [0, 255, 3]);
    assert!(target.join("empty retained directory").is_dir());
    assert_eq!(original.exists(), !delete);
    drop(manager);
    drop(store);
    let store = MetaStore::open(f.database()).unwrap();
    let manager = Worktrees::default();
    assert_eq!(
        manager.list(&store).unwrap().operation.unwrap().state,
        "unknown"
    );
    assert_eq!(
        tests::op(manager.recheck(&store, id).unwrap()).state,
        "ready"
    );
}
#[test]
fn ordinary_public_backup_cold_recover_keeps_original_and_rechecks() {
    recycle_tests::isolated_with_timeout(
        "worktrees::recovery_ordinary_windows_tests::ordinary_public_backup_cold_recover_keeps_original_and_rechecks",
        PUBLIC_COLD_TEST_TIMEOUT,
        || public_cold(false),
    );
}
#[test]
fn ordinary_public_confirm_delete_then_offline_cold_recover_preserves_all_material() {
    recycle_tests::isolated_with_timeout(
        "worktrees::recovery_ordinary_windows_tests::ordinary_public_confirm_delete_then_offline_cold_recover_preserves_all_material",
        PUBLIC_COLD_TEST_TIMEOUT,
        || public_cold(true),
    );
}

// Both tests acquire the real application-wide maintenance gate. Keep their
// fixtures independent and allow for the full Git, archive and recovery path.
const PUBLIC_COLD_TEST_TIMEOUT: Duration = Duration::from_secs(180);
