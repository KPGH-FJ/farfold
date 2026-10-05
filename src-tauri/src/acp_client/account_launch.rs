//! Provenance of read-only supplements without a capability declaration. Public
//! package entry metadata only; no credentials, Agent config, SHA or version gate.
use super::account_query::AccountQuery;
use crate::meta_store::AgentRow;
use std::{
    fs::File,
    io::Read,
    path::{Component, Path},
};

const LIMIT: u64 = 64 * 1024;

fn text(path: &Path, root: &Path) -> Option<String> {
    let canonical = path.canonicalize().ok()?;
    if !canonical.starts_with(root) {
        return None;
    }
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(canonical).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return None;
        }
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > LIMIT as usize {
        return None;
    }
    String::from_utf8(bytes).ok()
}

pub(crate) fn reviewed(row: &AgentRow) -> Option<AccountQuery> {
    if row.source != "registry" || !Path::new(&row.command).is_absolute() {
        return None;
    }
    match row.id.as_str() {
        "registry:codebuddy-code" if codebuddy(row) => Some(AccountQuery::CodeBuddy),
        "registry:mistral-vibe" if vibe(row) => Some(AccountQuery::Vibe),
        _ => None,
    }
}

fn codebuddy(row: &AgentRow) -> bool {
    (|| {
        let command = Path::new(&row.command);
        if crate::process_platform::program_name(command).as_deref() != Some("node")
            || row.args.len() != 2
            || row.args[1] != "--acp"
        {
            return None;
        }
        let entry = Path::new(&row.args[0]);
        if !entry.is_absolute() {
            return None;
        }
        let suffix = Path::new("node_modules/@tencent-ai/codebuddy-code");
        let package = entry
            .ancestors()
            .find(|p| p.ends_with(suffix))?
            .canonicalize()
            .ok()?;
        let entry = entry.canonicalize().ok()?;
        if !entry.starts_with(&package) || !entry.is_file() {
            return None;
        }
        let manifest: serde_json::Value =
            serde_json::from_str(&text(&package.join("package.json"), &package)?).ok()?;
        if manifest["name"] != "@tencent-ai/codebuddy-code" {
            return None;
        }
        let bin = Path::new(manifest.pointer("/bin/codebuddy-code")?.as_str()?);
        if bin.is_absolute()
            || bin.as_os_str().is_empty()
            || !bin
                .components()
                .all(|p| matches!(p, Component::Normal(_) | Component::CurDir))
        {
            return None;
        }
        (package.join(bin).canonicalize().ok()? == entry).then_some(())
    })()
    .is_some()
}

fn vibe(row: &AgentRow) -> bool {
    (|| {
        let command = Path::new(&row.command).canonicalize().ok()?;
        // Official registry archives contain this standalone executable. The
        // v2.25.8 build spec points to the same ACP server/extension handlers.
        let program = crate::process_platform::program_name(&command)?;
        if program == "vibe-acp" && row.args.is_empty() {
            return command.is_file().then_some(());
        }
        if program != "vibe" || !command.is_file() || row.args != ["--acp"] {
            return None;
        }
        let bin = command.parent()?;
        if bin.file_name()?.to_str()? != if cfg!(windows) { "Scripts" } else { "bin" } {
            return None;
        }
        let root = bin.parent()?.canonicalize().ok()?;
        // The managed Python installer resolves this same public console entry.
        // Never inspect ~/.vibe, keyring, .env or a work-folder configuration.
        for site in package_sites(&root)? {
            let Ok(packages) = std::fs::read_dir(site) else {
                continue;
            };
            for info in packages.take(2048).flatten() {
                let name = info.file_name();
                let name = name.to_str()?;
                if !name.starts_with("mistral_vibe-") || !name.ends_with(".dist-info") {
                    continue;
                }
                let metadata = text(&info.path().join("METADATA"), &root)?;
                if !metadata.lines().any(|l| l == "Name: mistral-vibe") {
                    continue;
                }
                let entries = text(&info.path().join("entry_points.txt"), &root)?;
                let mut scripts = false;
                if entries.lines().any(|line| {
                    let line = line.trim();
                    if line.starts_with('[') {
                        scripts = line == "[console_scripts]";
                        return false;
                    }
                    scripts
                        && line.split_once('=').is_some_and(|(name, target)| {
                            name.trim() == "vibe" && target.trim() == "vibe.cli.launcher:main"
                        })
                }) {
                    return Some(());
                }
            }
        }
        None
    })()
    .is_some()
}

fn package_sites(root: &Path) -> Option<Vec<std::path::PathBuf>> {
    if cfg!(windows) {
        return Some(vec![root.join("Lib/site-packages")]);
    }
    Some(
        std::fs::read_dir(root.join("lib"))
            .ok()?
            .take(32)
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("python"))
            })
            .map(|entry| entry.path().join("site-packages"))
            .collect(),
    )
}

#[cfg(test)]
#[path = "account_launch_tests.rs"]
mod tests;
