use super::*;
use crate::runtime_event_router::RuntimeEventCursor;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub scope: Scope,
    pub farfold_session_id: FarfoldSessionId,
    pub native_thread_id: String,
    pub native_tree_id: String,
    // Capture BEFORE native history. Replaying the shared ring after this cut
    // cannot miss a new Host Turn started after the history operation releases.
    pub before: RuntimeEventCursor,
    pub turns: Vec<HistoryTurn>,
}

impl configure::Runtime {
    pub fn history_operation(
        &self,
        store: &HostStore,
        scope: &Scope,
        id: &FarfoldSessionId,
        router: &RuntimeEventRouter,
    ) -> Result<Snapshot, String> {
        let (handle, original, before) = self.controller.exclusive(|| {
            let handle = self.connection()?;
            let c = handle.lock().map_err(|_| "Connection unavailable")?;
            let original = target(store, &c, scope, id)?;
            if c.turns
                .router
                .as_ref()
                .is_some_and(|r| !r.shares_stream_with(router))
            {
                return Err("History router differs from original event owner".into());
            }
            let before = router.cursor()?;
            drop(c);
            Ok((handle, original, before))
        })?;
        let turns = self.read_turn_history(store, scope, id)?;
        self.controller.exclusive(|| {
            if !Arc::ptr_eq(&self.connection()?, &handle) {
                return Err("Retired history receipt".into());
            }
            let c = handle.lock().map_err(|_| "Connection unavailable")?;
            if c.turns.unknown
                || c.transport.failure().is_some()
                || target(store, &c, scope, id)? != original
            {
                return Err("Original history target changed".into());
            }
            let thread = c
                .threads
                .bound
                .as_ref()
                .ok_or("Original native thread missing")?;
            if turns.iter().map(|t| t.items.len()).sum::<usize>() > 500
                || serde_json::to_vec(&turns)
                    .map_err(|_| "History unavailable")?
                    .len()
                    > 2 * 1024 * 1024
            {
                return Err("History presentation bound exceeded".into());
            }
            Ok(Snapshot {
                scope: scope.clone(),
                farfold_session_id: id.clone(),
                native_thread_id: thread.native_thread_id.clone(),
                native_tree_id: thread.native_session_id.clone(),
                before,
                turns,
            })
        })
    }
}
