//! Dedicated Farfold cancellation channel; raw Agent envelopes grant no rights.
use super::{active_prompt::CancelRequest, history_admission::Cancel, manager::AcpManager};
use std::path::Path;
use tauri::{AppHandle, Manager as _, Window};
use tokio::{sync::oneshot, time::Instant};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelReply {
    receipt_id: u64,
    outcome: &'static str,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn session_prompt_cancel(
    app: AppHandle,
    window: Window,
    prompt_token: String,
    receipt_id: u64,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
) -> Result<CancelReply, String> {
    let manager = app.state::<AcpManager>();
    let owner = manager
        .prompt_admission
        .owner(&window, &prompt_token, &agent_id)
        .map_err(super::active_prompt::failure)?;
    let outcome = match manager
        .prompt_admission
        .cancel(receipt_id, &owner)
        .map_err(super::active_prompt::failure)?
    {
        Cancel::CancelledWaiting => "cancelledBeforeOffer",
        Cancel::NotFound => "notFound",
        Cancel::AlreadyStarting => {
            // Stop remains available when a formerly canonical directory has
            // disappeared. Never re-resolve or route to an alternative source.
            let path = Path::new(&cwd);
            if !path.is_absolute() || cwd.contains('\0') {
                return Err("无法识别此对话".into());
            }
            let connection = manager.session_connection(&agent_id, path, &session_id)?;
            if connection.connection_id != connection_id {
                return Err("对话连接已变化".into());
            }
            let control = {
                let sessions = connection.sessions.lock().map_err(|_| "无法读取对话状态")?;
                sessions
                    .get(&session_id)
                    .ok_or("对话已关闭")?
                    .control
                    .clone()
            };
            let (result, receive) = oneshot::channel();
            control
                .send(super::pump::SessionControl::CancelPrompt {
                    request: CancelRequest {
                        owner,
                        receipt_id,
                        result,
                    },
                    deadline: Instant::now() + std::time::Duration::from_secs(10),
                })
                .map_err(|_| "无法确认停止请求")?;
            let matched = super::wait::reply(
                receive,
                std::time::Duration::from_secs(10),
                "owned prompt cancel",
            )
            .await??;
            if matched {
                "cancelRequested"
            } else {
                "notFound"
            }
        }
    };
    // cancelRequested acknowledges notification only, never a terminal outcome.
    Ok(CancelReply {
        receipt_id,
        outcome,
    })
}
