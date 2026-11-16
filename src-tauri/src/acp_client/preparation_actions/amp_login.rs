//! The Amp adapter's separate, documented companion account login.
use super::{
    AgentRow, MetaStore, Path, PreparationAction, exact_file, matching_registry_installation,
    recorded_installations,
};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};

pub(super) const AGENT: &str = "registry:amp-acp";
pub(super) const ACTION: &str = "login-amp-account";
const KEY: &str = "AMP_API_KEY";
const COMPANION: &str = "AMP_CLI_PATH";
const TRANSPORT: &str = "AMP_ACP_TRANSPORT";
const SERVER: &str = "AMP_URL";
const CONFLICT: &str = "当前设置会优先使用 Amp API 密钥或其他连接方式，请先检查账号来源";

pub(super) fn action(
    store: &MetaStore,
    row: &AgentRow,
    data: &Path,
) -> Result<Option<PreparationAction>, String> {
    // The 0.9.0 registry binary uses the selected Amp CLI by default. This
    // scope governs the supplemental action only, never the ACP connection.
    if row.id != AGENT
        || row.source != "registry"
        || row.version.as_deref() != Some("0.9.0")
        || !row.args.is_empty()
        || crate::process_platform::program_name(Path::new(&row.command)).as_deref()
            != Some("amp-acp")
        || !exact_file(Path::new(&row.command))
    {
        return Ok(None);
    }
    let [(name, path)] = row.env.as_slice() else {
        return Ok(None);
    };
    let program = Path::new(path);
    let filename = if cfg!(windows) { "amp.exe" } else { "amp" };
    if name != COMPANION
        || !program.is_absolute()
        || !exact_file(program)
        || !crate::process_platform::executable(program)
    {
        return Ok(None);
    }
    let items = recorded_installations(store)?;
    let adapter_matches = items
        .iter()
        .filter(|item| matching_registry_installation(row, item, data))
        .count();
    let companion_matches = items
        .iter()
        .filter(|item| {
            item.agent_id == row.id
                && item.source == "managed"
                && item.program_only
                && item.args.is_empty()
                && item.command == *path
                && item.path == *path
                && crate::installations::owned_root(item, data)
                    .is_ok_and(|root| root.join(filename) == program)
        })
        .count();
    let (config_env, home_env) = config_environment_names();
    if adapter_matches != 1
        || companion_matches != 1
        || crate::credentials::has_environment_grant(
            store,
            AGENT,
            &[KEY, COMPANION, TRANSPORT, SERVER, config_env, home_env],
        )?
    {
        return Ok(None);
    }
    Ok(Some(PreparationAction {
        id: ACTION.into(),
        purpose: "account_login",
        transport: "terminal",
        command: path.clone(),
        args: vec!["login".into()],
        source_url: "https://ampcode.com/docs/cli#manage-cli-accounts".into(),
    }))
}

pub(super) fn check_environment(env: &HashMap<String, String>) -> Result<(), String> {
    check_environment_with(env, |name| std::env::var_os(name))
}

fn config_environment_names() -> (&'static str, &'static str) {
    // Grants redirecting the adapter's configuration are excluded from this
    // action because the separately launched CLI receives no Farfold grants.
    if cfg!(windows) {
        ("APPDATA", "USERPROFILE")
    } else {
        ("XDG_CONFIG_HOME", "HOME")
    }
}

