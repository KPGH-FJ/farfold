//! Guidance for an identified official program. These records never authorize
//! execution, supply credentials, or change the selected service.
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::{
    AgentRow, Installation, MetaStore, matching_registry_installation, recorded_installations,
};
use crate::agent_discovery::DiscoveredBinary;
use crate::managed_paths::{Layout, recorded_root};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum GuidanceKind {
    OfficialSetup,
    OfficialSignIn,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionGuidance {
    kind: GuidanceKind,
    label: &'static str,
    url: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    method_id: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MethodRole {
    Reuse,
    Credential,
    External,
    Configuration,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MethodKind {
    Agent,
    Terminal,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfficialMethodRole {
    method_id: &'static str,
    role: MethodRole,
    kind: MethodKind,
}

const fn method(method_id: &'static str, role: MethodRole, kind: MethodKind) -> OfficialMethodRole {
    OfficialMethodRole {
        method_id,
        role,
        kind,
    }
}

const fn setup(label: &'static str, url: &'static str) -> ConnectionGuidance {
    ConnectionGuidance {
        kind: GuidanceKind::OfficialSetup,
        label,
        url,
        command: None,
        method_id: None,
    }
}

const fn sign_in(
    label: &'static str,
    url: &'static str,
    command: &'static str,
) -> ConnectionGuidance {
    ConnectionGuidance {
        kind: GuidanceKind::OfficialSignIn,
        label,
        url,
        command: Some(command),
        method_id: None,
    }
}

fn official_guides(id: &str) -> Vec<ConnectionGuidance> {
    match id {
        "registry:amp-acp" => vec![
            sign_in(
                "在 Amp 登录账号",
                "https://ampcode.com/docs/cli#manage-cli-accounts",
                "amp login",
            ),
            setup(
                "在 Amp 配置模型服务",
                "https://ampcode.com/docs/customize/model-routing",
            ),
        ],
        "registry:antigravity-acp" => vec![
            ConnectionGuidance {
                kind: GuidanceKind::OfficialSignIn,
                ..setup(
                    "在 Antigravity 登录个人或企业 Google 账号",
                    "https://antigravity.google/docs/ide/extensions/acp#authentication",
                )
            },
            ConnectionGuidance {
                method_id: Some("gemini-api-key"),
                ..setup(
                    "为 Antigravity 设置 Gemini API 密钥",
                    "https://antigravity.google/docs/ide/extensions/acp#authentication",
                )
            },
            ConnectionGuidance {
                method_id: Some("agent-platform"),
                ..setup(
                    "为 Antigravity 配置企业云项目和凭据",
                    "https://antigravity.google/docs/ide/extensions/acp#authentication",
                )
            },
        ],
        "registry:autohand" => vec![setup(
            "在 Autohand 配置模型服务",
            "https://docs.autohand.ai/working-with-autohand-code/configuration#custom-openai-compatible-providers",
        )],
        "registry:claude-acp" => vec![setup(
            "在 Claude Code 配置模型网关",
            "https://code.claude.com/docs/en/llm-gateway",
        )],
        "registry:cline" => vec![setup(
            "在 Cline CLI 配置模型服务",
            "https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/README.md",
        )],
        "registry:codebuddy-code" => vec![setup(
            "在 CodeBuddy CLI 配置模型服务",
            "https://www.codebuddy.ai/docs/cli/models",
        )],
        "codex" | "registry:codex-acp" => vec![setup(
            "在 Codex CLI 配置模型服务",
            "https://developers.openai.com/codex/config-reference",
        )],
        "registry:cursor" => vec![sign_in(
            "在 Cursor 登录账号",
            "https://cursor.com/docs/cli/reference/authentication",
            "agent login",
        )],
        "registry:devin" => vec![setup(
            "查看 Devin 的官方账号接入方式",
            "https://docs.devin.ai/cli/acp/zed#setup",
        )],
        "registry:dirac" => vec![ConnectionGuidance {
            command: Some("dirac auth"),
            ..setup(
                "在 Dirac 配置模型服务",
                "https://dirac.run/docs/cli#authentication",
            )
        }],
        "registry:fast-agent" => vec![ConnectionGuidance {
            method_id: Some("fast-agent-ai-secrets"),
            ..setup(
                "在 fast-agent 配置模型服务",
                "https://fast-agent.ai/ref/config_file/",
            )
        }],
        "registry:gemini" => vec![
            ConnectionGuidance {
                kind: GuidanceKind::OfficialSignIn,
                ..setup(
                    "使用 Google 账号登录 Gemini CLI",
                    "https://google-gemini.github.io/gemini-cli/docs/get-started/authentication.html#login-with-google",
                )
            },
            ConnectionGuidance {
                method_id: Some("gemini-api-key"),
                ..setup(
                    "在 Gemini CLI 设置 Gemini API 密钥",
                    "https://google-gemini.github.io/gemini-cli/docs/get-started/authentication.html#use-gemini-api-key",
                )
            },
            ConnectionGuidance {
                method_id: Some("vertex-ai"),
                ..setup(
                    "在 Gemini CLI 配置 Vertex AI",
                    "https://google-gemini.github.io/gemini-cli/docs/get-started/authentication.html#use-vertex-ai",
                )
            },
            ConnectionGuidance {
                method_id: Some("gateway"),
                ..setup(
                    "配置 Gemini 或 Vertex 兼容网关",
                    "https://github.com/google-gemini/gemini-cli/blob/v0.62.0/docs/reference/configuration.md#environment-variables",
                )
            },
        ],
        "registry:github-copilot-cli" => vec![setup(
            "在 Copilot CLI 配置自带模型服务",
            "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-llm-models",
        )],
        "registry:goose" => vec![ConnectionGuidance {
            command: Some("goose configure"),
            method_id: Some("goose-provider"),
            ..setup(
                "在 Goose 配置模型服务",
                "https://goose-docs.ai/docs/getting-started/providers/",
            )
        }],
        "registry:grok-build" => vec![setup(
            "在 Grok Build 配置账号或模型服务",
            "https://docs.x.ai/build/overview#run-grok",
        )],
        "registry:kilo" => vec![setup(
            "在 Kilo 配置账号及模型服务",
            "https://kilo.ai/docs/getting-started/setup-authentication",
        )],
        "registry:minimax-code" => vec![setup(
            "在 MiniMax Code 配置自带模型服务",
            "https://github.com/MiniMax-AI/minimax-code#2-sign-in-or-bring-your-own-api-key",
        )],
        "registry:mistral-vibe" => vec![setup(
            "在 Mistral Vibe 配置模型服务",
            "https://docs.mistral.ai/vibe/code/cli/api-keys-profiles",
        )],
        "opencode" | "registry:opencode" => vec![setup(
            "在 OpenCode 配置模型服务",
            "https://opencode.ai/docs/providers",
        )],
        "pi" | "registry:pi-acp" => vec![setup(
            "在 Pi 配置模型服务",
            "https://docs.pi.dev/latest/models",
        )],
        "registry:qoder" => vec![setup(
            "在 Qoder CLI 配置自带模型",
            "https://docs.qoder.com/cli/custom-models",
        )],
        _ => vec![],
    }
}

// These are presentation scopes for verified releases, not requirements on
// which versions a user may install, connect, or authenticate with.
fn proven_methods(row: &AgentRow) -> &'static [OfficialMethodRole] {
    use MethodKind::{Agent, Terminal};
    use MethodRole::{Configuration, Credential, External, Reuse};
    match (row.id.as_str(), row.version.as_deref()) {
        ("registry:amp-acp", Some("0.13.0")) => const { &[method("setup", Credential, Terminal)] },
        ("registry:fast-agent", Some("0.10.1")) => {
            const { &[method("fast-agent-ai-secrets", External, Agent)] }
        }
        ("registry:goose", Some("1.59.1")) => {
            const { &[method("goose-provider", External, Agent)] }
        }
        ("registry:grok-build", Some("1.0.90")) => {
            const { &[method("cached_token", Reuse, Agent)] }
        }
        ("registry:autohand", Some("0.9.11")) => {
            const { &[method("autohand-setup", Configuration, Terminal)] }
        }
        ("registry:mistral-vibe", Some("2.25.8")) => {
            const { &[method("vibe-setup", Configuration, Terminal)] }
        }
        ("registry:gemini", Some("0.62.0")) => {
            const {
                &[
                    method("gemini-api-key", Credential, Agent),
                    method("vertex-ai", Configuration, Agent),
                    method("gateway", External, Agent),
                ]
            }
        }
        ("registry:antigravity-acp", Some("1.2.1")) => {
            const {
                &[
                    method("gemini-api-key", Credential, Agent),
                    method("agent-platform", Configuration, Agent),
                ]
            }
        }
        _ => &[],
    }
}

fn declared_method(row: &AgentRow, expected: &OfficialMethodRole) -> bool {
    let Some(methods) = row
        .handshake
        .as_ref()
        .and_then(|handshake| handshake["authMethods"].as_array())
    else {
        return false;
    };
    let mut matching = methods
        .iter()
        .filter(|method| method["id"] == expected.method_id);
    matching.next().is_some_and(|method| {
        method.get("_farfoldInvalid") != Some(&Value::Bool(true))
            && match (expected.kind, method.get("type")) {
                (MethodKind::Agent, None) => true,
                (MethodKind::Agent, Some(kind)) => kind.as_str() == Some("agent"),
                (MethodKind::Terminal, kind) => kind.and_then(Value::as_str) == Some("terminal"),
            }
    }) && matching.next().is_none()
}

// npm registrations intentionally share Node outside the receipt root. Their
// selected entry file, rather than Node, must belong to that exact root.
fn matching_node_entry(row: &AgentRow, item: &Installation, data: &Path) -> bool {
    if item.agent_id != row.id
        || item.source != "managed"
        || item.program_only
        || item.version != row.version
        || item.command != row.command
        || item.args != row.args
        || crate::process_platform::program_name(Path::new(&row.command)).as_deref() != Some("node")
        || crate::agent_discovery::validate_executable_path(&row.command).is_err()
    {
        return false;
    }
    let Some(root) = item.managed_root.as_deref().map(Path::new) else {
        return false;
    };
    let Some(root) = recorded_root(data, &row.id, root, Layout::Agent, false) else {
        return false;
    };
    row.args.first().map(Path::new).is_some_and(|entry| {
        entry.is_absolute()
            && entry.is_file()
            && entry
                .canonicalize()
                .is_ok_and(|selected| selected.starts_with(root))
    })
}

fn matches_installed_program(row: &AgentRow, items: &[Installation], data: &Path) -> bool {
    items
        .iter()
        .filter(|item| {
            matching_registry_installation(row, item, data) || matching_node_entry(row, item, data)
        })
        .take(2)
        .count()
        == 1
}

fn verified_discovery(row: &AgentRow, discovered: &[DiscoveredBinary]) -> bool {
    if row.id != "opencode"
        || row.args != ["acp"]
        || !crate::agent_discovery::validate_executable_path(&row.command)
            .is_ok_and(|selected| selected == Path::new(&row.command))
    {
        return false;
    }
    // The official guide is read-only. For a cold start use the handshake
    // saved for this exact launch, independent of the last version probe.
    let advertised_name = row
        .handshake
        .as_ref()
        .and_then(|handshake| handshake.pointer("/agentInfo/name"))
        .and_then(Value::as_str);
    advertised_name.map_or_else(
        || {
            discovered
                .iter()
                .any(|entry| entry.agent_id == row.id && entry.path == row.command)
        },
        |name| name.eq_ignore_ascii_case("opencode"),
    )
}

pub(crate) fn guidance_for(
    store: &MetaStore,
    row: &AgentRow,
    data: &Path,
    discovered: &[DiscoveredBinary],
) -> (Vec<ConnectionGuidance>, Vec<OfficialMethodRole>) {
    let guides = official_guides(&row.id);
    if guides.is_empty() {
        return (vec![], vec![]);
    }
    let verified = match row.source.as_str() {
        "registry" => recorded_installations(store)
            .is_ok_and(|items| matches_installed_program(row, &items, data)),
        "discovered" => verified_discovery(row, discovered),
        _ => false,
    };
    if !verified {
        return (vec![], vec![]);
    }
    let roles = proven_methods(row)
        .iter()
        .filter(|role| {
            declared_method(row, role)
                && (role.role != MethodRole::External
                    || guides
                        .iter()
                        .filter(|guide| guide.method_id == Some(role.method_id))
                        .take(2)
                        .count()
                        == 1)
        })
        .copied()
        .collect();
    (guides, roles)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{installations::record, managed_paths};
    use serde_json::json;

    fn fixture(id: &str, version: &str) -> (tempfile::TempDir, MetaStore, AgentRow) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let agent_root = managed_paths::parent(&root, id, Layout::Agent).join("install-candidate");
        std::fs::create_dir_all(&agent_root).unwrap();
        let command = agent_root.join(if cfg!(windows) { "agent.exe" } else { "agent" });
        std::fs::write(&command, "test fixture; never run").unwrap();
        crate::process_platform::set_executable(&command).unwrap();
        let store = MetaStore::open(&root.join("farfold.sqlite3")).unwrap();
        let row = AgentRow {
            id: id.into(),
            source: "registry".into(),
            name: "Official fixture".into(),
            command: command.display().to_string(),
            args: vec![],
            env: vec![],
            version: Some(version.into()),
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        (dir, store, row)
    }

    fn record_fixture(row: &AgentRow, store: &MetaStore) {
        record(store, row, Path::new(&row.command).parent().unwrap()).unwrap();
    }

    #[test]
    fn serializes_only_advice_for_the_verified_official_method() {
        let (data, store, mut row) = fixture("registry:goose", "1.59.1");
        row.handshake =
            Some(json!({"authMethods":[{"id":"goose-provider","name":"Configure Provider"}]}));
        assert_eq!(
            guidance_for(&store, &row, data.path(), &[]),
            (vec![], vec![])
        );
        record_fixture(&row, &store);
        let (guides, roles) = guidance_for(&store, &row, data.path(), &[]);
        assert_eq!(
            serde_json::to_value(&roles).unwrap(),
            json!([
                {"methodId":"goose-provider","role":"external","kind":"agent"}
            ])
        );
        assert_eq!(
            serde_json::to_value(&guides).unwrap(),
            json!([
                {
                    "kind":"official_setup",
                    "label":"在 Goose 配置模型服务",
                    "url":"https://goose-docs.ai/docs/getting-started/providers/",
                    "command":"goose configure",
                    "methodId":"goose-provider"
                }
            ])
        );
        assert_eq!(store.get_agent(&row.id).unwrap(), None);
    }

    #[test]
    fn only_exact_supported_release_and_unique_declared_kind_gets_a_role() {
        let (data, store, mut row) = fixture("registry:amp-acp", "0.13.0");
        record_fixture(&row, &store);
        row.handshake = Some(json!({"authMethods":[{"id":"setup","type":"terminal"}]}));
        let (guides, roles) = guidance_for(&store, &row, data.path(), &[]);
        assert_eq!(
            guides
                .iter()
                .filter(|g| g.kind == GuidanceKind::OfficialSignIn)
                .count(),
            1
        );
        assert_eq!(
            roles,
            [OfficialMethodRole {
                method_id: "setup",
                role: MethodRole::Credential,
                kind: MethodKind::Terminal,
            }]
        );

        for declarations in [
            json!([{"id":"different","name":"Amp API Key Setup","type":"terminal"}]),
            json!([{"id":"setup","type":"agent"}]),
            json!([{"id":"setup","type":"terminal","_farfoldInvalid":true}]),
            json!([{"id":"setup","type":"terminal"},{"id":"setup","type":"terminal"}]),
        ] {
            row.handshake = Some(json!({"authMethods":declarations}));
            let (guides, roles) = guidance_for(&store, &row, data.path(), &[]);
            assert_eq!(guides.len(), 2);
            assert!(roles.is_empty());
        }
        row.source = "custom".into();
        assert_eq!(
            guidance_for(&store, &row, data.path(), &[]),
            (vec![], vec![])
        );

        let (data, store, mut newer) = fixture("registry:amp-acp", "0.14.0");
        record_fixture(&newer, &store);
        newer.handshake = Some(json!({"authMethods":[{"id":"setup","type":"terminal"}]}));
        let (guides, roles) = guidance_for(&store, &newer, data.path(), &[]);
        assert!(!guides.is_empty());
        assert!(roles.is_empty());
    }

    #[test]
    fn shared_node_requires_the_loader_inside_the_same_managed_receipt() {
        let (data, store, mut row) = fixture("registry:cline", "3.0.74");
        let root = Path::new(&row.command).parent().unwrap().to_path_buf();
        let node = data
            .path()
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        std::fs::write(&node, "shared Node fixture").unwrap();
        crate::process_platform::set_executable(&node).unwrap();
        let entry = root.join("loader.js");
        std::fs::write(&entry, "// public entry").unwrap();
        row.command = node.canonicalize().unwrap().display().to_string();
        row.args = vec![entry.display().to_string(), "--acp".into()];
        record(&store, &row, &root).unwrap();
        assert_eq!(guidance_for(&store, &row, data.path(), &[]).0.len(), 1);

        let other = data.path().join("unowned.js");
        std::fs::write(&other, "// unowned").unwrap();
        row.args[0] = other.display().to_string();
        record(&store, &row, &root).unwrap();
        assert!(guidance_for(&store, &row, data.path(), &[]).0.is_empty());
    }

    #[test]
    fn discovered_opencode_uses_cold_identity_or_exact_selected_discovery_path() {
        let (data, store, mut row) = fixture("opencode", "1.18.31");
        row.source = "discovered".into();
        row.args = vec!["acp".into()];
        assert!(guidance_for(&store, &row, data.path(), &[]).0.is_empty());
        let discovery = [DiscoveredBinary {
            agent_id: row.id.clone(),
            path: row.command.clone(),
            version: Some("2.2.7".into()),
        }];
        assert_eq!(
            guidance_for(&store, &row, data.path(), &discovery).0.len(),
            1
        );
        let not_selected = [DiscoveredBinary {
            path: data.path().join("another-opencode").display().to_string(),
            ..discovery[0].clone()
        }];
        assert!(
            guidance_for(&store, &row, data.path(), &not_selected)
                .0
                .is_empty()
        );

        store.insert_agent(&row).unwrap();
        store
            .set_agent_handshake(
                &row,
                &json!({"agentInfo":{"name":"OpenCode","version":"2.2.7"}}),
            )
            .unwrap();
        let mut row = store.get_agent(&row.id).unwrap().unwrap();
        assert_eq!(guidance_for(&store, &row, data.path(), &[]).0.len(), 1);
        row.args.push("--other".into());
        assert!(
            guidance_for(&store, &row, data.path(), &discovery)
                .0
                .is_empty()
        );
    }

    #[test]
    fn current_google_methods_keep_their_own_guides_roles_and_transport() {
        let (data, store, mut gemini) = fixture("registry:gemini", "0.62.0");
        record_fixture(&gemini, &store);
        gemini.handshake = Some(json!({"authMethods":[
            {"id":"oauth-personal"},
            {"id":"gemini-api-key"},
            {"id":"vertex-ai"},
            {"id":"gateway"}
        ]}));
        let (guides, roles) = guidance_for(&store, &gemini, data.path(), &[]);
        assert_eq!(guides.len(), 4);
        assert_eq!(
            guides
                .iter()
                .filter(|g| g.method_id == Some("gateway"))
                .count(),
            1
        );
        assert_eq!(
            serde_json::to_value(roles).unwrap(),
            json!([
                {"methodId":"gemini-api-key","role":"credential","kind":"agent"},
                {"methodId":"vertex-ai","role":"configuration","kind":"agent"},
                {"methodId":"gateway","role":"external","kind":"agent"}
            ])
        );

        let (data, store, mut antigravity) = fixture("registry:antigravity-acp", "1.2.1");
        record_fixture(&antigravity, &store);
        antigravity.handshake = Some(json!({"authMethods":[
            {"id":"oauth-personal"},
            {"id":"oauth-business"},
            {"id":"gemini-api-key","type":"agent"},
            {"id":"agent-platform"},
            {"id":"gateway"},
        ]}));
        let (guides, roles) = guidance_for(&store, &antigravity, data.path(), &[]);
        assert_eq!(guides.len(), 3);
        assert_eq!(
            serde_json::to_value(roles).unwrap(),
            json!([
                {"methodId":"gemini-api-key","role":"credential","kind":"agent"},
                {"methodId":"agent-platform","role":"configuration","kind":"agent"}
            ])
        );
    }
}
