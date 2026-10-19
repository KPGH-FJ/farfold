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
    NotStarted,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAdmissionPhase {
    kind: &'static str,
    open_token: String,
    phase: HistoryAdmissionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    history_delivery: Option<super::history_admission::HistoryDeliveryReceipt>,
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
        let delivery_owner = owner.clone();
        let gate = manager.history_admission.clone();
        Ok(Self {
            owner,
            preparation_bytes: 0,
            progress: Arc::new(move |phase| {
                let history_delivery = if phase == HistoryAdmissionState::Starting {
                    Some(gate.arm_renderer(&delivery_owner).map_err(|_| ())?)
                } else if phase == HistoryAdmissionState::NotStarted {
                    gate.existing_renderer(&delivery_owner).map_err(|_| ())?
                } else {
                    None
                };
                channel
                    .send(HistoryAdmissionPhase {
                        kind: "session_history_admission",
                        open_token: token.clone(),
                        phase,
                        history_delivery,
                    })
                    .map_err(|_| ())
            }),
        })
    }
}
/// Only the original metadata/admission scope, before ANY transport.
/// It carries no body and never changes native/renderer release facts.
pub(super) struct HistoryPreparation(Option<Progress>);
impl HistoryPreparation {
    pub(super) fn new(progress: Progress) -> Self {
        Self(Some(progress))
    }
    pub(super) fn ready(&mut self) {
        drop(self.0.take());
    }
}
impl Drop for HistoryPreparation {
    fn drop(&mut self) {
        if let Some(progress) = self.0.take() {
            // Best effort only. A callback failure must not cross the real
            // owner retirement; failed notification is unknown, not capacity.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = progress(HistoryAdmissionState::NotStarted);
            }));
        }
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

#[tauri::command]
pub fn session_history_delivery_ack(
    app: AppHandle,
    window: Window,
    agent_id: String,
    open_token: String,
    receipt_id: u64,
) -> Result<super::history_admission::HistoryDeliveryAck, String> {
    let manager = app.state::<AcpManager>();
    let gate = &manager.history_admission;
    let owner = gate
        .owner(&window, &open_token, &agent_id)
        .map_err(super::cold_history_open::error)?;
    gate.acknowledge_renderer(&owner, receipt_id)
        .map_err(super::cold_history_open::error)
}

#[cfg(test)]
#[path = "history_admission_wire_tests.rs"]
mod tests;
