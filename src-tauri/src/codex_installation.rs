//! Inspect and register user-owned Codex programs. Never install or upgrade the
//! CLI, import authentication/history, or start an Agent task from this surface.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use crate::runtime_registry::file_sha256;

const VERSION: &str = "0.143.0";
const NATIVE_SHA: &str = "9070e47d422129106bc41ca651a9998b06a6c55bd42a7c3362b48f1d2850766f";
const LAUNCHER_SHA: &str = "d3be844c45c4fd89392536e56e1010963f94785592596b50cd0c45bb8a341406";
const NPM_MANIFEST_SHA: &str = "8b1dbf6f0b7ff97db0ff0b07b4f73804c877c09ca7d8ceb93765b6d6ea6c2272";
const PLATFORM_MANIFEST_SHA: &str =
    "f8c7def659ced5a3b763b826925627b92712ca2fadaa6b457d40d6b3b038f414";
const NPM_RESOURCES: &[(&str, &str)] = &[
    (
        "bin/codex-code-mode-host",
        "d6ef2923b5e3e46be063c8e68734ff227ea15d32262577b5d2b96fcbfe012118",
    ),
    (
        "codex-path/rg",
        "4fdf1d8365af224bc70e3c1490d8461d859c37cc70e739a11e987af0215f3e94",
    ),
    (
        "codex-resources/zsh/bin/zsh",
        "b69893d9da08786211bac0862212e26a8a31af24eb77da21692671c58d388b8d",
    ),
    (
        "codex-package.json",
        "af53bbde84f389437b7e2200e83c66a577b79069b2e069f5a7c96e9f8f79c0dc",
    ),
];

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgramFile {
    path: PathBuf,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CodexLaunch {
    Native {
        executable: ProgramFile,
    },
    Npm {
        interpreter: ProgramFile,
        launcher: ProgramFile,
        executable: ProgramFile,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexInstallationInspection {
    pub(crate) selected_path: PathBuf,
    pub(crate) version: String,
    pub(crate) launch: CodexLaunch,
    pub(crate) resources: Vec<ProgramFile>,
    pub(crate) verified_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCandidates {
    paths: Vec<PathBuf>,
    warnings: Vec<String>,
}

impl CodexLaunch {
    /// The verified native app-server executable, never the npm shim/interpreter.
    pub(crate) fn executable_path(&self) -> &std::path::Path {
        match self {
            Self::Native { executable } | Self::Npm { executable, .. } => &executable.path,
        }
    }
}

impl CodexInstallationInspection {
    pub(crate) fn native_sha(&self) -> &str {
        match &self.launch {
            CodexLaunch::Native { executable } | CodexLaunch::Npm { executable, .. } => {
                &executable.sha256
            }
        }
    }
    pub(crate) fn validate_record(&self) -> Result<(), String> {
        let valid_path = |path: &Path| {
            path.is_absolute()
                && path
                    .to_str()
                    .is_some_and(|p| p.len() <= 4096 && !p.chars().any(char::is_control))
        };
        let valid_file = |f: &ProgramFile| {
            valid_path(&f.path)
                && f.sha256.len() == 64
                && f.sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        let launch_valid = match &self.launch {
            CodexLaunch::Native { executable } => {
                valid_file(executable)
                    && (self.resources.is_empty() || self.resources.len() == NPM_RESOURCES.len())
            }
            CodexLaunch::Npm {
                interpreter,
                launcher,
                executable,
            } => {
                valid_file(interpreter)
                    && valid_file(launcher)
                    && valid_file(executable)
                    && launcher.sha256 == LAUNCHER_SHA
                    && self.resources.len() == NPM_RESOURCES.len() + 2
            }
        };
        if self.version != VERSION
            || self.verified_at < 0
            || self.native_sha() != NATIVE_SHA
            || !valid_path(&self.selected_path)
            || !launch_valid
            || !self.resources.iter().all(valid_file)
        {
            return Err("已保存的 Codex 程序身份无效；不能启动".to_string());
        }
        Ok(())
    }
    pub(crate) fn same_build(&self, other: &Self) -> bool {
        let hashes = |launch: &CodexLaunch| match launch {
            CodexLaunch::Native { executable } => vec![executable.sha256.clone()],
            CodexLaunch::Npm {
                interpreter,
                launcher,
                executable,
            } => vec![
                interpreter.sha256.clone(),
                launcher.sha256.clone(),
                executable.sha256.clone(),
            ],
        };
        self.version == other.version
            && hashes(&self.launch) == hashes(&other.launch)
            && self
                .resources
                .iter()
                .map(|f| &f.sha256)
                .eq(other.resources.iter().map(|f| &f.sha256))
    }
    pub(crate) fn same_location(&self, other: &Self) -> bool {
        self.selected_path == other.selected_path
            && self.launch == other.launch
            && self.resources == other.resources
            && self.version == other.version
    }
}

// Check the accepted hashes before executing even `--version`, including Node.
fn inspect_matching(
    selected: PathBuf,
    expected: &CodexInstallationInspection,
    relocating: bool,
) -> Result<CodexInstallationInspection, String> {
    expected.validate_record()?;
    let (launch, resources) = resolve_launch(&selected)?;
    let candidate = CodexInstallationInspection {
        selected_path: selected.clone(),
        version: VERSION.to_string(),
        launch,
        resources,
        verified_at: expected.verified_at,
    };
    if !(if relocating {
        expected.same_build(&candidate)
    } else {
        expected.same_location(&candidate)
    }) {
        return Err(
            "程序、解释器、附属文件或位置已变化；保留原登记，请重新选择兼容安装".to_string(),
        );
    }
    let observed = inspect(selected)?;
    if !candidate.same_location(&observed) {
        return Err("核验期间程序发生变化".to_string());
    }
    Ok(observed)
}

fn registration(
    inspection: &CodexInstallationInspection,
) -> Result<crate::host_store::records::RuntimeRegistration, String> {
    use crate::{host_ids::*, host_store::records::*};
    let installation = derived_host_id(
        "system-installation",
        &["codex", &inspection.selected_path.to_string_lossy()],
    );
    Ok(RuntimeRegistration {
        runtime_product_id: RuntimeProductId::parse("codex").map_err(|e| e.to_string())?,
        display_name: "Codex".to_string(),
        installation_id: InstallationId::parse(&installation).map_err(|e| e.to_string())?,
        runtime_build_id: RuntimeBuildId::parse(derived_host_id(
            "runtime-build",
            &[&installation, VERSION, NATIVE_SHA],
        ))
        .map_err(|e| e.to_string())?,
        adapter_id: AdapterId::parse("codex-acp-stdio-v1").map_err(|e| e.to_string())?,
        distribution: RuntimeDistribution::System,
        observed_version: VERSION.to_string(),
        artifact_sha256: NATIVE_SHA.to_string(),
        connection_id: ConnectionId::parse(derived_host_id(
            "connection",
            &[&installation, "farfold-owned-stdio"],
        ))
        .map_err(|e| e.to_string())?,
        connection_label: "Codex Farfold private environment".to_string(),
        connection_kind: RuntimeConnectionKind::SystemLocal,
        created_at: inspection.verified_at,
        verified_at: inspection.verified_at,
    })
}

#[tauri::command]
pub fn codex_installation_list(
    store: tauri::State<'_, crate::host_store::HostStore>,
) -> Result<Vec<crate::host_store::system_installation::SystemInstallation>, String> {
    store.system_installations()
}

#[tauri::command]
pub async fn codex_installation_accept(
    store: tauri::State<'_, crate::host_store::HostStore>,
    expected: CodexInstallationInspection,
) -> Result<crate::host_store::system_installation::SystemInstallation, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let inspection = inspect_matching(expected.selected_path.clone(), &expected, false)?;
        store.accept_system_installation(&registration(&inspection)?, &inspection)
    })
    .await
    .map_err(|_| "登记程序被中断".to_string())?
}

#[tauri::command]
pub async fn codex_installation_recheck(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::host_store::HostStore>,
    installation_id: crate::host_ids::InstallationId,
    path: Option<PathBuf>,
) -> Result<crate::host_store::system_installation::SystemInstallation, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let runtime = app.state::<crate::codex_acp::configure::Runtime>();
        if path.is_some()
            && runtime
                .current_binding()?
                .is_some_and(|live| live.installation_id == installation_id)
        {
            return Err("请先停止此安装的 Codex ACP 自有连接，再重新定位程序".to_string());
        }
        let expected = store
            .system_installations()?
            .into_iter()
            .find(|i| i.installation_id == installation_id)
            .ok_or("找不到已登记的程序")?;
        let relocating = path.is_some();
        let selected = path.unwrap_or_else(|| expected.inspection.selected_path.clone());
        let inspection = inspect_matching(selected, &expected.inspection, relocating)?;
        store.relocate_system_installation(&expected, &inspection)
    })
    .await
    .map_err(|_| "重新核验程序被中断".to_string())?
}

