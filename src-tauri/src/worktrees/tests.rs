use super::*;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
pub(crate) struct Repo {
    pub(crate) _dir: tempfile::TempDir,
    pub(crate) root: PathBuf,
}
pub(crate) fn git(root: &Path, args: &[&str]) -> String {
    #[cfg(windows)]
    let (program, hooks) = {
        let hooks = root.join(".fixture-hooks");
        fs::create_dir_all(&hooks).unwrap();
        ("git.exe", format!("core.hooksPath={}", hooks.display()))
    };
    #[cfg(not(windows))]
    let (program, hooks) = ("/usr/bin/git", "core.hooksPath=/dev/null".to_owned());
    git_with_hooks(root, args, program, &hooks)
}

// Inspect recovered material without adding a test hook directory to that tree.
pub(super) fn recovered_remotes(root: &Path) -> String {
    #[cfg(windows)]
    let (program, hooks) = ("git.exe", "core.hooksPath=NUL");
    #[cfg(not(windows))]
    let (program, hooks) = ("/usr/bin/git", "core.hooksPath=/dev/null");
    git_with_hooks(root, &["remote"], program, hooks)
}

fn git_with_hooks(root: &Path, args: &[&str], program: &str, hooks: &str) -> String {
    let o = Command::new(program)
        .arg("-C")
        .arg(root)
        .arg("-c")
        .arg(hooks)
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "fixture git {:?}: {}",
        args,
        String::from_utf8_lossy(&o.stderr)
    );
    String::from_utf8(o.stdout).unwrap().trim().into()
}
impl Repo {
    pub(crate) fn new() -> Self {
        let d = crate::test_support::tempdir().unwrap();
        let r = d.path().join("repo");
        fs::create_dir(&r).unwrap();
        git(&r, &["init", "-q"]);
        git(&r, &["config", "user.name", "Fixture"]);
        git(&r, &["config", "user.email", "fixture@example.invalid"]);
        fs::write(r.join("a.txt"), "fixture").unwrap();
        git(&r, &["add", "."]);
        git(&r, &["commit", "-qm", "initial"]);
        Self { _dir: d, root: r }
    }
}
#[test]
fn selected_old_commit_filter_is_not_replaced_by_current_index_attributes() {
    let r = Repo::new();
    fs::write(r.root.join(".gitattributes"), "*.txt filter=owned-probe\n").unwrap();
    git(&r.root, &["add", "."]);
    git(&r.root, &["commit", "-qm", "filtered target"]);
    let old = git(&r.root, &["rev-parse", "HEAD"]);
    fs::write(r.root.join(".gitattributes"), "").unwrap();
    git(&r.root, &["add", "."]);
    git(&r.root, &["commit", "-qm", "current no filter"]);
    let s = inspect::snapshot(&r.root).unwrap();
    assert_eq!(inspect::check_target(&s, &old).unwrap_err().code, "filters");
}

