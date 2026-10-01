use super::*;
use std::os::unix::fs::PermissionsExt;

fn fixture(directory: &std::path::Path, postinstall: &str) -> node_runtime::NodeRuntime {
    let npm = directory.join("npm");
    let node = directory.join("node");
    std::fs::write(&node, "#!/bin/sh\nexit 77\n").unwrap();
    std::fs::write(&npm, format!("#!/bin/sh\nset -eu\nmkdir -p \"$3/node_modules/fixture/bin\"\nprintf '%s' '{{\"name\":\"fixture\",\"version\":\"0.230.0\",\"bin\":\"bin/entry\"}}' > \"$3/node_modules/fixture/package.json\"\n{postinstall}\n")).unwrap();
    for path in [&npm, &node] {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    node_runtime::NodeRuntime {
        node,
        npm: node_runtime::NpmRunner::System { npm },
        source: "fixture",
        version: None,
    }
}

fn reviewed(previous: AgentRow) -> ReviewedInstallation {
    let entry: RegistryAgent = serde_json::from_value(serde_json::json!({
        "id":"fixture", "name":"Fixture", "version":"0.230.0",
        "distribution":{"npx":{"package":"fixture@0.230.0",
            "args":["exec","--output-format","acp-daemon"],
            "env":{"PUBLIC_OPTION":"catalog", "CATALOG_ONLY":"keep"}}}
    }))
    .unwrap();
    let launch = crate::agent_catalog::registry_launch(&entry).unwrap();
    ReviewedInstallation {
        entry,
        launch,
        args: vec!["exec".into(), "--output-format".into(), "acp-daemon".into()],
        previous: Some(previous),
    }
}

fn previous() -> AgentRow {
    AgentRow {
        id: "registry:fixture".into(),
        name: "Keep name".into(),
        source: "registry".into(),
        command: "/bin/echo".into(),
        args: vec!["previous".into()],
        env: vec![
            ("PUBLIC_OPTION".into(), "user".into()),
            ("PRIVATE_MARKER".into(), "__keychain__".into()),
        ],
        version: Some("0.1.0".into()),
        handshake: None,
        created_at: 1,
        updated_at: 2,
    }
}

#[test]
fn native_candidate_preserves_args_env_and_path_through_receipt_and_keep() {
    let mut directory = tempfile::tempdir().unwrap();
    let runtime = fixture(
        directory.path(),
        "/usr/bin/clang -x c - -o \"$3/node_modules/fixture/bin/entry\" <<'FIXTURE_C'\n#include <stdio.h>\nint main(int argc, char **argv) { for (int i=1; i<argc; ++i) { if (i>1) putchar(' '); fputs(argv[i], stdout); } putchar('\\n'); return 0; }\nFIXTURE_C",
    );
    let store = MetaStore::open(&directory.path().join("meta.db")).unwrap();
    let old = previous();
    store.insert_agent(&old).unwrap();
    let lease = crate::install_job::begin(
        "native-candidate-receipt",
        tauri::ipc::Channel::new(|_| Ok(())),
    )
    .unwrap();
    let mut candidate = prepare_from_registry(
        &old.id,
        reviewed(old.clone()),
        Some(&runtime),
        directory.path(),
        &lease.job,
    )
    .unwrap();
    assert_eq!(candidate.previous, Some(old.clone()));
    assert_eq!(store.get_agent(&old.id).unwrap(), Some(old.clone()));
    assert_eq!(
        candidate.row.args,
        vec!["exec", "--output-format", "acp-daemon"]
    );
    assert_eq!(candidate.row.created_at, old.created_at);
    assert_eq!(candidate.row.name, old.name);
    assert!(
        candidate
            .row
            .env
            .contains(&("PUBLIC_OPTION".into(), "user".into()))
    );
    assert!(
        candidate
            .row
            .env
            .contains(&("CATALOG_ONLY".into(), "keep".into()))
    );
    assert!(
        candidate
            .row
            .env
            .contains(&("PRIVATE_MARKER".into(), "__keychain__".into()))
    );
    let root = candidate.staging.path().canonicalize().unwrap();
    assert_eq!(
        root.parent().unwrap(),
        directory
            .path()
            .canonicalize()
            .unwrap()
            .join("agent-installations/agent-registry%3Afixture")
    );
    assert!(std::path::Path::new(&candidate.row.command).starts_with(&root));
    let output = crate::node_runtime::npm_entry_tests::run_fixture(
        std::process::Command::new(&candidate.row.command).args(&candidate.row.args),
        &mut [&mut candidate.staging, &mut directory],
    );
    assert!(output.status.success());
    assert_eq!(output.stdout, b"exec --output-format acp-daemon\n");
    // No real Agent is initialized. Exercise the existing storage commit after
    // the fixture check, and the production keep-in-place lifetime boundary.
    crate::installations::commit_candidate(&store, &candidate.row, Some(&old), Some(&root))
        .unwrap();
    let kept = candidate.staging.keep();
    assert_eq!(kept.canonicalize().unwrap(), root);
    let selected = store.get_agent(&old.id).unwrap().unwrap();
    // Selection legitimately stamps updated_at; all launch and user fields keep
    // the prepared values, and created_at remains the previous row's timestamp.
    let mut expected = candidate.row.clone();
    assert!(selected.updated_at >= expected.updated_at);
    expected.updated_at = selected.updated_at;
    assert_eq!(selected, expected);
    let receipts = store.get_setting("installations.v1").unwrap().unwrap();
    assert!(receipts.to_string().contains(&candidate.row.command));
    assert!(std::path::Path::new(&candidate.row.command).is_file());
}

#[test]
fn rejected_entry_drops_candidate_without_changing_previous_row_or_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = fixture(
        directory.path(),
        "/bin/ln -s /bin/echo \"$3/node_modules/fixture/bin/entry\"",
    );
    let store = MetaStore::open(&directory.path().join("meta.db")).unwrap();
    let old = previous();
    store.insert_agent(&old).unwrap();
    let lease = crate::install_job::begin(
        "native-candidate-rejected",
        tauri::ipc::Channel::new(|_| Ok(())),
    )
    .unwrap();
    assert!(
        prepare_from_registry(
            &old.id,
            reviewed(old.clone()),
            Some(&runtime),
            directory.path(),
            &lease.job
        )
        .is_err()
    );
    assert_eq!(store.get_agent(&old.id).unwrap(), Some(old.clone()));
    assert!(store.get_setting("installations.v1").unwrap().is_none());
    assert_eq!(
        std::fs::read_dir(
            directory
                .path()
                .join("agent-installations/agent-registry%3Afixture")
        )
        .unwrap()
        .count(),
        0
    );
}