fn inspect_file(path: &Path, executable: bool) -> Result<ProgramFile, String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("文件不存在或无法读取：{}", path.display()))?;
    let meta = canonical
        .metadata()
        .map_err(|_| "无法读取程序属性".to_string())?;
    if !meta.is_file() || meta.len() > 512 * 1024 * 1024 {
        return Err(format!("不是支持的程序文件：{}", path.display()));
    }
    if executable && meta.permissions().mode() & 0o111 == 0 {
        return Err(format!("程序没有执行权限：{}", path.display()));
    }
    Ok(ProgramFile {
        sha256: file_sha256(&canonical)?,
        path: canonical,
    })
}

fn pinned_file(path: &Path, sha: &str, executable: bool) -> Result<ProgramFile, String> {
    let file = inspect_file(path, executable)?;
    if file.sha256 != sha {
        return Err(format!(
            "文件与已核验的 Codex {VERSION} 官方构建不一致：{}",
            path.display()
        ));
    }
    Ok(file)
}

fn package_json(path: &Path, name: &str, version: &str) -> Result<serde_json::Value, String> {
    let mut file =
        fs::File::open(path).map_err(|_| format!("缺少 npm 安装信息：{}", path.display()))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(32 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取 npm 安装信息".to_string())?;
    if bytes.len() > 32 * 1024 {
        return Err("npm 安装信息过大".to_string());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "npm 安装信息格式无效".to_string())?;
    if value["name"] != name || value["version"] != version {
        return Err(format!("需要官方 {name} {version} 安装"));
    }
    Ok(value)
}

fn resolve_launch(selected: &Path) -> Result<(CodexLaunch, Vec<ProgramFile>), String> {
    if !selected.is_absolute() {
        return Err("请选择 Codex 程序的绝对路径".to_string());
    }
    let entry = inspect_file(selected, false)?;
    if entry.sha256 == NATIVE_SHA {
        let executable = pinned_file(&entry.path, NATIVE_SHA, true)?;
        let resources = native_package_resources(&executable.path)?;
        return Ok((CodexLaunch::Native { executable }, resources));
    }
    if entry.sha256 != LAUNCHER_SHA {
        return Err(format!(
            "仅支持已核验的官方 Codex CLI {VERSION}；未执行所选文件"
        ));
    }
    // Fixed official npm layout, including nvm global installs. No shell/PATH or
    // arbitrary JS module resolution is executed to locate another installation.
    let package = entry
        .path
        .parent()
        .and_then(Path::parent)
        .ok_or("无法解析 npm 安装目录")?;
    let manifest = package_json(&package.join("package.json"), "@openai/codex", VERSION)?;
    let manifest_file = pinned_file(&package.join("package.json"), NPM_MANIFEST_SHA, false)?;
    if manifest["bin"]["codex"] != "bin/codex.js" || entry.path != package.join("bin/codex.js") {
        return Err("不支持这个 npm Codex 入口布局".to_string());
    }
    let node_modules = package
        .parent()
        .and_then(Path::parent)
        .ok_or("无法定位 npm 依赖目录")?;
    let lib = node_modules.parent().ok_or("无法定位 npm 安装前缀")?;
    if node_modules.file_name().is_none_or(|n| n != "node_modules")
        || lib.file_name().is_none_or(|n| n != "lib")
    {
        return Err("请选择包含 Node 解释器的官方 npm 全局安装入口（支持 nvm）".to_string());
    }
    let prefix = lib.parent().ok_or("无法定位 Node 解释器")?;
    let interpreter = inspect_file(&prefix.join("bin/node"), true)?;
    let mut header = [0; 8];
    fs::File::open(&interpreter.path)
        .and_then(|mut f| f.read_exact(&mut header))
        .map_err(|_| "无法识别 Node 解释器".to_string())?;
    if header != [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1] {
        return Err("需要 macOS arm64 Node 程序；不执行 shell 包装器".to_string());
    }
    let nested = package.join("node_modules/@openai/codex-darwin-arm64");
    let sibling = node_modules.join("@openai/codex-darwin-arm64");
    // Node resolves the closest dependency first. A present but broken nested
    // dependency is an error, never a silent fallback to another build.
    let platform_package = if nested.symlink_metadata().is_ok() {
        nested
    } else {
        sibling
    };
    package_json(
        &platform_package.join("package.json"),
        "@openai/codex",
        "0.143.0-darwin-arm64",
    )?;
    let platform_manifest = pinned_file(
        &platform_package.join("package.json"),
        PLATFORM_MANIFEST_SHA,
        false,
    )?;
    let vendor = platform_package.join("vendor/aarch64-apple-darwin");
    let executable = pinned_file(&vendor.join("bin/codex"), NATIVE_SHA, true)?;
    let mut resources = vec![manifest_file, platform_manifest];
    for (relative, sha) in NPM_RESOURCES {
        resources.push(pinned_file(
            &vendor.join(relative),
            sha,
            !relative.ends_with(".json"),
        )?);
    }
    Ok((
        CodexLaunch::Npm {
            interpreter,
            launcher: entry,
            executable,
        },
        resources,
    ))
}

fn native_package_resources(executable: &Path) -> Result<Vec<ProgramFile>, String> {
    // Codex 0.143.0 install-context/src/lib.rs detects package layout from a
    // canonical bin/ executable and ../codex-package.json, even without npm.
    let Some(bin) = executable
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "bin"))
    else {
        return Ok(Vec::new());
    };
    let Some(vendor) = bin.parent() else {
        return Ok(Vec::new());
    };
    if vendor
        .join("codex-package.json")
        .symlink_metadata()
        .is_err()
    {
        return Ok(Vec::new());
    }
    NPM_RESOURCES
        .iter()
        .map(|(relative, sha)| {
            pinned_file(&vendor.join(relative), sha, !relative.ends_with(".json"))
        })
        .collect()
}

