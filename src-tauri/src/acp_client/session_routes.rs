//! The original connection owns unclaimed session dispatches and ready inboxes.
//! No SDK retry Vec, persistent journal, identity inference or second controller.
use super::transient_pressure::{Budget, Lease};
use agent_client_protocol::{Dispatch, Handled};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{mpsc, watch};
struct Entry {
    sender: Sender,
    abandoned: Arc<AtomicBool>,
    events: super::pump::SessionSink,
}
#[derive(Default)]
struct State {
    routes: HashMap<String, Arc<Entry>>,
    pending: VecDeque<Queued>,
}
pub(super) struct Routes {
    state: Mutex<State>,
    budget: Arc<Budget>,
    unclaimed: Arc<Budget>,
    pressure: watch::Sender<bool>,
}
struct Queued {
    message: Dispatch,
    lease: Lease,
}
#[derive(Clone)]
pub(super) struct Sender(mpsc::UnboundedSender<Queued>, #[cfg(test)] Arc<Budget>);
pub(super) struct Inbox {
    receiver: mpsc::UnboundedReceiver<Queued>,
    current: Option<Lease>,
}
pub(super) struct Guard {
    routes: Weak<Routes>,
    id: String,
    entry: Arc<Entry>,
}
impl Default for Routes {
    fn default() -> Self {
        Self::new(Budget::shared())
    }
}
impl Routes {
    pub(super) fn new(budget: Arc<Budget>) -> Self {
        Self {
            state: Mutex::new(State::default()),
            budget,
            unclaimed: Budget::independent(),
            pressure: watch::channel(false).0,
        }
    }
    pub(super) fn unclaimed_budget(&self) -> Arc<Budget> {
        self.unclaimed.clone()
    }
    pub(super) fn has_unclaimed(&self) -> bool {
        self.state
            .lock()
            .map_or(true, |state| !state.pending.is_empty())
    }
    pub(super) async fn unclaimed_pressure(&self) {
        let mut pressure = self.pressure.subscribe();
        while !*pressure.borrow_and_update() {
            if pressure.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }
    pub(super) fn retire(&self) {
        let retired = std::mem::take(&mut *self.state.lock().unwrap_or_else(|e| e.into_inner()));
        drop(retired);
        self.pressure.send_replace(false);
    }
    pub(super) fn channel(&self) -> (Sender, Inbox) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (
            Sender(
                sender,
                #[cfg(test)]
                self.budget.clone(),
            ),
            Inbox {
                receiver,
                current: None,
            },
        )
    }
    pub(super) fn register(
        self: &Arc<Self>,
        id: &str,
        sender: Sender,
        abandoned: Arc<AtomicBool>,
        events: super::pump::SessionSink,
    ) -> Result<Guard, String> {
        let entry = Arc::new(Entry {
            sender,
            abandoned,
            events,
        });
        let mut state = self.state.lock().map_err(|_| "无法接收对话消息")?;
        if state.routes.contains_key(id) {
            return Err("此对话已经打开".into());
        }
        state.routes.insert(id.to_owned(), entry.clone());
        // Transfer the same Dispatch from local unknown debt to live backlog;
        // preserve this session's FIFO without retaining a duplicate body.
        let mut remaining = VecDeque::new();
        while let Some(queued) = state.pending.pop_front() {
            if session_id(&queued.message) == Some(id) {
                let live = self
                    .budget
                    .json(&queued.message.message().map(|m| (m.method(), m.params())));
                let queued = Queued {
                    message: queued.message,
                    lease: live,
                };
                if let Err(error) = entry.sender.0.send(queued) {
                    let local = self
                        .unclaimed
                        .json(&error.0.message.message().map(|m| (m.method(), m.params())));
                    let queued = Queued {
                        message: error.0.message,
                        lease: local,
                    };
                    remaining.push_back(queued);
                }
            } else {
                remaining.push_back(queued);
            }
        }
        state.pending = remaining;
        self.pressure.send_replace(self.unclaimed.saturated());
        let paused = self.unclaimed.saturated();
        drop(state);
        if paused {
            unavailable(&entry);
        }
        Ok(Guard {
            routes: Arc::downgrade(self),
            id: id.to_owned(),
            entry,
        })
    }
    pub(super) fn dispatch(
        &self,
        message: Dispatch,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        if message
            .message()
            .is_none_or(|m| m.params().get("sessionId").is_none())
        {
            return Ok(Handled::No {
                message,
                retry: false,
            });
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| agent_client_protocol::Error::internal_error())?;
        let route = session_id(&message).and_then(|id| state.routes.get(id));
        if let Some(route) = route {
            if route.abandoned.load(Ordering::SeqCst) {
                if let Dispatch::Request(_, responder) = message {
                    let _ = responder
                        .respond_with_error(agent_client_protocol::Error::request_cancelled());
                }
                return Ok(Handled::Yes);
            }
            let lease = self
                .budget
                .json(&message.message().map(|m| (m.method(), m.params())));
            match route.sender.0.send(Queued { message, lease }) {
                Ok(()) => return Ok(Handled::Yes),
                Err(error) => {
                    let local = self
                        .unclaimed
                        .json(&error.0.message.message().map(|m| (m.method(), m.params())));
                    state.pending.push_back(Queued {
                        message: error.0.message,
                        lease: local,
                    });
                }
            }
        } else {
            let lease = self
                .unclaimed
                .json(&message.message().map(|m| (m.method(), m.params())));
            state.pending.push_back(Queued { message, lease });
        }
        // Unknown/malformed IDs stay unconfirmed on this exact connection.
        // They pause ONLY this connection. Existing operation owners report an
        // unconfirmed result and keep the actual request/reservation alive.
        let paused = self.unclaimed.saturated();
        let newly_paused = !self.pressure.send_replace(paused) && paused;
        let notify: Vec<_> = if newly_paused {
            state.routes.values().cloned().collect()
        } else {
            Vec::new()
        };
        drop(state);
        // Common client status only, not an Agent envelope or stop receipt.
        // Never invoke UI callbacks while the original routes mutex is held.
        for route in notify {
            unavailable(&route);
        }
        Ok(Handled::Yes)
    }
}
fn unavailable(entry: &Entry) {
    if !entry.abandoned.load(Ordering::SeqCst) {
        (entry.events)(
            serde_json::json!({"kind":"deliveryUnavailable","message":"收到的消息暂时无法对应到对话，接收已暂停。原工作可能仍在继续，请查看连接状态。"}),
        );
    }
}
fn session_id(message: &Dispatch) -> Option<&str> {
    message.message()?.params().get("sessionId")?.as_str()
}
impl Inbox {
    pub(super) async fn recv(&mut self) -> Option<Dispatch> {
        self.current.take();
        let queued = self.receiver.recv().await?;
        self.current = Some(queued.lease);
        Some(queued.message)
    }
    pub(super) fn try_recv(&mut self) -> Result<Dispatch, mpsc::error::TryRecvError> {
        self.current.take();
        let queued = self.receiver.try_recv()?;
        self.current = Some(queued.lease);
        Ok(queued.message)
    }
}
#[cfg(test)]
impl Sender {
    pub(super) fn send(
        &self,
        message: Dispatch,
    ) -> Result<(), Box<mpsc::error::SendError<Dispatch>>> {
        let lease = self
            .1
            .json(&message.message().map(|m| (m.method(), m.params())));
        self.0
            .send(Queued { message, lease })
            .map_err(|e| Box::new(mpsc::error::SendError(e.0.message)))
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(routes) = self.routes.upgrade()
            && let Ok(mut state) = routes.state.lock()
            && state
                .routes
                .get(&self.id)
                .is_some_and(|entry| Arc::ptr_eq(entry, &self.entry))
        {
            state.routes.remove(&self.id);
        }
    }
}

#[cfg(test)]
#[path = "session_routes_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "session_routes_wire_tests.rs"]
mod wire_tests;
