//! Public synthetic package metadata only; no selected Agent or official CLI.
use super::*;

fn fixture(root: &Path) -> AgentRow {
    let package = root.join("node_modules/@agentclientprotocol/codex-acp");
    let entry = package.join("dist/index.js");
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    std::fs::write(&entry, "// synthetic public entry").unwrap();
    std::fs::write(package.join("package.json"), r#"{"name":"@agentclientprotocol/codex-acp","version":"unselected-future-version","bin":{"codex-acp":"dist/index.js"}}"#).unwrap();
    let command = root.join(if cfg!(windows) { "node.exe" } else { "node" });
    std::fs::write(&command, "synthetic program; not executed").unwrap();
    crate::process_platform::set_executable(&command).unwrap();
    AgentRow {
        id: "registry:codex-acp".into(),
        name: "fixture".into(),
        source: "registry".into(),
        command: command.to_string_lossy().into_owned(),
        args: vec![entry.to_string_lossy().into_owned()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn fixed_commands_keep_reviewed_entry_literal_arguments_and_selected_environment() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap();
    let mut row = fixture(&cwd);
    assert!(admission(&row).is_ok());
    row.version = Some("not-a-version-pin".into());
    assert!(admission(&row).is_ok());
    for kind in [Kind::Mcp, Kind::Skills] {
        let command = command(&row, cwd.to_str().unwrap(), HashMap::new(), kind).unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|v| v.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], row.args[0]);
        assert_eq!(
            &args[1..],
            if kind == Kind::Mcp {
                &["cli", "mcp", "list", "--json"]
            } else {
                &["cli", "app-server", "--listen", "stdio://"]
            }
        );
        assert_eq!(command.get_current_dir(), Some(cwd.as_path()));
    }
    let command = mcp_get_command(
        &row,
        cwd.to_str().unwrap(),
        HashMap::new(),
        "--literal-name",
    )
    .unwrap();
    let args: Vec<_> = command
        .get_args()
        .map(|v| v.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        &args[1..],
        &["cli", "mcp", "get", "--json", "--", "--literal-name"]
    );
    row.args.push("unreviewed-extra-argument".into());
    assert_eq!(admission(&row).unwrap_err().code, Code::EntryUnverified);
}

#[test]
fn windows_support_does_not_admit_custom_sources_or_credential_placeholders() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap();
    let mut row = fixture(&cwd);
    row.source = "custom".into();
    assert_eq!(admission(&row).unwrap_err().code, Code::EntryUnverified);
    row.source = "registry".into();
    row.env
        .push(("TOKEN".into(), crate::auth::KEYCHAIN_MARKER.into()));
    assert_eq!(
        admission(&row).unwrap_err().code,
        Code::EnvironmentUnavailable
    );
}
