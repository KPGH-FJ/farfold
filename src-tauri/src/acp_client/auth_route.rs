//! Authentication transport comes from declarations and verified program identity.
//! No process execution, credential lookup, user configuration or metadata writes.
use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::AuthMethod;
use serde_json::Value;

use crate::{
    installations::Installation,
    meta_store::{AgentRow, MetaStore},
};

pub(crate) const UNAVAILABLE: &str =
    "此登录声明未能确认对应程序，请在更多登录方式中明确配置登录命令";
pub(crate) const ENVIRONMENT_UNAVAILABLE: &str = "此方式需要环境变量，当前不能在这里直接配置";
pub(crate) const UNSUPPORTED: &str = "此登录方式当前不能自动运行，请使用更多登录方式或重新检查";

/// Fixed, content-free failures from the same verifier that owns execution.
/// Never attach paths, arguments, environment values or protocol error data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnavailableReason {
    InvalidDeclaration,
    PathUnavailable,
    LaunchUnsupported,
    ProgramMismatch,
    ScriptMismatch,
    Unverified,
}

impl UnavailableReason {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::InvalidDeclaration => {
                "此登录方式提供的信息不完整或格式不正确，请在更多登录方式中明确配置"
            }
            Self::PathUnavailable => {
                "无法确认此登录方式的程序路径，请检查程序或在更多登录方式中明确配置"
            }
            Self::LaunchUnsupported => {
                "此登录方式的启动参数尚不能自动确认，请在更多登录方式中明确配置"
            }
            Self::ProgramMismatch => "此登录方式的程序与当前程序不一致，请在更多登录方式中明确配置",
            Self::ScriptMismatch => "此登录方式的脚本与当前程序不一致，请在更多登录方式中明确配置",
            Self::Unverified => UNAVAILABLE,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct TerminalInvocation {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub setup: bool,
    pub description: Option<&'static str>,
}

#[derive(Debug, Clone)]
pub(crate) enum Route {
    Agent,
    Terminal(TerminalInvocation),
    ApiKey(Value),
    Environment(Vec<String>),
    Unsupported,
    Unavailable(UnavailableReason),
}

/// The same declaration-only guard is used by the live protocol dispatcher.
/// A terminal extension that needs target verification can never fall through.
pub(crate) fn protocol_method(method: &Value) -> bool {
    method.get("_farfoldInvalid") != Some(&Value::Bool(true))
        && matches!(method.get("type"), None | Some(Value::String(_)))
        && method
            .get("type")
            .and_then(Value::as_str)
            .is_none_or(|kind| kind == "agent")
        && method.pointer("/_meta/terminal-auth").is_none()
        && method.pointer("/_meta/type").and_then(Value::as_str) != Some("terminal")
        && !method
            .pointer("/_meta/api-key")
            .is_some_and(Value::is_object)
}

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(vec![]);
    };
    let args = value.as_array()?;
    if args.len() > 64 {
        return None;
    }
    args.iter()
        .map(|arg| {
            let arg = arg.as_str()?;
            (arg.len() <= 4096 && !arg.contains('\0')).then(|| arg.to_string())
        })
        .collect()
}

fn method_env(method: &Value) -> Option<Vec<(String, String)>> {
    let Some(value) = method.get("env") else {
        return Some(vec![]);
    };
    value
        .as_object()?
        .iter()
        .map(|(name, value)| {
            let value = value.as_str()?;
            (crate::manual_auth::valid_env(name) && !value.contains('\0'))
                .then(|| (name.clone(), value.to_string()))
        })
        .collect()
}

fn executable(path: &Path) -> Option<PathBuf> {
    crate::agent_discovery::validate_executable_path(path.to_str()?).ok()
}

fn resolve(command: &str) -> Option<PathBuf> {
    if command.contains('/') {
        return executable(Path::new(command));
    }
    let path =
        crate::agent_discovery::find_binary(command, &crate::agent_discovery::candidate_dirs())?;
    executable(&path)
}

/// This bounded check never parses arbitrary interpreter flags or shell code.
/// Such launches remain available through explicit manual configuration.
fn interpreter(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        name,
        "node" | "bun" | "deno" | "sh" | "bash" | "zsh" | "ruby" | "perl" | "python"
    ) || name.strip_prefix("python").is_some_and(|version| {
        !version.is_empty()
            && version
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    })
}

