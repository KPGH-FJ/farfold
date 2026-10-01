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

#[test]
fn ordinary_and_companion_roots_never_grant_each_other_ownership() {
    let data = tempfile::tempdir().unwrap();
    for (relative, program_only) in [
        (
            "agent-installations/agent-registry%3Aautohand/install-new",
            false,
        ),
        (
            "companion-programs/agent-registry%3Aautohand/dependency-new",
            true,
        ),
    ] {
        let root = data.path().join(relative);
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let mut item = receipt(&root);
        item.program_only = program_only;
        assert_eq!(owned_root(&item, data.path()).unwrap(), root);
        item.program_only = !program_only;
        assert!(owned_root(&item, data.path()).is_err());
        item.program_only = program_only;
        item.agent_id = "registry%3Aautohand".into();
        assert!(owned_root(&item, data.path()).is_err());
        item.agent_id = "registry:autohand".into();
        std::fs::remove_dir(&root).unwrap();
        assert_eq!(owned_root(&item, data.path()).unwrap(), root);
    }
}

#[test]
fn legacy_escaping_ids_or_symlink_parents_never_own_a_missing_root() {
    use std::os::unix::fs::symlink;
    let data = tempfile::tempdir().unwrap();
    let data_path = data.path().canonicalize().unwrap();
    std::fs::create_dir(data_path.join("agents")).unwrap();
    let outside = data_path.join("outside");
    std::fs::create_dir(&outside).unwrap();
    let missing = outside.join("removed-root");
    let mut item = receipt(&missing);
    item.agent_id = "../outside".into();
    assert!(owned_root(&item, data.path()).is_err());
    item.agent_id = outside.display().to_string();
    assert!(owned_root(&item, data.path()).is_err());
    symlink(&outside, data_path.join("agents/registry:autohand")).unwrap();
    item.agent_id = "registry:autohand".into();
    assert!(owned_root(&item, data.path()).is_err());
}

#[test]
fn old_and_new_component_receipts_remain_selectable_and_independently_removable() {
    use std::os::unix::fs::PermissionsExt;
    let data = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
    let mut rows = Vec::new();
    let mut roots = Vec::new();
    for parent in [
        "agents/registry:fixture",
        "agent-installations/agent-registry%3Afixture",
    ] {
        let root = data.path().join(parent).join("install-fixture");
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let program = root.join("program");
        std::fs::write(&program, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let row = AgentRow {
            id: "registry:fixture".into(),
            name: "Fixture".into(),
            source: "registry".into(),
            command: program.display().to_string(),
            args: vec!["--unchanged".into()],
            env: vec![],
            version: Some("1.0.0".into()),
            handshake: None,
            created_at: 1,
            updated_at: 1,
        };
        record(&store, &row, &root).unwrap();
        roots.push(root);
        rows.push(row);
    }
    let items = read(&store).unwrap();
    assert_eq!(items.len(), 2);
    assert_ne!(items[0].id, items[1].id);
    for (item, row) in items.iter().zip(&rows) {
        let selected = selection_candidate(item, &rows[0], data.path(), || Ok(())).unwrap();
        assert_eq!(selected.command, row.command);
        assert_eq!(selected.args, row.args);
    }
    remove_installed(&store, data.path(), &rows[0].id, &items[1].id).unwrap();
    assert!(roots[0].is_dir());
    assert!(!roots[1].exists());
    assert_eq!(read(&store).unwrap()[0].id, items[0].id);
    remove_installed(&store, data.path(), &rows[0].id, &items[0].id).unwrap();
    assert!(!roots[0].exists());
    assert!(read(&store).unwrap().is_empty());
}
