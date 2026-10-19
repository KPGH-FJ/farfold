//! Proposed real Windows controls. No case has been run by this preparation.
use super::*;
use crate::worktrees::{recovery_roots::Roots, recycle_types::MaterialSummary, windows_git};
use std::{ffi::OsStr, fs, path::PathBuf};

struct Fixture {
    root: PathBuf,
    pack: PathBuf,
    _temp: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().canonicalize().unwrap();
        let root = parent.join("owned source");
        for name in [".git/objects", ".git/refs/heads", ".git/hooks"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        fs::write(root.join(".git/HEAD"), b"ref: refs/heads/public\n").unwrap();
        fs::write(
            root.join(".git/config"),
            b"[core]\n repositoryformatversion = 0\n bare = false\n",
        )
        .unwrap();
        fs::write(root.join(".git/refs/heads/public"), format!("{COMMIT}\n")).unwrap();
        fs::write(root.join("owned.txt"), b"public\n").unwrap();
        for (id, bytes) in [
            (BLOB, BLOB_LOOSE),
            (TREE, TREE_LOOSE),
            (COMMIT, COMMIT_LOOSE),
        ] {
            let directory = root.join(".git/objects").join(&id[..2]);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join(&id[2..]), bytes).unwrap();
        }
        let pack = parent.join("owned.pack");
        fs::write(&pack, PACK).unwrap();
        Self {
            root,
            pack,
            _temp: temp,
        }
    }
    fn source(&self) -> (ReadContext, Identity, String) {
        let source = ReadContext::open(&self.root).unwrap();
        let retained = source.scope.root.path.clone();
        let expected = Identity {
            root: retained.clone(),
            repository_root: retained.clone(),
            git_dir: source.scope.git.path.clone(),
            common_dir: source.scope.common.path.clone(),
            root_stamp: inspect::pinned_stamp(&source.scope.root).unwrap(),
            git_stamp: inspect::pinned_stamp(&source.scope.git).unwrap(),
            common_stamp: inspect::pinned_stamp(&source.scope.common).unwrap(),
        };
        (source, expected, retained)
    }
    fn manifest(&self) -> Manifest {
        let mut objects = vec![BLOB.into(), TREE.into(), COMMIT.into()];
        objects.sort();
        Manifest {
            version: 1,
            roots: Roots {
                head: COMMIT.into(),
                format: "sha1".into(),
                commits: vec![COMMIT.into()],
                files: Vec::new(),
            },
            objects,
            // This consumer checks Git objects, not a complete material restore.
            content: MaterialSummary {
                profile: None,
                entries: 0,
                bytes: 0,
                sha256: "b".repeat(64),
            },
            configs: Vec::new(),
            attributes: Vec::new(),
        }
    }
    fn import(&self) -> Imported {
        let (source, expected, retained) = self.source();
        import(
            source,
            &expected,
            &retained,
            PinnedPath::regular(&self.pack).unwrap(),
            &self.manifest(),
            &AtomicBool::new(false),
        )
        .unwrap()
    }
    fn bytes(&self) -> Vec<Vec<u8>> {
        let mut paths = vec![
            ".git/HEAD".to_owned(),
            ".git/config".into(),
            ".git/refs/heads/public".into(),
            "owned.txt".into(),
        ];
        for id in [BLOB, TREE, COMMIT] {
            paths.push(format!(".git/objects/{}/{}", &id[..2], &id[2..]));
        }
        paths
            .iter()
            .map(|p| fs::read(self.root.join(p)).unwrap())
            .collect()
    }
}
#[test]
fn actual_import_ref_install_fsck_and_exact_reachable_objects_share_the_selected_owner() {
    let fixture = Fixture::new();
    let before = fixture.bytes();
    let mut imported = fixture.import();
    let private = imported.owner.root.guid_path.clone();
    let source_program = imported.owner.source.selected_program().identity().clone();
    let input = git::Input::from_bytes(
        format!("{COMMIT}\n").as_bytes(),
        git::OUTPUT_LIMIT,
        &AtomicBool::new(false),
    )
    .unwrap();
    let raw = imported
        .owner
        .run(Action::Objects(input), &AtomicBool::new(false))
        .unwrap();
    let actual = String::from_utf8(raw)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        actual,
        [BLOB.to_owned(), TREE.to_owned(), COMMIT.to_owned()]
            .into_iter()
            .collect()
    );
    assert_eq!(
        source_program,
        *imported.owner.source.selected_program().identity()
    );
    assert_eq!(fixture.bytes(), before);
    assert!(fs::rename(&private, fixture._temp.path().join("must-not-move")).is_err());
    drop(imported);
    assert!(!private.exists());
    assert_eq!(fixture.bytes(), before);
}
#[test]
fn malformed_pack_and_wrong_object_set_fail_without_changing_the_owned_source() {
    let fixture = Fixture::new();
    let before = fixture.bytes();
    fs::write(&fixture.pack, b"not a pack").unwrap();
    let (source, expected, retained) = fixture.source();
    assert_eq!(
        import(
            source,
            &expected,
            &retained,
            PinnedPath::regular(&fixture.pack).unwrap(),
            &fixture.manifest(),
            &AtomicBool::new(false)
        )
        .err()
        .unwrap()
        .code,
        "recoveryInvalid"
    );
    assert_eq!(fixture.bytes(), before);
    fs::write(&fixture.pack, PACK).unwrap();
    let (source, expected, retained) = fixture.source();
    let mut manifest = fixture.manifest();
    manifest.objects.retain(|id| id != BLOB);
    assert_eq!(
        import(
            source,
            &expected,
            &retained,
            PinnedPath::regular(&fixture.pack).unwrap(),
            &manifest,
            &AtomicBool::new(false)
        )
        .err()
        .unwrap()
        .code,
        "recoveryInvalid"
    );
    assert_eq!(fixture.bytes(), before);
}
#[test]
fn cancelled_or_mismatched_source_identity_does_not_gain_private_execution_authority() {
    let fixture = Fixture::new();
    let before = fixture.bytes();
    let (source, expected, retained) = fixture.source();
    assert_eq!(
        import(
            source,
            &expected,
            &retained,
            PinnedPath::regular(&fixture.pack).unwrap(),
            &fixture.manifest(),
            &AtomicBool::new(true)
        )
        .err()
        .unwrap()
        .code,
        "cancelled"
    );
    let (source, mut expected, retained) = fixture.source();
    expected.root_stamp = inspect::stamp(&fixture._temp.path().canonicalize().unwrap()).unwrap();
    assert_eq!(
        import(
            source,
            &expected,
            &retained,
            PinnedPath::regular(&fixture.pack).unwrap(),
            &fixture.manifest(),
            &AtomicBool::new(false)
        )
        .err()
        .unwrap()
        .code,
        "changed"
    );
    assert_eq!(fixture.bytes(), before);
}
#[test]
fn original_project_decoy_and_existing_public_read_and_mutation_gates_remain_separate() {
    let fixture = Fixture::new();
    let (source, expected, retained) = fixture.source();
    let selected = source.selected_program().identity().clone();
    let decoy = fixture.root.join("bin");
    fs::create_dir(&decoy).unwrap();
    fs::write(decoy.join("git.exe"), b"public decoy, never execute").unwrap();
    let paths = std::env::join_paths([&decoy]).unwrap();
    assert!(windows_git::executable_from(&source.scope, &paths).is_err());
    let imported = import(
        source,
        &expected,
        &retained,
        PinnedPath::regular(&fixture.pack).unwrap(),
        &fixture.manifest(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        *imported.owner.source.selected_program().identity(),
        selected
    );
    assert!(!crate::worktrees::read_policy::allowed(&[
        "index-pack",
        "--stdin",
        "--strict"
    ]));
    assert_eq!(
        crate::worktrees::mutation_supported().unwrap_err().code,
        "unsupportedGit"
    );
    let mut partial = fixture.manifest();
    partial.content.profile =
        Some(crate::worktrees::recycle_types::MaterialProfile::WindowsDefaultDataV1);
    assert_eq!(
        super::super::validate(&partial).unwrap_err().code,
        "recoveryInvalid"
    );
}

// These helpers are test-only. They exercise the real owner's private fixed
// base prefix and original executor; no test switch is added to production.
fn probe(
    owner: &mut Context,
    args: &[&str],
    global: Option<&OsStr>,
    attributes: Option<&OsStr>,
    hooks: Option<&OsStr>,
    worktree: Option<&PinnedPath>,
) -> git::Output {
    let mut command = owner.base_command().unwrap();
    if let Some(value) = global {
        command.env("GIT_CONFIG_GLOBAL", value);
    }
    for (key, value) in [
        ("core.attributesFile=", attributes),
        ("core.hooksPath=", hooks),
    ] {
        if let Some(value) = value {
            let mut setting = std::ffi::OsString::from(key);
            setting.push(value);
            command.arg("-c").arg(setting);
        }
    }
    if let Some(tree) = worktree {
        tree.verify().unwrap();
        command
            .args(["-c", "core.bare=false"])
            .arg("--work-tree")
            .arg(&tree.guid_path);
    }
    command.args(args);
    let output = git::execute_command_input(
        command,
        git::Input::null(),
        &AtomicBool::new(false),
        std::time::Duration::from_secs(10),
    )
    .unwrap();
    owner.verify().unwrap();
    output
}
#[test]
fn real_private_prefix_null_global_has_an_owned_positive_not_a_path_guess() {
    let fixture = Fixture::new();
    let mut imported = fixture.import();
    let config = imported.owner.root.guid_path.join("owned-global");
    fs::write(&config, b"[farfold]\n control = owned\n").unwrap();
    let positive = probe(
        &mut imported.owner,
        &["config", "--global", "--get", "farfold.control"],
        Some(config.as_os_str()),
        None,
        None,
        None,
    );
    assert!(positive.success);
    assert_eq!(
        String::from_utf8(positive.bytes)
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        ["owned"]
    );
    let negative = probe(
        &mut imported.owner,
        &["config", "--global", "--get", "farfold.control"],
        None,
        None,
        None,
        None,
    );
    assert!(!negative.success);
    assert_eq!(negative.code, Some(1));
    assert!(negative.bytes.is_empty());
}
#[test]
fn real_private_prefix_null_attributes_has_an_owned_positive() {
    let fixture = Fixture::new();
    let mut imported = fixture.import();
    let attributes = imported.owner.root.guid_path.join("owned-attributes");
    fs::write(&attributes, b"owned.txt farfold-control=owned\n").unwrap();
    fs::create_dir(imported.owner.root.guid_path.join("worktree")).unwrap();
    let tree = imported
        .owner
        .root
        .child(&"worktree".encode_utf16().collect::<Vec<_>>(), true)
        .unwrap();
    let positive = probe(
        &mut imported.owner,
        &["check-attr", "--all", "--", "owned.txt"],
        None,
        Some(attributes.as_os_str()),
        None,
        Some(&tree),
    );
    assert!(positive.success);
    assert_eq!(
        String::from_utf8(positive.bytes)
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        ["owned.txt: farfold-control: owned"]
    );
    let negative = probe(
        &mut imported.owner,
        &["check-attr", "--all", "--", "owned.txt"],
        None,
        None,
        None,
        Some(&tree),
    );
    assert!(negative.success);
    assert!(negative.bytes.is_empty());
}
#[test]
fn real_private_prefix_null_hooks_has_actual_benign_hook_positive_before_guarded_absence() {
    let fixture = Fixture::new();
    let mut imported = fixture.import();
    let hooks = imported.owner.repo.guid_path.join("hooks");
    fs::create_dir_all(&hooks).unwrap();
    fs::write(
        hooks.join("reference-transaction"),
        b"#!/bin/sh\nprintf public > .owned-hook-marker\n",
    )
    .unwrap();
    let positive = probe(
        &mut imported.owner,
        &["update-ref", "refs/tags/owned-positive", COMMIT],
        None,
        None,
        Some(hooks.as_os_str()),
        None,
    );
    assert!(positive.success);
    let marker = imported.owner.repo.guid_path.join(".owned-hook-marker");
    assert!(
        marker.is_file(),
        "hook positive not observed; cannot count negative"
    );
    fs::remove_file(&marker).unwrap();
    let guarded = probe(
        &mut imported.owner,
        &["update-ref", "refs/tags/owned-guarded", COMMIT],
        None,
        None,
        None,
        None,
    );
    assert!(guarded.success);
    assert!(!marker.exists());
}

// Owned canonical three-object Git fixture, synthesized without invoking Git.
const BLOB: &str = "a48cf0de7af6613887a8f33ce5957001234ac817";
const TREE: &str = "9d2673b5935d6cef0aef87762f72eb8862e3a78a";
const COMMIT: &str = "b50fdaba2683cc476645d2b253c9c1c759f386f5";
const PACK: &[u8] = &[
    80, 65, 67, 75, 0, 0, 0, 2, 0, 0, 0, 3, 146, 11, 120, 156, 157, 140, 65, 10, 195, 32, 16, 0,
    239, 190, 98, 239, 133, 144, 42, 113, 13, 148, 210, 83, 254, 177, 234, 46, 21, 180, 6, 209,
    146, 231, 183, 144, 31, 100, 78, 115, 153, 233, 141, 25, 214, 168, 45, 26, 191, 172, 102, 137,
    54, 176, 204, 196, 226, 16, 173, 22, 212, 236, 157, 179, 154, 13, 161, 35, 69, 163, 191, 107,
    131, 141, 154, 212, 28, 97, 75, 71, 31, 141, 225, 33, 167, 188, 248, 160, 178, 103, 158, 210,
    231, 75, 57, 197, 39, 220, 225, 54, 255, 81, 161, 150, 146, 122, 231, 43, 173, 218, 135, 207,
    41, 192, 249, 80, 63, 56, 67, 58, 232, 165, 2, 120, 156, 51, 52, 48, 48, 51, 49, 81, 200, 47,
    207, 75, 77, 209, 43, 169, 40, 97, 88, 210, 243, 225, 94, 213, 183, 68, 139, 246, 21, 159, 109,
    158, 78, 45, 96, 84, 246, 58, 33, 14, 0, 11, 100, 15, 151, 55, 120, 156, 43, 40, 77, 202, 201,
    76, 230, 2, 0, 11, 122, 2, 138, 150, 141, 185, 105, 83, 18, 113, 106, 199, 212, 25, 74, 67, 39,
    150, 45, 147, 62, 147, 150,
];
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
