//! Explicitly prepared distribution tools. These are shared install tools,
//! not Agent configuration. Agent packages live in independent owned venvs;
//! their official console scripts are the selected launch targets.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::acp_client::preparation::{DependencyStatus, PreparationDependency};
use crate::agent_catalog::{AgentCatalog, AgentLaunch, UvxPackage, registry_launch};
use crate::agent_discovery::version_output;
use crate::install_job::Job;

mod archive;

// Official release 2026-09-22. Archive digest is from its immutable asset page.
// Python is the 20260807 build listed in this uv release's frozen metadata.
// Sources and dates: docs/evidence/2026-09-30-agent-access-uvx/README.md.
const UV_VERSION: &str = "0.12.18";
// This installer requires global --no-config and --no-python-downloads,
// both declared by uv 0.2.37's official uv-cli source. Older PATH tools must
// not hide a suitable managed tool. This is not an Agent version gate.
const UV_INSTALL_BASELINE: semver::Version = semver::Version::new(0, 2, 37);
const UV_ARCHIVE: &str =
    "https://github.com/astral-sh/uv/releases/download/0.12.18/uv-aarch64-apple-darwin.tar.gz";
const UV_SHA256: &str = "cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b";
const PYTHON_VERSION: &str = "3.12.13";
const PYTHON_ARCHIVE: &str = "https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-aarch64-apple-darwin-install_only_stripped.tar.gz";
const PYTHON_SHA256: &str = "25baa97c65b3f0aa90e21131b4f9e80aef8899e8144006db8a9d2c1ab9e807e3";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const METADATA_LIMIT: u64 = 128 * 1024;

#[derive(Debug, Clone)]
struct Tool {
    path: PathBuf,
    version: String,
}

fn uv_root(data: &Path) -> PathBuf {
    data.join("uv").join(format!("uv-{UV_VERSION}"))
}
fn python_root(data: &Path) -> PathBuf {
    data.join("python").join("cpython-3.12.13+20260807-aarch64")
}
fn uv_path(data: &Path) -> PathBuf {
    uv_root(data).join("uv")
}
fn python_path(data: &Path) -> PathBuf {
    python_root(data).join("bin/python3.12")
}

fn usable_version(output: &str, python: bool) -> Option<String> {
    let mut tokens = output.split_whitespace();
    let expected = if python { "Python" } else { "uv" };
    if tokens.next()? != expected {
        return None;
    }
    let version = tokens.next()?;
    let parsed = semver::Version::parse(version).ok()?;
    if !python && parsed < UV_INSTALL_BASELINE {
        return None;
    }
    // A distribution-tool baseline, not an Agent compatibility gate. Actual
    // package Requires-Python and initialize are checked during installation.
    if python && (parsed.major != 3 || !(12..15).contains(&parsed.minor)) {
        return None;
    }
    Some(version.into())
}

fn probe(
    path: &Path,
    python: bool,
    check: &impl Fn() -> Result<(), String>,
) -> Result<Option<Tool>, String> {
    check()?;
    let output = version_output(path, Duration::from_secs(5), check)?;
    Ok(output
        .and_then(|output| usable_version(&output, python))
        .map(|version| Tool {
            path: path.into(),
            version,
        }))
}

fn tools_in(
    data: &Path,
    env: &HashMap<String, String>,
    check: &impl Fn() -> Result<(), String>,
) -> Result<(Option<Tool>, Option<Tool>), String> {
    let dirs = env
        .get("PATH")
        .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut uv_candidates = Vec::new();
    for dir in &dirs {
        uv_candidates.push(dir.join("uv"));
    }
    uv_candidates.push(uv_path(data));
    let mut uv = None;
    let mut uv_seen = std::collections::HashSet::new();
    for path in uv_candidates {
        check()?;
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        if !uv_seen.insert(canonical) || !path.is_file() {
            continue;
        }
        if let Some(tool) = probe(&path, false, check)? {
            uv = Some(tool);
            break;
        }
    }
    let mut python = None;
    let mut seen = std::collections::HashSet::new();
    for name in [
        "python3.12",
        "python3.13",
        "python3.14",
        "python3",
        "python",
    ] {
        for dir in &dirs {
            check()?;
            let path = dir.join(name);
            let Ok(canonical) = path.canonicalize() else {
                continue;
            };
            if !seen.insert(canonical) || !path.is_file() {
                continue;
            }
            if let Some(tool) = probe(&path, true, check)? {
                python = Some(tool);
                break;
            }
        }
        if python.is_some() {
            break;
        }
    }
    if python.is_none() {
        python = probe(&python_path(data), true, check)?;
    }
    Ok((uv, python))
}

