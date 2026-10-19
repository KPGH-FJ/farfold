//! Owned linked-tree source observations, not a full material restore.
use super::*;
use crate::worktrees::windows_scope::Scope;
use std::{fs, path::PathBuf};

struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
    private: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap();
        let main = parent.join("owned main");
        let root = parent.join("owned linked");
        let common = main.join(".git");
        let private = common.join("worktrees/owned");
        for path in [
            common.join("objects"),
            common.join("refs/heads"),
            private.join("logs/refs/worktree"),
            private.join("refs/worktree"),
            root.clone(),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(
            common.join("config"),
            b"[core]\n repositoryformatversion = 0\n bare = false\n",
        )
        .unwrap();
        fs::write(common.join("HEAD"), b"ref: refs/heads/public\n").unwrap();
        fs::write(common.join("refs/heads/public"), format!("{COMMIT}\n")).unwrap();
        fs::write(
            root.join(".git"),
            format!("gitdir: {}\n", private.display()),
        )
        .unwrap();
        fs::write(private.join("commondir"), b"../..\n").unwrap();
        fs::write(
            private.join("gitdir"),
            format!("{}\n", root.join(".git").display()),
        )
        .unwrap();
        fs::write(private.join("HEAD"), b"ref: refs/heads/public\n").unwrap();
        fs::write(private.join("index"), EMPTY_INDEX).unwrap();
        fs::write(private.join("refs/worktree/kept"), format!("{ORPHAN}\n")).unwrap();
        fs::write(
            private.join("logs/refs/worktree/deleted"),
            format!("{ORPHAN} {COMMIT} Fixture <f@example.invalid> 1 +0000\towned\n"),
        )
        .unwrap();
        fs::write(root.join("owned.txt"), b"public\n").unwrap();
        for (id, bytes) in [
            (BLOB, BLOB_LOOSE),
            (TREE, TREE_LOOSE),
            (COMMIT, COMMIT_LOOSE),
            (ORPHAN, ORPHAN_LOOSE),
        ] {
            fs::create_dir_all(common.join("objects").join(&id[..2])).unwrap();
            fs::write(common.join("objects").join(&id[..2]).join(&id[2..]), bytes).unwrap();
        }
        Self {
            temp,
            root,
            private,
        }
    }
    fn snapshot(&self) -> Snapshot {
        let scope = Scope::open(&self.root).unwrap();
        Snapshot {
            root: scope.root.path.clone(),
            git_dir: scope.git.path.clone(),
            common_dir: scope.common.path.clone(),
            root_stamp: inspect::pinned_stamp(&scope.root).unwrap(),
            git_stamp: inspect::pinned_stamp(&scope.git).unwrap(),
            common_stamp: inspect::pinned_stamp(&scope.common).unwrap(),
            head: Some(COMMIT.into()),
            branch: Some("refs/heads/public".into()),
            trees: Vec::new(),
            blockers: Vec::new(),
        }
    }
    fn bytes(&self) -> Vec<Vec<u8>> {
        [
            self.root.join("owned.txt"),
            self.root.join(".git"),
            self.private.join("index"),
            self.private.join("HEAD"),
            self.private.join("commondir"),
            self.private.join("gitdir"),
            self.private.join("refs/worktree/kept"),
            self.private.join("logs/refs/worktree/deleted"),
        ]
        .iter()
        .map(|p| fs::read(p).unwrap())
        .collect()
    }
}

