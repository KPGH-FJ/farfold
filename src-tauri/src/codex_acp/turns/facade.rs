//! Closed command contract; all native targets come from shared Host authority.
use super::*;
use crate::acp_runtime::AcpEventConnection;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommandInput {
    Send {
        farfold_session_id: FarfoldSessionId,
        text: String,
    },
    Interrupt {
        farfold_session_id: FarfoldSessionId,
        host_turn_id: HostTurnId,
        native_turn_id: String,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Started,
    InterruptAccepted,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub scope: Scope,
    pub farfold_session_id: FarfoldSessionId,
    pub host_turn_id: HostTurnId,
    pub native_turn_id: String,
    pub outcome: Outcome,
}

impl configure::Runtime {
    pub fn turn_operation(
        &self,
        store: &HostStore,
        scope: &Scope,
        command: CommandInput,
        coordinator: &TurnCoordinator,
        router: &RuntimeEventRouter,
    ) -> Result<Snapshot, String> {
        scope.validate()?;
        let (context, native_turn_id, outcome) = match command {
            CommandInput::Send {
                farfold_session_id,
                text,
            } => {
                if text.trim().is_empty() || text.len() > 65536 {
                    return Err("Turn text empty or too large".into());
                }
                self.ensure_turn_event_pump(store, scope, &farfold_session_id, router)?;
                let (context, native) = self.start_turn_receipt(
                    store,
                    scope,
                    &farfold_session_id,
                    coordinator,
                    router,
                    &text,
                )?;
                (context, native, Outcome::Started)
            }
            CommandInput::Interrupt {
                farfold_session_id,
                host_turn_id,
                native_turn_id,
            } => {
                if !threads::native_id(&native_turn_id) {
                    return Err("Invalid native Turn reference".into());
                }
                let (context, native) = self.turn_context(scope)?;
                if context.farfold_session_id != farfold_session_id
                    || context.host_turn_id != host_turn_id
                    || native != native_turn_id
                {
                    return Err("Stop does not reference the original active Turn".into());
                }
                self.interrupt_turn(store, scope, &context, &native)?;
                (context, native, Outcome::InterruptAccepted)
            }
        };
        Ok(Snapshot {
            scope: scope.clone(),
            farfold_session_id: context.farfold_session_id,
            host_turn_id: context.host_turn_id,
            native_turn_id,
            outcome,
        })
    }

    fn ensure_turn_event_pump(
        &self,
        store: &HostStore,
        scope: &Scope,
        id: &FarfoldSessionId,
        router: &RuntimeEventRouter,
    ) -> Result<(), String> {
        self.controller.exclusive(|| {
            let handle = self.connection()?;
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            target(store, &c, scope, id)?;
            if c.turns.unknown
                || c.control.operations.is_pending()
                || c.transport.has_unresolved_work()?
            {
                return Err("Unsettled operation blocks Turn dispatch".into());
            }
            if let Some(stop) = &c.turns.event_pump_stop {
                if stop.load(Ordering::Acquire)
                    || c.turns
                        .router
                        .as_ref()
                        .is_none_or(|r| !r.shares_stream_with(router))
                {
                    return Err("Original event consumer unavailable".into());
                }
                return Ok(()); // Same connection retains its one original consumer.
            }
            router.activate_connection(scope.binding()?, scope.generation)?;
            let stop = Arc::new(AtomicBool::new(false));
            c.turns.router = Some(router.clone());
            c.turns.event_pump_stop = Some(stop.clone());
            if crate::acp_runtime::start_event_pump(handle.clone(), router.clone(), stop.clone())
                .is_err()
            {
                stop.store(true, Ordering::Release);
                c.turns.mark_unknown()?;
                return Err("Host event consumer unavailable".into());
            }
            Ok(())
        })
    }
}

impl AcpEventConnection for Connection {
    fn transport(&self) -> Arc<crate::acp_transport::AcpTransport> {
        self.transport.clone()
    }
    fn can_consume_events(&self) -> bool {
        // A command's verified receipt owns the identity needed to validate its
        // queued events. Failure must still be observed while a receipt is pending.
        self.transport.failure().is_some()
            || match &self.turns.active {
                Some(active) => active.native_id.is_some(),
                None => !self.control.operations.is_pending(),
            }
    }
    fn update_events(&mut self, _: &RuntimeEventRouter) -> Result<(), String> {
        self.consume_turn_events().map(|_| ())
    }
    fn record_event_error(&mut self, _: String) {
        if let Some(stop) = &self.turns.event_pump_stop {
            stop.store(true, Ordering::Release);
        }
        let _ = self.turns.mark_unknown();
    }
}
