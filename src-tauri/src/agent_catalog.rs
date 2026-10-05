//! Agent catalog: the three built-in agent definitions plus the ACP registry.
//!
//! An agent is `{id, command, args, env}` — the catalog only describes how to
//! discover, install, and launch it. Compatibility is decided solely by the
//! ACP `initialize` handshake, never by anything in this file.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::acp_client::directory_presentation::{self, DirectoryPresentation};
use crate::agent_discovery::DiscoveredBinary;
use crate::meta_store::{AgentRow, MetaStore};

mod uvx;
pub(crate) use uvx::{RegistryUvx, UvxPackage, normalized_name};

/// ACP registry endpoint (version-pinned path; content is whatever upstream
/// publishes under `latest`).
pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
/// Registry cache freshness window.
pub const REGISTRY_CACHE_TTL: Duration = Duration::from_secs(3 * 60 * 60);
const REGISTRY_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// How a connected agent process is launched.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AgentLaunch {
    /// A native binary on PATH (or an absolute path after discovery).
    Binary { binary: String, args: Vec<String> },
    /// An npm package run under Node (`node <bin-entry>` after a private
    /// `npm install`, or `npx` when the user already has Node).
    Npx { package: String, args: Vec<String> },
    /// A declared Python tool, prepared into its own managed environment.
    Uvx { package: String, args: Vec<String> },
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
    pub bundled_program: bool,
    pub install_guide: &'static str,
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
            bundled_program: false,
            install_guide: "https://opencode.ai/docs/",
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
            bundled_program: true,
            install_guide: "https://github.com/openai/codex",
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
            bundled_program: false,
            install_guide: "https://github.com/earendil-works/pi-mono",
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
    pub repository: Option<String>,
    pub website: Option<String>,
    pub icon: Option<String>,
    pub distribution: RegistryDistribution,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RegistryDistribution {
    pub npx: Option<RegistryNpx>,
    pub binary: Option<std::collections::BTreeMap<String, RegistryBinary>>,
    /// Keep unsupported/unknown shapes intact without making the entire
    /// catalog unreadable. The installer validates a typed RegistryUvx.
    pub uvx: Option<serde_json::Value>,
    #[serde(flatten)]
    pub other: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RegistryNpx {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RegistryBinary {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub sha256: Option<String>,
    pub env: std::collections::BTreeMap<String, String>,
}

/// Stable local ids keep built-in history intact and avoid custom-entry collisions.
pub(crate) fn registry_agent_id(entry: &RegistryAgent) -> Option<String> {
    if entry.id.is_empty()
        || !entry
            .id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return None;
    }
    Some(
        builtin_defs()
            .into_iter()
            .find(|def| def.registry_id == entry.id)
            .map_or_else(|| format!("registry:{}", entry.id), |def| def.id.into()),
    )
}

pub(crate) const fn registry_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x86_64"
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
    #[cfg(all(windows, target_arch = "aarch64"))]
    {
        "windows-aarch64"
    }
}

fn registry_platform_available(entry: &RegistryAgent) -> Option<bool> {
    let distribution = &entry.distribution;
    if distribution
        .binary
        .as_ref()
        .is_some_and(|binary| binary.contains_key(registry_platform()))
        || distribution.npx.is_some()
        || distribution.uvx.is_some()
    {
        // A target or platform-neutral distribution is officially declared.
        // This does not establish installer support or working compatibility.
        Some(true)
    } else if distribution.other.is_empty()
        && distribution
            .binary
            .as_ref()
            .is_some_and(|binary| !binary.is_empty())
    {
        Some(false)
    } else {
        // Missing/unknown declarations cannot establish device incompatibility.
        None
    }
}

