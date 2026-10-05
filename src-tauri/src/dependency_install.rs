//! User-authorized installation of explicitly declared companion programs.
//! The official installer script is never run or modified.
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager, ipc::Channel};

use crate::acp_client::preparation::{
    DependencyDeclaration, PreparationInfo, check_program, dependencies, preparation_with_catalog,
    resolve_dependency,
};
use crate::acp_client::recipes::DependencyDistribution;
use crate::install_job::{Job, Progress};
use crate::installations::ProgramReceipt;
use crate::meta_store::{AgentRow, MetaStore};

const COMPRESSED_LIMIT: usize = 256 * 1024 * 1024;
const EXECUTABLE_LIMIT: u64 = 512 * 1024 * 1024;

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DependencyInstallMode {
    #[default]
    InstallMissing,
    PrepareCandidate,
}

fn distribution_url(
    declaration: &DependencyDeclaration,
    version_bytes: &[u8],
) -> Result<(String, String), String> {
    let (download_base, platform, suffix) = match declaration.distribution {
        DependencyDistribution::Gzip {
            download_base,
            platform,
            ..
        } => (download_base, platform, "gz"),
        DependencyDistribution::Executable {
            download_base,
            platform,
            ..
        } => (download_base, platform, "exe"),
        _ => return Err("此程序不使用此下载方式".into()),
    };
    let version = std::str::from_utf8(version_bytes)
        .map_err(|_| "无法读取官方版本信息")?
        .trim();
    // A version is one path component, never a command, URL or path traversal.
    if version.is_empty()
        || version.len() > 128
        || !version.as_bytes()[0].is_ascii_alphanumeric()
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
        || version.contains("..")
    {
        return Err("官方版本信息格式已变化，请查看官方说明".into());
    }
    Ok((
        format!(
            "{}/{version}/{}-{}.{suffix}",
            download_base, declaration.binary, platform
        ),
        version.into(),
    ))
}

fn unpack_program(bytes: &[u8], destination: &Path, job: &Job, limit: u64) -> Result<(), String> {
    write_program(flate2::read::GzDecoder::new(bytes), destination, job, limit)
}
fn write_program(
    mut input: impl Read,
    destination: &Path,
    job: &Job,
    limit: u64,
) -> Result<(), String> {
    job.check()?;
    job.report("extract", None, None);
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| "无法保存所需程序")?;
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        job.check()?;
        let count = input
            .read(&mut buffer)
            .map_err(|_| "所需程序下载不完整，请重试")?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > limit {
            return Err("所需程序超过允许大小，请查看官方说明".into());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|_| "无法保存所需程序，请检查磁盘空间")?;
    }
    if total == 0 {
        return Err("下载的所需程序为空，请重试".into());
    }
    output.sync_all().map_err(|_| "无法完成程序保存")?;
    crate::process_platform::set_executable(destination).map_err(|_| "无法设置程序执行权限")?;
    job.check()
}

struct Candidate {
    row: AgentRow,
    previous: AgentRow,
    staging: tempfile::TempDir,
    receipt: ProgramReceipt,
    component_version: Option<String>,
}

#[cfg(test)]
fn prepare(
    agent_id: &str,
    dependency_id: &str,
    store: &MetaStore,
    data: &Path,
    job: &Job,
) -> Result<Option<Candidate>, String> {
    prepare_with_mode(
        agent_id,
        dependency_id,
        store,
        data,
        job,
        DependencyInstallMode::InstallMissing,
        &crate::node_runtime::NodeRuntimeState::new(data.into()),
    )
}

