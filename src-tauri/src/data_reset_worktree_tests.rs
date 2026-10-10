use super::*;
use crate::worktrees::{
    tests::{OP, Repo, git, input, store},
    *,
};
#[test]
fn worktree_prepared_blocks_actual_clear_admission_without_deleting_any_material() {
    let r = Repo::new();
    let s = store();
    let work = Worktrees::default();
    let args = input(
        &work,
        &s,
        &r,
        Branch::New {
            name: "clear-owned".into(),
            start_oid: git(&r.root, &["rev-parse", "HEAD"]),
        },
        "clear-owned",
    );
    work.prepare(&s, OP, args).unwrap();
    let copies = crate::file_copy_jobs::FileCopyJobs::default();
    assert_eq!(
        admit_clear(&copies, &work, Some(&s)).err().as_deref(),
        Some("工作位置操作仍未结束，请先核对操作状态")
    );
    assert!(s.worktree_raw().unwrap().is_some());
    assert_eq!(std::fs::read(r.root.join("a.txt")).unwrap(), b"fixture");
}