/// Legacy descriptors contain complete argv. Preserve their auth arguments,
/// while freezing the selected absolute executable and simple script identity.
fn same_program(
    row: &AgentRow,
    command: &str,
    args: &[String],
) -> Result<Vec<String>, UnavailableReason> {
    use UnavailableReason::{LaunchUnsupported, PathUnavailable, ProgramMismatch, ScriptMismatch};
    let selected = executable(Path::new(&row.command)).ok_or(PathUnavailable)?;
    let target = resolve(command).ok_or(PathUnavailable)?;
    if interpreter(Path::new(&row.command)) || interpreter(&selected) {
        let entry = Path::new(row.args.first().ok_or(LaunchUnsupported)?);
        if !entry.is_absolute() {
            return Err(LaunchUnsupported);
        }
        if !entry.is_file() {
            return Err(PathUnavailable);
        }
        let actual_entry = entry.canonicalize().map_err(|_| PathUnavailable)?;
        if target == selected {
            let declared_entry = Path::new(args.first().ok_or(LaunchUnsupported)?);
            if !declared_entry.is_absolute() {
                return Err(LaunchUnsupported);
            }
            if declared_entry.canonicalize().map_err(|_| PathUnavailable)? != actual_entry {
                return Err(ScriptMismatch);
            }
            let mut argv = vec![row.command.clone(), row.args[0].clone()];
            argv.extend(args.iter().skip(1).cloned());
            return Ok(argv);
        }
        if target == actual_entry {
            let mut argv = vec![row.command.clone(), row.args[0].clone()];
            argv.extend(args.iter().cloned());
            return Ok(argv);
        }
        return Err(ProgramMismatch);
    }
    if target != selected {
        return Err(ProgramMismatch);
    }
    let mut argv = vec![row.command.clone()];
    argv.extend(args.iter().cloned());
    Ok(argv)
}

fn amp_companion(
    row: &AgentRow,
    method: &Value,
    command: &str,
    args: &[String],
) -> Option<Vec<String>> {
    if row.id != "registry:amp-acp" || method.get("id")?.as_str()? != "setup" || !args.is_empty() {
        return None;
    }
    let declaration = super::recipes::verified_for(row)
        .iter()
        .find(|item| item.id == "amp-cli")?;
    let path = super::preparation::resolve_dependency(declaration, Some(row))?;
    let selected = executable(&path)?;
    // A declared bare companion name resolves to the explicitly selected program,
    // not another same-named executable earlier on PATH. Broken selection stays broken.
    if command != declaration.binary && executable(Path::new(command))? != selected {
        return None;
    }
    Some(vec![path.to_str()?.to_string()])
}

/// This proof is limited to an existing selected registry ZIP installation.
/// It never gives a path new ownership or creates another installation record.
pub(crate) fn managed_kilo(row: &AgentRow, store: &MetaStore, data: &Path) -> bool {
    if row.id != "registry:kilo"
        || row.source != "registry"
        || row.version.as_deref() != Some("7.8.1")
        || row.args != ["acp"]
        || Path::new(&row.command)
            .file_name()
            .is_none_or(|name| name != "kilo")
    {
        return false;
    }
    let Ok(Some(value)) = store.get_setting("installations.v1") else {
        return false;
    };
    let Ok(items) = serde_json::from_value::<Vec<Installation>>(value) else {
        return false;
    };
    items.iter().any(|item| {
        if item.agent_id != row.id
            || item.source != "managed"
            || item.program_only
            || item.args != row.args
            || item.version != row.version
        {
            return false;
        }
        let Some(root) = item.managed_root.as_deref().map(Path::new) else {
            return false;
        };
        let Some((canonical, parent, selected, recorded)) = root
            .canonicalize()
            .ok()
            .zip(data.join("agents").join(&row.id).canonicalize().ok())
            .zip(executable(Path::new(&row.command)))
            .zip(executable(Path::new(&item.command)))
            .map(|(((root, parent), selected), recorded)| (root, parent, selected, recorded))
        else {
            return false;
        };
        root == canonical
            && data
                .canonicalize()
                .ok()
                .is_some_and(|data| parent == data.join("agents").join(&row.id))
            && canonical.parent() == Some(parent.as_path())
            && selected == recorded
            && selected == canonical.join("kilo")
    })
}

