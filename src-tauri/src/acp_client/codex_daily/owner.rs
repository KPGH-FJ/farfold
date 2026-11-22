use super::{ConversationAccess, Descriptor, Receipt, transport, wire};
use crate::acp_client::extension_inventory::{Code, launch, output, process};
use crate::acp_client::session_index::{now_millis, session_row_id};
use crate::acp_client::{
    model_guard::ConfigCheck, official_preflight::offline, session::SessionOpenResult,
};
use crate::meta_store::{AgentRow, MetaStore, SessionRow, codex_app_server::Owner};
use serde_json::{Value, json};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const TITLE: &str = "Codex 新对话";
const ACCOUNT: &str = "未能确认与原设置使用同一账号和工作区";

fn check_identifier() -> Result<String, String> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| "无法准备检查，请重试")?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(crate) struct OpenRequest {
    pub row: AgentRow,
    pub cwd: PathBuf,
    pub native_id: Option<String>,
    pub options: Vec<(String, Value)>,
    pub previous: Option<Owner>,
}

struct Admission {
    operation: crate::acp_client::manager::AuthenticationOperation,
    deadline: Instant,
}

impl process::Control for Admission {
    fn interested(&self) -> bool {
        self.operation.interested()
    }

    fn deadline(&self) -> Instant {
        self.deadline
    }

    fn pending_cleanup(&self) {}
}

fn exchange<T>(
    command: std::process::Command,
    admission: &Admission,
    mut request: wire::Exchange,
    finish: impl FnOnce(wire::Exchange, &[u8]) -> crate::acp_client::extension_inventory::Result<T>,
) -> crate::acp_client::extension_inventory::Result<T> {
    let output = process::run_owned(command, admission, Some(&mut request), output::STDOUT_LIMIT);
    let stage = request.stage();
    let result = output.and_then(|mut bytes| {
        let result = finish(request, &bytes);
        bytes.fill(0);
        result
    });
    if let Err(failure) = &result {
        crate::logging::record_codex_conversation_failure(stage, failure.code);
    }
    result
}

fn checked_path(root: &Path, path: &Path) -> bool {
    root.canonicalize().is_ok_and(|actual| actual == root)
        && path.starts_with(root)
        && path.canonicalize().is_ok_and(|actual| actual == path)
        && path.symlink_metadata().is_ok_and(|data| {
            data.is_file() && data.nlink() == 1 && data.uid() == unsafe { libc::geteuid() }
        })
}

fn selected(options: &[(String, Value)], key: &str) -> Result<String, String> {
    options
        .iter()
        .find(|(id, _)| id == key)
        .and_then(|(_, value)| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "请先确认并保存模型和思考强度".into())
}

pub(crate) async fn open(
    app: &AppHandle,
    store: &MetaStore,
    request: OpenRequest,
) -> Result<SessionOpenResult, String> {
    let data = app.path().app_data_dir().map_err(|_| "无法读取安装目录")?;
    launch::admission(&request.row).map_err(|_| "请先确认 Codex 程序")?;
    let id = format!("official-conversation:{}", check_identifier()?);
    let attempt = crate::auth::attempts::reserve(&request.row.id, &id)?;
    let configuration = attempt.configuration_guard(store).await?;
    let store = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _configuration = configuration;
        let _process = crate::acp_client::extension_inventory::execution::acquire()
            .map_err(|_| "Agent 正在检查，请稍后重试")?;
        let admission = Admission {
            operation: attempt.operation(),
            deadline: Instant::now() + Duration::from_secs(45),
        };
        let current = store.get_agent(&request.row.id)?;
        if !current
            .as_ref()
            .is_some_and(|value| launch::same_selection(&request.row, value))
        {
            return Err("Agent 程序已改变，请重新检查".into());
        }
        if crate::shell_env::cached_command_env().is_none() {
            let _ = crate::shell_env::command_env();
        }
        let descriptor = super::descriptor(&request.row, &data)
            .ok_or("请先确认 Codex 程序和新对话的官方登录")?;
        let result = checked_open(&store, &data, &admission, descriptor, request);
        attempt.check()?;
        result
    })
    .await
    .map_err(|_| "未能核对对话设置，请重试".to_owned())?
}

