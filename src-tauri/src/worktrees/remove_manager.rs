//! Two explicit operations: preparing recovery never grants deletion to ordinary start.
use super::*;
use crate::worktrees::{
    recovery_pack::{self, Manifest},
    removal,
    remove_types::*,
    storage::{RemoveIntent, SavedArchive},
};
pub(super) struct RemoveTicket {
    saved: SavedArchive,
    preview: RemoveInspection,
    plan: Manifest,
    created: Instant,
}
fn reject(i: &mut Inner, id: &str, code: &str) -> Reply {
    let mut op = operation(id, "failed", Some(code));
    op.action = "remove".into();
    op.removal_phase = Some("preparingRecovery".into());
    op.delete_dispatched = Some(false);
    i.rejected.insert(id.into(), op);
    i.reply(id)
}
fn set_status(
    id: &str,
    state: &str,
    phase: &str,
    code: Option<&str>,
    intent: &RemoveIntent,
    active: bool,
) -> Operation {
    let mut op = operation(id, state, code);
    op.action = "remove".into();
    op.maintenance_active = active;
    op.removal_phase = Some(phase.into());
    op.delete_dispatched = Some(intent.dispatched);
    op.original_path = Some(intent.saved.archive.original_path.clone());
    op.retained_path = Some(intent.saved.archive.retained_path.clone());
    op.recovery = intent.recovery.as_ref().map(|r| r.receipt.clone());
    op
}
fn impact(
    s: &MetaStore,
    a: &SavedArchive,
) -> Result<(
    crate::worktrees::DraftBaseline,
    crate::worktrees::RecycleImpact,
)> {
    s.worktree_impact(&[
        Path::new(&a.archive.original_path),
        Path::new(&a.archive.retained_path),
    ])
    .map_err(|_| error("unknownDrafts"))
}
impl Worktrees {
    pub(super) fn is_remove(&self, store: &MetaStore, id: &str) -> Result<bool> {
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
            .is_some_and(|v| v.status.operation_id == id && v.removal.is_some()))
    }
    pub fn remove_inspect(
        &self,
        store: &MetaStore,
        id: &str,
        revision: u64,
    ) -> Result<RemoveInspection> {
        let _own = self
            .0
            .admission
            .activity()
            .map_err(|_| error("maintenanceBusy"))?;
        let _global = managed_update::activity().map_err(|_| error("maintenanceBusy"))?;
        let saved = {
            let mut i = self.lock()?;
            i.load(store)?;
            i.idle()?;
            // A prior dispatched but unresolved deletion cannot regain disposal authority.
            if i.doc.operation.as_ref().is_some_and(|o| {
                o.removal
                    .as_ref()
                    .is_some_and(|r| r.saved.archive.id == id && r.dispatched)
                    && !o.completed
            }) {
                return Err(error("recheckRequired"));
            }
            i.doc
                .archives
                .iter()
                .find(|a| {
                    a.archive.id == id
                        && a.archive.revision == revision
                        && a.archive.availability == "verified"
                })
                .cloned()
                .ok_or(error("missingArchive"))?
        };
        if saved.removal_operation.is_some() {
            return Err(error("recheckRequired"));
        }
        let plan = removal::capture(&saved, &AtomicBool::new(false))?;
        let (baseline, imp) = impact(store, &saved)?;
        let local_tracking = if saved.archive.branch.is_none() {
            "noUpstream"
        } else {
            let root = Path::new(&saved.archive.retained_path);
            match crate::worktrees::git::execute(
                root,
                &["rev-parse", "--verify", "@{upstream}"],
                &AtomicBool::new(false),
                Duration::from_secs(10),
            ) {
                Ok(v) if v.code == Some(0) => "localRecord",
                Ok(_) => "noUpstream",
                Err(_) => "unknown",
            }
        };
        let preview = RemoveInspection {
            inspection_id: new_id()?,
            action: "remove",
            record_id: id.into(),
            revision,
            original_path: saved.archive.original_path.clone(),
            retained_path: saved.archive.retained_path.clone(),
            repository_root: saved.archive.repository_root.clone(),
            head_oid: saved.archive.head_oid.clone(),
            branch: saved.archive.branch.clone(),
            blockers: if imp.unsent {
                vec!["unsentWork".into()]
            } else {
                vec![]
            },
            impact: imp,
            draft_baseline: baseline,
            roots: plan.roots.summary()?,
            content: plan.content.clone(),
            local_tracking: local_tracking.into(),
        };
        let mut i = self.lock()?;
        i.idle()?;
        i.remove_tickets
            .retain(|_, v| v.created.elapsed() < Duration::from_secs(600));
        if i.remove_tickets.len() >= 32 {
            return Err(error("capacity"));
        }
        i.remove_tickets.insert(
            preview.inspection_id.clone(),
            RemoveTicket {
                saved,
                preview: preview.clone(),
                plan,
                created: Instant::now(),
            },
        );
        Ok(preview)
    }
    pub(crate) fn prepare_remove(
        &self,
        store: &MetaStore,
        id: &str,
        input: RemoveInput,
        retire: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<Reply> {
        let ticket = {
            let mut i = self.lock()?;
            let request = Request::Remove(input.clone());
            if let Err(e) = i.load(store) {
                if i.requests.get(id).is_some_and(|v| v != &request) {
                    return Err(error("operationConflict"));
                }
                i.reserve(id)?;
                i.requests.insert(id.into(), request);
                return Ok(reject(&mut i, id, e.code));
            }
            if i.seen.contains(id) {
                if !i.requests.contains_key(id)
                    && i.rejected.get(id).is_some_and(|o| o.state == "cancelled")
                {
                    i.requests.insert(id.into(), request.clone());
                    let o = i.rejected.get_mut(id).unwrap();
                    o.action = "remove".into();
                    o.removal_phase = Some("preparingRecovery".into());
                    o.delete_dispatched = Some(false);
                }
                if i.requests.get(id).is_some_and(|v| v != &request) {
                    return Err(error("operationConflict"));
                }
                return Ok(i.reply(id));
            }
            i.reserve(id)?;
            i.requests.insert(id.into(), request);
            if i.idle().is_err() {
                return Ok(reject(&mut i, id, "maintenanceBusy"));
            }
            if i.doc.recoveries.len() >= 256 || i.doc.materials.len() >= 256 {
                return Ok(reject(&mut i, id, "capacity"));
            }
            let Some(t) = i
                .remove_tickets
                .remove(&input.inspection_id)
                .filter(|t| t.created.elapsed() < Duration::from_secs(600))
            else {
                return Ok(reject(&mut i, id, "inspectionExpired"));
            };
            if t.preview.draft_baseline != input.expected_draft_baseline
                || !t.preview.blockers.is_empty()
            {
                return Ok(reject(&mut i, id, "draftChanged"));
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
            let (baseline, imp) = impact(store, &ticket.saved)?;
            if baseline != input.expected_draft_baseline
                || imp.conversations != ticket.preview.impact.conversations
            {
                return Err(error("draftChanged"));
            }
            if imp.unsent {
                return Err(error("unsentWork"));
            }
            if removal::capture(&ticket.saved, &AtomicBool::new(false))? != ticket.plan {
                return Err(error("recoveryChanged"));
            }
            Ok(MaintenanceOwner {
                id: id.into(),
                _store: seal,
                _global: global,
                _own: own,
            })
        })();
        let mut i = self.lock()?;
        i.preparing.remove(id);
        if i.rejected.contains_key(id) {
            let o = i.rejected.get_mut(id).unwrap();
            o.action = "remove".into();
            o.removal_phase = Some("preparingRecovery".into());
            o.delete_dispatched = Some(false);
            return Ok(i.reply(id));
        }
        let owner = match gates {
            Ok(v) => v,
            Err(e) => return Ok(reject(&mut i, id, e.code)),
        };
        if i.idle().is_err() {
            return Ok(reject(&mut i, id, "maintenanceBusy"));
        }
        if !i.doc.archives.iter().any(|a| {
            a.archive.id == ticket.saved.archive.id
                && a.archive.revision == ticket.saved.archive.revision
        }) {
            return Ok(reject(&mut i, id, "changed"));
        }
        let recovery_id = new_id()?;
        let recovery_path = format!("{}/.farfold-recovery-{recovery_id}", ticket.saved.parent);
        let intent = RemoveIntent {
            saved: ticket.saved,
            roots: ticket.plan.roots.summary()?,
            content: ticket.plan.content.clone(),
            profile_sha256: removal::profile(&ticket.plan)?,
            recovery_id,
            recovery_path,
            recovery: None,
            dispatched: false,
            confirmation: None,
        };
        let mut next = i.doc.clone();
        next.operation = Some(SavedOperation {
            request: Request::Remove(input),
            completed: false,
            status: set_status(id, "running", "preparingRecovery", None, &intent, true),
            intent: None,
            recycle: None,
            removal: Some(intent.clone()),
            recovery: None,
        });
        next.materials.push(Material {
            operation_id: id.into(),
            path: intent.recovery_path.clone(),
            repository_root: intent.saved.archive.repository_root.clone(),
        });
        let cancel = Arc::new(AtomicBool::new(false));
        i.maintenance = Some(owner);
        i.working = Some((id.into(), cancel.clone()));
        let saved = i.save(store, next);
        drop(i);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            saved.and_then(|_| retire(Path::new(&intent.saved.archive.retained_path)))
        }))
        .unwrap_or_else(|_| Err(error("unknown")));
        if let Err(e) = result {
            self.finish_remove(store, id, Err(e));
            return self.status(store, id);
        }
        let manager = self.clone();
        let store_copy = store.clone();
        let key = id.to_owned();
        let plan = ticket.plan;
        if std::thread::Builder::new()
            .name("farfold-recovery-prepare".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    manager.build_recovery(&store_copy, &key, intent, plan, &cancel)
                }))
                .unwrap_or_else(|_| Err(error("unknown")));
                if let Err(e) = result {
                    manager.finish_remove(&store_copy, &key, Err(e));
                }
            })
            .is_err()
        {
            self.finish_remove(store, id, Err(error("unavailable")));
        }
        self.status(store, id)
    }
    fn build_recovery(
        &self,
        store: &MetaStore,
        id: &str,
        mut intent: RemoveIntent,
        plan: Manifest,
        cancel: &AtomicBool,
    ) -> Result<()> {
        if cancel.load(Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        if removal::capture(&intent.saved, cancel)? != plan {
            return Err(error("recoveryChanged"));
        }
        let reserved_stamp = removal::reserve(&intent)?;
        let r = recovery_pack::build(
            id,
            &intent.saved,
            &plan,
            &intent.recovery_id,
            Path::new(&intent.recovery_path),
            &reserved_stamp,
            cancel,
        )?;
        intent.recovery = Some(r.clone());
        // The complete artifact remains findable even if source verification subsequently fails.
        {
            let mut i = self.lock()?;
            let mut n = i.doc.clone();
            n.recoveries.push(r);
            let o = n.operation.as_mut().ok_or(error("unknown"))?;
            o.removal = Some(intent.clone());
            o.status = set_status(id, "running", "verifyingRecovery", None, &intent, true);
            i.save(store, n)?;
        }
        if removal::capture(&intent.saved, cancel)? != plan {
            return Err(error("recoveryChanged"));
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        let mut i = self.lock()?;
        let mut n = i.doc.clone();
        let o = n.operation.as_mut().ok_or(error("unknown"))?;
        if o.status.operation_id != id {
            return Err(error("unknown"));
        }
        o.status = set_status(id, "prepared", "awaitingConfirmation", None, &intent, true);
        n.materials.retain(|m| m.operation_id != id);
        i.save(store, n)?;
        i.working = None;
        Ok(())
    }
    pub fn confirm_remove(
        &self,
        store: &MetaStore,
        id: &str,
        confirmation: RemoveConfirmation,
    ) -> Result<Reply> {
        let mut i = self.lock()?;
        if !i.loaded {
            i.load(store)?;
        }
        let Some(old) = i
            .doc
            .operation
            .as_ref()
            .filter(|o| o.status.operation_id == id && o.removal.is_some())
            .cloned()
        else {
            return Ok(i.reply(id));
        };
        let mut intent = old.removal.unwrap();
        if let Some(c) = &intent.confirmation {
            if c != &confirmation {
                return Err(error("operationConflict"));
            }
            return Ok(i.reply(id));
        }
        let r = intent
            .recovery
            .as_ref()
            .ok_or(error("confirmationRequired"))?;
        if old.status.state != "prepared"
            || old.status.removal_phase.as_deref() != Some("awaitingConfirmation")
            || !old.status.maintenance_active
            || i.working.is_some()
            || i.maintenance.as_ref().is_none_or(|m| m.id != id)
            || intent.dispatched
        {
            return Err(error("confirmationRequired"));
        }
        if confirmation.record_id != intent.saved.archive.id
            || confirmation.expected_revision != intent.saved.archive.revision
            || confirmation.recovery_id != r.receipt.id
            || confirmation.recovery_sha256 != r.receipt.bundle_sha256
            || confirmation.manifest_sha256 != r.receipt.manifest_sha256
        {
            return Err(error("operationConflict"));
        }
        intent.confirmation = Some(confirmation);
        let mut n = i.doc.clone();
        let o = n.operation.as_mut().unwrap();
        o.removal = Some(intent.clone());
        o.status = set_status(id, "running", "verifyingRecovery", None, &intent, true);
        if i.save(store, n).is_err() {
            drop(i);
            self.finish_remove(store, id, Err(error("storageUnknown")));
            return self.status(store, id);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        i.working = Some((id.into(), cancel.clone()));
        drop(i);
        let manager = self.clone();
        let s = store.clone();
        let key = id.to_owned();
        if std::thread::Builder::new()
            .name("farfold-worktree-remove".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let p = removal::capture(&intent.saved, &cancel)?;
                    removal::same_plan(&intent, &p)?;
                    recovery_pack::verify(
                        intent.recovery.as_ref().ok_or(error("recoveryInvalid"))?,
                        &cancel,
                    )?;
                    if cancel.load(Ordering::SeqCst) {
                        return Err(error("cancelled"));
                    }
                    removal::delete(&intent, &cancel, || {
                        let mut dispatched = intent.clone();
                        dispatched.dispatched = true;
                        let mut i = manager.lock()?;
                        let mut n = i.doc.clone();
                        let o = n.operation.as_mut().unwrap();
                        o.removal = Some(dispatched.clone());
                        o.status = set_status(&key, "running", "deleting", None, &dispatched, true);
                        let archive = n
                            .archives
                            .iter_mut()
                            .find(|a| {
                                a.archive.id == intent.saved.archive.id
                                    && a.archive.revision == intent.saved.archive.revision
                            })
                            .ok_or(error("changed"))?;
                        archive.removal_operation = Some(key.clone());
                        archive.archive.availability = "unknown".into();
                        i.save(&s, n)
                    })
                }))
                .unwrap_or_else(|_| Err(error("unknown")));
                manager.finish_remove(&s, &key, result);
            })
            .is_err()
        {
            self.finish_remove(store, id, Err(error("unavailable")));
        }
        self.status(store, id)
    }
    fn finish_remove(&self, store: &MetaStore, id: &str, result: Result<()>) {
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
        let Some(intent) = old.removal else {
            return;
        };
        let mut n = i.doc.clone();
        let phase = old
            .status
            .removal_phase
            .as_deref()
            .unwrap_or("preparingRecovery");
        let (state, code) = if let Err(e) = &result {
            let code = e.code;
            (
                if !intent.dispatched && !matches!(code, "unknown" | "storageUnknown") {
                    if code == "cancelled" {
                        "cancelled"
                    } else {
                        "failed"
                    }
                } else {
                    "unknown"
                },
                Some(code),
            )
        } else {
            ("ready", None)
        };
        let mut op = set_status(
            id,
            state,
            if state == "ready" { "finished" } else { phase },
            code,
            &intent,
            true,
        );
        op.cancel_requested = old.status.cancel_requested
            || i.working
                .as_ref()
                .is_some_and(|(_, c)| c.load(Ordering::SeqCst));
        if state == "ready" {
            n.archives
                .retain(|a| a.archive.id != intent.saved.archive.id);
            op.removed = Some(Removed {
                record_id: intent.saved.archive.id.clone(),
                revision: next_revision(intent.saved.archive.revision)
                    .unwrap_or(intent.saved.archive.revision),
                original_path: intent.saved.archive.original_path.clone(),
                retained_path: intent.saved.archive.retained_path.clone(),
                recovery_id: intent.recovery_id.clone(),
            });
        }
        let o = n.operation.as_mut().unwrap();
        o.status = op;
        o.completed = state == "ready";
        let save = i.save(store, n);
        i.working = None;
        let release = i.maintenance.take().map(|m| m.release()).unwrap_or(Ok(()));
        if save.is_err() || release.is_err() {
            i.poisoned = true;
            if let Some(o) = &mut i.doc.operation {
                o.status.state = "unknown".into();
                o.status.code = Some("storageUnknown".into());
                o.status.removed = None;
                o.status.reviewed = false;
            }
        }
        if let Some(o) = &mut i.doc.operation {
            o.status.maintenance_active = false;
            o.status.settled = true;
        }
    }
    pub(super) fn cancel_remove(&self, store: &MetaStore, id: &str) -> Result<Reply> {
        let mut i = self.lock()?;
        if let Some((key, c)) = &i.working
            && key == id
        {
            c.store(true, Ordering::SeqCst);
            let mut n = i.doc.clone();
            if let Some(o) = &mut n.operation {
                o.status.state = "cancelling".into();
                o.status.cancel_requested = true;
            }
            let _ = i.save(store, n);
            return Ok(i.reply(id));
        }
        let prepared = i.doc.operation.as_ref().is_some_and(|o| {
            o.status.operation_id == id
                && o.status.state == "prepared"
                && o.status.maintenance_active
        });
        drop(i);
        if prepared {
            self.finish_remove(store, id, Err(error("cancelled")));
        }
        self.status(store, id)
    }
    pub(super) fn recheck_remove(&self, store: &MetaStore, id: &str) -> Result<Reply> {
        self.recheck_remove_with(store, id, |intent| {
            removal::verify_deleted(intent, &AtomicBool::new(false))
        })
    }
    pub(super) fn recheck_remove_with(
        &self,
        store: &MetaStore,
        id: &str,
        verify: impl FnOnce(&RemoveIntent) -> Result<()>,
    ) -> Result<Reply> {
        let _own = self
            .0
            .admission
            .activity()
            .map_err(|_| error("maintenanceBusy"))?;
        let _global = managed_update::activity().map_err(|_| error("maintenanceBusy"))?;
        let mut i = self.lock()?;
        i.recover(store)?;
        if i.working.is_some() || i.maintenance.is_some() {
            return Ok(i.reply(id));
        }
        let Some(old) = i
            .doc
            .operation
            .as_ref()
            .filter(|o| o.status.operation_id == id)
            .cloned()
        else {
            return Ok(i.reply(id));
        };
        let Some(mut intent) = old.removal.clone().filter(|r| r.dispatched) else {
            return Ok(i.reply(id));
        };
        let recorded = intent.recovery.as_ref().ok_or(error("recoveryInvalid"))?;
        let current = i
            .doc
            .recoveries
            .iter()
            .find(|r| r.receipt.id == recorded.receipt.id)
            .cloned()
            .ok_or(error("missingRecovery"))?;
        // Availability and revision are observations. Every identity and proof field must
        // still name the original immutable recovery, even after an independent recheck.
        let mut identity = current.clone();
        identity.receipt.revision = recorded.receipt.revision;
        identity.receipt.availability = recorded.receipt.availability.clone();
        if current.receipt.revision < recorded.receipt.revision || identity != *recorded {
            return Err(error("changed"));
        }
        intent.recovery = Some(current.clone());
        drop(i);
        // verify_deleted includes the full bundle/manifest and actual independent recovery
        // checks. A past ready receipt or the absence of the removed directory is not proof.
        let checked = verify(&intent);
        let mut i = self.lock()?;
        if i.working.is_some() || i.maintenance.is_some() || !i.preparing.is_empty() {
            return Err(error("changed"));
        }
        let unchanged = i.doc.operation.as_ref().is_some_and(|o| {
            o.status == old.status
                && o.completed == old.completed
                && o.request == old.request
                && o.removal == old.removal
        });
        let index = i
            .doc
            .recoveries
            .iter()
            .position(|r| *r == current)
            .filter(|_| unchanged)
            .ok_or(error("changed"))?;
        let mut verified = current;
        verified.receipt.revision = next_revision(verified.receipt.revision)?;
        verified.receipt.availability = if checked.is_ok() {
            "verified"
        } else {
            "unknown"
        }
        .into();
        intent.recovery = Some(verified.clone());
        let mut n = i.doc.clone();
        n.recoveries[index] = verified;
        let mut status = set_status(
            id,
            if checked.is_ok() { "ready" } else { "unknown" },
            old.status
                .removal_phase
                .as_deref()
                .unwrap_or("checkingOutcome"),
            checked.as_ref().err().map(|e| e.code),
            &intent,
            false,
        );
        status.cancel_requested = old.status.cancel_requested;
        if checked.is_ok() {
            status.removal_phase = Some("finished".into());
            status.removed = Some(Removed {
                record_id: intent.saved.archive.id.clone(),
                revision: next_revision(intent.saved.archive.revision)?,
                original_path: intent.saved.archive.original_path.clone(),
                retained_path: intent.saved.archive.retained_path.clone(),
                recovery_id: intent.recovery_id.clone(),
            });
            n.archives
                .retain(|a| a.archive.id != intent.saved.archive.id);
        }
        let o = n.operation.as_mut().unwrap();
        o.removal = Some(intent);
        o.status = status;
        o.completed = checked.is_ok();
        // The catalogue, durable intent and returned receipt are one CAS publication.
        i.save(store, n)?;
        Ok(i.reply(id))
    }
    pub fn recovery_check(&self, store: &MetaStore, id: &str, revision: u64) -> Result<Listing> {
        let _own = self
            .0
            .admission
            .activity()
            .map_err(|_| error("maintenanceBusy"))?;
        let _global = managed_update::activity().map_err(|_| error("maintenanceBusy"))?;
        let saved = {
            let mut i = self.lock()?;
            i.recover(store)?;
            if i.working.is_some() || i.maintenance.is_some() {
                return Err(error("maintenanceBusy"));
            }
            i.doc
                .recoveries
                .iter()
                .find(|r| r.receipt.id == id && r.receipt.revision == revision)
                .cloned()
                .ok_or(error("missingRecovery"))?
        };
        let checked = recovery_pack::verify(&saved, &AtomicBool::new(false));
        let mut i = self.lock()?;
        let mut n = i.doc.clone();
        let r = n
            .recoveries
            .iter_mut()
            .find(|r| r.receipt.id == id && r.receipt.revision == revision)
            .ok_or(error("changed"))?;
        r.receipt.revision = next_revision(revision)?;
        r.receipt.availability = if checked.is_ok() {
            "verified"
        } else if std::fs::symlink_metadata(&saved.receipt.path)
            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            "missing"
        } else {
            "changed"
        }
        .into();
        i.save(store, n)?;
        drop(i);
        self.list(store)
    }
}