pub(crate) fn declared(catalog: &AgentCatalog, agent_id: &str) -> bool {
    catalog
        .cached_entry(agent_id)
        .is_some_and(|entry| matches!(registry_launch(&entry), Some(AgentLaunch::Uvx { .. })))
}

pub(crate) fn preparation(data: &Path) -> Result<Vec<PreparationDependency>, String> {
    let (uv, python) = tools_in(data, &crate::shell_env::command_env(), &|| Ok(()))?;
    Ok(preparation_from_tools(data, uv, python))
}

fn preparation_from_tools(
    data: &Path,
    uv: Option<Tool>,
    python: Option<Tool>,
) -> Vec<PreparationDependency> {
    [
        ("uv", "uv 安装工具", uv, uv_root(data), "https://docs.astral.sh/uv/getting-started/installation/"),
        ("python", "Python 3.12–3.14", python, python_root(data), "https://docs.astral.sh/uv/concepts/python-versions/"),
    ].into_iter().map(|(id, name, tool, root, source)| {
        let (status, detail, command) = match tool {
            Some(tool) => (DependencyStatus::Ready,
                format!("已找到 {name} {}，用于准备安装包；连接、账号与回复分别验证。", tool.version),
                format!("'{}' --version", tool.path.display().to_string().replace('\'', "'\\''"))),
            None => (DependencyStatus::Missing,
                if id == "uv" {
                    "尚未找到适用于本次安装的 uv（需 0.2.37 或更新）；点击安装会准备独立的安装工具，不升级已有程序或改变用户设置。".into()
                } else {
                    format!("尚未找到可用的 {name}；点击安装仅准备所需程序，不改变已选 Agent、账号或用户设置。")
                },
                if id == "uv" { "uv --version" } else { "python3 --version" }.into()),
        };
        PreparationDependency {
            id: id.into(), name: name.into(), status, detail, source_url: source.into(),
            installable: true, managed_location: root.display().to_string(), check_command: command,
            required_for_install: true, required_for_use: false,
            version_diagnostic: None,
        }
    }).collect()
}

fn owned_parent(data: &Path, parent: &Path) -> Result<(), String> {
    let relative = parent.strip_prefix(data).map_err(|_| "无法确认安装目录")?;
    let canonical_data = data.canonicalize().map_err(|_| "无法确认安装目录")?;
    let mut current = data.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err("所需程序的安装目录位置无效，已有文件保持不变".into());
        };
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err("无法准备所需程序的安装目录".into()),
                }
            }
            Err(_) => return Err("无法确认所需程序目录".into()),
        }
        let metadata = std::fs::symlink_metadata(&current).map_err(|_| "无法确认所需程序目录")?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || !current
                .canonicalize()
                .map_err(|_| "无法确认所需程序目录")?
                .starts_with(&canonical_data)
        {
            return Err("所需程序的安装目录位置无效，已有文件保持不变".into());
        }
    }
    Ok(())
}

fn path_present(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("无法确认所需程序目录，已有文件保持不变".into()),
    }
}

fn publish_tool(
    data: &Path,
    root: &Path,
    archive: &[u8],
    expected: &str,
    prefix: &str,
    (executable, python): (&str, bool),
    job: &Job,
) -> Result<(), String> {
    job.check()?;
    job.report("verify", None, None);
    archive::verify(archive, expected)?;
    let parent = root.parent().ok_or("无法确认安装目录")?;
    owned_parent(data, parent)?;
    if path_present(root)? {
        return Err("已有所需程序的文件不完整；已保留，请检查后重试".into());
    }
    let staging = tempfile::Builder::new()
        .prefix(".prepare-")
        .tempdir_in(parent)
        .map_err(|_| "无法准备所需程序的安装目录")?;
    job.report("extract", None, None);
    archive::extract(archive, staging.path(), job)?;
    let extracted = staging.path().join(prefix);
    let path = extracted.join(executable);
    let canonical = path
        .canonicalize()
        .map_err(|_| "下载的所需程序不完整，请重试")?;
    if !canonical.starts_with(
        extracted
            .canonicalize()
            .map_err(|_| "无法确认所需程序位置")?,
    ) {
        return Err("下载的所需程序位置无效".into());
    }
    job.report("check", None, None);
    let tool = probe(&path, python, &|| job.check())?.ok_or("所需程序未通过执行检查，请重试")?;
    if tool.version != if python { PYTHON_VERSION } else { UV_VERSION } {
        return Err("下载的所需程序与官方发行信息不一致，请重试".into());
    }
    job.check()?;
    job.commit(|| {
        if path_present(root)? {
            return Err("所需程序目录已变化；已有文件保持不变，请重新检查".into());
        }
        std::fs::rename(extracted, root).map_err(|_| "无法保存所需程序，已有文件保持不变".into())
    })
}

