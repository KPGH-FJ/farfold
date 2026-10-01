//! Reviewed first-release discovery scope. This is presentation policy, not
//! protocol compatibility, installation eligibility or permission to remove data.
//! Reviewed 2026-10-02 against the 41-ID snapshot and later installed evidence.

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

// (official registry ID, finite review reason, repository evidence).
// Deferred entries remain installed/manageable; this does not label them unsupported.
const DEFERRED: &[(&str, &str, &str)] = &[
    (
        "agoragentic-acp",
        "model_read_failed_no_delivered_preparation",
        "docs/evidence/2026-10-01-agent-access-directory-batch2/README.md",
    ),
    (
        "cortex-code",
        "connection_preparation_not_delivered",
        "docs/evidence/2026-10-01-agent-access-directory-batch5/README.md",
    ),
    (
        "crow-cli",
        "unverified_auth_target_and_model_read_failed",
        "docs/evidence/2026-10-01-agent-auth-route-diagnostics/installed.md",
    ),
    (
        "deepagents",
        "environment_key_delivery_not_provided",
        "docs/evidence/2026-10-01-agent-auth-declarations/installed.md",
    ),
    (
        "glm-acp-agent",
        "environment_key_delivery_not_provided",
        "docs/agent-first-release.md",
    ),
    (
        "harn",
        "model_read_failed_after_anonymous_auth",
        "docs/evidence/2026-10-01-agent-access-directory-batch6/README.md",
    ),
    (
        "minion-code",
        "installation_check_ended",
        "docs/evidence/2026-10-01-agent-startup-diagnostics/installed.md",
    ),
    (
        "vtcode",
        "request_and_history_failed_no_delivered_preparation",
        "docs/evidence/2026-10-01-protocol-error-classification/installed.md",
    ),
];

/// Unknown new registry identities wait for review; names, versions and local
/// commands never admit a directory entry. Existing/custom/local programs are
/// retained separately by the catalog and view model.
pub(crate) fn first_batch_visible(registry_id: &str) -> bool {
    !DEFERRED.iter().any(|(id, _, _)| *id == registry_id) && INCLUDED.contains(&registry_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn first_release_has_33_included_and_8_deferred_unique_reviewed_identities() {
        assert_eq!(INCLUDED.len(), 33);
        assert_eq!(DEFERRED.len(), 8);
        let mut reviewed = HashSet::new();
        for id in INCLUDED {
            assert!(reviewed.insert(*id));
            assert!(first_batch_visible(id));
        }
        for (id, reason, evidence) in DEFERRED {
            assert!(reviewed.insert(*id));
            assert!(!first_batch_visible(id));
            assert!(!reason.is_empty() && evidence.starts_with("docs/"));
        }
        assert_eq!(reviewed.len(), 41);
        assert!(!first_batch_visible("future-agent"));
        assert!(!first_batch_visible("Auggie"));
        assert!(!first_batch_visible("registry:auggie"));
        assert!(first_batch_visible("auggie"));
        assert!(first_batch_visible("fast-agent"));
    }
}
