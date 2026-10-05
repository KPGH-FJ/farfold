//! Publish bounded, live-only account projections for one exact process.
use agent_client_protocol::{Agent, ConnectionTo, Dispatch, UntypedMessage};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use super::{
    account_query::AccountQuery,
    account_status::AccountIdentity,
    handshake::Handshake,
    manager::{AcpManager, AgentConnectionStatus, ConnectionKey, ManagedConnection},
};

#[derive(Clone)]
pub(crate) struct AccountObserver {
    account: Arc<Mutex<Option<AccountIdentity>>>,
    handshake: Arc<OnceLock<Handshake>>,
    connections: Arc<Mutex<HashMap<ConnectionKey, ManagedConnection>>>,
    key: ConnectionKey,
    sink: Option<Arc<dyn Fn(AgentConnectionStatus) + Send + Sync>>,
    pending_push: Arc<Mutex<Option<Option<AccountIdentity>>>>,
}

impl AccountObserver {
    pub(crate) fn new(
        account: Arc<Mutex<Option<AccountIdentity>>>,
        handshake: Arc<OnceLock<Handshake>>,
        connections: Arc<Mutex<HashMap<ConnectionKey, ManagedConnection>>>,
        key: ConnectionKey,
        sink: Option<Arc<dyn Fn(AgentConnectionStatus) + Send + Sync>>,
    ) -> Self {
        Self {
            account,
            handshake,
            connections,
            key,
            sink,
            pending_push: Arc::new(Mutex::new(None)),
        }
    }

    fn publish(&self, identity: Option<AccountIdentity>) {
        if let Ok(mut current) = self.account.lock() {
            *current = identity;
        }
        if !self.key.candidate
            && let Some(sink) = &self.sink
            && let Ok(connections) = self.connections.lock()
            && let Some(connection) = connections.get(&self.key)
            // A late result from a terminated predecessor cannot update the
            // replacement which may now occupy the same preparation address.
            && Arc::ptr_eq(&connection.account, &self.account)
        {
            sink(AcpManager::status_of(&self.key, connection));
        }
    }

    pub(crate) fn observe(&self, dispatch: &Dispatch<UntypedMessage, UntypedMessage>) -> bool {
        let Dispatch::Notification(message) = dispatch else {
            return false;
        };
        if message.method() != "_auth/status_update" {
            return false;
        }
        // A query declaration does not authorize push. Keep an early push in a
        // separate slot until the exact push capability has been accepted.
        let Ok(mut pending) = self.pending_push.lock() else {
            return true;
        };
        let Some(handshake) = self.handshake.get() else {
            *pending = Some(super::account_status::parse(message.params()));
            return true;
        };
        if !super::account_status::accepts(&handshake.public_json(), message.method()) {
            return false;
        }
        // This later push supersedes the pre-handshake slot. Keep publication
        // under the same lock so handshake_published cannot restore older data.
        *pending = None;
        self.publish(super::account_status::parse(message.params()));
        true
    }

    pub(crate) fn handshake_published(&self) {
        let Ok(mut pending) = self.pending_push.lock() else {
            return;
        };
        let Some(identity) = pending.take() else {
            return;
        };
        if self.handshake.get().is_some_and(|h| {
            super::account_status::accepts(&h.public_json(), "_auth/status_update")
        }) {
            self.publish(identity);
        }
    }

    pub(crate) async fn query(&self, cx: &ConnectionTo<Agent>, query: AccountQuery) {
        self.publish(query.read(cx).await);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_post_handshake_unknown_or_logout_supersedes_the_buffered_identity() {
        for kind in ["future", "none"] {
            let account = Arc::new(Mutex::new(None));
            let handshake = Arc::new(OnceLock::new());
            let observer = AccountObserver::new(
                account.clone(),
                handshake.clone(),
                Arc::new(Mutex::new(HashMap::new())),
                ConnectionKey {
                    agent_id: "fixture".into(),
                    cwd: "/fixture".into(),
                    candidate: false,
                    conversation_id: None,
                    service: None,
                },
                None,
            );
            let push = |kind: &str| {
                Dispatch::Notification(
                    UntypedMessage::new(
                        "_auth/status_update",
                        json!({"authStatus":{"kind":kind,"account":{"email":"old@example.test"}}}),
                    )
                    .unwrap(),
                )
            };
            assert!(observer.observe(&push("account")));
            assert!(account.lock().unwrap().is_none());
            handshake.set(Handshake::decode(json!({"protocolVersion":1,"agentCapabilities":{"_meta":{"authStatus":{}}}})).unwrap())
                .unwrap_or_else(|_| panic!("already set"));
            assert!(observer.observe(&push(kind)));
            observer.handshake_published();
            let current = account.lock().unwrap();
            assert!(current.as_ref().is_none_or(|a| a.email.is_none()));
            assert_eq!(current.is_some(), kind == "none");
        }
    }
}
