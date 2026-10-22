//! Real shared Git owners remain pinned while linked-tree handles retire.
use super::*;
use crate::worktrees::{
    inspect,
    tests::{Repo, git},
    windows_git::ReadContext,
};
fn fixture() -> (Repo, PathBuf, Snapshot) {
    let repo = Repo::new();
    let target = repo._dir.path().join("remove-owned-linked");
    git(
        &repo.root,
        &[
            "worktree",
            "add",
            "-b",
            "remove-owner-control",
            target.to_str().unwrap(),
            "HEAD",
        ],
    );
    let snapshot = inspect::snapshot(&target).unwrap();
    (repo, target, snapshot)
}
#[test]
fn original_common_config_and_selected_ref_stay_held_after_linked_pins_retire() {
    let (repo, target, snapshot) = fixture();
    let context = ReadContext::open(&target)
        .unwrap()
        .into_removal_context(&snapshot)
        .unwrap();
    let common = Path::new(&snapshot.common_dir);
    let selected = common.join(snapshot.branch.as_ref().unwrap());
    assert!(fs::write(&selected, format!("{}\n", "1".repeat(40))).is_err());
    assert!(fs::write(common.join("config"), "[core]\n bare=true\n").is_err());
    // Holding directories does not prevent a new unrelated child. It is never
    // claimed as selected/disposable, and common is never a deletion target.
    fs::write(
        common.join("refs/heads/unselected-new"),
        format!("{}\n", snapshot.head.as_ref().unwrap()),
    )
    .unwrap();
    context.verify().unwrap();
    let moved = repo._dir.path().join("moved-owned-linked");
    fs::rename(&target, &moved).unwrap();
    context.verify().unwrap();
    fs::rename(&moved, &target).unwrap();
}
#[test]
fn changed_selected_ref_before_consuming_handoff_is_rejected() {
    let (_repo, target, snapshot) = fixture();
    let context = ReadContext::open(&target).unwrap();
    let selected = Path::new(&snapshot.common_dir).join(snapshot.branch.as_ref().unwrap());
    let old = fs::read(&selected).unwrap();
    fs::write(&selected, format!("{}\n", "1".repeat(40))).unwrap();
    assert!(matches!(
        context.into_removal_context(&snapshot),
        Err(crate::worktrees::types::Failure { code: "changed" })
    ));
    assert!(target.exists());
    assert_ne!(fs::read(&selected).unwrap(), old);
}
#[test]
fn packed_only_selected_ref_is_explicitly_refused_without_claiming_absence_lock() {
    let (repo, target, snapshot) = fixture();
    git(&repo.root, &["pack-refs", "--all", "--prune"]);
    let common = Path::new(&snapshot.common_dir);
    let packed = fs::read(common.join("packed-refs")).unwrap();
    assert!(!common.join(snapshot.branch.as_ref().unwrap()).exists());
    let context = ReadContext::open(&target).unwrap();
    assert!(matches!(
        context.into_removal_context(&snapshot),
        Err(crate::worktrees::types::Failure {
            code: "unsupportedGit"
        })
    ));
    assert_eq!(fs::read(common.join("packed-refs")).unwrap(), packed);
    assert!(target.exists());
}
#[test]
fn detached_original_head_needs_no_common_branch_and_still_retains_config() {
    let (repo, target, _) = fixture();
    git(&target, &["checkout", "--detach", "HEAD"]);
    let snapshot = inspect::snapshot(&target).unwrap();
    assert!(snapshot.branch.is_none());
    let context = ReadContext::open(&target)
        .unwrap()
        .into_removal_context(&snapshot)
        .unwrap();
    context.verify().unwrap();
    assert!(fs::write(Path::new(&snapshot.common_dir).join("config"), "changed").is_err());
    let moved = repo._dir.path().join("moved-detached");
    fs::rename(&target, &moved).unwrap();
    fs::rename(&moved, &target).unwrap();
}
