use super::tests::candidate_fixture;
use super::*;

fn history_fixture(data: &Path) -> (MetaStore, AgentRow, String, [String; 2]) {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let store = MetaStore::open(&data.join("meta.db")).unwrap();
    let mut programs = Vec::new();
    for name in ["original", "second", "third"] {
        let path = data.join(name);
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        programs.push(path.display().to_string());
    }
    let alias = data.join("original-alias");
    symlink(&programs[0], &alias).unwrap();
    let alias = alias.display().to_string();
    let row = AgentRow {
        id: "pi".into(),
        name: "Pi".into(),
        source: "registry".into(),
        command: "/bin/sh".into(),
        args: vec!["kept-component".into()],
        env: vec![
            ("PI_ACP_PI_COMMAND".into(), alias.clone()),
            ("MODEL_KEY".into(), "__keychain__".into()),
            ("KEPT_OPTION".into(), "unchanged".into()),
        ],
        version: Some("0.0.34".into()),
        handshake: None,
        created_at: 1,
        updated_at: 1,
    };
    store.insert_agent(&row).unwrap();
    (
        store,
        row,
        alias,
        [programs[1].clone(), programs[2].clone()],
    )
}

fn choose_program(row: &AgentRow, path: &str) -> AgentRow {
    let mut candidate = row.clone();
    let program_env = crate::acp_client::preparation::program_env(&row.id).unwrap();
    candidate
        .env
        .iter_mut()
        .find(|(name, _)| name == program_env)
        .unwrap()
        .1 = path.into();
    candidate
}

fn alias_chain(data: &Path, target: &Path, count: usize) -> PathBuf {
    let mut previous = target.to_path_buf();
    for index in 0..count {
        let next = data.join(format!("user-alias-{index}"));
        std::os::unix::fs::symlink(&previous, &next).unwrap();
        previous = next;
    }
    assert_eq!(
        previous.canonicalize().unwrap(),
        target.canonicalize().unwrap()
    );
    previous
}

