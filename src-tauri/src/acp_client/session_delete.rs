//! Keep official deletion on the exact connection selected before close.
use super::{
    manager::{AcpManager, ManagedConnection, ManagerCommand, STATE_READY},
    mutation::DeleteFailure,
};
use std::{path::Path, sync::atomic::Ordering, time::Duration};
use tokio::sync::oneshot;

pub(super) struct Attempt {
    pub result: Result<bool, DeleteFailure>,
    pub connection_closed: bool,
}
impl Attempt {
    fn refused() -> Self {
        Self {
            result: Err(DeleteFailure::NotDispatched),
            connection_closed: false,
        }
    }
}

impl AcpManager {
    pub(super) async fn close_and_delete_session(
        &self,
        agent: &str,
        cwd: &Path,
        native: &str,
    ) -> Attempt {
        let reservation = match self.opening_sessions.reserve(agent, cwd, native) {
            Ok(value) => value,
            Err(_) => return Attempt::refused(),
        };
        let connection = match self.session_owner(agent, cwd, native) {
            Ok(Some(value)) if value.state.load(Ordering::SeqCst) == STATE_READY => value,
            Ok(None) => {
                return Attempt {
                    result: Ok(false),
                    connection_closed: false,
                };
            }
            _ => return Attempt::refused(),
        };
        let _lease = match connection.life.operation(format!("delete:{native}")) {
            Ok(value) => value,
            Err(_) => return Attempt::refused(),
        };
        let Some(handshake) = connection.handshake.get() else {
            return Attempt::refused();
        };
        let supports = &handshake.typed.agent_capabilities.session_capabilities;
        let (deletes, closes) = (supports.delete.is_some(), supports.close.is_some());
        if deletes && !closes {
            // Local detach removes the pump. Without remote close, revoke its
            // browser permission then delete through the still-owned pump.
            if prepare_live_delete(&connection, native).await.is_err() {
                return Attempt::refused();
            }
            let result = async {
                let control = connection
                    .sessions
                    .lock()
                    .map_err(|_| DeleteFailure::NotDispatched)?
                    .get(native)
                    .ok_or(DeleteFailure::NotDispatched)?
                    .control
                    .clone();
                let (result, receive) = oneshot::channel();
                control
                    .send(super::pump::SessionControl::Delete {
                        result,
                        deadline: tokio::time::Instant::now() + Duration::from_secs(30),
                        opening: Some(reservation),
                    })
                    .map_err(|_| DeleteFailure::NotDispatched)?;
                super::wait::reply(receive, Duration::from_secs(30), "session delete")
                    .await
                    .map_err(DeleteFailure::Unconfirmed)??;
                Ok(true)
            }
            .await;
            let connection_closed = matches!(result, Ok(true));
            return Attempt {
                result,
                connection_closed,
            };
        }
        if self
            .close_session_owned(agent, cwd, native, None)
            .await
            .is_err()
        {
            return Attempt::refused();
        }
        let outcome = async {
            if !deletes {
                return Ok(false);
            }
            if connection.state.load(Ordering::SeqCst) != STATE_READY {
                return Err(DeleteFailure::NotDispatched);
            }
            let (result, receive) = oneshot::channel();
            // Never look up a preparation/replacement connection after close.
            // The queued command retains the native reservation on timeout.
            connection
                .send_reserved(
                    ManagerCommand::DeleteSession {
                        session_id: native.to_owned(),
                        result,
                    },
                    Some(reservation),
                )
                .map_err(|_| DeleteFailure::NotDispatched)?;
            super::wait::reply(receive, Duration::from_secs(30), "session delete")
                .await
                .and_then(|outcome| outcome)
                .map_err(DeleteFailure::Unconfirmed)?;
            Ok(true)
        }
        .await;
        Attempt {
            result: outcome,
            connection_closed: true,
        }
    }
}

async fn prepare_live_delete(connection: &ManagedConnection, native: &str) -> Result<(), ()> {
    let (control, browser) = {
        let sessions = connection.sessions.lock().map_err(|_| ())?;
        let entry = sessions.get(native).ok_or(())?;
        if entry.preview_token.is_some() || connection.state.load(Ordering::SeqCst) != STATE_READY {
            return Err(());
        }
        (entry.control.clone(), entry.browser_requests.owner())
    };
    if let Some(owner) = &browser {
        owner.clone().prepare_close().await.map_err(|_| ())?;
    }
    let sessions = connection.sessions.lock().map_err(|_| ())?;
    let entry = sessions.get(native).ok_or(())?;
    if connection.state.load(Ordering::SeqCst) != STATE_READY
        || entry.preview_token.is_some()
        || !entry.control.same_channel(&control)
        || entry.browser_requests.owner().is_some_and(|current| {
            browser
                .as_ref()
                .is_none_or(|old| !std::sync::Arc::ptr_eq(old, &current))
        })
    {
        return Err(());
    }
    Ok(())
}
