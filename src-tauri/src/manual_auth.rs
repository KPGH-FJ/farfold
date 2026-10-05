//! Explicit user login commands. No command is inferred from identity or prose.
use crate::{auth, meta_store::MetaStore, pty};
use serde::{Deserialize, Serialize};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualAuth {
    pub command: String,
    pub args: Vec<String>,
    pub env_name: Option<String>,
}
pub(crate) fn valid_env(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
fn setting_key(agent: &str, method: &str) -> String {
    format!("auth.manual.v1.{}", serde_json::json!([agent, method]))
}
fn validate(config: &ManualAuth) -> Result<(), String> {
    let path = Path::new(&config.command);
    if !path.is_absolute()
        || !path.is_file()
        || !path
            .metadata()
            .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    {
        return Err("请选择可执行文件的完整路径".into());
    }
    if config.args.iter().any(|arg| arg.contains('\0')) {
        return Err("登录参数无效".into());
    }
    if config
        .env_name
        .as_deref()
        .is_some_and(|name| !valid_env(name))
    {
        return Err("密钥变量名无效".into());
    }
    Ok(())
}
fn read(store: &MetaStore, agent: &str, method: &str) -> Result<Option<ManualAuth>, String> {
    match store.get_setting(&setting_key(agent, method))? {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value)
            .map(Some)
            .map_err(|_| "无法读取登录配置".into()),
    }
}
#[tauri::command]
pub fn auth_manual_get(
    app: AppHandle,
    agent_id: String,
    method_id: String,
) -> Result<Option<ManualAuth>, String> {
    read(&app.state::<MetaStore>(), &agent_id, &method_id)
}
#[tauri::command]
pub async fn auth_manual_set(
    app: AppHandle,
    agent_id: String,
    method_id: String,
    config: Option<ManualAuth>,
) -> Result<(), String> {
    let configuration = crate::install_job::configuration_guard(&agent_id).await;
    tauri::async_runtime::spawn_blocking(move || {
        let _configuration = configuration;
        let store = app.state::<MetaStore>();
        if store.get_agent(&agent_id)?.is_none() {
            return Err("请先连接 Agent".into());
        }
        if let Some(value) = &config {
            validate(value)?;
        }
        store.set_setting(
            &setting_key(&agent_id, &method_id),
            &serde_json::to_value(config).map_err(|_| "无法保存登录配置")?,
        )
    })
    .await
    .map_err(|_| "登录配置未能保存".to_string())?
}
#[tauri::command]
pub async fn auth_manual_run(
    app: AppHandle,
    agent_id: String,
    method_id: String,
    cwd: String,
    source: Option<String>,
    attempt_id: String,
    on_output: Channel<serde_json::Value>,
) -> Result<String, String> {
    if source.as_ref().is_some_and(|value| !value.is_empty()) {
        return Err("当前使用 API 配置，请返回 API 设置检查此服务".into());
    }
    let attempt = auth::attempts::reserve(&agent_id, &attempt_id)?;
    let cwd = attempt
        .setup(crate::acp_client::manager::validate_cwd_async(&cwd))
        .await?;
    let configuration = attempt.configuration_guard().await?;
    attempt.check()?;
    let scope = app
        .state::<crate::acp_client::manager::AcpManager>()
        .reserve_account_change(&agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        attempt.check()?;
        let store = app.state::<MetaStore>();
        let row = store.get_agent(&agent_id)?.ok_or("请先连接 Agent")?;
        let config = read(&store, &agent_id, &method_id)?.ok_or("请先保存登录配置")?;
        validate(&config)?;
        auth::terminal::run(
            &app.state::<pty::PtyManager>(),
            &config.command,
            &config.args,
            &cwd,
            auth::terminal::Ownership {
                output: on_output,
                configuration,
                scope,
                attempt,
            },
            || Ok(auth::environment_for(&store, &row)?.into_iter().collect()),
        )
        .map_err(run_error)
    })
    .await
    .map_err(|_| "登录操作未完成")?
}
fn run_error(error: String) -> String {
    if error == "AUTH_CANCELLED" {
        error
    } else {
        "无法运行登录命令".into()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_new_environment_only_or_empty_command_configuration() {
        for env_name in [None, Some("LEGACY_KEY".into())] {
            let config = ManualAuth {
                command: String::new(),
                args: vec![],
                env_name,
            };
            assert_eq!(validate(&config), Err("请选择可执行文件的完整路径".into()));
        }
    }

    #[test]
    fn legacy_environment_only_settings_remain_readable_and_repairable() {
        let directory = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&directory.path().join("meta.db")).unwrap();
        let key = setting_key("legacy-agent", "login");
        let original = serde_json::json!({
            "command": "",
            "args": [],
            "envName": "LEGACY_KEY"
        });
        store.set_setting(&key, &original).unwrap();
        let mut config = read(&store, "legacy-agent", "login").unwrap().unwrap();
        assert!(validate(&config).is_err());
        assert_eq!(store.get_setting(&key).unwrap(), Some(original));

        config.command = "/bin/echo".into();
        config.args = vec!["login".into()];
        validate(&config).unwrap();
        store
            .set_setting(&key, &serde_json::to_value(&config).unwrap())
            .unwrap();
        let restored = read(&store, "legacy-agent", "login").unwrap().unwrap();
        assert_eq!(restored.command, "/bin/echo");
        assert_eq!(restored.args, ["login"]);
        assert_eq!(restored.env_name.as_deref(), Some("LEGACY_KEY"));
    }

    #[test]
    fn validates_explicit_arguments_without_shell_interpretation() {
        let cfg = ManualAuth {
            command: "/bin/echo".into(),
            args: vec!["$(touch SHOULD_NOT_EXIST)".into()],
            env_name: Some("API_KEY".into()),
        };
        validate(&cfg).unwrap();
        assert!(valid_env("API_KEY"));
        assert!(!valid_env("KEY=value"));
        assert!(!valid_env("1_KEY"));
        let out = std::process::Command::new(&cfg.command)
            .args(&cfg.args)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), cfg.args[0]);
    }
    #[test]
    fn settings_are_scoped_by_agent_and_method() {
        assert_ne!(setting_key("a", "b:c"), setting_key("a:b", "c"));
    }
    #[test]
    fn cancellation_keeps_the_shared_cancelled_status() {
        assert_eq!(run_error("AUTH_CANCELLED".into()), "AUTH_CANCELLED");
        assert_eq!(
            run_error("private process diagnostic".into()),
            "无法运行登录命令"
        );
    }
}
