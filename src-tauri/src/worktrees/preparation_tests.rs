use super::{
    preparation,
    storage::{Identity, SavedLocation},
    tests::{Repo, git},
    *,
};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
};

fn saved(repo: &Repo) -> SavedLocation {
    let s = inspect::snapshot(&repo.root).unwrap();
    SavedLocation {
        location: Location {
            id: tests::OP.into(),
            revision: 0,
            path: s.root.clone(),
            repository_root: s.repository_root().into(),
            head_oid: s.head.clone().unwrap(),
            branch: s.branch.clone(),
            ownership: "existing".into(),
            availability: "verified".into(),
        },
        identity: Identity::from(&s),
    }
}
fn kind(facts: &[PreparationFact], name: &str) -> PreparationNodeKind {
    facts.iter().find(|f| f.name == name).unwrap().node_kind
}
#[test]
fn preparation_relative_scope_is_exact_and_bounded() {
    assert!(preparation::relative_segments("").unwrap().is_empty());
    assert_eq!(
        preparation::relative_segments("packages/子目录").unwrap(),
        ["packages", "子目录"]
    );
    for bad in [
        "/abs",
        "../a",
        "a/../b",
        "a/./b",
        "a//b",
        "a/",
        "\\a",
        "a\\b",
        ".git",
        "a/.GiT/b",
        "a\0b",
        "a\nb",
        "a/b/c/d/e/f/g/h/i",
    ] {
        assert_eq!(
            preparation::relative_segments(bad).unwrap_err().code,
            "unsafePath",
            "{bad:?}"
        );
    }
    assert!(preparation::relative_segments(&"x".repeat(1025)).is_err());
    assert!(preparation::relative_segments("a/b/c/d/e/f/g/h").is_ok());
}
#[test]
fn preparation_reports_only_fixed_metadata_never_reads_fifo_or_symlink_content() {
    let repo = Repo::new();
    let root = &repo.root;
    fs::write(
        root.join("package.json"),
        "not JSON: SECRET_MUST_NOT_BE_READ",
    )
    .unwrap();
    fs::set_permissions(root.join("package.json"), fs::Permissions::from_mode(0)).unwrap();
    fs::create_dir(root.join("node_modules")).unwrap();
    fs::write(root.join(".env"), "PRIVATE_CANARY").unwrap();
    symlink("/controlled/nonexistent/SECRET", root.join(".venv")).unwrap();
    let fifo = std::ffi::CString::new(root.join("Cargo.lock").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let index = fs::read(root.join(".git/index")).unwrap();
    let r = preparation::collect(&saved(&repo), "").unwrap();
    assert_eq!(r.facts.len(), 22);
    assert_eq!(kind(&r.facts, "package.json"), PreparationNodeKind::File);
    assert_eq!(
        kind(&r.facts, "node_modules"),
        PreparationNodeKind::Directory
    );
    assert_eq!(kind(&r.facts, ".venv"), PreparationNodeKind::Symlink);
    assert_eq!(kind(&r.facts, "Cargo.lock"), PreparationNodeKind::Other);
    assert_eq!(kind(&r.facts, "go.mod"), PreparationNodeKind::Missing);
    assert_eq!(index, fs::read(root.join(".git/index")).unwrap());
    let wire = serde_json::to_string(&r.facts).unwrap();
    assert!(!wire.contains("SECRET") && !wire.contains("PRIVATE_CANARY") && !wire.contains(".env"));
    fs::set_permissions(root.join("package.json"), fs::Permissions::from_mode(0o600)).unwrap();
}
#[test]
fn preparation_subdirectory_is_explicit_not_root_metadata() {
    let repo = Repo::new();
    fs::create_dir_all(repo.root.join("packages/app")).unwrap();
    fs::write(repo.root.join("package.json"), "root").unwrap();
    fs::write(repo.root.join("packages/app/pyproject.toml"), "child").unwrap();
    let r = preparation::collect(&saved(&repo), "packages/app").unwrap();
    assert_eq!(kind(&r.facts, "package.json"), PreparationNodeKind::Missing);
    assert_eq!(kind(&r.facts, "pyproject.toml"), PreparationNodeKind::File);
    assert_eq!(
        Path::new(&r.project_path),
        repo.root.canonicalize().unwrap().join("packages/app")
    );
    symlink(repo.root.join("packages/app"), repo.root.join("alias")).unwrap();
    assert_eq!(
        preparation::collect(&saved(&repo), "alias")
            .unwrap_err()
            .code,
        "unsafePath"
    );
}
#[test]
fn preparation_detects_fixed_leaf_replacement_missing_creation_and_symlink_swap() {
    for mode in 0..3 {
        let repo = Repo::new();
        let path = repo.root.join("package.json");
        if mode != 1 {
            fs::write(&path, "before").unwrap();
        }
        let r = preparation::collect_with(&saved(&repo), "", || {
            if mode != 1 {
                fs::rename(&path, repo.root.join("old-file")).unwrap();
            }
            if mode == 2 {
                symlink("/controlled/secret", &path).unwrap();
            } else {
                fs::write(&path, "after!").unwrap();
            }
        });
        assert_eq!(r.unwrap_err().code, "changed");
    }
}
#[test]
fn preparation_detects_same_length_in_place_metadata_change() {
    let repo = Repo::new();
    let path = repo.root.join("package.json");
    fs::write(&path, "before").unwrap();
    assert_eq!(
        preparation::collect_with(&saved(&repo), "", || {
            fs::write(&path, "after!").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        })
        .unwrap_err()
        .code,
        "changed"
    );
}
#[test]
fn preparation_does_not_retarget_replaced_project_parent() {
    let repo = Repo::new();
    fs::create_dir_all(repo.root.join("a/b")).unwrap();
    let r = preparation::collect_with(&saved(&repo), "a/b", || {
        fs::rename(repo.root.join("a"), repo.root.join("old-a")).unwrap();
        fs::create_dir_all(repo.root.join("a/b")).unwrap();
    });
    assert_eq!(r.unwrap_err().code, "changed");
}
#[test]
fn preparation_rejects_head_change_without_running_status_or_touching_index() {
    let repo = Repo::new();
    let s = saved(&repo);
    git(&repo.root, &["commit", "--allow-empty", "-qm", "new head"]);
    let index = fs::read(repo.root.join(".git/index")).unwrap();
    assert_eq!(preparation::collect(&s, "").unwrap_err().code, "changed");
    assert_eq!(index, fs::read(repo.root.join(".git/index")).unwrap());
}
#[test]
fn preparation_git_layout_is_actual_main_and_linked_count() {
    let repo = Repo::new();
    let sibling = repo._dir.path().join("sibling");
    git(
        &repo.root,
        &[
            "worktree",
            "add",
            "-b",
            "preparation-sibling",
            sibling.to_str().unwrap(),
        ],
    );
    let main = preparation::collect(&saved(&repo), "").unwrap();
    assert_eq!(main.git.summary.kind, "main");
    assert_eq!(main.git.summary.other_worktree_count, 1);
    let s = inspect::snapshot(&sibling).unwrap();
    let mut linked = saved(&repo);
    linked.identity = Identity::from(&s);
    linked.location.path = s.root.clone();
    linked.location.branch = s.branch.clone();
    let linked = preparation::collect(&linked, "").unwrap();
    assert_eq!(linked.git.summary.kind, "linked");
    assert_eq!(linked.git.summary.other_worktree_count, 1);
}

#[test]
fn preparation_does_not_invoke_configured_hooks_fsmonitor_or_filters() {
    let repo = Repo::new();
    let canary = repo._dir.path().join("must-not-exist");
    let script = repo._dir.path().join("external-helper");
    fs::write(
        &script,
        format!("#!/bin/sh\ntouch '{}'\n", canary.display()),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let hooks = repo._dir.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    fs::copy(&script, hooks.join("post-checkout")).unwrap();
    git(
        &repo.root,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    git(
        &repo.root,
        &["config", "core.fsmonitor", script.to_str().unwrap()],
    );
    git(
        &repo.root,
        &["config", "filter.fixture.process", script.to_str().unwrap()],
    );
    fs::write(repo.root.join(".gitattributes"), "* filter=fixture\n").unwrap();
    fs::write(repo.root.join("package.json"), "metadata-only").unwrap();
    let before = fs::read(repo.root.join(".git/index")).unwrap();
    preparation::collect(&saved(&repo), "").unwrap();
    assert!(!canary.exists());
    assert_eq!(before, fs::read(repo.root.join(".git/index")).unwrap());
}
