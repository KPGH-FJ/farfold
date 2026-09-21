//! Agent catalog: the three built-in agent definitions plus the ACP registry.
//!
//! An agent is `{id, command, args, env}` — the catalog only describes how to
//! discover, install, and launch it. Compatibility is decided solely by the
//! ACP `initialize` handshake, never by anything in this file.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::agent_discovery::DiscoveredBinary;
use crate::meta_store::{AgentRow, MetaStore};

/// ACP registry endpoint (version-pinned path; content is whatever upstream
/// publishes under `latest`).
pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
/// Registry cache freshness window.
pub const REGISTRY_CACHE_TTL: Duration = Duration::from_secs(3 * 60 * 60);
const REGISTRY_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Fallback versions used when the registry is unreachable and no cache
/// exists yet. These are the last known-good registry versions.
const FALLBACK_CODEX_ACP_PACKAGE: &str = "@agentclientprotocol/codex-acp@1.12.0";
const FALLBACK_PI_ACP_PACKAGE: &str = "pi-acp@0.0.33";
const FALLBACK_OPENCODE_VERSION: &str = "1.18.31";

/// How a connected agent process is launched.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AgentLaunch {
    /// A native binary on PATH (or an absolute path after discovery).
    Binary { binary: String, args: Vec<String> },
    /// An npm package run under Node (`node <bin-entry>` after a private
    /// `npm install`, or `npx` when the user already has Node).
    Npx { package: String, args: Vec<String> },
}

/// Static definition of one catalog agent. `id` is Farfold's stable agent id;
/// `registry_id` is the upstream registry entry used for installs.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub registry_id: &'static str,
    /// Binary name to probe during local discovery.
    pub discovery_binary: &'static str,
    /// Args used when the discovered binary itself is the launch target.
    /// `None` means the binary only informs env injection — direct launch
    /// goes through the adapter install instead.
    pub binary_args: Option<Vec<String>>,
    /// The preferred launch route for a fresh install (registry-driven).
    pub install_launch: AgentLaunch,
    /// Env var set to the discovered local binary's absolute path when the
    /// adapter should delegate to an existing CLI install.
    pub discovered_cli_env: Option<&'static str>,
}

/// The three supported agents (D3). Differences live only in this data.
pub fn builtin_defs() -> Vec<AgentDef> {
    vec![
        AgentDef {
            id: "opencode",
            display_name: "OpenCode",
            description: "Open-source coding agent with a native ACP mode.",
            registry_id: "opencode",
            discovery_binary: "opencode",
            binary_args: Some(vec!["acp".to_string()]),
            install_launch: AgentLaunch::Binary {
                binary: "opencode".to_string(),
                args: vec!["acp".to_string()],
            },
            discovered_cli_env: None,
        },
        AgentDef {
            id: "codex",
            display_name: "Codex",
            description: "OpenAI's coding assistant via the official ACP adapter.",
            registry_id: "codex-acp",
            discovery_binary: "codex",
            binary_args: None,
            install_launch: AgentLaunch::Npx {
                package: "@agentclientprotocol/codex-acp".to_string(),
                args: vec![],
            },
            discovered_cli_env: Some("CODEX_PATH"),
        },
        AgentDef {
            id: "pi",
            display_name: "Pi",
            description: "Pi coding agent via the upstream pi-acp adapter.",
            registry_id: "pi-acp",
            discovery_binary: "pi",
            binary_args: None,
            install_launch: AgentLaunch::Npx {
                package: "pi-acp".to_string(),
                args: vec![],
            },
            discovered_cli_env: Some("PI_ACP_PI_COMMAND"),
        },
    ]
}

