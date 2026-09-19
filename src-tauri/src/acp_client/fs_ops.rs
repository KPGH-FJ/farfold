//! `fs/read_text_file` and `fs/write_text_file` client capability.
//!
//! Every path the agent names must resolve inside the session's working
//! directory: the target is normalized lexically, its deepest existing
//! ancestor is canonicalized, and the result must stay under the
//! canonicalized session root — symlinks pointing out of the project are
//! rejected the same way `..` escapes are.
//!
//! Writes read the previous content first and emit a unified diff artifact
//! (`{type:"fileDiff",path,oldSize,newSize,diff,ts}`); the pump stores it on
//! the connection's artifact list and forwards it on the session channel as
//! `{kind:"artifact"}`.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use similar::TextDiff;

/// Refuse files larger than this instead of streaming unbounded content to
/// the agent.
const READ_CAP_BYTES: u64 = 16 * 1024 * 1024;

/// Resolve `path` (absolute or cwd-relative) against the session root.
/// The deepest existing ancestor is canonicalized so both existing files
/// and not-yet-created paths are checked against the real filesystem
/// layout. Returns the resolved path or an error naming the violation.
pub(crate) fn resolve_within(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("cannot resolve workspace {}: {error}", root.display()))?;
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        canonical_root.join(path)
    };
    // Lexical normalization: `.`/`..` collapse without touching the disk,
    // so `root/../x` fails containment rather than slipping past it.
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    // Canonicalize the deepest existing ancestor, then re-attach the
    // not-yet-existing tail. A symlink anywhere above the tail resolves to
    // its real location here.
    let mut probe = normalized.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !probe.exists() {
        match probe.file_name() {
            Some(name) => {
                tail.push(name.to_os_string());
                probe.pop();
            }
            None => return Err(format!("path outside workspace: {}", path.display())),
        }
    }
    let mut resolved = probe
        .canonicalize()
        .map_err(|error| format!("cannot resolve {}: {error}", probe.display()))?;
    for name in tail.iter().rev() {
        resolved.push(name);
    }
    if !resolved.starts_with(&canonical_root) {
        return Err(format!("path outside workspace: {}", path.display()));
    }
    Ok(resolved)
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {key}"))
}

fn read_text_file(root: &Path, params: &Value) -> Result<Value, String> {
    let path = resolve_within(root, Path::new(required_str(params, "path")?))?;
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if metadata.len() > READ_CAP_BYTES {
        return Err(format!("file too large: {}", path.display()));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let line = params
        .get("line")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1);
    let limit = params.get("limit").and_then(Value::as_u64);
    let sliced = if line > 1 || limit.is_some() {
        let lines: Vec<&str> = content.split_inclusive('\n').collect();
        let start = usize::try_from(line - 1)
            .unwrap_or(usize::MAX)
            .min(lines.len());
        let end = match limit {
            Some(limit) => start.saturating_add(usize::try_from(limit).unwrap_or(usize::MAX)),
            None => lines.len(),
        }
        .min(lines.len());
        lines[start..end].concat()
    } else {
        content
    };
    Ok(serde_json::json!({"content": sliced}))
}

fn unified_diff(path: &Path, old: &str, new: &str) -> String {
    let name = path.to_string_lossy();
    TextDiff::from_lines(old, new)
        .unified_diff()
        .header(&format!("a/{name}"), &format!("b/{name}"))
        .to_string()
}

fn write_text_file(root: &Path, params: &Value) -> Result<(Value, Value), String> {
    let path = resolve_within(root, Path::new(required_str(params, "path")?))?;
    let content = required_str(params, "content")?;
    if let Some(parent) = path.parent()
        && !parent.is_dir()
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    let old = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    std::fs::write(&path, content)
        .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    let artifact = serde_json::json!({
        "type": "fileDiff",
        "path": path.to_string_lossy(),
        "oldSize": old.len(),
        "newSize": content.len(),
        "diff": unified_diff(&path, &old, content),
        "ts": super::tap::now_millis(),
    });
    Ok((serde_json::json!({}), artifact))
}

/// Handle one `fs/*` request. Returns the JSON-RPC result plus a
/// `fileDiff` artifact for writes.
pub(crate) fn handle(
    root: &Path,
    method: &str,
    params: &Value,
) -> Result<(Value, Option<Value>), String> {
    match method {
        "fs/read_text_file" => Ok((read_text_file(root, params)?, None)),
        "fs/write_text_file" => {
            let (response, artifact) = write_text_file(root, params)?;
            Ok((response, Some(artifact)))
        }
        other => Err(format!("unsupported fs method {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.keep();
        path
    }

    #[test]
    fn rejects_escape_outside_workspace() {
        let root = root();
        let inside = root.join("sub/dir");
        std::fs::create_dir_all(&inside).unwrap();
        assert!(resolve_within(&root, Path::new("sub/dir/file.txt")).is_ok());
        assert!(resolve_within(&root, Path::new("../outside.txt")).is_err());
        assert!(resolve_within(&root, Path::new("/etc/passwd")).is_err());
        assert!(resolve_within(&root, Path::new("sub/../../etc/passwd")).is_err());
    }

    #[test]
    fn resolves_new_file_under_existing_ancestor() {
        let root = root();
        let resolved = resolve_within(&root, Path::new("a/b/c.txt")).expect("resolves");
        assert!(resolved.starts_with(root.canonicalize().unwrap()));
        assert!(resolved.ends_with("a/b/c.txt"));
    }

    #[test]
    fn read_slices_lines_and_limits() {
        let root = root();
        let file = root.join("f.txt");
        std::fs::write(&file, "l1\nl2\nl3\nl4\n").unwrap();
        let params = serde_json::json!({"path": "f.txt", "line": 2, "limit": 2});
        let (value, artifact) = handle(&root, "fs/read_text_file", &params).unwrap();
        assert_eq!(value["content"], "l2\nl3\n");
        assert!(artifact.is_none());
    }

    #[test]
    fn write_emits_file_diff_artifact() {
        let root = root();
        let file = root.join("w.txt");
        std::fs::write(&file, "old\n").unwrap();
        let params = serde_json::json!({"path": "w.txt", "content": "new\n"});
        let (response, artifact) = handle(&root, "fs/write_text_file", &params).unwrap();
        assert_eq!(response, serde_json::json!({}));
        let artifact = artifact.expect("write produces an artifact");
        assert_eq!(artifact["type"], "fileDiff");
        assert_eq!(artifact["oldSize"], 4);
        assert_eq!(artifact["newSize"], 4);
        let diff = artifact["diff"].as_str().unwrap();
        assert!(diff.contains("-old"), "diff should drop old: {diff}");
        assert!(diff.contains("+new"), "diff should add new: {diff}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new\n");
    }

    #[test]
    fn write_creates_missing_parents_inside_workspace() {
        let root = root();
        let params = serde_json::json!({"path": "deep/nested/f.txt", "content": "x"});
        let (_, artifact) = handle(&root, "fs/write_text_file", &params).unwrap();
        assert!(artifact.is_some());
        assert_eq!(
            std::fs::read_to_string(root.join("deep/nested/f.txt")).unwrap(),
            "x"
        );
    }
}
