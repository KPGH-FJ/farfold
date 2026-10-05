//! Existing inventory/transaction integration, using only task-owned executable fixtures.
use super::*;
use crate::acp_client::installation_parameters::{InstallationInput, compile_args, options};
use crate::agent_catalog::{RegistryAgent, registry_launch};
use std::collections::BTreeMap;

fn candidate(data: &Path, index: usize, value: &str) -> (AgentRow, PathBuf) {
    let id = "registry:fast-agent";
    let root = crate::managed_paths::prepare_agent_parent(data, id)
        .unwrap()
        .join(format!("install-{index}"));
    let command = root.join(if cfg!(windows) {
        "venv/Scripts/fast-agent-acp.exe"
    } else {
        "venv/bin/fast-agent-acp"
    });
    std::fs::create_dir_all(command.parent().unwrap()).unwrap();
    std::fs::write(&command, "#!/bin/sh\nexit 0\n").unwrap();
    // Only metadata selection is exercised; this fixture is never executed.
    crate::process_platform::set_executable(&command).unwrap();
    let entry: RegistryAgent = serde_json::from_value(serde_json::json!({
        "id":"fast-agent","version":"0.10.1",
        "distribution":{"uvx":{"package":"fast-agent-acp==0.10.1","args":["-x"],"env":{}}}
    }))
    .unwrap();
    let launch = registry_launch(&entry).unwrap();
    let options = options(&entry, &launch, None).unwrap();
    let input = InstallationInput {
        declaration_id: options.declaration_id,
        registry_version: options.registry_version,
        launch: options.launch,
        values: BTreeMap::from([("model".into(), value.into())]),
    };
    let args = compile_args(&entry, &launch, None, Some(&input)).unwrap();
    (
        AgentRow {
            id: id.into(),
            name: "fast-agent".into(),
            source: "registry".into(),
            command: command.display().to_string(),
            args,
            env: vec![
                ("KEPT_SETTING".into(), "original".into()),
                ("USER_SECRET_REF".into(), "__keychain__".into()),
            ],
            version: Some("0.10.1".into()),
            handshake: None,
            created_at: 1,
            updated_at: index as i64,
        },
        root,
    )
}

#[test]
fn startup_parameters_survive_three_installations_and_cold_inventory_reselection() {
    let data = tempfile::tempdir().unwrap();
    let database = data.path().join("meta.db");
    let store = MetaStore::open(&database).unwrap();
    let (first, first_root) = candidate(data.path(), 1, "$system.default");
    commit_candidate(&store, &first, None, Some(&first_root)).unwrap();
    let (second, second_root) = candidate(data.path(), 2, "provider.second-model");
    let expected = store.get_agent(&first.id).unwrap().unwrap();
    commit_candidate(&store, &second, Some(&expected), Some(&second_root)).unwrap();
    let (third, third_root) = candidate(data.path(), 3, "provider.third-model");
    let expected = store.get_agent(&first.id).unwrap().unwrap();
    commit_candidate(&store, &third, Some(&expected), Some(&third_root)).unwrap();
    drop(store);
    let store = MetaStore::open(&database).unwrap();
    let items = inventory_with_discovered(&store, vec![], &first.id).unwrap();
    assert_eq!(items.len(), 3);
    for row in [&first, &second, &third] {
        let item = items
            .iter()
            .find(|item| item.command == row.command)
            .unwrap();
        assert_eq!(item.args, row.args);
    }
    let old = items
        .iter()
        .find(|item| item.command == first.command)
        .unwrap();
    let current = store.get_agent(&first.id).unwrap().unwrap();
    let restored = selection_candidate(old, &current, data.path(), || Ok(())).unwrap();
    assert_eq!(restored.args, first.args);
    assert_eq!(restored.env, current.env);
    commit_candidate(&store, &restored, Some(&current), None).unwrap();
    assert!(selected(old, store.get_agent(&first.id).unwrap().as_ref()));
    assert_eq!(
        store.get_agent(&first.id).unwrap().unwrap().args,
        vec!["-x", "--model", "$system.default"]
    );
}

#[test]
fn stale_candidate_or_cancel_does_not_publish_parameters_or_lose_old_selection() {
    let data = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
    let (old, old_root) = candidate(data.path(), 1, "$system.default");
    commit_candidate(&store, &old, None, Some(&old_root)).unwrap();
    let expected = store.get_agent(&old.id).unwrap().unwrap();
    let (next, next_root) = candidate(data.path(), 2, "provider.changed-model");
    let lease = crate::install_job::begin(
        "startup-parameter-cancel",
        tauri::ipc::Channel::new(|_| Ok(())),
    )
    .unwrap();
    crate::install_job::agent_install_cancel("startup-parameter-cancel".into()).unwrap();
    assert!(
        lease
            .job
            .commit(|| commit_candidate(&store, &next, Some(&expected), Some(&next_root)))
            .is_err()
    );
    assert_eq!(store.get_agent(&old.id).unwrap().unwrap(), expected);
    let mut changed = expected.clone();
    changed
        .env
        .push(("CONCURRENT_SETTING".into(), "changed".into()));
    store.replace_agent_launch(&changed).unwrap();
    let changed = store.get_agent(&old.id).unwrap().unwrap();
    let before = store.get_setting("installations.v1").unwrap();
    assert!(commit_candidate(&store, &next, Some(&expected), Some(&next_root)).is_err());
    assert_eq!(store.get_agent(&old.id).unwrap().unwrap(), changed);
    assert_eq!(store.get_setting("installations.v1").unwrap(), before);
    assert_eq!(
        store
            .get_setting(&format!("installPrevious.{}", old.id))
            .unwrap(),
        Some(serde_json::Value::Null)
    );
}

#[test]
fn unselected_receipt_keeps_argv_without_changing_the_selected_agent() {
    let data = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
    let (old, old_root) = candidate(data.path(), 1, "$system.default");
    commit_candidate(&store, &old, None, Some(&old_root)).unwrap();
    let expected = store.get_agent(&old.id).unwrap().unwrap();
    let (unselected, root) = candidate(data.path(), 2, "provider.candidate-model");
    record(&store, &unselected, &root).unwrap();
    assert_eq!(store.get_agent(&old.id).unwrap().unwrap(), expected);
    let items = inventory_with_discovered(&store, vec![], &old.id).unwrap();
    let item = items
        .iter()
        .find(|item| item.command == unselected.command)
        .unwrap();
    assert_eq!(item.args, unselected.args);
    assert!(!selected(item, Some(&expected)));
    let mut external = item.clone();
    external.managed_root = None;
    external.source = "external".into();
    assert!(owned_root(&external, data.path()).is_err());
}
