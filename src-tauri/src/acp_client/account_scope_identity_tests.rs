use super::*;

#[test]
fn resolved_scripts_group_aliases_without_grouping_their_interpreter() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.js");
    let second = dir.path().join("second.js");
    let node = dir.path().join("node");
    for path in [&first, &second, &node] {
        std::fs::write(path, "fixture").unwrap();
    }
    let alias = dir.path().join("alias.js");
    std::os::unix::fs::symlink(&first, &alias).unwrap();
    let identify = |path: &Path| {
        LaunchIdentity::from_launch(node.to_str().unwrap(), &[path.to_string_lossy().into()])
    };
    assert!(identify(&first) == identify(&alias));
    assert!(identify(&first) != identify(&second));
    assert!(identify(&first) == LaunchIdentity::from_launch(first.to_str().unwrap(), &[]));
    assert!(
        LaunchIdentity::from_launch(node.to_str().unwrap(), &["-e".into(), "arbitrary()".into()])
            .is_none()
    );
    assert!(LaunchIdentity::from_launch(node.to_str().unwrap(), &["relative.js".into()]).is_none());
}

#[test]
fn unknown_package_runners_do_not_group_every_agent_by_runtime() {
    let dir = tempfile::tempdir().unwrap();
    for runner in ["npm", "npx", "uv", "uvx", "env", "sh"] {
        let path = dir.path().join(runner);
        std::fs::write(&path, "fixture").unwrap();
        assert!(
            LaunchIdentity::from_launch(path.to_str().unwrap(), &["unreviewed".into()]).is_none()
        );
    }
}

#[test]
fn setup_without_live_connection_reserves_the_companion_entry() {
    let dir = tempfile::tempdir().unwrap();
    let entry = dir.path().join("official-cli");
    std::fs::write(&entry, "fixture").unwrap();
    let manager = AcpManager::new(dir.path().into(), dir.path().into());
    let row = AgentRow {
        id: "preparation".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: entry.to_string_lossy().into(),
        args: vec![],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    let scope = manager
        .reserve_preparation_action(&row, &row.command, &["configure".into()])
        .unwrap();
    let identity = LaunchIdentity::of(&row);
    assert!(
        manager
            .account_admission
            .check("new-alias", identity.as_ref())
            .is_err()
    );
    assert!(
        manager
            .reserve_preparation_action(&row, &row.command, &[])
            .is_err()
    );
    drop(scope);
    assert!(
        manager
            .account_admission
            .check("new-alias", identity.as_ref())
            .is_ok()
    );
}