fn assert_program_selection(actual: &AgentRow, expected: &AgentRow) {
    assert_eq!(actual.command, expected.command);
    assert_eq!(actual.args, expected.args);
    assert_eq!(actual.version, expected.version);
    assert_eq!(program_path(actual), program_path(expected));
    let other_env = |row: &AgentRow| {
        row.env
            .iter()
            .filter(|(name, _)| name != "PI_ACP_PI_COMMAND")
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(other_env(actual), other_env(expected));
}

#[test]
fn program_history_retains_original_alias_without_discovery_and_returns_it_exactly() {
    let data = tempfile::tempdir().unwrap();
    let (store, original, alias, programs) = history_fixture(data.path());
    let candidate = choose_program(&original, &programs[0]);
    commit_candidate(&store, &candidate, Some(&original), None).unwrap();
    let items = inventory_with_discovered(&store, vec![], "pi").unwrap();
    let old = items
        .iter()
        .find(|item| item.program_only && item.path == alias)
        .expect("the previous explicit alias must remain available without discovery");
    assert_eq!(old.command, alias);
    assert_eq!(old.version, None);
    assert_eq!(old.source, "external");
    assert!(old.managed_root.is_none());
    assert!(!selected(old, Some(&candidate)));
    let returned = selection_candidate(old, &candidate, data.path(), || Ok(())).unwrap();
    assert_eq!(program_path(&returned), Some(alias.as_str()));
    assert_eq!(returned.command, original.command);
    assert_eq!(returned.args, original.args);
    assert_eq!(returned.version, original.version);
    assert_program_selection(&returned, &original);
    assert!(owned_root(old, data.path()).is_err());
    assert!(remove_installed(&store, data.path(), "pi", &old.id).is_err());
    assert!(Path::new(&alias).exists());
}

#[test]
fn program_history_retains_all_three_choices_after_the_snapshot_is_overwritten() {
    let data = tempfile::tempdir().unwrap();
    let (store, original, alias, programs) = history_fixture(data.path());
    let second = choose_program(&original, &programs[0]);
    commit_candidate(&store, &second, Some(&original), None).unwrap();
    let second = store.get_agent("pi").unwrap().unwrap();
    let third = choose_program(&second, &programs[1]);
    commit_candidate(&store, &third, Some(&second), None).unwrap();
    let third = store.get_agent("pi").unwrap().unwrap();
    let items = inventory_with_discovered(&store, vec![], "pi").unwrap();
    for path in [alias.as_str(), programs[0].as_str(), programs[1].as_str()] {
        assert_eq!(
            items
                .iter()
                .filter(|item| item.program_only && item.path == path)
                .count(),
            1,
            "every explicit choice must survive multiple switches: {path}"
        );
    }
    assert!(read(&store).unwrap().iter().any(|item| item.path == alias));
    let old = items.iter().find(|item| item.path == alias).unwrap();
    let returned = selection_candidate(old, &third, data.path(), || Ok(())).unwrap();
    commit_candidate(&store, &returned, Some(&third), None).unwrap();
    assert_program_selection(&store.get_agent("pi").unwrap().unwrap(), &original);
    let items = inventory_with_discovered(&store, vec![], "pi").unwrap();
    assert_eq!(items.iter().filter(|item| item.program_only).count(), 3);
}

#[test]
fn program_history_recovers_legacy_snapshot_and_persists_it_on_the_next_switch() {
    let data = tempfile::tempdir().unwrap();
    let (store, original, alias, programs) = history_fixture(data.path());
    let second = choose_program(&original, &programs[0]);
    store.replace_agent_launch(&second).unwrap();
    let second = store.get_agent("pi").unwrap().unwrap();
    store
        .set_setting(
            "installPrevious.pi",
            &serde_json::json!({
                "command":original.command,"args":original.args,
                "version":original.version,"programEnv":"PI_ACP_PI_COMMAND",
                "programPath":alias,
            }),
        )
        .unwrap();
    let items = inventory_with_discovered(&store, vec![], "pi").unwrap();
    assert!(
        items
            .iter()
            .any(|item| item.program_only && item.path == alias)
    );
    let third = choose_program(&second, &programs[1]);
    commit_candidate(&store, &third, Some(&second), None).unwrap();
    assert!(read(&store).unwrap().iter().any(|item| item.path == alias));
    assert_eq!(
        store.get_setting("installPrevious.pi").unwrap().unwrap()["programPath"],
        programs[0]
    );
}

#[test]
fn program_history_deduplicates_discovered_targets_without_replacing_the_explicit_alias() {
    let data = tempfile::tempdir().unwrap();
    let (store, original, alias, programs) = history_fixture(data.path());
    let candidate = choose_program(&original, &programs[0]);
    commit_candidate(&store, &candidate, Some(&original), None).unwrap();
    let items = inventory_with_discovered(
        &store,
        vec![crate::agent_discovery::DiscoveredBinary {
            agent_id: "pi".into(),
            path: Path::new(&alias)
                .canonicalize()
                .unwrap()
                .display()
                .to_string(),
            version: Some("0.80.5".into()),
        }],
        "pi",
    )
    .unwrap();
    let equivalent: Vec<_> = items
        .iter()
        .filter(|item| item.program_only && same_path(&item.path, &alias))
        .collect();
    assert_eq!(equivalent.len(), 1);
    assert_eq!(equivalent[0].path, alias);
    assert_eq!(equivalent[0].version.as_deref(), Some("0.80.5"));
    let returned = selection_candidate(equivalent[0], &candidate, data.path(), || Ok(())).unwrap();
    assert_program_selection(&returned, &original);
}

#[test]
fn program_history_is_not_published_by_a_stale_selection_or_storage_failure() {
    let data = tempfile::tempdir().unwrap();
    let (store, original, _, programs) = history_fixture(data.path());
    let candidate = choose_program(&original, &programs[0]);
    let newer = choose_program(&original, &programs[1]);
    store.replace_agent_launch(&newer).unwrap();
    assert!(commit_candidate(&store, &candidate, Some(&original), None).is_err());
    assert!(store.get_setting(KEY).unwrap().is_none());
    assert!(store.get_setting("installPrevious.pi").unwrap().is_none());
    let current = store.get_agent("pi").unwrap().unwrap();
    let candidate = choose_program(&current, &programs[0]);
    let connection = rusqlite::Connection::open(data.path().join("meta.db")).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER history_failure BEFORE INSERT ON settings
             WHEN NEW.key = 'installations.v1'
             BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
        )
        .unwrap();
    assert!(commit_candidate(&store, &candidate, Some(&current), None).is_err());
    assert_eq!(store.get_agent("pi").unwrap().unwrap(), current);
    assert!(store.get_setting(KEY).unwrap().is_none());
    assert!(store.get_setting("installPrevious.pi").unwrap().is_none());
}

