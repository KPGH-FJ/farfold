//! Disposable actual official-Git/public-Create controls for Windows CI.
use super::super::super::*;
use std::{
    fs,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git.exe")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.hooksPath=NUL", "-c", "core.fsmonitor=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "owned fixture Git failed: {:?}",
        args
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
fn repository(root: &Path) {
    fs::create_dir(root).unwrap();
    git(root, &["init", "-q"]);
    for (name, value) in [
        ("user.name", "Fixture"),
        ("user.email", "fixture@example.invalid"),
        ("core.autocrlf", "false"),
    ] {
        git(root, &["config", name, value]);
    }
}
fn input(
    manager: &Worktrees,
    store: &crate::meta_store::MetaStore,
    root: &Path,
    parent: &Path,
    oid: &str,
) -> Create {
    let inspected = manager.inspect(store, root.to_str().unwrap()).unwrap();
    Create {
        inspection_id: inspected.inspection_id,
        parent_path: inspect::canonical(parent).unwrap(),
        directory_name: "created selected tree".into(),
        branch: Branch::New {
            name: "owned-create-control".into(),
            start_oid: oid.into(),
        },
    }
}
fn isolated_full_security(name: &str, body: impl FnOnce()) {
    let arguments: Vec<_> = std::env::args().collect();
    if arguments.iter().any(|s| s == name) && arguments.iter().any(|s| s == "--exact") {
        body();
        println!("completed:{name}");
        return;
    }
    use std::io::{Read, Seek};
    let mut log = tempfile::tempfile().unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            name,
            "--exact",
            "--ignored",
            "--test-threads=1",
            "--nocapture",
        ])
        .stdout(log.try_clone().unwrap())
        .stderr(log.try_clone().unwrap())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(150);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("owned full-security public operation deadline");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    log.rewind().unwrap();
    let mut text = String::new();
    log.take(262144).read_to_string(&mut text).unwrap();
    assert!(
        status.success() && text.contains(&format!("completed:{name}")),
        "{text}"
    );
    println!("{text}");
}
#[test]
fn public_create_materializes_selected_old_oid_and_source_profile_without_touching_source() {
    let temporary = crate::test_support::tempdir().unwrap();
    let root = temporary.path().join("owned source");
    repository(&root);
    fs::write(root.join(".gitattributes"), "*.txt text eol=crlf\n").unwrap();
    fs::write(root.join("payload.txt"), b"selected\nline\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "selected"]);
    let selected = git(&root, &["rev-parse", "HEAD"]);
    git(&root, &["branch", "selected-kept", &selected]);
    fs::write(root.join("payload.txt"), b"new head\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "new head"]);
    fs::write(root.join(".gitattributes"), "*.txt filter=must-not-run\n").unwrap();
    fs::write(root.join("payload.txt"), b"dirty source\n").unwrap();
    fs::write(root.join("untracked.bin"), [0, 1, 0xff, 3]).unwrap();
    let kept = [
        ".gitattributes",
        "payload.txt",
        "untracked.bin",
        ".git/index",
        ".git/config",
    ];
    let before = kept.map(|path| fs::read(root.join(path)).unwrap());
    let store = tests::store();
    let manager = Worktrees::default();
    let request = input(&manager, &store, &root, temporary.path(), &selected);
    let id = "11111111-1111-4111-8111-111111111111";
    assert_eq!(
        tests::op(manager.prepare(&store, id, request).unwrap()).state,
        "prepared"
    );
    let target = temporary.path().join("created selected tree");
    assert!(!target.exists());
    assert_eq!(
        tests::op(manager.start(&store, id).unwrap()).state,
        "running"
    );
    let deadline = Instant::now() + Duration::from_secs(45);
    let finished = loop {
        let current = tests::op(manager.status(&store, id).unwrap());
        if current.settled {
            break current;
        }
        assert!(
            Instant::now() < deadline,
            "Create did not settle: {}",
            current.state
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(finished.state, "ready", "{:?}", finished);
    assert_eq!(finished.location.unwrap().ownership, "created");
    assert_eq!(
        fs::read(target.join("payload.txt")).unwrap(),
        b"selected\r\nline\r\n"
    );
    assert_eq!(git(&target, &["rev-parse", "HEAD"]), selected);
    assert_eq!(
        git(&target, &["status", "--porcelain", "--untracked-files=all"]),
        ""
    );
    for (path, before) in kept.into_iter().zip(before) {
        assert_eq!(fs::read(root.join(path)).unwrap(), before);
    }
    assert!(!target.join("untracked.bin").exists());
}
#[test]
fn selected_custom_filter_is_rejected_before_target_or_branch_creation() {
    let temporary = crate::test_support::tempdir().unwrap();
    let root = temporary.path().join("owned source");
    repository(&root);
    fs::write(
        root.join(".gitattributes"),
        "payload.txt filter=must-not-run\n",
    )
    .unwrap();
    fs::write(root.join("payload.txt"), "owned\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "filtered"]);
    let selected = git(&root, &["rev-parse", "HEAD"]);
    let before = fs::read(root.join(".git/index")).unwrap();
    let store = tests::store();
    let manager = Worktrees::default();
    let request = input(&manager, &store, &root, temporary.path(), &selected);
    let result = tests::op(
        manager
            .prepare(&store, "11111111-1111-4111-8111-111111111111", request)
            .unwrap(),
    );
    assert_eq!(result.state, "failed");
    assert_eq!(result.code.as_deref(), Some("filters"));
    assert!(!temporary.path().join("created selected tree").exists());
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), before);
    assert_eq!(
        git(&root, &["branch", "--list", "owned-create-control"]),
        ""
    );
}

#[test]
#[ignore = "manual: actual NTFS and existing combined FullSecurity rights; public Create Archive Restore, no privilege adjustment"]
fn public_create_archive_restore_keeps_same_tree_and_both_official_git_pointers() {
    isolated_full_security(
        "worktrees::create::windows::tests::public_create_archive_restore_keeps_same_tree_and_both_official_git_pointers",
        || {
            let temporary = crate::test_support::tempdir().unwrap();
            let root = temporary.path().join("owned source");
            repository(&root);
            fs::write(root.join("payload.txt"), b"retained content\n").unwrap();
            git(&root, &["add", "."]);
            git(&root, &["commit", "-qm", "source"]);
            let oid = git(&root, &["rev-parse", "HEAD"]);
            let source_index = fs::read(root.join(".git/index")).unwrap();
            let source_config = fs::read(root.join(".git/config")).unwrap();
            let store = tests::store();
            let manager = Worktrees::default();
            let request = input(&manager, &store, &root, temporary.path(), &oid);
            let id = "11111111-1111-4111-8111-111111111111";
            let prepared = manager.prepare(&store, id, request).unwrap();
            if let Reply::Operation(operation) = &prepared
                && operation.state != "prepared"
            {
                eprintln!(
                    "FARFOLD_PUBLIC_FIXTURE_OPERATION phase=createPrepare state={} code={:?} settled={}",
                    operation.state, operation.code, operation.settled
                );
            }
            manager.start(&store, id).unwrap();
            let created = super::super::super::recycle_tests::wait(&manager, &store, id);
            assert_eq!(
                created.state, "ready",
                "FARFOLD_PUBLIC_FIXTURE_OPERATION phase=createStart code={:?} settled={}",
                created.code, created.settled
            );
            let location = created.location.unwrap();
            let target = Path::new(&location.path);
            fs::write(target.join("untracked.bin"), [0, 255, 2]).unwrap();
            let original_id = crate::file_access::PinnedPath::directory(target)
                .unwrap()
                .identity()
                .clone();
            let index = git(target, &["rev-parse", "--absolute-git-dir"]);
            let index_bytes = fs::read(Path::new(&index).join("index")).unwrap();
            let archive_id = "22222222-2222-4222-8222-222222222222";
            let inspection = manager
                .recycle_inspect(
                    &store,
                    RecycleAction::Archive,
                    &location.id,
                    location.revision,
                )
                .unwrap();
            super::super::super::recycle_tests::prepare(&manager, &store, archive_id, inspection);
            manager.start(&store, archive_id).unwrap();
            let archived = super::super::super::recycle_tests::wait(&manager, &store, archive_id);
            assert_eq!(archived.state, "ready", "{archived:?}");
            let archive = archived.archive.unwrap();
            assert!(!target.exists());
            let retained = Path::new(&archive.retained_path);
            assert_eq!(
                crate::file_access::PinnedPath::directory(retained)
                    .unwrap()
                    .identity(),
                &original_id
            );
            assert_eq!(git(retained, &["rev-parse", "HEAD"]), oid);
            assert_eq!(git(retained, &["rev-parse", "--absolute-git-dir"]), index);
            assert_eq!(
                fs::read(Path::new(&index).join("index")).unwrap(),
                index_bytes
            );
            assert_eq!(
                fs::read(retained.join("untracked.bin")).unwrap(),
                [0, 255, 2]
            );
            let restore_id = "33333333-3333-4333-8333-333333333333";
            let inspection = manager
                .recycle_inspect(
                    &store,
                    RecycleAction::Restore,
                    &archive.id,
                    archive.revision,
                )
                .unwrap();
            super::super::super::recycle_tests::prepare(&manager, &store, restore_id, inspection);
            manager.start(&store, restore_id).unwrap();
            let restored = super::super::super::recycle_tests::wait(&manager, &store, restore_id);
            assert_eq!(restored.state, "ready", "{restored:?}");
            assert!(!retained.exists());
            assert_eq!(restored.location.unwrap().path, location.path);
            assert_eq!(
                crate::file_access::PinnedPath::directory(target)
                    .unwrap()
                    .identity(),
                &original_id
            );
            assert_eq!(git(target, &["rev-parse", "HEAD"]), oid);
            assert_eq!(fs::read(root.join(".git/index")).unwrap(), source_index);
            assert_eq!(fs::read(root.join(".git/config")).unwrap(), source_config);
            assert_eq!(
                fs::read(Path::new(&index).join("index")).unwrap(),
                index_bytes
            );
            assert_eq!(fs::read(target.join("untracked.bin")).unwrap(), [0, 255, 2]);
        },
    );
}
