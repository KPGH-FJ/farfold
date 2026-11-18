//! A read of saved working-folder rules on the current conversation.
use super::{AccessError, ErrorKind, Read, Request};
use crate::acp_client::manager::{AcpManager, ManagedConnection, validate_cwd_async};
use agent_client_protocol::{Agent, ConnectionTo, ErrorCode, UntypedMessage};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io, path::Path};

const LIST: &str = "dev.dirac/permissions.list";

pub(crate) fn supported(connection: &ManagedConnection) -> bool {
    connection.handshake.get().is_some_and(|handshake| {
        handshake
            .typed
            .agent_capabilities
            .meta
            .as_ref()
            .is_some_and(|meta| meta.get(LIST) == Some(&Value::Bool(true)))
    })
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    Allow,
    Deny,
}

#[derive(Deserialize, Serialize)]
struct Rule {
    tool: String,
    pattern: Option<String>,
    action: Action,
}

#[derive(Deserialize)]
struct Rules {
    rules: Vec<Rule>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPermissionRules {
    connection_id: String,
    native_session_id: String,
    cwd: String,
    rules: Vec<Rule>,
}

pub(crate) type Reply = Result<FolderPermissionRules, AccessError>;

fn parse(value: Value) -> Result<Vec<Rule>, AccessError> {
    if serde_json::to_vec(&value)
        .map_err(|_| ErrorKind::InvalidResponse)?
        .len()
        > 64 * 1024
    {
        return Err(ErrorKind::InvalidResponse.into());
    }
    let Rules { rules } = serde_json::from_value(value).map_err(|_| ErrorKind::InvalidResponse)?;
    if rules.len() > 256
        || rules.iter().any(|rule| {
            rule.tool.trim().is_empty()
                || rule.tool.len() > 512
                || rule.tool.chars().any(char::is_control)
                || rule.pattern.as_ref().is_some_and(|text| {
                    text.len() > 8192
                        || text
                            .chars()
                            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
                })
        })
    {
        return Err(ErrorKind::InvalidResponse.into());
    }
    Ok(rules)
}

async fn check_scope(cwd: &Path) -> Result<(), AccessError> {
    let folder = cwd.join(".dirac");
    for (path, directory) in [(&folder, true), (&folder.join("permissions.json"), false)] {
        match tokio::fs::symlink_metadata(path).await {
            Ok(info) if (directory && info.is_dir()) || (!directory && info.is_file()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            _ => return Err(ErrorKind::Changed.into()),
        }
    }
    Ok(())
}

pub(super) async fn read(
    request: Request,
    cx: ConnectionTo<Agent>,
    deadline: tokio::time::Instant,
) -> Reply {
    check_scope(&request.cwd).await?;
    if tokio::time::Instant::now() >= deadline {
        return Err(ErrorKind::Timeout.into());
    }
    if !(request.current_owner)() {
        return Err(ErrorKind::Changed.into());
    }
    let message = UntypedMessage::new(LIST, json!({"sessionId": request.session_id}))
        .map_err(|_| ErrorKind::QueryFailed)?;
    let value = cx
        .send_request_to(Agent, message)
        .block_task()
        .await
        .map_err(|error| {
            if error.code == ErrorCode::MethodNotFound {
                ErrorKind::Unavailable
            } else {
                ErrorKind::QueryFailed
            }
        })?;
    check_scope(&request.cwd).await?;
    if !(request.current_owner)() {
        return Err(ErrorKind::Changed.into());
    }
    Ok(FolderPermissionRules {
        connection_id: request.connection_id,
        native_session_id: request.session_id,
        cwd: request.cwd.to_string_lossy().into_owned(),
        rules: parse(value)?,
    })
}

#[tauri::command]
pub async fn session_permission_rules(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
) -> Reply {
    use tauri::Manager;
    let cwd = validate_cwd_async(&cwd)
        .await
        .map_err(|_| ErrorKind::Changed)?;
    app.state::<AcpManager>()
        .permission_rules(&agent_id, &cwd, &session_id, &connection_id)
        .await
}

impl AcpManager {
    pub(crate) async fn permission_rules(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
    ) -> Reply {
        self.workspace_read_owner(agent_id, cwd, session_id, connection_id, true)?
            .read(Read::PermissionRules)
            .await
    }
}
