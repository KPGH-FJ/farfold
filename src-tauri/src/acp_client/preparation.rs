//! Verified preparation data, separate from registry distributions and ACP admission.
//! Sources checked 2026-09-26: ampcode.com/install.sh and the linked public docs.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::agent_discovery::{find_binary, version_output};
use crate::meta_store::{AgentRow, MetaStore};

pub(crate) use super::recipes::{DependencyDeclaration, dependencies};
use super::recipes::{declared_for, support_for, verified_for};
use super::versions::{RequirementState, public_version, requirement_state};

/// A declared program path is not a credential or a new application env switch.
pub(crate) fn program_env(agent_id: &str) -> Option<&'static str> {
    dependencies(agent_id)
        .first()
        .map(|dependency| dependency.program_env)
        .or_else(|| crate::agent_catalog::def_for(agent_id)?.discovered_cli_env)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DependencyStatus {
    Ready,
    Missing,
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationDependency {
    pub id: String,
    pub name: String,
    pub status: DependencyStatus,
    pub detail: String,
    pub source_url: String,
    pub installable: bool,
    pub managed_location: String,
    pub check_command: String,
    pub required_for_install: bool,
    pub required_for_use: bool,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub version_diagnostic: Option<ProgramVersionDiagnostic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialVersionRequirement {
    pub component_version: String,
    pub range: String,
    pub source_url: String,
    pub state: RequirementState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramVersionDiagnostic {
    pub program_version: Option<String>,
    pub component_version: Option<String>,
    pub version_requirement: Option<OfficialVersionRequirement>,
    pub can_install_candidate: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationLink {
    pub label: &'static str,
    pub url: &'static str,
    pub kind: &'static str,
    pub method_ids: &'static [&'static str],
    pub description: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationInfo {
    pub dependencies: Vec<PreparationDependency>,
    pub links: Vec<PreparationLink>,
}

// Public account guidance, verified 2026-09-28. These links never authenticate
// an Agent or prove account entitlement. Only declared method IDs select a route.
// Sources: code.claude.com/docs/en/authentication;
// docs.cline.bot/getting-started/authorizing-with-cline and /clinepass;
// github.com/cline/cline/blob/main/apps/cli/src/acp/auth.ts;
// opencode.ai/docs/providers; developers.openai.com/codex/auth.
fn links(agent_id: &str) -> Vec<PreparationLink> {
    let link = |label: &'static str,
                url: &'static str,
                kind: &'static str,
                method_ids: &'static [&'static str],
                description: &'static str| PreparationLink {
        label,
        url,
        kind,
        method_ids,
        description,
    };
    match agent_id {
        "registry:amp-acp" => vec![
            link(
                "注册/登录并获取密钥",
                "https://ampcode.com/settings",
                "account",
                &[],
                "",
            ),
            link(
                "官方安装说明",
                "https://ampcode.com/docs/cli",
                "documentation",
                &[],
                "",
            ),
        ],
        "registry:qwen-code" => vec![link(
            "获取账号和密钥",
            "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/",
            "documentation",
            &[],
            "请按官方说明选择账号或 API 服务。",
        )],
        "opencode" | "registry:opencode" => vec![link(
            "查看账号与服务说明",
            "https://opencode.ai/docs/providers",
            "documentation",
            &["opencode-login"],
            "按实际选择的服务准备账号。不同服务的账号、权益和费用分别确认。",
        )],
        "registry:claude-acp" => vec![
            link(
                "准备 Claude 账号",
                "https://claude.ai",
                "account",
                &["claude-ai-login"],
                "此方式使用 Claude 订阅账号；账号权益以官方说明为准。",
            ),
            link(
                "查看 Claude 账号说明",
                "https://code.claude.com/docs/en/authentication",
                "documentation",
                &["claude-ai-login", "console-login"],
                "",
            ),
            link(
                "打开 Anthropic Console",
                "https://platform.claude.com",
                "account",
                &["console-login"],
                "此方式使用 Anthropic Console 账号，与 Claude 订阅分别确认。",
            ),
        ],
        "registry:cline" => vec![
            link(
                "准备 Cline 账号",
                "https://app.cline.bot",
                "account",
                &["cline", "cline-pass"],
                "Cline 与 ClinePass 使用 Cline 账号，服务权益仍需分别确认。",
            ),
            link(
                "查看 ClinePass 说明",
                "https://docs.cline.bot/getting-started/clinepass",
                "documentation",
                &["cline-pass"],
                "",
            ),
            link(
                "准备 ChatGPT 账号",
                "https://chatgpt.com",
                "account",
                &["openai-codex"],
                "此方式由 Agent 使用 ChatGPT 账号登录，是否具备所需权益以官方说明为准。",
            ),
        ],
        "codex" | "registry:codex-acp" => vec![link(
            "查看账号登录说明",
            "https://developers.openai.com/codex/auth",
            "documentation",
            &[],
            "ChatGPT 账号与 API 服务的使用方式、权益和费用分别确认。",
        )],
        _ => vec![],
    }
}

fn resolve_in(
    declaration: &DependencyDeclaration,
    row: Option<&AgentRow>,
    dirs: &[PathBuf],
    home: Option<&Path>,
    inherited: Option<&str>,
) -> Option<PathBuf> {
    // An explicit broken selection must never silently fall back to another CLI.
    if let Some((_, path)) = row.and_then(|row| {
        row.env
            .iter()
            .find(|(name, _)| name == declaration.program_env)
    }) {
        return Some(PathBuf::from(path));
    }
    if let Some(path) = inherited {
        return Some(PathBuf::from(path));
    }
    find_binary(declaration.binary, dirs).or_else(|| {
        let candidate = home?
            .join(declaration.home_bin_dir)
            .join(declaration.binary);
        candidate.exists().then_some(candidate)
    })
}

pub(crate) fn resolve_dependency(
    declaration: &DependencyDeclaration,
    row: Option<&AgentRow>,
) -> Option<PathBuf> {
    let env = crate::shell_env::command_env();
    let dirs = env
        .get("PATH")
        .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
        .unwrap_or_default();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    resolve_in(
        declaration,
        row,
        &dirs,
        home.as_deref(),
        env.get(declaration.program_env).map(String::as_str),
    )
}

fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_absolute()
        && path.is_file()
        && std::fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

/// Launch-copy only; never changes a user's selected path or external config.
pub(crate) fn apply_dependency_env(row: &mut AgentRow) {
    for declaration in verified_for(row) {
        if row
            .env
            .iter()
            .any(|(name, _)| name == declaration.program_env)
        {
            continue;
        }
        if let Some(path) = resolve_dependency(declaration, Some(row)) {
            row.env.push((
                declaration.program_env.into(),
                path.to_string_lossy().into_owned(),
            ));
        }
    }
}

/// A first-message preparation guard, not an initialize compatibility gate.
/// No external process or credential access is performed here.
pub(crate) fn require_dependencies(row: &AgentRow) -> Result<(), String> {
    for declaration in verified_for(row) {
        match resolve_dependency(declaration, Some(row)) {
            Some(path) if executable(&path) => {}
            Some(_) => {
                return Err(format!(
                    "{} 不可用，请在 Agent 准备中检查所选程序",
                    declaration.name
                ));
            }
            None => {
                return Err(format!(
                    "缺少 {}，请在 Agent 准备中安装所需程序，或选择已有程序",
                    declaration.name
                ));
            }
        }
    }
    Ok(())
}

#[derive(PartialEq)]
struct FileStamp {
    canonical: PathBuf,
    length: u64,
    modified: Option<SystemTime>,
    mode: u32,
}
#[derive(Clone)]
struct ProgramObservation {
    executable: bool,
    check_succeeded: bool,
    version: Option<String>,
}
type ProbeCache = HashMap<PathBuf, (FileStamp, ProgramObservation)>;

/// No version allowlist and no executable digest. Only rerun after the file changes.
pub(crate) fn check_program(
    path: &Path,
    check: impl Fn() -> Result<(), String>,
) -> Result<bool, String> {
    observe_program(path, false, check).map(|observation| observation.check_succeeded)
}

pub(crate) fn fresh_program_version(
    path: &Path,
    check: impl Fn() -> Result<(), String>,
) -> Result<Option<String>, String> {
    observe_program(path, true, check).map(|observation| observation.version)
}

fn observe_program(
    path: &Path,
    refresh: bool,
    check: impl Fn() -> Result<(), String>,
) -> Result<ProgramObservation, String> {
    use std::os::unix::fs::PermissionsExt;
    check()?;
    if !executable(path) {
        return Ok(ProgramObservation {
            executable: false,
            check_succeeded: false,
            version: None,
        });
    }
    let metadata = std::fs::metadata(path).map_err(|_| "无法读取所选程序")?;
    let stamp = FileStamp {
        canonical: path.canonicalize().map_err(|_| "无法读取所选程序位置")?,
        length: metadata.len(),
        modified: metadata.modified().ok(),
        mode: metadata.permissions().mode(),
    };
    static CACHE: OnceLock<Mutex<ProbeCache>> = OnceLock::new();
    let mut cache = loop {
        check()?;
        match CACHE.get_or_init(Default::default).try_lock() {
            Ok(cache) => break cache,
            Err(std::sync::TryLockError::Poisoned(_)) => return Err("程序检查暂时不可用".into()),
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(Duration::from_millis(20))
            }
        }
    };
    if !refresh
        && let Some((previous, observation)) = cache.get(path)
        && previous == &stamp
    {
        return Ok(observation.clone());
    }
    let output = version_output(path, Duration::from_secs(5), &check)?;
    let observation = ProgramObservation {
        executable: true,
        check_succeeded: output.as_ref().is_some_and(|text| !text.is_empty()),
        version: output.as_deref().and_then(public_version),
    };
    check()?;
    if cache.len() >= 128 {
        cache.clear();
    }
    cache.insert(path.into(), (stamp, observation.clone()));
    Ok(observation)
}

#[cfg(test)]
fn preparation_info(
    agent_id: &str,
    row: Option<&AgentRow>,
    app_data: &Path,
) -> Result<PreparationInfo, String> {
    preparation_info_refresh(agent_id, row, app_data, false)
}

fn preparation_info_refresh(
    agent_id: &str,
    row: Option<&AgentRow>,
    app_data: &Path,
    refresh: bool,
) -> Result<PreparationInfo, String> {
    let mut result = Vec::new();
    let declarations = row.map_or_else(|| dependencies(agent_id), declared_for);
    for declaration in declarations {
        let path = resolve_dependency(declaration, row);
        // A support warning is independent of executable availability. Probe
        // declared diagnostic programs afresh, including their managed launcher
        // dependencies, rather than caching only the wrapper's own file stamp.
        let observation = path
            .as_deref()
            .map(|path| observe_program(path, refresh || declaration.support.is_some(), || Ok(())))
            .transpose()?;
        let status = match observation.as_ref() {
            None => DependencyStatus::Missing,
            Some(observed)
                if if declaration.support.is_some() {
                    observed.executable
                } else {
                    observed.check_succeeded
                } =>
            {
                DependencyStatus::Ready
            }
            Some(_) => DependencyStatus::Failed,
        };
        let version_diagnostic = declaration.support.map(|_| {
            let component_version = row.and_then(super::recipes::component_version);
            let support =
                row.and_then(|row| support_for(declaration, row, component_version.as_deref()));
            let program_version = observation
                .as_ref()
                .and_then(|observed| observed.version.clone());
            let version_requirement = support.map(|support| OfficialVersionRequirement {
                component_version: support.component_version.into(),
                range: support.range.into(),
                source_url: support.source_url.into(),
                state: requirement_state(program_version.as_deref(), support.range),
            });
            ProgramVersionDiagnostic {
                program_version,
                component_version,
                can_install_candidate: row.is_some() && support.is_some(),
                version_requirement,
            }
        });
        let explanation = match status {
            DependencyStatus::Ready
                if declaration.support.is_some()
                    && observation
                        .as_ref()
                        .is_some_and(|observed| observed.version.is_none()) =>
            {
                "已找到可执行程序，但版本暂时无法核对；仍可尝试连接"
            }
            DependencyStatus::Ready => "程序检查通过；账号与回复仍需验证",
            DependencyStatus::Missing if row.is_none() => {
                "请先安装此 Agent，随后安装所需程序或选择已有程序"
            }
            DependencyStatus::Missing => "尚未找到所需程序，可以安装或选择已有程序",
            DependencyStatus::Failed => "已选或已找到的程序检查未通过，请检查程序位置与执行权限",
        };
        let command = path
            .as_ref()
            .map(|path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''")))
            .unwrap_or_else(|| declaration.binary.into());
        result.push(PreparationDependency {
            id: declaration.id.into(),
            name: declaration.name.into(),
            installable: row.is_some()
                && status == DependencyStatus::Missing
                && declaration.support.is_none(),
            status,
            detail: format!("{explanation}。依据 Farfold 核对的官方安装说明，独立于目录安装包。"),
            source_url: declaration.source_url.into(),
            managed_location: app_data.join("agents").join(agent_id).display().to_string(),
            check_command: format!("{command} --version"),
            required_for_install: false,
            required_for_use: declaration.support.is_none()
                || version_diagnostic
                    .as_ref()
                    .is_some_and(|diagnostic| diagnostic.version_requirement.is_some()),
            version_diagnostic,
        });
    }
    Ok(PreparationInfo {
        dependencies: result,
        links: links(agent_id),
    })
}

pub(crate) fn preparation_with_catalog(
    agent_id: &str,
    row: Option<&AgentRow>,
    app_data: &Path,
    catalog: &crate::agent_catalog::AgentCatalog,
) -> Result<PreparationInfo, String> {
    preparation_with_catalog_refresh(agent_id, row, app_data, catalog, false)
}

fn preparation_with_catalog_refresh(
    agent_id: &str,
    row: Option<&AgentRow>,
    app_data: &Path,
    catalog: &crate::agent_catalog::AgentCatalog,
    refresh: bool,
) -> Result<PreparationInfo, String> {
    let mut info = preparation_info_refresh(agent_id, row, app_data, refresh)?;
    if crate::uv_runtime::declared(catalog, agent_id) {
        info.dependencies
            .extend(crate::uv_runtime::preparation(app_data)?);
    }
    Ok(info)
}

#[tauri::command]
pub async fn agent_preparation(
    app: AppHandle,
    agent_id: String,
    refresh: Option<bool>,
) -> Result<PreparationInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = app.path().app_data_dir().map_err(|_| "无法读取安装目录")?;
        let row = app.state::<MetaStore>().get_agent(&agent_id)?;
        preparation_with_catalog_refresh(
            &agent_id,
            row.as_ref(),
            &data,
            &app.state::<crate::agent_catalog::AgentCatalog>(),
            refresh.unwrap_or(false),
        )
    })
    .await
    .map_err(|_| "准备信息读取失败，请重试".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn row(id: &str) -> AgentRow {
        AgentRow {
            id: id.into(),
            name: id.into(),
            source: "custom".into(),
            command: "/fixture/agent".into(),
            args: vec![],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn installed_uvx_agent_remains_usable_without_registry_cache() {
        let data = tempfile::tempdir().unwrap();
        let catalog = crate::agent_catalog::AgentCatalog::new(data.path().into());
        let installed = row("registry:minion-code");
        let info = preparation_with_catalog(&installed.id, Some(&installed), data.path(), &catalog)
            .unwrap();
        assert!(info.dependencies.is_empty());
        assert!(require_dependencies(&installed).is_ok());
        assert!(!data.path().join("registry-cache.json").exists());
    }

    #[test]
    fn catalog_uvx_preparation_is_available_before_registration_and_only_gates_installation() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("registry-cache.json"), serde_json::to_vec(&serde_json::json!({
            "fetchedAt":0,"source":crate::agent_catalog::REGISTRY_URL,"agents":[{
                "id":"minion-code","distribution":{"uvx":{"package":"minion-code@0.1.44","args":["acp"]}}
            }]
        })).unwrap()).unwrap();
        let catalog = crate::agent_catalog::AgentCatalog::new(data.path().into());
        let info =
            preparation_with_catalog("registry:minion-code", None, data.path(), &catalog).unwrap();
        assert_eq!(info.dependencies.len(), 2);
        assert!(
            info.dependencies
                .iter()
                .all(|dependency| dependency.installable
                    && dependency.required_for_install
                    && !dependency.required_for_use)
        );
        assert!(!data.path().join("uv").exists());
        assert!(!data.path().join("python").exists());
    }

    #[test]
    fn official_account_routes_are_scoped_to_the_declared_method() {
        let claude = links("registry:claude-acp");
        let account = claude
            .iter()
            .find(|link| link.url == "https://claude.ai")
            .unwrap();
        assert_eq!(account.method_ids, ["claude-ai-login"]);
        let console = claude
            .iter()
            .find(|link| link.url == "https://platform.claude.com")
            .unwrap();
        assert_eq!(console.method_ids, ["console-login"]);
        let cline = links("registry:cline");
        let chatgpt = cline
            .iter()
            .find(|link| link.url == "https://chatgpt.com")
            .unwrap();
        assert_eq!(chatgpt.method_ids, ["openai-codex"]);
        let opencode = links("opencode");
        assert!(opencode.iter().all(|link| link.kind == "documentation"));
        assert!(links("custom-unknown").is_empty());
    }

    #[test]
    fn unknown_agents_remain_unrestricted_and_account_links_are_public() {
        let unknown = row("custom-unknown");
        assert!(require_dependencies(&unknown).is_ok());
        assert!(
            preparation_info(&unknown.id, Some(&unknown), Path::new("/fixture"))
                .unwrap()
                .dependencies
                .is_empty()
        );
        for id in ["registry:amp-acp", "registry:qwen-code"] {
            assert!(
                links(id)
                    .iter()
                    .all(|link| link.url.starts_with("https://"))
            );
        }
    }

    #[test]
    fn migrated_native_amp_without_a_component_version_still_requires_its_program() {
        let root = tempfile::tempdir().unwrap();
        let mut agent = row("registry:amp-acp");
        agent.source = "registry".into();
        agent.command = "/managed/amp-acp".into();
        agent.env.push((
            "AMP_CLI_PATH".into(),
            root.path().join("missing-selected").display().to_string(),
        ));
        assert!(agent.version.is_none());
        assert!(require_dependencies(&agent).is_err());
        let info = preparation_info(&agent.id, Some(&agent), root.path()).unwrap();
        assert_eq!(info.dependencies.len(), 1);
        assert_eq!(info.dependencies[0].id, "amp-cli");
        assert!(info.dependencies[0].version_diagnostic.is_none());
        assert!(
            serde_json::to_value(&info.dependencies[0])
                .unwrap()
                .get("programVersion")
                .is_none()
        );
    }

    #[test]
    fn selected_broken_path_never_falls_back_or_gets_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let mut agent = super::super::recipes::tests::official_row(
            root.path(),
            "registry:amp-acp",
            "amp-acp",
            "1.0.0",
        );
        agent
            .env
            .push(("AMP_CLI_PATH".into(), "/missing/selected-program".into()));
        let original = agent.clone();
        apply_dependency_env(&mut agent);
        assert_eq!(agent, original);
        assert!(require_dependencies(&agent).is_err());
        let dep = &dependencies(&agent.id)[0];
        assert_eq!(
            resolve_in(
                dep,
                Some(&agent),
                &[PathBuf::from("/bin")],
                None,
                Some("/bin/sh")
            ),
            Some(PathBuf::from("/missing/selected-program"))
        );
        let info = preparation_info(&agent.id, Some(&agent), Path::new("/fixture")).unwrap();
        assert_eq!(info.dependencies[0].status, DependencyStatus::Failed);
        assert!(!info.dependencies[0].installable);
    }

    #[test]
    fn version_probe_is_cached_and_rechecks_changed_file_without_a_version_allowlist() {
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("program");
        let count = root.path().join("count");
        std::fs::write(
            &program,
            format!(
                "#!/bin/sh\nprintf x >> '{}'\nprintf '2099.0.0\\n'\n",
                count.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(check_program(&program, || Ok(())).unwrap());
        assert!(check_program(&program, || Ok(())).unwrap());
        assert_eq!(std::fs::read_to_string(&count).unwrap(), "x");
        std::fs::write(&program, "#!/bin/sh\nexit 7\n").unwrap();
        assert!(!check_program(&program, || Ok(())).unwrap());
        assert!(check_program(&program, || Err("cancelled".into())).is_err());
    }

    #[test]
    fn dependency_guard_only_checks_paths_and_never_executes_the_program() {
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("program");
        let marker = root.path().join("must-not-exist");
        std::fs::write(
            &program,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut agent = super::super::recipes::tests::official_row(
            root.path(),
            "registry:amp-acp",
            "amp-acp",
            "1.0.0",
        );
        agent
            .env
            .push(("AMP_CLI_PATH".into(), program.display().to_string()));
        assert!(require_dependencies(&agent).is_ok());
        assert!(!marker.exists());
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(require_dependencies(&agent).is_err());
        assert!(!marker.exists());
    }

    #[test]
    fn declared_standard_location_is_used_without_changing_home() {
        let home = tempfile::tempdir().unwrap();
        let declaration = &super::super::recipes::AMP_DEPENDENCIES[0];
        let path = home
            .path()
            .join(declaration.home_bin_dir)
            .join(declaration.binary);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "fixture").unwrap();
        assert_eq!(
            resolve_in(declaration, None, &[], Some(home.path()), None),
            Some(path)
        );
    }

    fn version_fixture(root: &Path, version: &str) -> PathBuf {
        let path = root.join("program");
        std::fs::write(&path, format!("#!/bin/sh\nprintf '%s\\n' '{version}'\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn supported_scope_reports_old_program_without_blocking_executable_use() {
        let root = tempfile::tempdir().unwrap();
        let mut agent =
            super::super::recipes::tests::official_row(root.path(), "pi", "pi-acp", "0.0.34");
        let program = version_fixture(root.path(), "0.80.5");
        agent
            .env
            .push(("PI_ACP_PI_COMMAND".into(), program.display().to_string()));
        let info = preparation_info(&agent.id, Some(&agent), root.path()).unwrap();
        let dependency = &info.dependencies[0];
        assert_eq!(dependency.status, DependencyStatus::Ready);
        assert!(!dependency.installable);
        let diagnostic = dependency.version_diagnostic.as_ref().unwrap();
        assert_eq!(diagnostic.program_version.as_deref(), Some("0.80.5"));
        assert_eq!(diagnostic.component_version.as_deref(), Some("0.0.34"));
        assert_eq!(
            diagnostic.version_requirement.as_ref().unwrap().state,
            RequirementState::Unsatisfied
        );
        assert!(diagnostic.can_install_candidate);
        assert!(require_dependencies(&agent).is_ok());
        let value = serde_json::to_value(dependency).unwrap();
        assert_eq!(value["programVersion"], "0.80.5");
        assert_eq!(value["versionRequirement"]["state"], "unsatisfied");
    }

    #[test]
    fn unknown_version_or_new_component_has_no_invented_requirement_gate() {
        let root = tempfile::tempdir().unwrap();
        let mut agent =
            super::super::recipes::tests::official_row(root.path(), "pi", "pi-acp", "0.0.34");
        let program = version_fixture(root.path(), "unknown-output");
        agent
            .env
            .push(("PI_ACP_PI_COMMAND".into(), program.display().to_string()));
        let info = preparation_info(&agent.id, Some(&agent), root.path()).unwrap();
        let dependency = &info.dependencies[0];
        assert_eq!(dependency.status, DependencyStatus::Ready);
        assert!(dependency.detail.contains("版本暂时无法核对"));
        assert_eq!(
            dependency
                .version_diagnostic
                .as_ref()
                .unwrap()
                .version_requirement
                .as_ref()
                .unwrap()
                .state,
            RequirementState::Unknown
        );
        agent.version = Some("0.0.35".into());
        agent.env[0].1 = root.path().join("missing-program").display().to_string();
        let info = preparation_info(&agent.id, Some(&agent), root.path()).unwrap();
        assert!(!info.dependencies[0].required_for_use);
        let diagnostic = info.dependencies[0].version_diagnostic.as_ref().unwrap();
        assert!(diagnostic.version_requirement.is_none());
        assert!(!diagnostic.can_install_candidate);
        assert!(require_dependencies(&agent).is_ok());
        let original = agent.clone();
        apply_dependency_env(&mut agent);
        assert_eq!(agent, original);
        agent.source = "custom".into();
        assert!(
            preparation_info(&agent.id, Some(&agent), root.path())
                .unwrap()
                .dependencies
                .is_empty()
        );
    }

    #[test]
    fn explicit_refresh_reads_new_version_without_relying_on_only_a_launcher_stamp() {
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("program");
        let value = root.path().join("reported-version");
        std::fs::write(&program, format!("#!/bin/sh\ncat '{}'\n", value.display())).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(&value, "1.0.0\n").unwrap();
        assert_eq!(
            observe_program(&program, false, || Ok(()))
                .unwrap()
                .version
                .as_deref(),
            Some("1.0.0")
        );
        std::fs::write(&value, "1.0.1\n").unwrap();
        assert_eq!(
            observe_program(&program, false, || Ok(()))
                .unwrap()
                .version
                .as_deref(),
            Some("1.0.0")
        );
        assert_eq!(
            observe_program(&program, true, || Ok(()))
                .unwrap()
                .version
                .as_deref(),
            Some("1.0.1")
        );
    }
}
