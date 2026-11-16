use super::*;
use std::sync::atomic::Ordering;

#[derive(Clone)]
pub(crate) struct Request {
    pub(super) operation: Operation,
    pub(super) slot: Arc<Slot>,
    pub(super) availability: Arc<Availability>,
    pub(super) current_owner: Arc<dyn Fn() -> bool + Send + Sync>,
}
impl Request {
    fn matches(&self, connection: &str, session: &str) -> bool {
        self.operation.connection_id == connection
            && self.operation.native_session_id == session
            && (self.current_owner)()
    }
    async fn run(
        self,
        cx: ConnectionTo<Agent>,
        life: Arc<ConnectionLife>,
        lease: OperationLease,
        deadline: tokio::time::Instant,
    ) {
        let id = &self.operation.operation_id;
        let query = self.operation.query();
        let before = if tokio::time::Instant::now() >= deadline {
            Some(Code::Timeout)
        } else if !(self.current_owner)() {
            Some(Code::Changed)
        } else if !self.availability.supports(query) {
            Some(Code::Unavailable)
        } else {
            None
        };
        if let Some(code) = before {
            drop(lease);
            self.slot.finish(id, Err(code.into()), true);
            return;
        }
        let (future, observed) =
            match self
                .availability
                .send(&cx, &self.operation.native_session_id, query)
            {
                Ok(sent) => sent,
                Err(error) => {
                    drop(lease);
                    self.slot.finish(id, Err(error), true);
                    return;
                }
            };
        let result = super::super::operations::until_owner_ended(&life, future).await;
        let witnessed = observed.load(Ordering::SeqCst);
        let outcome = match result {
            Some(Ok(value)) if witnessed && (self.current_owner)() => match query {
                Query::Tools(_) => types::parse(&value).map(ReadReport::Tools),
                Query::Configuration => configuration::parse(&value).map(ReadReport::Configuration),
            },
            Some(Ok(_)) if witnessed => Err(Code::Changed.into()),
            Some(Err(error)) if witnessed && error.code == ErrorCode::MethodNotFound => {
                self.availability.unsupported(query);
                Err(Code::Unavailable.into())
            }
            _ => Err(Code::QueryFailed.into()),
        };
        if witnessed || life.finished() {
            self.availability.clear(&observed);
            drop(lease);
            self.slot.finish(id, outcome, true);
        } else {
            // A local SDK/decode/EOF error is not an official response. Keep
            // this exact lease and slot until the original process really ends.
            self.slot.finish(id, outcome, false);
            life.terminated().await;
            self.availability.clear(&observed);
            drop(lease);
            self.slot.finish(id, Err(Code::QueryFailed.into()), true);
        }
    }
}

/// Called by the one actual actor. No await or protocol work runs inside it.
#[allow(clippy::too_many_arguments)]
pub(crate) fn start(
    request: Request,
    cx: ConnectionTo<Agent>,
    connection_id: &str,
    session_id: &str,
    life: &Arc<ConnectionLife>,
    busy: bool,
    deadline: tokio::time::Instant,
    result: oneshot::Sender<Result<(), ToolsError>>,
) {
    let outcome = (|| {
        if !request.matches(connection_id, session_id) {
            return Err(Code::Changed.into());
        }
        if request.slot.existing(&request.operation)?.is_some() {
            return Ok(());
        }
        if busy {
            return Err(Code::Busy.into());
        }
        if !request.availability.supports(request.operation.query()) {
            return Err(Code::Unavailable.into());
        }
        if tokio::time::Instant::now() >= deadline || result.is_closed() {
            return Err(Code::Timeout.into());
        }
        let lease = life
            .operation(format!("open:{session_id}"))
            .map_err(|_| Code::Busy)?;
        request.slot.admit(&request.operation)?;
        // This independent owner outlives actor/UI disposal. The ordinary
        // actor still delivers all original protocol events without changes.
        super::super::manager::runtime().spawn(request.run(cx, life.clone(), lease, deadline));
        Ok(())
    })();
    let _ = result.send(outcome);
}
