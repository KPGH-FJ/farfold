//! One verified official loader/platform relationship. No execution, PATH lookup,
//! credential reads, configuration writes or new installation ownership.
use super::{AgentRow, Installation, MetaStore, Path, PathBuf, Value, executable};
use crate::acp_client::recipes::COPILOT_LOGIN as DECLARATION;
use std::io::Read as _;

const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

pub(super) struct Target {
    node: String,
    loader: String,
    platform: PathBuf,
}

fn row_scope(row: &AgentRow) -> bool {
    row.id == DECLARATION.registry_id
        && row.source == "registry"
        && row.version.as_deref() == Some(DECLARATION.version)
        && Path::new(&row.command).is_absolute()
        && Path::new(&row.command)
            .file_name()
            .is_some_and(|name| name == "node")
        && row.args.len() == 2
        && row.args[1] == "--acp"
}

/// Flat layout only: no intermediate package/root aliases can change Node's
/// resolution base. This is more specific than merely staying inside the root.
fn exact_file(path: &Path) -> Option<PathBuf> {
    let resolved = path.canonicalize().ok()?;
    (resolved == path && resolved.is_file()).then_some(resolved)
}

fn manifest(path: &Path) -> Option<Value> {
    exact_file(path)?;
    let mut data = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut data)
        .ok()?;
    if data.len() > MAX_MANIFEST_BYTES as usize {
        return None;
    }
    serde_json::from_slice(&data).ok()
}

fn absent(path: &Path) -> bool {
    // Broken symlinks and inaccessible paths are not evidence of absence.
    matches!(std::fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}

pub(super) fn verify(row: &AgentRow, store: &MetaStore, data: &Path) -> Option<Target> {
    if !row_scope(row) {
        return None;
    }
    executable(Path::new(&row.command))?;
    let items: Vec<Installation> =
        serde_json::from_value(store.get_setting("installations.v1").ok()??).ok()?;
    // Do not choose the first of ambiguous or inconsistent current receipts.
    let mut selected = items.iter().filter(|item| {
        item.agent_id == row.id && item.command == row.command && item.args == row.args
    });
    let item = selected.next()?;
    if selected.next().is_some()
        || item.source != "managed"
        || item.program_only
        || item.version != row.version
    {
        return None;
    }
    let root = Path::new(item.managed_root.as_deref()?);
    let data = data.canonicalize().ok()?;
    let parent = data.join("agents").join(&row.id);
    if parent.canonicalize().ok()? != parent
        || root.canonicalize().ok()? != root
        || root.parent() != Some(parent.as_path())
        || item.path != root.to_str()?
        || item.id != format!("{}:{}", row.id, root.display())
    {
        return None;
    }
    let package = root.join("node_modules").join(DECLARATION.package);
    let platform = root.join("node_modules").join(DECLARATION.platform_package);
    let loader = package.join(DECLARATION.loader);
    if row.args[0] != loader.to_str()? {
        return None;
    }
    exact_file(&loader)?;
    // These are the only closer package-search locations before the verified
    // root/node_modules export for this exact canonical scoped-package layout.
    for base in [&package, package.parent()?] {
        if !absent(&base.join("node_modules").join(DECLARATION.platform_package)) {
            return None;
        }
        // A redirected node_modules directory could hide a different package
        // (including a currently broken redirect), even if the leaf looks absent.
        for directory in [base.join("node_modules"), base.join("node_modules/@github")] {
            match std::fs::symlink_metadata(&directory) {
                Ok(meta)
                    if meta.is_dir()
                        && directory.canonicalize().ok().as_ref() == Some(&directory) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return None,
            }
        }
    }
    let main = manifest(&package.join("package.json"))?;
    let native = manifest(&platform.join("package.json"))?;
    if main.get("name")?.as_str()? != DECLARATION.package
        || main.get("version")?.as_str()? != DECLARATION.version
        || main.pointer("/bin/copilot")?.as_str()? != DECLARATION.loader
        || main
            .get("optionalDependencies")?
            .get(DECLARATION.platform_package)?
            .as_str()?
            != DECLARATION.version
        || native.get("name")?.as_str()? != DECLARATION.platform_package
        || native.get("version")?.as_str()? != DECLARATION.version
        || native.get("os")? != &serde_json::json!(["darwin"])
        || native.get("cpu")? != &serde_json::json!(["arm64"])
        || native.pointer("/exports/.")?.as_str()? != format!("./{}", DECLARATION.platform_entry)
    {
        return None;
    }
    let target = platform.join(DECLARATION.platform_entry);
    exact_file(&target)?;
    let target = executable(&target)?;
    Some(Target {
        node: row.command.clone(),
        loader: row.args[0].clone(),
        platform: target,
    })
}

fn no_environment(value: Option<&Value>) -> bool {
    value.is_none_or(|value| value.as_object().is_some_and(|env| env.is_empty()))
}

impl Target {
    pub(super) fn invocation(
        &self,
        row: &AgentRow,
        method: &Value,
        command: &str,
        args: &[String],
    ) -> Option<Vec<String>> {
        if !row_scope(row)
            || row.command != self.node
            || row.args[0] != self.loader
            || method.get("id")?.as_str()? != DECLARATION.method
            || method.get("type").is_some()
            || args != ["login"]
            || !no_environment(method.get("env"))
            || !no_environment(method.pointer("/_meta/terminal-auth/env"))
            || !Path::new(command).is_absolute()
            || executable(Path::new(command))? != self.platform
        {
            return None;
        }
        Some(vec![self.node.clone(), self.loader.clone(), "login".into()])
    }
}