pub(crate) fn registry_launch(entry: &RegistryAgent) -> Option<AgentLaunch> {
    // A fresh install follows the published platform distribution. Unsupported
    // formats stay discoverable but are not presented as installable.
    if let Some(binary) = entry
        .distribution
        .binary
        .as_ref()
        .and_then(|map| map.get(registry_platform()))
        && !binary.cmd.is_empty()
        && ([".tar.gz", ".tgz", ".zip", ".tar.bz2"]
            .iter()
            .any(|suffix| {
                (!cfg!(windows) || *suffix != ".tar.bz2")
                    && binary
                        .archive
                        .split(['?', '#'])
                        .next()
                        .unwrap_or(&binary.archive)
                        .ends_with(suffix)
            })
            || (cfg!(windows)
                && crate::archive_zip::raw_executable_target(&binary.archive, &binary.cmd)
                    .is_some()))
        && binary.archive.starts_with("https://")
        && !binary.env.contains_key("HOME")
    {
        return Some(AgentLaunch::Binary {
            binary: binary.cmd.clone(),
            args: binary.args.clone(),
        });
    }
    entry
        .distribution
        .npx
        .as_ref()
        .filter(|npx| {
            !npx.package.is_empty()
                && !npx.package.starts_with('-')
                && !npx.env.contains_key("HOME")
        })
        .map(|npx| AgentLaunch::Npx {
            package: npx.package.clone(),
            args: npx.args.clone(),
        })
        .or_else(|| {
            let uvx = RegistryUvx::decode(entry.distribution.uvx.as_ref()?)?;
            Some(AgentLaunch::Uvx {
                package: uvx.package,
                args: uvx.args,
            })
        })
}

