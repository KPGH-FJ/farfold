//! Capability-negotiated AIR task control on the existing ACP connection.
//! This is bounded live metadata, never a command executor or history ledger.
use super::lifecycle::{ConnectionLife, WorkLease};
use agent_client_protocol::{Agent, ConnectionTo, UntypedMessage};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};

const LIMIT: usize = 512;
pub(super) const STOP_METHOD: &str = "_session/async_task/stop";

pub(super) fn supported(handshake: &Value) -> bool {
    let Some(air) = handshake.pointer("/_meta/jetbrains/air") else {
        return false;
    };
    air.get("version").and_then(Value::as_u64) == Some(1)
        && air
            .get("capabilities")
            .and_then(Value::as_array)
            .is_some_and(|list| {
                list.len() <= 64
                    && list.iter().all(Value::is_string)
                    && list.iter().any(|v| v == "asyncTasks")
            })
}

fn text(value: Option<&Value>, limit: usize) -> Option<&str> {
    value?
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= limit && !s.contains('\0'))
}

struct Task {
    name: String,
    task_type: String,
    tool: Option<String>,
    can_stop: bool,
    state: &'static str,
    stop: &'static str,
    deadline: Option<tokio::time::Instant>,
    reply: Option<oneshot::Sender<Result<Value, String>>>,
}

struct EarlyState {
    state: &'static str,
    tool: Option<String>,
}

fn reported_state(update: &Value) -> &'static str {
    match update.get("state").and_then(Value::as_str) {
        Some("completed") => "completed",
        Some("failed") => "failed",
        Some("stopped") => "stopped",
        _ => "unknown",
    }
}

pub(super) struct Completion {
    task_id: String,
    result: Result<Value, agent_client_protocol::Error>,
}

pub(super) struct Tasks {
    enabled: bool,
    connection: String,
    session: String,
    tasks: BTreeMap<String, Task>,
    early: BTreeMap<String, EarlyState>,
    overflow: bool,
    life: Arc<ConnectionLife>,
    lease: Option<WorkLease>,
}

impl Tasks {
    pub(super) fn new(
        enabled: bool,
        connection: String,
        session: String,
        life: Arc<ConnectionLife>,
    ) -> Self {
        Self {
            enabled,
            connection,
            session,
            tasks: BTreeMap::new(),
            early: BTreeMap::new(),
            overflow: false,
            life,
            lease: None,
        }
    }

    pub(super) fn busy(&self) -> bool {
        self.overflow
            || self.early.values().any(|value| value.state == "unknown")
            || self
                .tasks
                .values()
                .any(|t| matches!(t.state, "running" | "unknown"))
    }

    fn hold(&mut self) {
        if self.busy() {
            if self.lease.is_none() {
                self.lease = self.life.work().ok();
            }
        } else {
            self.lease.take();
        }
    }

    pub(super) fn event(&self) -> Value {
        json!({"kind":"asyncTasks", "connectionId":self.connection, "sessionId":self.session,
            "supported":self.enabled, "overflow":self.overflow || self.early.values().any(|value| value.state == "unknown"),
            "tasks":self.tasks.iter().map(|(id,t)| json!({"asyncTaskId":id,"name":t.name,
                "taskType":t.task_type,"toolCallId":t.tool,"canStop":t.can_stop,
                "state":t.state,"stopRequest":t.stop})).collect::<Vec<_>>()})
    }

