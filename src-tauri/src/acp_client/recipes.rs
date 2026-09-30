//! Verified, data-only preparation declarations. No Agent execution or service mutation.
//! Each supplement is scoped to its official registration and npm launch shape.
use std::path::Path;

use crate::meta_store::AgentRow;

#[derive(Clone, Copy)]
pub(crate) struct InstallationParameterDeclaration {
    pub id: &'static str,
    pub registry_id: &'static str,
    pub version: &'static str,
    pub package: &'static str,
    pub launch_args: &'static [&'static str],
    pub field_id: &'static str,
    pub argument: &'static str,
    pub label: &'static str,
    pub model_env: &'static str,
    pub source_url: &'static str,
}

const INSTALLATION_PARAMETERS: &[InstallationParameterDeclaration] =
    &[InstallationParameterDeclaration {
        id: "fast-agent-startup-model-0.10.1",
        registry_id: "fast-agent",
        version: "0.10.1",
        package: "fast-agent-acp",
        launch_args: &["-x"],
        field_id: "model",
        argument: "--model",
        label: "启动模型",
        model_env: "FAST_AGENT_MODEL",
        // Cached official fast-agent-mcp 0.10.1 source was checked 2026-09-30:
        // cli/commands/acp.py accepts CommonAgentOptions.model(); the coverage
        // is optional and never replaces initialize or existing HOME/config.
        source_url: "https://fast-agent.ai/acp/",
    }];

pub(crate) fn installation_parameter_declaration(
    entry: &crate::agent_catalog::RegistryAgent,
    launch: &crate::agent_catalog::AgentLaunch,
) -> Option<&'static InstallationParameterDeclaration> {
    let crate::agent_catalog::AgentLaunch::Uvx {
        package: requirement,
        args,
    } = launch
    else {
        return None;
    };
    let package = crate::agent_catalog::UvxPackage::parse(requirement).ok()?;
    let uvx = crate::agent_catalog::RegistryUvx::decode(entry.distribution.uvx.as_ref()?)?;
    if !uvx.other.is_empty() {
        return None;
    }
    INSTALLATION_PARAMETERS.iter().find(|declaration| {
        entry.id == declaration.registry_id
            && entry.version == declaration.version
            && package.name == declaration.package
            && package.version == declaration.version
            && args
                .iter()
                .map(String::as_str)
                .eq(declaration.launch_args.iter().copied())
            && uvx.package == *requirement
            && uvx.args == *args
    })
}

pub(crate) fn previous_installation_parameter_declaration(
    row: &AgentRow,
) -> Option<&'static InstallationParameterDeclaration> {
    INSTALLATION_PARAMETERS.iter().find(|declaration| {
        row.id == format!("registry:{}", declaration.registry_id)
            && row.source == "registry"
            && row.version.as_deref() == Some(declaration.version)
            && Path::new(&row.command).is_absolute()
            && Path::new(&row.command)
                .file_name()
                .and_then(|value| value.to_str())
                == Some(declaration.package)
    })
}

#[derive(Clone, Copy)]
pub(crate) struct TerminalActionDeclaration {
    pub id: &'static str,
    pub purpose: &'static str,
    pub agent_id: &'static str,
    pub version: &'static str,
    pub binary: &'static str,
    pub launch_args: &'static [&'static str],
    pub action_args: &'static [&'static str],
    pub source_url: &'static str,
}

const TERMINAL_ACTIONS: &[TerminalActionDeclaration] = &[TerminalActionDeclaration {
    id: "configure-model-service",
    purpose: "service_configuration",
    agent_id: "registry:goose",
    version: "1.52.0",
    binary: "goose",
    launch_args: &["acp"],
    action_args: &["configure"],
    // Fixed official configure source checked 2026-09-30. This version scopes
    // only this supplement; it is never a connection or installation gate.
    source_url: "https://github.com/block/goose/blob/v1.52.0/crates/goose-cli/src/commands/configure.rs",
}];

pub(crate) fn terminal_action_declaration(
    row: &AgentRow,
) -> Option<&'static TerminalActionDeclaration> {
    TERMINAL_ACTIONS.iter().find(|declaration| {
        row.id == declaration.agent_id
            && row.source == "registry"
            && row.version.as_deref() == Some(declaration.version)
            && Path::new(&row.command).is_absolute()
            && Path::new(&row.command)
                .file_name()
                .and_then(|name| name.to_str())
                == Some(declaration.binary)
            && row
                .args
                .iter()
                .map(String::as_str)
                .eq(declaration.launch_args.iter().copied())
            && row.env.is_empty()
    })
}

