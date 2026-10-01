//! Deterministic directories for new companion installations. This is a path
//! encoding, not a second installation inventory or ownership grant.
use std::path::{Path, PathBuf};

pub(crate) fn parent(data: &Path, agent_id: &str) -> PathBuf {
    crate::managed_paths::parent(data, agent_id, crate::managed_paths::Layout::Companion)
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