#[test]
fn program_history_replaces_a_persisted_external_canonical_path_with_the_explicit_alias() {
    let data = tempfile::tempdir().unwrap();
    let (store, original, alias, programs) = history_fixture(data.path());
    let canonical = Path::new(&alias).canonicalize().unwrap();
    let mut known = vec![];
    remember_external_program(&mut known, "pi", canonical.to_str().unwrap());
    write(&store, &known).unwrap();
    let candidate = choose_program(&original, &programs[0]);
    commit_candidate(&store, &candidate, Some(&original), None).unwrap();
    let items = inventory_with_discovered(&store, vec![], "pi").unwrap();
    let same: Vec<_> = items
        .iter()
        .filter(|item| item.program_only && same_path(&item.path, &alias))
        .collect();
    assert_eq!(same.len(), 1);
    assert_eq!(same[0].path, alias);
    assert_eq!(same[0].command, alias);
    assert!(same[0].managed_root.is_none());
    let returned = selection_candidate(same[0], &candidate, data.path(), || Ok(())).unwrap();
    assert_program_selection(&returned, &original);
}

#[test]
fn program_history_does_not_resurrect_uninstalled_managed_paths_or_inner_external_entries() {
    use std::os::unix::fs::PermissionsExt;
    let data = tempfile::tempdir().unwrap();
    let root = data.path().join("agents/pi/managed-old");
    let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
    let (initial, receipt) = candidate_fixture(&store, &root);
    let current = choose_program(&initial, receipt.path.to_str().unwrap());
    store.replace_agent_launch(&current).unwrap();
    let current = store.get_agent("pi").unwrap().unwrap();
    record_with_program(&store, &current, &root, Some(&receipt)).unwrap();
    let external = data.path().join("external-pi");
    std::fs::write(&external, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&external, std::fs::Permissions::from_mode(0o755)).unwrap();
    let active_alias = root.canonicalize().unwrap().join("selected-outside-link");
    std::os::unix::fs::symlink(&external, &active_alias).unwrap();
    store
        .replace_agent_launch(&choose_program(&current, active_alias.to_str().unwrap()))
        .unwrap();
    let item = read(&store)
        .unwrap()
        .into_iter()
        .find(|item| item.managed_root.is_some())
        .unwrap();
    assert!(remove_installed(&store, data.path(), "pi", &item.id).is_err());
    assert!(root.exists());
    assert!(active_alias.exists());
    store.replace_agent_launch(&current).unwrap();
    let current = store.get_agent("pi").unwrap().unwrap();
    let inner = root.join("official-entry.js");
    std::fs::write(&inner, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&inner, std::fs::Permissions::from_mode(0o755)).unwrap();
    let inner_choice = choose_program(&current, inner.to_str().unwrap());
    commit_candidate(&store, &inner_choice, Some(&current), None).unwrap();
    let inner_choice = store.get_agent("pi").unwrap().unwrap();
    let alias = data.path().join("user-alias");
    std::os::unix::fs::symlink(&inner, &alias).unwrap();
    let alias_choice = choose_program(&inner_choice, alias.to_str().unwrap());
    commit_candidate(&store, &alias_choice, Some(&inner_choice), None).unwrap();
    let alias_choice = store.get_agent("pi").unwrap().unwrap();
    let outside = choose_program(&alias_choice, external.to_str().unwrap());
    commit_candidate(&store, &outside, Some(&alias_choice), None).unwrap();
    let item = read(&store)
        .unwrap()
        .into_iter()
        .find(|item| item.managed_root.is_some())
        .unwrap();
    // A valid legacy record can refer to another Agent's owned program without
    // having a program-only inventory item of its own.
    let mut codex = outside.clone();
    codex.id = "codex".into();
    codex.name = "Codex".into();
    codex.env = vec![
        ("CODEX_PATH".into(), inner.display().to_string()),
        ("KEPT_OPTION".into(), "unchanged".into()),
    ];
    store.insert_agent(&codex).unwrap();
    assert!(remove_installed(&store, data.path(), "pi", &item.id).is_err());
    assert!(inner.exists());
    let codex = choose_program(&codex, external.to_str().unwrap());
    store.replace_agent_launch(&codex).unwrap();
    let codex = store.get_agent("codex").unwrap().unwrap();
    let mut legacy = serde_json::json!({
        "programEnv":"CODEX_PATH", "programPath":inner.to_str().unwrap(),
        "command":"kept-command", "args":["kept-argument"],
        "version":"kept-version", "source":"kept-source"
    });
    store.set_setting("installPrevious.codex", &legacy).unwrap();
    assert!(
        !read(&store)
            .unwrap()
            .iter()
            .any(|item| item.agent_id == "codex")
    );
    remove_installed(&store, data.path(), "pi", &item.id).unwrap();
    assert!(!root.exists());
    assert!(
        std::fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(store.get_setting("installPrevious.pi").unwrap().unwrap()["programPath"].is_null());
    legacy["programPath"] = serde_json::Value::Null;
    assert_eq!(
        store.get_setting("installPrevious.codex").unwrap().unwrap(),
        legacy
    );
    assert_eq!(store.get_agent("codex").unwrap().unwrap(), codex);
    assert!(
        !inventory_with_discovered(&store, vec![], "codex")
            .unwrap()
            .iter()
            .any(|item| item.path == inner.to_str().unwrap())
    );
    let codex_next = choose_program(&codex, "/bin/sh");
    commit_candidate(&store, &codex_next, Some(&codex), None).unwrap();
    assert!(
        !read(&store)
            .unwrap()
            .iter()
            .any(|item| item.path == inner.to_str().unwrap())
    );
    let items = inventory_with_discovered(&store, vec![], "pi").unwrap();
    assert!(
        !items
            .iter()
            .any(|item| item.path == alias.to_str().unwrap())
    );
    assert!(
        !items
            .iter()
            .any(|item| { item.program_only && Path::new(&item.path).starts_with(&root) })
    );
    let current = store.get_agent("pi").unwrap().unwrap();
    let next = choose_program(&current, "/bin/sh");
    commit_candidate(&store, &next, Some(&current), None).unwrap();
    assert!(
        !read(&store)
            .unwrap()
            .iter()
            .any(|item| { item.program_only && Path::new(&item.path).starts_with(&root) })
    );
    assert!(external.exists());
}

#[test]
fn program_history_uninstall_metadata_failures_keep_the_owned_receipt_for_exact_retry() {
    for failing_key in ["installPrevious.pi", "installations.v1"] {
        let data = tempfile::tempdir().unwrap();
        let root = data.path().join("agents/pi/managed-old");
        let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
        let (initial, receipt) = candidate_fixture(&store, &root);
        let current = choose_program(&initial, receipt.path.to_str().unwrap());
        store.replace_agent_launch(&current).unwrap();
        let current = store.get_agent("pi").unwrap().unwrap();
        record_with_program(&store, &current, &root, Some(&receipt)).unwrap();
        let alias = alias_chain(data.path(), &receipt.path, 12);
        let alias_choice = choose_program(&current, alias.to_str().unwrap());
        commit_candidate(&store, &alias_choice, Some(&current), None).unwrap();
        let alias_choice = store.get_agent("pi").unwrap().unwrap();
        let outside = choose_program(&alias_choice, "/bin/sh");
        commit_candidate(&store, &outside, Some(&alias_choice), None).unwrap();
        let outside = store.get_agent("pi").unwrap().unwrap();
        let item = read(&store)
            .unwrap()
            .into_iter()
            .find(|item| item.managed_root.is_some())
            .unwrap();
        let connection = rusqlite::Connection::open(data.path().join("meta.db")).unwrap();
        connection
            .execute_batch(&format!(
                "CREATE TRIGGER uninstall_failure BEFORE UPDATE ON settings
             WHEN NEW.key = '{failing_key}'
             BEGIN SELECT RAISE(ABORT, 'fixture'); END;"
            ))
            .unwrap();
        assert!(remove_installed(&store, data.path(), "pi", &item.id).is_err());
        assert!(!root.exists());
        assert!(
            read(&store)
                .unwrap()
                .iter()
                .any(|known| known.id == item.id)
        );
        assert!(owned_root(&item, data.path()).is_ok());
        assert_eq!(store.get_agent("pi").unwrap().unwrap(), outside);
        connection
            .execute_batch("DROP TRIGGER uninstall_failure;")
            .unwrap();
        remove_installed(&store, data.path(), "pi", &item.id).unwrap();
        assert!(
            !read(&store)
                .unwrap()
                .iter()
                .any(|known| known.id == item.id)
        );
        assert!(store.get_setting("installPrevious.pi").unwrap().unwrap()["programPath"].is_null());
        assert!(
            std::fs::symlink_metadata(&alias)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(store.get_agent("pi").unwrap().unwrap(), outside);
    }
}
