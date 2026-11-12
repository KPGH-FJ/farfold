//! Passive presentation of reviewed official Goose notification shapes.
//! Original notifications stay intact. Hints are never work ownership,
//! compaction inference or an execution result.
use super::{
    manager::STATE_READY,
    pump::{SessionControl, SessionMap, SessionOps},
};
use agent_client_protocol::{UntypedMessage, schema::v1::Meta};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, AtomicU8, Ordering},
};

const METHOD: &str = "_goose/unstable/session/update";
const MAX_MESSAGE: usize = 2048;
mod message_usage;
pub(crate) mod session_usage;

pub(crate) fn initialize_meta(meta: &mut Meta, enabled: bool) {
    if enabled {
        meta.insert("goose".into(), json!({"customNotifications":true}));
    }
}

fn status(params: &Value) -> Option<Value> {
    let raw = params.get("update")?.get("status")?.as_object()?;
    let kind = raw.get("type")?.as_str()?;
    if !matches!(kind, "notice" | "progress") {
        return None;
    }
    let message = raw.get("message")?.as_str()?;
    if message.trim().is_empty()
        || message
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return None;
    }
    let mut chars = message.chars();
    let text: String = chars.by_ref().take(MAX_MESSAGE).collect();
    Some(json!({"type":kind,"message":text,"truncated":chars.next().is_some()}))
}

fn present(
    mut value: Value,
    session_id: &str,
    enabled: bool,
    current: impl FnOnce() -> bool,
) -> Value {
    if enabled
        && value.get("kind").and_then(Value::as_str) == Some("notification")
        && value.get("method").and_then(Value::as_str) == Some(METHOD)
        && let Some(params) = value.get("params")
        && params.get("sessionId").and_then(Value::as_str) == Some(session_id)
        && params
            .pointer("/update/sessionUpdate")
            .and_then(Value::as_str)
            == Some("status_message")
    {
        // Only a presentation hint is added beside the untouched method/params.
        // Invalid or unowned live-only content is null, never a clear command.
        let hint = json!({"kind":"liveStatus","status":if current() {status(params)} else {None}});
        value
            .as_object_mut()
            .expect("notification object")
            .insert("presentation".into(), hint);
    }
    value
}

pub(crate) struct Owner {
    enabled: bool,
    display_allowed: AtomicBool,
    session: String,
    connection: String,
    state: Arc<AtomicU8>,
    routes: Weak<Mutex<std::collections::HashMap<String, super::pump::SessionEntry>>>,
    control: Option<tokio::sync::mpsc::WeakUnboundedSender<SessionControl>>,
    opening: Option<super::operations::Operation>,
}
impl Owner {
    /// Opening/replay retains the source's live-only classification, but has
    /// no established display owner. Its hint must therefore carry null.
    pub(crate) fn inactive(ops: &SessionOps, session: &str) -> Self {
        Self {
            enabled: ops.live_status_enabled,
            display_allowed: AtomicBool::new(false),
            session: session.into(),
            connection: ops.connection_id.clone(),
            state: ops.life.state.clone(),
            routes: Weak::new(),
            control: None,
            opening: None,
        }
    }
    /// The original registered load route and interested public opening own
    /// replayable message metadata, but cannot display live-only status text.
    pub(crate) fn loading(
        ops: &SessionOps,
        session: &str,
        purpose: super::open_purpose::OpenPurpose,
        preview: Option<&str>,
        operation: &super::operations::Operation,
    ) -> Self {
        let mut owner = Self::inactive(ops, session);
        if purpose == super::open_purpose::OpenPurpose::Conversation && preview.is_none() {
            owner.opening = Some(operation.observer());
        }
        owner
    }
    pub(crate) fn new(ops: &SessionOps, session: &str, sessions: &SessionMap) -> Self {
        Self::bind(
            ops.live_status_enabled,
            &ops.connection_id,
            ops.life.state.clone(),
            session,
            sessions,
        )
    }
    fn bind(
        enabled: bool,
        connection: &str,
        state: Arc<AtomicU8>,
        session: &str,
        sessions: &SessionMap,
    ) -> Self {
        let control = sessions
            .lock()
            .ok()
            .and_then(|entries| entries.get(session).map(|e| e.control.downgrade()));
        Self {
            enabled,
            display_allowed: AtomicBool::new(false),
            session: session.into(),
            connection: connection.into(),
            state,
            routes: Arc::downgrade(sessions),
            control,
            opening: None,
        }
    }
    pub(crate) fn set_display_allowed(&self, allowed: bool) {
        self.display_allowed.store(allowed, Ordering::SeqCst);
    }
    fn current(&self) -> bool {
        self.display_allowed.load(Ordering::SeqCst) && self.metadata_owner()
    }
    fn metadata_owner(&self) -> bool {
        self.enabled
            && self.state.load(std::sync::atomic::Ordering::SeqCst) == STATE_READY
            && (self.opening.as_ref().is_some_and(|op| op.interested())
                || self.routes.upgrade().is_some_and(|sessions| {
                    sessions.lock().is_ok_and(|entries| {
                        entries.get(&self.session).is_some_and(|entry| {
                            entry.connection_is(&self.connection)
                                && entry.preview_token.is_none()
                                && entry.purpose == super::open_purpose::OpenPurpose::Conversation
                                && self.control.as_ref().and_then(|c| c.upgrade()).is_some_and(
                                    |original| {
                                        !original.is_closed()
                                            && original.same_channel(&entry.control)
                                    },
                                )
                        })
                    })
                }))
    }
}

/// Only the real nonstandard Dispatch::Notification branch calls this. A
/// standard session/update body that resembles our wrapper cannot gain a hint.
pub(crate) fn notification(message: UntypedMessage, owner: &Owner) -> Value {
    let (method, params) = message.into_parts();
    let is_message_usage = owner.enabled
        && method == METHOD
        && params.get("sessionId").and_then(Value::as_str) == Some(owner.session.as_str())
        && params
            .pointer("/update/sessionUpdate")
            .and_then(Value::as_str)
            == Some("message_usage");
    let is_session_usage = owner.enabled
        && method == METHOD
        && params.get("sessionId").and_then(Value::as_str) == Some(owner.session.as_str())
        && params
            .pointer("/update/sessionUpdate")
            .and_then(Value::as_str)
            == Some("usage_update");
    let value = present(
        json!({"kind":"notification","method":method,"params":params}),
        &owner.session,
        owner.enabled,
        || owner.current(),
    );
    if is_message_usage {
        message_usage::present(value, &owner.connection, owner.metadata_owner())
    } else if is_session_usage {
        session_usage::present(value, &owner.connection, owner.metadata_owner())
    } else {
        value
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod wire_tests;
