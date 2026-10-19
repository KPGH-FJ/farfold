//! Owned Windows role controls only; no FullSD or material exclusion claim.
use super::*;
use crate::worktrees::windows_git::ReadContext;

#[test]
fn real_linked_graph_retains_original_root_git_role_through_complete_recheck() {
    let f = Fixture::new();
    let before = f.bytes();
    let graph = SourceGraph::capture(&f.snapshot(), &AtomicBool::new(false)).unwrap();
    graph
        .owner
        .managed_root_git
        .verify(&graph.owner.source)
        .unwrap();
    assert_eq!(fs::read(f.root.join(".git")).unwrap(), before[1]);
    assert_eq!(f.bytes(), before);
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(f.root.join(".git"))
            .is_err()
    );
    graph.recheck(&AtomicBool::new(false)).unwrap();
    assert_eq!(f.bytes(), before);
    drop(graph);
    f.temp.close().unwrap();
}

#[test]
fn actual_main_read_context_role_does_not_widen_private_graph_inventory_or_material_gate() {
    let f = Fixture::new();
    let main = f
        .private
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let source = ReadContext::open(main).unwrap();
    let role = source.managed_root_git().unwrap();
    role.verify(&source).unwrap();
    assert_eq!(source.scope.git.identity(), source.scope.common.identity());
    assert_eq!(
        source.config("core.bare", true).unwrap().as_deref(),
        Some("false")
    );
    let snapshot = Snapshot {
        root: source.scope.root.path.clone(),
        git_dir: source.scope.git.path.clone(),
        common_dir: source.scope.common.path.clone(),
        root_stamp: inspect::pinned_stamp(&source.scope.root).unwrap(),
        git_stamp: inspect::pinned_stamp(&source.scope.git).unwrap(),
        common_stamp: inspect::pinned_stamp(&source.scope.common).unwrap(),
        head: Some(COMMIT.into()),
        branch: Some("refs/heads/public".into()),
        trees: Vec::new(),
        blockers: Vec::new(),
    };
    assert_eq!(
        SourceGraph::capture(&snapshot, &AtomicBool::new(false))
            .err()
            .unwrap()
            .code,
        "unprovenPrivateCommits"
    );
    role.verify(&source).unwrap();
    drop(role);
    drop(source);
    f.temp.close().unwrap();
}

#[test]
fn root_git_role_does_not_accept_a_correct_pointer_to_a_nondefault_private_directory() {
    let mut f = Fixture::new();
    let common = f.private.parent().unwrap().parent().unwrap().to_owned();
    let other = f
        .root
        .parent()
        .unwrap()
        .join("not a managed worktrees child");
    fs::rename(&f.private, &other).unwrap();
    f.private = other;
    fs::write(
        f.root.join(".git"),
        format!("gitdir: {}\n", f.private.display()),
    )
    .unwrap();
    fs::write(
        f.private.join("commondir"),
        format!("{}\n", common.display()),
    )
    .unwrap();
    let before = f.bytes();
    let source = ReadContext::open(&f.root).unwrap();
    assert_eq!(
        source.config("core.bare", true).unwrap().as_deref(),
        Some("false")
    );
    drop(source);
    assert_eq!(
        SourceGraph::capture(&f.snapshot(), &AtomicBool::new(false))
            .err()
            .unwrap()
            .code,
        "unsupportedGit"
    );
    assert_eq!(f.bytes(), before);
    f.temp.close().unwrap();
}

#[test]
fn actual_root_namespace_change_cannot_leave_original_graph_role_verified() {
    let f = Fixture::new();
    let graph = SourceGraph::capture(&f.snapshot(), &AtomicBool::new(false)).unwrap();
    let before = stamp(graph.owner.source.scope.root.file()).unwrap();
    fs::write(
        f.root.join("new user payload.txt"),
        b"must be part of a later whole material capture",
    )
    .unwrap();
    let after = stamp(graph.owner.source.scope.root.file()).unwrap();
    assert_ne!(before, after); // actual OS change, never a time-based inference
    assert_eq!(
        graph.recheck(&AtomicBool::new(false)).err().unwrap().code,
        "recoveryChanged"
    );
    assert_eq!(
        fs::read(f.root.join("new user payload.txt")).unwrap(),
        b"must be part of a later whole material capture"
    );
    drop(graph);
    f.temp.close().unwrap();
}

#[test]
fn an_original_role_capsule_cannot_be_presented_as_a_different_root_read_context() {
    let first = Fixture::new();
    let second = Fixture::new();
    let source = ReadContext::open(&first.root).unwrap();
    let foreign = ReadContext::open(&second.root).unwrap();
    let role = source.managed_root_git().unwrap();
    assert_eq!(role.verify(&foreign).err().unwrap().code, "recoveryChanged");
    role.verify(&source).unwrap();
    drop(role);
    drop(source);
    drop(foreign);
    first.temp.close().unwrap();
    second.temp.close().unwrap();
}