/// Only the explicit prerequisite action calls this; package preparation never
/// downloads a missing runtime implicitly. Serialize shared tool publication.
pub(crate) fn install_dependency(data: &Path, id: &str, job: &Job) -> Result<(), String> {
    if !["uv", "python"].contains(&id) {
        return Err("此安装方式没有声明所需程序".into());
    }
    static PREPARING: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = loop {
        job.check()?;
        match PREPARING.get_or_init(Default::default).try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err("所需程序准备暂时不可用，请重试".into());
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(Duration::from_millis(20))
            }
        }
    };
    let (uv, python) = tools_in(data, &crate::shell_env::command_env(), &|| job.check())?;
    if (id == "uv" && uv.is_some()) || (id == "python" && python.is_some()) {
        return job.check();
    }
    let (url, digest, root, prefix, executable, is_python, limit) = if id == "uv" {
        (
            UV_ARCHIVE,
            UV_SHA256,
            uv_root(data),
            "uv-aarch64-apple-darwin",
            "uv",
            false,
            128 * 1024 * 1024,
        )
    } else {
        (
            PYTHON_ARCHIVE,
            PYTHON_SHA256,
            python_root(data),
            "python",
            "bin/python3.12",
            true,
            256 * 1024 * 1024,
        )
    };
    // Official fixed URL may redirect to the HTTPS release-assets CDN. The
    // immutable digest and byte bound remain mandatory before extraction.
    let bytes = job.download_bounded(url, DOWNLOAD_TIMEOUT, limit, None)?;
    publish_tool(
        data,
        &root,
        &bytes,
        digest,
        prefix,
        (executable, is_python),
        job,
    )
}

fn package_command(uv: &Path, data: &Path, destination: &Path) -> Command {
    package_command_with_env(uv, data, destination, crate::shell_env::command_env())
}

fn package_command_with_env(
    uv: &Path,
    data: &Path,
    destination: &Path,
    env: HashMap<String, String>,
) -> Command {
    let mut command = Command::new(uv);
    command
        .args(["--no-config", "--no-python-downloads", "--cache-dir"])
        .arg(data.join("uv/cache"))
        .current_dir(destination)
        .envs(env)
        // uv's explicit configuration file takes priority over --no-config;
        // a configured pip target/prefix could write outside this venv.
        // This affects only the package installer, never the Agent process.
        .env_remove("UV_CONFIG_FILE");
    command
}

/// The existing TempDir remains at its final path: absolute venv shebangs must
/// not move after preparation. Only candidate selection can keep this directory.
pub(crate) fn install_package(
    data: &Path,
    destination: &Path,
    package: &str,
    job: &Job,
) -> Result<PathBuf, String> {
    job.check()?;
    let package = UvxPackage::parse(package)?;
    let (uv, python) = tools_in(data, &crate::shell_env::command_env(), &|| job.check())?;
    let uv = uv.ok_or("缺少 uv 安装工具，请先在所需程序中安装或重新检查")?;
    let python = python.ok_or("缺少可用的 Python，请先在所需程序中安装或重新检查")?;
    owned_parent(data, &data.join("uv/cache"))?;
    let venv = destination.join("venv");
    if path_present(&venv)? {
        return Err("本次安装目录已存在，已有文件保持不变，请重试".into());
    }
    job.report("install", None, None);
    job.run(
        package_command(&uv.path, data, destination)
            .args(["venv", "--python"])
            .arg(&python.path)
            .arg(&venv),
    )?;
    job.run(
        package_command(&uv.path, data, destination)
            .args(["pip", "install", "--python"])
            .arg(venv.join("bin/python"))
            .arg(&package.requirement),
    )?;
    job.check()?;
    console_script(&venv, &package, job)
}