#[derive(Clone, Copy)]
pub(crate) enum DependencyDistribution {
    Gzip {
        version_url: &'static str,
        download_base: &'static str,
        platform: &'static str,
    },
    Npm {
        package: &'static str,
        bin: &'static str,
    },
}

#[derive(Clone, Copy)]
pub(crate) struct SupportRequirement {
    pub component_version: &'static str,
    pub range: &'static str,
    pub source_url: &'static str,
}

#[derive(Clone, Copy)]
pub(crate) struct DependencyDeclaration {
    pub id: &'static str,
    pub name: &'static str,
    pub binary: &'static str,
    pub program_env: &'static str,
    pub home_bin_dir: &'static str,
    pub source_url: &'static str,
    pub distribution: DependencyDistribution,
    pub support: Option<SupportRequirement>,
}

pub(crate) struct Recipe {
    agent_ids: &'static [&'static str],
    component_package: &'static str,
    component_binary: Option<&'static str>,
    pub dependencies: &'static [DependencyDeclaration],
}

pub(crate) const AMP_DEPENDENCIES: &[DependencyDeclaration] = &[DependencyDeclaration {
    id: "amp-cli",
    name: "Amp CLI",
    binary: "amp",
    program_env: "AMP_CLI_PATH",
    home_bin_dir: ".amp/bin",
    // Official install.sh and CLI docs checked 2026-09-26; migration only.
    source_url: "https://ampcode.com/docs/cli",
    distribution: DependencyDistribution::Gzip {
        version_url: "https://static.ampcode.com/cli/cli-version.txt",
        download_base: "https://static.ampcode.com/cli",
        platform: "darwin-arm64",
    },
    support: None,
}];

const PI_DEPENDENCIES: &[DependencyDeclaration] = &[DependencyDeclaration {
    id: "pi-cli",
    name: "Pi",
    binary: "pi",
    program_env: "PI_ACP_PI_COMMAND",
    home_bin_dir: ".local/bin",
    source_url: "https://raw.githubusercontent.com/svkozak/pi-acp/v0.0.34/README.md",
    distribution: DependencyDistribution::Npm {
        package: "@earendil-works/pi-coding-agent",
        bin: "pi",
    },
    support: Some(SupportRequirement {
        component_version: "0.0.34",
        range: ">=0.81.0",
        source_url: "https://raw.githubusercontent.com/svkozak/pi-acp/v0.0.34/README.md",
    }),
}];

const RECIPES: &[Recipe] = &[
    Recipe {
        agent_ids: &["registry:amp-acp"],
        component_package: "amp-acp",
        // Registry also distributes the official amp-acp binary with no args.
        component_binary: Some("amp-acp"),
        dependencies: AMP_DEPENDENCIES,
    },
    Recipe {
        agent_ids: &["pi", "registry:pi-acp"],
        component_package: "pi-acp",
        component_binary: None,
        dependencies: PI_DEPENDENCIES,
    },
];

pub(crate) fn recipe(agent_id: &str) -> Option<&'static Recipe> {
    RECIPES
        .iter()
        .find(|recipe| recipe.agent_ids.contains(&agent_id))
}

pub(crate) fn dependencies(agent_id: &str) -> &'static [DependencyDeclaration] {
    recipe(agent_id).map_or(&[], |recipe| recipe.dependencies)
}

