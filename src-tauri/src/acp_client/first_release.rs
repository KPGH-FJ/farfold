//! Current product directory scope, last reviewed on 2026-11-16.
//! Compatibility still comes from initialize; existing user data is retained.

const INCLUDED: &[&str] = &[
    "amp-acp",
    "antigravity-acp",
    "autohand",
    "claude-acp",
    "cline",
    "codebuddy-code",
    "codex-acp",
    "cursor",
    "devin",
    "dimcode",
    "dirac",
    "factory-droid",
    "fast-agent",
    "gemini",
    "github-copilot-cli",
    "goose",
    "grok-build",
    "kilo",
    "kimchi",
    "minimax-code",
    "mistral-vibe",
    "opencode",
    "pi-acp",
    "poolside",
    "qoder",
    "sigit",
];

/// Unknown new registry identities wait for review; names, versions and local
/// commands never admit a directory entry. Existing/custom/local programs are
/// retained separately by the catalog and view model.
pub(crate) fn first_batch_visible(registry_id: &str) -> bool {
    INCLUDED.contains(&registry_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn current_directory_has_26_unique_reviewed_identities() {
        assert_eq!(INCLUDED.len(), 26);
        let mut reviewed = HashSet::new();
        for id in INCLUDED {
            assert!(reviewed.insert(*id));
            assert!(first_batch_visible(id));
        }
        assert_eq!(reviewed.len(), 26);
        assert!(!first_batch_visible("future-agent"));
        assert!(!first_batch_visible("Cline"));
        assert!(!first_batch_visible("registry:cline"));
        assert!(first_batch_visible("cline"));
        assert!(first_batch_visible("fast-agent"));
        assert!(!first_batch_visible("kimi"));
        assert!(!first_batch_visible("kimi-code"));
        assert!(!first_batch_visible("nova"));
        assert!(!first_batch_visible("qwen-code"));
        assert!(first_batch_visible("qoder"));
    }
}
