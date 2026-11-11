use super::super::lifecycle::{ConnectionLife, OperationLease};
use super::*;
use super::{inventory::Inventory, slot::Reviewed};
use crate::meta_store::mcp_pending::{Action, Pending};
use agent_client_protocol::{Agent, ConnectionTo, ErrorCode};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) struct Request {
    pub(crate) operation: Operation,
    pub(crate) change: Change,
    pub(super) slot: Arc<Slot>,
    pub(super) availability: Arc<super::super::session_tools::Availability>,
    pub(crate) current_owner: Arc<dyn Fn() -> bool + Send + Sync>,
    pub(super) store: MetaStore,
    pub(crate) row: Option<SessionRow>,
}
impl Request {
    pub(crate) fn validate_target(&self) -> Result<(), ChangeError> {
        if !(self.current_owner)() {
            return Err(Code::Changed.into());
        }
        Ok(())
    }
    pub(crate) fn validate_new_target(&self) -> Result<(), ChangeError> {
        if self.row.is_none()
            && let Change::Remove { item_ref } = &self.change
            && !self.slot.target(item_ref)?.item.can_remove
        {
            return Err(Code::Changed.into());
        }
        Ok(())
    }
}
struct Execution {
    request: Request,
    cx: ConnectionTo<Agent>,
    life: Arc<ConnectionLife>,
    unresolved: Vec<Arc<AtomicBool>>,
    pending: Option<Pending>,
    mutation_sent: bool,
}
impl Execution {
    async fn wire(&mut self, method: &'static str, params: Value) -> Result<Value, ChangeError> {
        if !(self.request.current_owner)() {
            return Err(Code::Changed.into());
        }
        let (future, observed) = self
            .request
            .availability
            .send_raw(&self.cx, method, params)
            .map_err(|_| Code::QueryFailed)?;
        if matches!(method, ADD | REMOVE) {
            self.mutation_sent = true;
            self.request
                .slot
                .update(&self.request.operation.operation_id, |o| {
                    o.mutation_sent = true
                });
        }
        let response = super::super::operations::until_owner_ended(&self.life, future).await;
        if !observed.load(Ordering::SeqCst) {
            self.unresolved.push(observed);
            return Err(Code::Unknown.into());
        }
        self.request.availability.clear(&observed);
        if !(self.request.current_owner)() {
            return Err(Code::Changed.into());
        }
        match response {
            Some(Ok(value)) => Ok(value),
            Some(Err(error)) if error.code == ErrorCode::MethodNotFound => {
                self.request.availability.management_unsupported();
                Err(Code::Unavailable.into())
            }
            _ => Err(Code::QueryFailed.into()),
        }
    }
    async fn inventory(&mut self) -> Result<Inventory, ChangeError> {
        Inventory::parse(
            self.wire(
                LIST,
                json!({"sessionId":self.request.operation.native_session_id}),
            )
            .await?,
        )
    }
    async fn tools(
        &mut self,
        name: Option<&str>,
    ) -> Result<std::collections::HashSet<String>, ChangeError> {
        inventory::tools(&self.wire(TOOLS,json!({"sessionId":self.request.operation.native_session_id,"extensionName":name})).await?)
    }
    async fn perform(&mut self) -> Result<Vec<Reviewed>, ChangeError> {
        let before = self.inventory().await?;
        if matches!(self.request.change, Change::Inspect) {
            return before.reviewed();
        }
        let (action, descriptor, owned, expected, baseline_tools) =
            match &self.request.change.clone() {
                Change::Inspect => unreachable!("handled before mutation planning"),
                Change::AddHttp { name, url } => {
                    let descriptor = inventory::http_descriptor(name, url)?;
                    if before.conflict(name) {
                        return Err(Code::Changed.into());
                    }
                    let tools = self.tools(None).await?;
                    (Action::Add, descriptor, None, None, tools)
                }
                Change::Remove { item_ref } => {
                    let owned = self.request.slot.target(item_ref)?;
                    if !owned.item.can_remove || before.digest() != owned.inventory_digest {
                        return Err(Code::Changed.into());
                    }
                    let name = before.scope_name(&owned.key, &owned.descriptor)?;
                    let tools = self.tools(Some(&name)).await?;
                    let expected = before.without(&owned.key, &owned.descriptor)?.digest();
                    (
                        Action::Remove,
                        owned.descriptor.clone(),
                        Some(owned),
                        Some(expected),
                        tools,
                    )
                }
            };
        let pending = Pending {
            operation_id: self.request.operation.operation_id.clone(),
            action,
            before_digest: before.digest(),
            expected_digest: expected,
            target_digest: inventory::descriptor_digest(&descriptor),
        };
        let row = self.request.row.clone().ok_or(Code::Changed)?;
        let (begin_row, save) = (row.clone(), pending.clone());
        let guard = crate::install_job::configuration_guard(&row.agent_id).await;
        if !(self.request.current_owner)() {
            return Err(Code::Changed.into());
        }
        self.request
            .store
            .run(move |store| store.begin_mcp_pending(&begin_row, &save))
            .await
            .map_err(|_| Code::SaveFailed)?;
        drop(guard);
        self.pending = Some(pending.clone());
        if !(self.request.current_owner)() {
            return Err(Code::Changed.into());
        }
        let (method, params) = match &owned {
            None => (
                ADD,
                json!({"sessionId":self.request.operation.native_session_id,"extension":descriptor}),
            ),
            Some(owned) => (
                REMOVE,
                json!({"sessionId":self.request.operation.native_session_id,"extensionKey":owned.key}),
            ),
        };
        let ack = self.wire(method, params).await?;
        if !ack.as_object().is_some_and(|v| v.is_empty()) {
            return Err(Code::InvalidResponse.into());
        }
        let after = self.inventory().await?;
        if !after.matches_pending(&pending)? {
            return Err(Code::Changed.into());
        }
        let activity = match owned {
            None => {
                after.added(&before, &descriptor)?;
                let name = descriptor
                    .pointer("/server/name")
                    .and_then(Value::as_str)
                    .ok_or(Code::InvalidResponse)?;
                let tools = self.tools(Some(name)).await?;
                if tools.is_empty() || !tools.is_disjoint(&baseline_tools) {
                    return Err(Code::InvalidResponse.into());
                }
                Activity::ToolsReported
            }
            Some(_) => {
                // This endpoint can mask an extension error as an empty set.
                // Absence is only supporting evidence beside exact remove ACK
                // and both complete persisted inventories; never success alone.
                let tools = self.tools(None).await?;
                if !tools.is_disjoint(&baseline_tools) {
                    return Err(Code::InvalidResponse.into());
                }
                if baseline_tools.is_empty() {
                    Activity::Unreported
                } else {
                    Activity::AbsentReported
                }
            }
        };
        if self.inventory().await? != after {
            return Err(Code::Changed.into());
        }
        let reviewed = after.reviewed()?;
        let clear = pending;
        self.request
            .store
            .run(move |store| store.clear_mcp_pending(&row, &clear))
            .await
            .map_err(|_| Code::SaveFailed)?;
        self.pending = None;
        self.request
            .slot
            .update(&self.request.operation.operation_id, |o| {
                o.persistence = Persistence::Confirmed;
                o.activity = activity;
            });
        Ok(reviewed)
    }
    async fn run(mut self, lease: OperationLease) {
        let outcome = self.perform().await;
        let id = self.request.operation.operation_id.clone();
        if let Ok(reviewed) = outcome {
            self.request.slot.confirmed(&id, reviewed);
            drop(lease);
            self.request.slot.update(&id, |o| {
                o.state = State::Ready;
                o.settled = true;
                o.error = None;
            });
            return;
        }
        let error = outcome.err().expect("failed outcome");
        if !self.mutation_sent
            && let (Some(pending), Some(row)) = (self.pending.clone(), self.request.row.clone())
            && self
                .request
                .store
                .run(move |store| store.clear_mcp_pending(&row, &pending))
                .await
                .is_ok()
        {
            self.pending = None;
        }
        let unknown = self.mutation_sent || self.pending.is_some();
        let settled = self.unresolved.is_empty() || self.life.finished();
        self.request.slot.update(&id, |o| {
            o.state = if unknown {
                State::Unknown
            } else {
                State::Failed
            };
            o.settled = settled;
            if unknown {
                o.persistence = Persistence::Unknown;
            }
            o.error = Some(error);
        });
        if !settled {
            self.life.terminated().await;
        }
        for observed in &self.unresolved {
            self.request.availability.clear(observed);
        }
        drop(lease);
        self.request.slot.update(&id, |o| o.settled = true);
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn start(
    request: Request,
    cx: ConnectionTo<Agent>,
    connection_id: &str,
    session_id: &str,
    life: &Arc<ConnectionLife>,
    busy: bool,
    deadline: tokio::time::Instant,
    result: oneshot::Sender<Result<(), ChangeError>>,
) {
    let conversation_saved = request.operation.conversation_saved;
    let outcome = (|| {
        if request.operation.connection_id != connection_id
            || request.operation.native_session_id != session_id
            || !(request.current_owner)()
        {
            return Err(Code::Changed.into());
        }
        if request
            .slot
            .existing(&request.operation.operation_id, &request.change)?
            .is_some()
        {
            return Ok(());
        }
        if busy {
            return Err(Code::Busy.into());
        }
        if !request.availability.management_supported() {
            return Err(Code::Unavailable.into());
        }
        if tokio::time::Instant::now() >= deadline || result.is_closed() {
            return Err(Code::Timeout.into());
        }
        let lease = life
            .operation(format!("open:{session_id}"))
            .map_err(|_| Code::Busy)?;
        request
            .slot
            .admit(request.change.clone(), request.operation.clone())?;
        let execution = Execution {
            request,
            cx,
            life: life.clone(),
            unresolved: Vec::new(),
            pending: None,
            mutation_sent: false,
        };
        super::super::manager::runtime().spawn(execution.run(lease));
        Ok(())
    })();
    let _ = result
        .send(outcome.map_err(|e: ChangeError| e.with_saved_conversation(conversation_saved)));
}