    pub(super) fn observe(&mut self, params: &Value) -> Option<Value> {
        if !self.enabled || params.get("sessionId").and_then(Value::as_str) != Some(&self.session) {
            return None;
        }
        let update = params.get("update")?;
        let kind = update.get("sessionUpdate")?.as_str()?;
        if !matches!(kind, "async_task_spawned" | "async_task_state_update") {
            return None;
        }
        let id = text(update.get("asyncTaskId"), 4096)?;
        if kind == "async_task_spawned" {
            let name = text(update.get("name"), 4096)?;
            let task_type = text(update.get("taskType"), 128)?;
            let can_stop = update.get("canStop")?.as_bool()?;
            let tool = match update.get("toolCallId") {
                None | Some(Value::Null) => None,
                value => Some(text(value, 4096)?.to_owned()),
            };
            if let Some(old) = self.tasks.get_mut(id) {
                // A repeated ID cannot replace its original execution owner.
                if old.name == name
                    && old.task_type == task_type
                    && old.tool == tool
                    && old.can_stop == can_stop
                {
                    return None;
                }
                self.overflow = true;
                old.can_stop = false;
                if old.state == "running" {
                    old.state = "unknown";
                }
            } else if self.tasks.len() + self.early.len() >= LIMIT && !self.early.contains_key(id) {
                // Do not silently turn untracked reported work into idle.
                self.overflow = true;
            } else {
                // A terminal may precede its announcement. Retain its original
                // owner and never resurrect it as a controllable execution.
                let early = self.early.remove(id);
                let state = early.as_ref().map_or("running", |prior| prior.state);
                if early.as_ref().is_some_and(|prior| prior.tool != tool) {
                    self.overflow = true;
                }
                self.tasks.insert(
                    id.to_owned(),
                    Task {
                        name: name.to_owned(),
                        task_type: task_type.to_owned(),
                        tool,
                        can_stop: can_stop && early.is_none(),
                        state,
                        stop: "idle",
                        deadline: None,
                        reply: None,
                    },
                );
            }
        } else {
            if !self.tasks.contains_key(id) {
                let tool = match update.get("toolCallId") {
                    None | Some(Value::Null) => None,
                    value => Some(text(value, 4096)?.to_owned()),
                };
                if let Some(prior) = self.early.get_mut(id) {
                    if prior.tool != tool {
                        // A terminal from another owner cannot settle this ID.
                        self.overflow = true;
                    } else if prior.state == "unknown" {
                        prior.state = reported_state(update);
                    }
                } else {
                    if self.tasks.len() + self.early.len() >= LIMIT {
                        self.overflow = true;
                    } else {
                        self.early.insert(
                            id.to_owned(),
                            EarlyState {
                                state: reported_state(update),
                                tool,
                            },
                        );
                    }
                }
                self.hold();
                return Some(self.event());
            }
            let task = self.tasks.get_mut(id).unwrap();
            if update
                .get("toolCallId")
                .is_some_and(|value| value.as_str() != task.tool.as_deref())
            {
                return None;
            }
            if !matches!(task.state, "running" | "unknown") {
                return None;
            }
            task.state = reported_state(update);
            if task.state == "unknown" {
                task.can_stop = false;
            }
        }
        self.hold();
        Some(self.event())
    }

    fn receipt(&self, id: &str, status: &str) -> Value {
        json!({"connectionId":self.connection,"sessionId":self.session,"asyncTaskId":id,"status":status})
    }

    pub(super) fn start(
        &mut self,
        cx: &ConnectionTo<Agent>,
        connection: &str,
        id: &str,
        reply: oneshot::Sender<Result<Value, String>>,
        completed: mpsc::UnboundedSender<Completion>,
    ) -> Value {
        if !self.enabled
            || connection != self.connection
            || !self.tasks.get(id).is_some_and(|t| {
                t.can_stop && t.state == "running" && matches!(t.stop, "idle" | "rejected")
            })
        {
            let _ = reply.send(Ok(self.receipt(id, "rejected")));
            return self.event();
        }
        let request = UntypedMessage::new(
            STOP_METHOD,
            json!({"sessionId":self.session,"asyncTaskId":id}),
        );
        let task_id = id.to_owned();
        let sent = request.and_then(|request| {
            cx.send_request_to(Agent, request)
                .on_receiving_result(async move |result| {
                    let _ = completed.send(Completion { task_id, result });
                    Ok(())
                })
        });
        if sent.is_err() {
            let _ = reply.send(Ok(self.receipt(id, "unknown")));
            self.tasks.get_mut(id).unwrap().stop = "unknown";
        } else {
            let task = self.tasks.get_mut(id).unwrap();
            task.stop = "requested";
            task.deadline = Some(tokio::time::Instant::now() + Duration::from_secs(10));
            task.reply = Some(reply);
        }
        self.event()
    }

    pub(super) fn complete(&mut self, completion: Completion) -> Option<Value> {
        let status = match completion
            .result
            .ok()
            .as_ref()
            .and_then(|v| v.get("stopped"))
            .and_then(Value::as_bool)
        {
            Some(true) => "accepted",
            Some(false) => "rejected",
            None => "unknown",
        };
        let receipt = self.receipt(&completion.task_id, status);
        let task = self.tasks.get_mut(&completion.task_id)?;
        task.stop = status;
        task.deadline = None;
        if let Some(reply) = task.reply.take() {
            let _ = reply.send(Ok(receipt));
        }
        // A method response never rewrites the task, tool or prompt terminal state.
        Some(self.event())
    }

    pub(super) fn deadline(&self) -> Option<tokio::time::Instant> {
        self.tasks.values().filter_map(|task| task.deadline).min()
    }

    pub(super) fn expire(&mut self) -> Value {
        let connection = &self.connection;
        let session = &self.session;
        for (id, task) in &mut self.tasks {
            if task
                .deadline
                .is_some_and(|deadline| deadline <= tokio::time::Instant::now())
            {
                task.deadline = None;
                task.stop = "unknown";
                if let Some(reply) = task.reply.take() {
                    let _ = reply.send(Ok(json!({"connectionId":connection,"sessionId":session,"asyncTaskId":id,"status":"unknown"})));
                }
            }
        }
        self.event()
    }
}

impl Drop for Tasks {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            lease.retain_until_terminated();
        }
    }
}

#[cfg(test)]
#[path = "async_tasks_tests.rs"]
mod tests;
