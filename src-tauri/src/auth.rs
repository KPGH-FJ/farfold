//! Agent authentication: `authMethods` rendering data, `authenticate`,
//! terminal-style login through the embedded PTY, optional API-key injection
//! (the system credential store, never SQLite), and `logout`.
//!
//! Login actions come from declarations or explicit user configuration.

#[cfg(target_os = "macos")]
use std::io::Write as _;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::acp_client::auth_route::ManagedTerminalProof;
use crate::acp_client::manager::AcpManager;
use crate::meta_store::{AgentRow, MetaStore};
use crate::pty::{self, PtyManager};
use crate::shell_env;

pub(crate) mod agent_environment;
pub(crate) mod attempts;
pub(crate) mod terminal;
#[cfg(any(target_os = "windows", test))]
mod windows_vault;
#[cfg(target_os = "windows")]
pub(crate) use windows_vault::{
    delete as keychain_delete, lookup as keychain_lookup, store as keychain_store,
};

#[tauri::command]
pub fn auth_cancel(agent_id: String, attempt_id: String) -> Result<(), String> {
    attempts::auth_cancel(agent_id, attempt_id)
}

#[tauri::command]
pub async fn auth_end(app: AppHandle, agent_id: String, attempt_id: String) -> Result<(), String> {
    let connection = attempts::end_connection(&agent_id, &attempt_id, |cwd| {
        let connection = app.state::<AcpManager>().live_connection(&agent_id, cwd)?;
        connection.life.close(false, None)?;
        Ok(connection)
    })?;
    connection.life.closed().await
}

/// Env placeholder stored on an agents row: the real value lives in the
/// system credential store and is resolved at spawn time only. Keep the existing
/// marker and service IDs so the platform addition does not migrate user data.
/// Env value placeholder meaning "the real value lives in system secure
/// storage under `env_keychain_service(agent_id, name)`". Never the secret.
pub(crate) const KEYCHAIN_MARKER: &str = "__keychain__";

/// Name of the secure-storage entry holding one Agent env value. Contains no
/// secret material; callers use it to look up or delete the stored copy.
pub(crate) fn env_keychain_service(agent_id: &str, env_name: &str) -> String {
    keychain_service(agent_id, env_name)
}

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
    is_api_key: bool,
    kind: &'static str,
    env_names: Option<Vec<String>>,
    /// `_meta["api-key"]` object, if the method declares one.
    api_key_meta: Option<serde_json::Value>,
    api_key_provider: Option<String>,
    /// Pre-standard terminal auth shape (`_meta["terminal-auth"]`):
    /// the declaration carries the full argv, not args appended to the
    /// agent launch command.
    invocation: Option<crate::acp_client::auth_route::TerminalInvocation>,
    unavailable_reason: Option<String>,
    setup: bool,
}

fn parse_auth_methods(row: &AgentRow) -> Vec<ParsedAuthMethod> {
    parse_auth_methods_with_proof(row, &ManagedTerminalProof::default())
}

