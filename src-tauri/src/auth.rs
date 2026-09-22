//! Agent authentication: `authMethods` rendering data, `authenticate`,
//! terminal-style login through the embedded PTY, optional API-key injection
//! (macOS keychain only, never stored in SQLite), and `logout`.
//!
//! Login actions come from declarations or explicit user configuration.

use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::acp_client::manager::AcpManager;
use crate::meta_store::{AgentRow, MetaStore};
use crate::pty::{self, PtyManager};
use crate::shell_env;

/// Env placeholder stored on an agents row: the real value lives in the
/// macOS keychain and is resolved at spawn time only.
const KEYCHAIN_MARKER: &str = "__keychain__";

fn keychain_service(agent_id: &str, env_name: &str) -> String {
    format!("farfold.agent.{agent_id}.{env_name}")
}

// ---------------------------------------------------------------------------
// Handshake authMethods parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct ParsedAuthMethod {
    id: String,
    name: String,
    description: Option<String>,
    is_terminal: bool,
    args: Vec<String>,
    env: Vec<(String, String)>,
    is_api_key: bool,
    /// `_meta["api-key"]` object, if the method declares one.
    api_key_meta: Option<serde_json::Value>,
    /// Pre-standard terminal auth shape (`_meta["terminal-auth"]`):
    /// the declaration carries the full argv, not args appended to the
    /// agent launch command.
    terminal_argv: Option<Vec<String>>,
}

