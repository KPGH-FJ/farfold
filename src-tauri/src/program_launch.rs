//! A managed argv-forwarding entrypoint, never an Agent loop or config proxy.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::acp_client::{
    preparation::fresh_program_version,
    versions::{RequirementState, requirement_state},
};
use crate::npm_release::ProgramRelease;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeLaunch {
    pub node: String,
    pub entrypoint: String,
    pub node_version: String,
}

#[cfg(unix)]
fn quoted(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("程序位置无法识别")?;
    if !path.is_absolute() || text.contains(['\n', '\r', '\0']) {
        return Err("程序位置无效".into());
    }
    Ok(format!("'{}'", text.replace('\'', "'\\''")))
}

const LAUNCHER_NAME: &str = if cfg!(windows) {
    "launch-program.exe"
} else {
    "launch-program"
};
fn launcher_bytes(node: &Path, entry: &Path) -> Result<Vec<u8>, String> {
    #[cfg(unix)]
    {
        Ok(format!(
            "#!/bin/sh\nexec {} {} \"$@\"\n",
            quoted(node)?,
            quoted(entry)?
        )
        .into_bytes())
    }
    #[cfg(windows)]
    {
        let paths = [node, entry].map(|path| {
            let text = path.to_str().ok_or("程序位置无法识别")?;
            if !path.is_absolute()
                || text.is_empty()
                || text.len() > 32768
                || text.contains(['\n', '\r', '\0'])
            {
                return Err("程序位置无效");
            }
            Ok(text.as_bytes())
        });
        let node = paths[0].as_ref().map_err(|error| error.to_string())?;
        let entry = paths[1].as_ref().map_err(|error| error.to_string())?;
        let mut bytes =
            include_bytes!(concat!(env!("OUT_DIR"), "/launch-program-template.exe")).to_vec();
        bytes.extend_from_slice(node);
        bytes.extend_from_slice(entry);
        bytes.extend_from_slice(&(node.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(entry.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"FFNODE01");
        Ok(bytes)
    }
}

pub(crate) fn create(
    root: &Path,
    node: &Path,
    entry: &Path,
    version: &str,
) -> Result<(PathBuf, NodeLaunch), String> {
    let node = crate::agent_discovery::validate_executable_path(&node.display().to_string())?;
    let entry = entry.canonicalize().map_err(|_| "无法确认程序入口")?;
    if !entry.starts_with(root.canonicalize().map_err(|_| "无法确认安装位置")?) || !entry.is_file()
    {
        return Err("程序入口不在本次安装目录中".into());
    }
    let launcher = root.join(LAUNCHER_NAME);
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&launcher)
        .map_err(|_| "无法创建程序启动文件")?;
    file.write_all(&launcher_bytes(&node, &entry)?)
        .map_err(|_| "无法保存程序启动文件")?;
    file.sync_all().map_err(|_| "无法完成程序保存")?;
    crate::process_platform::set_executable(&launcher).map_err(|_| "无法设置程序执行权限")?;
    Ok((
        launcher,
        NodeLaunch {
            node: node.display().to_string(),
            entrypoint: entry.display().to_string(),
            node_version: version.into(),
        },
    ))
}

pub(crate) fn validate(
    root: &Path,
    launcher: &Path,
    launch: &NodeLaunch,
    release: &ProgramRelease,
    check: impl Fn() -> Result<(), String>,
) -> Result<String, String> {
    check()?;
    let root = root.canonicalize().map_err(|_| "无法确认安装位置")?;
    let launcher =
        crate::agent_discovery::validate_executable_path(&launcher.display().to_string())?;
    if launcher != root.join(LAUNCHER_NAME) || !launcher.starts_with(&root) {
        return Err("程序启动位置已改变，原选择保持不变".into());
    }
    let node = crate::agent_discovery::validate_executable_path(&launch.node)?;
    let entry = Path::new(&launch.entrypoint)
        .canonicalize()
        .map_err(|_| "程序入口已不存在，请重新安装")?;
    let package = root.join("node_modules").join(&release.package);
    let canonical_package = package.canonicalize().map_err(|_| "无法确认程序安装包")?;
    if !canonical_package.starts_with(&root)
        || !entry.starts_with(&root)
        || !entry.is_file()
        || !entry.starts_with(&canonical_package)
    {
        return Err("程序入口不属于本次安装包".into());
    }
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(package.join("package.json")).map_err(|_| "无法读取程序安装信息")?,
    )
    .map_err(|_| "程序安装信息无效")?;
    let bin = match &manifest["bin"] {
        serde_json::Value::String(bin) => Some(bin.as_str()),
        serde_json::Value::Object(bins) => {
            bins.get(&release.bin).and_then(serde_json::Value::as_str)
        }
        _ => None,
    }
    .ok_or("官方程序入口已变化，请重新安装")?;
    if manifest["name"].as_str() != Some(&release.package)
        || manifest["version"].as_str() != Some(&release.version)
        || manifest["engines"]["node"].as_str() != Some(&release.node_engine)
        || package.join(bin).canonicalize().ok().as_ref() != Some(&entry)
    {
        return Err("程序安装内容已变化，请重新检查；原选择保持不变".into());
    }
    let expected = launcher_bytes(&node, &entry)?;
    if std::fs::read(&launcher).map_err(|_| "无法读取程序启动文件")? != expected {
        return Err("程序启动文件已变化，请重新安装；原选择保持不变".into());
    }
    let actual_node = fresh_program_version(&node, &check)?;
    if requirement_state(actual_node.as_deref(), &release.node_engine)
        != RequirementState::Satisfied
    {
        return Err("此程序所需的 Node 版本未满足或无法核对，请重新检查；原选择保持不变".into());
    }
    let actual =
        fresh_program_version(&launcher, &check)?.ok_or("程序版本暂时无法核对，请重新检查")?;
    if actual != release.version {
        return Err("程序版本与安装记录不同，请重新检查；原选择保持不变".into());
    }
    check()?;
    Ok(actual)
}

#[cfg(all(test, windows))]
mod windows_tests;

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn launcher_quotes_paths_and_forwards_arguments_cwd_and_environment() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed ' program");
        std::fs::create_dir(&root).unwrap();
        let node = temp.path().join("node ' fixture");
        std::fs::write(&node, "#!/bin/sh\nexec /bin/sh \"$@\"\n").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        let entry = root.join("entry ' fixture");
        std::fs::write(
            &entry,
            "printf '%s\\n' \"$1\" \"$2\" \"$PWD\" \"$FARFOLD_TEST_INPUT\"\n",
        )
        .unwrap();
        let (launcher, _) = create(&root, &node, &entry, "22.20.0").unwrap();
        let output = std::process::Command::new(&launcher)
            .args(["one ' argument", "two $ literal"])
            .current_dir(&root)
            .env("FARFOLD_TEST_INPUT", "fixture-only")
            .output()
            .unwrap();
        assert!(output.status.success());
        let lines = String::from_utf8(output.stdout).unwrap();
        assert!(lines.starts_with("one ' argument\ntwo $ literal\n"));
        assert!(lines.ends_with("fixture-only\n"));
        assert!(lines.contains(&format!("{}\n", root.display())));
        assert!(create(&root, &node, &entry, "22.20.0").is_err());
    }
}