fn parse_auth_methods_with_proof(
    row: &AgentRow,
    proof: &ManagedTerminalProof,
) -> Vec<ParsedAuthMethod> {
    row.handshake
        .as_ref()
        .and_then(|value| value.get("authMethods"))
        .and_then(serde_json::Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(|method| {
                    let id = method.get("id")?.as_str()?.to_string();
                    use crate::acp_client::auth_route::{self, Route};
                    let (kind, invocation, api_key_meta, unavailable_reason, env_names) =
                        match auth_route::route(row, method, proof) {
                            Route::Terminal(invocation) => {
                                ("terminal", Some(invocation), None, None, None)
                            }
                            Route::ApiKey(meta) => ("api-key", None, Some(meta), None, None),
                            Route::Environment(names) => (
                                "environment",
                                None,
                                None,
                                Some(auth_route::ENVIRONMENT_UNAVAILABLE.to_string()),
                                Some(names),
                            ),
                            Route::Unsupported => (
                                "unsupported",
                                None,
                                None,
                                Some(auth_route::UNSUPPORTED.to_string()),
                                None,
                            ),
                            Route::Unavailable(reason) => {
                                let kind =
                                    match method.get("type").and_then(serde_json::Value::as_str) {
                                        Some("terminal") => "terminal",
                                        None | Some("agent") => "agent",
                                        _ => "unsupported",
                                    };
                                (kind, None, None, Some(reason.message().to_string()), None)
                            }
                            Route::Agent => ("agent", None, None, None, None),
                        };
                    Some(ParsedAuthMethod {
                        kind,
                        env_names,
                        name: method
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or(&id)
                            .to_string(),
                        description: invocation
                            .as_ref()
                            .and_then(|invocation| invocation.description.map(str::to_string))
                            .or_else(|| {
                                method
                                    .get("description")
                                    .and_then(serde_json::Value::as_str)
                                    .map(str::to_string)
                            }),
                        is_terminal: invocation.is_some()
                            || method.get("type").and_then(serde_json::Value::as_str)
                                == Some("terminal"),
                        is_api_key: api_key_meta.is_some(),
                        api_key_meta,
                        api_key_provider: (kind == "api-key")
                            .then(|| {
                                auth_route::protocol_api_key_provider(method).map(str::to_string)
                            })
                            .flatten(),
                        setup: invocation
                            .as_ref()
                            .is_some_and(|invocation| invocation.setup),
                        invocation,
                        unavailable_reason,
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A derived terminal login invocation: full argv plus method env overrides.
type TerminalInvocation = crate::acp_client::auth_route::TerminalInvocation;

fn derive_terminal_invocation(
    _row: &AgentRow,
    method: &ParsedAuthMethod,
) -> Result<TerminalInvocation, String> {
    method.invocation.clone().ok_or_else(|| {
        method
            .unavailable_reason
            .clone()
            .unwrap_or_else(|| "此登录方式未提供终端命令，请手动配置".into())
    })
}

/// Shared by the real execution entry before any environment or PTY work.
fn runnable_auth_method(
    row: &AgentRow,
    method_id: &str,
    proof: &ManagedTerminalProof,
) -> Result<ParsedAuthMethod, String> {
    let method = parse_auth_methods_with_proof(row, proof)
        .into_iter()
        .find(|method| method.id == method_id)
        .ok_or_else(|| format!("agent {} has no auth method {method_id}", row.id))?;
    if let Some(reason) = &method.unavailable_reason {
        return Err(reason.clone());
    }
    Ok(method)
}

fn auth_uses_terminal(
    method: &ParsedAuthMethod,
    via_terminal: Option<bool>,
) -> Result<bool, String> {
    // A fresh declaration must not turn an earlier protocol choice into a
    // terminal child that its caller never explicitly requested or owns.
    if method.is_terminal && via_terminal != Some(true) {
        return Err("登录方式已变化，请重新选择".into());
    }
    Ok(method.is_terminal || via_terminal.unwrap_or(false))
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
    /// `agent` | `terminal` | `api-key` | `environment` | `unsupported`
    pub kind: String,
    /// Full argv when the method can run in the embedded terminal.
    pub terminal_command: Option<Vec<String>>,
    /// Suggested env var name for `api-key` methods.
    pub env_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_names: Option<Vec<String>>,
    pub purpose: &'static str,
    pub completion: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodsResponse {
    pub methods: Vec<AuthMethodInfo>,
    pub can_logout: bool,
    /// True only while the exact preparation connection is live and ready.
    /// Borrowed or cached declarations are display-only; the caller connects
    /// before running a listed method.
    pub execution_ready: bool,
}

fn auth_methods_for(row: &AgentRow) -> AuthMethodsResponse {
    auth_methods_with_proof(row, &ManagedTerminalProof::default())
}
fn auth_methods_with_proof(row: &AgentRow, proof: &ManagedTerminalProof) -> AuthMethodsResponse {
    let methods = parse_auth_methods_with_proof(row, proof)
        .iter()
        .map(|method| AuthMethodInfo {
            id: method.id.clone(),
            name: method.name.clone(),
            description: method.description.clone(),
            kind: method.kind.to_string(),
            terminal_command: derive_terminal_invocation(row, method)
                .ok()
                .map(|invocation| invocation.argv),
            env_name: method
                .is_api_key
                .then(|| api_key_env_name(method))
                .flatten(),
            env_names: method.env_names.clone(),
            api_key_provider: method.api_key_provider.clone(),
            purpose: if method.setup { "setup" } else { "login" },
            completion: if method.setup {
                "return_and_verify"
            } else {
                "exit_code"
            },
            unavailable_reason: method.unavailable_reason.clone(),
        })
        .collect();
    let can_logout = row
        .handshake
        .as_ref()
        .and_then(|handshake| handshake.get("agentCapabilities"))
        .and_then(|caps| caps.get("auth"))
        .and_then(|auth| auth.get("logout"))
        .is_some_and(serde_json::Value::is_object);
    AuthMethodsResponse {
        methods,
        can_logout,
        execution_ready: false,
    }
}

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn shell_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Store `key` in the login keychain via `security -i` so the secret travels
/// over stdin and never appears in the process list.
#[cfg(target_os = "macos")]
pub(crate) fn keychain_store(service: &str, key: &str) -> Result<(), String> {
    if key.trim().is_empty() || key.len() > 16384 || key.chars().any(char::is_control) {
        return Err("请输入有效的单行密钥".into());
    }
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
        Err("无法保存到系统钥匙串，请检查访问权限后重试".into())
    }
}

/// Read a key back out of the login keychain (`None` when absent).
#[cfg(target_os = "macos")]
pub(crate) fn keychain_lookup(service: &str) -> Option<String> {
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

#[cfg(target_os = "macos")]
pub(crate) fn keychain_delete(service: &str) -> Result<(), String> {
    let status = Command::new("security")
        .args(["delete-generic-password", "-a", "farfold", "-s", service])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "无法清除钥匙串条目")?;
    if status.success() || status.code() == Some(44) {
        Ok(())
    } else {
        Err("无法清除钥匙串条目，请重试".into())
    }
}

pub(crate) fn environment_for(
    store: &MetaStore,
    row: &AgentRow,
) -> Result<std::collections::HashMap<String, String>, String> {
    let mut env = shell_env::command_env();
    shell_env::EnvNames::current().extend(&mut env, resolve_agent_env(&row.id, &row.env)?);
    crate::credentials::apply(store, &row.id, &mut env)?;
    Ok(env)
}

/// Resolve protected values only inside trusted launch and explicit removal checks.
pub(crate) fn resolve_agent_env(
    agent_id: &str,
    env: &[(String, String)],
) -> Result<Vec<(String, String)>, String> {
    resolve_agent_env_with(agent_id, env, &keychain_lookup)
}

pub(crate) fn resolve_agent_env_with(
    agent_id: &str,
    env: &[(String, String)],
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Vec<(String, String)>, String> {
    env.iter()
        .map(|(name, value)| {
            if value == KEYCHAIN_MARKER {
                let value = lookup(&keychain_service(agent_id, name))
                    .filter(|value| !value.is_empty() && !value.contains('\0'))
                    .ok_or("无法读取此 Agent 的安全环境变量，请检查系统凭据后重试")?;
                Ok((name.clone(), value))
            } else {
                Ok((name.clone(), value.clone()))
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Connect helper shared by auth_run / agent_logout
// ---------------------------------------------------------------------------

/// Keep the exact task directory, even when another directory is connected.
async fn ensure_connected(
    manager: &AcpManager,
    store: &MetaStore,
    row: &AgentRow,
    cwd: &std::path::Path,
) -> Result<(), String> {
    let ready = manager.status(&row.id)?.iter().any(|status| {
        status.state == "ready"
            && status.service_context.is_none()
            && std::path::Path::new(&status.cwd) == cwd
    });
    if !ready {
        manager.connect(row, cwd, store).await?;
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

const RECHECK_METHODS: &str = "请重新检查连接后再选择登录方式";

/// Execution always requires a current declaration for this exact existing-settings target.
fn live_auth_row(
    manager: &AcpManager,
    row: &AgentRow,
    cwd: &std::path::Path,
) -> Result<AgentRow, String> {
    let connection = manager
        .live_connection(&row.id, cwd)
        .map_err(|_| RECHECK_METHODS)?;
    let handshake = connection.handshake.get().ok_or(RECHECK_METHODS)?;
    let mut current = row.clone();
    current.handshake = Some(handshake.execution_json());
    Ok(current)
}

/// Read-only declarations from a ready conversation connection in the same
/// Agent/project context. Never a source for execution.
fn borrowed_auth_row(
    manager: &AcpManager,
    row: &AgentRow,
    cwd: &std::path::Path,
) -> Option<(AgentRow, bool)> {
    let handshake = manager.borrowable_handshake(&row.id, cwd)?;
    let handshake = handshake.get()?;
    let mut borrowed = row.clone();
    borrowed.handshake = Some(handshake.execution_json());
    Some((borrowed, handshake.can_logout()))
}

fn methods_for_target(
    manager: &AcpManager,
    row: &AgentRow,
    cwd: Option<&std::path::Path>,
    source: Option<&str>,
    proof: &ManagedTerminalProof,
) -> AuthMethodsResponse {
    let existing_source = attempts::require_existing_source(source);
    let live = if existing_source.is_ok() {
        cwd.and_then(|cwd| live_auth_row(manager, row, cwd).ok())
    } else {
        None
    };
    let borrowed = if live.is_none() && existing_source.is_ok() {
        cwd.and_then(|cwd| borrowed_auth_row(manager, row, cwd))
    } else {
        None
    };
    let mut info = if let Some(current) = live {
        let mut info = auth_methods_with_proof(&current, proof);
        info.can_logout = cwd.is_some_and(|cwd| manager.can_logout(&row.id, cwd));
        info.execution_ready = true;
        info
    } else if let Some((borrowed, can_logout)) = borrowed {
        let mut info = auth_methods_with_proof(&borrowed, proof);
        info.can_logout = can_logout;
        info
    } else {
        let mut cached = row.clone();
        cached.handshake = Some(crate::acp_client::handshake::cached_json(
            row.handshake.as_ref(),
        ));
        let mut info = auth_methods_for(&cached);
        if let Err(reason) = &existing_source {
            for method in &mut info.methods {
                method.unavailable_reason = Some(reason.clone());
            }
        }
        info.can_logout = false;
        info
    };
    // The current UI does not consume command previews here. Do not forward
    // live terminal arguments (which may carry dynamic values) to UI snapshots.
    for method in &mut info.methods {
        method.terminal_command = None;
    }
    info
}

/// Current target declarations; a persisted snapshot is display-only.
#[tauri::command]
pub async fn auth_methods(
    app: AppHandle,
    agent_id: String,
    cwd: Option<String>,
    source: Option<String>,
) -> Result<AuthMethodsResponse, String> {
    let row = require_agent_row(&app, &agent_id)?;
    let cwd = match cwd {
        Some(cwd) => Some(crate::acp_client::manager::validate_cwd_async(&cwd).await?),
        None => None,
    };
    let data = app.path().app_data_dir().map_err(|_| "无法读取安装目录")?;
    let proof = crate::acp_client::auth_route::managed_terminal_proof(
        &row,
        &app.state::<MetaStore>(),
        &data,
    );
    Ok(methods_for_target(
        &app.state::<AcpManager>(),
        &row,
        cwd.as_deref(),
        source.as_deref(),
        &proof,
    ))
}

/// Save only for a current method declaration. The Keychain reference belongs
/// to the existing credential pool; this command does not start authentication.
fn selected_key_provider(
    row: &AgentRow,
    method_id: &str,
    expected_provider: &str,
) -> Result<String, String> {
    let provider = parse_auth_methods(row)
        .into_iter()
        .find(|method| method.id == method_id && method.unavailable_reason.is_none())
        .and_then(|method| method.api_key_provider)
        .ok_or("此登录方式已变化，请重新检查后再保存密钥")?;
    if provider != expected_provider {
        return Err("此登录方式已变化，请重新选择后再保存密钥".into());
    }
    Ok(provider)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn auth_key_save(
    app: AppHandle,
    agent_id: String,
    method_id: String,
    cwd: String,
    source: Option<String>,
    expected_provider: String,
    label: String,
    key: String,
) -> Result<crate::credentials::View, String> {
    attempts::require_existing_source(source.as_deref())?;
    let cwd = crate::acp_client::manager::validate_cwd_async(&cwd).await?;
    let configuration = crate::install_job::configuration_guard(&agent_id).await;
    let row = crate::acp_client::manager::require_agent_row(&app, &agent_id).await?;
    let row = live_auth_row(&app.state::<AcpManager>(), &row, &cwd)?;
    let provider = selected_key_provider(&row, &method_id, &expected_provider)?;
    let store = app.state::<MetaStore>().inner().clone();
    store
        .run(move |store| {
            let _configuration = configuration;
            crate::credentials::save_auth_key(store, &provider, &label, &key)
        })
        .await
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthRunResult {
    /// `agent` | `terminal` | `api-key`
    pub kind: String,
    pub pty_id: Option<String>,
}

/// The actual login child owns the configuration reservation, even if the IPC
/// caller disappears. Its exit frame releases it before delivering UI feedback.
pub(crate) fn terminal_output(
    channel: Channel<serde_json::Value>,
    configuration: tokio::sync::OwnedMutexGuard<()>,
    scope: crate::acp_client::manager::AccountScope,
    attempt: Option<attempts::Attempt>,
) -> pty::PtySink {
    let configuration = std::sync::Mutex::new(Some((configuration, scope, attempt)));
    std::sync::Arc::new(move |frame| {
        if frame.get("exit").is_some()
            && let Ok(mut owned) = configuration.lock()
            && let Some((configuration, scope, attempt)) = owned.take()
        {
            // Waiting configuration changes must not observe a free lock
            // while the previous account operation still owns its attempt.
            drop(attempt);
            drop(scope);
            drop(configuration);
        }
        let _ = channel.send(frame);
    })
}

/// Run one auth method. `agent` methods go through `authenticate`;
/// `terminal` methods spawn only the verified derived command
/// on an embedded PTY. A verified method API Key uses an explicit saved
/// reference and the same protocol ownership as other agent methods.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn auth_run(
    app: AppHandle,
    agent_id: String,
    method_id: String,
    cwd: String,
    source: Option<String>,
    attempt_id: String,
    via_terminal: Option<bool>,
    credential_id: Option<String>,
    credential_revision: Option<String>,
    on_output: Channel<serde_json::Value>,
) -> Result<AuthRunResult, String> {
    attempts::require_existing_source(source.as_deref())?;
    let attempt = attempts::reserve(&agent_id, &attempt_id)?;
    let cwd = attempt
        .setup(crate::acp_client::manager::validate_cwd_async(&cwd))
        .await?;
    let configuration = attempt.configuration_guard().await?;
    let row = attempt
        .setup(crate::acp_client::manager::require_agent_row(
            &app, &agent_id,
        ))
        .await?;
    let row = live_auth_row(&app.state::<AcpManager>(), &row, &cwd)?;
    let data = app.path().app_data_dir().map_err(|_| "无法读取安装目录")?;
    let proof = crate::acp_client::auth_route::managed_terminal_proof(
        &row,
        &app.state::<MetaStore>(),
        &data,
    );
    let method = runnable_auth_method(&row, &method_id, &proof)?;
    attempt.check()?;

    if method.is_api_key && method.api_key_provider.is_none() {
        return Err("此登录方式当前不能在这里使用密钥，请使用更多登录方式".into());
    }
    if method.api_key_provider.is_some() && via_terminal.unwrap_or(false) {
        return Err("此登录方式需要通过选中的密钥登录".into());
    }
    if method.api_key_provider.is_none()
        && (credential_id.is_some() || credential_revision.is_some())
    {
        return Err("此登录方式不接受密钥，请重新选择".into());
    }

    if auth_uses_terminal(&method, via_terminal)? {
        let invocation = derive_terminal_invocation(&row, &method)?;
        let (command, args) = invocation
            .argv
            .split_first()
            .ok_or_else(|| "derived auth command is empty".to_string())?;
        let scope = app
            .state::<AcpManager>()
            .reserve_authentication_terminal(&agent_id, command, args)?;
        return tauri::async_runtime::spawn_blocking(move || {
            attempt.check()?;
            let (command, args) = invocation
                .argv
                .split_first()
                .ok_or_else(|| "derived auth command is empty".to_string())?;
            // Target identity is already verified and frozen under the configuration
            // guard. Never perform a second PATH lookup at execution time.
            let command = command.as_str();
            let pty_id = terminal::run(
                &app.state::<PtyManager>(),
                command,
                args,
                &cwd,
                terminal::Ownership {
                    output: on_output,
                    configuration,
                    scope,
                    attempt,
                },
                || {
                    let mut env = environment_for(&app.state::<MetaStore>(), &row)?;
                    shell_env::EnvNames::current().extend(&mut env, invocation.env);
                    Ok(env.into_iter().collect())
                },
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
    drop(configuration);
    attempt
        .setup(ensure_connected(&manager, &store, &row, &cwd))
        .await?;
    let _configuration = attempt.configuration_guard().await?;
    let current = attempt
        .setup(crate::acp_client::manager::require_agent_row(
            &app, &agent_id,
        ))
        .await?;
    if current.command != row.command || current.args != row.args || current.env != row.env {
        return Err("Agent 程序设置已变化，请重新选择登录方式".into());
    }
    let current = live_auth_row(&manager, &current, &cwd)?;
    let current_method = parse_auth_methods(&current)
        .into_iter()
        .find(|current_method| {
            current_method.id == method_id
                && !current_method.is_terminal
                && current_method.api_key_provider == method.api_key_provider
                && current_method.unavailable_reason.is_none()
        });
    if current_method.is_none() {
        return Err("此登录方式已变化，请重新选择".into());
    }
    attempt.check()?;
    let scope = if method.api_key_provider.is_some() {
        manager.reserve_preparation_change(&agent_id)?
    } else {
        manager.reserve_account_change(&agent_id)?
    };
    attempt.protocol_directory(&cwd)?;
    // Metadata and account/configuration ownership are verified before the
    // first credential read. Saving a key never grants environment access.
    let credential = if let Some(provider) = method.api_key_provider {
        let id = credential_id.ok_or("请选择此登录方式使用的密钥")?;
        let revision = credential_revision.ok_or("请重新选择此登录方式使用的密钥")?;
        let store = store.inner().clone();
        Some(
            attempt
                .setup(store.run(move |store| {
                    crate::credentials::auth_key(store, &id, &revision, &provider).and_then(|key| {
                        crate::acp_client::auth_route::ProtocolApiKey::new(provider, key)
                    })
                }))
                .await?,
        )
    } else {
        None
    };
    attempt.check()?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (_configuration, _scope) = (_configuration, scope);
        let inquiry_output = on_output.clone();
        let operation = attempt
            .operation()
            .with_events(std::sync::Arc::new(move |event| {
                let _ = inquiry_output.send(event);
            }));
        let _attempt = attempt;
        let on_unknown = std::sync::Arc::new(move || {
            let _ = on_output.send(serde_json::json!({"authStatus":"unknown"}));
        });
        let manager = app.state::<AcpManager>();
        match credential {
            Some(credential) => {
                manager
                    .authenticate_with_key(
                        &agent_id,
                        &cwd,
                        &method_id,
                        Some(credential),
                        operation,
                        on_unknown,
                    )
                    .await?
            }
            None => {
                manager
                    .authenticate(&agent_id, &cwd, &method_id, operation, on_unknown)
                    .await?
            }
        }
        Ok(AuthRunResult {
            kind: "agent".into(),
            pty_id: None,
        })
    })
    .await
    .map_err(|_| "登录操作未完成".to_string())?
}

/// Exit through the exact live connection's standard capability or reviewed
/// official action. Shared-account scope and fresh route checks still apply.
#[tauri::command]
pub async fn agent_logout(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    source: Option<String>,
    attempt_id: String,
    on_output: Channel<serde_json::Value>,
) -> Result<(), String> {
    attempts::require_existing_source(source.as_deref())?;
    let attempt = attempts::reserve(&agent_id, &attempt_id)?;
    let cwd = attempt
        .setup(crate::acp_client::manager::validate_cwd_async(&cwd))
        .await?;
    let configuration = attempt.configuration_guard().await?;
    let row = attempt
        .setup(crate::acp_client::manager::require_agent_row(
            &app, &agent_id,
        ))
        .await?;
    let row = live_auth_row(&app.state::<AcpManager>(), &row, &cwd)?;
    if !app.state::<AcpManager>().can_logout(&agent_id, &cwd) {
        return Err("此 Agent 当前不支持退出登录，请查看官方账号说明".into());
    }
    let manager = app.state::<AcpManager>();
    let store = app.state::<MetaStore>();
    drop(configuration);
    attempt
        .setup(ensure_connected(&manager, &store, &row, &cwd))
        .await?;
    let _configuration = attempt.configuration_guard().await?;
    let current = attempt
        .setup(crate::acp_client::manager::require_agent_row(
            &app, &agent_id,
        ))
        .await?;
    if current.command != row.command || current.args != row.args || current.env != row.env {
        return Err("Agent 程序设置已变化，请重新操作".into());
    }
    live_auth_row(&manager, &current, &cwd)?;
    if !manager.can_logout(&agent_id, &cwd) {
        return Err("此 Agent 当前不支持退出登录".into());
    }
    attempt.check()?;
    let scope = manager.reserve_account_change(&agent_id)?;
    attempt.protocol_directory(&cwd)?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (_configuration, _scope) = (_configuration, scope);
        let operation = attempt.operation();
        let _attempt = attempt;
        let on_unknown = std::sync::Arc::new(move || {
            let _ = on_output.send(serde_json::json!({"authStatus":"unknown"}));
        });
        app.state::<AcpManager>()
            .logout(&agent_id, &cwd, &_scope, operation, on_unknown)
            .await
    })
    .await
    .map_err(|_| "账号操作未完成".to_string())?
}

/// Read one settings value (`None` when unset).
#[tauri::command]
pub async fn settings_get(
    store: tauri::State<'_, MetaStore>,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    // A read shares the same mutex as saves; never wait for it on the UI thread.
    store.run(move |store| store.get_setting(&key)).await
}

/// Write one settings value.
#[tauri::command]
pub fn settings_set(
    store: tauri::State<'_, MetaStore>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    store.set_setting(&key, &value)
}

pub(crate) fn settings_write_awaited_on_exit(key: &str) -> bool {
    matches!(
        key,
        "unsentWork.v1" | "conversationReadState.v1" | "agentSetup.v1"
    )
}

// The renderer checks these settings for late writes before normal exit.
#[tauri::command(rename = "settings_set")]
async fn exit_settings_set(
    store: tauri::State<'_, MetaStore>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    store
        .run(move |store| store.set_setting(&key, &value))
        .await
}

pub(crate) fn dispatch_exit_settings<R: tauri::Runtime>(invoke: tauri::ipc::Invoke<R>) -> bool {
    let handler: fn(tauri::ipc::Invoke<R>) -> bool = tauri::generate_handler![exit_settings_set];
    handler(invoke)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[cfg_attr(windows, ignore = "Executed by the active owned Windows parent")]
    async fn login_child_keeps_program_reserved_until_exit() {
        #[cfg(windows)]
        crate::platform_tests::windows_conpty::entered(
            crate::platform_tests::windows_conpty::Case::Reservation,
        );
        let agent = "login-reservation-fixture";
        let reservation = crate::install_job::configuration_guard(agent).await;
        #[cfg(windows)]
        let cursor_started = std::time::Instant::now();
        #[cfg(windows)]
        let (output, mut cursor) =
            crate::platform_tests::windows_cursor::CursorConsumer::channel(true);
        #[cfg(not(windows))]
        let output = Channel::new(|_| Ok(()));
        let sink = terminal_output(
            output,
            reservation,
            crate::acp_client::manager::AccountScope::empty_for_test(),
            None,
        );
        let manager = std::sync::Arc::new(PtyManager::new());
        #[cfg(unix)]
        let id = manager
            .spawn(
                "/bin/sh",
                &["-c".into(), "read token; exit 0".into()],
                &[],
                std::path::Path::new("/tmp"),
                portable_pty::PtySize::default(),
                sink,
            )
            .unwrap();
        #[cfg(windows)]
        let directory = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let id = manager
            .spawn(
                &crate::platform_tests::python(),
                &["-u".into(), "-c".into(), "input()".into()],
                &[],
                directory.path(),
                portable_pty::PtySize::default(),
                sink,
            )
            .unwrap();
        #[cfg(windows)]
        cursor.start(std::sync::Arc::downgrade(&manager), id.clone(), true);
        #[cfg(windows)]
        crate::platform_tests::windows_conpty::environment();
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(30),
                crate::install_job::configuration_guard(agent),
            )
            .await
            .is_err()
        );
        #[cfg(unix)]
        manager.write(&id, b"finish\n").unwrap();
        #[cfg(windows)]
        manager.write(&id, b"finish\r").unwrap();
        let waiting = manager.clone();
        tauri::async_runtime::spawn_blocking(move || waiting.await_exit(&id))
            .await
            .unwrap()
            .unwrap();
        let _available = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            crate::install_job::configuration_guard(agent),
        )
        .await
        .expect("the exited child releases its configuration reservation");
        #[cfg(windows)]
        {
            cursor.finish();
            cursor.phase("auth-reservation.fixture.complete", true, cursor_started);
            cursor.assert_settled();
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_login_child_keeps_program_reserved_until_exit_isolated() {
        crate::platform_tests::windows_conpty::run(
            crate::platform_tests::windows_conpty::Case::Reservation,
        );
    }

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
        assert_eq!(info.methods[0].purpose, "login");
        assert_eq!(info.methods[0].completion, "exit_code");
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
    fn terminal_without_extra_args_uses_the_configured_invocation() {
        let row = row(
            "example",
            serde_json::json!({"authMethods":[{
                "id":"login", "name":"Login", "type":"terminal"
            }]}),
        );
        let info = auth_methods_for(&row);
        assert_eq!(
            info.methods[0].terminal_command,
            Some(vec![row.command.clone(), "acp".to_string()])
        );
    }

    #[test]
    fn provider_only_key_exposes_its_verified_delivery_without_guessing_environment() {
        let row = row(
            "example",
            serde_json::json!({"authMethods":[{
                "id":"api-key", "name":"API Key", "_meta":{"api-key":{"provider":"openai"}}
            }]}),
        );
        let info = auth_methods_for(&row);
        assert_eq!(info.methods[0].kind, "api-key");
        assert_eq!(info.methods[0].api_key_provider.as_deref(), Some("openai"));
        assert_eq!(info.methods[0].env_name, None);
        assert_eq!(
            selected_key_provider(&row, "api-key", "openai").unwrap(),
            "openai"
        );
        assert!(selected_key_provider(&row, "api-key", "changed").is_err());
        assert!(selected_key_provider(&row, "other-method", "openai").is_err());
    }

    #[test]
    fn key_save_rejects_changed_removed_and_environment_only_declarations() {
        for method in [
            serde_json::json!({"id":"api-key", "name":"API Key"}),
            serde_json::json!({"id":"api-key", "name":"API Key", "_meta":{"api-key":{"env":"TOKEN"}}}),
            serde_json::json!({"id":"api-key", "name":"API Key", "_meta":{"api-key":{"provider":"unverified"}}}),
        ] {
            let row = row("example", serde_json::json!({"authMethods":[method]}));
            assert!(selected_key_provider(&row, "api-key", "openai").is_err());
        }
    }

    #[test]
    fn api_key_id_alone_is_not_a_credential_delivery_contract() {
        let row = row(
            "example",
            serde_json::json!({"authMethods":[{
                "id":"api-key", "name":"Login"
            }]}),
        );
        assert_eq!(auth_methods_for(&row).methods[0].kind, "agent");
    }

    #[test]
    fn standard_terminal_takes_precedence_over_an_api_key_label() {
        let row = row(
            "example",
            serde_json::json!({"authMethods":[{
                "id":"api-key", "name":"API Key", "type":"terminal", "args":[],
                "_meta":{"api-key":{"env":"EXAMPLE_KEY"}}
            }]}),
        );
        let info = auth_methods_for(&row);
        assert_eq!(info.methods[0].kind, "terminal");
        assert_eq!(info.methods[0].env_name, None);
        assert!(info.methods[0].terminal_command.is_some());
    }

    #[test]
    fn standard_terminal_keeps_configured_invocation_over_legacy_metadata() {
        let row = row(
            "example",
            serde_json::json!({"authMethods":[{
                "id":"login", "name":"Login", "type":"terminal",
                "args":["--standard-login"],
                "env":{"LOGIN_MODE":"standard"},
                "_meta":{
                    "terminal-auth":{"command":"/unexpected/legacy-login", "args":["legacy"]},
                    "api-key":{"env":"UNEXPECTED_KEY"}
                }
            }]}),
        );
        let info = auth_methods_for(&row);
        assert_eq!(info.methods[0].kind, "terminal");
        assert_eq!(info.methods[0].env_name, None);
        assert_eq!(
            info.methods[0].terminal_command,
            Some(vec![
                row.command.clone(),
                "acp".to_string(),
                "--standard-login".to_string(),
            ])
        );
        let parsed = parse_auth_methods(&row);
        let invocation = derive_terminal_invocation(&row, &parsed[0]).unwrap();
        assert_eq!(
            invocation.env,
            vec![("LOGIN_MODE".into(), "standard".into())]
        );
    }

    #[test]
    fn unverified_legacy_metadata_is_preserved_without_execution() {
        let row = row(
            "example",
            serde_json::json!({"authMethods":[{
                "id":"login", "name":"Login",
                "env":{"LOGIN_MODE":"legacy"},
                "_meta":{"terminal-auth":{
                    "command":"/official/legacy-login", "args":["login"]
                }, "unrecognized-envelope":{"keep":[1, "value"]}}
            }]}),
        );
        let before = row.handshake.clone();
        let parsed = parse_auth_methods(&row);
        assert!(derive_terminal_invocation(&row, &parsed[0]).is_err());
        assert_eq!(auth_methods_for(&row).methods[0].kind, "agent");
        assert_eq!(row.handshake, before);
    }

    #[test]
    fn verified_setup_is_explicitly_a_return_and_verify_flow() {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("node_modules/@qwen-code/qwen-code");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@qwen-code/qwen-code","bin":{"qwen":"cli-entry.js"}}"#,
        )
        .unwrap();
        std::fs::write(package.join("cli-entry.js"), "").unwrap();
        let node = dir.path().join("node");
        std::fs::write(&node, "").unwrap();
        let mut row = row(
            "registry:qwen-code",
            serde_json::json!({"authMethods":[{
                "id":"openai", "name":"Use OpenAI API key", "_meta":{"type":"terminal","args":["--auth-type=openai"]}
            }]}),
        );
        row.source = "registry".into();
        row.command = node.display().to_string();
        row.args = vec![
            package.join("cli-entry.js").display().to_string(),
            "--acp".into(),
        ];
        let info = auth_methods_for(&row);
        assert_eq!(info.methods[0].kind, "terminal");
        assert_eq!(info.methods[0].purpose, "setup");
        assert_eq!(info.methods[0].completion, "return_and_verify");
        assert_eq!(
            info.methods[0].terminal_command.as_ref().unwrap(),
            &vec![
                row.command.clone(),
                row.args[0].clone(),
                "--auth-type=openai".into()
            ]
        );
        row.id = "custom".into();
        assert_eq!(auth_methods_for(&row).methods[0].kind, "agent");
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
    fn null_logout_capability_is_not_permission_to_logout() {
        let row = row(
            "example",
            serde_json::json!({"agentCapabilities":{"auth":{"logout":null}}}),
        );
        assert!(!auth_methods_for(&row).can_logout);
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
    #[cfg(target_os = "macos")]
    #[ignore = "writes and removes one non-account test key in the local Keychain"]
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
    fn missing_secure_environment_stops_instead_of_inheriting_shell_credentials() {
        let env = vec![
            ("KEEP".to_string(), "1".to_string()),
            ("API_KEY".to_string(), KEYCHAIN_MARKER.to_string()),
        ];
        let mut inherited = std::collections::HashMap::from([(
            "API_KEY".to_string(),
            "synthetic-other-account".to_string(),
        )]);
        let result = resolve_agent_env_with("synthetic-agent", &env, &|_| None)
            .map(|resolved| inherited.extend(resolved));
        assert!(
            result.is_err(),
            "missing selected secret must stop before process launch"
        );
    }
}

#[cfg(test)]
mod target_tests;

#[cfg(test)]
mod declaration_tests;

#[cfg(test)]
mod declaration_transport_tests;

#[cfg(test)]
mod route_diagnostics_tests;

#[cfg(test)]
mod copilot_tests;

#[cfg(test)]
mod transport_selection_tests;
