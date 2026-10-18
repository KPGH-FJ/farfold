//! Verified authentication extensions. Standard terminal args are never rewritten.
//! Qwen's published 0.24.5 authMethods uses `_meta.type/args`; its documented
//! setup entry is the interactive CLI followed by /auth, not a login-only command.
//! Sources: QwenLM/qwen-code packages/cli/src/acp-integration/authMethods.ts and
//! https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
use crate::meta_store::AgentRow;
use std::path::Path;

pub(crate) struct TerminalSetup {
    pub argv: Vec<String>,
    pub description: &'static str,
}

/// Only a registry identity with the installed official Node entry can use this
/// compatibility route. Arbitrary user args and executable names are not guessed.
pub(crate) fn terminal_setup(row: &AgentRow, method: &serde_json::Value) -> Option<TerminalSetup> {
    if row.id != "registry:qwen-code"
        || row.source != "registry"
        || method.get("type").is_some()
        || method.get("id")?.as_str()? != "openai"
        || method.pointer("/_meta/type")?.as_str()? != "terminal"
        || method.pointer("/_meta/args")? != &serde_json::json!(["--auth-type=openai"])
    {
        return None;
    }
    let command = Path::new(&row.command);
    if !command.is_absolute()
        || !command.is_file()
        || crate::process_platform::program_name(command).as_deref() != Some("node")
    {
        return None;
    }
    let (entry, protocol_args) = row.args.split_first()?;
    // These are the two verified registry shapes; this is not a generic flag
    // filter. A changed declaration remains usable through its standard methods.
    if protocol_args != ["--acp"] && protocol_args != ["--acp", "--experimental-skills"] {
        return None;
    }
    let entry_path = Path::new(entry);
    if !entry_path.is_absolute() || !entry_path.is_file() {
        return None;
    }
    let package = entry_path.parent()?;
    if package.file_name()?.to_str()? != "qwen-code"
        || package.parent()?.file_name()?.to_str()? != "@qwen-code"
        || package.parent()?.parent()?.file_name()?.to_str()? != "node_modules"
    {
        return None;
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package.join("package.json")).ok()?).ok()?;
    if manifest.get("name")?.as_str()? != "@qwen-code/qwen-code" {
        return None;
    }
    let declared_entry = manifest.pointer("/bin/qwen")?.as_str()?;
    if declared_entry != "cli-entry.js" {
        return None;
    }
    if std::fs::canonicalize(entry_path).ok()?
        != std::fs::canonicalize(package.join(declared_entry)).ok()?
    {
        return None;
    }
    Some(TerminalSetup {
        argv: vec![
            row.command.clone(),
            entry.clone(),
            "--auth-type=openai".into(),
        ],
        description: "在打开的终端中输入 /auth 配置服务。完成后点击“返回检查”，再验证所选模型。",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, AgentRow, serde_json::Value) {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("node_modules/@qwen-code/qwen-code");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@qwen-code/qwen-code","bin":{"qwen":"cli-entry.js"}}"#,
        )
        .unwrap();
        std::fs::write(package.join("cli-entry.js"), "").unwrap();
        let node = dir
            .path()
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        std::fs::write(&node, "").unwrap();
        let row = AgentRow {
            id: "registry:qwen-code".into(),
            name: "Qwen Code".into(),
            source: "registry".into(),
            command: node.display().to_string(),
            args: vec![
                package.join("cli-entry.js").display().to_string(),
                "--acp".into(),
                "--experimental-skills".into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        let method = serde_json::json!({"id":"openai", "_meta":{"type":"terminal", "args":["--auth-type=openai"]}});
        (dir, row, method)
    }

    #[test]
    fn verified_setup_uses_the_entry_without_protocol_mode() {
        let (_dir, row, method) = fixture();
        let setup = terminal_setup(&row, &method).unwrap();
        assert_eq!(
            setup.argv,
            vec![
                row.command,
                row.args[0].clone(),
                "--auth-type=openai".into()
            ]
        );
    }

    #[test]
    fn does_not_treat_other_programs_or_node_helpers_as_node() {
        let (dir, row, method) = fixture();
        let mut names = vec!["other.exe", "node-helper.exe", "node-helper"];
        if cfg!(unix) {
            names.push("node.exe");
        }
        for name in names {
            let program = dir.path().join(name);
            std::fs::write(&program, "").unwrap();
            let changed = AgentRow {
                command: program.display().to_string(),
                ..row.clone()
            };
            assert!(terminal_setup(&changed, &method).is_none(), "{name}");
        }
    }

    #[test]
    fn does_not_rewrite_unknown_or_user_configured_launches() {
        let (_dir, row, method) = fixture();
        for changed in [
            AgentRow {
                id: "custom-qwen".into(),
                ..row.clone()
            },
            AgentRow {
                source: "custom".into(),
                ..row.clone()
            },
            AgentRow {
                args: vec![row.args[0].clone(), "--acp".into(), "--unknown".into()],
                ..row.clone()
            },
            AgentRow {
                command: "/bin/sh".into(),
                ..row.clone()
            },
        ] {
            assert!(terminal_setup(&changed, &method).is_none());
        }
        assert!(
            terminal_setup(
                &row,
                &serde_json::json!({"id":"openai","type":"terminal","args":["--login"]})
            )
            .is_none()
        );
    }
}
