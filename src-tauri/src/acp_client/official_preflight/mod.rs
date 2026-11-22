//! An independent official preparation check. Its receipt never authorizes
//! sending in an ACP conversation or changes the registered program.
#[cfg(target_os = "macos")]
use super::extension_inventory::launch;
use super::extension_inventory::{Code, Result, allowed, context};
use crate::meta_store::AgentRow;
use serde::Serialize;
use tauri::{AppHandle, Webview};

#[cfg(target_os = "macos")]
mod offline;
#[cfg(any(target_os = "macos", test))]
mod wire;

const CHECK: &str = "app-server-readonly";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    id: &'static str,
    model_option_id: &'static str,
    reasoning_option_id: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    account_present: bool,
    workspace_reported: bool,
    model: String,
    reasoning_effort: String,
    provider: String,
}

pub(super) fn descriptor(row: &AgentRow) -> Option<Descriptor> {
    #[cfg(target_os = "macos")]
    if offline::available() && launch::admission(row).is_ok() {
        return Some(Descriptor {
            id: CHECK,
            model_option_id: "model",
            reasoning_option_id: "reasoning_effort",
        });
    }
    let _ = row;
    None
}

fn attempt_id(request_id: &str) -> Result<String> {
    if request_id.len() != 36
        || !request_id.bytes().enumerate().all(|(offset, byte)| {
            if matches!(offset, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err(Code::InvalidRequest.into());
    }
    Ok(format!("official-readonly:{request_id}"))
}

fn selection(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_official_readonly_check(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    check_id: String,
    request_id: String,
    cwd: String,
    model: String,
    reasoning_effort: String,
) -> Result<Receipt> {
    let store = context(&app, &webview, "agent_official_readonly_check")?;
    let attempt_id = attempt_id(&request_id)?;
    if !selection(&agent_id)
        || !selection(&model)
        || !selection(&reasoning_effort)
        || check_id != CHECK
    {
        return Err(Code::InvalidRequest.into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (store, attempt_id, cwd);
        Err(Code::PlatformUnsupported.into())
    }
    #[cfg(target_os = "macos")]
    {
        let row = store
            .run({
                let id = agent_id.clone();
                move |store| store.get_agent(&id)?.ok_or("unavailable".into())
            })
            .await
            .map_err(|_| Code::Unavailable)?;
        if descriptor(&row).is_none() {
            return Err(Code::NotReviewed.into());
        }
        let attempt =
            crate::auth::attempts::reserve(&agent_id, &attempt_id).map_err(|_| Code::Busy)?;
        let configuration = attempt
            .configuration_guard(&store)
            .await
            .map_err(|_| attempt_code(&attempt))?;
        tauri::async_runtime::spawn_blocking(move || {
            let _configuration = configuration;
            let _permit = super::extension_inventory::execution::acquire()?;
            let current = store.get_agent(&agent_id).map_err(|_| Code::Unavailable)?;
            if !current
                .as_ref()
                .is_some_and(|value| launch::same_selection(&row, value))
            {
                return Err(Code::SelectionChanged.into());
            }
            let selected_directory = launch::Directory::open(&cwd)?;
            let control = OfflineCheck {
                operation: attempt.operation(),
                deadline: std::time::Instant::now() + std::time::Duration::from_secs(45),
            };
            attempt.check().map_err(|_| Code::Cancelled)?;
            let mut isolated = offline::launch(&row)?;
            let path = isolated.cwd.to_str().ok_or(Code::CwdUnavailable)?;
            let mut exchange = wire::Exchange::new(path, &model, &reasoning_effort)?;
            let command = isolated.command.take().ok_or(Code::SpawnFailed)?;
            let output = super::extension_inventory::process::run_owned(
                command,
                &control,
                Some(&mut exchange),
                super::extension_inventory::output::STDOUT_LIMIT,
            );
            let mut result = output.and_then(|mut output| {
                let result = exchange.finish(&output);
                output.fill(0);
                result
            });
            if !isolated.unchanged() || !selected_directory.current() {
                return Err(Code::SelectionChanged.into());
            }
            if attempt.check().is_err() {
                result = Err(Code::Cancelled.into());
            }
            result
        })
        .await
        .map_err(|_| Code::QueryFailed)?
    }
}

#[cfg(target_os = "macos")]
fn attempt_code(attempt: &crate::auth::attempts::Attempt) -> Code {
    if attempt.check().is_ok() {
        Code::Busy
    } else {
        Code::Cancelled
    }
}

#[cfg(target_os = "macos")]
struct OfflineCheck {
    operation: super::manager::AuthenticationOperation,
    deadline: std::time::Instant,
}

#[cfg(target_os = "macos")]
impl super::extension_inventory::process::Control for OfflineCheck {
    fn interested(&self) -> bool {
        self.operation.interested()
    }
    fn deadline(&self) -> std::time::Instant {
        self.deadline
    }
    // Keep the operation owner until the existing supervisor actually reaps the child.
    fn pending_cleanup(&self) {}
}

#[tauri::command]
pub fn agent_official_readonly_check_cancel(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<()> {
    allowed(&webview)?;
    if !selection(&agent_id) {
        return Err(Code::InvalidRequest.into());
    }
    crate::auth::attempts::auth_cancel(agent_id, attempt_id(&request_id)?)
        .map_err(|_| Code::SelectionChanged.into())
}
