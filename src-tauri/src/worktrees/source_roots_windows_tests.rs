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
fn real_private_roots_consumer_keeps_deleted_reflog_commits_without_mutating_source() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let before = fixture.bytes();
    let roots =
        crate::worktrees::recovery_roots::capture(&snapshot, &AtomicBool::new(false)).unwrap();
    let expected = BTreeSet::from([COMMIT.to_owned(), ORPHAN.to_owned()]);
    assert_eq!(
        roots.commits.iter().cloned().collect::<BTreeSet<_>>(),
        expected
    );
    assert_eq!(roots.format, "sha1");
    assert_eq!(roots.head, COMMIT);
    assert!(
        roots
            .files
            .iter()
            .any(|f| f.path == "logs/refs/worktree/deleted")
    );
    assert!(!roots.files.iter().any(|f| skipped(&f.path)));
    assert!(!roots.commits.iter().any(|id| id == BLOB || id == TREE));
    assert_eq!(fixture.bytes(), before);
    assert!(fixture.temp.path().exists());
}
#[test]
fn orphan_reflog_fingerprint_changes_even_when_its_commit_set_does_not() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let cancel = AtomicBool::new(false);
    let before = crate::worktrees::recovery_roots::capture(&snapshot, &cancel).unwrap();
    fs::write(
        fixture.private.join("logs/refs/worktree/deleted"),
        format!("{ORPHAN} {COMMIT} Fixture <f@example.invalid> 2 +0000\tchanged\n"),
    )
    .unwrap();
    let after = crate::worktrees::recovery_roots::capture(&snapshot, &cancel).unwrap();
    assert_eq!(before.commits, after.commits);
    assert_ne!(before.summary().unwrap(), after.summary().unwrap());
    assert_eq!(
        fs::read(fixture.private.join("index")).unwrap(),
        EMPTY_INDEX
    );
}
#[test]
fn unknown_private_state_noncommit_ref_and_cancel_are_not_silently_omitted() {
    let fixture = Fixture::new();
    let snapshot = fixture.snapshot();
    let cancel = AtomicBool::new(false);
    fs::write(fixture.private.join("MERGE_HEAD"), format!("{COMMIT}\n")).unwrap();
    assert_eq!(
        crate::worktrees::recovery_roots::capture(&snapshot, &cancel)
            .unwrap_err()
            .code,
        "unprovenPrivateCommits"
    );
    fs::remove_file(fixture.private.join("MERGE_HEAD")).unwrap();
    fs::write(
        fixture.private.join("refs/worktree/kept"),
        format!("{BLOB}\n"),
    )
    .unwrap();
    assert_eq!(
        crate::worktrees::recovery_roots::capture(&snapshot, &cancel)
            .unwrap_err()
            .code,
        "unprovenPrivateCommits"
    );
    assert_eq!(
        crate::worktrees::recovery_roots::capture(&snapshot, &AtomicBool::new(true))
            .unwrap_err()
            .code,
        "cancelled"
    );
    assert_eq!(
        fs::read(fixture.private.join("index")).unwrap(),
        EMPTY_INDEX
    );
}
#[test]
fn held_inventory_denies_metadata_writers_and_rechecks_complete_private_namespace() {
    let fixture = Fixture::new();
    let scope = Scope::open(&fixture.root).unwrap();
    let cancel = AtomicBool::new(false);
    let inventory = Inventory::capture(&scope.git, &cancel).unwrap();
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(fixture.private.join("index"))
            .is_err()
    );
    inventory.verify(&scope.git, &cancel).unwrap();
    fs::write(fixture.private.join("MERGE_HEAD"), format!("{COMMIT}\n")).unwrap();
    assert_eq!(
        inventory.verify(&scope.git, &cancel).unwrap_err().code,
        "recoveryChanged"
    );
}

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
