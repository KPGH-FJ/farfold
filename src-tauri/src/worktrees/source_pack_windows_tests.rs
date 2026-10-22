//! Proposed real Windows source-export controls; no case executed in preparation.
use super::*;
use crate::worktrees::{
    recovery_roots::Roots, recycle_types::MaterialSummary, storage::Identity, windows_git,
    windows_git::ReadContext,
};
use std::{fs, path::PathBuf};
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
            windows_material: None,
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
    fn first(&self) -> WindowsFirst {
        let (source, expected, retained) = self.source();
        drop(source);
        windows_first(
            ExportRequest::new(&expected, &retained, &self.manifest()).unwrap(),
            &AtomicBool::new(false),
        )
        .unwrap()
    }
    fn bytes_without_blob(&self) -> Vec<Vec<u8>> {
        [
            ".git/HEAD",
            ".git/config",
            ".git/refs/heads/public",
            "owned.txt",
        ]
        .iter()
        .map(|p| fs::read(self.root.join(p)).unwrap())
        .collect()
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
fn real_source_export_then_existing_import_checks_exact_objects_without_source_writes() {
    let fixture = Fixture::new();
    let before = fixture.bytes();
    fs::write(
        &fixture.pack,
        b"untrusted sibling output, must never be imported",
    )
    .unwrap();
    let first = fixture.first();
    let private = first.path().to_owned();
    assert!(private.is_dir());
    assert_eq!(fixture.bytes(), before);
    assert!(!crate::worktrees::read_policy::allowed(&[
        "pack-objects",
        "--stdout",
        "--revs"
    ]));
    assert_eq!(
        crate::worktrees::mutation_supported().unwrap_err().code,
        "unsupportedGit"
    );
    drop(first);
    assert!(!private.exists());
    assert_eq!(fixture.bytes(), before);
}
#[test]
fn real_export_output_and_source_authority_stay_owned_until_import_finishes() {
    let fixture = Fixture::new();
    let before = fixture.bytes();
    let (old, identity, retained) = fixture.source();
    let selected = old.selected_program().identity().clone();
    drop(old);
    let manifest = fixture.manifest();
    let exported = git::source_export::export(
        ExportRequest::new(&identity, &retained, &manifest).unwrap(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let (source, pack, namespace) = exported.into_parts().unwrap();
    assert_eq!(*source.selected_program().identity(), selected);
    let generated = pack.guid_path.parent().unwrap().to_owned();
    let bytes = fs::read(&pack.guid_path).unwrap();
    assert!(bytes.len() >= 32);
    assert_eq!(&bytes[..4], b"PACK");
    assert_eq!(u32::from_be_bytes(bytes[8..12].try_into().unwrap()), 3);
    assert!(fs::rename(&generated, fixture._temp.path().join("must-not-rename")).is_err());
    let imported = private_bare::import(
        source,
        &identity,
        &retained,
        pack,
        &manifest,
        &AtomicBool::new(false),
    )
    .unwrap();
    namespace.verify().unwrap();
    assert_eq!(fixture.bytes(), before);
    drop(imported);
    drop(namespace);
    assert!(!generated.exists());
    assert_eq!(fixture.bytes(), before);
}
#[test]
fn cancelled_or_wrong_source_request_has_no_export_success() {
    let fixture = Fixture::new();
    let before = fixture.bytes();
    let (source, mut identity, retained) = fixture.source();
    drop(source);
    let manifest = fixture.manifest();
    let request = ExportRequest::new(&identity, &retained, &manifest).unwrap();
    assert_eq!(
        git::source_export::export(request, &AtomicBool::new(true))
            .err()
            .unwrap()
            .code,
        "cancelled"
    );
    identity.root_stamp = inspect::stamp(&fixture._temp.path().canonicalize().unwrap()).unwrap();
    assert_eq!(
        git::source_export::export(
            ExportRequest::new(&identity, &retained, &manifest).unwrap(),
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
fn roots_cannot_inject_revision_options_and_partial_material_still_cannot_export() {
    let fixture = Fixture::new();
    let (source, identity, retained) = fixture.source();
    drop(source);
    let mut manifest = fixture.manifest();
    manifest.roots.commits.push("--all\n--not".into());
    assert_eq!(
        ExportRequest::new(&identity, &retained, &manifest)
            .err()
            .unwrap()
            .code,
        "recoveryInvalid"
    );
    let mut manifest = fixture.manifest();
    manifest.roots.format = "sha256".into();
    assert_eq!(
        ExportRequest::new(&identity, &retained, &manifest)
            .err()
            .unwrap()
            .code,
        "recoveryInvalid"
    );
    let mut manifest = fixture.manifest();
    manifest.content.profile =
        Some(crate::worktrees::recycle_types::MaterialProfile::WindowsDefaultDataV1);
    assert_eq!(
        ExportRequest::new(&identity, &retained, &manifest)
            .err()
            .unwrap()
            .code,
        "recoveryInvalid"
    );
}
#[test]
fn missing_source_objects_fail_and_absolute_project_program_decoy_is_not_authority() {
    let fixture = Fixture::new();
    let decoy = fixture.root.join("owned-bin");
    fs::create_dir(&decoy).unwrap();
    fs::write(decoy.join("git.exe"), b"public decoy, never execute").unwrap();
    let (source, identity, retained) = fixture.source();
    let paths = std::env::join_paths([&decoy]).unwrap();
    assert!(windows_git::executable_from(&source.scope, &paths).is_err());
    drop(source);
    fs::remove_file(
        fixture
            .root
            .join(format!(".git/objects/{}/{}", &BLOB[..2], &BLOB[2..])),
    )
    .unwrap();
    let before = fixture.bytes_without_blob();
    let manifest = fixture.manifest();
    assert_eq!(
        windows_first(
            ExportRequest::new(&identity, &retained, &manifest).unwrap(),
            &AtomicBool::new(false)
        )
        .err()
        .unwrap()
        .code,
        "recoveryInvalid"
    );
    assert_eq!(fixture.bytes_without_blob(), before);
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