#[test]
fn actual_source_graph_has_exact_reachable_objects_and_one_program_with_held_private_inventory() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let before = fixture.bytes();
    let graph = SourceGraph::capture(&snapshot, &AtomicBool::new(false)).unwrap();
    let mut expected = vec![
        BLOB.to_owned(),
        TREE.to_owned(),
        COMMIT.to_owned(),
        ORPHAN.to_owned(),
    ];
    expected.sort();
    assert_eq!(graph.objects(), expected.as_slice());
    assert_eq!(
        graph
            .roots()
            .commits
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([COMMIT.to_owned(), ORPHAN.to_owned()])
    );
    let selected = graph.owner.source.selected_program().identity().clone();
    graph.recheck(&AtomicBool::new(false)).unwrap();
    assert_eq!(*graph.owner.source.selected_program().identity(), selected);
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(fixture.private.join("HEAD"))
            .is_err()
    );
    assert_eq!(fixture.bytes(), before);
    drop(graph);
    assert!(fixture.temp.path().exists());
}
#[test]
fn real_recovery_capture_does_not_turn_a_graph_component_into_complete_material() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let cancel = AtomicBool::new(false);
    assert_eq!(
        SourceGraph::capture(&snapshot, &cancel)
            .unwrap()
            .objects()
            .len(),
        4
    );
    // Material content comparison retains its Windows admission boundary.
    // No None profile/fake material is supplied to get past it.
    assert_eq!(
        crate::worktrees::recovery_pack::capture(&snapshot, &cancel)
            .unwrap_err()
            .code,
        "unsupportedGit"
    );
    assert_eq!(
        fs::read(fixture.private.join("index")).unwrap(),
        EMPTY_INDEX
    );
}
#[test]
fn missing_owned_source_object_and_pre_cancel_never_publish_a_complete_graph() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let blob = PathBuf::from(&snapshot.common_dir)
        .join("objects")
        .join(&BLOB[..2])
        .join(&BLOB[2..]);
    fs::remove_file(blob).unwrap();
    assert_eq!(
        SourceGraph::capture(&snapshot, &AtomicBool::new(false))
            .err()
            .unwrap()
            .code,
        "recoveryInvalid"
    );
    assert_eq!(
        SourceGraph::capture(&snapshot, &AtomicBool::new(true))
            .err()
            .unwrap()
            .code,
        "cancelled"
    );
    assert_eq!(
        fs::read(fixture.private.join("index")).unwrap(),
        EMPTY_INDEX
    );
}
#[test]
fn real_object_parser_rejects_incomplete_duplicate_wrong_width_and_overbudget_sets() {
    let roots = Roots {
        head: COMMIT.into(),
        format: "sha1".into(),
        commits: vec![COMMIT.into()],
        files: vec![],
    };
    let raw = format!("{TREE}\n{BLOB}\n{COMMIT}\n");
    let cancel = AtomicBool::new(false);
    let ids = object_ids(raw.as_bytes(), &roots, &cancel).unwrap();
    assert_eq!(ids.len(), 3);
    for bad in [
        String::new(),
        format!("{BLOB}\n"),
        format!("{COMMIT}\n{COMMIT}\n"),
        format!("{}\n", "a".repeat(64)),
        format!("{COMMIT} extra\n"),
    ] {
        assert_eq!(
            object_ids(bad.as_bytes(), &roots, &cancel)
                .unwrap_err()
                .code,
            "recoveryInvalid"
        );
    }
    let excessive = (0..=MAX_OBJECTS)
        .map(|n| format!("{n:040x}\n"))
        .collect::<String>();
    assert_eq!(
        object_ids(excessive.as_bytes(), &roots, &cancel)
            .unwrap_err()
            .code,
        "recoveryLimit"
    );
    assert_eq!(
        object_ids(raw.as_bytes(), &roots, &AtomicBool::new(true))
            .unwrap_err()
            .code,
        "cancelled"
    );
}
#[test]
fn actual_size_parser_keeps_exact_rows_types_and_checked_256mib_sum() {
    let objects = vec![COMMIT.to_owned(), BLOB.to_owned()];
    let good = format!("{COMMIT} commit 12\n{BLOB} blob 7\n");
    let cancel = AtomicBool::new(false);
    assert_eq!(
        validate_sizes(good.as_bytes(), &objects, &cancel).unwrap(),
        19
    );
    for bad in [
        format!("{COMMIT} commit 12\n"),
        format!("{BLOB} blob 7\n{COMMIT} commit 12\n"),
        format!("{COMMIT} missing\n{BLOB} blob 7\n"),
        format!("{COMMIT} other 12\n{BLOB} blob 7\n"),
        format!("{COMMIT} commit -1\n{BLOB} blob 7\n"),
    ] {
        assert_eq!(
            validate_sizes(bad.as_bytes(), &objects, &cancel)
                .unwrap_err()
                .code,
            "recoveryInvalid"
        );
    }
    let exact = format!("{COMMIT} commit {MAX_BYTES}\n{BLOB} blob 0\n");
    assert_eq!(
        validate_sizes(exact.as_bytes(), &objects, &cancel).unwrap(),
        MAX_BYTES
    );
    let over = format!("{COMMIT} commit {MAX_BYTES}\n{BLOB} blob 1\n");
    assert_eq!(
        validate_sizes(over.as_bytes(), &objects, &cancel)
            .unwrap_err()
            .code,
        "recoveryLimit"
    );
    assert_eq!(
        validate_sizes(good.as_bytes(), &objects, &AtomicBool::new(true))
            .unwrap_err()
            .code,
        "cancelled"
    );
}
#[test]
fn graph_retains_private_namespace_observation_until_explicit_recheck_finishes() {
    let fixture = Fixture::new();
    let graph = SourceGraph::capture(&fixture.snapshot(), &AtomicBool::new(false)).unwrap();
    fs::write(fixture.private.join("MERGE_HEAD"), format!("{COMMIT}\n")).unwrap();
    assert_eq!(
        graph.recheck(&AtomicBool::new(false)).unwrap_err().code,
        "recoveryChanged"
    );
}