fn owned_file(path: &Path, root: &Path) -> Result<(PathBuf, u64), String> {
    let canonical = path
        .canonicalize()
        .map_err(|_| "安装包未提供完整的程序信息，请查看官方说明")?;
    let metadata = std::fs::metadata(&canonical).map_err(|_| "无法读取安装后的程序信息")?;
    if !canonical.starts_with(root) || !metadata.is_file() {
        return Err("安装后的程序信息位置无效".into());
    }
    Ok((canonical, metadata.len()))
}

fn small_owned_text(path: &Path, root: &Path) -> Result<String, String> {
    let (canonical, size) = owned_file(path, root)?;
    if size > METADATA_LIMIT {
        return Err("安装后的程序信息大小无效".into());
    }
    std::fs::read_to_string(canonical).map_err(|_| "无法读取安装后的程序信息".into())
}

fn metadata_header(path: &Path, root: &Path) -> Result<String, String> {
    use std::io::Read;
    let (canonical, size) = owned_file(path, root)?;
    let mut bytes = Vec::new();
    std::fs::File::open(canonical)
        .map_err(|_| "无法读取安装后的程序信息")?
        .take(METADATA_LIMIT)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取安装后的程序信息")?;
    let end = bytes
        .windows(2)
        .position(|pair| pair == b"\n\n")
        .or_else(|| bytes.windows(4).position(|pair| pair == b"\r\n\r\n"));
    let end = end
        .or_else(|| (size <= METADATA_LIMIT).then_some(bytes.len()))
        .ok_or("安装后的程序信息头过大")?;
    String::from_utf8(bytes[..end].to_vec()).map_err(|_| "无法读取安装后的程序信息".into())
}

fn console_script(venv: &Path, package: &UvxPackage, job: &Job) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let root = venv.canonicalize().map_err(|_| "安装后的程序目录不完整")?;
    let libraries = std::fs::read_dir(root.join("lib")).map_err(|_| "安装后的程序目录不完整")?;
    let mut found = false;
    for library in libraries {
        job.check()?;
        let library = library.map_err(|_| "无法读取安装后的程序目录")?;
        if !library.file_name().to_string_lossy().starts_with("python") {
            continue;
        }
        let Ok(packages) = std::fs::read_dir(library.path().join("site-packages")) else {
            continue;
        };
        for info in packages {
            job.check()?;
            let info = info.map_err(|_| "无法读取安装后的程序信息")?;
            let filename = info.file_name();
            let filename = filename.to_string_lossy();
            let declared_name = filename
                .strip_suffix(".dist-info")
                .and_then(|name| name.split_once('-'))
                .map(|(name, _)| name);
            if declared_name
                .is_none_or(|name| crate::agent_catalog::normalized_name(name) != package.name)
            {
                continue;
            }
            let metadata = metadata_header(&info.path().join("METADATA"), &root)?;
            let name = metadata
                .lines()
                .find_map(|line| line.strip_prefix("Name: "));
            if name.is_none_or(|name| crate::agent_catalog::normalized_name(name) != package.name) {
                continue;
            }
            if metadata
                .lines()
                .find_map(|line| line.strip_prefix("Version: "))
                != Some(package.version.as_str())
            {
                return Err("安装后的包版本与目录声明不一致，请查看官方说明".into());
            }
            let entries = small_owned_text(&info.path().join("entry_points.txt"), &root)?;
            let mut scripts = false;
            found = entries.lines().any(|line| {
                let line = line.trim();
                if line.starts_with('[') {
                    scripts = line == "[console_scripts]";
                    return false;
                }
                scripts
                    && line.split_once('=').is_some_and(|(name, target)| {
                        name.trim() == package.script && !target.trim().is_empty()
                    })
            });
            if found {
                break;
            }
        }
        if found {
            break;
        }
    }
    if !found {
        return Err("安装包未提供目录声明的启动程序，请查看官方说明".into());
    }
    let command = root
        .join("bin")
        .join(&package.script)
        .canonicalize()
        .map_err(|_| "安装包中的启动程序不存在，请查看官方说明")?;
    let metadata = std::fs::metadata(&command).map_err(|_| "无法读取安装后的启动程序")?;
    if !command.starts_with(&root)
        || !metadata.is_file()
        || metadata.permissions().mode() & 0o111 == 0
    {
        return Err("安装包中的启动程序位置或执行权限无效".into());
    }
    job.check()?;
    Ok(command)
}

#[cfg(test)]
mod tests;