pub(crate) fn route(row: &AgentRow, method: &Value, managed_kilo: bool) -> Route {
    use UnavailableReason::{InvalidDeclaration, Unverified};
    if method.get("_farfoldInvalid") == Some(&Value::Bool(true)) {
        return Route::Unavailable(InvalidDeclaration);
    }
    if method.get("type").and_then(Value::as_str) == Some("env_var") {
        let Some(vars) = method.get("vars").and_then(Value::as_array) else {
            return Route::Unsupported;
        };
        let names: Option<Vec<_>> = vars
            .iter()
            .map(|v| {
                v.get("name")
                    .and_then(Value::as_str)
                    .filter(|s| crate::manual_auth::valid_env(s))
                    .map(str::to_string)
            })
            .collect();
        return match names {
            Some(names) if !names.is_empty() && names.len() <= 64 => Route::Environment(names),
            _ => Route::Unsupported,
        };
    }
    if method.get("type").and_then(Value::as_str) == Some("terminal") {
        // The schema tolerates malformed container members; an invocation must
        // instead preserve every declared argument/environment entry exactly.
        if strings(method.get("args")).is_none() || method_env(method).is_none() {
            return Route::Unavailable(InvalidDeclaration);
        }
        // The typed descriptor owns invocation semantics, even with malformed old metadata.
        let Ok(AuthMethod::Terminal(terminal)) =
            serde_json::from_value::<AuthMethod>(method.clone())
        else {
            return Route::Unavailable(InvalidDeclaration);
        };
        if terminal.args.iter().any(|arg| arg.contains('\0'))
            || terminal
                .env
                .iter()
                .any(|(name, value)| !crate::manual_auth::valid_env(name) || value.contains('\0'))
        {
            return Route::Unavailable(InvalidDeclaration);
        }
        let mut argv = vec![row.command.clone()];
        argv.extend(row.args.iter().cloned());
        argv.extend(terminal.args);
        return Route::Terminal(TerminalInvocation {
            argv,
            env: terminal.env.into_iter().collect(),
            setup: false,
            description: None,
        });
    }
    if !matches!(method.get("type"), None | Some(Value::String(_)))
        || method
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "agent")
    {
        return Route::Unsupported;
    }
    if let Some(value) = method.pointer("/_meta/terminal-auth") {
        let Some(meta) = value.as_object() else {
            return Route::Unavailable(InvalidDeclaration);
        };
        let Some(command) = meta
            .get("command")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return Route::Unavailable(InvalidDeclaration);
        };
        let Some(args) = strings(meta.get("args")) else {
            return Route::Unavailable(InvalidDeclaration);
        };
        let Some(env) = method_env(method) else {
            return Route::Unavailable(InvalidDeclaration);
        };
        if meta.get("label").is_some_and(|label| !label.is_string()) {
            return Route::Unavailable(InvalidDeclaration);
        }
        let argv = if managed_kilo && super::recipes::kilo_legacy_login(row, method, command, &args)
        {
            Ok(vec![row.command.clone(), "auth".into(), "login".into()])
        } else {
            amp_companion(row, method, command, &args)
                .map(Ok)
                .unwrap_or_else(|| same_program(row, command, &args))
        };
        return match argv {
            Ok(argv) => Route::Terminal(TerminalInvocation {
                argv,
                env,
                setup: false,
                description: None,
            }),
            Err(reason) => Route::Unavailable(reason),
        };
    }
    if let Some(setup) = super::auth_compat::terminal_setup(row, method) {
        let Some(env) = method_env(method) else {
            return Route::Unavailable(InvalidDeclaration);
        };
        return Route::Terminal(TerminalInvocation {
            argv: setup.argv,
            env,
            setup: true,
            description: Some(setup.description),
        });
    }
    if method.pointer("/_meta/type").and_then(Value::as_str) == Some("terminal") {
        return Route::Unavailable(Unverified);
    }
    if let Some(meta) = method
        .pointer("/_meta/api-key")
        .filter(|meta| meta.is_object())
    {
        return Route::ApiKey(meta.clone());
    }
    if protocol_method(method) {
        Route::Agent
    } else {
        Route::Unavailable(Unverified)
    }
}

#[cfg(test)]
mod tests;