/// Inspect only the public npm manifest associated with an explicitly registered
/// launch. Same ID/custom commands and unrelated arguments do not gain supplements.
fn registered_version(row: &AgentRow) -> Option<Option<String>> {
    let recipe = recipe(&row.id)?;
    if row.source != "registry" || !Path::new(&row.command).is_absolute() {
        return None;
    }
    let binary = Path::new(&row.command).file_name()?.to_str()?;
    if recipe.component_binary == Some(binary) && row.args.is_empty() {
        return Some(row.version.clone());
    }
    if binary != "node" || row.args.len() != 1 {
        return None;
    }
    let entry = Path::new(&row.args[0]);
    if !entry.is_absolute() {
        return None;
    }
    let package_dir = entry.ancestors().find(|path| {
        path.file_name()
            .is_some_and(|name| name == recipe.component_package)
            && path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "node_modules")
    })?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package_dir.join("package.json")).ok()?).ok()?;
    if manifest["name"].as_str()? != recipe.component_package {
        return None;
    }
    let canonical_entry = entry.canonicalize().ok()?;
    let canonical_package = package_dir.canonicalize().ok()?;
    if !canonical_entry.starts_with(&canonical_package) {
        return None;
    }
    let is_bin =
        |bin: &str| package_dir.join(bin).canonicalize().ok().as_ref() == Some(&canonical_entry);
    let matches = match &manifest["bin"] {
        serde_json::Value::String(bin) => is_bin(bin),
        serde_json::Value::Object(bins) => {
            bins.values().any(|bin| bin.as_str().is_some_and(is_bin))
        }
        _ => false,
    };
    matches.then(|| manifest["version"].as_str().map(str::to_owned))
}

pub(crate) fn component_version(row: &AgentRow) -> Option<String> {
    registered_version(row).flatten()
}

pub(crate) fn declared_for(row: &AgentRow) -> &'static [DependencyDeclaration] {
    if registered_version(row).is_some() {
        dependencies(&row.id)
    } else {
        &[]
    }
}

/// Diagnostic-only data for an unverified component release cannot add a launch
/// environment supplement or a new required-use guard.
pub(crate) fn verified_for(row: &AgentRow) -> &'static [DependencyDeclaration] {
    let declarations = declared_for(row);
    let version = component_version(row);
    if declarations.iter().any(|declaration| {
        declaration.support.is_some() && support_for(declaration, row, version.as_deref()).is_none()
    }) {
        &[]
    } else {
        declarations
    }
}

pub(crate) fn support_for(
    declaration: &DependencyDeclaration,
    row: &AgentRow,
    component_version: Option<&str>,
) -> Option<SupportRequirement> {
    let support = declaration.support?;
    (component_version == Some(support.component_version)
        && row
            .version
            .as_deref()
            .is_none_or(|version| version == support.component_version))
    .then_some(support)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn official_row(root: &Path, id: &str, package: &str, version: &str) -> AgentRow {
        let directory = root.join("node_modules").join(package);
        let entry = directory.join("dist/index.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "// official launch fixture").unwrap();
        std::fs::write(
            directory.join("package.json"),
            serde_json::to_vec(&serde_json::json!({
                "name":package,"version":version,"bin":{"component":"dist/index.js"}
            }))
            .unwrap(),
        )
        .unwrap();
        AgentRow {
            id: id.into(),
            name: id.into(),
            source: "registry".into(),
            command: "/fixture/node".into(),
            args: vec![entry.display().to_string()],
            env: vec![],
            version: Some(version.into()),
            handshake: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn recipe_requires_registered_official_launch_and_versions_stay_scoped() {
        let root = tempfile::tempdir().unwrap();
        let mut row = official_row(root.path(), "pi", "pi-acp", "0.0.34");
        assert_eq!(component_version(&row).as_deref(), Some("0.0.34"));
        let declaration = &declared_for(&row)[0];
        assert!(support_for(declaration, &row, Some("0.0.34")).is_some());
        row.version = Some("0.0.35".into());
        assert!(support_for(declaration, &row, Some("0.0.34")).is_none());
        row.source = "custom".into();
        assert!(declared_for(&row).is_empty());
        row.source = "registry".into();
        row.args.push("--unverified".into());
        assert!(declared_for(&row).is_empty());
        assert!(dependencies("custom-other").is_empty());
    }

    #[test]
    fn migrated_amp_dependency_preserves_the_registry_native_binary_shape() {
        let root = tempfile::tempdir().unwrap();
        let mut row = official_row(root.path(), "registry:amp-acp", "amp-acp", "0.9.0");
        row.command = "/managed/amp-acp".into();
        row.args.clear();
        assert_eq!(declared_for(&row)[0].id, "amp-cli");
        row.version = None;
        assert!(component_version(&row).is_none());
        assert_eq!(verified_for(&row)[0].id, "amp-cli");
        row.args.push("unverified".into());
        assert!(declared_for(&row).is_empty());
        row.args.clear();
        row.source = "custom".into();
        assert!(declared_for(&row).is_empty());
    }
}
