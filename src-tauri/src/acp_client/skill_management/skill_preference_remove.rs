//! Reviewed removal of a selected skill's explicit enablement preference only.
use super::{domain::Domain, requests, types::*};
use crate::acp_client::extension_inventory as inventory;
use tauri::{AppHandle, Webview};

#[tauri::command]
pub async fn agent_skill_preference_remove_inspect(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    inventory_request_id: String,
    item_id: usize,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_skill_preference_remove_inspect")?;
    let pair = requests::shared().begin_skill_preference_remove_inspect(
        &agent_id,
        &request_id,
        &inventory_request_id,
        item_id,
    )?;
    super::dispatch(&app, store, pair).await
}

#[tauri::command]
pub async fn agent_skill_preference_remove_confirm(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    review_id: String,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_skill_preference_remove_confirm")?;
    let pair = requests::shared().begin_confirm_domain(
        &agent_id,
        &request_id,
        &review_id,
        Domain::SkillPreferenceRemoval,
    )?;
    super::dispatch(&app, store, pair).await
}

#[tauri::command]
pub async fn agent_skill_preference_remove_recheck(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    operation_id: String,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_skill_preference_remove_recheck")?;
    let pair = requests::shared().begin_recheck_domain(
        &agent_id,
        &request_id,
        &operation_id,
        Domain::SkillPreferenceRemoval,
    )?;
    super::dispatch(&app, store, pair).await
}

#[tauri::command]
pub fn agent_skill_preference_remove_status(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<ChangeOperation> {
    inventory::allowed(&webview)?;
    Ok(requests::shared()
        .get_domain(&agent_id, &request_id, Domain::SkillPreferenceRemoval)?
        .snapshot())
}

#[tauri::command]
pub fn agent_skill_preference_remove_cancel(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<Cancellation> {
    inventory::allowed(&webview)?;
    requests::shared().cancel_domain(&agent_id, &request_id, Domain::SkillPreferenceRemoval)
}