fn owned_parent(data: &Path, agent_id: &str) -> Result<std::path::PathBuf, String> {
    let data = data.canonicalize().map_err(|_| "无法确认安装目录")?;
    let expected = crate::managed_programs::parent(&data, agent_id);
    let relative = expected
        .strip_prefix(&data)
        .map_err(|_| "无法确认所需程序目录")?;
    let mut parent = data.clone();
    for part in relative.components() {
        let std::path::Component::Normal(part) = part else {
            return Err("无法确认所需程序目录".into());
        };
        parent.push(part);
        match std::fs::symlink_metadata(&parent) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&parent).map_err(|_| "无法准备安装目录")?
            }
            Err(_) => return Err("无法确认所需程序目录".into()),
        }
        let metadata = std::fs::symlink_metadata(&parent).map_err(|_| "无法确认所需程序目录")?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || !parent
                .canonicalize()
                .map_err(|_| "无法确认所需程序目录")?
                .starts_with(&data)
        {
            return Err("安装目录位置已变化，原程序保持不变".into());
        }
    }
    Ok(parent)
}

fn npm_requirement(
    declaration: &DependencyDeclaration,
    previous: &AgentRow,
    component_version: Option<&str>,
) -> Result<Option<&'static str>, String> {
    let verified = crate::acp_client::recipes::verified_for(previous)
        .iter()
        .find(|verified| verified.id == declaration.id)
        .ok_or("此程序声明与当前接入不匹配，请查看官方说明；原选择保持不变")?;
    if verified.support.is_none() {
        return Ok(None);
    }
    crate::acp_client::recipes::support_for(verified, previous, component_version)
        .map(|support| Some(support.range))
        .ok_or_else(|| "此接入版本的官方程序要求尚未核对，请查看官方说明；原选择保持不变".into())
}

fn prepare_with_mode(
    agent_id: &str,
    dependency_id: &str,
    store: &MetaStore,
    data: &Path,
    job: &Job,
    mode: DependencyInstallMode,
    node_state: &crate::node_runtime::NodeRuntimeState,
) -> Result<Option<Candidate>, String> {
    job.check()?;
    let declaration = dependencies(agent_id)
        .iter()
        .find(|declaration| declaration.id == dependency_id)
        .ok_or("此 Agent 没有可自动安装的程序声明，请查看官方说明")?;
    let previous = store
        .get_agent(agent_id)?
        .ok_or("请先安装并添加此 Agent，再安装所需程序")?;
    if !crate::acp_client::recipes::declared_for(&previous)
        .iter()
        .any(|declared| declared.id == dependency_id)
    {
        return Err("此程序声明与当前接入不匹配，请查看官方说明；原选择保持不变".into());
    }
    let component_version = crate::acp_client::recipes::component_version(&previous);
    let npm_range = if matches!(declaration.distribution, DependencyDistribution::Npm { .. }) {
        npm_requirement(declaration, &previous, component_version.as_deref())?
    } else {
        None
    };
    if mode == DependencyInstallMode::InstallMissing
        && let Some(path) = resolve_dependency(declaration, Some(&previous))
    {
        if check_program(&path, || job.check())? {
            return Ok(None);
        }
        return Err("已有程序检查未通过；已保留原选择，请检查程序位置与执行权限".into());
    }
    job.check()?;
    let parent = owned_parent(data, agent_id)?;
    // Direct child preserves the existing receipt-based uninstall boundary.
    let staging = tempfile::Builder::new()
        .prefix(&format!("dependency-{}-", declaration.id))
        .tempdir_in(parent)
        .map_err(|_| "无法准备所需程序的安装目录")?;
    let receipt = match declaration.distribution {
        DependencyDistribution::Gzip {
            version_url,
            download_base,
            ..
        }
        | DependencyDistribution::Executable {
            version_url,
            download_base,
            ..
        } => {
            let version = job.download_bounded(
                version_url,
                Duration::from_secs(30),
                1024,
                Some(download_base),
            )?;
            let (url, version) = distribution_url(declaration, &version)?;
            let bytes = job.download_bounded(
                &url,
                Duration::from_secs(300),
                COMPRESSED_LIMIT,
                Some(download_base),
            )?;
            let direct = matches!(
                declaration.distribution,
                DependencyDistribution::Executable { .. }
            );
            let path = staging.path().join(if direct {
                format!("{}.exe", declaration.binary)
            } else {
                declaration.binary.into()
            });
            if direct {
                write_program(std::io::Cursor::new(&bytes), &path, job, EXECUTABLE_LIMIT)?;
            } else {
                unpack_program(&bytes, &path, job, EXECUTABLE_LIMIT)?;
            }
            job.report("check", None, None);
            if !check_program(&path, || job.check())? {
                return Err("所需程序未通过执行检查，原选择保持不变".into());
            }
            ProgramReceipt {
                path: path.canonicalize().map_err(|_| "无法确认所需程序位置")?,
                version: Some(version),
                node_launch: None,
                release: None,
            }
        }
        DependencyDistribution::Npm { package, bin } => {
            let release = crate::npm_release::select(package, bin, npm_range, job)?;
            let runtime = node_state.get_for_engine(&release.node_engine, job)?;
            let spec = format!("{package}@{}", release.version);
            job.report("install", None, None);
            let (node, entry) =
                crate::node_runtime::npm_install_named(&runtime, &spec, bin, staging.path(), job)?;
            let (path, launch) = crate::program_launch::create(
                staging.path(),
                &node,
                &entry,
                runtime.version.as_deref().ok_or("安装工具版本无法核对")?,
            )?;
            job.report("check", None, None);
            let version =
                crate::program_launch::validate(staging.path(), &path, &launch, &release, || {
                    job.check()
                })?;
            ProgramReceipt {
                path,
                version: Some(version),
                node_launch: Some(launch),
                release: Some(release),
            }
        }
    };
    let mut row = previous.clone();
    row.env.retain(|(name, _)| name != declaration.program_env);
    row.env.push((
        declaration.program_env.into(),
        receipt.path.to_string_lossy().into_owned(),
    ));
    row.handshake = None;
    Ok(Some(Candidate {
        row,
        previous,
        staging,
        receipt,
        component_version,
    }))
}

