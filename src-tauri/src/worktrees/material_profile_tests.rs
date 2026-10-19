#[cfg(windows)]
use super::{AtomicBool, capture, content};
use crate::worktrees::recycle_types::{MaterialProfile, MaterialSummary};
#[test]
fn historical_unix_summary_bytes_do_not_gain_a_profile_or_change_key_order() {
    let value = MaterialSummary {
        profile: None,
        entries: 2,
        bytes: 3,
        sha256: "a".repeat(64),
    };
    assert_eq!(
        serde_json::to_string(&value).unwrap(),
        format!(
            "{{\"entries\":2,\"bytes\":3,\"sha256\":\"{}\"}}",
            "a".repeat(64)
        )
    );
    assert_eq!(
        serde_json::from_str::<MaterialSummary>(&serde_json::to_string(&value).unwrap()).unwrap(),
        value
    );
}
#[test]
fn partial_windows_profile_is_explicit_and_unknown_profiles_are_not_accepted() {
    let value = MaterialSummary {
        profile: Some(MaterialProfile::WindowsDefaultDataV1),
        entries: 2,
        bytes: 3,
        sha256: "b".repeat(64),
    };
    let wire = serde_json::to_string(&value).unwrap();
    assert!(wire.contains("windowsDefaultDataV1"));
    let mut null = serde_json::to_value(&value).unwrap();
    null["profile"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<MaterialSummary>(null).is_err());
    assert!(
        serde_json::from_str::<MaterialSummary>(&wire.replacen(
            "{",
            "{\"profile\":\"windowsDefaultDataV1\",",
            1
        ))
        .is_err()
    );
    assert_eq!(
        serde_json::from_str::<MaterialSummary>(&wire).unwrap(),
        value
    );
    assert!(
        serde_json::from_str::<MaterialSummary>(
            &wire.replace("windowsDefaultDataV1", "completeWindowsBackup")
        )
        .is_err()
    );
}
#[cfg(windows)]
#[test]
fn actual_owned_default_data_observation_changes_with_body_and_includes_ignored_names() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".git"), b"owned-linked-pointer-marker").unwrap();
    std::fs::write(dir.path().join(".gitignore"), b"ignored.bin\n").unwrap();
    std::fs::write(dir.path().join("ignored.bin"), b"original-data").unwrap();
    let cancel = AtomicBool::new(false);
    let first = capture(dir.path(), &cancel).unwrap();
    assert_eq!(
        first.profile,
        Some(MaterialProfile::WindowsDefaultDataEaStreamsV1)
    );
    assert_eq!(first.entries, 3);
    assert_eq!(capture(dir.path(), &cancel).unwrap(), first);
    std::fs::write(dir.path().join("ignored.bin"), b"changed!-data").unwrap();
    assert_ne!(capture(dir.path(), &cancel).unwrap(), first);
    assert_eq!(
        content(dir.path(), &cancel).unwrap_err().code,
        "unsupportedGit"
    );
    assert_eq!(
        capture(dir.path(), &AtomicBool::new(true))
            .unwrap_err()
            .code,
        "cancelled"
    );
}

