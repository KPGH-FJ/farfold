use super::tests::{OP, Repo, git, input, op, store, wait};
use super::*;
#[test]
fn official_boolean_aliases_preserve_checkout_and_do_not_reject_an_ordinary_repository() {
    let r = Repo::new();
    std::fs::write(r.root.join("a.txt"), "one\ntwo\n").unwrap();
    git(&r.root, &["add", "."]);
    git(&r.root, &["commit", "-qm", "lines"]);
    for (key, value) in [
        ("core.filemode", "1"),
        ("core.symlinks", "yes"),
        ("core.ignorecase", "off"),
        ("core.precomposeunicode", "no"),
        ("core.protecthfs", "ON"),
        ("core.protectntfs", "0"),
        ("core.autocrlf", "yes"),
        ("core.safecrlf", "off"),
    ] {
        git(&r.root, &["config", key, value]);
    }
    let before = std::fs::read(r.root.join(".git/config")).unwrap();
    let m = Worktrees::default();
    let s = store();
    let args = input(
        &m,
        &s,
        &r,
        Branch::New {
            name: "bool-alias".into(),
            start_oid: git(&r.root, &["rev-parse", "HEAD"]),
        },
        "bool-alias",
    );
    assert_eq!(op(m.prepare(&s, OP, args).unwrap()).state, "prepared");
    m.start(&s, OP).unwrap();
    let result = wait(&m, &s);
    assert_eq!(result.state, "ready", "{result:?}");
    assert_eq!(
        std::fs::read(std::path::Path::new(&result.location.unwrap().path).join("a.txt")).unwrap(),
        b"one\r\ntwo\r\n"
    );
    assert_eq!(std::fs::read(r.root.join(".git/config")).unwrap(), before);
}
#[test]
fn explicit_disabled_sparse_checkout_is_not_an_enabled_sparse_profile() {
    let r = Repo::new();
    git(&r.root, &["config", "core.sparseCheckout", "false"]);
    let s = inspect::snapshot(&r.root).unwrap();
    assert!(!s.blockers.contains(&"sparseCheckout".into()));
    inspect::check_target(&s, s.head.as_ref().unwrap()).unwrap();
    git(&r.root, &["config", "core.sparseCheckout", "yes"]);
    let s = inspect::snapshot(&r.root).unwrap();
    assert!(s.blockers.contains(&"sparseCheckout".into()));
}