#[test]
fn selected_head_binary_blob_over_vec_limit_is_read_from_actual_file_and_compared_in_blocks() {
    let fixture = Fixture::new();
    for (id, data) in [
        (RAW_BINARY_BLOB, RAW_BINARY_BLOB_LOOSE),
        (RAW_BINARY_TREE, RAW_BINARY_TREE_LOOSE),
        (RAW_BINARY_COMMIT, RAW_BINARY_COMMIT_LOOSE),
    ] {
        let directory = fixture
            .private
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("objects")
            .join(&id[..2]);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(&id[2..]), data).unwrap();
    }
    let common = fixture.private.parent().unwrap().parent().unwrap();
    let public_ref = common.join("refs/heads/public");
    fs::write(&public_ref, format!("{RAW_BINARY_COMMIT}\n")).unwrap();
    let mut bytes = vec![0u8; 4 * 1024 * 1024 + 3];
    bytes[..5].copy_from_slice(&[255, 0, 128, 13, 10]);
    *bytes.last_mut().unwrap() = 127;
    fs::write(fixture.root.join("owned.txt"), &bytes).unwrap();
    let mut snapshot = fixture.snapshot();
    snapshot.head = Some(RAW_BINARY_COMMIT.into());
    let before = fixture.bytes();
    let ref_before = fs::read(&public_ref).unwrap();
    let cancel = AtomicBool::new(false);
    let graph = SourceGraph::capture(&snapshot, &cancel).unwrap();
    let selected = graph.raw_selected_blob(b"owned.txt", &cancel).unwrap();
    let got = selected.compare_source_default(&cancel).unwrap();
    assert_eq!(got.head, RAW_BINARY_COMMIT);
    assert_eq!(got.oid, RAW_BINARY_BLOB);
    assert_eq!(got.path.as_slice(), b"owned.txt");
    let held = graph
        .owner
        .source
        .scope
        .root
        .child(&"owned.txt".encode_utf16().collect::<Vec<_>>(), false)
        .unwrap();
    assert_eq!(&got.source, held.identity());
    assert!(got.raw.equal);
    assert_eq!(got.raw.expected_bytes, (4 * 1024 * 1024 + 3) as u64);
    assert_eq!(got.raw.actual_bytes, got.raw.expected_bytes);
    assert_eq!(got.raw.expected_sha256, RAW_BINARY_SHA256);
    assert_eq!(got.raw.actual_sha256, RAW_BINARY_SHA256);
    graph.recheck(&cancel).unwrap();
    assert_eq!(fixture.bytes(), before);
    assert_eq!(fs::read(&public_ref).unwrap(), ref_before);
    assert_eq!(
        fs::read(fixture.private.join("index")).unwrap(),
        EMPTY_INDEX
    );
}
#[test]
fn same_size_changed_default_is_a_raw_difference_and_unselected_or_cancelled_reads_refuse() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("owned.txt"), b"public!").unwrap();
    let before = fixture.bytes();
    let cancel = AtomicBool::new(false);
    let graph = SourceGraph::capture(&fixture.snapshot(), &cancel).unwrap();
    let got = graph
        .raw_selected_blob(b"owned.txt", &cancel)
        .unwrap()
        .compare_source_default(&cancel)
        .unwrap();
    assert!(!got.raw.equal);
    assert_eq!(got.raw.expected_bytes, 7);
    assert_eq!(got.raw.actual_bytes, 7);
    assert_ne!(got.raw.expected_sha256, got.raw.actual_sha256);
    assert_eq!(
        graph
            .raw_selected_blob(b"not-selected.txt", &cancel)
            .err()
            .unwrap()
            .code,
        "unsupportedGit"
    );
    assert_eq!(
        graph
            .raw_selected_blob(b"owned.txt", &AtomicBool::new(true))
            .err()
            .unwrap()
            .code,
        "cancelled"
    );
    assert_eq!(fixture.bytes(), before);
}
#[test]
fn raw_default_equality_with_extra_ads_does_not_open_complete_content_or_manifest_authority() {
    let fixture = Fixture::new();
    let ads = format!("{}:owned:$DATA", fixture.root.join("owned.txt").display());
    fs::write(&ads, b"must-remain-separate").unwrap();
    let before = fixture.bytes();
    let cancel = AtomicBool::new(false);
    let snapshot = fixture.snapshot();
    let graph = SourceGraph::capture(&snapshot, &cancel).unwrap();
    let got = graph
        .raw_selected_blob(b"owned.txt", &cancel)
        .unwrap()
        .compare_source_default(&cancel)
        .unwrap();
    assert!(got.raw.equal);
    assert_eq!(fs::read(&ads).unwrap(), b"must-remain-separate");
    // Equal raw default bytes say nothing about this real extra ADS, EA,
    // labels/full SD, EOL conversion, complete tree coverage or restoration.
    assert_eq!(
        crate::worktrees::recovery_pack::capture(&snapshot, &cancel)
            .unwrap_err()
            .code,
        "unsupportedGit"
    );
    assert_eq!(fixture.bytes(), before);
    assert_eq!(
        fs::read(fixture.private.join("index")).unwrap(),
        EMPTY_INDEX
    );
}

