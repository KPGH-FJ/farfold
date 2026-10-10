//! Retained archives live in existing location metadata, independently of the
//! single current operation. Unknown paths never acquire created authority.
use super::*;
use crate::meta_store::worktree_maintenance::MaintenancePermit;
use crate::worktrees::{
    recycle,
    recycle_types::*,
    storage::{RecycleIntent, SavedArchive},
};

pub(super) struct RecycleTicket {
    saved: SavedArchive,
    preview: RecycleInspection,
    created: Instant,
}
pub(super) struct MaintenanceOwner {
    pub(super) id: String,
    pub(super) _store: MaintenancePermit,
    pub(super) _global: UpdatePermit,
    pub(super) _own: UpdatePermit,
}
impl MaintenanceOwner {
    pub(super) fn release(self) -> std::result::Result<(), String> {
        let Self {
            _store,
            _global,
            _own,
            ..
        } = self;
        let result = _store.release();
        drop(_global);
        drop(_own);
        result
    }
}
fn reject_recycle(i: &mut Inner, id: &str, action: RecycleAction, code: &str) -> Reply {
    let mut op = operation(id, "failed", Some(code));
    op.action = action.name().into();
    i.rejected.insert(id.into(), op.clone());
    Reply::Operation(Box::new(op))
}
fn status(
    id: &str,
    state: &str,
    code: Option<&str>,
    saved: &SavedArchive,
    action: RecycleAction,
    active: bool,
) -> Operation {
    let mut op = operation(id, state, code);
    op.action = action.name().into();
    op.maintenance_active = active;
    op.original_path = Some(saved.archive.original_path.clone());
    op.retained_path = Some(saved.archive.retained_path.clone());
    op
}
fn impact(store: &MetaStore, saved: &SavedArchive) -> Result<(DraftBaseline, RecycleImpact)> {
    store
        .worktree_impact(&[
            Path::new(&saved.archive.original_path),
            Path::new(&saved.archive.retained_path),
        ])
        .map_err(|_| error("unknownDrafts"))
}
fn source(saved: &SavedArchive, action: RecycleAction) -> &str {
    if action == RecycleAction::Archive {
        &saved.archive.original_path
    } else {
        &saved.archive.retained_path
    }
}
impl Worktrees {
    pub fn recycle_inspect(
        &self,
        store: &MetaStore,
        action: RecycleAction,
        id: &str,
        revision: u64,
    ) -> Result<RecycleInspection> {
        let _own = self
            .0
            .admission
            .activity()
            .map_err(|_| error("maintenanceBusy"))?;
        let _global = managed_update::activity().map_err(|_| error("maintenanceBusy"))?;
        let token = new_id()?;
        next_revision(revision)?;
        let mut saved = {
            let mut i = self.lock()?;
            i.load(store)?;
            i.idle()?;
            match action {
                RecycleAction::Archive => {
                    if i.doc.archives.len() >= 256 {
                        return Err(error("capacity"));
                    }
                    let location = i
                        .doc
                        .locations
                        .iter()
                        .find(|v| v.location.id == id && v.location.revision == revision)
                        .cloned()
                        .ok_or(error("changed"))?;
                    drop(i);
                    recycle::prepare_record(location, &token, &AtomicBool::new(false))?
                }
                RecycleAction::Restore => i
                    .doc
                    .archives
                    .iter()
                    .find(|v| {
                        v.archive.id == id
                            && v.archive.revision == revision
                            && v.archive.availability == "verified"
                    })
                    .cloned()
                    .ok_or(error("missingArchive"))?,
            }
        };
        if saved.removal_operation.is_some() {
            return Err(error("recheckRequired"));
        }
        recycle::verify_at(
            &saved,
            action == RecycleAction::Restore,
            &AtomicBool::new(false),
        )?;
        let (baseline, impact) = impact(store, &saved)?;
        let preview = RecycleInspection {
            inspection_id: token.clone(),
            action,
            record_id: id.into(),
            revision,
            original_path: saved.archive.original_path.clone(),
            retained_path: saved.archive.retained_path.clone(),
            repository_root: saved.archive.repository_root.clone(),
            head_oid: saved.archive.head_oid.clone(),
            branch: saved.archive.branch.clone(),
            blockers: if impact.unsent {
                vec!["unsentWork".into()]
            } else {
                vec![]
            },
            impact,
            material: saved.material.clone(),
            draft_baseline: baseline,
        };
        saved.archive.availability = "unknown".into();
        let mut i = self.lock()?;
        i.idle()?;
        i.recycle_tickets
            .retain(|_, t| t.created.elapsed() < Duration::from_secs(600));
        if i.recycle_tickets.len() >= 32 {
            return Err(error("capacity"));
        }
        i.recycle_tickets.insert(
            token,
            RecycleTicket {
                saved,
                preview: preview.clone(),
                created: Instant::now(),
            },
        );
        Ok(preview)
    }
    pub(crate) fn prepare_recycle(
        &self,
        store: &MetaStore,
        id: &str,
        input: RecycleInput,
        retire: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<Reply> {
        let ticket = {
            let mut i = self.lock()?;
            let request = Request::Recycle(input.clone());
            if let Err(e) = i.load(store) {
                if i.requests.get(id).is_some_and(|r| r != &request) {
                    return Err(error("operationConflict"));
                }
                i.reserve(id)?;
                i.requests.insert(id.into(), request);
                return Ok(reject_recycle(&mut i, id, input.action, e.code));
            }
            if i.seen.contains(id) {
                if !i.requests.contains_key(id)
                    && i.rejected.get(id).is_some_and(|o| o.state == "cancelled")
                {
                    i.requests.insert(id.into(), request.clone());
                    i.rejected.get_mut(id).unwrap().action = input.action.name().into();
                }
                if i.requests.get(id).is_some_and(|r| r != &request) {
                    return Err(error("operationConflict"));
                }
                return Ok(i.reply(id));
            }
            i.reserve(id)?;
            i.requests.insert(id.into(), request);
            let rejected = |i: &mut Inner, code| {
                let mut op = operation(id, "failed", Some(code));
                op.action = input.action.name().into();
                i.rejected.insert(id.into(), op.clone());
                Reply::Operation(Box::new(op))
            };
            if i.idle().is_err() {
                return Ok(rejected(&mut i, "maintenanceBusy"));
            }
            let Some(t) = i.recycle_tickets.remove(&input.inspection_id).filter(|t| {
                t.created.elapsed() < Duration::from_secs(600) && t.preview.action == input.action
            }) else {
                return Ok(rejected(&mut i, "inspectionExpired"));
            };
            if t.preview.draft_baseline != input.expected_draft_baseline
                || !t.preview.blockers.is_empty()
            {
                return Ok(rejected(&mut i, "draftChanged"));
            }
            i.preparing.insert(id.into());
            t
        };
        let gates = (|| {
            let own = self
                .0
                .admission
                .update()
                .map_err(|_| error("maintenanceBusy"))?;
            let global = managed_update::exclusive().map_err(|_| error("maintenanceBusy"))?;
            let seal = store
                .begin_worktree_maintenance(&input.expected_draft_baseline)
                .map_err(|e| {
                    error(if e == "draftChanged" {
                        "draftChanged"
                    } else {
                        "maintenanceBusy"
                    })
                })?;
            let (current, imp) = impact(store, &ticket.saved)?;
            if current != input.expected_draft_baseline
                || imp.conversations != ticket.preview.impact.conversations
            {
                return Err(error("draftChanged"));
            }
            if imp.unsent {
                return Err(error("unsentWork"));
            }
            recycle::verify_at(
                &ticket.saved,
                input.action == RecycleAction::Restore,
                &AtomicBool::new(false),
            )?;
            Ok(MaintenanceOwner {
                id: id.into(),
                _own: own,
                _global: global,
                _store: seal,
            })
        })();
        let mut i = self.lock()?;
        i.preparing.remove(id);
        if i.rejected.contains_key(id) {
            i.rejected.get_mut(id).unwrap().action = input.action.name().into();
            return Ok(i.reply(id));
        }
        let owner = match gates {
            Ok(g) => g,
            Err(e) => {
                let mut op = operation(id, "failed", Some(e.code));
                op.action = input.action.name().into();
                i.rejected.insert(id.into(), op);
                return Ok(i.reply(id));
            }
        };
        if let Err(e) = i.idle() {
            return Ok(reject_recycle(&mut i, id, input.action, e.code));
        }
        let saved = ticket.saved;
        let mut next = i.doc.clone();
        match input.action {
            RecycleAction::Archive => {
                let Some(pos) = next.locations.iter().position(|v| {
                    v.location.id == saved.archive.id
                        && v.location.revision == saved.archive.revision
                }) else {
                    return Ok(reject_recycle(&mut i, id, input.action, "changed"));
                };
                next.locations.remove(pos);
                next.archives.push(saved.clone());
            }
            RecycleAction::Restore => {
                let Some(item) = next.archives.iter_mut().find(|v| {
                    v.archive.id == saved.archive.id && v.archive.revision == saved.archive.revision
                }) else {
                    return Ok(reject_recycle(&mut i, id, input.action, "changed"));
                };
                item.archive.availability = "unknown".into();
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        next.operation = Some(SavedOperation {
            request: Request::Recycle(input.clone()),
            completed: false,
            status: status(id, "prepared", None, &saved, input.action, true),
            intent: None,
            removal: None,
            recovery: None,
            recycle: Some(RecycleIntent {
                saved: saved.clone(),
                action: input.action,
                dispatched: false,
            }),
        });
        i.maintenance = Some(owner);
        i.working = Some((id.into(), cancel.clone()));
        let save = i.save(store, next);
        drop(i);
        // Even if the IPC receiver disappears, this blocking owner retains every
        // gate until exact processes have actually retired and metadata is saved.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            save.and_then(|_| retire(Path::new(source(&saved, input.action))))
        }))
        .unwrap_or_else(|_| Err(error("unknown")));
        let mut i = self.lock()?;
        if result.is_ok() && !cancel.load(Ordering::SeqCst) {
            i.working = None;
            return Ok(i.reply(id));
        }
        let code = result.err().map(|e| e.code).unwrap_or("cancelled");
        drop(i);
        self.finish_recycle(store, id, Err(error(code)), false);
        self.status(store, id)
    }
    pub(super) fn is_recycle(&self, store: &MetaStore, id: &str) -> Result<bool> {
        let mut i = self.lock()?;
        if i.rejected.contains_key(id) {
            return Ok(false);
        }
        if !i.loaded {
            i.load(store)?;
        }
        Ok(i.doc
            .operation
            .as_ref()
            .is_some_and(|o| o.status.operation_id == id && o.recycle.is_some()))
    }
    pub(super) fn start_recycle(&self, store: &MetaStore, id: &str) -> Result<Reply> {
        let mut i = self.lock()?;
        let Some(op) = i
            .doc
            .operation
            .as_ref()
            .filter(|o| o.status.operation_id == id && o.status.state == "prepared")
        else {
            return Ok(i.reply(id));
        };
        if i.working.is_some() {
            return Err(error("maintenanceBusy"));
        }
        if i.maintenance.as_ref().is_none_or(|o| o.id != id) {
            return Err(error("unknown"));
        }
        let intent = op.recycle.clone().ok_or(error("unknown"))?;
        let cancel = Arc::new(AtomicBool::new(false));
        let mut next = i.doc.clone();
        next.operation.as_mut().unwrap().status =
            status(id, "running", None, &intent.saved, intent.action, true);
        if i.save(store, next).is_err() {
            drop(i);
            self.finish_recycle(store, id, Err(error("storageUnknown")), false);
            return self.status(store, id);
        }
        i.working = Some((id.into(), cancel.clone()));
        let manager = self.clone();
        let worker_store = store.clone();
        let key = id.to_owned();
        let spawned = std::thread::Builder::new()
            .name("farfold-worktree-retain".into())
            .spawn(move || {
                let store = worker_store;
                let mut intent = intent;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(error("cancelled"));
                    }
                    recycle::verify_at(
                        &intent.saved,
                        intent.action == RecycleAction::Restore,
                        &cancel,
                    )?;
                    if intent.action == RecycleAction::Archive {
                        recycle::reserve_parent(&mut intent.saved)?;
                    }
                    {
                        let mut i = manager.lock()?;
                        let mut next = i.doc.clone();
                        next.operation.as_mut().ok_or(error("unknown"))?.recycle =
                            Some(intent.clone());
                        if let Some(a) = next
                            .archives
                            .iter_mut()
                            .find(|a| a.archive.id == intent.saved.archive.id)
                        {
                            *a = intent.saved.clone();
                        }
                        i.save(&store, next)?;
                    }
                    if cancel.load(Ordering::SeqCst) {
                        return Err(error("cancelled"));
                    }
                    intent.dispatched = true;
                    {
                        let mut i = manager.lock()?;
                        let mut next = i.doc.clone();
                        next.operation.as_mut().ok_or(error("unknown"))?.recycle =
                            Some(intent.clone());
                        i.save(&store, next)?;
                    }
                    recycle::move_tree(&intent, &cancel)
                }))
                .unwrap_or_else(|_| Err(error("unknown")));
                manager.finish_recycle(&store, &key, result, intent.dispatched);
            });
        if spawned.is_err() {
            drop(i);
            self.finish_recycle(store, id, Err(error("unavailable")), false);
            return self.status(store, id);
        }
        Ok(i.reply(id))
    }
    fn finish_recycle(
        &self,
        store: &MetaStore,
        id: &str,
        result: Result<Snapshot>,
        dispatched: bool,
    ) {
        let Ok(mut i) = self.lock() else {
            return;
        };
        let Some(old) = i
            .doc
            .operation
            .as_ref()
            .filter(|o| o.status.operation_id == id)
            .cloned()
        else {
            return;
        };
        let Some(intent) = old.recycle else {
            return;
        };
        let saved = &intent.saved;
        let requested = i
            .working
            .as_ref()
            .is_some_and(|(_, c)| c.load(Ordering::SeqCst));
        let mut next = i.doc.clone();
        let mut state = "unknown";
        let mut code = result.as_ref().err().map(|e| e.code);
        let mut location = None;
        let mut archive = None;
        if let Ok(s) = result {
            if intent.action == RecycleAction::Archive {
                let mut a = saved.clone();
                a.archive.revision =
                    next_revision(a.archive.revision).unwrap_or(a.archive.revision);
                a.archive.availability = "verified".into();
                if let Some(v) = next
                    .archives
                    .iter_mut()
                    .find(|v| v.archive.id == a.archive.id)
                {
                    *v = a.clone();
                }
                archive = Some(a.archive);
            } else {
                let mut l = saved.original.clone();
                l.location.revision =
                    next_revision(saved.archive.revision).unwrap_or(saved.archive.revision);
                l.location.availability = "verified".into();
                l.identity = Identity::from(&s);
                next.archives.retain(|a| a.archive.id != l.location.id);
                next.locations.push(l.clone());
                location = Some(l.location);
            }
            state = "ready";
            code = None;
        } else if !dispatched
            && !matches!(code, Some("unknown" | "storageUnknown"))
            && recycle::verify_at(
                saved,
                intent.action == RecycleAction::Restore,
                &AtomicBool::new(false),
            )
            .is_ok()
        {
            state = if code == Some("cancelled") {
                "cancelled"
            } else {
                "failed"
            };
            if intent.action == RecycleAction::Archive {
                next.archives.retain(|a| a.archive.id != saved.archive.id);
                next.locations.push(saved.original.clone());
            } else if let Some(a) = next
                .archives
                .iter_mut()
                .find(|a| a.archive.id == saved.archive.id)
            {
                a.archive.availability = "verified".into();
            }
        }
        let op = next.operation.as_mut().unwrap();
        op.completed = state == "ready";
        op.status = status(id, state, code, saved, intent.action, true);
        op.status.cancel_requested = requested;
        op.status.location = location;
        op.status.archive = archive;
        // Final durable result is written while admission and the write seal remain held.
        let saved_result = i.save(store, next.clone());
        i.working = None;
        if saved_result.is_err()
            && let Some(o) = &mut i.doc.operation
        {
            o.status.state = "unknown".into();
            o.status.code = Some("storageUnknown".into());
            o.status.location = None;
            o.status.archive = None;
            o.status.settled = true;
        }
        // Drop write seal before publishing maintenanceActive=false. No Git is in flight.
        if i.maintenance
            .take()
            .is_some_and(|owner| owner.release().is_err())
        {
            // Git has ended, but the store did not confirm releasing its write seal.
            // Retain actual path/material metadata; never report that the move did not happen.
            i.poisoned = true;
            if let Some(o) = &mut i.doc.operation {
                o.status.state = "unknown".into();
                o.status.code = Some("storageUnknown".into());
                o.status.location = None;
                o.status.archive = None;
                o.status.reviewed = false;
            }
        }
        if let Some(o) = &mut i.doc.operation {
            o.status.maintenance_active = false;
            o.status.settled = true;
        }
        // Saved maintenanceActive is only a cold hint: load always derives false.
    }
    pub(super) fn cancel_recycle(&self, store: &MetaStore, id: &str) -> Result<Reply> {
        let mut i = self.lock()?;
        if let Some((key, flag)) = &i.working
            && key == id
        {
            flag.store(true, Ordering::SeqCst);
            let mut next = i.doc.clone();
            if let Some(o) = &mut next.operation {
                o.status.cancel_requested = true;
                o.status.state = "cancelling".into();
            }
            let _ = i.save(store, next);
            return Ok(i.reply(id));
        }
        let prepared = i.doc.operation.as_ref().is_some_and(|o| {
            o.status.operation_id == id
                && o.status.state == "prepared"
                && o.status.maintenance_active
        });
        drop(i);
        if prepared {
            self.finish_recycle(store, id, Err(error("cancelled")), false);
        }
        self.status(store, id)
    }
    pub fn recycle_check(&self, store: &MetaStore, id: &str, revision: u64) -> Result<Listing> {
        let _own = self
            .0
            .admission
            .activity()
            .map_err(|_| error("maintenanceBusy"))?;
        let _global = managed_update::activity().map_err(|_| error("maintenanceBusy"))?;
        let saved = {
            let mut i = self.lock()?;
            i.recover(store)?;
            if i.working.is_some() {
                return Err(error("maintenanceBusy"));
            }
            i.doc
                .archives
                .iter()
                .find(|a| a.archive.id == id && a.archive.revision == revision)
                .cloned()
                .ok_or(error("missingArchive"))?
        };
        if saved.removal_operation.is_some() {
            return self.check_removed_archive(store, &saved);
        }
        let retained = recycle::verify_at(&saved, true, &AtomicBool::new(false));
        let original = if retained.is_err() {
            recycle::verify_at(&saved, false, &AtomicBool::new(false)).ok()
        } else {
            None
        };
        let mut i = self.lock()?;
        let mut next = i.doc.clone();
        let index = next
            .archives
            .iter()
            .position(|a| a.archive.id == id && a.archive.revision == revision)
            .ok_or(error("changed"))?;
        let revision = next_revision(revision)?;
        let mut checked_location = None;
        let mut checked_archive = None;
        if let Some(s) = original {
            let mut l = saved.original.clone();
            l.location.revision = revision;
            l.location.availability = "verified".into();
            l.identity = Identity::from(&s);
            next.archives.remove(index);
            next.locations.push(l.clone());
            checked_location = Some(l.location);
        } else {
            let a = &mut next.archives[index].archive;
            a.revision = revision;
            a.availability = if retained.is_ok() {
                "verified"
            } else {
                "unknown"
            }
            .into();
            checked_archive = Some(a.clone());
        }
        if let Some(op) = &mut next.operation
            && op
                .recycle
                .as_ref()
                .is_some_and(|r| r.saved.archive.id == id)
        {
            op.status.maintenance_active = false;
            op.status.settled = true;
            op.status.reviewed = false;
            let expected = if op.status.action == "archive" {
                checked_archive
                    .as_ref()
                    .is_some_and(|a| a.availability == "verified")
            } else {
                checked_location.is_some()
            };
            op.status.state = if expected { "ready" } else { "unknown" }.into();
            op.status.code = if expected {
                None
            } else {
                Some("recheckRequired".into())
            };
            op.status.location = if expected { checked_location } else { None };
            op.status.archive = if expected { checked_archive } else { None };
        }
        i.save(store, next)?;
        drop(i);
        self.list(store)
    }
    pub(super) fn recheck_recycle(&self, store: &MetaStore, id: &str) -> Result<Reply> {
        let archived = {
            let mut i = self.lock()?;
            i.recover(store)?;
            if i.working.is_some() || i.maintenance.is_some() {
                return Ok(i.reply(id));
            }
            i.doc
                .operation
                .as_ref()
                .filter(|o| o.status.operation_id == id)
                .and_then(|o| o.recycle.as_ref())
                .and_then(|r| {
                    i.doc
                        .archives
                        .iter()
                        .find(|a| a.archive.id == r.saved.archive.id)
                })
                .map(|a| (a.archive.id.clone(), a.archive.revision))
        };
        if let Some((key, revision)) = archived {
            self.recycle_check(store, &key, revision)?;
        }
        self.status(store, id)
    }
}