fn observed_version(launch: &CodexLaunch) -> Result<String, String> {
    let temporary = tempfile::tempdir().map_err(|_| "无法创建程序检查临时目录".to_string())?;
    let mut command = match launch {
        CodexLaunch::Native { executable } => Command::new(&executable.path),
        CodexLaunch::Npm {
            interpreter,
            launcher,
            ..
        } => {
            let mut command = Command::new(&interpreter.path);
            command.arg(&launcher.path);
            command
        }
    };
    let mut child = command
        .arg("--version")
        .env_clear()
        .env("HOME", temporary.path())
        .env("CODEX_HOME", temporary.path())
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .current_dir(temporary.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法启动所选 Codex 程序进行版本检查：{e}"))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err("Codex 版本检查失败；请检查 Node 与原生依赖".to_string()),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Codex 版本检查未在 5 秒内完成".to_string());
            }
        }
    }
    let mut output = String::new();
    child
        .stdout
        .take()
        .ok_or("无法读取程序版本")?
        .take(1025)
        .read_to_string(&mut output)
        .map_err(|_| "Codex 版本输出无效".to_string())?;
    if output.len() > 1024 || output.trim() != format!("codex-cli {VERSION}") {
        return Err(format!("实际程序版本不是 Codex CLI {VERSION}"));
    }
    Ok(VERSION.to_string())
}

