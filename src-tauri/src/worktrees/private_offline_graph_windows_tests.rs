//! Owned graph-only Windows controls. No full material/source build claim.
use super::*;
use crate::worktrees::{
    inspect,
    recovery_roots::Roots,
    recycle_types::{Archive, MaterialSummary},
    remove_types::Recovery,
    storage::{Identity, SavedArchive, SavedLocation},
    types::Location,
    windows_scope::Scope,
};
use std::fs;
struct Fixture {
    saved: SavedRecovery,
    manifest: Manifest,
    _temp: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let original = base.join("original");
        let retained_parent = base.join("retained");
        let retained = retained_parent.join("owned source");
        for name in [".git/objects", ".git/refs/heads"] {
            fs::create_dir_all(retained.join(name)).unwrap();
        }
        fs::write(retained.join(".git/HEAD"), b"ref: refs/heads/public\n").unwrap();
        fs::write(
            retained.join(".git/config"),
            b"[core]\n repositoryformatversion = 0\n bare = false\n",
        )
        .unwrap();
        fs::write(
            retained.join(".git/refs/heads/public"),
            format!("{COMMIT}\n"),
        )
        .unwrap();
        let scope = Scope::open(&retained).unwrap();
        let origin = scope.offline_program_origin().unwrap();
        let identity = Identity {
            root: original.to_str().unwrap().into(),
            repository_root: original.to_str().unwrap().into(),
            git_dir: original.join(".git").to_str().unwrap().into(),
            common_dir: original.join(".git").to_str().unwrap().into(),
            root_stamp: inspect::pinned_stamp(&scope.root).unwrap(),
            git_stamp: inspect::pinned_stamp(&scope.git).unwrap(),
            common_stamp: inspect::pinned_stamp(&scope.common).unwrap(),
        };
        let retained = scope.root.path.clone();
        drop(scope);
        let content = MaterialSummary {
            profile: None,
            entries: 0,
            bytes: 0,
            sha256: "b".repeat(64),
        };
        let mut objects = vec![BLOB.into(), TREE.into(), COMMIT.into()];
        objects.sort();
        let manifest = Manifest {
            version: 1,
            roots: Roots {
                head: COMMIT.into(),
                format: "sha1".into(),
                commits: vec![COMMIT.into()],
                files: Vec::new(),
            },
            objects,
            content: content.clone(),
            configs: Vec::new(),
            attributes: Vec::new(),
        };
        let root = base.join("owned recovery");
        fs::create_dir(&root).unwrap();
        // Complete public three-object pack, not a synthetic Git command result.
        let mut bundle=format!("# v3 git bundle\n@object-format=sha1\n{COMMIT} refs/heads/recovery/root-0000\n{COMMIT} HEAD\n\n").into_bytes();
        bundle.extend_from_slice(PACK);
        fs::write(root.join("recovery.bundle"), bundle).unwrap();
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let parent_stamp = inspect::stamp(&base).unwrap();
        let directory_stamp = inspect::stamp(&root).unwrap();
        let mut artifacts = Artifacts::open(
            &root,
            &base,
            &parent_stamp,
            &directory_stamp,
            &AtomicBool::new(false),
        )
        .unwrap();
        let observed = artifacts.observe(&AtomicBool::new(false)).unwrap();
        drop(artifacts);
        let archive_id = "12345678-1234-4123-8123-123456789abc".to_owned();
        let original = identity.root.clone();
        let repository_root = identity.repository_root.clone();
        let source = SavedArchive {
            removal_operation: None,
            archive: Archive {
                id: archive_id.clone(),
                revision: 0,
                original_path: original.clone(),
                retained_path: retained.clone(),
                repository_root: repository_root.clone(),
                branch: Some("public".into()),
                head_oid: COMMIT.into(),
                ownership: "created".into(),
                availability: "verified".into(),
            },
            original: SavedLocation {
                location: Location {
                    id: archive_id.clone(),
                    revision: 0,
                    path: original.clone(),
                    repository_root: repository_root.clone(),
                    branch: Some("public".into()),
                    head_oid: COMMIT.into(),
                    ownership: "created".into(),
                    availability: "verified".into(),
                },
                identity,
            },
            parent: base.to_str().unwrap().into(),
            parent_stamp: parent_stamp.clone(),
            retained_parent: retained_parent.to_str().unwrap().into(),
            retained_parent_stamp: Some(inspect::stamp(&retained_parent).unwrap()),
            material: content,
            index_sha256: None,
        };
        let saved = SavedRecovery {
            operation_id: "22345678-1234-4123-8123-123456789abc".into(),
            source,
            receipt: Recovery {
                id: "32345678-1234-4123-8123-123456789abc".into(),
                revision: 0,
                archive_id,
                archive_revision: 0,
                original_path: original,
                retained_path: retained,
                repository_root,
                head_oid: COMMIT.into(),
                branch: Some("public".into()),
                path: root.to_str().unwrap().into(),
                bundle_bytes: observed.bundle_bytes,
                bundle_sha256: observed.bundle_sha256,
                manifest_sha256: observed.manifest_sha256,
                roots_sha256: manifest.roots.summary().unwrap().sha256,
                content_sha256: manifest.content.sha256.clone(),
                root_count: 1,
                object_count: 3,
                object_format: "sha1".into(),
                availability: "verified".into(),
            },
            parent: base.to_str().unwrap().into(),
            parent_stamp,
            directory_stamp,
            bundle_stamp: observed.bundle_identity,
            manifest_stamp: observed.manifest_identity,
            windows_program_origin: Some(origin),
        };
        assert!(crate::worktrees::remove_validation::recovery(&saved));
        Self {
            saved,
            manifest,
            _temp: temp,
        }
    }
    fn artifacts(&self) -> Artifacts {
        Artifacts::open(
            std::path::Path::new(&self.saved.receipt.path),
            std::path::Path::new(&self.saved.parent),
            &self.saved.parent_stamp,
            &self.saved.directory_stamp,
            &AtomicBool::new(false),
        )
        .unwrap()
    }
    fn remove_source(&self) {
        fs::remove_dir_all(&self.saved.receipt.retained_path).unwrap();
        assert!(!std::path::Path::new(&self.saved.receipt.retained_path).exists());
        assert!(!std::path::Path::new(&self.saved.receipt.original_path).exists());
    }
}
#[test]
fn actual_owned_bundle_verifies_after_all_original_source_paths_are_absent_but_full_restore_stays_closed()
 {
    let fixture = Fixture::new();
    fixture.remove_source();
    let mut artifacts = fixture.artifacts();
    verify(
        &fixture.saved,
        &mut artifacts,
        &fixture.manifest,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        crate::worktrees::mutation_supported().unwrap_err().code,
        "unsupportedGit"
    );
    assert_eq!(
        super::super::verify(&fixture.saved, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "unsupportedGit"
    );
    assert!(!std::path::Path::new(&fixture.saved.receipt.retained_path).exists());
}
#[test]
fn missing_origin_remains_readable_but_no_offline_execution_and_explicit_null_unknown_duplicate_are_rejected()
 {
    let fixture = Fixture::new();
    let mut legacy = fixture.saved.clone();
    legacy.windows_program_origin = None;
    assert!(crate::worktrees::remove_validation::recovery(&legacy));
    let text = serde_json::to_string(&legacy).unwrap();
    assert!(!text.contains("windows_program_origin"));
    let decoded: SavedRecovery = serde_json::from_str(&text).unwrap();
    assert!(decoded.windows_program_origin.is_none());
    let mut artifacts = fixture.artifacts();
    assert_eq!(
        verify(
            &legacy,
            &mut artifacts,
            &fixture.manifest,
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .code,
        "unsupportedGit"
    );
    let mut value = serde_json::to_value(&legacy).unwrap();
    value["windows_program_origin"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<SavedRecovery>(value).is_err());
    let mut value = serde_json::to_value(&fixture.saved).unwrap();
    value["windows_program_origin"]["unexpected"] = true.into();
    assert!(serde_json::from_value::<SavedRecovery>(value).is_err());
    let origin =
        serde_json::to_string(fixture.saved.windows_program_origin.as_ref().unwrap()).unwrap();
    let duplicate = format!(
        "{{\"windows_program_origin\":{origin},\"windows_program_origin\":{origin},{}",
        &text[1..]
    );
    assert!(serde_json::from_str::<SavedRecovery>(&duplicate).is_err());
}
#[test]
fn mixed_platform_or_source_identity_metadata_cannot_authorize_installed_program_selection() {
    let fixture = Fixture::new();
    let mut value = serde_json::to_value(&fixture.saved).unwrap();
    value["windows_program_origin"]["windows"]["root"]["identity"] =
        serde_json::json!({"dev":1,"ino":2});
    let foreign: SavedRecovery = serde_json::from_value(value).unwrap();
    assert!(!crate::worktrees::remove_validation::recovery(&foreign));
    let mut artifacts = fixture.artifacts();
    assert_eq!(
        verify(
            &foreign,
            &mut artifacts,
            &fixture.manifest,
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .code,
        "unsupportedGit"
    );
    let mut changed = fixture.saved.clone();
    changed.source.original.identity.root_stamp = changed.parent_stamp.clone();
    assert!(!crate::worktrees::remove_validation::recovery(&changed));
}
#[test]
fn old_path_replacement_and_moved_original_directory_ids_both_exclude_decoy_programs() {
    let fixture = Fixture::new();
    let paths = std::env::var_os("PATH").unwrap();
    let official = select_from(&fixture.saved, &paths, &AtomicBool::new(false)).unwrap();
    let installed = official.guid_path.parent().unwrap().to_owned();
    let expected_id = official.identity().clone();
    drop(official);
    let retained = std::path::Path::new(&fixture.saved.receipt.retained_path);
    let moved = fixture._temp.path().join("moved original");
    fs::rename(retained, &moved).unwrap();
    fs::write(moved.join("git.exe"), b"public nonprogram, must not run").unwrap();
    fs::create_dir_all(retained).unwrap();
    fs::write(
        retained.join("git.exe"),
        b"replacement nonprogram, must not run",
    )
    .unwrap();
    let paths = std::env::join_paths([moved.as_path(), retained, installed.as_path()]).unwrap();
    let selected = select_from(&fixture.saved, &paths, &AtomicBool::new(false)).unwrap();
    assert_eq!(*selected.identity(), expected_id);
    let only_decoys = std::env::join_paths([moved.as_path(), retained]).unwrap();
    assert_eq!(
        select_from(&fixture.saved, &only_decoys, &AtomicBool::new(false))
            .err()
            .unwrap()
            .code,
        "gitUnavailable"
    );
}
#[test]
fn component_case_boundaries_guid_and_artifact_scope_do_not_expand_exclusions_into_unrelated_names()
{
    let fixture = Fixture::new();
    let origin = fixture.saved.windows_program_origin.as_ref().unwrap();
    let source = &fixture.saved.source.original.identity;
    let retained = &fixture.saved.receipt.retained_path;
    assert!(
        origin
            .excludes_path(
                &format!("{}\\git.exe", retained.replace("retained", "RETAINED")),
                source,
                retained
            )
            .unwrap()
    );
    assert!(
        !origin
            .excludes_path(&format!("{retained}_sibling\\git.exe"), source, retained)
            .unwrap()
    );
    fs::write(
        std::path::Path::new(&fixture.saved.receipt.path).join("git.exe"),
        b"public artifact decoy",
    )
    .unwrap();
    let only_artifact =
        std::env::join_paths([std::path::Path::new(&fixture.saved.receipt.path)]).unwrap();
    assert_eq!(
        select_from(&fixture.saved, &only_artifact, &AtomicBool::new(false))
            .err()
            .unwrap()
            .code,
        "gitUnavailable"
    );
}
#[test]
fn actual_graph_mismatch_partial_profile_and_pre_cancel_never_become_full_recovery_proof() {
    let fixture = Fixture::new();
    fixture.remove_source();
    let mut artifacts = fixture.artifacts();
    let mut wrong = fixture.manifest.clone();
    wrong.objects.retain(|id| id != BLOB);
    assert_eq!(
        verify(
            &fixture.saved,
            &mut artifacts,
            &wrong,
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .code,
        "recoveryInvalid"
    );
    let mut partial = fixture.manifest.clone();
    partial.content.profile =
        Some(crate::worktrees::recycle_types::MaterialProfile::WindowsDefaultDataV1);
    assert_eq!(
        verify(
            &fixture.saved,
            &mut artifacts,
            &partial,
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .code,
        "recoveryInvalid"
    );
    assert_eq!(
        verify(
            &fixture.saved,
            &mut artifacts,
            &fixture.manifest,
            &AtomicBool::new(true)
        )
        .unwrap_err()
        .code,
        "cancelled"
    );
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
