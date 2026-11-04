//! Confirmation and storage of one explicitly requested session configuration.
use crate::acp_client::model_guard::{Choice, ConfigStore, ModelGuard};
use crate::acp_client::permission_guard::PermissionGuard;
use serde_json::{Value, json};

/// One complete view of the actual actor state, never reconstructed from choices.
pub(super) fn configuration_snapshot(
    options: Value,
    modern: bool,
    guard: &ModelGuard,
    store: &ConfigStore,
    permission: &PermissionGuard,
) -> Value {
    json!({
        "configOptions": options,
        "configOptionsModern": modern,
        "configCheck": guard.check(),
        "permissionConfigId": permission.id(),
        "permissionState": permission.state(),
        "permissionEffect": permission.effect(),
        "service": match &store.service_record {
            Some(crate::acp_client::service_connection::ServiceRecord::Configured { identity }) => Some(identity),
            _ => None,
        },
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn complete_choice_change(
    session_id: &str,
    guard: &mut ModelGuard,
    store: &mut ConfigStore,
    pending_store: &mut Option<ConfigStore>,
    requested: &Choice,
    prior_guard: &ModelGuard,
    next_store: &ConfigStore,
    options: &Value,
    delivered: bool,
) -> Result<(), String> {
    if !delivered {
        guard.observe(options);
        guard.change_unknown();
        return Err("设置结果尚未确认，请重新检查此对话".into());
    }
    let mut candidate = match prior_guard.confirmed_change(requested, options) {
        Ok(candidate) => candidate,
        Err(error) => {
            guard.observe(options);
            guard.change_unknown();
            return Err(error);
        }
    };
    if let Err(error) = next_store.validate_service().await {
        guard.observe(options);
        guard.change_unknown();
        return Err(error);
    }
    if candidate.is_established()
        && next_store
            .save(session_id, candidate.record())
            .await
            .is_err()
    {
        candidate.record_failed_change();
        *guard = candidate;
        *pending_store = Some(next_store.clone());
        return Err("Agent 已接受新设置，但未能保存，请重新检查后重试".into());
    }
    candidate.confirm_saved();
    *guard = candidate;
    *store = next_store.clone();
    *pending_store = None;
    Ok(())
}

pub(super) async fn save_confirmed_change(
    session_id: &str,
    guard: &mut ModelGuard,
    store: &mut ConfigStore,
    pending_store: &mut Option<ConfigStore>,
) -> Result<(), String> {
    let saving_store = pending_store.as_ref().unwrap_or(&*store);
    saving_store.validate_service().await?;
    if saving_store.save(session_id, guard.record()).await.is_err() {
        if pending_store.is_some() {
            guard.record_failed_change();
        } else {
            guard.record_failed();
        }
        return Err("未能保存确认值，请重试".into());
    }
    if let Some(confirmed) = pending_store.take() {
        *store = confirmed;
    }
    guard.saved_session();
    Ok(())
}

#[cfg(test)]
#[path = "config_change/tests.rs"]
mod tests;
