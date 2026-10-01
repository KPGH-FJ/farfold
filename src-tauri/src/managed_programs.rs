//! Deterministic directories for new companion installations. This is a path
//! encoding, not a second installation inventory or ownership grant.
use std::path::{Path, PathBuf};

pub(crate) fn parent(data: &Path, agent_id: &str) -> PathBuf {
    let mut name = String::from("agent-");
    for byte in agent_id.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_".contains(&byte) {
            name.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(name, "%{byte:02X}").expect("writing to String cannot fail");
        }
    }
    data.join("companion-programs").join(name)
}

pub(crate) fn existing_parent(data: &Path, agent_id: &str) -> Option<PathBuf> {
    let data = data.canonicalize().ok()?;
    let expected = parent(&data, agent_id);
    let mut path = data.clone();
    for part in expected.strip_prefix(&data).ok()?.components() {
        path.push(part);
        let metadata = std::fs::symlink_metadata(&path).ok()?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return None;
        }
    }
    (path.canonicalize().ok()? == expected).then_some(expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_encoding_is_distinct_and_never_adds_a_path_separator() {
        let data = Path::new("/data");
        let ids = [
            "registry:autohand",
            "registry%3Aautohand",
            "../outside",
            ".",
            "",
            "中文",
            "a/b",
            "a:b",
            "a b",
        ];
        let paths: std::collections::HashSet<_> = ids.iter().map(|id| parent(data, id)).collect();
        assert_eq!(paths.len(), ids.len());
        for path in paths {
            assert_eq!(
                path.parent(),
                Some(data.join("companion-programs").as_path())
            );
            assert!(!path.to_str().unwrap().contains([':', ' ', '\n', '\r']));
        }
        assert_eq!(
            parent(data, "registry:autohand"),
            data.join("companion-programs/agent-registry%3Aautohand")
        );
    }
}