fn source_url(entry: &RegistryAgent) -> Option<String> {
    entry
        .website
        .as_ref()
        .or(entry.repository.as_ref())
        .filter(|url| url.starts_with("https://"))
        .cloned()
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistryCache {
    fetched_at: u64,
    source: String,
    agents: Vec<RegistryAgent>,
}

/// The same shape is used for persistence and restart recovery.
fn read_registry_cache(app_data_dir: &Path) -> Option<(u64, Vec<RegistryAgent>)> {
    let raw = std::fs::read_to_string(cache_path(app_data_dir)).ok()?;
    let cache: RegistryCache = serde_json::from_str(&raw).ok()?;
    (cache.source == REGISTRY_URL).then_some((cache.fetched_at, cache.agents))
}

fn is_fresh(fetched_at: u64) -> bool {
    now_millis().saturating_sub(fetched_at) < REGISTRY_CACHE_TTL.as_millis() as u64
}

fn write_registry_cache(app_data_dir: &Path, agents: &[RegistryAgent]) {
    let cache = RegistryCache {
        fetched_at: now_millis(),
        source: REGISTRY_URL.into(),
        agents: agents.to_vec(),
    };
    if let Ok(raw) = serde_json::to_vec(&cache) {
        let _ = std::fs::write(cache_path(app_data_dir), raw);
    }
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

    /// Keep the newest successfully decoded cache, even after its TTL expires
    /// or a later disk write/read fails. Freshness only controls network refresh.
    fn retained_registry(&self) -> Option<(u64, Vec<RegistryAgent>)> {
        let disk = read_registry_cache(&self.app_data_dir);
        match self.registry.lock() {
            Ok(mut registry) => {
                if let Some(cache) = disk
                    && registry.as_ref().is_none_or(|current| cache.0 > current.0)
                {
                    *registry = Some(cache);
                }
                registry.clone()
            }
            Err(_) => disk,
        }
    }

    /// Registry entries without touching the network. The blocking `agents()`
    /// path stays for installs, where a fetch is user-driven.
    pub fn agents_cached(&self) -> Option<Vec<RegistryAgent>> {
        self.retained_registry().map(|(_, agents)| agents)
    }

    /// Preparation can inspect distribution prerequisites before registration,
    /// without refreshing the directory or starting the Agent.
    pub(crate) fn cached_entry(&self, agent_id: &str) -> Option<RegistryAgent> {
        self.agents_cached()?
            .into_iter()
            .filter(|entry| crate::acp_client::first_release::first_batch_visible(&entry.id))
            .find(|entry| registry_agent_id(entry).as_deref() == Some(agent_id))
    }

    /// Blocking refresh: probe binaries and re-pull the registry (scan
    /// path). Discovery always writes the cache; a failed fetch keeps the
    /// stale registry cache. Without any registry cache, return the failure;
    /// discovery stays available through `catalog_list` in either case.
    pub fn refresh_blocking(&self) -> Result<Vec<DiscoveredBinary>, String> {
        self.refresh_with(crate::agent_discovery::discover(), || {
            fetch_registry(REGISTRY_URL, REGISTRY_REQUEST_TIMEOUT)
        })
    }

    fn refresh_with(
        &self,
        found: Vec<DiscoveredBinary>,
        fetch: impl FnOnce() -> Result<Vec<RegistryAgent>, String>,
    ) -> Result<Vec<DiscoveredBinary>, String> {
        if let Ok(mut discovered) = self.discovered.lock() {
            *discovered = Some(found.clone());
        }
        match fetch() {
            Ok(agents) => {
                write_registry_cache(&self.app_data_dir, &agents);
                if let Ok(mut registry) = self.registry.lock() {
                    *registry = Some((now_millis(), agents));
                }
            }
            Err(error) => {
                if self.retained_registry().is_none() {
                    return Err(error);
                }
            }
        }
        Ok(found)
    }

    /// Registry entries. Fresh in-memory or on-disk cache (3h TTL) wins;
    /// otherwise a blocking fetch, falling back to stale cache on failure.
    /// `None` only when nothing has ever been fetched and the network is out.
    pub fn agents(&self) -> Option<Vec<RegistryAgent>> {
        self.agents_with(|| fetch_registry(REGISTRY_URL, REGISTRY_REQUEST_TIMEOUT))
    }

    fn agents_with(
        &self,
        fetch: impl FnOnce() -> Result<Vec<RegistryAgent>, String>,
    ) -> Option<Vec<RegistryAgent>> {
        let stale = self.retained_registry();
        if let Some((fetched_at, agents)) = &stale
            && is_fresh(*fetched_at)
        {
            return Some(agents.clone());
        }
        match fetch() {
            Ok(agents) => {
                write_registry_cache(&self.app_data_dir, &agents);
                if let Ok(mut registry) = self.registry.lock() {
                    *registry = Some((now_millis(), agents.clone()));
                }
                Some(agents)
            }
            Err(_) => self.retained_registry().or(stale).map(|(_, agents)| agents),
        }
    }

    pub(crate) fn installation_entry(
        &self,
        agent_id: &str,
    ) -> Result<(RegistryAgent, AgentLaunch), String> {
        let registry_id = def_for(agent_id)
            .map(|def| def.registry_id.to_string())
            .or_else(|| agent_id.strip_prefix("registry:").map(str::to_string));
        if registry_id
            .as_deref()
            .is_none_or(|id| !crate::acp_client::first_release::first_batch_visible(id))
        {
            return Err("此 Agent 未包含在当前目录中，已有程序和对话仍保留".into());
        }
        let entry = self
            .agents()
            .ok_or("暂时无法读取 Agent 目录，请重试")?
            .into_iter()
            .find(|entry| registry_agent_id(entry).as_deref() == Some(agent_id))
            .ok_or("目录中没有找到此 Agent，请刷新后重试")?;
        let launch = registry_launch(&entry).ok_or_else(|| {
            if registry_platform_available(&entry) == Some(false) {
                "官方目录未提供适用于此设备的安装方式，请查看官方说明"
            } else {
                "Farfold 当前尚不能安装此条目，请查看官方说明或添加已安装的程序"
            }
        })?;
        Ok((entry, launch))
    }
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
    pub presentation: Option<DirectoryPresentation>,
    pub registry_id: String,
    /// Reviewed discovery scope, independent of compatibility or installed data.
    pub first_batch_visible: bool,
    pub install_launch: Option<AgentLaunch>,
    /// Local binary probe result, when found.
    pub discovered: Option<DiscoveredBinary>,
    /// The registered agent row (`discovered`|`registry`|`custom`), if any.
    pub registered: Option<AgentRow>,
    /// Registry-published version, when reachable or retained in the cache.
    pub registry_version: Option<String>,
    /// Farfold can install one of the published distributions on this device.
    pub installable: bool,
    /// Official target/platform-neutral distribution; None means not known.
    pub platform_available: Option<bool>,
    pub source_url: Option<String>,
    pub icon: Option<String>,
    pub program_env: Option<String>,
    pub bundled_program: bool,
    pub install_guide: String,
    pub rollback_available: bool,
}

fn catalog_entries(
    registered: &[AgentRow],
    discovered: &[DiscoveredBinary],
    registry: &[RegistryAgent],
) -> Vec<CatalogEntry> {
    let definitions = builtin_defs();
    let mut entries: Vec<CatalogEntry> = definitions
        .iter()
        .map(|def| {
            let entry = registry.iter().find(|entry| entry.id == def.registry_id);
            let launch = entry.and_then(registry_launch);
            CatalogEntry {
                agent_id: def.id.into(),
                display_name: def.display_name.into(),
                description: entry
                    .map_or_else(|| def.description.into(), |entry| entry.description.clone()),
                presentation: directory_presentation::for_registry(def.registry_id),
                registry_id: def.registry_id.into(),
                first_batch_visible: crate::acp_client::first_release::first_batch_visible(
                    def.registry_id,
                ),
                installable: launch.is_some(),
                platform_available: entry.and_then(registry_platform_available),
                source_url: entry
                    .and_then(source_url)
                    .or_else(|| Some(def.install_guide.into())),
                icon: entry
                    .and_then(|entry| entry.icon.clone())
                    .filter(|url| url.starts_with("https://")),
                registry_version: entry.map(|entry| entry.version.clone()),
                discovered: discovered
                    .iter()
                    .find(|found| found.agent_id == def.id)
                    .cloned(),
                registered: registered.iter().find(|row| row.id == def.id).cloned(),
                // Existing local discovery has its own official invocation;
                // registry packaging does not change whether it speaks the protocol.
                install_launch: Some(def.install_launch.clone()),
                program_env: def.discovered_cli_env.map(str::to_string),
                bundled_program: def.bundled_program,
                install_guide: def.install_guide.into(),
                rollback_available: false,
            }
        })
        .collect();
    let mut seen: std::collections::HashSet<String> =
        entries.iter().map(|entry| entry.agent_id.clone()).collect();
    for entry in registry {
        let Some(id) = registry_agent_id(entry) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let launch = registry_launch(entry);
        let source_url = source_url(entry);
        entries.push(CatalogEntry {
            registered: registered.iter().find(|row| row.id == id).cloned(),
            program_env: crate::acp_client::preparation::program_env(&id).map(str::to_string),
            agent_id: id,
            display_name: entry.name.clone(),
            description: entry.description.clone(),
            presentation: directory_presentation::for_registry(&entry.id),
            registry_id: entry.id.clone(),
            first_batch_visible: crate::acp_client::first_release::first_batch_visible(&entry.id),
            installable: launch.is_some(),
            platform_available: registry_platform_available(entry),
            install_launch: launch,
            discovered: None,
            registry_version: Some(entry.version.clone()),
            install_guide: source_url
                .clone()
                .unwrap_or_else(|| "https://agentclientprotocol.com/get-started/registry".into()),
            source_url,
            icon: entry.icon.clone().filter(|url| url.starts_with("https://")),
            bundled_program: false,
            rollback_available: false,
        });
    }
    entries
}

fn current_catalog_entries(
    registered: &[AgentRow],
    discovered: &[DiscoveredBinary],
    registry: &[RegistryAgent],
) -> Vec<CatalogEntry> {
    let current = registry
        .iter()
        .filter(|entry| crate::acp_client::first_release::first_batch_visible(&entry.id))
        .cloned()
        .collect::<Vec<_>>();
    catalog_entries(registered, discovered, &current)
}

/// Probe binaries and refresh the registry cache in the background, then
/// tell the UI to re-read `catalog_list`. This is the only path that
/// touches the filesystem or the network.
#[tauri::command]
pub async fn catalog_scan(app: AppHandle) -> Result<Vec<DiscoveredBinary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let catalog = app.state::<AgentCatalog>();
        let found = catalog.refresh_blocking();
        crate::ui_transport::emit_event(
            &app,
            "catalog:updated",
            serde_json::json!({ "found": catalog.discovered_cached().map_or(0, |entries| entries.len()) }),
        );
        found
    })
    .await
    .map_err(|error| format!("catalog scan failed: {error}"))?
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
        let mut entries = current_catalog_entries(&registered, &discovered, &registry);
        for entry in &mut entries {
            entry.rollback_available = store
                .get_setting(&format!("installPrevious.{}", entry.agent_id))?
                .is_some_and(|value| value.is_object());
        }
        Ok(entries)
    })
    .await
    .map_err(|error| format!("catalog list failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_directory_filters_entries_without_changing_registered_data() {
        let registry = ["auggie", "fast-agent", "retired-agent", "unreviewed"]
            .into_iter()
            .map(|id| RegistryAgent {
                id: id.into(),
                name: "Same display name".into(),
                version: "future-version".into(),
                distribution: RegistryDistribution {
                    npx: Some(RegistryNpx {
                        package: "example-package".into(),
                        args: vec!["acp".into()],
                        env: std::collections::BTreeMap::new(),
                    }),
                    ..Default::default()
                },
                ..Default::default()
            })
            .collect::<Vec<_>>();
        let registered: AgentRow = serde_json::from_value(serde_json::json!({
            "id":"registry:retired-agent", "name":"Original", "source":"registry",
            "command":"/original/program", "args":["keep"], "env":[["PUBLIC_CONFIG","keep"]],
            "version":"old", "handshake":{"authMethods":[]}, "createdAt":1,"updatedAt":2
        }))
        .unwrap();
        let original = serde_json::to_value(&registered).unwrap();
        let entries = current_catalog_entries(std::slice::from_ref(&registered), &[], &registry);
        assert_eq!(entries.len(), builtin_defs().len() + 2);
        assert!(entries.iter().all(|entry| entry.first_batch_visible));
        assert!(
            entries
                .iter()
                .all(|entry| !matches!(entry.registry_id.as_str(), "retired-agent" | "unreviewed"))
        );
        assert_eq!(serde_json::to_value(&registered).unwrap(), original);
        assert_eq!(registry.len(), 4);
    }

    #[test]
    fn out_of_scope_installation_does_not_refresh_or_delete_saved_data() {
        let root = tempfile::tempdir().unwrap();
        let registry = vec![RegistryAgent {
            id: "retired-agent".into(),
            ..Default::default()
        }];
        write_registry_cache(root.path(), &registry);
        let original = std::fs::read(cache_path(root.path())).unwrap();
        let catalog = AgentCatalog::new(root.path().into());
        assert!(
            catalog
                .installation_entry("registry:retired-agent")
                .is_err()
        );
        assert!(catalog.cached_entry("registry:retired-agent").is_none());
        assert_eq!(std::fs::read(cache_path(root.path())).unwrap(), original);
        assert_eq!(catalog.agents_cached(), Some(registry));
    }

    #[test]
    fn sourced_presentation_survives_unavailable_installs_without_classifying_unknowns() {
        let registry = vec![
            RegistryAgent {
                id: "fast-agent".into(),
                name: "fast-agent".into(),
                ..Default::default()
            },
            RegistryAgent {
                id: "unknown".into(),
                name: "Codex".into(),
                ..Default::default()
            },
        ];
        let entries = catalog_entries(&[], &[], &registry);
        let codex = entries
            .iter()
            .find(|entry| entry.agent_id == "codex")
            .unwrap();
        assert!(codex.presentation.is_some());
        assert!(!codex.installable);
        assert!(codex.registered.is_none());
        let fast = entries
            .iter()
            .find(|entry| entry.registry_id == "fast-agent")
            .unwrap();
        assert!(fast.presentation.is_some());
        assert!(fast.install_launch.is_none());
        assert!(!fast.installable);
        assert_eq!(fast.platform_available, None);
        let unknown = entries
            .iter()
            .find(|entry| entry.registry_id == "unknown")
            .unwrap();
        assert!(unknown.presentation.is_none());
    }

    #[test]
    fn official_platform_archive_is_distinct_from_installer_support() {
        for id in ["archive-example", "opencode"] {
            let registry: Vec<RegistryAgent> = serde_json::from_value(serde_json::json!([{
                "id": id, "name": "Example", "website": "https://example.test",
                "distribution": {"binary": {(registry_platform()): {
                    "archive": "https://example.test/agent.tar.xz", "cmd": "./agent"
                }}}
            }]))
            .unwrap();
            let entries = catalog_entries(&[], &[], &registry);
            let entry = entries
                .iter()
                .find(|entry| entry.registry_id == id)
                .unwrap();
            let serialized = serde_json::to_value(entry).unwrap();
            assert_eq!(serialized["platformAvailable"], true);
            assert!(!entry.installable);
            assert!(registry_launch(&registry[0]).is_none());
            assert_eq!(entry.source_url.as_deref(), Some("https://example.test"));
        }
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn goose_bzip2_distribution_reaches_installation_entry() {
        // Observed official agentclientprotocol/registry goose/agent.json,
        // 2026-09-30. This is a catalog fixture, not a live download result.
        let registry: Vec<RegistryAgent> = serde_json::from_value(serde_json::json!([{
            "id": "goose", "name": "Goose", "version": "1.52.0",
            "distribution": {"binary": {"darwin-aarch64": {
                "archive": "https://github.com/block/goose/releases/download/v1.52.0/goose-aarch64-apple-darwin.tar.bz2",
                "cmd": "./goose", "args": ["acp"],
                "sha256": "10f7aca02d265750f43ec6948a63757ea372b1ef52b5c116f55b79d382769ae7"
            }}}
        }])).unwrap();
        let entries = catalog_entries(&[], &[], &registry);
        let card = entries
            .iter()
            .find(|entry| entry.registry_id == "goose")
            .unwrap();
        assert!(card.installable);
        let root = tempfile::tempdir().unwrap();
        write_registry_cache(root.path(), &registry);
        let catalog = AgentCatalog::new(root.path().into());
        let (retained, launch) = catalog.installation_entry(&card.agent_id).unwrap();
        assert_eq!(retained, registry[0]);
        assert_eq!(
            launch,
            AgentLaunch::Binary {
                binary: "./goose".into(),
                args: vec!["acp".into()]
            }
        );
    }

    #[test]
    fn supported_archive_urls_with_download_parameters_reach_the_installer() {
        for suffix in ["tar.gz", "tgz", "zip", "tar.bz2"] {
            let entry: RegistryAgent = serde_json::from_value(serde_json::json!({
                "id": "archive-example",
                "distribution": {"binary": {(registry_platform()): {
                    "archive": format!("https://example.test/agent.{suffix}?download=1#asset"),
                    "cmd": "./agent"
                }}}
            }))
            .unwrap();
            assert_eq!(
                registry_launch(&entry).is_some(),
                !(cfg!(windows) && suffix == "tar.bz2"),
                "{suffix}"
            );
        }
    }

    #[test]
    fn raw_executable_uses_windows_binary_route_and_retains_official_npm_fallback() {
        for command in ["./agent.exe", ".\\bin\\agent.exe"] {
            let entry: RegistryAgent = serde_json::from_value(serde_json::json!({
                "id":"raw-executable-example",
                "distribution": {
                    "binary": {(registry_platform()): {
                        "archive":"https://example.test/agent.exe?download=1#asset",
                        "cmd":command,"args":["acp"]
                    }},
                    "npx":{"package":"example-agent@1.0.0"}
                }
            }))
            .unwrap();
            assert_eq!(
                registry_launch(&entry),
                Some(if cfg!(windows) {
                    AgentLaunch::Binary {
                        binary: command.into(),
                        args: vec!["acp".into()],
                    }
                } else {
                    AgentLaunch::Npx {
                        package: "example-agent@1.0.0".into(),
                        args: vec![],
                    }
                })
            );
            for invalid in [
                "../agent.exe",
                "C:\\agent.exe",
                "./CON.exe",
                "./agent.exe:stream",
            ] {
                let mut invalid_entry = entry.clone();
                invalid_entry
                    .distribution
                    .binary
                    .as_mut()
                    .unwrap()
                    .get_mut(registry_platform())
                    .unwrap()
                    .cmd = invalid.into();
                assert!(matches!(
                    registry_launch(&invalid_entry),
                    Some(AgentLaunch::Npx { .. })
                ));
            }
        }
    }

    #[test]
    fn uvx_distribution_survives_cache_and_exposes_a_valid_install_route() {
        let root = tempfile::tempdir().unwrap();
        let declaration = serde_json::json!({"package": "example-agent==1.2.3", "args": ["-x"],
            "env": {"AGENT_MODEL": "default"}, "python": "3.13"});
        let registry: Vec<RegistryAgent> = serde_json::from_value(serde_json::json!([{
            "id": "uvx-example", "distribution": {"uvx": declaration}
        }]))
        .unwrap();
        write_registry_cache(root.path(), &registry);
        let retained = read_registry_cache(root.path()).unwrap().1;
        assert_eq!(
            serde_json::to_value(&retained[0]).unwrap()["distribution"]["uvx"],
            declaration
        );
        let entries = catalog_entries(&[], &[], &retained);
        let entry = entries
            .iter()
            .find(|entry| entry.registry_id == "uvx-example")
            .unwrap();
        assert_eq!(
            serde_json::to_value(entry).unwrap()["platformAvailable"],
            true
        );
        assert!(entry.installable);
        assert!(matches!(
            entry.install_launch,
            Some(AgentLaunch::Uvx { .. })
        ));
    }

    #[test]
    fn official_uvx_entries_reach_installation_without_npx_or_brand_guessing() {
        // Official registry shapes observed 2026-09-30; cache fixtures are not
        // evidence of a live fetch, package installation or actual response.
        let registry: Vec<RegistryAgent> = serde_json::from_value(serde_json::json!([
            {"id":"fast-agent","version":"0.10.1","distribution":{"uvx":{
                "package":"fast-agent-acp==0.10.1","args":["-x"],"env":{"FAST_AGENT_MODEL":"fixture-declared-model"}}}}
        ])).unwrap();
        let root = tempfile::tempdir().unwrap();
        write_registry_cache(root.path(), &registry);
        let catalog = AgentCatalog::new(root.path().into());
        for entry in &registry {
            let id = registry_agent_id(entry).unwrap();
            let (retained, launch) = catalog.installation_entry(&id).unwrap();
            let declaration =
                RegistryUvx::decode(entry.distribution.uvx.as_ref().unwrap()).unwrap();
            assert_eq!(retained, *entry);
            assert_eq!(
                launch,
                AgentLaunch::Uvx {
                    package: declaration.package,
                    args: declaration.args
                }
            );
            assert!(crate::uv_runtime::declared(&catalog, &id));
        }
        assert_eq!(
            catalog
                .cached_entry("registry:fast-agent")
                .unwrap()
                .distribution
                .uvx
                .unwrap()["env"]["FAST_AGENT_MODEL"],
            "fixture-declared-model"
        );
    }

    #[test]
    fn unsupported_platform_and_unknown_catalog_have_different_install_reasons() {
        let root = tempfile::tempdir().unwrap();
        let registry: Vec<RegistryAgent> = serde_json::from_value(serde_json::json!([
            {"id":"poolside","distribution":{"binary":{"windows-x86_64":{"archive":"https://example.test/agent.zip","cmd":"agent.exe"}}}},
            {"id":"fast-agent","distribution":{"uvx":{"package":"example @ https://example.test/tool.whl"}}},
            {"id":"unknown","distribution":{}}
        ])).unwrap();
        write_registry_cache(root.path(), &registry);
        let catalog = AgentCatalog::new(root.path().into());
        assert_eq!(
            catalog.installation_entry("registry:poolside").unwrap_err(),
            "官方目录未提供适用于此设备的安装方式，请查看官方说明"
        );
        assert_eq!(
            catalog
                .installation_entry("registry:fast-agent")
                .unwrap_err(),
            "Farfold 当前尚不能安装此条目，请查看官方说明或添加已安装的程序"
        );
        let entries = catalog_entries(&[], &[], &registry);
        for id in ["unknown", "codex-acp"] {
            let entry = entries
                .iter()
                .find(|entry| entry.registry_id == id)
                .unwrap();
            assert!(serde_json::to_value(entry).unwrap()["platformAvailable"].is_null());
        }
    }

    #[test]
    fn full_registry_keeps_builtins_and_distinguishes_platform_support() {
        let registry: Vec<RegistryAgent> = serde_json::from_value(serde_json::json!([
            {"id":"codex-acp","name":"Codex","distribution":{"npx":{"package":"codex-example@1.0.0"}}},
            {"id":"example","name":"Example","website":"https://example.test","distribution":{"npx":{"package":"example-agent@1.0.0","env":{"AGENT_MODE":"acp"}}}},
            {"id":"windows-only","name":"Windows only","distribution":{"binary":{"windows-x86_64":{"archive":"https://example.test/agent.zip","cmd":"agent.exe"}}}},
            {"id":"../escape","name":"Invalid path","distribution":{"npx":{"package":"example@1"}}}
        ])).unwrap();
        let entries = catalog_entries(&[], &[], &registry);
        assert_eq!(entries.len(), 5);
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.agent_id == "codex")
                .count(),
            1
        );
        let generic = entries
            .iter()
            .find(|entry| entry.agent_id == "registry:example")
            .unwrap();
        assert!(generic.installable);
        assert_eq!(generic.platform_available, Some(true));
        assert_eq!(generic.source_url.as_deref(), Some("https://example.test"));
        let windows = entries
            .iter()
            .find(|entry| entry.agent_id == "registry:windows-only")
            .unwrap();
        assert!(!windows.installable);
        assert_eq!(windows.platform_available, Some(false));
        assert!(windows.install_launch.is_none());
        assert_eq!(
            registry[1].distribution.npx.as_ref().unwrap().env["AGENT_MODE"],
            "acp"
        );
    }

    #[test]
    fn install_selection_only_uses_published_entries_and_respects_home() {
        let root = tempfile::tempdir().unwrap();
        let catalog = AgentCatalog::new(root.path().into());
        let registry: Vec<RegistryAgent> = serde_json::from_value(serde_json::json!([
            {"id":"auggie","name":"Example","distribution":{"npx":{"package":"example-agent@1.2.3","args":["--agent"]}}},
            {"id":"nova","distribution":{"npx":{"package":"example@1.0.0","env":{"HOME":"/private"}}}}
        ])).unwrap();
        write_registry_cache(root.path(), &registry);
        let (entry, launch) = catalog.installation_entry("registry:auggie").unwrap();
        assert_eq!(entry.id, "auggie");
        assert_eq!(
            launch,
            AgentLaunch::Npx {
                package: "example-agent@1.2.3".into(),
                args: vec!["--agent".into()]
            }
        );
        assert!(catalog.installation_entry("auggie").is_err());
        assert!(catalog.installation_entry("registry:unknown").is_err());
        assert!(catalog.installation_entry("registry:nova").is_err());
    }

    fn fixture_registry(version: &str) -> Vec<RegistryAgent> {
        vec![RegistryAgent {
            id: "codex-acp".into(),
            version: version.into(),
            ..Default::default()
        }]
    }

    #[test]
    fn registry_retention_keeps_stale_memory_when_disk_is_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        let catalog = AgentCatalog::new(directory.path().to_path_buf());
        let entries = fixture_registry("2.0.0");
        *catalog.registry.lock().unwrap() = Some((0, entries.clone()));
        std::fs::write(cache_path(directory.path()), "incomplete cache").unwrap();
        assert_eq!(catalog.agents_with(|| Err("offline".into())), Some(entries));
    }

    #[test]
    fn registry_retention_uses_the_newest_verified_cache() {
        let directory = tempfile::tempdir().unwrap();
        let catalog = AgentCatalog::new(directory.path().to_path_buf());
        let newer = fixture_registry("2.0.0");
        let older = RegistryCache {
            fetched_at: 1,
            source: REGISTRY_URL.into(),
            agents: fixture_registry("1.0.0"),
        };
        *catalog.registry.lock().unwrap() = Some((2, newer.clone()));
        std::fs::write(
            cache_path(directory.path()),
            serde_json::to_vec(&older).unwrap(),
        )
        .unwrap();
        assert_eq!(catalog.agents_with(|| Err("offline".into())), Some(newer));
        let newest = fixture_registry("3.0.0");
        write_registry_cache(directory.path(), &newest);
        assert_eq!(catalog.agents_cached(), Some(newest));
    }

    #[test]
    fn registry_retention_scan_reports_unavailable_registry_without_losing_discovery() {
        let directory = tempfile::tempdir().unwrap();
        let catalog = AgentCatalog::new(directory.path().to_path_buf());
        let found = vec![DiscoveredBinary {
            agent_id: "opencode".into(),
            path: "/fixture/opencode".into(),
            version: None,
        }];
        let result = catalog.refresh_with(found.clone(), || Err("offline".into()));
        assert_eq!(catalog.discovered_cached(), Some(found));
        assert_eq!(result, Err("offline".into()));
    }

    #[test]
    fn registry_retention_scan_accepts_known_cache_when_offline() {
        let directory = tempfile::tempdir().unwrap();
        let catalog = AgentCatalog::new(directory.path().to_path_buf());
        let entries = fixture_registry("2.0.0");
        *catalog.registry.lock().unwrap() = Some((0, entries.clone()));
        assert!(
            catalog
                .refresh_with(vec![], || Err("offline".into()))
                .is_ok()
        );
        assert_eq!(catalog.agents_cached(), Some(entries));
    }

    #[test]
    fn access_regression_registry_cache_survives_catalog_restart() {
        let directory = tempfile::tempdir().unwrap();
        let entries = vec![RegistryAgent {
            id: "fixture".into(),
            version: "9.8.7".into(),
            ..Default::default()
        }];
        write_registry_cache(directory.path(), &entries);
        let restarted = AgentCatalog::new(directory.path().to_path_buf());
        assert_eq!(restarted.agents_cached(), Some(entries));
    }

    #[test]
    fn stale_registry_survives_network_failure_without_version_fallbacks() {
        let directory = tempfile::tempdir().unwrap();
        let entries = vec![RegistryAgent {
            id: "codex-acp".into(),
            version: "99.0.0".into(),
            ..Default::default()
        }];
        let cache = RegistryCache {
            fetched_at: 0,
            source: REGISTRY_URL.into(),
            agents: entries.clone(),
        };
        std::fs::write(
            cache_path(directory.path()),
            serde_json::to_vec(&cache).unwrap(),
        )
        .unwrap();
        let catalog = AgentCatalog::new(directory.path().to_path_buf());
        assert_eq!(
            catalog.agents_with(|| Err("offline".into())),
            Some(entries.clone())
        );
        std::fs::write(cache_path(directory.path()), "incomplete cache").unwrap();
        assert_eq!(
            catalog.agents_with(|| Err("offline".into())),
            Some(entries.clone())
        );
        std::fs::remove_file(cache_path(directory.path())).unwrap();
        assert_eq!(catalog.agents_with(|| Err("offline".into())), Some(entries));
        let restarted = AgentCatalog::new(directory.path().to_path_buf());
        assert!(restarted.agents_with(|| Err("offline".into())).is_none());
    }

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
