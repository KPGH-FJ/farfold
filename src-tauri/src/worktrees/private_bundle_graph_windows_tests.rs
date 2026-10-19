//! Proposed real Windows fixed bundle/independent graph controls; not run here.
use super::*;
use crate::worktrees::{
    inspect,
    recovery_pack::{ExportRequest, windows_first},
    recovery_roots::Roots,
    recycle_types::MaterialSummary,
    storage::Identity,
    windows_git::ReadContext,
};
use std::path::PathBuf;
struct Fixture {
    root: PathBuf,
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
        Self { root, _temp: temp }
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
    fn first(&self) -> WindowsFirst {
        let (source, expected, retained) = self.source();
        drop(source);
        windows_first(
            ExportRequest::new(&expected, &retained, &self.manifest()).unwrap(),
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

fn small(path: &Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    File::open(path)
        .unwrap()
        .take(1_048_577)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= 1_048_576);
    bytes
}
// Consumer-only invalid inputs: this testfile assembles a bounded owned
// carrier after modifying public bytes. It is not a production Git receipt.
fn owned_invalid_carrier(owner: &Context<'_>) -> Produced {
    let bridge = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(owner.root.guid_path.join("verified.bundle"))
        .unwrap();
    let (stamp, sha256) = digest_file(&bridge, &AtomicBool::new(false)).unwrap();
    Produced {
        bridge,
        producer: stamp.clone(),
        stamp,
        sha256,
    }
}
#[test]
fn real_stdout_bundle_and_two_stdin_commands_verify_independent_exact_graph() {
    let fixture = Fixture::new();
    let before = fixture.bytes();
    let first = fixture.first();
    let manifest = fixture.manifest();
    let mut graph = generate(&first, &manifest, &AtomicBool::new(false)).unwrap();
    let private = graph.owner.root.guid_path.clone();
    let bytes = small(graph.path().unwrap());
    assert!(bytes.starts_with(b"# v3 git bundle\n@object-format=sha1\n"));
    assert_ne!(
        graph.owner.second.identity(),
        first.imported.observed().unwrap().1.identity()
    );
    assert_eq!(
        digest(
            &graph.owner.bundle.as_ref().unwrap().pin,
            &AtomicBool::new(false)
        )
        .unwrap()
        .1,
        crate::worktrees::material_scan::hex(Sha256::digest(&bytes))
    );
    graph.recheck(&AtomicBool::new(false)).unwrap();
    assert_eq!(fixture.bytes(), before);
    assert_eq!(
        crate::worktrees::mutation_supported().unwrap_err().code,
        "unsupportedGit"
    );
    assert!(!crate::worktrees::read_policy::allowed(&[
        "bundle", "unbundle", "-"
    ]));
    drop(graph);
    assert!(!private.exists());
    assert!(first.path().is_dir());
    assert_eq!(fixture.bytes(), before);
}
#[test]
fn actual_stdin_verify_or_unbundle_rejects_malformed_and_truncated_owned_bundle() {
    let fixture = Fixture::new();
    let before = fixture.bytes();
    let first = fixture.first();
    let manifest = fixture.manifest();
    for truncated in [false, true] {
        let mut owner = Context::new(&first, &manifest, &AtomicBool::new(false)).unwrap();
        let root = owner.root.guid_path.clone();
        owner.check_graph(true, &AtomicBool::new(false)).unwrap();
        drop(owner.produce_bundle(&AtomicBool::new(false)).unwrap());
        let path = root.join("verified.bundle");
        if truncated {
            let bytes = small(&path);
            assert!(bytes.len() > 32);
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(24)
                .unwrap();
        } else {
            fs::write(&path, b"public malformed bundle").unwrap();
        }
        let produced = owned_invalid_carrier(&owner);
        owner
            .observe_bundle(produced, &AtomicBool::new(false))
            .unwrap();
        owner.initialize_second(&AtomicBool::new(false)).unwrap();
        assert_eq!(
            owner
                .import_bundle(&AtomicBool::new(false))
                .err()
                .unwrap()
                .code,
            "recoveryInvalid"
        );
        drop(owner);
        assert!(!root.exists());
        assert_eq!(fixture.bytes(), before);
    }
}
#[test]
fn valid_pack_with_extra_announced_ref_is_not_the_expected_recovery_graph() {
    let fixture = Fixture::new();
    let first = fixture.first();
    let manifest = fixture.manifest();
    let mut owner = Context::new(&first, &manifest, &AtomicBool::new(false)).unwrap();
    drop(owner.produce_bundle(&AtomicBool::new(false)).unwrap());
    let path = owner.root.guid_path.join("verified.bundle");
    let bytes = small(&path);
    let split = bytes.windows(2).position(|w| w == b"\n\n").unwrap() + 1;
    let mut changed = bytes[..split].to_vec();
    changed.extend_from_slice(format!("{COMMIT} refs/tags/owned-extra\n").as_bytes());
    changed.extend_from_slice(&bytes[split..]);
    fs::write(&path, changed).unwrap();
    let produced = owned_invalid_carrier(&owner);
    owner
        .observe_bundle(produced, &AtomicBool::new(false))
        .unwrap();
    owner.initialize_second(&AtomicBool::new(false)).unwrap();
    let input = owner.bundle_input(&AtomicBool::new(false)).unwrap();
    owner
        .second_action(Action::Verify(input), &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        owner
            .import_bundle(&AtomicBool::new(false))
            .err()
            .unwrap()
            .code,
        "recoveryInvalid"
    );
}
#[test]
fn mismatched_expected_objects_and_partial_profiles_never_gain_graph_success() {
    let fixture = Fixture::new();
    let first = fixture.first();
    let mut manifest = fixture.manifest();
    manifest.objects.retain(|o| o != BLOB);
    assert_eq!(
        generate(&first, &manifest, &AtomicBool::new(false))
            .err()
            .unwrap()
            .code,
        "recoveryInvalid"
    );
    let mut manifest = fixture.manifest();
    manifest.content.profile =
        Some(crate::worktrees::recycle_types::MaterialProfile::WindowsDefaultDataV1);
    assert_eq!(
        Context::new(&first, &manifest, &AtomicBool::new(false))
            .err()
            .unwrap()
            .code,
        "recoveryInvalid"
    );
    let manifest = fixture.manifest();
    assert_eq!(
        Context::new(&first, &manifest, &AtomicBool::new(true))
            .err()
            .unwrap()
            .code,
        "cancelled"
    );
}
#[test]
fn finalized_bundle_and_namespace_remain_held_until_the_graph_owner_drops() {
    let fixture = Fixture::new();
    let first = fixture.first();
    let manifest = fixture.manifest();
    let graph = generate(&first, &manifest, &AtomicBool::new(false)).unwrap();
    let path = graph.path().unwrap().to_owned();
    let root = graph.owner.root.guid_path.clone();
    assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
    assert!(fs::rename(&path, root.join("must-not-replace.bundle")).is_err());
    assert!(fs::rename(&root, fixture._temp.path().join("must-not-move")).is_err());
    graph.owner.verify().unwrap();
    drop(graph);
    assert!(!root.exists());
    assert!(first.path().is_dir());
}
#[test]
fn second_repository_ref_tamper_fails_recheck_without_changing_source() {
    let fixture = Fixture::new();
    let before = fixture.bytes();
    let first = fixture.first();
    let manifest = fixture.manifest();
    let mut graph = generate(&first, &manifest, &AtomicBool::new(false)).unwrap();
    fs::write(
        graph
            .owner
            .second
            .guid_path
            .join("refs/heads/recovery/root-0000"),
        format!("{BLOB}\n"),
    )
    .unwrap();
    assert!(graph.recheck(&AtomicBool::new(false)).is_err());
    assert_eq!(fixture.bytes(), before);
}
#[test]
fn actual_output_factory_sharing_denies_writers_and_strict_pin_until_writer_closes() {
    let fixture = Fixture::new();
    let first = fixture.first();
    let manifest = fixture.manifest();
    let mut owner = Context::new(&first, &manifest, &AtomicBool::new(false)).unwrap();
    let request = owner.prepare_output(&AtomicBool::new(false)).unwrap();
    let path = owner.root.guid_path.join("verified.bundle");
    assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
    assert!(
        owner
            .root
            .child(&"verified.bundle".encode_utf16().collect::<Vec<_>>(), false)
            .is_err()
    );
    assert!(fs::rename(&path, owner.root.guid_path.join("must-not-replace.bundle")).is_err());
    let produced = git::bundle_output::write(request, &AtomicBool::new(false)).unwrap();
    owner
        .observe_bundle(produced, &AtomicBool::new(false))
        .unwrap();
    assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
}
#[test]
fn actual_transition_rejects_a_concurrent_writer_without_claiming_immutable_output() {
    let fixture = Fixture::new();
    let first = fixture.first();
    let manifest = fixture.manifest();
    let mut owner = Context::new(&first, &manifest, &AtomicBool::new(false)).unwrap();
    let produced = owner.produce_bundle(&AtomicBool::new(false)).unwrap();
    let path = owner.root.guid_path.join("verified.bundle");
    assert!(fs::rename(&path, owner.root.guid_path.join("must-not-replace.bundle")).is_err());
    let (ready_rx, release_tx, worker) = {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let writer = fs::OpenOptions::new()
                .write(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .open(path)
                .unwrap();
            ready_tx.send(()).unwrap();
            let released = release_rx.recv_timeout(std::time::Duration::from_secs(5));
            drop(writer);
            released.unwrap();
        });
        (ready_rx, release_tx, worker)
    };
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let result = owner.observe_bundle(produced, &AtomicBool::new(false));
    let release = release_tx.send(());
    let joined = worker.join();
    release.unwrap();
    joined.unwrap();
    assert_eq!(result.unwrap_err().code, "recoveryChanged");
    assert!(owner.bundle.is_none());
}
#[test]
fn changed_bytes_during_real_transition_cannot_become_the_producer_bundle() {
    let fixture = Fixture::new();
    let first = fixture.first();
    let manifest = fixture.manifest();
    let mut owner = Context::new(&first, &manifest, &AtomicBool::new(false)).unwrap();
    let produced = owner.produce_bundle(&AtomicBool::new(false)).unwrap();
    let path = owner.root.guid_path.join("verified.bundle");
    let mut bytes = small(&path);
    *bytes.last_mut().unwrap() ^= 1;
    fs::write(&path, bytes).unwrap();
    assert_eq!(
        owner
            .observe_bundle(produced, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "recoveryChanged"
    );
    assert!(owner.bundle.is_none());
}
// Owned canonical three-object Git fixture, synthesized without invoking Git.
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
