//! Restore only a missing original configuration on the already loaded conversation.
use std::{path::PathBuf, time::Duration};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::{sync::oneshot, time::Instant};

use super::{
    manager::{AcpManager, validate_cwd_async},
    model_guard::{ModelGuard, Snapshot},
    pump::SessionControl,
};
use crate::meta_store::{MetaStore, SessionRow};

const CHANGED: &str = "对话或设置已变化，请重新打开后核对原设置";
const UNVERIFIED: &str = "无法核对这条对话的原模型或思考深度，仍可查看原对话";
const BUDGET: Duration = Duration::from_secs(30);

pub(crate) enum Request {
    Review { backup: Option<Value> },
    Confirm { review_id: String },
}

pub(super) struct Review {
    row: SessionRow,
    id: String,
    record: Value,
}

#[derive(Serialize)]
struct ChoiceLabel {
    id: String,
    name: String,
    value: String,
    label: String,
}

fn choices(guard: &ModelGuard, options: &Value) -> Result<Vec<ChoiceLabel>, String> {
    let check = guard.check();
    if check.issues.is_empty()
        || check
            .issues
            .iter()
            .any(|issue| issue.reason != "unrecorded")
    {
        return Err(UNVERIFIED.into());
    }
    let snapshot: Snapshot = serde_json::from_value(check.current).map_err(|_| UNVERIFIED)?;
    if snapshot
        .choices
        .iter()
        .filter(|c| c.category == "model")
        .count()
        != 1
        || snapshot
            .choices
            .iter()
            .filter(|c| c.category == "thought_level")
            .count()
            > 1
        || snapshot.choices.len() != check.issues.len()
    {
        return Err(UNVERIFIED.into());
    }
    let entries = options.as_array().ok_or(UNVERIFIED)?;
    let mut choices = Vec::with_capacity(snapshot.choices.len());
    for choice in snapshot.choices {
        let entry = entries
            .iter()
            .find(|entry| entry["id"] == choice.id)
            .ok_or(UNVERIFIED)?;
        let (Some(name), Some(values)) = (entry["name"].as_str(), entry["options"].as_array())
        else {
            return Err(UNVERIFIED.into());
        };
        if entry["type"] != "select"
            || entry["currentValue"] != choice.value
            || name.trim().is_empty()
        {
            return Err(UNVERIFIED.into());
        }
        let mut labels = values
            .iter()
            .flat_map(|value| {
                value["options"]
                    .as_array()
                    .map_or_else(|| std::slice::from_ref(value), Vec::as_slice)
            })
            .filter(|item| item["value"] == choice.value)
            .map(|item| item["name"].as_str());
        let label = labels
            .next()
            .flatten()
            .filter(|value| !value.trim().is_empty())
            .ok_or(UNVERIFIED)?;
        if labels.any(|matched| matched != Some(label)) {
            return Err(UNVERIFIED.into());
        }
        choices.push(ChoiceLabel {
            id: choice.id,
            name: name.into(),
            value: choice.value,
            label: label.into(),
        });
    }
    Ok(choices)
}

impl Review {
    pub(super) async fn new(
        store: &super::model_guard::ConfigStore,
        native: &str,
        guard: &ModelGuard,
        options: &Value,
        backup: Option<Value>,
    ) -> Result<(Self, Value), String> {
        let choices = choices(guard, options)?;
        let mut record = guard.record();
        record["_farfoldService"] = json!({"kind":"existing"});
        if let Some(backup) = backup.as_ref() {
            let saved = ModelGuard::new(options, Some(backup), true);
            if !saved.admissible() || backup["_farfoldService"] != record["_farfoldService"] {
                return Err("备份中的原设置与这条对话当前报告的设置不一致".into());
            }
        }
        let agent = store.agent_id.clone();
        let cwd = store.cwd.clone();
        let native = native.to_owned();
        let id = super::session_index::session_row_id(&agent, &cwd, &native);
        let row = store
            .store
            .run(move |db| {
                db.get_session(&id)?
                    .filter(|row| {
                        row.agent_id == agent
                            && row.cwd == cwd
                            && row.native_session_id.as_deref() == Some(&native)
                            && row.config_options.is_none()
                            && !row.archived
                    })
                    .ok_or_else(|| CHANGED.into())
            })
            .await?;
        let id = super::pump::next_request_id();
        let reply = json!({"reviewId":id,"choices":choices,"source":if backup.is_some(){"backup"}else{"attestation"}});
        Ok((Self { row, id, record }, reply))
    }

