//! User-authorized installation of explicitly declared companion programs.
//! The official installer script is never run or modified.
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, Manager, ipc::Channel};

use crate::acp_client::preparation::{
    DependencyDeclaration, PreparationInfo, check_program, dependencies, preparation_info,
    resolve_dependency,
};
use crate::install_job::{Job, Progress};
use crate::installations::ProgramReceipt;
use crate::meta_store::{AgentRow, MetaStore};

const COMPRESSED_LIMIT: usize = 256 * 1024 * 1024;
const EXECUTABLE_LIMIT: u64 = 512 * 1024 * 1024;

fn distribution_url(
    declaration: &DependencyDeclaration,
    version_bytes: &[u8],
) -> Result<(String, String), String> {
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
            "{}/{version}/{}-{}.gz",
            declaration.download_base, declaration.binary, declaration.platform
        ),
        version.into(),
    ))
}

fn unpack_program(bytes: &[u8], destination: &Path, job: &Job, limit: u64) -> Result<(), String> {
    job.check()?;
    job.report("extract", None, None);
    let mut input = flate2::read::GzDecoder::new(bytes);
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
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o755))
        .map_err(|_| "无法设置程序执行权限")?;
    job.check()
}

struct Candidate {
    row: AgentRow,
    previous: AgentRow,
    staging: tempfile::TempDir,
    receipt: ProgramReceipt,
}

fn prepare(
    agent_id: &str,
    dependency_id: &str,
    store: &MetaStore,
    data: &Path,
    job: &Job,
) -> Result<Option<Candidate>, String> {
    job.check()?;
    let declaration = dependencies(agent_id)
        .iter()
        .find(|declaration| declaration.id == dependency_id)
        .ok_or("此 Agent 没有可自动安装的程序声明，请查看官方说明")?;
    let previous = store
        .get_agent(agent_id)?
        .ok_or("请先安装并添加此 Agent，再安装所需程序")?;
    if let Some(path) = resolve_dependency(declaration, Some(&previous)) {
        if check_program(&path, || job.check())? {
            return Ok(None);
        }
        return Err("已有程序检查未通过；已保留原选择，请检查程序位置与执行权限".into());
    }
    let version = job.download_bounded(
        declaration.version_url,
        Duration::from_secs(30),
        1024,
        Some(declaration.download_base),
    )?;
    let (url, version) = distribution_url(declaration, &version)?;
    let bytes = job.download_bounded(
        &url,
        Duration::from_secs(300),
        COMPRESSED_LIMIT,
        Some(declaration.download_base),
    )?;
    job.check()?;
    let parent = data.join("agents").join(agent_id);
    std::fs::create_dir_all(&parent).map_err(|_| "无法准备安装目录")?;
    // Direct child preserves the existing receipt-based uninstall boundary.
    let staging = tempfile::Builder::new()
        .prefix(&format!("dependency-{}-", declaration.id))
        .tempdir_in(parent)
        .map_err(|_| "无法准备所需程序的安装目录")?;
    let path = staging.path().join(declaration.binary);
    unpack_program(&bytes, &path, job, EXECUTABLE_LIMIT)?;
    job.report("check", None, None);
    if !check_program(&path, || job.check())? {
        return Err("所需程序未通过执行检查，原选择保持不变".into());
    }
    let path = path.canonicalize().map_err(|_| "无法确认所需程序位置")?;
    let mut row = previous.clone();
    row.env.push((
        declaration.program_env.into(),
        path.to_string_lossy().into_owned(),
    ));
    row.handshake = None;
    Ok(Some(Candidate {
        row,
        previous,
        staging,
        receipt: ProgramReceipt {
            path,
            version: Some(version),
        },
    }))
}

#[tauri::command]
pub async fn agent_dependency_install(
    app: AppHandle,
    agent_id: String,
    dependency_id: String,
    request_id: String,
    on_progress: Channel<Progress>,
) -> Result<PreparationInfo, String> {
    let lease = crate::install_job::begin_scoped(&agent_id, on_progress, Some(request_id))?;
    tauri::async_runtime::spawn(async move {
        let _guard = lease.job.configuration(&agent_id).await?;
        crate::agent_install::require_disconnected(&app, &agent_id)?;
        let prepare_app = app.clone();
        let prepare_id = agent_id.clone();
        let job = lease.job.clone();
        let candidate = tauri::async_runtime::spawn_blocking(move || {
            let data = prepare_app
                .path()
                .app_data_dir()
                .map_err(|_| "无法读取安装目录")?;
            prepare(
                &prepare_id,
                &dependency_id,
                &prepare_app.state::<MetaStore>(),
                &data,
                &job,
            )
        })
        .await
        .map_err(|_| "所需程序准备失败，请重试")??;
        if let Some(candidate) = candidate {
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
        lease.job.check()?;
        tauri::async_runtime::spawn_blocking(move || {
            let data = app.path().app_data_dir().map_err(|_| "无法读取安装目录")?;
            let row = app.state::<MetaStore>().get_agent(&agent_id)?;
            preparation_info(&agent_id, row.as_ref(), &data)
        })
        .await
        .map_err(|_| "无法读取安装后的准备信息")?
    })
    .await
    .map_err(|_| "所需程序安装未完成，请重试".to_string())?
}

#[tauri::command]
pub fn agent_dependency_cancel(agent_id: String, request_id: String) -> Result<(), String> {
    crate::install_job::cancel_matching(&agent_id, &request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
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