const RAW_BINARY_BLOB: &str = "02c2405d3a188c9f41f6243f127cf59609b6d44d";
const RAW_BINARY_BLOB_LOOSE: &[u8] = &[
    120, 156, 237, 193, 209, 9, 128, 32, 20, 0, 192, 247, 29, 180, 67, 35, 40, 9, 225, 58, 239, 59,
    104, 4, 221, 60, 7, 241, 238, 242, 253, 242, 106, 181, 183, 187, 60, 241, 199, 60, 143, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 216,
    217, 88, 0, 239, 5, 65,
];
const RAW_BINARY_TREE: &str = "762768cd1f07dc4e8e2e647670d95f04e040bc4b";
const RAW_BINARY_TREE_LOOSE: &[u8] = &[
    120, 156, 43, 41, 74, 77, 85, 48, 54, 103, 48, 52, 48, 48, 51, 49, 81, 200, 47, 207, 75, 77,
    209, 43, 169, 40, 97, 96, 58, 228, 16, 107, 37, 209, 51, 223, 241, 155, 138, 189, 80, 205, 215,
    105, 156, 219, 174, 248, 2, 0, 59, 103, 15, 166,
];
const RAW_BINARY_COMMIT: &str = "c50ef42982cc8ff2d5c1fe69f12d96508fce28ff";
const RAW_BINARY_COMMIT_LOOSE: &[u8] = &[
    120, 156, 141, 206, 77, 10, 194, 48, 16, 64, 97, 215, 57, 197, 236, 5, 153, 164, 249, 43, 136,
    184, 242, 30, 201, 100, 130, 1, 155, 150, 144, 218, 122, 123, 139, 39, 240, 173, 191, 197, 163,
    121, 154, 74, 7, 133, 242, 212, 27, 51, 56, 171, 156, 245, 148, 100, 70, 151, 72, 179, 103,
    197, 86, 59, 235, 48, 141, 38, 163, 102, 212, 24, 73, 71, 177, 132, 198, 181, 67, 52, 152, 83,
    136, 65, 89, 63, 16, 29, 208, 106, 147, 84, 84, 102, 160, 145, 36, 57, 51, 230, 193, 219, 108,
    68, 88, 251, 115, 110, 240, 40, 123, 95, 27, 195, 53, 223, 121, 15, 211, 242, 226, 75, 169,
    239, 240, 42, 233, 6, 18, 206, 120, 36, 232, 247, 212, 249, 63, 45, 230, 173, 114, 130, 22, 54,
    136, 165, 134, 246, 17, 95, 122, 183, 65, 147,
];
const RAW_BINARY_SHA256: [u8; 32] = [
    231, 54, 7, 153, 88, 36, 177, 96, 255, 252, 26, 153, 65, 41, 253, 51, 20, 192, 51, 223, 55,
    121, 232, 120, 124, 211, 43, 6, 66, 12, 159, 105,
];

