//! Farfold-only cold-open controls have their own IPC channel. Agent events
//! never enter this decoder or lose same-named fields on the raw event channel.
use super::{
    history_admission::{Cancel, Owner},
    manager::AcpManager,
};
use std::sync::Arc;
use tauri::{AppHandle, Manager as _, Window, ipc::Channel};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryAdmissionState {
    Waiting,
    Starting,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAdmissionPhase {
    kind: &'static str,
    open_token: String,
    phase: HistoryAdmissionState,
}
pub(super) type Progress = Arc<dyn Fn(HistoryAdmissionState) -> Result<(), ()> + Send + Sync>;
pub(super) struct HistoryRequest {
    pub(super) owner: Owner,
    pub(super) progress: Progress,
    pub(super) preparation_bytes: usize,
}
impl HistoryRequest {
    pub(super) fn from_window(
        manager: &AcpManager,
        window: &Window,
        token: &str,
        agent: &str,
        channel: Channel<HistoryAdmissionPhase>,
    ) -> Result<Self, String> {
        let owner = manager
            .history_admission
            .owner(window, token, agent)
            .map_err(super::cold_history_open::error)?;
        let token = token.to_owned();
        Ok(Self {
            owner,
            preparation_bytes: 0,
            progress: Arc::new(move |phase| {
                channel
                    .send(HistoryAdmissionPhase {
                        kind: "session_history_admission",
                        open_token: token.clone(),
                        phase,
                    })
                    .map_err(|_| ())
            }),
        })
    }
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCancelReply {
    open_token: String,
    outcome: &'static str,
}
impl AcpManager {
    pub(crate) fn register_history_window(
        &self,
        window: &tauri::WebviewWindow,
    ) -> Result<(), String> {
        self.history_admission
            .register_window(window)
            .map_err(super::cold_history_open::error)?;
        self.prompt_admission
            .register_window(window)
            .map_err(super::active_prompt::failure)
    }
}
#[tauri::command]
pub fn session_open_cancel_waiting(
    app: AppHandle,
    window: Window,
    open_token: String,
) -> Result<HistoryCancelReply, String> {
    let outcome = app
        .state::<AcpManager>()
        .history_admission
        .cancel_token(&window, &open_token)
        .map_err(super::cold_history_open::error)?;
    Ok(HistoryCancelReply {
        open_token,
        outcome: match outcome {
            Cancel::CancelledWaiting => "cancelledWaiting",
            Cancel::AlreadyStarting => "alreadyStarting",
            Cancel::NotFound => "notFound",
        },
    })
}

#[cfg(test)]
#[path = "history_admission_wire_tests.rs"]
mod tests;
