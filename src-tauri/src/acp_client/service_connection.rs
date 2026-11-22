//! Service selection is launch metadata on the existing connection owner.
//! Secrets live in launch delivery, never in keys, status or history.
use std::{collections::HashMap, path::Path, sync::atomic::Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::Manager as _;

use super::manager::{
    AcpManager, AgentConnectionStatus, ConnectionKey, ManagedConnection, STATE_READY,
};
use crate::{
    credentials::{ServiceIdentity, ServiceSelection},
    meta_store::{AgentRow, MetaStore},
};

#[derive(Clone)]
pub(crate) struct ServiceContext {
    pub identity: ServiceIdentity,
    pub revision: String,
    pub model_id: String,
}

pub(crate) struct PreparedService {
    pub environment: HashMap<String, String>,
    pub context: ServiceContext,
    pub delivery: Option<super::service_delivery::ServiceDelivery>,
    pub relay: Option<super::service_config::goose_relay::Relay>,
}

/// Missing on old history means unknown, not proof of today's default service.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ServiceRecord {
    Existing,
    Configured { identity: ServiceIdentity },
}

pub(crate) fn recorded_service(config: Option<&Value>) -> Result<Option<ServiceRecord>, String> {
    config
        .and_then(|v| v.get("_farfoldService"))
        .map(|value| {
            serde_json::from_value(value.clone())
                .map_err(|_| "无法读取此对话的 API 来源，原记录已保留".into())
        })
        .transpose()
}

/// Restoration follows the saved source; a caller cannot replace it by selection.
pub(crate) fn selection_for_open(
    restored: bool,
    recorded: Option<&ServiceRecord>,
    requested: Option<ServiceSelection>,
) -> Result<(Option<ServiceSelection>, Option<ServiceIdentity>), String> {
    if !restored {
        return Ok((requested, None));
    }
    match recorded {
        Some(ServiceRecord::Configured { identity }) => {
            if requested
                .as_ref()
                .is_some_and(|s| s.id != identity.id || s.model != identity.model)
            {
                return Err("恢复对话不能更换 API 来源或模型".into());
            }
            Ok((
                Some(ServiceSelection {
                    revision: None,
                    id: identity.id.clone(),
                    model: identity.model.clone(),
                }),
                Some(identity.clone()),
            ))
        }
        _ if requested.is_some() => Err("此历史没有所选 API 的记录，请保持原设置或新建对话".into()),
        _ => Ok((None, None)),
    }
}