#[cfg(test)]
#[path = "dependency_install_tests.rs"]
mod companion_tests;

#[tauri::command]
pub async fn agent_dependency_install(
    app: AppHandle,
    agent_id: String,
    dependency_id: String,
    request_id: String,
    on_progress: Channel<Progress>,
    mode: Option<DependencyInstallMode>,
) -> Result<PreparationInfo, String> {
    let lease = crate::install_job::begin_scoped(&agent_id, on_progress, Some(request_id))?;
    tauri::async_runtime::spawn(async move {
        let _guard = lease.job.configuration(&agent_id).await?;
        let mode = mode.unwrap_or_default();
        let install_tool = crate::uv_runtime::declared(
            &app.state::<crate::agent_catalog::AgentCatalog>(),
            &agent_id,
        );
        if !install_tool && mode == DependencyInstallMode::InstallMissing {
            crate::agent_install::require_disconnected(&app, &agent_id)?;
        }
        let prepare_app = app.clone();
        let prepare_id = agent_id.clone();
        let job = lease.job.clone();
        let candidate = tauri::async_runtime::spawn_blocking(move || {
            let data = prepare_app
                .path()
                .app_data_dir()
                .map_err(|_| "无法读取安装目录")?;
            if install_tool {
                if mode == DependencyInstallMode::PrepareCandidate {
                    return Err("此安装工具不使用程序候选，请选择安装所需工具".into());
                }
                job.report("prepare", None, None);
                crate::uv_runtime::install_dependency(&data, &dependency_id, &job)?;
                Ok(None)
            } else {
                prepare_with_mode(
                    &prepare_id,
                    &dependency_id,
                    &prepare_app.state::<MetaStore>(),
                    &data,
                    &job,
                    mode,
                    &prepare_app.state::<crate::node_runtime::NodeRuntimeState>(),
                )
            }
        })
        .await
        .map_err(|_| "所需程序准备失败，请重试")??;
        if let Some(candidate) = candidate {
            if mode == DependencyInstallMode::PrepareCandidate {
                let publish_app = app.clone();
                let publish_job = lease.job.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    publish_candidate(&publish_app.state::<MetaStore>(), candidate, &publish_job)
                })
                .await
                .map_err(|_| "程序候选准备未完成，原选择保持不变")??;
            } else {
                crate::agent_install::check_and_select_program(
                    &app,
                    candidate.row,
                    Some(candidate.previous),
                    Some(candidate.staging),
                    lease.job.clone(),
                    Some(candidate.receipt),
                )
                .await?;
            }
        }
        lease.job.check()?;
        tauri::async_runtime::spawn_blocking(move || {
            let data = app.path().app_data_dir().map_err(|_| "无法读取安装目录")?;
            let row = app.state::<MetaStore>().get_agent(&agent_id)?;
            preparation_with_catalog(
                &agent_id,
                row.as_ref(),
                &data,
                &app.state::<crate::agent_catalog::AgentCatalog>(),
            )
        })
        .await
        .map_err(|_| "无法读取安装后的准备信息")?
    })
    .await
    .map_err(|_| "所需程序安装未完成，请重试".to_string())?
}

