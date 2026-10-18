use super::*;
use crate::worktrees::tests::{OP, Repo, git};
use std::{fs, path::Path, sync::atomic::AtomicBool};
fn args(r: &Repo, oid: String) -> Create {
    Create {
        inspection_id: OP.into(),
        parent_path: r
            ._dir
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        directory_name: "exact-checkout".into(),
        branch: Branch::New {
            name: "owned-checkout".into(),
            start_oid: oid,
        },
    }
}
#[test]
fn captured_global_info_and_tree_attributes_preserve_precedence_and_path_escaping() {
    let r = Repo::new();
    for name in ["a space.txt", "方括[号].txt", "literal*.txt"] {
        fs::write(r.root.join(name), "one\ntwo\n").unwrap();
    }
    fs::write(r.root.join(".gitattributes"), "*.txt text eol=lf\n").unwrap();
    git(&r.root, &["add", "."]);
    git(&r.root, &["commit", "-qm", "paths"]);
    let global = r._dir.path().join("owned-global-attributes");
    fs::write(&global, "*.txt text eol=crlf\n").unwrap();
    git(
        &r.root,
        &["config", "core.attributesFile", global.to_str().unwrap()],
    );
    fs::write(
        r.root.join(".git/info/attributes"),
        "\"a space.txt\" text eol=crlf\n",
    )
    .unwrap();
    let s = inspect::snapshot(&r.root).unwrap();
    let args = args(&r, s.head.clone().unwrap());
    let checkout = checkout::Checkout::prepare(&s, args.branch.oid()).unwrap();
    let mut intent = create::validate(&s, &args).unwrap();
    fs::create_dir(&intent.target).unwrap();
    intent.target_stamp = Some(inspect::stamp(Path::new(&intent.target)).unwrap());
    create::add(&intent, &AtomicBool::new(false)).unwrap();
    checkout
        .materialize(&intent, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        fs::read(Path::new(&intent.target).join("a space.txt")).unwrap(),
        b"one\r\ntwo\r\n"
    );
    assert_eq!(
        fs::read(Path::new(&intent.target).join("方括[号].txt")).unwrap(),
        b"one\ntwo\n"
    );
    assert_eq!(
        fs::read(Path::new(&intent.target).join("literal*.txt")).unwrap(),
        b"one\ntwo\n"
    );
}
#[test]
fn checkout_after_info_filter_mutation_uses_captured_attributes_without_executing_helper() {
    let r = Repo::new();
    let s = inspect::snapshot(&r.root).unwrap();
    let args = args(&r, s.head.clone().unwrap());
    let checkout = checkout::Checkout::prepare(&s, args.branch.oid()).unwrap();
    let mut intent = create::validate(&s, &args).unwrap();
    let canary = r._dir.path().join("helper-ran");
    git(
        &r.root,
        &[
            "config",
            "filter.late.smudge",
            &format!("sh -c 'printf ran > {}; cat'", canary.display()),
        ],
    );
    fs::write(r.root.join(".git/info/attributes"), "a.txt filter=late\n").unwrap();
    fs::create_dir(&intent.target).unwrap();
    intent.target_stamp = Some(inspect::stamp(Path::new(&intent.target)).unwrap());
    create::add(&intent, &AtomicBool::new(false)).unwrap();
    checkout
        .materialize(&intent, &AtomicBool::new(false))
        .unwrap();
    assert!(!canary.exists());
    assert_eq!(
        fs::read(Path::new(&intent.target).join("a.txt")).unwrap(),
        b"fixture"
    );
}
#[test]
fn private_object_read_cannot_lazy_fetch_a_missing_target_from_new_source_promisor_config() {
    let r = Repo::new();
    let s = inspect::snapshot(&r.root).unwrap();
    let oid = s.head.clone().unwrap();
    let canary = r._dir.path().join("fetch-ran");
    let helper = r._dir.path().join("git-upload-probe");
    fs::write(
        &helper,
        format!("#!/bin/sh\nprintf ran > {}\nexit 1\n", canary.display()),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(
        &r.root,
        &[
            "config",
            "remote.owned.url",
            &format!("ext::{}", helper.display()),
        ],
    );
    git(&r.root, &["config", "remote.owned.promisor", "true"]);
    git(&r.root, &["config", "protocol.ext.allow", "always"]);
    fs::remove_file(r.root.join(".git/objects").join(&oid[..2]).join(&oid[2..])).unwrap();
    assert!(checkout::Checkout::prepare(&s, &oid).is_err());
    assert!(
        !canary.exists(),
        "a missing object must never invoke the configured remote helper"
    );
}
#[test]
#[cfg(unix)]
fn add_after_preflight_cannot_lazy_fetch_from_mutated_source_configuration() {
    let r = Repo::new();
    let s = inspect::snapshot(&r.root).unwrap();
    let oid = s.head.clone().unwrap();
    let args = args(&r, oid.clone());
    let _checkout = checkout::Checkout::prepare(&s, &oid).unwrap();
    let mut intent = create::validate(&s, &args).unwrap();
    fs::create_dir(&intent.target).unwrap();
    intent.target_stamp = Some(inspect::stamp(Path::new(&intent.target)).unwrap());
    let canary = r._dir.path().join("late-add-fetch-ran");
    let helper = r._dir.path().join("git-upload-probe");
    fs::write(
        &helper,
        format!("#!/bin/sh\nprintf ran > {}\nexit 1\n", canary.display()),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
    git(
        &r.root,
        &[
            "config",
            "remote.owned.url",
            &format!("ext::{}", helper.display()),
        ],
    );
    git(&r.root, &["config", "remote.owned.promisor", "true"]);
    git(&r.root, &["config", "protocol.ext.allow", "always"]);
    fs::remove_file(r.root.join(".git/objects").join(&oid[..2]).join(&oid[2..])).unwrap();
    assert!(create::add(&intent, &AtomicBool::new(false)).is_err());
    assert!(
        !canary.exists(),
        "source worktree registration must never run a remote helper after preflight"
    );
}
#[test]
fn linked_source_uses_common_info_attributes_for_materialization_and_filter_guard() {
    let r = Repo::new();
    fs::write(r.root.join("a.txt"), "one\ntwo\n").unwrap();
    git(&r.root, &["add", "."]);
    git(&r.root, &["commit", "-qm", "lines"]);
    let linked = r._dir.path().join("linked-source");
    git(
        &r.root,
        &[
            "worktree",
            "add",
            "-b",
            "linked-source",
            linked.to_str().unwrap(),
        ],
    );
    fs::write(r.root.join(".git/info/attributes"), "a.txt text eol=crlf\n").unwrap();
    assert_eq!(
        git(&linked, &["check-attr", "eol", "--", "a.txt"]),
        "a.txt: eol: crlf"
    );
    let s = inspect::snapshot(&linked).unwrap();
    let args = args(&r, s.head.clone().unwrap());
    let checkout = checkout::Checkout::prepare(&s, args.branch.oid()).unwrap();
    let mut intent = create::validate(&s, &args).unwrap();
    fs::create_dir(&intent.target).unwrap();
    intent.target_stamp = Some(inspect::stamp(Path::new(&intent.target)).unwrap());
    create::add(&intent, &AtomicBool::new(false)).unwrap();
    checkout
        .materialize(&intent, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        fs::read(Path::new(&intent.target).join("a.txt")).unwrap(),
        b"one\r\ntwo\r\n"
    );
    fs::write(
        r.root.join(".git/info/attributes"),
        "a.txt filter=blocked\n",
    )
    .unwrap();
    assert_eq!(
        checkout::Checkout::prepare(&s, args.branch.oid())
            .err()
            .unwrap()
            .code,
        "filters"
    );
}
#[test]
fn literal_filter_sentinel_names_cannot_silently_skip_a_real_registered_transform() {
    for name in ["unset", "unspecified"] {
        let r = Repo::new();
        fs::write(
            r.root.join(".gitattributes"),
            format!("a.txt filter={name}\n"),
        )
        .unwrap();
        git(&r.root, &["add", "."]);
        git(&r.root, &["commit", "-qm", "literal filter name"]);
        git(
            &r.root,
            &[
                "config",
                &format!("filter.{name}.smudge"),
                "sed s/fixture/transformed/",
            ],
        );
        assert_eq!(
            git(&r.root, &["check-attr", "filter", "--", "a.txt"]),
            format!("a.txt: filter: {name}")
        );
        let reference = r._dir.path().join("official-checkout");
        fs::create_dir(&reference).unwrap();
        git(
            &r.root,
            &[
                "checkout-index",
                "--all",
                &format!("--prefix={}/", reference.display()),
            ],
        );
        assert_eq!(
            fs::read(reference.join("a.txt")).unwrap(),
            b"transformed",
            "official Git actually applies this literal driver name"
        );
        let s = inspect::snapshot(&r.root).unwrap();
        assert_eq!(
            checkout::Checkout::prepare(&s, s.head.as_ref().unwrap())
                .err()
                .map(|e| e.code),
            Some("filters")
        );
    }
}