// Portable controls use the exact ListingBudget::collect production seam that
// Windows walk invokes. Tracked maps expose entry retention and query ordering,
// not allocator/RSS bytes. The legacy path is a bounded model of R2 ordering,
// not an executed Windows runtime RED.
mod listing_controls {
    use super::super::ListingBudget;
    use crate::worktrees::types::{Result, error};
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
        sync::atomic::AtomicBool,
    };
    #[derive(Default)]
    struct Metrics {
        live: Cell<usize>,
        peak: Cell<usize>,
        queries: RefCell<Vec<u64>>,
        processed: Cell<usize>,
    }
    struct Map {
        len: usize,
        metrics: Rc<Metrics>,
    }
    impl Map {
        fn new(len: usize, metrics: &Rc<Metrics>) -> Self {
            let live = metrics.live.get() + len;
            metrics.live.set(live);
            metrics.peak.set(metrics.peak.get().max(live));
            Self {
                len,
                metrics: metrics.clone(),
            }
        }
    }
    impl Drop for Map {
        fn drop(&mut self) {
            self.metrics.live.set(self.metrics.live.get() - self.len);
        }
    }
    fn query(width: usize, capacity: u64, metrics: &Rc<Metrics>) -> Result<Map> {
        metrics.queries.borrow_mut().push(capacity);
        if width as u64 > capacity {
            return Err(error("materialLimit"));
        }
        Ok(Map::new(width, metrics))
    }
    fn reserved_walk(
        widths: &[usize],
        budget: &mut ListingBudget,
        metrics: &Rc<Metrics>,
    ) -> Result<()> {
        let (map, capacity) = budget.collect(
            &AtomicBool::new(false),
            |cap| query(widths[0], cap, metrics),
            |m| m.len,
        )?;
        for index in 0..map.len {
            if index == 0 && widths.len() > 1 {
                reserved_walk(&widths[1..], budget, metrics)?;
            }
            metrics.processed.set(metrics.processed.get() + 1);
        }
        let again = query(map.len, capacity, metrics)?;
        assert_eq!(again.len, map.len);
        Ok(())
    }
    fn legacy_walk(
        widths: &[usize],
        budget: &mut ListingBudget,
        metrics: &Rc<Metrics>,
    ) -> Result<()> {
        let map = query(widths[0], budget.remaining(), metrics)?;
        for index in 0..map.len {
            budget.reserve(1)?;
            if index == 0 && widths.len() > 1 {
                legacy_walk(&widths[1..], budget, metrics)?;
            }
            metrics.processed.set(metrics.processed.get() + 1);
        }
        Ok(())
    }
    #[test]
    fn wide_first_child_is_refused_before_another_complete_map_or_content_processing() {
        let widths = [16, 15, 14, 13];
        let legacy = Rc::new(Metrics::default());
        assert_eq!(
            legacy_walk(&widths, &mut ListingBudget::new(16), &legacy)
                .unwrap_err()
                .code,
            "materialLimit"
        );
        assert_eq!(legacy.peak.get(), 58);
        assert_eq!(legacy.live.get(), 0);
        let actual = Rc::new(Metrics::default());
        let mut budget = ListingBudget::new(16);
        assert_eq!(
            reserved_walk(&widths, &mut budget, &actual)
                .unwrap_err()
                .code,
            "materialLimit"
        );
        assert_eq!(&*actual.queries.borrow(), &[16, 0]);
        assert_eq!(actual.peak.get(), 16);
        assert_eq!(actual.processed.get(), 0);
        assert_eq!(actual.live.get(), 0);
        assert_eq!(budget.reserved, 16);
    }
    #[test]
    fn an_exactly_full_first_map_rechecks_with_its_initial_capacity_without_reserving_twice() {
        let metrics = Rc::new(Metrics::default());
        let mut budget = ListingBudget::new(8);
        reserved_walk(&[8], &mut budget, &metrics).unwrap();
        assert_eq!(&*metrics.queries.borrow(), &[8, 8]);
        assert_eq!(budget.reserved, 8);
        assert_eq!(metrics.peak.get(), 16);
        assert_eq!(metrics.live.get(), 0);
        assert_eq!(metrics.processed.get(), 8);
    }
    #[test]
    fn an_oversized_query_result_and_cancel_never_reach_descendants_or_reserve_phantom_entries() {
        let metrics = Rc::new(Metrics::default());
        let mut budget = ListingBudget::new(2);
        assert!(
            budget
                .collect(
                    &AtomicBool::new(false),
                    |_| Ok(Map::new(3, &metrics)),
                    |m| m.len
                )
                .is_err()
        );
        assert_eq!(budget.reserved, 0);
        assert_eq!(metrics.live.get(), 0);
        let called = Cell::new(false);
        assert_eq!(
            budget
                .collect(
                    &AtomicBool::new(true),
                    |_| {
                        called.set(true);
                        Ok(0usize)
                    },
                    |v| *v
                )
                .unwrap_err()
                .code,
            "cancelled"
        );
        assert!(!called.get());
        assert_eq!(budget.reserved, 0);
        let cancel = AtomicBool::new(false);
        assert!(
            budget
                .collect(
                    &cancel,
                    |_| {
                        let map = Map::new(1, &metrics);
                        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                        Ok(map)
                    },
                    |m| m.len
                )
                .is_err()
        );
        assert_eq!(metrics.live.get(), 0);
        assert_eq!(budget.reserved, 0);
    }
}

// These controls call the real Unix scanner with a small entry limit, not a
// second traversal/counter implementation. The special-file control separates
// early capacity refusal from accidentally weakening existing file-kind checks.
#[cfg(unix)]
mod unix_listing_controls {
    use super::super::{ListingBudget, MaterialSummary, Scan, capture, content, hex, walk};
    use crate::worktrees::types::{Result, error};
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::MetadataExt;
    use std::{
        ffi::CString,
        os::unix::{
            ffi::OsStrExt,
            fs::{PermissionsExt, symlink},
        },
        path::Path,
        sync::atomic::AtomicBool,
    };

