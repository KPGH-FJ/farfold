//! Verified, data-only preparation declarations. No Agent execution or service mutation.
//! Each supplement is scoped to its official registration and npm launch shape.
use std::path::Path;

use crate::meta_store::AgentRow;

/// Reviewed official Goose ACP launch shape, shared by read-only supplements.
/// No program authentication, version gate, configuration read or process probe.
pub(crate) fn goose_acp(agent: &AgentRow) -> bool {
    let command = Path::new(&agent.command);
    agent.source == "registry"
        && agent.id == "registry:goose"
        && agent.args == ["acp"]
        && command.is_absolute()
        && command
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s == "goose" || (cfg!(windows) && s.eq_ignore_ascii_case("goose.exe")))
}

/// Official @github/copilot 1.0.89 loader forwards argv to this platform export.
/// Supplement scope only, never an Agent installation/connection version gate.
/// Source: https://github.com/github/copilot-cli/releases/tag/v1.0.89 and the
/// same-version published package.json/npm-loader.js; login is documented at
/// https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
pub(crate) struct PackageLoginDeclaration {
    pub registry_id: &'static str,
    pub version: &'static str,
    pub package: &'static str,
    pub platform_package: &'static str,
    pub loader: &'static str,
    pub platform_entry: &'static str,
    pub method: &'static str,
}

pub(crate) const COPILOT_LOGIN: PackageLoginDeclaration = PackageLoginDeclaration {
    registry_id: "registry:github-copilot-cli",
    version: "1.0.89",
    package: "@github/copilot",
    platform_package: if cfg!(windows) {
        if cfg!(target_arch = "aarch64") {
            "@github/copilot-win32-arm64"
        } else {
            "@github/copilot-win32-x64"
        }
    } else {
        "@github/copilot-darwin-arm64"
    },
    loader: "npm-loader.js",
    platform_entry: if cfg!(windows) {
        "copilot.exe"
    } else {
        "copilot"
    },
    method: "copilot-login",
};

/// Fixed official Kilo 7.8.1 service.ts emits the wrong old command;
/// cli-reference documents `kilo auth login`. The caller also requires the
/// current managed ZIP receipt. No program admission/version pin is added.
/// Sources: Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/acp/service.ts;
/// https://kilo.ai/docs/code-with-ai/platforms/cli-reference#kilo-auth-login
pub(crate) fn kilo_legacy_login(
    row: &AgentRow,
    method: &serde_json::Value,
    command: &str,
    args: &[String],
) -> bool {
    row.id == "registry:kilo"
        && row.source == "registry"
        && row.version.as_deref() == Some("7.8.1")
        && row.args == ["acp"]
        && Path::new(&row.command)
            .file_name()
            .is_some_and(|name| name == "kilo")
        && method.get("id").and_then(serde_json::Value::as_str) == Some("kilo-login")
        && method.get("type").is_none()
        && command == "opencode"
        && args == ["auth", "login"]
}

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

fn installation_parameter_program_matches(name: &str, package: &str, windows: bool) -> bool {
    if windows {
        name.eq_ignore_ascii_case(package) || name.eq_ignore_ascii_case(&format!("{package}.exe"))
    } else {
        name == package
    }
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
                .is_some_and(|name| {
                    installation_parameter_program_matches(name, declaration.package, cfg!(windows))
                })
    })
}

#[derive(Clone, Copy)]
pub(crate) enum TerminalActionLaunch {
    Native {
        binary: &'static str,
    },
    Npm {
        package: &'static str,
        bin: &'static str,
        manifest_entry: &'static str,
        loader: &'static str,
    },
}

#[derive(Clone, Copy)]
pub(crate) struct TerminalActionDeclaration {
    pub id: &'static str,
    pub purpose: &'static str,
    pub agent_id: &'static str,
    pub version: &'static str,
    pub launch: TerminalActionLaunch,
    pub launch_args: &'static [&'static str],
    pub action_args: &'static [&'static str],
    pub source_url: &'static str,
}