pub fn def_for(agent_id: &str) -> Option<AgentDef> {
    builtin_defs().into_iter().find(|def| def.id == agent_id)
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// One agent entry from the upstream registry (only the fields Farfold reads).
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub distribution: RegistryDistribution,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RegistryDistribution {
    pub npx: Option<RegistryNpx>,
    pub binary: Option<std::collections::BTreeMap<String, RegistryBinary>>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RegistryNpx {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RegistryBinary {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct RegistryDocument {
    version: String,
    agents: Vec<RegistryAgent>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn cache_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("registry-cache.json")
}

/// The on-disk cache as `(fetched_at_ms, agents)`; `None` when absent or
/// unparsable. Freshness is the caller's decision against `fetched_at`.
fn read_registry_cache(app_data_dir: &Path) -> Option<(u64, Vec<RegistryAgent>)> {
    let raw = std::fs::read_to_string(cache_path(app_data_dir)).ok()?;
    #[derive(Deserialize)]
    struct CacheEnvelope {
        fetched_at: u64,
        agents: Vec<RegistryAgent>,
    }
    let envelope: CacheEnvelope = serde_json::from_str(&raw).ok()?;
    Some((envelope.fetched_at, envelope.agents))
}

fn is_fresh(fetched_at: u64) -> bool {
    now_millis().saturating_sub(fetched_at) < REGISTRY_CACHE_TTL.as_millis() as u64
}

fn write_registry_cache(app_data_dir: &Path, agents: &[RegistryAgent]) {
    let envelope = serde_json::json!({
        "fetchedAt": now_millis(),
        "source": REGISTRY_URL,
        "agents": agents,
    });
    let _ = std::fs::write(cache_path(app_data_dir), envelope.to_string());
}

fn fetch_registry(url: &str, timeout: Duration) -> Result<Vec<RegistryAgent>, String> {
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout)
        .build()
        .map_err(|_| "cannot create registry client".to_string())?;
    let document: RegistryDocument = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.json())
        .map_err(|error| format!("registry fetch failed: {error}"))?;
    Ok(document.agents)
}

/// The agent catalog as managed state: builtin defs plus the registry with
/// a 3h TTL in-memory and on-disk cache (`app_data/registry-cache.json`),
/// and the latest local-discovery result (`catalog_scan` is the only
/// writer — `catalog_list` never probes binaries or the network itself).
pub struct AgentCatalog {
    app_data_dir: PathBuf,
    registry: std::sync::Mutex<Option<(u64, Vec<RegistryAgent>)>>,
    discovered: std::sync::Mutex<Option<Vec<DiscoveredBinary>>>,
}

impl AgentCatalog {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir,
            registry: std::sync::Mutex::new(None),
            discovered: std::sync::Mutex::new(None),
        }
    }

    /// Cached discovery result from the last `catalog_scan` (empty before
    /// the first scan of this app run — callers treat `None` as "unknown").
    pub fn discovered_cached(&self) -> Option<Vec<DiscoveredBinary>> {
        self.discovered.lock().ok()?.clone()
    }

    /// Registry entries without touching the network: fresh in-memory or
    /// on-disk cache, else the stale disk cache, else `None`. The blocking
    /// `agents()` path stays for installs, where a fetch is user-driven.
    pub fn agents_cached(&self) -> Option<Vec<RegistryAgent>> {
        if let Ok(registry) = self.registry.lock()
            && let Some((_, agents)) = registry.as_ref()
        {
            return Some(agents.clone());
        }
        read_registry_cache(&self.app_data_dir).map(|(_, agents)| agents)
    }

    /// Blocking refresh: probe binaries and re-pull the registry (scan
    /// path). Discovery always writes the cache; a failed fetch keeps the
    /// stale registry cache so scan still reports what it found.
    pub fn refresh_blocking(&self) -> Vec<DiscoveredBinary> {
        let found = crate::agent_discovery::discover();
        if let Ok(mut discovered) = self.discovered.lock() {
            *discovered = Some(found.clone());
        }
        if let Ok(agents) = fetch_registry(REGISTRY_URL, REGISTRY_REQUEST_TIMEOUT) {
            write_registry_cache(&self.app_data_dir, &agents);
            if let Ok(mut registry) = self.registry.lock() {
                *registry = Some((now_millis(), agents));
            }
        }
        found
    }

    /// Registry entries. Fresh in-memory or on-disk cache (3h TTL) wins;
    /// otherwise a blocking fetch, falling back to stale cache on failure.
    /// `None` only when nothing has ever been fetched and the network is out.
    pub fn agents(&self) -> Option<Vec<RegistryAgent>> {
        if let Ok(registry) = self.registry.lock()
            && let Some((fetched_at, agents)) = registry.as_ref()
            && is_fresh(*fetched_at)
        {
            return Some(agents.clone());
        }
        let stale = read_registry_cache(&self.app_data_dir);
        if let Some((fetched_at, agents)) = &stale
            && is_fresh(*fetched_at)
        {
            if let Ok(mut registry) = self.registry.lock() {
                *registry = Some((*fetched_at, agents.clone()));
            }
            return Some(agents.clone());
        }
        match fetch_registry(REGISTRY_URL, REGISTRY_REQUEST_TIMEOUT) {
            Ok(agents) => {
                write_registry_cache(&self.app_data_dir, &agents);
                if let Ok(mut registry) = self.registry.lock() {
                    *registry = Some((now_millis(), agents.clone()));
                }
                Some(agents)
            }
            Err(_) => stale.map(|(_, agents)| agents),
        }
    }

    /// The registry entry for one catalog def. When the registry is entirely
    /// unavailable, a minimal fallback entry built from the pinned constants
    /// is returned so npx adapter installs still work.
    pub fn entry_for(&self, def: &AgentDef) -> Option<RegistryAgent> {
        if let Some(entry) = self
            .agents()
            .unwrap_or_default()
            .into_iter()
            .find(|agent| agent.id == def.registry_id)
        {
            return Some(entry);
        }
        fallback_entry(def)
    }
}

