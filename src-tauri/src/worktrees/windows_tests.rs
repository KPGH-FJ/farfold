//! Disposable real Git fixture tests for Windows CI, never a user's repository.
use super::*;
use std::{path::Path, process::Command};
fn git(root: &Path, args: &[&str]) -> String {
    let hooks = root.join(".fixture-hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let output = Command::new("git.exe")
        .arg("-C")
        .arg(root)
        .arg("-c")
        .arg(format!("core.hooksPath={}", hooks.display()))
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "fixture Git failed");
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn repository(root: &Path) {
    std::fs::create_dir(root).unwrap();
    git(root, &["init", "-q"]);
    git(root, &["config", "core.autocrlf", "false"]);
    git(root, &["config", "user.name", "Fixture"]);
    git(root, &["config", "user.email", "fixture@example.invalid"]);
    std::fs::write(root.join("owned.txt"), "original\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "fixture"]);
}
#[test]
fn existing_main_and_linked_tree_require_exact_adopt_then_cold_recheck() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("repo with spaces");
    repository(&root);
    let linked = directory.path().join("linked tree");
    git(
        &root,
        &["worktree", "add", "-qb", "linked", linked.to_str().unwrap()],
    );
    std::fs::write(linked.join("untracked.txt"), "retain").unwrap();
    let config = std::fs::read(root.join(".git/config")).unwrap();
    let store = tests::store();
    let manager = Worktrees::default();
    let view = manager.inspect(&store, root.to_str().unwrap()).unwrap();
    let path = inspect::canonical(&linked).unwrap();
    assert!(view.trees.iter().any(|t| t.path == path));
    let op = tests::op(
        manager
            .adopt(
                &store,
                "11111111-1111-4111-8111-111111111111",
                &view.inspection_id,
                &path,
            )
            .unwrap(),
    );
    assert_eq!(op.state, "ready");
    let location = op.location.unwrap();
    let cold = Worktrees::default();
    assert_eq!(
        cold.list(&store).unwrap().locations[0].availability,
        "unknown"
    );
    assert_eq!(
        cold.check_location(&store, &location.id)
            .unwrap()
            .availability,
        "verified"
    );
    assert_eq!(
        std::fs::read(linked.join("owned.txt")).unwrap(),
        b"original\n"
    );
    assert_eq!(
        std::fs::read(linked.join("untracked.txt")).unwrap(),
        b"retain"
    );
    assert_eq!(std::fs::read(root.join(".git/config")).unwrap(), config);
    let before_unknown = store.worktree_raw().unwrap();
    assert!(matches!(
        manager.start(&store, "unknown").unwrap(),
        Reply::Unknown { .. }
    ));
    assert_eq!(store.worktree_raw().unwrap(), before_unknown);
}
#[test]
fn a_project_local_git_executable_is_not_admitted_from_absolute_path() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("repo");
    repository(&root);
    let fake = root.join("bin");
    std::fs::create_dir(&fake).unwrap();
    std::fs::write(fake.join("git.exe"), b"decoy").unwrap();
    let scope = windows_scope::Scope::open(&root).unwrap();
    let paths = std::env::join_paths([&fake]).unwrap();
    assert!(windows_git::executable_from(&scope, &paths).is_err());
}