const TERMINAL_ACTIONS: &[TerminalActionDeclaration] = &[
    TerminalActionDeclaration {
        id: "configure-model-service",
        purpose: "service_configuration",
        agent_id: "registry:goose",
        version: "1.52.0",
        launch: TerminalActionLaunch::Native { binary: "goose" },
        launch_args: &["acp"],
        action_args: &["configure"],
        // Fixed official configure source checked 2026-09-30. This version scopes
        // only this supplement; it is never a connection or installation gate.
        source_url: "https://github.com/block/goose/blob/v1.52.0/crates/goose-cli/src/commands/configure.rs",
    },
    TerminalActionDeclaration {
        id: "configure-model-service",
        purpose: "service_configuration",
        agent_id: "registry:cline",
        version: "3.0.65",
        launch: TerminalActionLaunch::Npm {
            package: "cline",
            bin: "cline",
            manifest_entry: "./bin/cline",
            loader: "bin/cline",
        },
        launch_args: &["--acp"],
        action_args: &["auth"],
        // Published cline 3.0.65 README documents this interactive setup; its
        // CLI and protocol route share ProviderSettingsManager. The repository
        // URL is a source pointer, not a claim about the current main version or
        // support for arbitrary providers through the protocol.
        source_url: "https://github.com/cline/cline/tree/main/apps/cli",
    },
];

pub(crate) fn terminal_action_declaration(
    row: &AgentRow,
) -> Option<&'static TerminalActionDeclaration> {
    TERMINAL_ACTIONS.iter().find(|declaration| {
        row.id == declaration.agent_id
            && row.source == "registry"
            && row.version.as_deref() == Some(declaration.version)
            && Path::new(&row.command).is_absolute()
            && row.env.is_empty()
            && match declaration.launch {
                TerminalActionLaunch::Native { binary } => {
                    crate::process_platform::program_name(Path::new(&row.command)).as_deref()
                        == Some(binary)
                        && row
                            .args
                            .iter()
                            .map(String::as_str)
                            .eq(declaration.launch_args.iter().copied())
                }
                TerminalActionLaunch::Npm { .. } => {
                    crate::process_platform::program_name(Path::new(&row.command)).as_deref()
                        == Some("node")
                        && row.args.len() == declaration.launch_args.len() + 1
                        && Path::new(&row.args[0]).is_absolute()
                        && row.args[1..]
                            .iter()
                            .map(String::as_str)
                            .eq(declaration.launch_args.iter().copied())
                }
            }
    })
}

#[derive(Clone, Copy)]
pub(crate) enum DependencyDistribution {
    Executable {
        version_url: &'static str,
        download_base: &'static str,
        platform: &'static str,
    },
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
pub(crate) enum DependencyCommandDelivery {
    AbsolutePath,
    SearchPath,
}

#[derive(Clone, Copy)]
pub(crate) struct DependencyDeclaration {
    pub id: &'static str,
    pub name: &'static str,
    pub binary: &'static str,
    pub program_env: &'static str,
    pub command_delivery: DependencyCommandDelivery,
    pub reject_cwd_name_collision: bool,
    pub home_bin_dir: Option<&'static str>,
    pub source_url: &'static str,
    pub distribution: DependencyDistribution,
    pub support: Option<SupportRequirement>,
}

pub(crate) struct Recipe {
    agent_ids: &'static [&'static str],
    component_package: &'static str,
    component_binary: Option<&'static str>,
    component_bin: Option<&'static str>,
    verified_component_version: Option<&'static str>,
    pub dependencies: &'static [DependencyDeclaration],
}

pub(crate) const AMP_DEPENDENCIES: &[DependencyDeclaration] = &[DependencyDeclaration {
    id: "amp-cli",
    name: "Amp CLI",
    binary: "amp",
    program_env: "AMP_CLI_PATH",
    command_delivery: DependencyCommandDelivery::AbsolutePath,
    reject_cwd_name_collision: false,
    home_bin_dir: Some(".amp/bin"),
    // Official install.sh and CLI docs checked 2026-09-26; migration only.
    source_url: "https://ampcode.com/docs/cli",
    // Official https://ampcode.com/install.ps1 (2026-10-06) declares this
    // native x64 executable, also used on ARM64 via Windows emulation.
    distribution: if cfg!(windows) {
        DependencyDistribution::Executable {
            version_url: "https://static.ampcode.com/cli/cli-version.txt",
            download_base: "https://static.ampcode.com/cli",
            platform: "windows-x64",
        }
    } else {
        DependencyDistribution::Gzip {
            version_url: "https://static.ampcode.com/cli/cli-version.txt",
            download_base: "https://static.ampcode.com/cli",
            platform: "darwin-arm64",
        }
    },
    support: None,
}];