impl AcpManager {
    pub(crate) async fn connect_selected(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        store: &MetaStore,
        selection: Option<ServiceSelection>,
        expected: Option<ServiceIdentity>,
        conversation: bool,
    ) -> Result<(AgentConnectionStatus, ManagedConnection), String> {
        self.connect_selected_owned(
            agent,
            cwd,
            store,
            selection,
            expected,
            conversation,
            None,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn connect_selected_owned(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        store: &MetaStore,
        selection: Option<ServiceSelection>,
        expected: Option<ServiceIdentity>,
        conversation: bool,
        history: Option<super::history_admission::Permit>,
        draft_wait: Option<&super::draft_wait::DraftWait>,
    ) -> Result<(AgentConnectionStatus, ManagedConnection), String> {
        let _configuration = if let Some(wait) = draft_wait {
            wait.admit(&agent.id, |owner| {
                self.history_admission.current_owner(owner)
            })
            .await?
        } else {
            crate::install_job::configuration_guard(&agent.id).await
        };
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err("应用正在退出，请稍后重试".into());
        }
        if self.candidate_pending(&agent.id)? {
            return Err("版本检查进程尚未确认结束，请稍后重试".into());
        }
        let id = agent.id.clone();
        let current = store
            .run(move |store| {
                store
                    .get_agent(&id)?
                    .ok_or_else(|| "请先重新添加此 Agent".into())
            })
            .await?;
        if history.is_some() && !super::cold_history_open::same_launch(agent, &current) {
            return Err("读取设置已变化，本次尚未开始，请重新打开".into());
        }
        if conversation {
            super::preparation::require_dependencies(&current)?;
        }
        let prepared = if let Some(selection) = selection {
            let row = current.clone();
            let data_dir = self.data_directory().to_owned();
            let (mut prepared, goose_upstream) = store
                .run(move |store| {
                    if super::service_config::copilot::registered(&row)
                        && !super::service_config::copilot::verified(&row, store, &data_dir)
                    {
                        return Err(super::service_config::copilot::UNAVAILABLE.into());
                    }
                    let goose = super::service_config::goose::registered(&row);
                    if goose && !super::service_config::goose::verified(&row, store, &data_dir) {
                        return Err(super::service_config::goose::UNAVAILABLE.into());
                    }
                    let snapshot =
                        crate::credentials::service_snapshot(store, &selection, expected.as_ref())?;
                    // Explicit service selection does not inherit the legacy global
                    // grants. User-configured Agent environment remains intact.
                    let mut environment = crate::shell_env::command_env();
                    crate::shell_env::EnvNames::current().extend(
                        &mut environment,
                        crate::auth::resolve_agent_env(&row.id, &row.env)?,
                    );
                    let key =
                        serde_json::to_vec(&(&snapshot.identity, &snapshot.connection_revision))
                            .map_err(|_| "无法准备 API 配置")?;
                    let revision = Sha256::digest(key)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>();
                    let (model_id, delivery, goose_upstream) = if goose {
                        if snapshot.api_type != "chat-completions" {
                            return Err("Goose 需要 Chat Completions 格式的 API 配置".into());
                        }
                        (
                            snapshot.identity.model.clone(),
                            None,
                            Some((snapshot.endpoint, snapshot.secret)),
                        )
                    } else {
                        let config = super::service_config::compile(&row, &snapshot, &environment)?;
                        crate::shell_env::EnvNames::current()
                            .extend(&mut environment, config.env_overrides);
                        (config.model_id, config.delivery, None)
                    };
                    Ok((
                        PreparedService {
                            environment,
                            delivery,
                            relay: None,
                            context: ServiceContext {
                                identity: snapshot.identity,
                                revision,
                                model_id,
                            },
                        },
                        goose_upstream,
                    ))
                })
                .await?;
            if let Some((endpoint, key)) = goose_upstream {
                let model = &prepared.context.model_id;
                let relay =
                    super::service_config::goose_relay::start(endpoint, model.clone(), key).await?;
                super::service_config::goose::prepare_environment(
                    &mut prepared.environment,
                    &relay,
                    model,
                );
                prepared.relay = Some(relay);
            }
            Some(prepared)
        } else {
            None
        };
        let key = ConnectionKey {
            agent_id: current.id.clone(),
            cwd: cwd.to_path_buf(),
            candidate: false,
            conversation_id: conversation.then(super::manager::next_connection_id),
            service: prepared.as_ref().map(|p| p.context.revision.clone()),
        };
        let status = self
            .connect_launch_owned(
                &current,
                cwd,
                store,
                false,
                prepared,
                key.conversation_id.clone(),
                None,
                history,
            )
            .await?;
        let connection = self
            .lock()?
            .get(&key)
            .cloned()
            .ok_or("连接已结束，请重试")?;
        Ok((status, connection))
    }

    /// A native session has one live owner across all service connections.
    /// This routes stop/approval/config/close without broadcasting to a source.
    pub(crate) fn session_connection(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<ManagedConnection, String> {
        self.session_owner(agent_id, cwd, session_id)?
            .filter(|connection| connection.state.load(Ordering::SeqCst) == STATE_READY)
            .ok_or_else(|| "会话已断开，请重新连接".into())
    }

    /// Closing owners remain visible until their exact process has exited.
    pub(crate) fn session_owner(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<Option<ManagedConnection>, String> {
        let candidates: Vec<_> = self
            .lock()?
            .iter()
            .filter(|(key, _)| key.agent_id == agent_id && key.cwd == cwd && !key.candidate)
            .map(|(_, connection)| connection.clone())
            .collect();
        let mut selected = None;
        for connection in candidates {
            if connection
                .sessions
                .lock()
                .map_err(|_| "无法读取对话状态")?
                .contains_key(session_id)
            {
                if selected.is_some() {
                    return Err("对话连接来源不明确，请先断开后重试".into());
                }
                selected = Some(connection);
            }
        }
        Ok(selected)
    }
}

#[tauri::command]
pub async fn service_capabilities(
    app: tauri::AppHandle,
    agent_id: String,
) -> Result<super::service_config::ServiceCapability, String> {
    let agent = super::manager::require_agent_row(&app, &agent_id).await?;
    if super::service_config::copilot::registered(&agent) {
        let data = app.path().app_data_dir().map_err(|_| "无法读取安装目录")?;
        return app
            .state::<MetaStore>()
            .run(move |store| {
                Ok(
                    if super::service_config::copilot::verified(&agent, store, &data) {
                        super::service_config::capability(&agent)
                    } else {
                        super::service_config::copilot::unavailable()
                    },
                )
            })
            .await;
    }
    if super::service_config::goose::registered(&agent) {
        let data = app.path().app_data_dir().map_err(|_| "无法读取安装目录")?;
        return app
            .state::<MetaStore>()
            .run(move |store| {
                Ok(
                    if super::service_config::goose::verified(&agent, store, &data) {
                        super::service_config::capability(&agent)
                    } else {
                        super::service_config::goose::unavailable()
                    },
                )
            })
            .await;
    }
    Ok(super::service_config::capability(&agent))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn identity() -> ServiceIdentity {
        ServiceIdentity {
            id: "service-a".into(),
            fingerprint: "endpoint-and-format".into(),
            model: "model-a".into(),
        }
    }
    #[test]
    fn restored_source_is_never_replaced_or_guessed() {
        let record = ServiceRecord::Configured {
            identity: identity(),
        };
        let (selection, expected) = selection_for_open(true, Some(&record), None).unwrap();
        assert_eq!(selection.unwrap().id, "service-a");
        assert_eq!(expected, Some(identity()));
        for (id, model) in [("service-b", "model-a"), ("service-a", "model-b")] {
            assert!(
                selection_for_open(
                    true,
                    Some(&record),
                    Some(ServiceSelection {
                        revision: None,
                        id: id.into(),
                        model: model.into()
                    })
                )
                .is_err()
            );
        }
        for record in [None, Some(ServiceRecord::Existing)] {
            assert!(
                selection_for_open(
                    true,
                    record.as_ref(),
                    Some(ServiceSelection {
                        revision: None,
                        id: "service-a".into(),
                        model: "model-a".into()
                    })
                )
                .is_err()
            );
            assert!(
                selection_for_open(true, record.as_ref(), None)
                    .unwrap()
                    .0
                    .is_none()
            );
        }
    }
    #[test]
    fn missing_history_is_unknown_but_invalid_source_is_an_error() {
        assert!(
            recorded_service(Some(&json!({"model":"original"})))
                .unwrap()
                .is_none()
        );
        assert!(recorded_service(Some(&json!({"_farfoldService":{"kind":"configured"}}))).is_err());
        let record = ServiceRecord::Configured {
            identity: identity(),
        };
        let restored = recorded_service(Some(&json!({"_farfoldService": record})))
            .unwrap()
            .unwrap();
        assert!(restored == record);
    }
}