fn check_environment_with(
    env: &HashMap<String, String>,
    inherited: impl Fn(&str) -> Option<OsString>,
) -> Result<(), String> {
    let names = crate::shell_env::EnvNames::current();
    // The PTY inherits process variables in addition to this overlay. Presence
    // alone blocks the account action; the API key value never leaves the environment.
    if names.contains(env, KEY) || inherited(KEY).is_some() {
        return Err(CONFLICT.into());
    }
    let transport = names
        .get(env, TRANSPORT)?
        .map(OsString::from)
        .or_else(|| inherited(TRANSPORT));
    if transport.is_some_and(|value| value != OsStr::new("cli")) {
        return Err(CONFLICT.into());
    }
    // amp-acp v0.9.0 imports its own credentials at adapter startup. This
    // action directly starts the companion CLI, outside that process.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{super::*, *};
    use crate::acp_client::auth_route::{ManagedTerminalProof, Route, route};
    use crate::installations::{ProgramReceipt, record, record_with_program};
    use crate::managed_paths::{Layout, parent};
    use serde_json::json;
    use std::path::PathBuf;

    fn write_program(root: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(root).unwrap();
        let program = root.join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        });
        std::fs::write(&program, "never run this fixture").unwrap();
        crate::process_platform::set_executable(&program).unwrap();
        program
    }

    fn receipt(program: PathBuf) -> ProgramReceipt {
        ProgramReceipt {
            path: program,
            version: Some("0.0.1790740844-g023754".into()),
            node_launch: None,
            release: None,
        }
    }

    fn fixture() -> (tempfile::TempDir, MetaStore, AgentRow) {
        let data = tempfile::tempdir().unwrap();
        let base = data.path().canonicalize().unwrap();
        let adapter_root = parent(&base, AGENT, Layout::Agent).join("install-fixture");
        let cli_root = parent(&base, AGENT, Layout::Companion).join("dependency-amp-cli-fixture");
        let adapter = write_program(&adapter_root, "amp-acp");
        let cli = write_program(&cli_root, "amp");
        let row = AgentRow {
            id: AGENT.into(),
            name: "Amp".into(),
            source: "registry".into(),
            command: adapter.display().to_string(),
            args: vec![],
            env: vec![(COMPANION.into(), cli.display().to_string())],
            version: Some("0.9.0".into()),
            handshake: None,
            created_at: 1,
            updated_at: 1,
        };
        let store = MetaStore::open(&base.join("meta.db")).unwrap();
        store.insert_agent(&row).unwrap();
        record(&store, &row, &adapter_root).unwrap();
        record_with_program(&store, &row, &cli_root, Some(&receipt(cli))).unwrap();
        (data, store, row)
    }

    #[test]
    fn amp_login_adds_its_own_action_and_keeps_the_declared_api_key_terminal() {
        let (data, store, row) = fixture();
        let action = actions_for(&store, &row, data.path()).unwrap().remove(0);
        assert_eq!(action.id, ACTION);
        assert_eq!(action.purpose, "account_login");
        assert_eq!(action.command, row.env[0].1);
        assert_eq!(action.args, ["login"]);
        assert_eq!(store.get_agent(AGENT).unwrap(), Some(row.clone()));
        let declared = json!({
            "id":"setup", "name":"Amp API Key Setup",
            "_meta":{"terminal-auth":{"command":row.command,"args":["--setup"]}}
        });
        let Route::Terminal(terminal) = route(&row, &declared, &ManagedTerminalProof::default())
        else {
            panic!("declared adapter terminal unavailable");
        };
        assert_eq!(terminal.argv, [row.command, "--setup".into()]);
    }

    #[test]
    fn amp_login_rejects_missing_receipts_and_unowned_or_stale_companions() {
        let (data, store, row) = fixture();
        let action = actions_for(&store, &row, data.path()).unwrap().remove(0);
        let expected = |candidate: &AgentRow, command: &str, args: &[String]| {
            reviewed_action(&store, candidate, data.path(), ACTION, command, args)
        };
        assert_eq!(
            expected(&row, &action.command, &action.args),
            Ok(action.clone())
        );
        assert!(expected(&row, &row.command, &action.args).is_err());
        assert!(expected(&row, &action.command, &["--setup".into()]).is_err());
        let recorded = store.get_setting("installations.v1").unwrap().unwrap();
        for removed_index in 0..2 {
            let mut missing = recorded.clone();
            missing.as_array_mut().unwrap().remove(removed_index);
            store.set_setting("installations.v1", &missing).unwrap();
            assert!(expected(&row, &action.command, &action.args).is_err());
        }
        store.set_setting("installations.v1", &recorded).unwrap();

        let new_root = parent(
            &data.path().canonicalize().unwrap(),
            AGENT,
            Layout::Companion,
        )
        .join("dependency-amp-cli-new");
        let alternative = write_program(&new_root, "amp");
        let mut changed = row.clone();
        changed.env[0].1 = alternative.display().to_string();
        assert!(expected(&changed, &changed.env[0].1, &action.args).is_err());
        record_with_program(&store, &row, &new_root, Some(&receipt(alternative))).unwrap();
        assert!(expected(&changed, &action.command, &action.args).is_err());
        assert!(expected(&changed, &changed.env[0].1, &action.args).is_ok());
    }

    #[test]
    fn amp_login_rejects_key_sources_without_loading_credentials() {
        let (data, store, mut row) = fixture();
        row.env.push((KEY.into(), "__keychain__".into()));
        assert!(actions_for(&store, &row, data.path()).unwrap().is_empty());
        row.env.pop();
        for env_name in [KEY, SERVER, config_environment_names().0] {
            store.set_setting("credentials.v1", &json!([{
                "id":"fixture", "label":"fixture", "provider":"fixture", "endpoint":"fixture",
                "apiType":"responses", "secretRef":"never-look-up-this-fixture", "retired":[],
                "grants":[{"agentId":AGENT,"envName":env_name,"overrideExisting":true}], "deleting":false
            }])).unwrap();
            assert!(actions_for(&store, &row, data.path()).unwrap().is_empty());
        }
        let shell = HashMap::from([(KEY.into(), String::new())]);
        assert_eq!(
            check_environment_with(&shell, |_| None),
            Err(CONFLICT.into())
        );
        assert_eq!(
            check_environment_with(&HashMap::new(), |name| (name == KEY).then(OsString::new)),
            Err(CONFLICT.into())
        );
    }

    #[test]
    fn amp_login_transport_must_be_the_literal_cli_value() {
        for value in ["cli/", "sdk", ""] {
            let env = HashMap::from([(TRANSPORT.into(), value.into())]);
            assert_eq!(check_environment_with(&env, |_| None), Err(CONFLICT.into()));
        }
        let env = HashMap::from([(TRANSPORT.into(), "cli".into())]);
        assert_eq!(check_environment_with(&env, |_| None), Ok(()));
        assert_eq!(
            check_environment_with(&HashMap::new(), |name| (name == TRANSPORT)
                .then(|| "sdk".into())),
            Err(CONFLICT.into())
        );
    }

    #[test]
    fn amp_login_allows_the_separately_stored_adapter_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let adapter_directory = root.join("amp-acp");
        let credential_file = adapter_directory.join("credentials.json");
        std::fs::create_dir(&adapter_directory).unwrap();
        std::fs::write(&credential_file, "synthetic adapter fixture").unwrap();
        let env = HashMap::from([(
            config_environment_names().0.into(),
            root.display().to_string(),
        )]);
        assert_eq!(check_environment_with(&env, |_| None), Ok(()));
        assert_eq!(
            std::fs::read_to_string(credential_file).unwrap(),
            "synthetic adapter fixture"
        );
    }
}