pub(crate) fn inspect(selected: PathBuf) -> Result<CodexInstallationInspection, String> {
    let (launch, resources) = resolve_launch(&selected)?;
    let version = observed_version(&launch)?;
    // Detect program/symlink replacement during inspection. Startup will need
    // this same check against the Host's persisted accepted identity in schema 8.
    if resolve_launch(&selected)? != (launch.clone(), resources.clone()) {
        return Err("检查期间程序发生变化，请重新选择并校验".to_string());
    }
    Ok(CodexInstallationInspection {
        selected_path: selected,
        version,
        launch,
        resources,
        verified_at: crate::host_store::now_millis(),
    })
}

fn candidates(home: &Path, system_paths: &[PathBuf]) -> CodexCandidates {
    let mut paths = vec![
        home.join(".local/bin/codex"),
        home.join(".npm-global/bin/codex"),
    ];
    paths.extend_from_slice(system_paths);
    let mut warnings = Vec::new();
    match fs::read_dir(home.join(".nvm/versions/node")) {
        Ok(entries) => {
            let mut versions = Vec::new();
            for entry in entries.take(65) {
                match entry {
                    Ok(entry) => versions.push(entry.path()),
                    Err(_) => {
                        warnings.push("部分 nvm 安装目录无法读取，可手动选择程序".to_string())
                    }
                }
            }
            if versions.len() > 64 {
                warnings.push("nvm 安装超过检测上限，可手动选择程序".to_string());
                versions.truncate(64);
            }
            versions.sort();
            paths.extend(versions.iter().map(|p| p.join("bin/codex")));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => warnings.push("无法读取 nvm 安装目录，可手动选择程序".to_string()),
    }
    let mut seen = HashSet::new();
    paths.retain(|p| p.is_file() && p.canonicalize().is_ok_and(|p| seen.insert(p)));
    CodexCandidates { paths, warnings }
}

#[tauri::command]
pub async fn codex_installation_candidates(
    app: tauri::AppHandle,
) -> Result<CodexCandidates, String> {
    use tauri::Manager;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "无法定位用户目录".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        candidates(
            &home,
            &[
                PathBuf::from("/opt/homebrew/bin/codex"),
                PathBuf::from("/usr/local/bin/codex"),
            ],
        )
    })
    .await
    .map_err(|_| "Codex 程序检测被中断".to_string())
}

