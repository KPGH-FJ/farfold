//! Owned linked-tree source observations, not a full material restore.
use super::super::SourceGraph;
use super::*;
use crate::worktrees::{
    inspect::{self, Snapshot},
    windows_scope::Scope,
};
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

fn common(f: &Fixture) -> PathBuf {
    f.private.parent().unwrap().parent().unwrap().to_path_buf()
}
fn configure(f: &Fixture, extra: &str) {
    let file = common(f).join("config");
    let mut bytes = fs::read(&file).unwrap();
    bytes.extend_from_slice(extra.as_bytes());
    fs::write(file, bytes).unwrap();
}
#[test]
fn actual_selected_head_profile_preserves_safe_config_info_and_original_source_bytes() {
    let f = Fixture::new();
    configure(&f, "\n[core]\n autocrlf = no\n filemode = off\n");
    fs::create_dir(common(&f).join("info")).unwrap();
    fs::write(
        common(&f).join("info/attributes"),
        b"owned.txt text eol=lf -filter\n",
    )
    .unwrap();
    // Dirty working-tree attributes cannot replace selected-HEAD cached input.
    fs::write(
        f.root.join(".gitattributes"),
        b"owned.txt filter=must-not-run\n",
    )
    .unwrap();
    let before = f.bytes();
    let info = fs::read(common(&f).join("info/attributes")).unwrap();
    let graph = SourceGraph::capture(&f.snapshot(), &AtomicBool::new(false)).unwrap();
    let (configs, attributes) = graph.checkout_profile(&AtomicBool::new(false)).unwrap();
    assert!(configs.contains(&"core.autocrlf=false".to_owned()));
    assert!(configs.contains(&"core.filemode=false".to_owned()));
    let text = String::from_utf8(attributes).unwrap();
    assert!(text.contains("eol=lf"));
    assert!(text.contains("-filter"));
    assert!(text.contains(" text"));
    assert!(!text.contains("must-not-run"));
    assert_eq!(f.bytes(), before);
    assert!(f.temp.path().exists());
    assert_eq!(fs::read(common(&f).join("info/attributes")).unwrap(), info);
    assert_eq!(
        fs::read(f.root.join(".gitattributes")).unwrap(),
        b"owned.txt filter=must-not-run\n"
    );
}
#[test]
fn exact_configured_attributes_file_is_used_and_missing_setting_is_not_default_fallback() {
    let f = Fixture::new();
    let selected = f.root.join("owned.attributes");
    fs::write(&selected, b"owned.txt eol=crlf\n").unwrap();
    configure(&f, "\n[core]\n attributesFile = owned.attributes\n");
    let graph = SourceGraph::capture(&f.snapshot(), &AtomicBool::new(false)).unwrap();
    let inputs = inputs::Inputs::capture(&graph.owner, &AtomicBool::new(false)).unwrap();
    assert_eq!(inputs.attr_file(), Some(selected.as_path()));
    assert!(fs::OpenOptions::new().write(true).open(&selected).is_err());
    let (_, attributes) = graph.checkout_profile(&AtomicBool::new(false)).unwrap();
    assert!(String::from_utf8(attributes).unwrap().contains("eol=crlf"));
    drop(inputs);
    drop(graph);
    let missing = Fixture::new();
    configure(&missing, "\n[core]\n attributesFile = missing.attributes\n");
    let graph = SourceGraph::capture(&missing.snapshot(), &AtomicBool::new(false)).unwrap();
    let inputs = inputs::Inputs::capture(&graph.owner, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        inputs.attr_file(),
        Some(missing.root.join("missing.attributes").as_path())
    );
    graph.checkout_profile(&AtomicBool::new(false)).unwrap();
    assert!(!missing.root.join("missing.attributes").exists());
}
#[test]
fn custom_filter_and_literal_unset_driver_are_rejected_without_running_a_helper() {
    for (attr, config) in [
        ("filter=must-not-run", ""),
        (
            "-filter",
            "\n[filter \"unset\"]\n process = must-not-run-owned-marker\n",
        ),
    ] {
        let f = Fixture::new();
        configure(&f, config);
        fs::create_dir(common(&f).join("info")).unwrap();
        fs::write(
            common(&f).join("info/attributes"),
            format!("owned.txt {attr}\n"),
        )
        .unwrap();
        let before = f.bytes();
        let graph = SourceGraph::capture(&f.snapshot(), &AtomicBool::new(false)).unwrap();
        assert_eq!(
            graph
                .checkout_profile(&AtomicBool::new(false))
                .unwrap_err()
                .code,
            "filters"
        );
        assert_eq!(f.bytes(), before);
        assert!(!f.root.join("must-not-run-owned-marker").exists());
    }
}
#[test]
fn held_optional_source_absence_detects_creation_and_drive_relative_config_is_rejected() {
    let f = Fixture::new();
    let graph = SourceGraph::capture(&f.snapshot(), &AtomicBool::new(false)).unwrap();
    let inputs = inputs::Inputs::capture(&graph.owner, &AtomicBool::new(false)).unwrap();
    fs::create_dir(common(&f).join("info")).unwrap();
    fs::write(common(&f).join("info/attributes"), b"owned.txt eol=lf\n").unwrap();
    assert_eq!(
        inputs
            .verify(&graph.owner, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "changed"
    );
    let f = Fixture::new();
    configure(&f, "\n[core]\n attributesFile = C:relative.attributes\n");
    let graph = SourceGraph::capture(&f.snapshot(), &AtomicBool::new(false)).unwrap();
    assert_eq!(
        graph
            .checkout_profile(&AtomicBool::new(false))
            .unwrap_err()
            .code,
        "unsafePath"
    );
}
#[test]
fn cancelled_profile_never_writes_source_index_or_publishes_a_complete_recovery() {
    let f = Fixture::new();
    let before = f.bytes();
    let graph = SourceGraph::capture(&f.snapshot(), &AtomicBool::new(false)).unwrap();
    assert_eq!(
        graph
            .checkout_profile(&AtomicBool::new(true))
            .unwrap_err()
            .code,
        "cancelled"
    );
    assert_eq!(f.bytes(), before);
    // This slice has no material-content/restore authority: real capture still
    // reaches the existing unsupported Windows content-comparison gate.
    assert_eq!(
        crate::worktrees::recovery_pack::capture(&f.snapshot(), &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "unsupportedGit"
    );
    assert_eq!(fs::read(f.private.join("index")).unwrap(), EMPTY_INDEX);
}

#[test]
fn actual_cached_head_attributes_override_dirty_worktree_and_survive_mirror_evaluation() {
    let f = Fixture::new();
    for (id, bytes) in [
        (CACHED_ATTRIBUTES_BLOB, CACHED_ATTRIBUTES_BLOB_LOOSE),
        (CACHED_ATTRIBUTES_TREE, CACHED_ATTRIBUTES_TREE_LOOSE),
        (CACHED_ATTRIBUTES_COMMIT, CACHED_ATTRIBUTES_COMMIT_LOOSE),
    ] {
        let directory = common(&f).join("objects").join(&id[..2]);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(&id[2..]), bytes).unwrap();
    }
    let public_ref = common(&f).join("refs/heads/public");
    fs::write(&public_ref, format!("{CACHED_ATTRIBUTES_COMMIT}\n")).unwrap();
    let dirty = f.root.join(".gitattributes");
    fs::write(&dirty, b"owned.txt -text eol=crlf filter=must-not-run\n").unwrap();
    let mut snapshot = f.snapshot();
    snapshot.head = Some(CACHED_ATTRIBUTES_COMMIT.into());
    assert_eq!(snapshot.branch.as_deref(), Some("refs/heads/public"));
    let before = f.bytes();
    let mut preserved_paths = vec![
        public_ref,
        common(&f).join("HEAD"),
        common(&f).join("config"),
        dirty,
    ];
    for id in [
        CACHED_ATTRIBUTES_BLOB,
        CACHED_ATTRIBUTES_TREE,
        CACHED_ATTRIBUTES_COMMIT,
    ] {
        preserved_paths.push(common(&f).join("objects").join(&id[..2]).join(&id[2..]));
    }
    let preserved = preserved_paths
        .iter()
        .map(|p| fs::read(p).unwrap())
        .collect::<Vec<_>>();
    let cancel = AtomicBool::new(false);
    let graph = SourceGraph::capture(&snapshot, &cancel).unwrap();
    assert_eq!(graph.roots().head, CACHED_ATTRIBUTES_COMMIT);
    assert!(graph.objects().contains(&CACHED_ATTRIBUTES_BLOB.to_owned()));
    assert!(graph.objects().contains(&CACHED_ATTRIBUTES_TREE.to_owned()));
    assert!(
        graph
            .objects()
            .contains(&CACHED_ATTRIBUTES_COMMIT.to_owned())
    );
    let (configs, attributes) = graph.checkout_profile(&cancel).unwrap();
    let effective = std::str::from_utf8(&attributes).unwrap();
    assert!(effective.contains("eol=lf"));
    assert!(!effective.contains("eol=crlf"));
    assert!(!effective.contains("must-not-run"));
    // Consume the returned profile through official Git in a fresh owned role.
    // Fixed semantic expectations below do not reproduce the mirror algorithm.
    let mut mirrored = evaluator::Evaluator::new(&graph.owner, &configs, &cancel).unwrap();
    let paths = mirrored.paths(&cancel).unwrap();
    mirrored
        .install(evaluator::Role::Mirror, &attributes, &cancel)
        .unwrap();
    let observed = mirrored
        .attributes(evaluator::Role::Mirror, &paths, None, &cancel)
        .unwrap();
    let owned = observed.get(b"owned.txt".as_slice()).unwrap();
    assert_eq!(owned.get("text").map(String::as_str), Some("set"));
    assert_eq!(owned.get("eol").map(String::as_str), Some("lf"));
    assert_eq!(owned.get("filter").map(String::as_str), Some("unset"));
    graph.recheck(&cancel).unwrap();
    assert_eq!(f.bytes(), before);
    for (path, bytes) in preserved_paths.iter().zip(&preserved) {
        assert_eq!(&fs::read(path).unwrap(), bytes);
    }
    assert_eq!(fs::read(f.private.join("index")).unwrap(), EMPTY_INDEX);
}

const CACHED_ATTRIBUTES_BLOB: &str = "72c0366cdbe8ec5fcb861d28e75c3ccc94da68b6";
const CACHED_ATTRIBUTES_BLOB_LOOSE: &[u8] = &[
    120, 156, 75, 202, 201, 79, 82, 48, 54, 96, 200, 47, 207, 75, 77, 209, 43, 169, 40, 81, 40, 73,
    5, 18, 169, 249, 57, 182, 57, 105, 10, 186, 105, 153, 57, 37, 169, 69, 92, 0, 251, 174, 12,
    255,
];
const CACHED_ATTRIBUTES_TREE: &str = "ab633d29c14ddc78ad15a6cbce0a4417bad67619";
const CACHED_ATTRIBUTES_TREE_LOOSE: &[u8] = &[
    120, 156, 43, 41, 74, 77, 85, 48, 183, 100, 48, 52, 48, 48, 51, 49, 81, 208, 75, 207, 44, 73,
    44, 41, 41, 202, 76, 42, 45, 73, 45, 102, 40, 58, 96, 150, 115, 251, 197, 155, 248, 211, 109,
    178, 26, 207, 99, 108, 206, 76, 185, 149, 177, 13, 170, 50, 191, 60, 47, 53, 69, 175, 164, 162,
    132, 97, 73, 207, 135, 123, 85, 223, 18, 45, 218, 87, 124, 182, 121, 58, 181, 128, 81, 217,
    235, 132, 56, 0, 187, 181, 36, 46,
];
const CACHED_ATTRIBUTES_COMMIT: &str = "0aeef67f3eea63c2a68ead7e9d4b2b178e076043";
const CACHED_ATTRIBUTES_COMMIT_LOOSE: &[u8] = &[
    120, 156, 141, 142, 75, 10, 194, 64, 16, 5, 93, 207, 41, 102, 47, 72, 230, 159, 128, 136, 43,
    239, 209, 211, 221, 67, 6, 204, 135, 177, 163, 57, 190, 193, 19, 248, 54, 181, 41, 138, 135,
    203, 52, 85, 209, 182, 235, 79, 210, 152, 53, 228, 232, 28, 217, 1, 141, 39, 194, 212, 3, 153,
    0, 17, 51, 114, 7, 222, 155, 148, 129, 98, 138, 102, 80, 43, 52, 158, 69, 231, 208, 21, 130,
    12, 54, 246, 14, 209, 167, 24, 125, 32, 155, 109, 112, 120, 52, 48, 133, 161, 184, 62, 150,
    160, 96, 147, 113, 105, 250, 81, 119, 217, 26, 235, 107, 185, 243, 14, 211, 250, 228, 75, 157,
    223, 240, 172, 116, 211, 70, 159, 187, 99, 10, 127, 159, 132, 255, 179, 213, 242, 153, 153, 52,
    2, 142, 7, 64, 164, 213, 188, 9, 191, 212, 23, 217, 100, 69, 19,
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