    // Test-only setup/seed/fresh-root wrapper. names(), walk(), reservation,
    // metadata/content checks and hash fields are the actual production code.
    // This wrapper itself is not evidence of the production outer path; the
    // tests also compare the real content() and capture() entry points below.
    fn scan_with_limit(
        root: &Path,
        cancel: &AtomicBool,
        content_only: bool,
        entry_limit: u64,
    ) -> Result<MaterialSummary> {
        let dir = crate::file_access::open_directory(root).map_err(|_| error("unsafePath"))?;
        let mut scan = Scan {
            hash: Sha256::new(),
            entries: ListingBudget::new(entry_limit),
            bytes: 0,
            content_only,
        };
        if !content_only {
            scan.field(
                &dir.metadata()
                    .map_err(|_| error("unavailable"))?
                    .mode()
                    .to_le_bytes(),
            );
        }
        walk(&mut scan, &dir, b"", 0, cancel)?;
        let fresh =
            crate::file_access::open_directory(root).map_err(|_| error("materialChanged"))?;
        if !crate::file_access::same_object(&dir, &fresh).map_err(|_| error("materialChanged"))? {
            return Err(error("materialChanged"));
        }
        Ok(MaterialSummary {
            profile: None,
            entries: scan.entries.reserved,
            bytes: scan.bytes,
            sha256: hex(scan.hash.finalize()),
        })
    }

    fn special_child() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(".git"), b"owned-linked-pointer-marker").unwrap();
        std::fs::create_dir(root.path().join("a-first")).unwrap();
        std::fs::write(root.path().join("y-file"), b"y").unwrap();
        std::fs::write(root.path().join("z-file"), b"z").unwrap();
        let fifo =
            CString::new(root.path().join("a-first/a-special").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        root
    }

    #[test]
    fn the_complete_parent_is_reserved_before_the_first_child_can_inspect_a_special_file() {
        let root = special_child();
        let path = root.path().canonicalize().unwrap();
        let result = scan_with_limit(&path, &AtomicBool::new(false), true, 4);
        assert_eq!(result.unwrap_err().code, "materialLimit");
    }

    #[test]
    fn an_admitted_child_still_rejects_a_special_file_instead_of_skipping_it() {
        let root = special_child();
        let path = root.path().canonicalize().unwrap();
        let result = scan_with_limit(&path, &AtomicBool::new(false), true, 5);
        assert_eq!(result.unwrap_err().code, "specialFile");
    }

    fn regular(path: &Path, body: &[u8], mode: u32) {
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn a_successful_exact_limit_tree_preserves_historical_count_hash_order_and_wire() {
        let root = tempfile::tempdir().unwrap();
        regular(
            &root.path().join(".git"),
            b"owned-linked-pointer-marker",
            0o644,
        );
        std::fs::create_dir(root.path().join("a-dir")).unwrap();
        regular(&root.path().join("a-dir/child.txt"), b"nested\n", 0o644);
        regular(&root.path().join("b-file"), b"alpha\n", 0o644);
        symlink("b-file", root.path().join("c-link")).unwrap();
        regular(&root.path().join("z-exec"), b"#!/bin/x\n", 0o755);
        let path = root.path().canonicalize().unwrap();
        let cancel = AtomicBool::new(false);
        let bounded = scan_with_limit(&path, &cancel, true, 6).unwrap();
        assert_eq!(bounded.entries, 6); // Includes .git, although its bytes/hash are skipped.
        assert_eq!(bounded.bytes, 22);
        assert_eq!(
            bounded.sha256,
            "935dbe5559fa47a2283728a06c004c194007cca9e386f1f2fa87c8a2bed030d4"
        );
        assert_eq!(
            serde_json::to_string(&bounded).unwrap(),
            "{\"entries\":6,\"bytes\":22,\"sha256\":\"935dbe5559fa47a2283728a06c004c194007cca9e386f1f2fa87c8a2bed030d4\"}"
        );
        assert_eq!(content(&path, &cancel).unwrap(), bounded);
        assert_eq!(
            capture(&path, &cancel).unwrap(),
            scan_with_limit(&path, &cancel, false, 6).unwrap()
        );
        assert_eq!(
            scan_with_limit(&path, &cancel, true, 5).unwrap_err().code,
            "materialLimit"
        );
        assert_eq!(
            scan_with_limit(&path, &AtomicBool::new(true), true, 6)
                .unwrap_err()
                .code,
            "cancelled"
        );
    }
}

