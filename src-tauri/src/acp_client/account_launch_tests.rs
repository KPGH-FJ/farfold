use super::*;
use crate::meta_store::AgentRow;

fn row(command: &Path, id: &str, args: Vec<String>) -> AgentRow {
    AgentRow {
        id: id.into(),
        name: "fixture".into(),
        source: "registry".into(),
        command: command.display().to_string(),
        args,
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    }
}

#[test]
fn reviewed_package_entry_is_required_without_a_wire_declaration() {
    let d = tempfile::tempdir().unwrap();
    let package = d.path().join("node_modules/@tencent-ai/codebuddy-code");
    std::fs::create_dir_all(package.join("bin")).unwrap();
    let bin = package.join("bin/codebuddy");
    std::fs::write(&bin, "// public entry fixture").unwrap();
    std::fs::write(
        package.join("package.json"),
        r#"{"name":"@tencent-ai/codebuddy-code","bin":{"codebuddy-code":"./bin/codebuddy"}}"#,
    )
    .unwrap();
    let mut a = row(
        &d.path().join("node"),
        "registry:codebuddy-code",
        vec![bin.display().to_string(), "--acp".into()],
    );
    assert_eq!(reviewed(&a), Some(AccountQuery::CodeBuddy));
    a.source = "custom".into();
    assert_eq!(reviewed(&a), None);
    a.source = "registry".into();
    a.args.push("--user-extra".into());
    assert_eq!(reviewed(&a), None);
    a.args.pop();
    std::fs::write(
        package.join("package.json"),
        r#"{"name":"other","bin":{"codebuddy-code":"./bin/codebuddy"}}"#,
    )
    .unwrap();
    assert_eq!(reviewed(&a), None);
}

#[test]
fn python_console_entry_uses_only_public_metadata_and_no_version_gate() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join("bin")).unwrap();
    std::fs::write(d.path().join("bin/vibe"), "# public entry fixture").unwrap();
    let info = d
        .path()
        .join("lib/python3.12/site-packages/mistral_vibe-9.9.9.dist-info");
    std::fs::create_dir_all(&info).unwrap();
    std::fs::write(
        info.join("METADATA"),
        "Name: mistral-vibe\nVersion: 9.9.9\n",
    )
    .unwrap();
    std::fs::write(
        info.join("entry_points.txt"),
        "[console_scripts]\nvibe = vibe.cli.launcher:main\n",
    )
    .unwrap();
    let a = row(
        &d.path().join("bin/vibe"),
        "registry:mistral-vibe",
        vec!["--acp".into()],
    );
    assert_eq!(reviewed(&a), Some(AccountQuery::Vibe));
    std::fs::write(
        info.join("entry_points.txt"),
        "[other]\nvibe = vibe.cli.launcher:main\n",
    )
    .unwrap();
    assert_eq!(reviewed(&a), None);
    std::fs::write(
        info.join("entry_points.txt"),
        "[console_scripts]\nvibe = other:main\n",
    )
    .unwrap();
    assert_eq!(reviewed(&a), None);
}

#[test]
fn unbounded_or_outside_package_metadata_is_not_inspected() {
    let d = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let p = outside.path().join("public.json");
    std::fs::write(&p, "{}").unwrap();
    assert!(text(&p, d.path()).is_none());
    std::fs::write(&p, "x".repeat((LIMIT + 1) as usize)).unwrap();
    assert!(text(&p, outside.path()).is_none());
}

#[test]
fn official_registry_standalone_vibe_entry_is_supported_without_guessing_custom_names() {
    let d = tempfile::tempdir().unwrap();
    let binary = d.path().join("vibe-acp");
    std::fs::write(&binary, "standalone public fixture").unwrap();
    let mut a = row(&binary, "registry:mistral-vibe", vec![]);
    assert_eq!(reviewed(&a), Some(AccountQuery::Vibe));
    a.source = "custom".into();
    assert_eq!(reviewed(&a), None);
    a.source = "registry".into();
    a.args.push("--unreviewed".into());
    assert_eq!(reviewed(&a), None);
}