const BLOB: &str = "a48cf0de7af6613887a8f33ce5957001234ac817";
const TREE: &str = "9d2673b5935d6cef0aef87762f72eb8862e3a78a";
const COMMIT: &str = "b50fdaba2683cc476645d2b253c9c1c759f386f5";
const BLOB_LOOSE: &[u8] = &[
    120, 156, 75, 202, 201, 79, 82, 48, 103, 40, 40, 77, 202, 201, 76, 230, 2, 0, 34, 242, 4, 128,
];
const TREE_LOOSE: &[u8] = &[
    120, 156, 43, 41, 74, 77, 85, 48, 54, 103, 48, 52, 48, 48, 51, 49, 81, 200, 47, 207, 75, 77,
    209, 43, 169, 40, 97, 88, 210, 243, 225, 94, 213, 183, 68, 139, 246, 21, 159, 109, 158, 78, 45,
    96, 84, 246, 58, 33, 14, 0, 106, 106, 17, 209,
];
const COMMIT_LOOSE: &[u8] = &[
    120, 156, 157, 141, 65, 10, 195, 32, 16, 69, 187, 246, 20, 179, 47, 132, 68, 137, 99, 160, 132,
    174, 114, 143, 81, 71, 42, 104, 13, 162, 37, 199, 111, 105, 110, 144, 191, 122, 155, 247, 190,
    43, 57, 199, 6, 19, 154, 91, 171, 204, 176, 120, 169, 81, 217, 121, 81, 179, 215, 142, 195, 72,
    28, 12, 162, 150, 1, 37, 91, 99, 180, 100, 69, 104, 72, 80, 111, 175, 82, 97, 163, 26, 74, 242,
    176, 197, 163, 245, 202, 240, 8, 39, 60, 249, 160, 188, 39, 30, 226, 251, 67, 41, 250, 21, 38,
    184, 143, 191, 9, 247, 127, 108, 124, 197, 21, 123, 183, 41, 58, 56, 27, 226, 11, 153, 18, 62,
    49,
];
const ORPHAN: &str = "2bf7ea41cb3742129b4b073f95a25bd499ee6658";
const ORPHAN_LOOSE: &[u8] = &[
    120, 156, 141, 205, 75, 10, 194, 48, 20, 70, 97, 199, 89, 197, 157, 11, 210, 38, 54, 15, 16,
    113, 228, 62, 110, 147, 63, 52, 208, 36, 37, 164, 218, 229, 43, 174, 192, 51, 254, 224, 248,
    154, 115, 234, 52, 94, 221, 169, 55, 128, 92, 144, 218, 168, 121, 114, 106, 10, 218, 35, 14,
    140, 104, 141, 209, 50, 26, 137, 217, 90, 45, 161, 216, 88, 22, 188, 247, 165, 54, 122, 166,
    163, 239, 13, 116, 139, 15, 28, 156, 183, 21, 151, 84, 94, 188, 166, 112, 167, 145, 206, 195,
    55, 225, 127, 143, 142, 255, 180, 168, 239, 130, 64, 181, 109, 11, 23, 241, 1, 184, 93, 50,
    206,
];
const EMPTY_INDEX: &[u8] = &[
    68, 73, 82, 67, 0, 0, 0, 2, 0, 0, 0, 0, 57, 216, 144, 19, 158, 229, 53, 108, 126, 245, 114, 33,
    108, 235, 205, 39, 170, 65, 249, 223,
];

#[path = "windows_managed_git_edge_tests.rs"]
mod managed_root_git_tests;