#[test]
fn new_ea_profile_is_still_explicit_partial_and_never_legacy_none() {
    let value = MaterialSummary {
        profile: Some(MaterialProfile::WindowsDefaultDataEaV1),
        entries: 1,
        bytes: 17,
        sha256: "c".repeat(64),
    };
    let wire = serde_json::to_string(&value).unwrap();
    assert!(wire.contains("windowsDefaultDataEaV1"));
    assert_eq!(
        serde_json::from_str::<MaterialSummary>(&wire).unwrap(),
        value
    );
    assert_ne!(value.profile, None);
    assert!(
        serde_json::from_str::<MaterialSummary>(
            &wire.replace("windowsDefaultDataEaV1", "completeWindowsBackup")
        )
        .is_err()
    );
}

#[cfg(windows)]
#[test]
fn real_capture_consumes_ea_without_adding_ea_bytes_to_default_data_total() {
    use std::{
        fs::OpenOptions,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    };
    use windows_sys::{
        Wdk::Storage::FileSystem::NtSetEaFile,
        Win32::{
            Storage::FileSystem::{FILE_WRITE_EA, SYNCHRONIZE},
            System::IO::IO_STATUS_BLOCK,
        },
    };
    fn set_ea(path: &std::path::Path, value: &[u8]) {
        let file = OpenOptions::new()
            .access_mode(FILE_WRITE_EA | SYNCHRONIZE)
            .open(path)
            .unwrap();
        let name = b"farfold-public-owned";
        let mut raw = Vec::new();
        raw.extend(0u32.to_le_bytes());
        raw.extend([0, name.len() as u8]);
        raw.extend((value.len() as u16).to_le_bytes());
        raw.extend(name);
        raw.push(0);
        raw.extend(value);
        let mut ios = IO_STATUS_BLOCK::default();
        assert_eq!(
            unsafe {
                NtSetEaFile(
                    file.as_raw_handle(),
                    &mut ios,
                    raw.as_ptr().cast(),
                    raw.len() as u32,
                )
            },
            0
        );
    }
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("owned.txt");
    std::fs::write(&file, b"same-default-data").unwrap();
    set_ea(&file, b"first\0\xff");
    let cancel = AtomicBool::new(false);
    let a = capture(root.path(), &cancel).unwrap();
    set_ea(&file, b"other\0\xff");
    let b = capture(root.path(), &cancel).unwrap();
    assert_ne!(a.sha256, b.sha256);
    assert_eq!(a.bytes, 17);
    assert_eq!(b.bytes, 17);
    assert_eq!(a.entries, b.entries);
    assert_eq!(
        b.profile,
        Some(MaterialProfile::WindowsDefaultDataEaStreamsV1)
    );
}

#[test]
fn streams_partial_profile_is_additive_and_does_not_become_historical_unix() {
    let value = MaterialSummary {
        profile: Some(MaterialProfile::WindowsDefaultDataEaStreamsV1),
        entries: 2,
        bytes: 3,
        sha256: "c".repeat(64),
    };
    let wire = serde_json::to_string(&value).unwrap();
    assert!(wire.contains("windowsDefaultDataEaStreamsV1"));
    assert_eq!(
        serde_json::from_str::<MaterialSummary>(&wire).unwrap(),
        value
    );
    assert!(
        serde_json::from_str::<MaterialSummary>(
            &wire.replace("windowsDefaultDataEaStreamsV1", "completeWindowsBackup")
        )
        .is_err()
    );
    assert_ne!(
        value,
        MaterialSummary {
            profile: None,
            ..value.clone()
        }
    );
}

#[cfg(windows)]
#[test]
fn owned_ntfs_named_data_changes_the_partial_stream_facet_without_changing_default_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::write(root.join(".git"), b"owned-linked-pointer").unwrap();
    let file = root.join("owned.txt");
    std::fs::write(&file, b"body").unwrap();
    let first_ads = format!("{}:one:$DATA", file.display());
    let second_ads = format!("{}:two:$DATA", file.display());
    // ADS pathnames are used only to create this explicitly owned fixture;
    // production observation never opens one or widens the base handle.
    std::fs::write(&first_ads, b"first").unwrap();
    std::fs::write(&second_ads, b"other").unwrap();
    let owner = crate::worktrees::material_owner::Owner::default();
    let cancel = AtomicBool::new(false);
    let first = owner.capture(&root, &cancel).unwrap();
    assert_eq!(
        first.profile,
        Some(MaterialProfile::WindowsDefaultDataEaStreamsV1)
    );
    assert_eq!(first.bytes, 4);
    assert_eq!(owner.capture(&root, &cancel).unwrap(), first);
    std::fs::write(&first_ads, b"later").unwrap();
    let second = owner.capture(&root, &cancel).unwrap();
    assert_eq!(second.bytes, first.bytes);
    assert_eq!(second.entries, first.entries);
    assert_ne!(second.sha256, first.sha256);
    assert_eq!(std::fs::read(&file).unwrap(), b"body");
}
