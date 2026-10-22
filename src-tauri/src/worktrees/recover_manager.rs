use super::*;
use crate::worktrees::{RecoverInput, recover, recovery_pack, storage::RecoverIntent};
fn status(id: &str, state: &str, code: Option<&str>, intent: &RecoverIntent) -> Operation {
    let mut o = operation(id, state, code);
    o.action = "recover".into();
    o.target_path = Some(intent.target.clone());
    o.recovery = Some(intent.recovery.receipt.clone());
    o
}
fn reject(i: &mut Inner, id: &str, code: &str) -> Reply {
    let mut o = operation(id, "failed", Some(code));
    o.action = "recover".into();
    i.rejected.insert(id.into(), o);
    i.reply(id)
}
impl Worktrees {
    pub(super) fn is_recover(&self, s: &MetaStore, id: &str) -> Result<bool> {
        let mut i = self.lock()?;
        if i.rejected.contains_key(id) {
            return Ok(false);
        }
        if !i.loaded {
            i.load(s)?;
        }
        Ok(i.doc
            .operation
            .as_ref()
            .is_some_and(|o| o.status.operation_id == id && o.recovery.is_some()))
    }
    pub fn prepare_recover(&self, s: &MetaStore, id: &str, input: RecoverInput) -> Result<Reply> {
        self.prepare_recover_checked(s, id, input, |input, recovery| {
            recover::prepare(&self.0.material, input, recovery)
        })
    }
    pub(in crate::worktrees) fn prepare_recover_checked(
        &self,
        s: &MetaStore,
        id: &str,
        input: RecoverInput,
        validate: impl FnOnce(RecoverInput, recovery_pack::SavedRecovery) -> Result<RecoverIntent>,
    ) -> Result<Reply> {
        recover::supported()?;
        let source = {
            let mut i = self.lock()?;
            let request = Request::Recover(input.clone());
            if let Err(e) = i.load(s) {
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
                    i.rejected.get_mut(id).unwrap().action = "recover".into();
                }
                if i.requests.get(id).is_some_and(|r| r != &request) {
                    return Err(error("operationConflict"));
                }
                return Ok(i.reply(id));
            }
            i.reserve(id)?;
            i.requests.insert(id.into(), request);
            if let Err(e) = i.idle() {
                return Ok(reject(&mut i, id, e.code));
            }
            if i.doc.locations.len() >= 256 || i.doc.materials.len() >= 256 {
                return Ok(reject(&mut i, id, "capacity"));
            }
            let Some(r) = i
                .doc
                .recoveries
                .iter()
                .find(|r| {
                    r.receipt.id == input.recovery_id
                        && r.receipt.revision == input.expected_revision
                        && r.receipt.availability == "verified"
                })
                .cloned()
            else {
                return Ok(reject(&mut i, id, "missingRecovery"));
            };
            i.preparing.insert(id.into());
            r
        };
        let checked: Result<_> = (|| {
            let _own = self.0.admission.activity().map_err(|_| error("busy"))?;
            let _global = managed_update::activity().map_err(|_| error("busy"))?;
            let intent = validate(input.clone(), source)?;
            Ok((_own, _global, intent))
        })();
        let mut i = self.lock()?;
        i.preparing.remove(id);
        if i.rejected.contains_key(id) {
            return Ok(i.reply(id));
        }
        if let Err(e) = i.idle() {
            return Ok(reject(&mut i, id, e.code));
        }
        let (_own, _global, intent) = match checked {
            Ok(v) => v,
            Err(e) => return Ok(reject(&mut i, id, e.code)),
        };
        if !i
            .doc
            .recoveries
            .iter()
            .any(|r| r.receipt == intent.recovery.receipt)
        {
            return Ok(reject(&mut i, id, "changed"));
        }
        let mut n = i.doc.clone();
        n.operation = Some(SavedOperation {
            request: Request::Recover(input),
            completed: false,
            status: status(id, "prepared", None, &intent),
            intent: None,
            recycle: None,
            removal: None,
            recovery: Some(intent),
        });
        i.save(s, n)?;
        Ok(i.reply(id))
    }
    pub(super) fn start_recover(&self, s: &MetaStore, id: &str) -> Result<Reply> {
        recover::supported()?;
        let own = self.0.admission.activity().map_err(|_| error("busy"))?;
        let global = managed_update::activity().map_err(|_| error("busy"))?;
        let mut i = self.lock()?;
        i.load(s)?;
        let Some(o) = i
            .doc
            .operation
            .as_ref()
            .filter(|o| o.status.operation_id == id && o.status.state == "prepared")
            .cloned()
        else {
            return Ok(i.reply(id));
        };
        let intent = o.recovery.ok_or(error("unknown"))?;
        if i.working.is_some() {
            return Err(error("busy"));
        }
        let mut n = i.doc.clone();
        n.operation.as_mut().unwrap().status = status(id, "running", None, &intent);
        n.materials.push(Material {
            operation_id: id.into(),
            path: intent.target.clone(),
            repository_root: intent.target.clone(),
        });
        i.save(s, n)?;
        let cancel = Arc::new(AtomicBool::new(false));
        i.working = Some((id.into(), cancel.clone()));
        let manager = self.clone();
        let store = s.clone();
        let key = id.to_owned();
        drop(i);
        if std::thread::Builder::new()
            .name("farfold-worktree-recover".into())
            .spawn(move || {
                let _own = own;
                let _global = global;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    manager.run_recover(&store, &key, intent, &cancel)
                }))
                .unwrap_or_else(|_| Err(error("unknown")));
                manager.finish_recover(&store, &key, result);
            })
            .is_err()
        {
            self.finish_recover(s, id, Err(error("unavailable")));
        }
        self.status(s, id)
    }
    fn run_recover(
        &self,
        s: &MetaStore,
        id: &str,
        mut intent: RecoverIntent,
        cancel: &AtomicBool,
    ) -> Result<Snapshot> {
        if cancel.load(Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        recover::revalidate(&self.0.material, &intent)?;
        let manifest = recovery_pack::verify(&self.0.material, &intent.recovery, cancel)?;
        if cancel.load(Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        inspect::same(&intent.parent, &intent.parent_stamp)?;
        #[cfg(unix)]
        std::fs::create_dir(&intent.target).map_err(|e| {
            error(if e.kind() == std::io::ErrorKind::AlreadyExists {
                "targetExists"
            } else {
                "unavailable"
            })
        })?;
        #[cfg(unix)]
        {
            intent.target_stamp = Some(inspect::stamp(Path::new(&intent.target))?);
        }
        // The exact created leaf is saved before Git can initialize or write its contents.
        intent.dispatched = true;
        {
            let mut i = self.lock()?;
            let mut n = i.doc.clone();
            let o = n
                .operation
                .as_mut()
                .filter(|o| o.status.operation_id == id)
                .ok_or(error("unknown"))?;
            o.recovery = Some(intent.clone());
            i.save(s, n)?;
        }
        #[cfg(unix)]
        recovery_pack::recover_reserved(
            &Path::new(&intent.recovery.receipt.path).join("recovery.bundle"),
            &manifest,
            Path::new(&intent.target),
            intent.target_stamp.as_ref().ok_or(error("unknown"))?,
            cancel,
        )?;
        #[cfg(windows)]
        {
            intent.target_stamp = Some(recovery_pack::material::restore_target(
                &self.0.material,
                &intent,
                &manifest,
                cancel,
            )?);
            let mut inner = self.lock()?;
            let mut doc = inner.doc.clone();
            let operation = doc
                .operation
                .as_mut()
                .filter(|o| o.status.operation_id == id)
                .ok_or(error("unknown"))?;
            operation.recovery = Some(intent.clone());
            inner.save(s, doc)?;
        }
        recover::verify(&self.0.material, &intent, &AtomicBool::new(false))
    }
    fn finish_recover(&self, s: &MetaStore, id: &str, result: Result<Snapshot>) {
        let Ok(mut i) = self.lock() else { return };
        let Some(old) = i
            .doc
            .operation
            .as_ref()
            .filter(|o| o.status.operation_id == id)
            .cloned()
        else {
            return;
        };
        let Some(intent) = old.recovery else { return };
        let requested = old.status.cancel_requested
            || i.working
                .as_ref()
                .is_some_and(|(_, c)| c.load(Ordering::SeqCst));
        let mut n = i.doc.clone();
        let mut op = match result {
            Ok(snapshot) => {
                let previous = n.locations.iter().find(|v| v.location.id == id);
                let revision = previous.map(|v| v.location.revision).unwrap_or(0);
                let l = Location {
                    id: id.into(),
                    revision,
                    path: snapshot.root.clone(),
                    repository_root: snapshot.repository_root().into(),
                    branch: snapshot.branch.clone(),
                    head_oid: snapshot.head.clone().unwrap_or_default(),
                    ownership: "existing".into(),
                    availability: "verified".into(),
                };
                if !n.locations.iter().any(|v| v.location.id == id) {
                    n.locations.push(SavedLocation {
                        location: l.clone(),
                        identity: Identity::from(&snapshot),
                    });
                }
                n.materials.retain(|m| m.operation_id != id);
                let mut op = status(id, "ready", None, &intent);
                op.location = Some(l);
                op
            }
            Err(e) => {
                let material = intent.target_stamp.is_some()
                    || intent.dispatched
                    || std::fs::symlink_metadata(&intent.target).is_ok();
                if !material {
                    n.materials.retain(|m| m.operation_id != id);
                }
                status(
                    id,
                    if material || matches!(e.code, "unknown" | "storageUnknown") {
                        "unknown"
                    } else if e.code == "cancelled" {
                        "cancelled"
                    } else {
                        "failed"
                    },
                    Some(e.code),
                    &intent,
                )
            }
        };
        op.cancel_requested = requested;
        let o = n.operation.as_mut().unwrap();
        o.completed = op.state == "ready";
        o.status = op;
        let _ = i.save(s, n);
        i.working = None;
        if let Some(o) = &mut i.doc.operation {
            o.status.settled = true;
        }
    }
    pub(super) fn cancel_recover(&self, s: &MetaStore, id: &str) -> Result<Reply> {
        let mut i = self.lock()?;
        if let Some((key, c)) = &i.working
            && key == id
        {
            c.store(true, Ordering::SeqCst);
            let mut n = i.doc.clone();
            let o = n.operation.as_mut().unwrap();
            o.status.state = "cancelling".into();
            o.status.cancel_requested = true;
            let _ = i.save(s, n);
            return Ok(i.reply(id));
        }
        if let Some(o) = i
            .doc
            .operation
            .as_ref()
            .filter(|o| o.status.operation_id == id && o.status.state == "prepared")
            .cloned()
        {
            let mut n = i.doc.clone();
            let op = n.operation.as_mut().unwrap();
            op.status = status(id, "cancelled", None, &o.recovery.unwrap());
            op.status.cancel_requested = true;
            i.save(s, n)?;
        }
        Ok(i.reply(id))
    }
    pub(super) fn recheck_recover(&self, s: &MetaStore, id: &str) -> Result<Reply> {
        recover::supported()?;
        let _own = self.0.admission.activity().map_err(|_| error("busy"))?;
        let _global = managed_update::activity().map_err(|_| error("busy"))?;
        let intent = {
            let mut i = self.lock()?;
            i.recover(s)?;
            if i.working.is_some() {
                return Ok(i.reply(id));
            }
            i.doc
                .operation
                .as_ref()
                .filter(|o| o.status.operation_id == id)
                .and_then(|o| o.recovery.clone())
        };
        if let Some(intent) = intent
            && intent.target_stamp.is_some()
        {
            self.finish_recover(
                s,
                id,
                recover::verify(&self.0.material, &intent, &AtomicBool::new(false)),
            );
        }
        self.status(s, id)
    }
}