fn checked_open(
    store: &MetaStore,
    data: &Path,
    admission: &Admission,
    descriptor: Descriptor,
    request: OpenRequest,
) -> Result<SessionOpenResult, String> {
    let OpenRequest {
        row,
        cwd,
        native_id,
        options,
        previous,
    } = request;
    let (model, effort) = if let Some(previous) = &previous {
        (previous.model.clone(), previous.effort.clone())
    } else {
        (
            selected(&options, descriptor.model_option_id)?,
            selected(&options, descriptor.reasoning_option_id)?,
        )
    };
    let mut original = offline::launch(&row).map_err(|_| ACCOUNT)?;
    let original_auth = exchange(
        original.command.take().ok_or(ACCOUNT)?,
        admission,
        wire::Exchange::account().map_err(|_| ACCOUNT)?,
        wire::Exchange::finish_account,
    )
    .map_err(|failure| {
        crate::logging::warn(
            "acp_client",
            format_args!("official conversation original account: {:?}", failure.code),
        );
        ACCOUNT
    })?;
    if !original.unchanged() {
        return Err(ACCOUNT.into());
    }

    let mut dedicated = transport::launch(&row, data, &cwd, &model, &effort)
        .map_err(|_| "未能打开独立 Codex 目录，请检查官方登录")?;
    let cwd = dedicated.cwd.to_str().ok_or("无法读取工作文件夹")?;
    let resumed = native_id.is_some();
    let request = match (native_id, previous) {
        (Some(id), Some(previous)) if original_auth.fingerprint() == previous.account_digest => {
            wire::Exchange::resume(
                cwd,
                &model,
                &effort,
                &id,
                &previous.account_digest,
                dedicated.history_root(),
            )
        }
        (None, None) => wire::Exchange::start(
            cwd,
            &model,
            &effort,
            TITLE,
            &original_auth,
            dedicated.history_root(),
        ),
        _ => return Err(ACCOUNT.into()),
    }
    .map_err(|_| "无法核对这段对话的设置")?;
    let receipt = exchange(
        dedicated.command.take().ok_or("无法启动 Codex")?,
        admission,
        request,
        wire::Exchange::finish,
    )
    .map_err(|failure| {
        crate::logging::warn(
            "acp_client",
            format_args!(
                "official conversation {}: {:?}",
                if resumed { "resume" } else { "start" },
                failure.code
            ),
        );
        if matches!(
            failure.code,
            Code::ConfigurationChanged | Code::SelectionChanged | Code::Unavailable
        ) {
            ACCOUNT
        } else if resumed {
            "未能在原对话核对账号和实际权限，请重新打开"
        } else {
            "未能确认新对话已保存，请检查 Codex 对话记录"
        }
    })?;
    if !original.unchanged()
        || !dedicated.current()
        || !process::Control::interested(admission)
        || !receipt
            .path
            .as_deref()
            .is_some_and(|path| checked_path(dedicated.history_root(), path))
    {
        return Err("对话设置或保存位置发生变化，请重新检查".into());
    }
    let connection_id = check_identifier()?;
    let current = json!({"model": &receipt.model, "reasoning_effort": &receipt.effort});
    if !resumed {
        let now = now_millis();
        store.insert_codex_app_server_session(
            &SessionRow {
                id: session_row_id(&row.id, cwd, &receipt.thread_id),
                agent_id: row.id,
                cwd: cwd.to_owned(),
                native_session_id: Some(receipt.thread_id.clone()),
                title: Some(TITLE.into()),
                config_options: Some(current.clone()),
                pinned: false,
                archived: false,
                created_at: now,
                updated_at: now,
            },
            &Owner {
                model: receipt.model.clone(),
                effort: receipt.effort.clone(),
                account_digest: receipt.account_sha256,
            },
        )?;
    }
    Ok(SessionOpenResult {
        conversation_access: Some(ConversationAccess {
            kind: "zero-send",
            receipt: Receipt {
                account_verified: true,
                provider: receipt.provider,
                file_access: "read-only",
                tool_network: false,
                approval: "on-request",
                model: receipt.model,
                effort: receipt.effort,
            },
        }),
        history_empty_confirmed: true,
        identity_read: None,
        session_tool_inventory: None,
        workspace_access: None,
        session_operations: Default::default(),
        connection_id,
        native_session_id: receipt.thread_id,
        cwd: receipt.cwd,
        config_options: Value::Null,
        config_options_modern: true,
        legacy_thought_mode_mirror: None,
        config_check: ConfigCheck {
            status: "ready",
            issues: vec![],
            current,
            protected_ids: vec![],
            explicit_model_apply: false,
        },
        permission_config_id: None,
        permission_state: "ready",
        permission_effect: None,
        modes: None,
        models: None,
        meta: None,
        resumed,
        warnings: vec![],
        service: None,
        service_context: None,
        service_model_value: None,
    })
}
