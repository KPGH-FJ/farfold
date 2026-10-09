//! Transient responders for official v1 form/URL inquiries. No account, URL or
//! response content is persisted. External completion is not parent success.
use super::{
    lifecycle::{ConnectionLife, WorkLease},
    operations::Operation,
    pump::SessionSink,
    session::InteractionReply,
};
use agent_client_protocol::{
    Agent, ConnectionTo, Dispatch, Handled, RequestCancellation, Responder, SentRequest,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::oneshot;

const MAX_PENDING: usize = 32;
const MAX_PARAMS: usize = 256 * 1024;
const MAX_URL_IDS: usize = 4096;

pub(crate) struct PendingElicitation {
    pub responder: Option<Responder<Value>>,
    pub cancelled: RequestCancellation,
    _completed: oneshot::Sender<()>,
    pub session_id: String,
    pub lease: WorkLease,
    owner: Value,
    url_id: Option<String>,
    events: SessionSink,
    abandoned: Option<Arc<AtomicBool>>,
}
pub(crate) type PendingElicitations = Arc<Mutex<HashMap<String, PendingElicitation>>>;

#[derive(Clone)]
struct RequestOwner {
    events: SessionSink,
    operation: Operation,
}

#[derive(Clone)]
pub(crate) struct ConnectionElicitations {
    pending: PendingElicitations,
    life: Arc<ConnectionLife>,
    connection_id: String,
    requests: Arc<Mutex<HashMap<String, RequestOwner>>>,
    openings: Arc<Mutex<HashMap<String, RequestOwner>>>,
    // Connection-local retired IDs prevent a late completion from resolving a
    // reused ID. Bounded; exhaustion rejects new URL requests explicitly.
    url_ids: Arc<Mutex<HashSet<String>>>,
    queued_urls: Arc<Mutex<HashMap<String, Option<Value>>>>,
}

impl ConnectionElicitations {
    pub(crate) fn new(
        pending: PendingElicitations,
        life: Arc<ConnectionLife>,
        connection_id: String,
    ) -> Self {
        Self {
            pending,
            life,
            connection_id,
            requests: Default::default(),
            openings: Default::default(),
            url_ids: Default::default(),
            queued_urls: Default::default(),
        }
    }

    pub(crate) fn opening_session(
        &self,
        id: &str,
        operation: &Operation,
        events: SessionSink,
    ) -> OpeningGuard {
        if let Ok(mut openings) = self.openings.lock() {
            openings.insert(
                id.to_owned(),
                RequestOwner {
                    events,
                    operation: operation.clone(),
                },
            );
        }
        OpeningGuard {
            hub: self.clone(),
            id: id.to_owned(),
            abandoned: operation.abandoned.clone(),
        }
    }

    /// Holding this short lock across synchronous send + registration prevents
    /// a fast reverse request from observing an unregistered parent. No await,
    /// user code or user response is allowed while holding the lock.
    pub(crate) async fn request<T>(
        &self,
        operation: &Operation,
        cx: &ConnectionTo<Agent>,
        send: impl FnOnce() -> SentRequest<T>,
        events: SessionSink,
    ) -> Result<T, agent_client_protocol::Error> {
        let (sent, key) = {
            let mut requests = self
                .requests
                .lock()
                .map_err(|_| agent_client_protocol::Error::internal_error())?;
            let sent = send();
            let key = serde_json::to_string(sent.id())
                .map_err(|_| agent_client_protocol::Error::internal_error())?;
            requests.insert(
                key.clone(),
                RequestOwner {
                    events,
                    operation: operation.clone(),
                },
            );
            (sent, key)
        };
        let _owner = RequestGuard {
            hub: self.clone(),
            key,
        };
        operation.request(cx, sent).await
    }

    pub(crate) fn dispatch(
        &self,
        dispatch: Dispatch,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        if let Dispatch::Request(message, _) = &dispatch
            && message.method() == "elicitation/create"
            && message.params().get("mode").and_then(Value::as_str) == Some("url")
            && let Some(id) = message
                .params()
                .get("elicitationId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 4096)
        {
            let mut used = self
                .url_ids
                .lock()
                .map_err(|_| agent_client_protocol::Error::internal_error())?;
            if used.len() >= MAX_URL_IDS || !used.insert(id.to_owned()) {
                // Even rejected IDs stay retired: a later completion has no
                // request identifier with which to distinguish a new owner.
                if let Dispatch::Request(_, responder) = dispatch {
                    let _ = responder
                        .respond_with_error(agent_client_protocol::Error::invalid_params());
                }
                return Ok(Handled::Yes);
            }
            if message.params().get("sessionId").is_some() {
                self.queued_urls
                    .lock()
                    .map_err(|_| agent_client_protocol::Error::internal_error())?
                    .insert(id.to_owned(), None);
            }
        }
        match dispatch {
            Dispatch::Notification(message) if message.method() == "elicitation/complete" => {
                if let Some(id) = message
                    .params()
                    .get("elicitationId")
                    .and_then(Value::as_str)
                {
                    self.complete(id, message.params());
                }
                Ok(Handled::Yes)
            }
            Dispatch::Request(message, responder) if message.method() == "elicitation/create" => {
                if let Some(id) = message.params().get("sessionId").and_then(Value::as_str) {
                    let openings = self.openings.lock();
                    let owner = openings.as_ref().ok().and_then(|map| map.get(id)).cloned();
                    if let Some(owner) = owner {
                        if owner.operation.interested() {
                            self.create_owned(
                                message.params().clone(),
                                responder,
                                id,
                                owner.events,
                                Some(owner.operation.abandoned.clone()),
                            );
                        } else {
                            self.discard_queued(message.params());
                            let _ = responder.respond_with_error(
                                agent_client_protocol::Error::request_cancelled(),
                            );
                        }
                        return Ok(Handled::Yes);
                    }
                    return Ok(Handled::No {
                        message: Dispatch::Request(message, responder),
                        retry: false,
                    });
                }

                let params = message.params();
                let key = params
                    .get("requestId")
                    .and_then(|id| serde_json::to_string(id).ok());
                let requests = self.requests.lock();
                let owner = key
                    .as_ref()
                    .and_then(|key| requests.as_ref().ok()?.get(key).cloned());
                match owner {
                    Some(owner) if owner.operation.interested() => {
                        self.create_owned(
                            params.clone(),
                            responder,
                            "",
                            owner.events,
                            Some(owner.operation.abandoned.clone()),
                        );
                    }
                    _ => {
                        let _ = responder
                            .respond_with_error(agent_client_protocol::Error::invalid_params());
                    }
                }
                drop(requests);
                Ok(Handled::Yes)
            }
            Dispatch::Request(message, responder)
                if message.params().get("sessionId").is_none()
                    && message.params().get("requestId").is_some() =>
            {
                let key = message
                    .params()
                    .get("requestId")
                    .and_then(|id| serde_json::to_string(id).ok());
                let owners = self.requests.lock();
                if let Some(owner) = key.as_ref().and_then(|key| owners.as_ref().ok()?.get(key))
                    && owner.operation.interested()
                {
                    (owner.events)(
                        json!({"kind":"elicitationUnavailable","params":{"method":message.method(),"params":message.params()},"reason":"unknown_method"}),
                    );
                }
                let _ =
                    responder.respond_with_error(agent_client_protocol::Error::method_not_found());
                Ok(Handled::Yes)
            }
            other => Ok(Handled::No {
                message: other,
                retry: false,
            }),
        }
    }

    pub(crate) fn discard_queued(&self, params: &Value) {
        if let Some(id) = params.get("elicitationId").and_then(Value::as_str)
            && let Ok(mut queued) = self.queued_urls.lock()
        {
            queued.remove(id);
        }
    }

    pub(crate) fn create(
        &self,
        params: Value,
        responder: Responder<Value>,
        session_id: &str,
        events: SessionSink,
    ) -> Option<String> {
        self.create_owned(params, responder, session_id, events, None)
    }

    fn create_owned(
        &self,
        params: Value,
        responder: Responder<Value>,
        session_id: &str,
        events: SessionSink,
        abandoned: Option<Arc<AtomicBool>>,
    ) -> Option<String> {
        let mode = params.get("mode").and_then(Value::as_str);
        let session_scope = params.get("sessionId").and_then(Value::as_str);
        let request_scope = params.get("requestId");
        let shape_valid = params.get("message").is_some_and(Value::is_string)
            && ((session_scope == Some(session_id)
                && !session_id.is_empty()
                && request_scope.is_none())
                || (session_id.is_empty()
                    && session_scope.is_none()
                    && request_scope.is_some_and(|v| v.is_string() || v.is_i64() || v.is_u64())));
        let url_id = if mode == Some("url") {
            params
                .get("elicitationId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 4096)
                .map(str::to_owned)
        } else {
            None
        };
        let _queued = QueuedGuard {
            hub: self.clone(),
            id: url_id.clone(),
        };
        let supported = match mode {
            Some("form") => params.get("requestedSchema").is_some_and(Value::is_object),
            Some("url") => {
                url_id.is_some()
                    && params
                        .get("url")
                        .and_then(Value::as_str)
                        .is_some_and(safe_url)
            }
            _ => false,
        };
        if !shape_valid || !supported || params.to_string().len() > MAX_PARAMS {
            events(
                json!({"kind":"elicitationUnavailable","params":params,"reason":"unsupported_or_invalid"}),
            );
            let _ = responder.respond_with_error(agent_client_protocol::Error::invalid_params());
            return None;
        }
        let Ok(lease) = self.life.work() else {
            let _ = responder.respond_with_error(agent_client_protocol::Error::request_cancelled());
            return None;
        };
        let Ok(mut pending) = self.pending.lock() else {
            let _ = responder.respond_with_error(agent_client_protocol::Error::internal_error());
            return None;
        };
        if pending
            .values()
            .filter(|p| p.lease.belongs_to(&self.life))
            .count()
            >= MAX_PENDING
        {
            events(json!({"kind":"elicitationUnavailable","params":params,"reason":"capacity"}));
            let _ = responder.respond_with_error(agent_client_protocol::Error::invalid_params());
            return None;
        }
        let request_id = super::pump::next_request_id();
        let owner = if session_id.is_empty() {
            json!({"connectionId":self.connection_id,"requestId":request_scope})
        } else {
            json!({"connectionId":self.connection_id,"sessionId":session_id})
        };
        let cancelled = responder.cancellation();
        let cancellation = cancelled.clone();
        let (completed, done) = oneshot::channel();
        // Keep pending locked until insertion so complete cannot pass between
        // removing the queued prefix and publishing its live owner.
        let early_complete = url_id
            .as_ref()
            .and_then(|id| self.queued_urls.lock().ok()?.remove(id))
            .flatten();
        pending.insert(
            request_id.clone(),
            PendingElicitation {
                responder: Some(responder),
                cancelled,
                _completed: completed,
                lease,
                session_id: session_id.to_owned(),
                owner: owner.clone(),
                url_id,
                events: events.clone(),
                abandoned,
            },
        );
        events(
            json!({"kind":"elicitation","requestId":request_id,"owner":owner,
            "mode":mode,"message":params.get("message"),"schema":params.get("requestedSchema"),
            "url":params.get("url"),"elicitationId":params.get("elicitationId"),
            "toolCallId":params.get("toolCallId"),"request":params}),
        );
        drop(pending);
        let registry = self.pending.clone();
        let expired_id = request_id.clone();
        super::manager::runtime().spawn(async move {
            tokio::select! {
                _ = done => {},
                _ = cancellation.cancelled() => expire(&registry, &expired_id, "cancelled"),
            }
        });
        if let Some(complete) = early_complete
            && let Some(id) = complete.get("elicitationId").and_then(Value::as_str)
        {
            self.complete(id, &complete);
        }
        Some(request_id)
    }

    fn complete(&self, url_id: &str, params: &Value) {
        let entry = self.pending.lock().ok().and_then(|mut entries| {
            let id = entries
                .iter()
                .find(|(_, item)| {
                    item.lease.belongs_to(&self.life) && item.url_id.as_deref() == Some(url_id)
                })
                .map(|(id, _)| id.clone())?;
            entries.remove(&id).map(|entry| (id, entry))
        });
        if entry.is_none() {
            if let Ok(mut queued) = self.queued_urls.lock()
                && let Some(complete) = queued.get_mut(url_id)
                && complete.is_none()
            {
                *complete = Some(params.clone());
            }
            return;
        }
        if let Some((id, mut entry)) = entry {
            if entry.cancelled.is_cancelled()
                || entry
                    .abandoned
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::SeqCst))
            {
                if let Some(responder) = entry.responder.take() {
                    let _ = responder
                        .respond_with_error(agent_client_protocol::Error::request_cancelled());
                }
                (entry.events)(
                    json!({"kind":"interactionExpired","requestId":id,"reason":"cancelled"}),
                );
                return;
            }
            // Completion may precede consent. Never manufacture accept; ending
            // the obsolete protocol request is distinct from a user's cancel.
            if let Some(responder) = entry.responder.take() {
                let _ =
                    responder.respond_with_error(agent_client_protocol::Error::request_cancelled());
            }
            (entry.events)(json!({"kind":"elicitationComplete","requestId":id,"params":params}));
        }
    }
}

pub(crate) struct OpeningGuard {
    hub: ConnectionElicitations,
    id: String,
    abandoned: Arc<AtomicBool>,
}
impl Drop for OpeningGuard {
    fn drop(&mut self) {
        if let Ok(mut openings) = self.hub.openings.lock()
            && openings
                .get(&self.id)
                .is_some_and(|owner| Arc::ptr_eq(&owner.operation.abandoned, &self.abandoned))
        {
            openings.remove(&self.id);
        }
        let ids = self
            .hub
            .pending
            .lock()
            .ok()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|(_, entry)| {
                        entry.lease.belongs_to(&self.hub.life)
                            && entry.session_id == self.id
                            && entry
                                .abandoned
                                .as_ref()
                                .is_some_and(|flag| Arc::ptr_eq(flag, &self.abandoned))
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for id in ids {
            expire(&self.hub.pending, &id, "parent_ended");
        }
    }
}

struct QueuedGuard {
    hub: ConnectionElicitations,
    id: Option<String>,
}
impl Drop for QueuedGuard {
    fn drop(&mut self) {
        if let Some(id) = &self.id
            && let Ok(mut queued) = self.hub.queued_urls.lock()
        {
            queued.remove(id);
        }
    }
}

struct RequestGuard {
    hub: ConnectionElicitations,
    key: String,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut owners) = self.hub.requests.lock() {
            owners.remove(&self.key);
        }
        let ids = self
            .hub
            .pending
            .lock()
            .ok()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|(_, entry)| {
                        entry.lease.belongs_to(&self.hub.life)
                            && entry.owner.get("requestId").is_some_and(|id| {
                                serde_json::to_string(id).ok().as_deref() == Some(&self.key)
                            })
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for id in ids {
            expire(&self.hub.pending, &id, "parent_ended");
        }
    }
}

fn expire(pending: &PendingElicitations, id: &str, reason: &str) {
    let entry = pending.lock().ok().and_then(|mut map| map.remove(id));
    if let Some(mut entry) = entry {
        if let Some(responder) = entry.responder.take() {
            let _ = responder.respond_with_error(agent_client_protocol::Error::request_cancelled());
        }
        (entry.events)(json!({"kind":"interactionExpired","requestId":id,"reason":reason}));
    }
}

pub(crate) fn cancel(pending: &PendingElicitations, ids: &mut Vec<String>) {
    for id in ids.drain(..) {
        let entry = pending.lock().ok().and_then(|mut map| map.remove(&id));
        if let Some(mut entry) = entry {
            if let Some(responder) = entry.responder.take() {
                let _ = responder.respond(json!({"action":"cancel"}));
            }
            (entry.events)(
                json!({"kind":"interactionExpired","requestId":id,"reason":"cancelled"}),
            );
        }
    }
}

pub(crate) fn safe_url(raw: &str) -> bool {
    if raw.len() > 16 * 1024
        || raw.chars().any(char::is_control)
        || raw.trim() != raw
        || raw.contains('\\')
    {
        return false;
    }
    tauri::Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

pub(crate) fn respond(
    pending: &PendingElicitations,
    id: &str,
    session_id: Option<&str>,
    owner: Option<&Value>,
    action: &str,
    content: Option<Value>,
) -> Result<InteractionReply, String> {
    if !["accept", "decline", "cancel"].contains(&action)
        || (action == "accept" && content.as_ref().is_some_and(|v| !v.is_object()))
    {
        return Ok(InteractionReply::new(
            "retryable",
            Some("请检查填写内容后重试"),
        ));
    }
    let mut entries = pending.lock().map_err(|_| "无法读取待处理事项")?;
    let Some(entry) = entries.get_mut(id) else {
        return Ok(InteractionReply::new("expired", None));
    };
    if entry.cancelled.is_cancelled()
        || entry
            .abandoned
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
    {
        entries.remove(id);
        return Ok(InteractionReply::new("expired", None));
    }
    let owner_matches = if entry.session_id.is_empty() {
        owner == Some(&entry.owner)
    } else {
        session_id == Some(entry.session_id.as_str())
            && owner.is_none_or(|owner| owner == &entry.owner)
    };
    if !owner_matches {
        return Ok(InteractionReply::new("expired", None));
    }
    let Some(responder) = entry.responder.take() else {
        return Ok(InteractionReply::new(
            "uncertain",
            Some("答复结果尚未确认，请等待"),
        ));
    };
    let mut response = json!({"action":action});
    if action == "accept" && entry.url_id.is_none() {
        response["content"] = content.unwrap_or_else(|| json!({}));
    }
    match responder.respond(response) {
        Ok(()) => {
            if entry.url_id.is_none() || action != "accept" {
                entries.remove(id);
            }
            Ok(InteractionReply::new("submitted", None))
        }
        Err(_) => Ok(InteractionReply::new(
            "uncertain",
            Some("答复结果尚未确认，请等待"),
        )),
    }
}
