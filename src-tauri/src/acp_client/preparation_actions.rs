//! Explicit official configuration actions, separate from protocol authentication.
//! No credential lookup, output persistence, hidden model checks or prompt dispatch.
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::{io::Read as _, path::Path, sync::atomic::Ordering};

use serde::Serialize;
use tauri::{AppHandle, Manager as _, ipc::Channel};

use super::manager::{AcpManager, validate_cwd_async};
use super::recipes::{TerminalActionDeclaration, TerminalActionLaunch};
use crate::{
    auth::{self, attempts},
    installations::Installation,
    meta_store::{AgentRow, MetaStore},
    pty::{self, PtyManager},
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparationAction {
    pub id: String,
    pub purpose: &'static str,
    pub transport: &'static str,
    pub command: String,
    pub args: Vec<String>,
    pub source_url: String,
}

/// Verify the current registered launch against its existing managed receipt.
/// This is supplement provenance, never a new Agent compatibility requirement.
fn matching_registry_installation(row: &AgentRow, item: &Installation, data: &Path) -> bool {
    if item.agent_id != row.id
        || item.source != "managed"
        || item.program_only
        || item.args != row.args
        || item.version != row.version
    {
        return false;
    }
    let Some(root) = item.managed_root.as_deref().map(Path::new) else {
        return false;
    };
    let Some(root_canonical) = crate::managed_paths::recorded_root(
        data,
        &row.id,
        root,
        crate::managed_paths::Layout::Agent,
        false,
    ) else {
        return false;
    };
    let Some((command, registered)) = Path::new(&row.command)
        .canonicalize()
        .ok()
        .zip(Path::new(&item.command).canonicalize().ok())
    else {
        return false;
    };
    command == registered
        && command.starts_with(&root_canonical)
        && crate::agent_discovery::validate_executable_path(&row.command).is_ok()
}

fn exact_file(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|metadata| metadata.is_file())
        && path.canonicalize().ok().as_deref() == Some(path)
}

/// The ordinary npm receipt owns the loader, not the selected shared Node.
/// Reading its public manifest must not run a version command or prepare Node.
fn matching_npm_installation(
    row: &AgentRow,
    item: &Installation,
    data: &Path,
    declaration: &TerminalActionDeclaration,
) -> bool {
    let TerminalActionLaunch::Npm {
        package,
        bin,
        manifest_entry,
        loader,
    } = declaration.launch
    else {
        return false;
    };
    if item.agent_id != row.id
        || item.command != row.command
        || item.args != row.args
        || item.source != "managed"
        || item.program_only
        || item.version != row.version
        || crate::agent_discovery::validate_executable_path(&row.command).is_err()
    {
        return false;
    }
    let Some(root) = item.managed_root.as_deref().map(Path::new) else {
        return false;
    };
    if crate::managed_paths::recorded_root(
        data,
        &row.id,
        root,
        crate::managed_paths::Layout::Agent,
        false,
    )
    .is_none()
        || Some(item.path.as_str()) != root.to_str()
        || item.id != format!("{}:{}", row.id, root.display())
    {
        return false;
    }
    let package_dir = root.join("node_modules").join(package);
    let loader = package_dir.join(loader);
    if Some(row.args[0].as_str()) != loader.to_str() || !exact_file(&loader) {
        return false;
    }
    let manifest_path = package_dir.join("package.json");
    if !exact_file(&manifest_path) {
        return false;
    }
    let mut options = std::fs::File::options();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    #[cfg(windows)]
    options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    let Ok(file) = options.open(&manifest_path) else {
        return false;
    };
    if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return false;
    }
    #[cfg(windows)]
    if !file.metadata().is_ok_and(|metadata| {
        metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            == 0
    }) {
        return false;
    }
    const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
    let mut raw = Vec::new();
    if file
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut raw)
        .is_err()
        || raw.len() > MAX_MANIFEST_BYTES as usize
    {
        return false;
    }
    let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return false;
    };
    manifest["name"].as_str() == Some(package)
        && manifest["version"].as_str() == Some(declaration.version)
        && manifest["bin"][bin].as_str() == Some(manifest_entry)
}

