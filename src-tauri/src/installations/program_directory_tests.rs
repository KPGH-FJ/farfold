use super::*;

fn receipt(root: &Path) -> Installation {
    Installation {
        id: "fixture".into(),
        agent_id: "registry:autohand".into(),
        path: root.join("launch-program").display().to_string(),
        command: "/external/node".into(),
        args: vec!["/original/component.js".into()],
        version: Some("0.9.8".into()),
        source: "registry".into(),
        managed_root: Some(root.display().to_string()),
        program_only: true,
        node_launch: None,
        release: None,
    }
}

#[test]
fn only_the_matching_program_receipt_owns_the_new_direct_child() {
    let data = tempfile::tempdir().unwrap();
    let root = crate::managed_programs::parent(data.path(), "registry:autohand")
        .join("dependency-fixture");
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let mut item = receipt(&root);
    assert_eq!(owned_root(&item, data.path()).unwrap(), root);
    item.program_only = false;
    assert!(owned_root(&item, data.path()).is_err());
    item.program_only = true;
    item.agent_id = "registry%3Aautohand".into();
    assert!(owned_root(&item, data.path()).is_err());
    item.agent_id = "registry:autohand".into();
    item.managed_root = Some(root.join("nested").display().to_string());
    assert!(owned_root(&item, data.path()).is_err());
    item.managed_root = None;
    assert!(owned_root(&item, data.path()).is_err());
    std::fs::remove_dir(&root).unwrap();
    // Exact missing-root cleanup can still finish its recorded metadata.
    assert_eq!(owned_root(&receipt(&root), data.path()).unwrap(), root);
}

#[test]
fn legacy_roots_stay_owned_and_new_symlink_parents_never_gain_ownership() {
    use std::os::unix::fs::symlink;
    let data = tempfile::tempdir().unwrap();
    let root = data.path().join("agents/registry:autohand/dependency-old");
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    assert_eq!(owned_root(&receipt(&root), data.path()).unwrap(), root);
    let external = tempfile::tempdir().unwrap();
    symlink(external.path(), data.path().join("companion-programs")).unwrap();
    let alias =
        crate::managed_programs::parent(data.path(), "registry:autohand").join("dependency-new");
    std::fs::create_dir_all(&alias).unwrap();
    assert!(owned_root(&receipt(&alias), data.path()).is_err());
    assert!(owned_root(&receipt(&alias.canonicalize().unwrap()), data.path()).is_err());
    assert!(external.path().exists());
}
