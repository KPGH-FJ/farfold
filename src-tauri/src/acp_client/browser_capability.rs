//! Narrow provenance for reviewed official stdio MCP launch shapes.
//! This is not cryptographic process authentication or MCP readiness. The actual
//! connection must separately permit temporary credentials before delivery.
use crate::meta_store::AgentRow;
use std::fs::File;
use std::io::Read as _;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Component, Path};

const PACKAGE: &str = "@agentclientprotocol/codex-acp";
const BIN: &str = "codex-acp";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LaunchKind {
    Binary,
    Node,
    OpenCode,
}

pub(crate) fn reviewed_launch(agent: &AgentRow) -> Option<LaunchKind> {
    // Catalog discovery/installation assigns these sources; self-chosen names
    // or handshake claims alone do not establish a reviewed launch. This is a
    // command-shape review, not executable attestation. Versions are not pinned.
    let command = Path::new(&agent.command);
    if command.is_absolute()
        && agent.source == "discovered"
        && agent.id == "opencode"
        && agent.args == ["acp"]
        && matches!(
            command.file_name().and_then(|name| name.to_str()),
            Some("opencode")
        )
    {
        return Some(LaunchKind::OpenCode);
    }
    #[cfg(windows)]
    if command.is_absolute()
        && agent.source == "discovered"
        && agent.id == "opencode"
        && agent.args == ["acp"]
        && command.file_name().and_then(|name| name.to_str()) == Some("opencode.exe")
    {
        return Some(LaunchKind::OpenCode);
    }
    if agent.source != "registry"
        || !matches!(agent.id.as_str(), "codex" | "registry:codex-acp")
        || !command.is_absolute()
    {
        return None;
    }
    match command.file_name()?.to_str()? {
        BIN if agent.args.is_empty() => Some(LaunchKind::Binary),
        #[cfg(windows)]
        "codex-acp.exe" if agent.args.is_empty() => Some(LaunchKind::Binary),
        #[cfg(windows)]
        "node.exe" if agent.args.len() == 1 && reviewed_node_entry(Path::new(&agent.args[0])) => {
            Some(LaunchKind::Node)
        }
        "node" if agent.args.len() == 1 && reviewed_node_entry(Path::new(&agent.args[0])) => {
            Some(LaunchKind::Node)
        }
        _ => None,
    }
}

pub(crate) fn eligible(agent: &AgentRow) -> bool {
    reviewed_launch(agent).is_some()
}

#[cfg(unix)]
fn regular_file(path: &Path) -> Option<File> {
    // A FIFO or a last-component symlink replacement must not block this check.
    let file = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    file.metadata().ok()?.is_file().then_some(file)
}

#[cfg(windows)]
fn regular_file(path: &Path) -> Option<File> {
    let parent = crate::file_access::open_directory(path.parent()?).ok()?;
    let file = crate::file_access::open_relative(&parent, Path::new(path.file_name()?)).ok()?;
    crate::file_access::stamp(&file)
        .ok()?
        .regular
        .then_some(file)
}

fn manifest(path: &Path) -> Option<serde_json::Value> {
    let file = regular_file(path)?;
    if file.metadata().ok()?.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    let mut data = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut data)
        .ok()?;
    if data.len() > MAX_MANIFEST_BYTES as usize {
        return None;
    }
    serde_json::from_slice(&data).ok()
}

fn reviewed_node_entry(entry: &Path) -> bool {
    reviewed_node_package(entry).is_some()
}

fn reviewed_node_package(entry: &Path) -> Option<()> {
    if !entry.is_absolute() {
        return None;
    }
    // The current registry npm installer records the canonical bin under this
    // layout. It does not choose an entry or package from the working directory.
    let suffix = Path::new("node_modules").join(PACKAGE);
    let package = entry.ancestors().find(|path| path.ends_with(&suffix))?;
    let modules = package.parent()?.parent()?.canonicalize().ok()?;
    let package = package.canonicalize().ok()?;
    if package != modules.join(PACKAGE) {
        return None;
    }
    let entry = entry.canonicalize().ok()?;
    if !entry.starts_with(&package) {
        return None;
    }
    regular_file(&entry)?;
    let manifest = manifest(&package.join("package.json"))?;
    if manifest.get("name")?.as_str()? != PACKAGE {
        return None;
    }
    let bin = Path::new(manifest.get("bin")?.as_object()?.get(BIN)?.as_str()?);
    if bin.as_os_str().is_empty()
        || bin.is_absolute()
        || !bin
            .components()
            .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return None;
    }
    // Ordinary npm bin links may resolve within this same package. The Node
    // executable itself can also be a normal installation symlink; neither is
    // a reason to inspect executable contents or introduce a version/SHA gate.
    (package.join(bin).canonicalize().ok()? == entry).then_some(())
}

#[cfg(test)]
#[path = "browser_capability_tests.rs"]
mod tests;