fn parse_auth_methods(handshake: Option<&serde_json::Value>) -> Vec<ParsedAuthMethod> {
    handshake
        .and_then(|value| value.get("authMethods"))
        .and_then(serde_json::Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(|method| {
                    let id = method.get("id")?.as_str()?.to_string();
                    let api_key_meta = method
                        .get("_meta")
                        .and_then(|meta| meta.get("api-key"))
                        .filter(|value| value.is_object())
                        .cloned();
                    // `_meta["terminal-auth"]: {command, args, label}` —
                    // the pre-standard declaration shape still emitted by
                    // some agents; the command is the complete argv.
                    let terminal_meta = method
                        .get("_meta")
                        .and_then(|meta| meta.get("terminal-auth"))
                        .filter(|value| value.is_object());
                    let terminal_argv = terminal_meta
                        .and_then(|meta| meta.get("command"))
                        .and_then(serde_json::Value::as_str)
                        .map(|command| {
                            let args = terminal_meta
                                .and_then(|meta| meta.get("args"))
                                .and_then(serde_json::Value::as_array)
                                .map(|args| {
                                    args.iter()
                                        .filter_map(serde_json::Value::as_str)
                                        .map(str::to_string)
                                        .collect::<Vec<String>>()
                                })
                                .unwrap_or_default();
                            std::iter::once(command.to_string()).chain(args).collect()
                        });
                    let is_terminal = method.get("type").and_then(serde_json::Value::as_str)
                        == Some("terminal")
                        || terminal_argv.is_some();
                    Some(ParsedAuthMethod {
                        name: method
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or(&id)
                            .to_string(),
                        description: method
                            .get("description")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string),
                        is_terminal,
                        args: method
                            .get("args")
                            .and_then(serde_json::Value::as_array)
                            .map(|args| {
                                args.iter()
                                    .filter_map(serde_json::Value::as_str)
                                    .map(str::to_string)
                                    .collect()
                            })
                            .unwrap_or_default(),
                        env: method
                            .get("env")
                            .and_then(serde_json::Value::as_object)
                            .map(|env| {
                                env.iter()
                                    .filter_map(|(key, value)| {
                                        value.as_str().map(|v| (key.clone(), v.to_string()))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                        is_api_key: id == "api-key" || api_key_meta.is_some(),
                        api_key_meta,
                        terminal_argv,
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A derived terminal login invocation: full argv plus method env overrides.
#[derive(Debug, Clone)]
struct TerminalInvocation {
    argv: Vec<String>,
    env: Vec<(String, String)>,
}

fn derive_terminal_invocation(
    row: &AgentRow,
    method: &ParsedAuthMethod,
) -> Result<TerminalInvocation, String> {
    if !method.is_terminal {
        return Err("此登录方式未提供终端命令，请手动配置".into());
    }
    // `_meta["terminal-auth"]` declarations carry the complete argv; the
    // standard `type:"terminal"` method only appends args to the agent
    // launch command.
    if let Some(argv) = &method.terminal_argv {
        return Ok(TerminalInvocation {
            argv: argv.clone(),
            env: method.env.clone(),
        });
    }
    if method.args.is_empty() {
        return Err("此登录方式未提供终端命令，请手动配置".into());
    }
    let mut argv = vec![row.command.clone()];
    argv.extend(row.args.iter().cloned());
    argv.extend(method.args.iter().cloned());
    Ok(TerminalInvocation {
        argv,
        env: method.env.clone(),
    })
}
fn api_key_env_name(method: &ParsedAuthMethod) -> Option<String> {
    method
        .api_key_meta
        .as_ref()?
        .get("env")?
        .as_str()
        .filter(|name| crate::manual_auth::valid_env(name))
        .map(str::to_string)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `agent` | `terminal` | `api-key`
    pub kind: String,
    /// Full argv when the method can run in the embedded terminal.
    pub terminal_command: Option<Vec<String>>,
    /// Suggested env var name for `api-key` methods.
    pub env_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodsResponse {
    pub methods: Vec<AuthMethodInfo>,
    pub can_logout: bool,
}

fn auth_methods_for(row: &AgentRow) -> AuthMethodsResponse {
    let methods = parse_auth_methods(row.handshake.as_ref())
        .iter()
        .map(|method| {
            let kind = if method.is_api_key {
                "api-key"
            } else if method.is_terminal {
                "terminal"
            } else {
                "agent"
            };
            AuthMethodInfo {
                id: method.id.clone(),
                name: method.name.clone(),
                description: method.description.clone(),
                kind: kind.to_string(),
                terminal_command: derive_terminal_invocation(row, method)
                    .ok()
                    .map(|invocation| invocation.argv),
                env_name: method
                    .is_api_key
                    .then(|| api_key_env_name(method))
                    .flatten(),
            }
        })
        .collect();
    let can_logout = row
        .handshake
        .as_ref()
        .and_then(|handshake| handshake.get("agentCapabilities"))
        .and_then(|caps| caps.get("auth"))
        .and_then(|auth| auth.get("logout"))
        .is_some();
    AuthMethodsResponse {
        methods,
        can_logout,
    }
}

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

fn shell_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Store `key` in the login keychain via `security -i` so the secret travels
/// over stdin and never appears in the process list.
fn keychain_store(service: &str, key: &str) -> Result<(), String> {
    let mut child = Command::new("security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot run security: {error}"))?;
    let line = format!(
        "add-generic-password -a farfold -s {} -w {} -U\n",
        shell_quote(service),
        shell_quote(key)
    );
    let write_result = child
        .stdin
        .as_mut()
        .ok_or_else(|| std::io::Error::other("security stdin unavailable"))
        .and_then(|stdin| stdin.write_all(line.as_bytes()));
    drop(child.stdin.take());
    let output = child
        .wait_with_output()
        .map_err(|error| format!("security did not finish: {error}"))?;
    if let Err(error) = write_result {
        return Err(format!("cannot pass key to security: {error}"));
    }
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "security add-generic-password failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Read a key back out of the login keychain (`None` when absent).
fn keychain_lookup(service: &str) -> Option<String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            "farfold",
            "-s",
            service,
            "-w",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).to_string();
    let value = value.strip_suffix('\n').unwrap_or(&value).to_string();
    if value.is_empty() { None } else { Some(value) }
}

/// Resolve `__keychain__` env placeholders on an agents row to their real
/// values. Unresolvable entries are dropped — the agent falls back to its
/// own auth state.
pub(crate) fn resolve_agent_env(agent_id: &str, env: &[(String, String)]) -> Vec<(String, String)> {
    env.iter()
        .filter_map(|(name, value)| {
            if value == KEYCHAIN_MARKER {
                match keychain_lookup(&keychain_service(agent_id, name)) {
                    Some(resolved) => Some((name.clone(), resolved)),
                    None => {
                        eprintln!(
                            "[farfold] keychain entry missing for {agent_id}.{name}; \
                             agent spawns without it"
                        );
                        None
                    }
                }
            } else {
                Some((name.clone(), value.clone()))
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Connect helper shared by auth_run / agent_logout
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "cannot resolve home directory".to_string())
}

/// Ensure the agent has one ready connection (spawning it in the home
/// directory when needed), so auth calls have somewhere to go.
async fn ensure_connected(
    manager: &AcpManager,
    store: &MetaStore,
    row: &AgentRow,
) -> Result<(), String> {
    let ready = manager
        .status(&row.id)?
        .iter()
        .any(|status| status.state == "ready");
    if !ready {
        manager.connect(row, &home_dir()?, store).await?;
    }
    Ok(())
}

fn require_agent_row(app: &AppHandle, agent_id: &str) -> Result<AgentRow, String> {
    app.state::<MetaStore>()
        .get_agent(agent_id)?
        .ok_or_else(|| format!("agent {agent_id} is not registered"))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// `authMethods` from the agent's last handshake, classified for the UI.
#[tauri::command]
pub fn auth_methods(app: AppHandle, agent_id: String) -> Result<AuthMethodsResponse, String> {
    let row = require_agent_row(&app, &agent_id)?;
    Ok(auth_methods_for(&row))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthRunResult {
    /// `agent` | `terminal` | `api-key`
    pub kind: String,
    pub pty_id: Option<String>,
}

/// Run one auth method. `agent` methods go through `authenticate`;
/// `terminal` methods (and `via_terminal` overrides for agent-type methods
/// whose description points at a terminal command) spawn the derived command
/// on an embedded PTY. `api-key` methods bounce back so the UI collects the
/// key first.
#[tauri::command]
pub async fn auth_run(
    app: AppHandle,
    agent_id: String,
    method_id: String,
    via_terminal: Option<bool>,
    on_output: Channel<serde_json::Value>,
) -> Result<AuthRunResult, String> {
    let row = crate::acp_client::manager::require_agent_row(&app, &agent_id).await?;
    let method = parse_auth_methods(row.handshake.as_ref())
        .into_iter()
        .find(|method| method.id == method_id)
        .ok_or_else(|| format!("agent {agent_id} has no auth method {method_id}"))?;

    if method.is_api_key {
        return Ok(AuthRunResult {
            kind: "api-key".to_string(),
            pty_id: None,
        });
    }

    if method.is_terminal || via_terminal.unwrap_or(false) {
        return tauri::async_runtime::spawn_blocking(move || {
            let invocation = derive_terminal_invocation(&row, &method)?;
            let (command, args) = invocation
                .argv
                .split_first()
                .ok_or_else(|| "derived auth command is empty".to_string())?;
            // `_meta["terminal-auth"]` declarations name a bare binary
            // (e.g. "opencode") — resolve it against the discovery dirs so
            // PTY spawn does not depend on PATH lookup semantics.
            let resolved;
            let command = if !command.contains('/') {
                resolved = crate::agent_discovery::find_binary(
                    command,
                    &crate::agent_discovery::candidate_dirs(),
                );
                match &resolved {
                    Some(path) => path.to_string_lossy().into_owned(),
                    None => command.clone(),
                }
            } else {
                command.clone()
            };
            let command = command.as_str();
            let mut env: Vec<(String, String)> = shell_env::command_env().into_iter().collect();
            env.extend(resolve_agent_env(&row.id, &row.env));
            env.extend(invocation.env);
            let sink: pty::PtySink = std::sync::Arc::new(move |frame| {
                let _ = on_output.send(frame);
            });
            let pty_id = app.state::<PtyManager>().spawn(
                command,
                args,
                &env,
                &home_dir()?,
                portable_pty::PtySize {
                    rows: pty::DEFAULT_ROWS,
                    cols: pty::DEFAULT_COLS,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                sink,
            )?;
            crate::logging::info(
                "auth",
                format_args!("auth_run: {agent_id}.{method_id} via terminal ({pty_id})"),
            );
            Ok(AuthRunResult {
                kind: "terminal".to_string(),
                pty_id: Some(pty_id),
            })
        })
        .await
        .map_err(|_| "登录终端启动失败".to_string())?;
    }

    let manager = app.state::<AcpManager>();
    let store = app.state::<MetaStore>();
    ensure_connected(&manager, &store, &row).await?;
    manager.authenticate(&agent_id, &method_id).await?;
    crate::logging::info(
        "auth",
        format_args!("auth_run: {agent_id}.{method_id} via agent"),
    );
    Ok(AuthRunResult {
        kind: "agent".to_string(),
        pty_id: None,
    })
}

/// Save an API key into the login keychain and mark the agent's env entry as
/// keychain-backed. The value never touches SQLite or logs.
#[tauri::command]
pub async fn auth_set_api_key(
    app: AppHandle,
    agent_id: String,
    env_name: String,
    key: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::manual_auth::valid_env(&env_name) {
            return Err("env var name is empty".to_string());
        }
        if key.trim().is_empty() {
            return Err("API key is empty".to_string());
        }
        let mut row = require_agent_row(&app, &agent_id)?;
        keychain_store(&keychain_service(&agent_id, &env_name), &key)?;
        row.env.retain(|(name, _)| name != &env_name);
        row.env
            .push((env_name.clone(), KEYCHAIN_MARKER.to_string()));
        row.updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_default();
        app.state::<MetaStore>().upsert_agent(&row)?;
        crate::logging::info(
            "auth",
            format_args!("api key saved to keychain for {agent_id}.{env_name}"),
        );
        Ok(())
    })
    .await
    .map_err(|error| format!("auth_set_api_key failed: {error}"))?
}

/// `logout` on the agent's live connections (capability-gated by the
/// handshake's `agentCapabilities.auth.logout`).
#[tauri::command]
pub async fn agent_logout(app: AppHandle, agent_id: String) -> Result<(), String> {
    let row = crate::acp_client::manager::require_agent_row(&app, &agent_id).await?;
    if !auth_methods_for(&row).can_logout {
        return Err(format!("agent {agent_id} does not support logout"));
    }
    let manager = app.state::<AcpManager>();
    let store = app.state::<MetaStore>();
    ensure_connected(&manager, &store, &row).await?;
    manager.logout(&agent_id).await?;
    crate::logging::info("auth", format_args!("logout: {agent_id}"));
    Ok(())
}

/// Read one settings value (`None` when unset).
#[tauri::command]
pub fn settings_get(app: AppHandle, key: String) -> Result<Option<serde_json::Value>, String> {
    app.state::<MetaStore>().get_setting(&key)
}

/// Write one settings value.
#[tauri::command]
pub fn settings_set(app: AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    app.state::<MetaStore>().set_setting(&key, &value)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, handshake: serde_json::Value) -> AgentRow {
        AgentRow {
            id: id.to_string(),
            name: id.to_string(),
            source: "discovered".to_string(),
            command: format!("/usr/local/bin/{id}"),
            args: vec!["acp".to_string()],
            env: vec![],
            version: None,
            handshake: Some(handshake),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn parses_terminal_method_with_args() {
        let row = row(
            "pi",
            serde_json::json!({
                "authMethods": [{
                    "type": "terminal",
                    "id": "pi_terminal_login",
                    "name": "Launch pi in the terminal",
                    "args": ["--terminal-login"]
                }]
            }),
        );
        let info = auth_methods_for(&row);
        assert_eq!(info.methods.len(), 1);
        assert_eq!(info.methods[0].kind, "terminal");
        assert_eq!(
            info.methods[0].terminal_command,
            Some(vec![
                "/usr/local/bin/pi".to_string(),
                "acp".to_string(),
                "--terminal-login".to_string(),
            ])
        );
        assert!(!info.can_logout);
    }

    #[test]
    fn descriptions_never_create_terminal_commands() {
        let row = row(
            "opencode",
            serde_json::json!({
                "authMethods": [{
                    "id": "opencode-login",
                    "name": "Login with opencode",
                    "description": "Run `opencode auth login` in the terminal"
                }]
            }),
        );
        let info = auth_methods_for(&row);
        assert_eq!(info.methods[0].kind, "agent");
        assert_eq!(info.methods[0].terminal_command, None);
    }

    #[test]
    fn codex_methods_and_logout_capability() {
        let row = row(
            "codex",
            serde_json::json!({
                "agentCapabilities": {"auth": {"logout": {}}},
                "authMethods": [
                    {"id": "api-key", "name": "API Key",
                     "_meta": {"api-key": {"provider": "openai"}}},
                    {"id": "chat-gpt", "name": "ChatGPT"}
                ]
            }),
        );
        let info = auth_methods_for(&row);
        assert!(info.can_logout);
        assert_eq!(info.methods[0].kind, "api-key");
        assert_eq!(info.methods[0].env_name, None);
        assert_eq!(info.methods[1].kind, "agent");
        assert_eq!(info.methods[1].terminal_command, None);
    }

    #[test]
    fn api_key_env_name_requires_explicit_declaration() {
        let mut method = ParsedAuthMethod {
            is_api_key: true,
            api_key_meta: Some(serde_json::json!({"provider":"openai"})),
            ..Default::default()
        };
        assert_eq!(api_key_env_name(&method), None);
        method.api_key_meta = Some(serde_json::json!({"env":"EXPLICIT_KEY"}));
        assert_eq!(api_key_env_name(&method).as_deref(), Some("EXPLICIT_KEY"));
        let handshake = serde_json::json!({"authMethods":[{"id":"login","name":"Login","description":"run something"}]});
        let a = auth_methods_for(&row("codex", handshake.clone()));
        let b = auth_methods_for(&row("other", handshake));
        assert_eq!(a, b);
    }

    #[test]
    fn keychain_round_trip_stores_and_reads_back() {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let service = format!("farfold.test.roundtrip.{millis}");
        // Clean any stale entry from a previous interrupted run.
        let _ = Command::new("security")
            .args(["delete-generic-password", "-a", "farfold", "-s", &service])
            .output();
        keychain_store(&service, "sk-test-abc123").expect("keychain store");
        assert_eq!(keychain_lookup(&service).as_deref(), Some("sk-test-abc123"));
        let _ = Command::new("security")
            .args(["delete-generic-password", "-a", "farfold", "-s", &service])
            .output();
    }

    #[test]
    fn keychain_placeholder_resolves_or_drops() {
        // Missing entries are dropped rather than injected empty.
        let env = vec![
            ("KEEP".to_string(), "1".to_string()),
            ("NO_SUCH_KEY_XYZ".to_string(), KEYCHAIN_MARKER.to_string()),
        ];
        let resolved = resolve_agent_env("ghost-agent", &env);
        assert_eq!(resolved, vec![("KEEP".to_string(), "1".to_string())]);
    }
}