#[tauri::command]
pub async fn codex_installation_inspect(
    path: PathBuf,
) -> Result<CodexInstallationInspection, String> {
    tauri::async_runtime::spawn_blocking(move || inspect(path))
        .await
        .map_err(|_| "Codex 程序检查被中断".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn record_fixture(path: &str) -> CodexInstallationInspection {
        CodexInstallationInspection {
            selected_path: PathBuf::from(path),
            version: VERSION.to_string(),
            launch: CodexLaunch::Native {
                executable: ProgramFile {
                    path: PathBuf::from(path),
                    sha256: NATIVE_SHA.to_string(),
                },
            },
            resources: Vec::new(),
            verified_at: 1,
        }
    }

    #[test]
    fn saved_installation_survives_reopen_and_explicit_relocation_preserves_identity() {
        use crate::host_store::HostStore;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("host.sqlite3");
        let open = || HostStore::open(&path);
        let store = open();
        let first = record_fixture("/fixture/original codex");
        let accepted = store
            .accept_system_installation(&registration(&first).unwrap(), &first)
            .unwrap();
        assert_eq!(store.system_installations().unwrap().len(), 1);
        store
            .accept_system_installation(&registration(&first).unwrap(), &first)
            .unwrap();
        let mut moved = record_fixture("/fixture/moved codex");
        moved.verified_at = 2;
        let relocated = store
            .relocate_system_installation(&accepted, &moved)
            .unwrap();
        assert_eq!(accepted.installation_id, relocated.installation_id);
        assert_eq!(accepted.runtime_build_id, relocated.runtime_build_id);
        assert!(
            store
                .relocate_system_installation(&accepted, &first)
                .is_err()
        );
        drop(store);
        let restored = open().system_installations().unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].inspection, moved);
        assert_eq!(restored[0].installation_id, accepted.installation_id);
    }

    #[test]
    fn portable_export_preserves_installation_references_and_rejects_extra_launch_fields() {
        use crate::host_store::{
            HostStore,
            portable_export::{CreatePortableExportInput, host_portable_import_preview},
        };
        let temp = tempfile::tempdir().unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let inspection = record_fixture("/missing-on-restored-machine/codex");
        let accepted = store
            .accept_system_installation(&registration(&inspection).unwrap(), &inspection)
            .unwrap();
        let export = temp.path().join("portable.farfold.sqlite3");
        store
            .create_portable_export(CreatePortableExportInput {
                destination_path: export.to_string_lossy().into_owned(),
            })
            .unwrap();
        let preview = host_portable_import_preview(export.to_string_lossy().into_owned()).unwrap();
        let preview = serde_json::to_value(preview).unwrap();
        assert_eq!(preview["contents"]["systemInstallationCount"], 1);
        assert_eq!(preview["policy"]["includesSystemProgramPaths"], true);
        assert_eq!(preview["policy"]["includesProviderCredentials"], false);
        let restored = HostStore::open(&export);
        let entries = restored.system_installations().unwrap();
        assert_eq!(entries[0].installation_id, accepted.installation_id);
        assert_eq!(entries[0].inspection, inspection);
        assert!(inspect_matching(inspection.selected_path.clone(), &inspection, false).is_err());
        drop(restored);
        let connection = rusqlite::Connection::open(&export).unwrap();
        let mut corrupted = serde_json::to_value(&inspection).unwrap();
        corrupted["apiKey"] = serde_json::json!("fixture-not-a-credential");
        connection
            .execute(
                "UPDATE system_installation_launches SET launch_json = ?1",
                [corrupted.to_string()],
            )
            .unwrap();
        drop(connection);
        assert!(
            host_portable_import_preview(export.to_string_lossy().into_owned())
                .unwrap_err()
                .contains("程序记录无效")
        );
    }

    #[test]
    fn registration_rejects_changed_build_and_unknown_secret_or_command_fields() {
        use crate::host_store::HostStore;
        let temp = tempfile::tempdir().unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let original = record_fixture("/fixture/codex");
        let accepted = store
            .accept_system_installation(&registration(&original).unwrap(), &original)
            .unwrap();
        let mut changed = original.clone();
        changed.version = "0.144.0".to_string();
        assert!(
            store
                .relocate_system_installation(&accepted, &changed)
                .is_err()
        );
        assert_eq!(
            store.system_installations().unwrap()[0].inspection,
            original
        );
        for field in ["apiKey", "command", "environment", "auth"] {
            let mut input = serde_json::to_value(&original).unwrap();
            input[field] = serde_json::json!("must-not-store");
            assert!(serde_json::from_value::<CodexInstallationInspection>(input).is_err());
        }
        let npm = |sha: &str| CodexLaunch::Npm {
            interpreter: ProgramFile {
                path: PathBuf::from("/fixture/node"),
                sha256: sha.to_string(),
            },
            launcher: ProgramFile {
                path: PathBuf::from("/fixture/codex.js"),
                sha256: LAUNCHER_SHA.to_string(),
            },
            executable: ProgramFile {
                path: PathBuf::from("/fixture/native"),
                sha256: NATIVE_SHA.to_string(),
            },
        };
        let mut before = original.clone();
        before.launch = npm(&"a".repeat(64));
        let mut after = before.clone();
        after.launch = npm(&"b".repeat(64));
        assert!(!before.same_build(&after));
    }

    #[test]
    fn discovery_deduplicates_symlinks_without_scanning_other_user_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let real = root.join(".nvm/versions/node/v22/bin/codex");
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        fs::write(&real, "fixture").unwrap();
        fs::create_dir_all(root.join(".local/bin")).unwrap();
        symlink(&real, root.join(".local/bin/codex")).unwrap();
        fs::create_dir_all(root.join("private/project/bin")).unwrap();
        fs::write(
            root.join("private/project/bin/codex"),
            "not a discovery location",
        )
        .unwrap();
        let found = candidates(root, &[]);
        assert_eq!(found.paths, vec![root.join(".local/bin/codex")]);
        assert!(found.warnings.is_empty());
    }

    #[test]
    fn unknown_program_is_never_executed_and_relative_paths_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("codex");
        let marker = temp.path().join("executed");
        fs::write(
            &binary,
            format!(
                "#!/bin/sh\ntouch '{}'\necho codex-cli 0.143.0\n",
                marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(inspect(binary).unwrap_err().contains("未执行"));
        assert!(!marker.exists());
        assert!(
            inspect(PathBuf::from("codex"))
                .unwrap_err()
                .contains("绝对路径")
        );
    }

    #[test]
    fn file_inspection_rejects_missing_unexecutable_and_replaced_files() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("program with spaces");
        assert!(inspect_file(&file, true).is_err());
        fs::write(&file, "original").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(inspect_file(&file, true).is_err());
        let accepted = inspect_file(&file, false).unwrap();
        fs::write(&file, "replaced").unwrap();
        assert!(pinned_file(&file, &accepted.sha256, false).is_err());
    }

    #[test]
    #[ignore = "requires an explicitly selected user-owned Codex installation"]
    fn explicit_installed_codex_probe() {
        let path = std::env::var_os("FARFOLD_CODEX_INSTALLATION_TEST_PATH")
            .expect("select the installation explicitly");
        let inspected = inspect(PathBuf::from(path)).unwrap();
        assert_eq!(inspected.version, VERSION);
        if matches!(inspected.launch, CodexLaunch::Npm { .. }) {
            assert_eq!(inspected.resources.len(), 6);
        }
    }

    #[test]
    #[ignore = "copies an explicitly selected official npm installation into a disposable fixture"]
    fn npm_spaces_relocation_dependencies_and_replacement() {
        let selected = std::env::var_os("FARFOLD_CODEX_INSTALLATION_TEST_PATH")
            .expect("select the installation explicitly");
        let original = inspect(PathBuf::from(selected)).unwrap();
        let CodexLaunch::Npm {
            interpreter,
            launcher,
            executable,
        } = original.launch
        else {
            panic!("this test requires the official npm entry");
        };
        let package = launcher.path.parent().unwrap().parent().unwrap();
        let prefix = package.ancestors().nth(4).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let fixture_root = temp.path().canonicalize().unwrap();
        let copied = fixture_root.join("Node install with spaces");
        // Copies, never hard links: failure tests must not alter the user's CLI.
        for file in std::iter::once(&launcher)
            .chain(std::iter::once(&executable))
            .chain(original.resources.iter())
        {
            let destination = copied.join(file.path.strip_prefix(prefix).unwrap());
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::copy(&file.path, &destination).unwrap();
        }
        let copied_node = copied.join("bin/node");
        fs::create_dir_all(copied_node.parent().unwrap()).unwrap();
        symlink(&interpreter.path, &copied_node).unwrap();
        let copied_entry = copied.join("bin/codex");
        symlink(
            "../lib/node_modules/@openai/codex/bin/codex.js",
            &copied_entry,
        )
        .unwrap();
        let first = inspect(copied_entry).unwrap();
        assert_eq!(first.version, VERSION);
        let copied_native = match &first.launch {
            CodexLaunch::Npm { executable, .. } => executable.path.clone(),
            _ => unreachable!(),
        };
        let (direct, resources) = resolve_launch(&copied_native).unwrap();
        assert!(matches!(direct, CodexLaunch::Native { .. }));
        assert_eq!(resources.len(), 4);

        let moved = fixture_root.join("relocated Node");
        fs::rename(&copied, &moved).unwrap();
        assert!(inspect(copied.join("bin/codex")).is_err());
        let second = inspect(moved.join("bin/codex")).unwrap();
        assert_ne!(first.selected_path, second.selected_path);
        assert_eq!(
            first
                .resources
                .iter()
                .map(|f| &f.sha256)
                .collect::<Vec<_>>(),
            second
                .resources
                .iter()
                .map(|f| &f.sha256)
                .collect::<Vec<_>>()
        );

        let rg = second
            .resources
            .iter()
            .find(|f| f.path.ends_with("codex-path/rg"))
            .unwrap();
        fs::rename(&rg.path, rg.path.with_file_name("rg-held")).unwrap();
        assert!(
            inspect(moved.join("bin/codex"))
                .unwrap_err()
                .contains("文件不存在")
        );
        let moved_native = moved.join(copied_native.strip_prefix(&copied).unwrap());
        assert!(
            resolve_launch(&moved_native)
                .unwrap_err()
                .contains("文件不存在")
        );
        fs::rename(rg.path.with_file_name("rg-held"), &rg.path).unwrap();
        fs::remove_file(moved.join("bin/node")).unwrap();
        assert!(
            inspect(moved.join("bin/codex"))
                .unwrap_err()
                .contains("文件不存在")
        );
        symlink(&interpreter.path, moved.join("bin/node")).unwrap();

        let manifest = second
            .resources
            .iter()
            .find(|f| f.path.ends_with("codex-darwin-arm64/package.json"))
            .unwrap();
        fs::write(&manifest.path, r#"{"name":"@openai/codex","version":"0.143.0-darwin-arm64","exports":{"./package.json":"./redirect/package.json"}}"#).unwrap();
        assert!(
            inspect(moved.join("bin/codex"))
                .unwrap_err()
                .contains("官方构建不一致")
        );
        // The original remains usable after every destructive fixture scenario.
        assert_eq!(inspect_file(&launcher.path, false).unwrap(), launcher);
        assert_eq!(inspect_file(&executable.path, true).unwrap(), executable);
    }
}
