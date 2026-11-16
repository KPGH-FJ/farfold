//! Keep official deletion on the exact connection selected before close.
use super::{
    manager::{AcpManager, ManagedConnection, ManagerCommand, STATE_READY},
    mutation::DeleteFailure,
    pump::SessionControl,
};
use crate::meta_store::MetaStore;
use std::{path::Path, sync::atomic::Ordering, time::Duration};
use tokio::sync::{mpsc, oneshot};

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
        store: &MetaStore,
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
        let Ok(control) = prepare_live_delete(&connection, native).await else {
            return Attempt::refused();
        };
        if deletes && !closes {
            let result = async {
                let (result, receive) = oneshot::channel();
                control
                    .send(SessionControl::Delete {
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
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let admission = if closes {
            let (result, receive) = oneshot::channel();
            if control
                .send(SessionControl::DeleteClose { deadline, result })
                .is_err()
            {
                return Attempt::refused();
            }
            super::wait::reply(receive, Duration::from_secs(15), "session close").await
        } else {
            let (result, receive) = oneshot::channel();
            if control
                .send(SessionControl::DeleteDetach { deadline, result })
                .is_err()
            {
                return Attempt::refused();
            }
            super::wait::reply(receive, Duration::from_secs(15), "session close")
                .await
                .map(|outcome| outcome.map(|()| true))
        };
        match admission {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => {
                return Attempt {
                    result: Err(DeleteFailure::NotDispatched),
                    connection_closed: true,
                };
            }
            _ => return Attempt::refused(),
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
                        row_id: MetaStore::dismissed_id(agent, &cwd.to_string_lossy(), native),
                        store: store.clone(),
                        result,
                    },
                    Some(reservation),
                )
                .map_err(|_| DeleteFailure::NotDispatched)?;
            let deleted = super::wait::reply(receive, Duration::from_secs(30), "session delete")
                .await
                .and_then(|outcome| outcome)
                .map_err(DeleteFailure::Unconfirmed)?;
            if deleted {
                Ok(true)
            } else {
                Err(DeleteFailure::NotDispatched)
            }
        }
        .await;
        Attempt {
            result: outcome,
            connection_closed: true,
        }
    }
}

async fn prepare_live_delete(
    connection: &ManagedConnection,
    native: &str,
) -> Result<mpsc::UnboundedSender<SessionControl>, ()> {
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
    Ok(control)
}
