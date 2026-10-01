//! Path layout for owned installations, not an inventory or ownership grant.
//! Callers must already hold the matching receipt and their operation guard.
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy)]
pub(crate) enum Layout {
    Agent,
    Companion,
}

fn encoded_name(agent_id: &str) -> String {
    let mut name = String::from("agent-");
    for byte in agent_id.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_".contains(&byte) {
            name.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(name, "%{byte:02X}").expect("writing to String cannot fail");
        }
    }
    name
}

pub(crate) fn parent(data: &Path, agent_id: &str, layout: Layout) -> PathBuf {
    let namespace = match layout {
        Layout::Agent => "agent-installations",
        Layout::Companion => "companion-programs",
    };
    data.join(namespace).join(encoded_name(agent_id))
}

// Validate every descendant before following it; creation never traverses a
// pre-existing symlink, including one that currently has a missing target.
fn checked_directory(data: &Path, expected: &Path, create: bool) -> Option<PathBuf> {
    let mut current = data.to_path_buf();
    for part in expected.strip_prefix(data).ok()?.components() {
        let Component::Normal(part) = part else {
            return None;
        };
        current.push(part);
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if create && error.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return None,
                }
                std::fs::symlink_metadata(&current).ok()?
            }
            Err(_) => return None,
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return None;
        }
    }
    (current.canonicalize().ok()?.as_os_str() == expected.as_os_str()).then_some(current)
}

pub(crate) fn prepare_agent_parent(data: &Path, agent_id: &str) -> Result<PathBuf, String> {
    let data = data.canonicalize().map_err(|_| "无法读取安装目录")?;
    checked_directory(&data, &parent(&data, agent_id, Layout::Agent), true)
        .ok_or_else(|| "无法准备安装目录".into())
}

fn legacy_parent(data: &Path, agent_id: &str) -> Option<PathBuf> {
    // Old literal IDs remain usable only as one original directory component.
    // Never reinterpret absolute/escaping IDs as a grant outside data/agents.
    let mut parts = Path::new(agent_id).components();
    match (parts.next(), parts.next()) {
        (Some(Component::Normal(name)), None) if name == agent_id => {}
        _ => return None,
    }
    checked_directory(data, &data.join("agents").join(agent_id), false)
}

/// A receipt's exact direct child. Missing roots are accepted only when the
/// caller is finishing metadata cleanup after a confirmed filesystem removal.
/// This never discovers receipts or turns an external path into an owned one.
pub(crate) fn recorded_root(
    data: &Path,
    agent_id: &str,
    root: &Path,
    layout: Layout,
    allow_missing: bool,
) -> Option<PathBuf> {
    let data = data.canonicalize().ok()?;
    let expected = checked_directory(&data, &parent(&data, agent_id, layout), false);
    let legacy = legacy_parent(&data, agent_id);
    if ![expected, legacy].iter().flatten().any(|parent| {
        root.parent()
            .is_some_and(|actual| actual.as_os_str() == parent.as_os_str())
    }) {
        return None;
    }
    match std::fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            let canonical = root.canonicalize().ok()?;
            (canonical.as_os_str() == root.as_os_str()).then_some(canonical)
        }
        Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => {
            Some(root.to_path_buf())
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "managed_paths_tests.rs"]
mod tests;
