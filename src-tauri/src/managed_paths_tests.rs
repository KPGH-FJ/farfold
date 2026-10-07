use super::*;
#[cfg(unix)]
use std::os::unix::fs::symlink;

#[test]
fn ordinary_encoding_is_injective_and_separate_from_both_previous_namespaces() {
    let data = Path::new("/data");
    let ids = [
        "registry:fixture",
        "registry%3Afixture",
        "agent-registry%3Afixture",
        "../outside",
        "/absolute",
        ".",
        "",
        "中文",
        "a/b",
        "a:b",
        "a b",
    ];
    let mut unique = std::collections::HashSet::new();
    for id in ids {
        let path = parent(data, id, Layout::Agent);
        assert!(unique.insert(path.clone()));
        assert_eq!(path.parent().unwrap(), data.join("agent-installations"));
        assert!(
            !path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .contains([':', '/', ' '])
        );
        assert_ne!(path, parent(data, id, Layout::Companion));
        assert_ne!(path, data.join("agents").join(id));
    }
}

#[cfg(unix)]
#[test]
fn preparation_rejects_every_existing_symlink_before_creating_descendants() {
    for leaf in [
        "agent-installations",
        "agent-installations/agent-registry%3Afixture",
    ] {
        for broken in [false, true] {
            let data = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let link = data.path().join(leaf);
            std::fs::create_dir_all(link.parent().unwrap()).unwrap();
            let target = if broken {
                outside.path().join("missing")
            } else {
                outside.path().into()
            };
            symlink(&target, link).unwrap();
            assert!(prepare_agent_parent(data.path(), "registry:fixture").is_err());
            assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        }
    }
}

#[test]
fn roots_require_exact_normal_parent_and_correct_namespace_even_after_removal() {
    let data = tempfile::tempdir().unwrap();
    let base = data.path().canonicalize().unwrap();
    let id = "registry:fixture";
    let parent = prepare_agent_parent(data.path(), id).unwrap();
    let root = parent.join("install-fixture");
    std::fs::create_dir(&root).unwrap();
    assert_eq!(
        recorded_root(&base, id, &root, Layout::Agent, false),
        Some(root.clone())
    );
    assert!(recorded_root(&base, id, &root, Layout::Companion, false).is_none());
    assert!(recorded_root(&base, "registry%3Afixture", &root, Layout::Agent, false).is_none());
    std::fs::create_dir(root.join("nested")).unwrap();
    assert!(recorded_root(&base, id, &root.join("nested"), Layout::Agent, false).is_none());
    #[cfg(unix)]
    let link = {
        let link = parent.join("linked");
        symlink(&root, &link).unwrap();
        assert!(recorded_root(&base, id, &link, Layout::Agent, false).is_none());
        link
    };
    std::fs::remove_dir_all(&root).unwrap();
    assert!(recorded_root(&base, id, &root, Layout::Agent, false).is_none());
    assert_eq!(
        recorded_root(&base, id, &root, Layout::Agent, true),
        Some(root)
    );
    #[cfg(unix)]
    assert!(recorded_root(&base, id, &link, Layout::Agent, true).is_none());
}

#[test]
fn legacy_parent_normalization_never_grants_an_outside_or_alias_root() {
    let data = tempfile::tempdir().unwrap();
    let base = data.path().canonicalize().unwrap();
    let root = base.join("outside/install-fixture");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir(base.join("agents")).unwrap();
    for id in ["../outside", "a/../../outside", "/absolute", "", ".", "a/"] {
        assert!(recorded_root(&base, id, &root, Layout::Agent, true).is_none());
    }
    #[cfg(unix)]
    symlink(base.join("outside"), base.join("agents/registry:fixture")).unwrap();
    assert!(recorded_root(&base, "registry:fixture", &root, Layout::Agent, true).is_none());
    std::fs::remove_dir(&root).unwrap();
    assert!(recorded_root(&base, "registry:fixture", &root, Layout::Agent, true).is_none());
}
