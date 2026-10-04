//! Narrow rollout eligibility for the reviewed official Codex ACP launch.
//! This is catalog/launch provenance, not cryptographic process authentication.
//! An unrecognized launch is unreviewed; it is not a claim of no MCP support.
use crate::meta_store::AgentRow;
use std::path::Path;

pub(crate) fn eligible(agent: &AgentRow) -> bool {
    // The install path assigns this source after preparing the registry entry;
    // user-added commands have source="custom". Do not accept self-chosen names
    // or an Agent's self-reported handshake as sufficient provenance.
    agent.source == "registry"
        && matches!(agent.id.as_str(), "codex" | "registry:codex-acp")
        && Path::new(&agent.command).is_absolute()
        && Path::new(&agent.command)
            .file_name()
            .and_then(|name| name.to_str())
            == Some("codex-acp")
        && agent.args.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> AgentRow {
        AgentRow {
            id: "codex".into(),
            name: "Codex".into(),
            source: "registry".into(),
            command: "/controlled/registry/codex-acp".into(),
            args: vec![],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn reviewed_registry_binary_accepts_catalog_and_registry_ids_without_version_pin() {
        let mut row = fixture();
        assert!(eligible(&row));
        row.id = "registry:codex-acp".into();
        row.version = Some("a-later-version-is-not-a-pin-failure".into());
        assert!(eligible(&row));
    }

    #[test]
    fn custom_or_discovered_same_name_is_not_reviewed() {
        let mut row = fixture();
        for source in ["custom", "discovered", ""] {
            row.source = source.into();
            assert!(!eligible(&row));
        }
    }

    #[test]
    fn relative_commands_wrappers_and_extra_args_are_not_reviewed() {
        let mut row = fixture();
        for command in [
            "codex-acp",
            "/controlled/codex",
            "/controlled/node",
            "/bin/sh",
        ] {
            row.command = command.into();
            assert!(!eligible(&row));
        }
        row = fixture();
        row.args.push("--unknown-wrapper-mode".into());
        assert!(!eligible(&row));
    }

    #[test]
    fn unknown_catalog_id_does_not_gain_access_from_binary_name() {
        let mut row = fixture();
        row.id = "self-named-codex".into();
        assert!(!eligible(&row));
    }
}