fn publish_candidate(store: &MetaStore, candidate: Candidate, job: &Job) -> Result<(), String> {
    job.commit(|| {
        if crate::acp_client::recipes::declared_for(&candidate.previous).is_empty()
            || crate::acp_client::recipes::component_version(&candidate.previous)
                != candidate.component_version
        {
            return Err("接入组件已变化，请重新准备；原选择保持不变".into());
        }
        crate::installations::record_unselected_program(
            store,
            &candidate.previous,
            candidate.staging.path(),
            &candidate.receipt,
        )?;
        let _ = candidate.staging.keep();
        job.report("ready", None, None);
        Ok(())
    })
}

#[tauri::command]
pub fn agent_dependency_cancel(agent_id: String, request_id: String) -> Result<(), String> {
    crate::install_job::cancel_matching(&agent_id, &request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unselected_fixture(
        store: &MetaStore,
        data: &Path,
        lease: &crate::install_job::Lease,
    ) -> Candidate {
        let parent = owned_parent(data, "registry:amp-acp").unwrap();
        let staging = tempfile::Builder::new()
            .prefix("dependency-fixture-")
            .tempdir_in(parent)
            .unwrap();
        let path = staging.path().join("program");
        std::fs::write(&path, "fixture").unwrap();
        let previous = AgentRow {
            id: "registry:amp-acp".into(),
            name: "Amp".into(),
            source: "registry".into(),
            command: "/fixture/amp-acp".into(),
            args: vec![],
            env: vec![("AMP_CLI_PATH".into(), "/external/kept-program".into())],
            version: None,
            handshake: None,
            created_at: 1,
            updated_at: 1,
        };
        store.insert_agent(&previous).unwrap();
        lease.job.check().unwrap();
        let mut row = previous.clone();
        row.env[0].1 = path.display().to_string();
        Candidate {
            row,
            previous,
            staging,
            receipt: ProgramReceipt {
                path,
                version: Some("1.0.0".into()),
                node_launch: None,
                release: None,
            },
            component_version: None,
        }
    }

    #[test]
    fn publish_mode_only_keeps_unselected_receipt_and_cancel_cleans_its_owned_directory() {
        let data = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
        let lease =
            crate::install_job::begin("publish-unselected-program", Channel::new(|_| Ok(())))
                .unwrap();
        let candidate = unselected_fixture(&store, data.path(), &lease);
        let previous = candidate.previous.clone();
        let root = candidate.staging.path().to_owned();
        publish_candidate(&store, candidate, &lease.job).unwrap();
        assert!(root.exists());
        assert_eq!(store.get_agent(&previous.id).unwrap().unwrap(), previous);
        let inventory = store.get_setting("installations.v1").unwrap().unwrap();
        assert_eq!(inventory.as_array().unwrap().len(), 1);
        assert_eq!(inventory[0]["programOnly"], true);
        assert!(
            store
                .get_setting("installPrevious.registry:amp-acp")
                .unwrap()
                .is_none()
        );
        assert!(
            crate::install_job::agent_install_cancel("publish-unselected-program".into()).is_err()
        );
        assert!(root.exists());
        lease.job.check().unwrap();

        let other = tempfile::tempdir().unwrap();
        let other_store = MetaStore::open(&other.path().join("meta.db")).unwrap();
        let cancelled =
            crate::install_job::begin("publish-unselected-cancel", Channel::new(|_| Ok(())))
                .unwrap();
        let candidate = unselected_fixture(&other_store, other.path(), &cancelled);
        let previous = candidate.previous.clone();
        let root = candidate.staging.path().to_owned();
        crate::install_job::agent_install_cancel("publish-unselected-cancel".into()).unwrap();
        assert!(publish_candidate(&other_store, candidate, &cancelled.job).is_err());
        assert!(!root.exists());
        assert_eq!(
            other_store.get_agent(&previous.id).unwrap().unwrap(),
            previous
        );
        assert!(
            other_store
                .get_setting("installations.v1")
                .unwrap()
                .is_none()
        );
    }
    fn compressed(text: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(text).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn official_version_is_only_a_path_component_not_a_version_gate() {
        let declaration = &dependencies("registry:amp-acp")[0];
        let (url, version) = distribution_url(declaration, b"0.0.1790380893-geeadb1\n").unwrap();
        assert_eq!(version, "0.0.1790380893-geeadb1");
        assert_eq!(
            url,
            "https://static.ampcode.com/cli/0.0.1790380893-geeadb1/amp-darwin-arm64.gz"
        );
        assert!(distribution_url(declaration, b"2099.100.1-future").is_ok());
        for bad in [
            "",
            "../other",
            "https://other.invalid",
            "1?key=secret",
            "1\n2",
            "a/other",
            "$(echo bad)",
        ] {
            assert!(distribution_url(declaration, bad.as_bytes()).is_err());
        }
    }

    #[test]
    fn unpack_is_bounded_exclusive_and_cancellable() {
        let dir = tempfile::tempdir().unwrap();
        let lease =
            crate::install_job::begin("dependency-unpack", Channel::new(|_| Ok(()))).unwrap();
        let target = dir.path().join("program");
        unpack_program(&compressed(b"fixture"), &target, &lease.job, 7).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"fixture");
        assert!(unpack_program(&compressed(b"replace"), &target, &lease.job, 7).is_err());
        assert!(
            unpack_program(
                &compressed(b"oversized"),
                &dir.path().join("large"),
                &lease.job,
                3
            )
            .is_err()
        );
        assert!(unpack_program(b"not gzip", &dir.path().join("invalid"), &lease.job, 99).is_err());
        crate::install_job::agent_install_cancel("dependency-unpack".into()).unwrap();
        let cancelled = dir.path().join("cancelled");
        assert!(unpack_program(&compressed(b"x"), &cancelled, &lease.job, 9).is_err());
        assert!(!cancelled.exists());
    }

    #[test]
    fn unknown_dependency_and_absent_registration_fail_before_any_download() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        let lease =
            crate::install_job::begin("dependency-no-download", Channel::new(|_| Ok(()))).unwrap();
        assert!(prepare("registry:unknown", "guess", &store, dir.path(), &lease.job).is_err());
        assert!(
            prepare(
                "registry:amp-acp",
                "amp-cli",
                &store,
                dir.path(),
                &lease.job
            )
            .is_err()
        );
        assert!(!dir.path().join("agents").exists());
    }

    #[test]
    fn selected_missing_program_is_preserved_without_installing_a_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        let row = AgentRow {
            id: "registry:amp-acp".into(),
            name: "Amp".into(),
            source: "registry".into(),
            command: "/external/amp-acp".into(),
            args: vec![],
            env: vec![(
                "AMP_CLI_PATH".into(),
                dir.path().join("missing-user-choice").display().to_string(),
            )],
            version: None,
            handshake: None,
            created_at: 1,
            updated_at: 1,
        };
        store.insert_agent(&row).unwrap();
        let lease =
            crate::install_job::begin("dependency-preserve-choice", Channel::new(|_| Ok(())))
                .unwrap();
        assert!(prepare(&row.id, "amp-cli", &store, dir.path(), &lease.job).is_err());
        assert_eq!(store.get_agent(&row.id).unwrap(), Some(row));
        assert!(!dir.path().join("agents").exists());
    }
}