pub(crate) fn actions_for(
    store: &MetaStore,
    row: &AgentRow,
    data: &Path,
) -> Result<Vec<PreparationAction>, String> {
    let Some(declaration) = super::recipes::terminal_action_declaration(row) else {
        return Ok(vec![]);
    };
    // Read the existing inventory, without granting ownership or writing it.
    let items: Vec<Installation> = store
        .get_setting("installations.v1")?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| "无法核对配置程序来源，请重新查看")?
        .unwrap_or_default();
    let mut args = match declaration.launch {
        TerminalActionLaunch::Native { .. } => {
            if !items
                .iter()
                .any(|item| matching_registry_installation(row, item, data))
            {
                return Ok(vec![]);
            }
            vec![]
        }
        TerminalActionLaunch::Npm { .. } => {
            let mut selected = items.iter().filter(|item| {
                item.agent_id == row.id && item.command == row.command && item.args == row.args
            });
            let Some(item) = selected.next() else {
                return Ok(vec![]);
            };
            if selected.next().is_some() || !matching_npm_installation(row, item, data, declaration)
            {
                return Ok(vec![]);
            }
            vec![row.args[0].clone()]
        }
    };
    args.extend(declaration.action_args.iter().map(|arg| (*arg).into()));
    Ok(vec![PreparationAction {
        id: declaration.id.into(),
        purpose: declaration.purpose,
        transport: "terminal",
        command: row.command.clone(),
        args,
        source_url: declaration.source_url.into(),
    }])
}

fn reviewed_action(
    store: &MetaStore,
    row: &AgentRow,
    data: &Path,
    action_id: &str,
    expected_command: &str,
    expected_args: &[String],
) -> Result<PreparationAction, String> {
    let action = actions_for(store, row, data)?
        .into_iter()
        .find(|action| action.id == action_id)
        .ok_or("此配置动作已变化，请重新查看")?;
    if action.command != expected_command || action.args != expected_args {
        return Err("配置程序已变化，请重新查看后再运行".into());
    }
    Ok(action)
}

struct TerminalOwnership {
    configuration: tokio::sync::OwnedMutexGuard<()>,
    attempt: attempts::Attempt,
    output: Channel<serde_json::Value>,
}

fn run_terminal(
    manager: &AcpManager,
    pty: &PtyManager,
    row: &AgentRow,
    action: &PreparationAction,
    cwd: &Path,
    ownership: TerminalOwnership,
) -> Result<String, String> {
    let operation = ownership.attempt.operation();
    if !operation.interested() {
        return Err("AUTH_CANCELLED".into());
    }
    if manager.shutting_down.load(Ordering::SeqCst) {
        return Err("应用正在退出，请稍后重试".into());
    }
    if manager.candidate_pending(&row.id)? {
        return Err("程序检查尚未确认结束，请稍后重试".into());
    }
    let scope = manager.reserve_preparation_action(row, &action.command, &action.args)?;
    // Only normal shell/process environment. Do not resolve Agent placeholders,
    // call credentials::apply or load the selected service's Farfold Keychain.
    let env: Vec<_> = crate::shell_env::command_env().into_iter().collect();
    let sink = auth::terminal_output(
        ownership.output,
        ownership.configuration,
        scope,
        Some(ownership.attempt),
    );
    pty.spawn_controlled(
        &action.command,
        &action.args,
        &env,
        cwd,
        portable_pty::PtySize {
            rows: pty::DEFAULT_ROWS,
            cols: pty::DEFAULT_COLS,
            pixel_width: 0,
            pixel_height: 0,
        },
        sink,
        operation.abandoned,
    )
    .map_err(|error| {
        if error == "AUTH_CANCELLED" {
            error
        } else {
            "配置终端启动失败，请重试".into()
        }
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_preparation_action_run(
    app: AppHandle,
    agent_id: String,
    action_id: String,
    cwd: String,
    source: Option<String>,
    attempt_id: String,
    expected_command: String,
    expected_args: Vec<String>,
    on_output: Channel<serde_json::Value>,
) -> Result<String, String> {
    attempts::require_existing_source(source.as_deref())?;
    let attempt = attempts::reserve(&agent_id, &attempt_id)?;
    if !attempt.operation().interested() {
        return Err("AUTH_CANCELLED".into());
    }
    let cwd = validate_cwd_async(&cwd).await?;
    let configuration = crate::install_job::configuration_guard(&agent_id).await;
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<MetaStore>();
        let row = store.get_agent(&agent_id)?.ok_or("找不到此 Agent")?;
        let data = app.path().app_data_dir().map_err(|_| "无法读取安装目录")?;
        // Re-derive under configuration ownership. Reviewed client fields never
        // become a command execution surface or an implicit source override.
        let action = reviewed_action(
            &store,
            &row,
            &data,
            &action_id,
            &expected_command,
            &expected_args,
        )?;
        run_terminal(
            &app.state::<AcpManager>(),
            &app.state::<PtyManager>(),
            &row,
            &action,
            &cwd,
            TerminalOwnership {
                configuration,
                attempt,
                output: on_output,
            },
        )
    })
    .await
    .map_err(|_| "配置操作未完成，请重试".to_string())?
}

#[cfg(test)]
#[path = "preparation_actions_tests.rs"]
mod tests;