pub(crate) fn store() -> crate::meta_store::MetaStore {
    crate::meta_store::MetaStore::test_memory()
}
pub(crate) fn op(reply: Reply) -> Operation {
    match reply {
        Reply::Operation(op) => *op,
        _ => panic!("expected exact operation"),
    }
}
pub(crate) fn input(
    m: &Worktrees,
    s: &crate::meta_store::MetaStore,
    r: &Repo,
    branch: Branch,
    name: &str,
) -> Create {
    let inspection = m.inspect(s, r.root.to_str().unwrap()).unwrap();
    Create {
        inspection_id: inspection.inspection_id,
        parent_path: r
            ._dir
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        directory_name: name.into(),
        branch,
    }
}
pub(crate) const OP: &str = "12345678-1234-4123-8123-123456789abc";
pub(crate) fn wait(m: &Worktrees, s: &crate::meta_store::MetaStore) -> Operation {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let value = op(m.status(s, OP).unwrap());
        if value.settled {
            return value;
        }
        assert!(
            std::time::Instant::now() < end,
            "worktree operation did not settle"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
#[test]
fn creates_exact_new_branch_preserves_original_index_dirty_ignored_and_disables_hook() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    let oid = git(&r.root, &["rev-parse", "HEAD"]);
    fs::write(r.root.join("a.txt"), "unsaved original").unwrap();
    fs::write(r.root.join(".gitignore"), "ignored\n").unwrap();
    fs::write(r.root.join("ignored"), "private ignored").unwrap();
    let index = fs::read(r.root.join(".git/index")).unwrap();
    let hook = r.root.join(".git/hooks/post-checkout");
    fs::write(&hook, "#!/bin/sh\nprintf called > hook-was-run\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let args = input(
        &m,
        &s,
        &r,
        Branch::New {
            name: "codex/temp-owned".into(),
            start_oid: oid.clone(),
        },
        "new-location",
    );
    assert_eq!(op(m.prepare(&s, OP, args).unwrap()).state, "prepared");
    assert!(!r._dir.path().join("new-location").exists());
    assert_eq!(op(m.start(&s, OP).unwrap()).state, "running");
    let result = wait(&m, &s);
    assert_eq!(result.state, "ready", "{result:?}");
    let location = result.location.unwrap();
    assert_eq!(
        fs::read_to_string(Path::new(&location.path).join("a.txt")).unwrap(),
        "fixture"
    );
    assert!(!Path::new(&location.path).join("hook-was-run").exists());
    assert_eq!(
        git(Path::new(&location.path), &["status", "--porcelain"]),
        ""
    );
    assert_eq!(location.head_oid, oid);
    assert_eq!(fs::read(r.root.join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(r.root.join("a.txt")).unwrap(),
        "unsaved original"
    );
    assert_eq!(
        fs::read_to_string(r.root.join("ignored")).unwrap(),
        "private ignored"
    );
    assert_eq!(op(m.start(&s, OP).unwrap()).state, "ready");
    assert_eq!(m.list(&s).unwrap().locations.len(), 1);
    let fresh = m.check_location(&s, OP).unwrap();
    assert_eq!(fresh.availability, "verified");
    assert!(m.forget(&s, OP, location.revision).is_err());
    assert!(m.forget(&s, OP, fresh.revision).unwrap().forgotten);
    assert!(Path::new(&location.path).exists());
}
#[test]
fn registered_unused_filter_is_allowed_but_effective_info_attribute_is_rejected_without_execution()
{
    let r = Repo::new();
    git(
        &r.root,
        &[
            "config",
            "filter.owned.smudge",
            "sh -c 'touch filter-called; cat'",
        ],
    );
    git(&r.root, &["config", "filter.owned.clean", "cat"]);
    let snap = inspect::snapshot(&r.root).unwrap();
    assert!(!snap.blockers.contains(&"filters".into()));
    inspect::check_target(&snap, snap.head.as_ref().unwrap()).unwrap();
    fs::write(r.root.join(".git/info/attributes"), "a.txt filter=owned\n").unwrap();
    assert_eq!(
        inspect::check_target(&snap, snap.head.as_ref().unwrap())
            .unwrap_err()
            .code,
        "filters"
    );
    assert!(!r.root.join("filter-called").exists());
}
#[test]
fn existing_branch_and_checkout_transforms_modes_links_are_preserved() {
    let r = Repo::new();
    fs::write(r.root.join("a.txt"), "hello\nworld\n").unwrap();
    fs::write(r.root.join(".gitattributes"), "a.txt text eol=crlf\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::{PermissionsExt, symlink};
        fs::set_permissions(r.root.join("a.txt"), fs::Permissions::from_mode(0o755)).unwrap();
        symlink("a.txt", r.root.join("alias")).unwrap();
    }
    git(&r.root, &["add", "."]);
    git(&r.root, &["commit", "-qm", "types"]);
    let oid = git(&r.root, &["rev-parse", "HEAD"]);
    git(&r.root, &["branch", "existing"]);
    let s = store();
    let m = Worktrees::default();
    let args = input(
        &m,
        &s,
        &r,
        Branch::Existing {
            r#ref: "refs/heads/existing".into(),
            expected_oid: oid,
        },
        "existing-location",
    );
    assert_eq!(op(m.prepare(&s, OP, args).unwrap()).state, "prepared");
    m.start(&s, OP).unwrap();
    let result = wait(&m, &s);
    assert_eq!(result.state, "ready", "{result:?}");
    let p = PathBuf::from(result.location.unwrap().path);
    assert_eq!(fs::read(p.join("a.txt")).unwrap(), b"hello\r\nworld\r\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_ne!(
            fs::metadata(p.join("a.txt")).unwrap().permissions().mode() & 0o111,
            0
        );
        assert_eq!(fs::read_link(p.join("alias")).unwrap(), Path::new("a.txt"));
    }
    assert_eq!(git(&p, &["status", "--porcelain"]), "");
}
#[test]
fn prepared_cancel_never_creates_or_restarts_and_unknown_id_never_starts() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    let oid = git(&r.root, &["rev-parse", "HEAD"]);
    let args = input(
        &m,
        &s,
        &r,
        Branch::New {
            name: "cancelled".into(),
            start_oid: oid,
        },
        "cancelled",
    );
    m.prepare(&s, OP, args.clone()).unwrap();
    assert_eq!(op(m.cancel(&s, OP).unwrap()).state, "cancelled");
    assert_eq!(op(m.start(&s, OP).unwrap()).state, "cancelled");
    assert_eq!(op(m.prepare(&s, OP, args).unwrap()).state, "cancelled");
    assert!(!r._dir.path().join("cancelled").exists());
    assert!(matches!(
        m.start(&s, "ffffffff-ffff-4fff-8fff-ffffffffffff").unwrap(),
        Reply::Unknown { .. }
    ));
}
#[test]
fn existing_target_nested_path_in_use_branch_and_changed_ref_do_not_write() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    let inspection = m.inspect(&s, r.root.to_str().unwrap()).unwrap();
    let oid = inspection.head.oid.unwrap();
    let branch = inspection.head.branch.unwrap();
    let args = Create {
        inspection_id: inspection.inspection_id,
        parent_path: r
            ._dir
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        directory_name: "repo".into(),
        branch: Branch::Existing {
            r#ref: branch,
            expected_oid: oid,
        },
    };
    let result = op(m.prepare(&s, OP, args).unwrap());
    assert_eq!(result.state, "failed");
    assert_eq!(result.code.as_deref(), Some("targetExists"));
    assert_eq!(m.list(&s).unwrap().locations.len(), 0);
}
#[test]
fn adopt_existing_and_cold_recheck_require_same_os_and_git_identity() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    let inspection = m.inspect(&s, r.root.to_str().unwrap()).unwrap();
    let reply = op(m
        .adopt(&s, OP, &inspection.inspection_id, &inspection.root)
        .unwrap());
    assert_eq!(reply.state, "ready");
    assert_eq!(reply.location.unwrap().ownership, "existing");
    let cold = Worktrees::default();
    assert_eq!(cold.list(&s).unwrap().locations[0].availability, "unknown");
    assert_eq!(op(cold.recheck(&s, OP).unwrap()).state, "ready");
    let moved = r._dir.path().join("original-preserved");
    fs::rename(&r.root, &moved).unwrap();
    fs::create_dir(&r.root).unwrap();
    git(&r.root, &["init", "-q"]);
    assert!(cold.check_location(&s, OP).is_err());
    assert_eq!(cold.list(&s).unwrap().locations[0].availability, "changed");
    assert!(moved.join("a.txt").exists());
}
#[test]
fn branch_movement_after_precheck_never_executes_unchecked_filter() {
    let r = Repo::new();
    let old = git(&r.root, &["rev-parse", "HEAD"]);
    git(&r.root, &["branch", "other", &old]);
    fs::write(r.root.join(".gitattributes"), "a.txt filter=late\n").unwrap();
    git(&r.root, &["add", "."]);
    git(&r.root, &["commit", "-qm", "different filtered commit"]);
    let changed = git(&r.root, &["rev-parse", "HEAD"]);
    let canary = r._dir.path().canonicalize().unwrap().join("filter-ran");
    git(
        &r.root,
        &[
            "config",
            "filter.late.smudge",
            &format!("sh -c 'printf ran > {}; cat'", canary.display()),
        ],
    );
    let snap = inspect::snapshot(&r.root).unwrap();
    let args = Create {
        inspection_id: OP.into(),
        parent_path: r
            ._dir
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        directory_name: "changed-branch".into(),
        branch: Branch::Existing {
            r#ref: "refs/heads/other".into(),
            expected_oid: old,
        },
    };
    let mut intent = create::validate(&snap, &args).unwrap();
    fs::create_dir(&intent.target).unwrap();
    intent.target_stamp = Some(inspect::stamp(Path::new(&intent.target)).unwrap());
    git(&r.root, &["update-ref", "refs/heads/other", &changed]);
    let _ = create::add(&intent, &std::sync::atomic::AtomicBool::new(false));
    assert!(
        !canary.exists(),
        "unchecked branch contents must never run a configured filter"
    );
    assert_eq!(create::verify(&intent).unwrap_err().code, "changed");
}
#[test]
fn info_attribute_change_after_precheck_never_executes_configured_filter() {
    let r = Repo::new();
    let old = git(&r.root, &["rev-parse", "HEAD"]);
    let canary = r
        ._dir
        .path()
        .canonicalize()
        .unwrap()
        .join("info-filter-ran");
    git(
        &r.root,
        &[
            "config",
            "filter.late.smudge",
            &format!("sh -c 'printf ran > {}; cat'", canary.display()),
        ],
    );
    let snap = inspect::snapshot(&r.root).unwrap();
    let args = Create {
        inspection_id: OP.into(),
        parent_path: r
            ._dir
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        directory_name: "changed-info".into(),
        branch: Branch::New {
            name: "info-change".into(),
            start_oid: old,
        },
    };
    let mut intent = create::validate(&snap, &args).unwrap();
    fs::create_dir(&intent.target).unwrap();
    intent.target_stamp = Some(inspect::stamp(Path::new(&intent.target)).unwrap());
    fs::write(r.root.join(".git/info/attributes"), "a.txt filter=late\n").unwrap();
    let _ = create::add(&intent, &std::sync::atomic::AtomicBool::new(false));
    assert!(
        !canary.exists(),
        "late attributes must not start executable conversion"
    );
}