#[test]
fn expired_or_missing_conditions_refuse_before_retirement_or_durable_intent() {
    let store = tests::store();
    let manager = Worktrees::default();
    let before = store.worktree_raw().unwrap();
    let baseline = DraftBaseline {
        unsent_work: None,
        agent_setup: None,
    };
    let mut retired = false;
    let result = manager.prepare_recycle(
        &store,
        "11111111-1111-4111-8111-111111111111",
        RecycleInput {
            inspection_id: "fixture".into(),
            action: RecycleAction::Archive,
            expected_draft_baseline: baseline.clone(),
        },
        |_| {
            retired = true;
            Ok(())
        },
    );
    let rejected = tests::op(result.unwrap());
    assert_eq!(rejected.state, "failed");
    assert_eq!(rejected.code.as_deref(), Some("inspectionExpired"));
    assert!(!retired);
    let result = manager.prepare_remove(
        &store,
        "22222222-2222-4222-8222-222222222222",
        RemoveInput {
            inspection_id: "fixture".into(),
            expected_draft_baseline: baseline,
        },
        |_| {
            retired = true;
            Ok(())
        },
    );
    let rejected = tests::op(result.unwrap());
    assert_eq!(rejected.state, "failed");
    assert_eq!(rejected.code.as_deref(), Some("inspectionExpired"));
    assert!(!retired);
    assert!(matches!(
        manager.preparation_inspect(&store, "missing", 0, "project"),
        Err(Failure { code: "missing" })
    ));
    let rejected = tests::op(
        manager
            .prepare_recover(
                &store,
                "33333333-3333-4333-8333-333333333333",
                RecoverInput {
                    recovery_id: "22222222-2222-4222-8222-222222222222".into(),
                    expected_revision: 0,
                    parent_path: r"C:\nonexistent".into(),
                    directory_name: "must-not-create".into(),
                },
            )
            .unwrap(),
    );
    assert_eq!(rejected.state, "failed");
    assert_eq!(rejected.code.as_deref(), Some("missingRecovery"));
    assert_eq!(store.worktree_raw().unwrap(), before);
}
#[test]
fn cold_non_adopt_operation_cannot_reuse_existing_location_to_become_ready() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("repo");
    repository(&root);
    let store = tests::store();
    let manager = Worktrees::default();
    let view = manager.inspect(&store, root.to_str().unwrap()).unwrap();
    let path = view.root.clone();
    let id = "11111111-1111-4111-8111-111111111111";
    manager
        .adopt(&store, id, &view.inspection_id, &path)
        .unwrap();
    let (before, mut document) = storage::read(&store).unwrap();
    let operation = document.operation.as_mut().unwrap();
    operation.request = storage::Request::Create(Create {
        inspection_id: view.inspection_id,
        parent_path: directory.path().to_str().unwrap().into(),
        directory_name: "not-created".into(),
        branch: Branch::New {
            name: "never-create".into(),
            start_oid: operation.status.location.as_ref().unwrap().head_oid.clone(),
        },
    });
    operation.status.action = "create".into();
    operation.status.state = "unknown".into();
    assert!(document.valid());
    let raw = serde_json::to_string(&document).unwrap();
    assert!(
        store
            .worktree_compare_write(before.as_deref(), &raw)
            .unwrap()
    );
    let cold = Worktrees::default();
    assert!(matches!(
        cold.recheck(&store, id),
        Err(Failure { code: "unknown" })
    ));
    assert_eq!(store.worktree_raw().unwrap().as_deref(), Some(raw.as_str()));
    assert!(!directory.path().join("not-created").exists());
}

#[test]
fn one_context_holds_shared_and_worktree_config_until_its_final_read() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("repo");
    repository(&root);
    git(&root, &["config", "extensions.worktreeConfig", "true"]);
    let config = root.join(".git/config.worktree");
    std::fs::write(&config, "[core]\n sparseCheckout = false\n").unwrap();
    let context = windows_git::ReadContext::open(&root).unwrap();
    assert!(std::fs::write(root.join(".git/config"), "replacement").is_err());
    assert!(std::fs::write(&config, "replacement").is_err());
    assert!(std::fs::rename(root.join(".git"), root.join("moved-git")).is_err());
    assert_eq!(
        context
            .config("core.sparseCheckout", true)
            .unwrap()
            .as_deref(),
        Some("false")
    );
    assert_eq!(
        context.text(&["rev-parse", "--verify", "HEAD"]).unwrap(),
        git(&root, &["rev-parse", "HEAD"])
    );
    drop(context);
    std::fs::write(config, "[core]\n sparseCheckout = true\n").unwrap();
}
#[test]
fn explicit_git_context_does_not_override_a_custom_worktree_layout() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("repo");
    repository(&root);
    git(&root, &["config", "core.worktree", "."]);
    assert!(matches!(
        windows_git::ReadContext::open(&root),
        Err(Failure {
            code: "unsupportedGit"
        })
    ));
}
#[test]
fn a_new_pointer_after_open_invalidates_the_same_context_before_another_read() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("repo");
    repository(&root);
    let context = windows_git::ReadContext::open(&root).unwrap();
    std::fs::write(root.join(".git/commondir"), "..\n").unwrap();
    assert!(matches!(
        context.text(&["rev-parse", "--verify", "HEAD"]),
        Err(Failure { code: "changed" })
    ));
}

#[test]
fn snapshot_stamps_must_equal_all_held_identities_not_just_reopened_paths() {
    let directory = crate::test_support::tempdir().unwrap();
    let root = directory.path().join("repo");
    repository(&root);
    let (snapshot, reader) = inspect::observe(&root).unwrap();
    for part in 0..3 {
        for field in ["volume", "fileId"] {
            let mut changed = snapshot.clone();
            let stamp = match part {
                0 => &mut changed.root_stamp,
                1 => &mut changed.git_stamp,
                _ => &mut changed.common_stamp,
            };
            let mut value = serde_json::to_value(&*stamp).unwrap();
            let bytes = value["windows"][field].as_array_mut().unwrap();
            let byte = bytes.last_mut().unwrap();
            *byte = serde_json::json!(byte.as_u64().unwrap() ^ 1);
            *stamp = serde_json::from_value(value).unwrap();
            assert!(matches!(
                reader.matches(&changed),
                Err(Failure { code: "changed" })
            ));
        }
    }
    reader.matches(&snapshot).unwrap();
}
