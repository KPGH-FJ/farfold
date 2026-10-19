//! Real owned NTFS structure only. No carrier/target/BackupRead restore fallback.
use super::{Slot, error};
use crate::file_access::{
    AliasFailure as E, AliasMemory, AliasRequest, AliasView, EaWorkBudget as WorkBudget,
    PinnedPath, with_alias_structure,
};
use std::{
    ffi::OsString,
    fs::{FileTimes, OpenOptions},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::OpenOptionsExt,
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};
fn request(path: &Path, memory: &AliasMemory) -> AliasRequest {
    let path = path.canonicalize().unwrap();
    let pin = PinnedPath::directory(&path).unwrap();
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
    AliasRequest::held(
        pin,
        path.file_name().unwrap().encode_wide().collect(),
        memory,
        &AtomicBool::new(false),
    )
    .unwrap()
}
macro_rules! run {
    ($req:expr,$work:expr,$cancel:expr,$consume:expr) => {{
        let slot = Slot::<()>::default();
        let mut value = None;
        let result = slot.run(|_| {
            value = Some(with_alias_structure(
                $req,
                &mut WorkBudget::new($work),
                &AtomicBool::new($cancel),
                $consume,
            ));
            match value.as_ref().unwrap() {
                Ok(_) => Ok(()),
                Err(_) => Err(error("aliasStructureRejected")),
            }
        });
        assert!(!slot.occupied());
        match value {
            Some(r) => r,
            None => panic!("Slot rejected {result:?}"),
        }
    }};
}
struct Fixture {
    dir: tempfile::TempDir,
    root: PathBuf,
    a: PathBuf,
    b: PathBuf,
}
impl Fixture {
    fn linked() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("left")).unwrap();
        std::fs::create_dir(root.join("right")).unwrap();
        let a = root.join("left").join(OsString::from_wide(&[0x61, 0xd800]));
        let b = root.join("right").join("A");
        std::fs::write(&a, b"alias-source\0\xff").unwrap();
        std::fs::hard_link(&a, &b).unwrap();
        Self { dir, root, a, b }
    }
    fn preserved(&self) {
        for p in [&self.a, &self.b] {
            assert_eq!(std::fs::read(p).unwrap(), b"alias-source\0\xff");
        }
    }
}
#[test]
fn actual_cross_parent_raw_names_form_one_closed_full_identity_group() {
    let f = Fixture::linked();
    let memory = AliasMemory::default();
    assert!(memory.whole_allowance_available());
    let id = run!(
        request(&f.root, &memory),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
        |view: AliasView<'_>| {
            assert!(!memory.whole_allowance_available());
            assert_eq!(view.edge_count(), 5);
            assert_eq!(view.groups().len(), 1);
            let group = &view.groups()[0];
            assert_eq!(group.reported_links, 2);
            assert_eq!(group.members.len(), 2);
            let a = view.edge(group.members[0] as usize).unwrap();
            let b = view.edge(group.members[1] as usize).unwrap();
            assert!(!a.directory && !b.directory);
            assert_eq!(a.identity, b.identity);
            assert_eq!(a.identity, group.identity);
            assert_ne!(a.parent, b.parent);
            assert_eq!(a.raw_leaf, [0x61, 0xd800]);
            assert_eq!(b.raw_leaf, [65]);
            assert_eq!((a.reported_links, b.reported_links), (2, 2));
            Ok(group.identity.clone())
        }
    )
    .unwrap();
    assert_ne!(id.inode, 0);
    assert!(memory.whole_allowance_available());
    f.preserved();
    f.dir.close().unwrap();
}
#[test]
fn actual_outside_alias_is_incomplete_even_with_two_visible_alias_names() {
    let f = Fixture::linked();
    std::fs::hard_link(&f.a, f.dir.path().join("outside")).unwrap();
    let result: Result<(), E> = run!(
        request(&f.root, &AliasMemory::default()),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
        |_| panic!("incomplete group cannot reach callback")
    );
    assert_eq!(
        result,
        Err(E::Incomplete {
            group: 0,
            known_names: 2,
            reported_links: 3
        })
    );
    f.preserved();
}
#[test]
fn single_visible_name_is_not_complete_when_another_link_is_outside_root() {
    let f = Fixture::linked();
    std::fs::remove_file(&f.b).unwrap();
    std::fs::hard_link(&f.a, f.dir.path().join("outside")).unwrap();
    let result: Result<(), E> = run!(
        request(&f.root, &AliasMemory::default()),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
        |_| panic!("outside link cannot be hidden by grouping")
    );
    assert_eq!(
        result,
        Err(E::Incomplete {
            group: 0,
            known_names: 1,
            reported_links: 2
        })
    );
    assert_eq!(std::fs::read(&f.a).unwrap(), b"alias-source\0\xff");
}
#[test]
fn equal_contents_do_not_merge_distinct_file_objects() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(temp.path().join("a"), b"same").unwrap();
    std::fs::write(temp.path().join("b"), b"same").unwrap();
    run!(
        request(temp.path(), &AliasMemory::default()),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
        |view: AliasView<'_>| {
            assert_eq!(view.groups().len(), 2);
            assert_ne!(view.groups()[0].identity, view.groups()[1].identity);
            for g in view.groups() {
                assert_eq!(g.members.len(), 1);
                assert_eq!(g.reported_links, 1);
            }
            Ok(())
        }
    )
    .unwrap();
    temp.close().unwrap();
}
#[test]
fn metadata_change_after_readonly_consumer_must_fail_the_same_source_witness() {
    let f = Fixture::linked();
    let changed = std::fs::metadata(&f.a).unwrap().modified().unwrap() + Duration::from_secs(60);
    let writer = OpenOptions::new()
        .access_mode(windows_sys::Win32::Storage::FileSystem::FILE_WRITE_ATTRIBUTES)
        .share_mode(7)
        .open(&f.a)
        .unwrap();
    let result = run!(
        request(&f.root, &AliasMemory::default()),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
        |view: AliasView<'_>| {
            assert_eq!(view.groups()[0].reported_links, 2);
            writer
                .set_times(FileTimes::new().set_modified(changed))
                .unwrap();
            assert_eq!(writer.metadata().unwrap().modified().unwrap(), changed);
            Ok(())
        }
    );
    assert_eq!(result, Err(E::Changed));
    drop(writer);
    f.preserved();
}
#[test]
fn cancel_and_shared_work_limit_reject_without_calling_the_structural_consumer() {
    for (work, cancel, expected) in [
        (0, false, E::Limit),
        (crate::file_access::SHAPE_WORK_LIMIT, true, E::Cancelled),
    ] {
        let f = Fixture::linked();
        let memory = AliasMemory::default();
        let result: Result<(), E> = run!(request(&f.root, &memory), work, cancel, |_| panic!(
            "rejected input"
        ));
        assert_eq!(result, Err(expected));
        assert!(memory.whole_allowance_available());
        f.preserved();
    }
}