fn fallback_entry(def: &AgentDef) -> Option<RegistryAgent> {
    let (version, distribution) = match def.registry_id {
        "codex-acp" => (
            "1.12.0",
            RegistryDistribution {
                npx: Some(RegistryNpx {
                    package: FALLBACK_CODEX_ACP_PACKAGE.to_string(),
                    args: vec![],
                }),
                binary: None,
            },
        ),
        "pi-acp" => (
            "0.0.33",
            RegistryDistribution {
                npx: Some(RegistryNpx {
                    package: FALLBACK_PI_ACP_PACKAGE.to_string(),
                    args: vec![],
                }),
                binary: None,
            },
        ),
        "opencode" => (FALLBACK_OPENCODE_VERSION, RegistryDistribution::default()),
        _ => return None,
    };
    Some(RegistryAgent {
        id: def.registry_id.to_string(),
        name: def.display_name.to_string(),
        version: version.to_string(),
        description: def.description.to_string(),
        distribution,
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// One row of the Settings "Agent 接入" card model: the static definition
/// merged with what is registered, discovered locally, and installable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub agent_id: String,
    pub display_name: String,
    pub description: String,
    pub registry_id: String,
    pub install_launch: AgentLaunch,
    /// Local binary probe result, when found.
    pub discovered: Option<DiscoveredBinary>,
    /// The registered agent row (`discovered`|`registry`|`custom`), if any.
    pub registered: Option<AgentRow>,
    /// Registry-published version, when reachable (or cached/fallback).
    pub registry_version: Option<String>,
    /// A registry distribution exists for this agent.
    pub installable: bool,
}

/// Probe binaries and refresh the registry cache in the background, then
/// tell the UI to re-read `catalog_list`. This is the only path that
/// touches the filesystem or the network.
#[tauri::command]
pub async fn catalog_scan(app: AppHandle) -> Result<Vec<DiscoveredBinary>, String> {
    let discovered = tauri::async_runtime::spawn_blocking(move || {
        let catalog = app.state::<AgentCatalog>();
        let found = catalog.refresh_blocking();
        crate::ui_transport::emit_event(
            &app,
            "catalog:updated",
            serde_json::json!({ "found": found.len() }),
        );
        found
    })
    .await
    .map_err(|error| format!("catalog scan failed: {error}"))?;
    Ok(discovered)
}

/// The merged catalog: defs + registered rows + the last scan's discovery
/// + the cached registry. Reads only memory and small local files so the
/// settings page renders immediately; `catalog_scan` fills the caches.
#[tauri::command]
pub async fn catalog_list(app: AppHandle) -> Result<Vec<CatalogEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<MetaStore>();
        let catalog = app.state::<AgentCatalog>();
        let registered = store.list_agents()?;
        let discovered = catalog.discovered_cached().unwrap_or_default();
        let registry = catalog.agents_cached().unwrap_or_default();
        Ok(builtin_defs()
            .into_iter()
            .map(|def| {
                let entry = registry.iter().find(|agent| agent.id == def.registry_id);
                CatalogEntry {
                    agent_id: def.id.to_string(),
                    display_name: def.display_name.to_string(),
                    description: def.description.to_string(),
                    registry_id: def.registry_id.to_string(),
                    installable: entry.is_some_and(|e| {
                        e.distribution.npx.is_some()
                            || e.distribution
                                .binary
                                .as_ref()
                                .is_some_and(|map| map.contains_key("darwin-aarch64"))
                    }),
                    registry_version: entry.map(|e| e.version.clone()),
                    discovered: discovered.iter().find(|d| d.agent_id == def.id).cloned(),
                    registered: registered.iter().find(|row| row.id == def.id).cloned(),
                    install_launch: def.install_launch,
                }
            })
            .collect())
    })
    .await
    .map_err(|error| format!("catalog list failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_defs_cover_the_three_agents() {
        let defs = builtin_defs();
        assert_eq!(defs.len(), 3);
        assert_eq!(defs[0].id, "opencode");
        assert_eq!(defs[1].id, "codex");
        assert_eq!(defs[2].id, "pi");
        assert_eq!(def_for("codex").unwrap().registry_id, "codex-acp");
        assert_eq!(def_for("pi").unwrap().registry_id, "pi-acp");
        assert!(def_for("gemini").is_none());
    }

    #[test]
    fn codex_and_pi_defs_carry_cli_env_injection() {
        assert_eq!(
            def_for("codex").unwrap().discovered_cli_env,
            Some("CODEX_PATH")
        );
        assert_eq!(
            def_for("pi").unwrap().discovered_cli_env,
            Some("PI_ACP_PI_COMMAND")
        );
        assert!(def_for("opencode").unwrap().discovered_cli_env.is_none());
    }

    #[test]
    fn fallback_entries_match_registry_shape() {
        let codex = fallback_entry(&def_for("codex").unwrap()).unwrap();
        assert_eq!(codex.id, "codex-acp");
        let npx = codex.distribution.npx.expect("npx distribution");
        assert!(npx.package.starts_with("@agentclientprotocol/codex-acp@"));

        let pi = fallback_entry(&def_for("pi").unwrap()).unwrap();
        let npx = pi.distribution.npx.expect("npx distribution");
        assert!(npx.package.starts_with("pi-acp@"));

        let opencode = fallback_entry(&def_for("opencode").unwrap()).unwrap();
        assert_eq!(opencode.id, "opencode");
        assert!(!opencode.version.is_empty());
    }

    #[test]
    fn registry_document_parses_real_shape() {
        let document: RegistryDocument = serde_json::from_str(
            r#"{"version":"1.0.0","agents":[{
                "id":"codex-acp","name":"Codex","version":"1.12.0",
                "distribution":{"npx":{"package":"@agentclientprotocol/codex-acp@1.12.0"}}
            },{
                "id":"opencode","name":"OpenCode","version":"1.18.31",
                "distribution":{"binary":{"darwin-aarch64":{
                    "archive":"https://example/opencode.zip","cmd":"./opencode",
                    "args":["acp"],"sha256":"abc"}}}
            }]}"#,
        )
        .expect("registry document parses");
        assert_eq!(document.agents.len(), 2);
        let binary = document.agents[1]
            .distribution
            .binary
            .as_ref()
            .expect("binary map");
        assert_eq!(binary["darwin-aarch64"].sha256.as_deref(), Some("abc"));
    }
}