    pub(super) async fn save(
        self,
        id: &str,
        store: &super::model_guard::ConfigStore,
        guard: &ModelGuard,
        options: &Value,
    ) -> Result<Value, String> {
        if self.id != id
            || !ModelGuard::new(options, Some(&self.record), true).admissible()
            || self.record["choices"] != guard.record()["choices"]
            || choices(guard, options).is_err()
        {
            return Err(CHANGED.into());
        }
        let previous = self.row;
        let mut requested = previous.clone();
        requested.config_options = Some(self.record.clone());
        store
            .store
            .run(move |db| {
                use crate::meta_store::InitialConfigError;
                db.save_initial_session_config(&requested, Some(&previous))
                    .map_err(|error| match error {
                        InitialConfigError::Changed => CHANGED.into(),
                        InitialConfigError::SaveFailed => {
                            "原设置未能保存，请重新打开此对话检查".into()
                        }
                    })
            })
            .await?;
        Ok(self.record)
    }
}

async fn request(
    app: &AppHandle,
    agent_id: &str,
    cwd: &std::path::Path,
    session_id: &str,
    connection_id: String,
    request: Request,
) -> Result<Value, String> {
    let manager = app.state::<AcpManager>();
    let control = manager
        .session_control_tx(agent_id, cwd, session_id)
        .map_err(|_| CHANGED)?;
    let (result, receive) = oneshot::channel();
    control
        .send(SessionControl::OriginalConfig {
            connection_id,
            request,
            deadline: Instant::now() + BUDGET,
            result,
        })
        .map_err(|_| CHANGED)?;
    tokio::time::timeout(BUDGET, receive)
        .await
        .map_err(|_| "核对原设置超时，请重新打开此对话检查")?
        .map_err(|_| CHANGED)?
}

#[tauri::command]
pub async fn acp_review_original_session_config(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
    backup_path: Option<String>,
) -> Result<Value, String> {
    let cwd = validate_cwd_async(&cwd).await?;
    let backup = if let Some(path) = backup_path {
        let source = PathBuf::from(path);
        let live = MetaStore::default_path(
            &app.path()
                .app_data_dir()
                .map_err(|_| "无法读取应用数据位置")?,
        );
        let (agent, directory, native) = (
            agent_id.clone(),
            cwd.to_string_lossy().into_owned(),
            session_id.clone(),
        );
        Some(
            tokio::task::spawn_blocking(move || {
                super::original_config_backup::existing_config_from_backup(
                    &source, &live, &agent, &directory, &native,
                )
            })
            .await
            .map_err(|_| "无法读取原设置备份")??
            .ok_or("备份内没有这条对话的原设置")?,
        )
    } else {
        None
    };
    request(
        &app,
        &agent_id,
        &cwd,
        &session_id,
        connection_id,
        Request::Review { backup },
    )
    .await
}

#[tauri::command]
pub async fn acp_confirm_original_session_config(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
    review_id: String,
    same_original_account: bool,
) -> Result<Value, String> {
    if !same_original_account {
        return Err("请先核对原账号、服务和显示的原设置".into());
    }
    let cwd = validate_cwd_async(&cwd).await?;
    request(
        &app,
        &agent_id,
        &cwd,
        &session_id,
        connection_id,
        Request::Confirm { review_id },
    )
    .await
}

#[cfg(test)]
mod tests;
