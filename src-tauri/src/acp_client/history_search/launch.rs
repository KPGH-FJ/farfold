//! Public selected-installation metadata only. Never probes private Agent storage.
use super::types::*;
use crate::{acp_client::extension_inventory as inventory, file_access, meta_store::AgentRow};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Command,
};
const ADAPTER: &str = "@agentclientprotocol/claude-agent-acp";
const SDK: &str = "@anthropic-ai/claude-agent-sdk";
#[derive(Clone)]
pub(super) enum Route {
    AppServer,
    Sdk(Resolved),
}
impl Route {
    pub fn source(&self) -> &'static str {
        match self {
            Self::AppServer => "officialAppServer",
            Self::Sdk(_) => "officialSdk",
        }
    }
    pub fn scope(&self) -> Option<SdkScope> {
        matches!(self, Self::Sdk(_)).then(SdkScope::partial)
    }
    pub fn current(&self, row: &AgentRow) -> Result<()> {
        if let Self::Sdk(old) = self
            && &resolve(row)? != old
        {
            return Err(Code::SelectionChanged.into());
        }
        Ok(())
    }
}
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Resolved {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub root: PathBuf,
    pub sdk: PathBuf,
    watched: Vec<(PathBuf, file_access::Stamp)>,
}
fn regular(path: &Path) -> Result<File> {
    let parent = file_access::open_directory(path.parent().ok_or(Code::EntryUnverified)?)
        .map_err(|_| Code::EntryUnverified)?;
    let file = file_access::open_relative(
        &parent,
        Path::new(path.file_name().ok_or(Code::EntryUnverified)?),
    )
    .map_err(|_| Code::EntryUnverified)?;
    if !file_access::stamp(&file)
        .map_err(|_| Code::EntryUnverified)?
        .regular
    {
        return Err(Code::EntryUnverified.into());
    }
    Ok(file)
}
fn manifest(path: &Path) -> Result<Value> {
    let file = regular(path)?;
    let before = file_access::stamp(&file).map_err(|_| Code::EntryUnverified)?;
    if before.size > 65536 {
        return Err(Code::EntryUnverified.into());
    }
    let mut bytes = vec![];
    (&file)
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| Code::EntryUnverified)?;
    if bytes.len() > 65536
        || file_access::stamp(&file).map_err(|_| Code::EntryUnverified)? != before
    {
        return Err(Code::EntryUnverified.into());
    }
    serde_json::from_slice(&bytes).map_err(|_| Code::EntryUnverified.into())
}
fn declared(root: &Path, raw: &str) -> Result<PathBuf> {
    let path = Path::new(raw);
    if raw.is_empty()
        || path.is_absolute()
        || !path
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(Code::EntryUnverified.into());
    }
    let value = root
        .join(path)
        .canonicalize()
        .map_err(|_| Code::EntryUnverified)?;
    if !value.starts_with(root) {
        return Err(Code::EntryUnverified.into());
    }
    regular(&value)?;
    Ok(value)
}
pub(super) fn resolve(row: &AgentRow) -> Result<Resolved> {
    if row.source != "registry" || row.id != "registry:claude-acp" {
        return Err(Code::NotReviewed.into());
    }
    let command = Path::new(&row.command);
    if !command.is_absolute()
        || crate::process_platform::program_name(command).as_deref() != Some("node")
        || row.args.len() != 1
        || !crate::process_platform::executable(command)
    {
        return Err(Code::EntryUnverified.into());
    }
    let raw = Path::new(&row.args[0]);
    if !raw.is_absolute() {
        return Err(Code::EntryUnverified.into());
    }
    let package = raw
        .ancestors()
        .find(|p| p.ends_with(Path::new("node_modules").join(ADAPTER)))
        .ok_or(Code::EntryUnverified)?;
    let modules = package
        .parent()
        .and_then(Path::parent)
        .ok_or(Code::EntryUnverified)?
        .canonicalize()
        .map_err(|_| Code::EntryUnverified)?;
    let root = modules.parent().ok_or(Code::EntryUnverified)?.to_path_buf();
    let package = package.canonicalize().map_err(|_| Code::EntryUnverified)?;
    if package != modules.join(ADAPTER) {
        return Err(Code::EntryUnverified.into());
    }
    let entry = raw.canonicalize().map_err(|_| Code::EntryUnverified)?;
    let adapter_manifest = package.join("package.json");
    let a = manifest(&adapter_manifest)?;
    if a["name"] != ADAPTER
        || !a["dependencies"][SDK].is_string()
        || declared(
            &package,
            a["bin"]["claude-agent-acp"]
                .as_str()
                .ok_or(Code::EntryUnverified)?,
        )? != entry
    {
        return Err(Code::EntryUnverified.into());
    }
    // Match Node's ordinary ancestor node_modules search, bounded to this install.
    // First present candidate must be valid; never fall through an ambiguous package.
    let mut sdk_package = None;
    for ancestor in entry
        .parent()
        .ok_or(Code::EntryUnverified)?
        .ancestors()
        .take(16)
    {
        if !ancestor.starts_with(&root) {
            break;
        }
        let candidate = ancestor.join("node_modules").join(SDK);
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) => {
                sdk_package = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Code::EntryUnverified.into()),
        }
    }
    let sdk_package = sdk_package
        .ok_or(Code::EntryUnverified)?
        .canonicalize()
        .map_err(|_| Code::EntryUnverified)?;
    if !sdk_package.starts_with(&root) {
        return Err(Code::EntryUnverified.into());
    }
    let sdk_manifest = sdk_package.join("package.json");
    let s = manifest(&sdk_manifest)?;
    let export = s["exports"]["."].as_object().ok_or(Code::EntryUnverified)?;
    if s["name"] != SDK
        || s["type"] != "module"
        || export.keys().any(|k| k != "default" && k != "types")
    {
        return Err(Code::EntryUnverified.into());
    }
    let default = export
        .get("default")
        .and_then(Value::as_str)
        .filter(|s| s.starts_with("./"))
        .ok_or(Code::EntryUnverified)?;
    let sdk = declared(&sdk_package, default)?;
    let node = command.canonicalize().map_err(|_| Code::EntryUnverified)?;
    let watched = [&node, &entry, &adapter_manifest, &sdk_manifest, &sdk]
        .into_iter()
        .map(|p| {
            Ok((
                p.clone(),
                file_access::stamp(&regular(p)?).map_err(|_| Code::EntryUnverified)?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Resolved {
        node,
        entry,
        root,
        sdk,
        watched,
    })
}
pub(super) fn environment(row: &AgentRow) -> Result<HashMap<String, String>> {
    selected_environment(
        row,
        crate::shell_env::cached_command_env().ok_or(Code::EnvironmentUnavailable)?,
    )
}
pub(super) fn selected_environment(
    row: &AgentRow,
    mut env: HashMap<String, String>,
) -> Result<HashMap<String, String>> {
    for (key, value) in &row.env {
        if key.is_empty()
            || key.contains('=')
            || key.chars().any(char::is_control)
            || value.contains('\0')
        {
            return Err(Code::EnvironmentUnavailable.into());
        }
        env.insert(key.clone(), value.clone());
    }
    if env.values().any(|v| v == crate::auth::KEYCHAIN_MARKER) {
        return Err(Code::EnvironmentUnavailable.into());
    }
    for key in [
        "NODE_OPTIONS",
        "NODE_PATH",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
    ] {
        if env
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
            .is_some_and(|v| !v.is_empty())
        {
            return Err(Code::EnvironmentUnavailable.into());
        }
    }
    Ok(env)
}
pub(super) fn admission(row: &AgentRow) -> Result<Route> {
    // The management transport's platform support is not history-read admission.
    if !cfg!(target_os = "macos") {
        return Err(Code::PlatformUnsupported.into());
    }
    if row.id != "registry:claude-acp" {
        inventory::launch::admission(row)?;
        return Ok(Route::AppServer);
    }
    let value = resolve(row)?;
    environment(row)?;
    Ok(Route::Sdk(value))
}
pub(super) fn command(row: &AgentRow, cwd: &str, selected: &Resolved) -> Result<Command> {
    let fresh = resolve(row)?;
    if &fresh != selected {
        return Err(Code::SelectionChanged.into());
    }
    let mut command = Command::new(&selected.node);
    command
        .args([
            "--input-type=module",
            "--eval",
            include_str!("claude_read.mjs"),
        ])
        .current_dir(cwd)
        .envs(environment(row)?);
    Ok(command)
}
