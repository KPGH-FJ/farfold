//! Current product directory scope, selected by the user on 2026-10-02.
//! Compatibility still comes from initialize; existing user data is retained.

const INCLUDED: &[&str] = &[
    "amp-acp",
    "antigravity-acp",
    "auggie",
    "autohand",
    "claude-acp",
    "cline",
    "codebuddy-code",
    "codex-acp",
    "corust-agent",
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
    "junie",
    "kilo",
    "kimchi",
    "kimi",
    "minimax-code",
    "mistral-vibe",
    "nova",
    "opencode",
    "pi-acp",
    "poolside",
    "qoder",
    "qwen-code",
    "sigit",
    "stakpak",
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
    fn current_directory_has_33_unique_reviewed_identities() {
        assert_eq!(INCLUDED.len(), 33);
        let mut reviewed = HashSet::new();
        for id in INCLUDED {
            assert!(reviewed.insert(*id));
            assert!(first_batch_visible(id));
        }
        assert_eq!(reviewed.len(), 33);
        assert!(!first_batch_visible("future-agent"));
        assert!(!first_batch_visible("Auggie"));
        assert!(!first_batch_visible("registry:auggie"));
        assert!(first_batch_visible("auggie"));
        assert!(first_batch_visible("fast-agent"));
    }
}