const PI_DEPENDENCIES: &[DependencyDeclaration] = &[DependencyDeclaration {
    id: "pi-cli",
    name: "Pi",
    binary: "pi",
    program_env: "PI_ACP_PI_COMMAND",
    command_delivery: DependencyCommandDelivery::AbsolutePath,
    reject_cwd_name_collision: false,
    home_bin_dir: Some(".local/bin"),
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

const AUTOHAND_DEPENDENCIES: &[DependencyDeclaration] = &[DependencyDeclaration {
    id: "autohand-cli",
    name: "Autohand CLI",
    binary: "autohand",
    program_env: "AUTOHAND_CMD",
    command_delivery: DependencyCommandDelivery::SearchPath,
    // v0.2.1 treats an existing AUTOHAND_CMD path relative to cwd as a stub
    // and skips account checks. A PATH command must never trigger that branch.
    reject_cwd_name_collision: true,
    home_bin_dir: None,
    // Fixed component v0.2.1 documents AUTOHAND_CMD as a path or command.
    // Its raw-spawn checks/resume and tokenized prompt all accept a command
    // name. No overall CLI minimum is inferred from the callback-only v0.6+.
    source_url: "https://raw.githubusercontent.com/autohandai/autohand-acp/v0.2.1/README.md",
    distribution: DependencyDistribution::Npm {
        package: "autohand-cli",
        bin: "autohand",
    },
    support: None,
}];

const RECIPES: &[Recipe] = &[
    Recipe {
        agent_ids: &["registry:amp-acp"],
        component_package: "amp-acp",
        // Registry also distributes the official amp-acp binary with no args.
        component_binary: Some("amp-acp"),
        component_bin: None,
        verified_component_version: None,
        dependencies: AMP_DEPENDENCIES,
    },
    Recipe {
        agent_ids: &["pi", "registry:pi-acp"],
        component_package: "pi-acp",
        component_binary: None,
        component_bin: None,
        verified_component_version: None,
        dependencies: PI_DEPENDENCIES,
    },
    Recipe {
        agent_ids: &["registry:autohand"],
        component_package: "@autohandai/autohand-acp",
        component_binary: None,
        component_bin: Some("autohand-acp"),
        verified_component_version: Some("0.2.1"),
        dependencies: AUTOHAND_DEPENDENCIES,
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
    let binary = crate::process_platform::program_name(Path::new(&row.command))?;
    if recipe.component_binary == Some(binary.as_str()) && row.args.is_empty() {
        return Some(row.version.clone());
    }
    if binary != "node" || row.args.len() != 1 {
        return None;
    }
    let entry = Path::new(&row.args[0]);
    if !entry.is_absolute() {
        return None;
    }
    let package = Path::new(recipe.component_package);
    let suffix = Path::new("node_modules").join(package);
    let package_dir = entry.ancestors().find(|path| path.ends_with(&suffix))?;
    let modules = package_dir.ancestors().nth(package.components().count())?;
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package_dir.join("package.json")).ok()?).ok()?;
    if manifest["name"].as_str()? != recipe.component_package {
        return None;
    }
    let canonical_entry = entry.canonicalize().ok()?;
    let canonical_package = package_dir.canonicalize().ok()?;
    let canonical_modules = modules.canonicalize().ok()?;
    if !canonical_package.starts_with(&canonical_modules)
        || !canonical_entry.starts_with(&canonical_package)
    {
        return None;
    }
    let is_bin = |bin: &str| {
        let path = Path::new(bin);
        !path.is_absolute()
            && path.components().all(|component| {
                matches!(
                    component,
                    std::path::Component::Normal(_) | std::path::Component::CurDir
                )
            })
            && package_dir.join(path).canonicalize().ok().as_ref() == Some(&canonical_entry)
    };
    let matches = match (&manifest["bin"], recipe.component_bin) {
        (serde_json::Value::String(bin), None) => is_bin(bin),
        (serde_json::Value::Object(bins), Some(name)) => bins
            .get(name)
            .and_then(serde_json::Value::as_str)
            .is_some_and(is_bin),
        (serde_json::Value::Object(bins), None) => {
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
    if recipe(&row.id).is_some_and(|recipe| {
        recipe.verified_component_version.is_some_and(|expected| {
            version.as_deref() != Some(expected) || row.version.as_deref() != Some(expected)
        })
    }) || row
        .version
        .as_ref()
        .zip(version.as_ref())
        .is_some_and(|(selected, actual)| selected != actual)
        || declarations.iter().any(|declaration| {
            declaration.support.is_some()
                && support_for(declaration, row, version.as_deref()).is_none()
        })
    {
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
mod companion_recipe_tests;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn installation_parameter_program_accepts_windows_console_exe() {
        assert!(installation_parameter_program_matches(
            "fast-agent-acp.exe",
            "fast-agent-acp",
            true,
        ));
    }

    #[test]
    fn installation_parameter_program_accepts_windows_name_case() {
        for name in ["FAST-AGENT-ACP", "Fast-Agent-Acp.EXE"] {
            assert!(installation_parameter_program_matches(
                name,
                "fast-agent-acp",
                true,
            ));
        }
    }

    #[test]
    fn installation_parameter_program_rejects_unreviewed_suffixes_and_names() {
        for name in [
            "fast-agent-acp.cmd",
            "fast-agent-acp.bat",
            "fast-agent-acp.com",
            "fast-agent-acp.exe.exe",
            "other-fast-agent-acp.exe",
            "fast-agent-acp-other.exe",
            "fast-agent-acp.exe ",
        ] {
            assert!(!installation_parameter_program_matches(
                name,
                "fast-agent-acp",
                true,
            ));
        }
    }

    #[test]
    fn installation_parameter_program_keeps_unix_exact_name() {
        assert!(installation_parameter_program_matches(
            "fast-agent-acp",
            "fast-agent-acp",
            false,
        ));
        for name in ["FAST-AGENT-ACP", "fast-agent-acp.exe"] {
            assert!(!installation_parameter_program_matches(
                name,
                "fast-agent-acp",
                false,
            ));
        }
    }

    pub(crate) fn official_row(root: &Path, id: &str, package: &str, version: &str) -> AgentRow {
        let directory = root.join("node_modules").join(package);
        let entry = directory.join("dist/index.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "// official launch fixture").unwrap();
        std::fs::write(
            directory.join("package.json"),
            serde_json::to_vec(&serde_json::json!({
                "name":package,"version":version,"bin":{package.rsplit('/').next().unwrap():"dist/index.js"}
            }))
            .unwrap(),
        )
        .unwrap();
        AgentRow {
            id: id.into(),
            name: id.into(),
            source: "registry".into(),
            command: if cfg!(windows) {
                r"C:\fixture\node.exe"
            } else {
                "/fixture/node"
            }
            .into(),
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
        row.command = if cfg!(windows) {
            r"C:\managed\amp-acp.exe"
        } else {
            "/managed/amp-acp"
        }
        .into();
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

/// User-authorized official read-only companion, 2026-11-13. This declaration
/// grants only export of the already-selected history, not an arbitrary sibling.
/// Public console_scripts metadata and the managed installation receipt must
/// independently bind both entries. No version or binary digest admission.
pub(crate) struct HistoryExportDeclaration {
    pub registry_id: &'static str,
    pub acp_entry: &'static str,
    pub companion_entry: &'static str,
    pub distribution: &'static str,
    pub acp_import: &'static str,
    pub companion_import: &'static str,
}
pub(crate) const FAST_HISTORY_EXPORT: HistoryExportDeclaration = HistoryExportDeclaration {
    registry_id: "registry:fast-agent",
    acp_entry: "fast-agent-acp",
    companion_entry: "fast-agent",
    distribution: "fast-agent-mcp",
    acp_import: "fast_agent.cli.commands.acp",
    companion_import: "fast_agent.cli.__main__",
};
