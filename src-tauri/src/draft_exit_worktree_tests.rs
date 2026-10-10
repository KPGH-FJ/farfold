use super::*;
use crate::worktrees::{
    tests::{OP, Repo, git, input, op, store},
    *,
};
fn prepared(m: &Worktrees, s: &crate::meta_store::MetaStore, r: &Repo) {
    let args = input(
        m,
        s,
        r,
        Branch::New {
            name: "exit-owned".into(),
            start_oid: git(&r.root, &["rev-parse", "HEAD"]),
        },
        "exit-owned",
    );
    m.prepare(s, OP, args).unwrap();
}
#[test]
fn worktree_prepared_cannot_be_bypassed_by_save_exit_confirmation() {
    let r = Repo::new();
    let s = store();
    let work = Worktrees::default();
    prepared(&work, &s, &r);
    let copies = crate::file_copy_jobs::FileCopyJobs::default();
    for confirm in [false, true] {
        for available_store in [Some(&s), None] {
            assert_eq!(
                admit_file_exit(&copies, &work, available_store, confirm)
                    .err()
                    .as_deref(),
                Some("WORKTREE_EXIT_BLOCKED")
            );
        }
    }
    assert_eq!(op(work.cancel(&s, OP).unwrap()).state, "cancelled");
    assert!(admit_file_exit(&copies, &work, Some(&s), true).is_ok());
    assert!(!r._dir.path().join("exit-owned").exists());
}

#[test]
fn missing_meta_store_exit_uses_only_registered_in_memory_gates() {
    let copies = crate::file_copy_jobs::FileCopyJobs::default();
    let work = Worktrees::default();
    let held = admit_file_exit(&copies, &work, None, false)
        .expect("database recovery must remain normally closable without an initialized store");
    assert!(copies.seal_exit().is_err(), "copy gate is retained");
    assert!(
        work.seal_exit(None, false).is_err(),
        "worktree gate is retained"
    );
    drop(held);
    assert!(admit_file_exit(&copies, &work, None, false).is_ok());
}
#[test]
fn cold_unknown_requires_explicit_risk_confirmation_at_the_actual_exit_gate() {
    let r = Repo::new();
    let s = store();
    let original = Worktrees::default();
    prepared(&original, &s, &r);
    drop(original);
    let work = Worktrees::default();
    let copies = crate::file_copy_jobs::FileCopyJobs::default();
    assert_eq!(
        admit_file_exit(&copies, &work, Some(&s), false)
            .err()
            .as_deref(),
        Some("EXIT_CONFIRMATION_REQUIRED")
    );
    let _held = admit_file_exit(&copies, &work, Some(&s), true).unwrap();
    assert!(
        work.inspect(&s, r.root.to_str().unwrap()).is_err(),
        "the successful gate must keep worktree admission through actual exit"
    );
}
