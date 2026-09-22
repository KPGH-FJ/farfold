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
    if !config.command.is_empty() {
        let path = Path::new(&config.command);
        if !path.is_absolute()
            || !path.is_file()
            || !path
                .metadata()
                .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
        {
            return Err("请选择可执行文件的完整路径".into());
        }
    } else if !config.args.is_empty() || config.env_name.is_none() {
        return Err("请填写执行文件或密钥变量名".into());
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
pub fn auth_manual_set(
    app: AppHandle,
    agent_id: String,
    method_id: String,
    config: Option<ManualAuth>,
) -> Result<(), String> {
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
}
#[tauri::command]
pub async fn auth_manual_run(
    app: AppHandle,
    agent_id: String,
    method_id: String,
    on_output: Channel<serde_json::Value>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<MetaStore>();
        let row = store.get_agent(&agent_id)?.ok_or("请先连接 Agent")?;
        let config = read(&store, &agent_id, &method_id)?.ok_or("请先保存登录配置")?;
        validate(&config)?;
        if config.command.is_empty() {
            return Err("请先填写登录执行文件".into());
        }
        let env: Vec<(String, String)> = auth::environment_for(&store, &row)?.into_iter().collect();
        let sink: pty::PtySink = std::sync::Arc::new(move |frame| {
            let _ = on_output.send(frame);
        });
        app.state::<pty::PtyManager>()
            .spawn(
                &config.command,
                &config.args,
                &env,
                Path::new(&std::env::var("HOME").map_err(|_| "无法打开登录目录")?),
                portable_pty::PtySize {
                    rows: pty::DEFAULT_ROWS,
                    cols: pty::DEFAULT_COLS,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                sink,
            )
            .map_err(|_| "无法运行登录命令".into())
    })
    .await
    .map_err(|_| "登录操作未完成")?
}
#[cfg(test)]
mod tests {
    use super::*;
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
}
