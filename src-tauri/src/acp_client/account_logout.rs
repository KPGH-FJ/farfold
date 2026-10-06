//! Official logout routes. Standard ACP remains primary; a reviewed supplement
//! must recheck its live credential source before sending an effectful request.
use super::{
    account_query::AccountQuery,
    account_status::{AccountIdentity, AccountKind},
    manager::{AcpManager, ManagedConnection},
    operations::Operation,
};
use agent_client_protocol::schema::v1::LogoutRequest;
use agent_client_protocol::{Agent, ConnectionTo, UntypedMessage};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Clone, Copy)]
pub(crate) enum LogoutRoute {
    Standard,
    Vibe,
}

impl LogoutRoute {
    pub(crate) fn for_connection(connection: &ManagedConnection) -> Option<Self> {
        let handshake = connection.handshake.get()?;
        if handshake.can_logout() {
            Some(Self::Standard)
        } else if AccountQuery::declared(&handshake.public_json(), connection.account_query)
            == Some(AccountQuery::Vibe)
        {
            Some(Self::Vibe)
        } else {
            None
        }
    }

    pub(crate) fn available(self, connection: &ManagedConnection) -> bool {
        match self {
            Self::Standard => true,
            Self::Vibe => connection.account.lock().ok().is_some_and(|account| {
                account
                    .as_ref()
                    .is_some_and(|account| account.logout_available)
            }),
        }
    }

    pub(crate) async fn execute(
        self,
        cx: &ConnectionTo<Agent>,
        operation: &Operation,
        account: &Arc<Mutex<Option<AccountIdentity>>>,
        effect_sent: &AtomicBool,
    ) -> Result<(), String> {
        if matches!(self, Self::Standard) {
            effect_sent.store(true, Ordering::SeqCst);
            return operation
                .request(cx, cx.send_request(LogoutRequest::new()))
                .await
                .map(|_| ())
                .map_err(super::operations::authentication_error);
        }
        // A stale UI permission is never sufficient. This read and the mutation
        // run under the same account scope and exact connection operation.
        let current = Self::vibe_status(cx, operation).await;
        let allowed = current.as_ref().is_some_and(|a| a.logout_available);
        Self::publish(account, current)?;
        if !operation.interested() {
            return Err("AUTH_CANCELLED".into());
        }
        if !allowed {
            return Err("当前凭据来源不能在这里退出，请重新检查账号设置".into());
        }
        // Once sent, cancellation/deadline does not discard the real response.
        Self::publish(account, None)?;
        let request = UntypedMessage::new("_auth/signOut", json!({}))
            .map_err(super::operations::authentication_error)?;
        effect_sent.store(true, Ordering::SeqCst);
        operation
            .request(cx, cx.send_request_to(Agent, request))
            .await
            .map_err(super::operations::authentication_error)?;
        // The official empty response acknowledges the action. Confirm the
        // resulting local credential state separately; never claim remote validity.
        let current = Self::vibe_status(cx, operation).await;
        let signed_out = current
            .as_ref()
            .is_some_and(|a| a.kind == AccountKind::MissingCredential);
        Self::publish(account, current)?;
        if signed_out {
            Ok(())
        } else {
            Err("退出操作已返回，但账号状态尚未确认，请重新检查".into())
        }
    }

    async fn vibe_status(
        cx: &ConnectionTo<Agent>,
        operation: &Operation,
    ) -> Option<AccountIdentity> {
        let request = UntypedMessage::new(AccountQuery::Vibe.method(), json!({})).ok()?;
        let reply: Value = tokio::time::timeout(
            Duration::from_secs(3),
            operation.request(cx, cx.send_request_to(Agent, request)),
        )
        .await
        .ok()?
        .ok()?;
        AccountQuery::Vibe.parse(&reply)
    }

    fn publish(
        account: &Arc<Mutex<Option<AccountIdentity>>>,
        value: Option<AccountIdentity>,
    ) -> Result<(), String> {
        *account.lock().map_err(|_| "账号状态尚未确认")? = value;
        Ok(())
    }
}

impl AcpManager {
    pub(crate) fn can_logout(&self, agent_id: &str, cwd: &Path) -> bool {
        self.live_connection(agent_id, cwd)
            .ok()
            .is_some_and(|connection| {
                LogoutRoute::for_connection(&connection)
                    .is_some_and(|route| route.available(&connection))
            })
    }
}
