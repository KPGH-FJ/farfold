use super::{
    create,
    inspect::{self, Snapshot},
    storage::{self, Document, Identity, Intent, Request, SavedLocation, SavedOperation},
    types::*,
};
use crate::{
    managed_update::{self, UpdateAdmission, UpdatePermit},
    meta_store::MetaStore,
};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
#[path = "recycle_manager.rs"]
mod recycle_manager;
use recycle_manager::{MaintenanceOwner, RecycleTicket};

struct Ticket {
    snapshot: Snapshot,
    refs: Vec<Ref>,
    created: Instant,
}
#[derive(Default)]
struct Inner {
    raw: Option<String>,
    doc: Document,
    loaded: bool,
    poisoned: bool,
    tickets: HashMap<String, Ticket>,
    recycle_tickets: HashMap<String, RecycleTicket>,
    maintenance: Option<MaintenanceOwner>,
    seen: HashSet<String>,
    rejected: HashMap<String, Operation>,
    requests: HashMap<String, Request>,
    pending_write: Option<Document>,
    preparing: HashSet<String>,
    working: Option<(String, Arc<AtomicBool>)>,
}
#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    admission: UpdateAdmission,
}
#[derive(Clone, Default)]
pub struct Worktrees(Arc<Shared>);
fn operation(id: &str, state: &str, code: Option<&str>) -> Operation {
    Operation {
        kind: "operation".into(),
        action: "create".into(),
        maintenance_active: false,
        operation_id: id.into(),
        state: state.into(),
        settled: !matches!(state, "prepared" | "running" | "cancelling"),
        cancel_requested: false,
        reviewed: false,
        target_path: None,
        location: None,
        archive: None,
        original_path: None,
        retained_path: None,
        code: code.map(Into::into),
    }
}
fn next_revision(n: u64) -> Result<u64> {
    n.checked_add(1)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or(error("tooLarge"))
}
impl Inner {
    fn load(&mut self, store: &MetaStore) -> Result<()> {
        if self.poisoned {
            return Err(error("storageUnknown"));
        }
        if self.loaded {
            return Ok(());
        }
        let (raw, mut doc) = storage::read(store)?;
        for v in &mut doc.locations {
            v.location.availability = "unknown".into();
        }
        for v in &mut doc.archives {
            v.archive.availability = "unknown".into();
        }
        if let Some(op) = &mut doc.operation {
            op.status.action = op.request.action().into();
            op.status.maintenance_active = false;
            // Reload never restarts a process, nor infers its outcome from an existing path.
            if !matches!(op.status.state.as_str(), "failed" | "cancelled") {
                op.status.state = "unknown".into();
                op.status.settled = true;
                op.status.code = Some("recheckRequired".into());
            }
            if let Some(l) = &mut op.status.location {
                l.availability = "unknown".into();
            }
            if let Some(a) = &mut op.status.archive {
                a.availability = "unknown".into();
            }
            self.seen.insert(op.status.operation_id.clone());
            self.requests
                .insert(op.status.operation_id.clone(), op.request.clone());
            op.status.reviewed = false;
        }
        self.seen
            .extend(doc.locations.iter().map(|v| v.location.id.clone()));
        self.seen
            .extend(doc.materials.iter().map(|v| v.operation_id.clone()));
        self.seen
            .extend(doc.archives.iter().map(|v| v.archive.id.clone()));
        self.raw = raw;
        self.doc = doc;
        self.loaded = true;
        Ok(())
    }
    fn save(&mut self, store: &MetaStore, mut next: Document) -> Result<()> {
        if let Some(op) = &mut next.operation {
            op.status.action = op.request.action().into();
        }
        if let Some(op) = &mut next.operation
            && let Some(intent) = &op.intent
        {
            op.status.target_path = Some(intent.target.clone());
        }
        match storage::save(store, &self.raw, &next) {
            Ok(raw) => {
                self.raw = Some(raw);
                self.doc = next;
                Ok(())
            }
            Err(e) => {
                self.pending_write = Some(next.clone());
                if let Some(op) = &mut next.operation {
                    op.status.state = "unknown".into();
                    op.status.settled = self.working.is_none();
                    op.status.code = Some("storageUnknown".into());
                    op.status.location = None;
                }
                self.doc = next;
                self.poisoned = true;
                Err(e)
            }
        }
    }
    fn recover(&mut self, store: &MetaStore) -> Result<()> {
        if !self.poisoned {
            return self.load(store);
        }
        if self.working.is_some() {
            return Err(error("busy"));
        }
        let actual = store.worktree_raw().map_err(|_| error("storageUnknown"))?;
        let mut wanted = self.pending_write.clone().ok_or(error("storageUnknown"))?;
        let raw = serde_json::to_string(&wanted).map_err(|_| error("storageInvalid"))?;
        if actual != self.raw && actual.as_deref() != Some(&raw) {
            return Err(error("storageConflict"));
        }
        if let Some(op) = &mut wanted.operation
            && !op.completed
            && !matches!(op.status.state.as_str(), "failed" | "cancelled")
        {
            op.status.state = "unknown".into();
            op.status.settled = true;
            op.status.code = Some("recheckRequired".into());
        }
        if let Some(op) = &mut wanted.operation {
            op.status.maintenance_active = self.maintenance.is_some();
        }
        self.raw = actual;
        self.poisoned = false;
        self.save(store, wanted)?;
        self.pending_write = None;
        Ok(())
    }
    fn reply(&self, id: &str) -> Reply {
        self.doc
            .operation
            .as_ref()
            .filter(|o| o.status.operation_id == id)
            .map(|o| Reply::Operation(Box::new(o.status.clone())))
            .or_else(|| {
                self.rejected
                    .get(id)
                    .cloned()
                    .map(|o| Reply::Operation(Box::new(o)))
            })
            .unwrap_or_else(|| Reply::unknown(id))
    }
    fn idle(&self) -> Result<()> {
        if self.working.is_some()
            || self.maintenance.is_some()
            || !self.preparing.is_empty()
            || self.doc.operation.as_ref().is_some_and(|o| {
                !o.status.settled || (o.status.state == "unknown" && !o.status.reviewed)
            })
        {
            Err(error("busy"))
        } else {
            Ok(())
        }
    }
    fn reject(&mut self, id: &str, code: &str) -> Reply {
        let value = operation(id, "failed", Some(code));
        self.seen.insert(id.into());
        self.rejected.insert(id.into(), value.clone());
        Reply::Operation(Box::new(value))
    }
    fn reserve(&mut self, id: &str) -> Result<()> {
        if !super::types::id(id) {
            return Err(error("invalidOperation"));
        }
        if self.seen.len() >= 1024 && !self.seen.contains(id) {
            return Err(error("capacity"));
        }
        self.seen.insert(id.into());
        Ok(())
    }
}
impl Worktrees {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>> {
        self.0.inner.lock().map_err(|_| error("unavailable"))
    }
    pub fn inspect(&self, store: &MetaStore, path: &str) -> Result<Inspection> {
        let _permit = self.0.admission.activity().map_err(|_| error("busy"))?;
        let _global = managed_update::activity().map_err(|_| error("busy"))?;
        let s = inspect::snapshot(Path::new(path))?;
        let refs = inspect::refs(&s)?;
        let mut inner = self.lock()?;
        inner.load(store)?;
        inner
            .tickets
            .retain(|_, v| v.created.elapsed() < Duration::from_secs(600));
        if inner.tickets.len() >= 32 {
            return Err(error("capacity"));
        }
        let ticket = new_id()?;
        let mut trees = s.trees.clone();
        for t in &mut trees {
            t.location_id = inner
                .doc
                .locations
                .iter()
                .find(|l| l.location.path == t.path && l.identity.common_dir == s.common_dir)
                .map(|l| l.location.id.clone());
        }
        let result = Inspection {
            inspection_id: ticket.clone(),
            root: s.root.clone(),
            repository_root: s.repository_root().into(),
            kind: if s.root == s.repository_root() {
                "main"
            } else {
                "linked"
            }
            .into(),
            head: Head {
                oid: s.head.clone(),
                branch: s.branch.clone(),
            },
            trees,
            blockers: s.blockers.clone(),
        };
        inner.tickets.insert(
            ticket,
            Ticket {
                snapshot: s,
                refs,
                created: Instant::now(),
            },
        );
        Ok(result)
    }
    pub fn refs(&self, ticket: &str, cursor: Option<&str>) -> Result<Refs> {
        let inner = self.lock()?;
        let t = inner
            .tickets
            .get(ticket)
            .filter(|t| t.created.elapsed() < Duration::from_secs(600))
            .ok_or(error("inspectionExpired"))?;
        t.snapshot.identity()?;
        let offset = match cursor {
            None => 0,
            Some(c) => c
                .strip_prefix(&format!("{ticket}:"))
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|n| *n > 0 && *n % 100 == 0 && *n < t.refs.len())
                .ok_or(error("inspectionExpired"))?,
        };
        let end = (offset + 100).min(t.refs.len());
        Ok(Refs {
            refs: t.refs[offset..end].to_vec(),
            next_cursor: (end < t.refs.len()).then(|| format!("{ticket}:{end}")),
        })
    }
    pub fn list(&self, store: &MetaStore) -> Result<Listing> {
        let mut i = self.lock()?;
        i.load(store)?;
        Ok(Listing {
            locations: i.doc.locations.iter().map(|v| v.location.clone()).collect(),
            archives: i.doc.archives.iter().map(|v| v.archive.clone()).collect(),
            materials: i.doc.materials.clone(),
            operation: i.doc.operation.as_ref().map(|o| o.status.clone()),
        })
    }
    pub fn prepare(&self, store: &MetaStore, id: &str, input: Create) -> Result<Reply> {
        let _permit = self.0.admission.activity().map_err(|_| error("busy"))?;
        let _global = managed_update::activity().map_err(|_| error("busy"))?;
        let source = {
            let mut i = self.lock()?;
            i.load(store)?;
            if i.seen.contains(id) {
                if i.requests
                    .get(id)
                    .is_some_and(|r| r != &Request::Create(input.clone()))
                {
                    return Err(error("operationConflict"));
                }
                return Ok(i.reply(id));
            }
            i.reserve(id)?;
            i.requests.insert(id.into(), Request::Create(input.clone()));
            if let Err(e) = i.idle() {
                return Ok(i.reject(id, e.code));
            }
            if i.doc.locations.len() >= 256 {
                return Ok(i.reject(id, "capacity"));
            }
            let Some(t) = i
                .tickets
                .remove(&input.inspection_id)
                .filter(|t| t.created.elapsed() < Duration::from_secs(600))
            else {
                return Ok(i.reject(id, "inspectionExpired"));
            };
            if t.snapshot.head.as_deref() != Some(input.branch.oid())
                && !t.refs.iter().any(|r| r.oid == input.branch.oid())
            {
                return Ok(i.reject(id, "invalidRef"));
            }
            i.preparing.insert(id.into());
            t.snapshot
        };
        let checked = create::validate(&source, &input);
        let mut i = self.lock()?;
        i.preparing.remove(id);
        i.load(store)?;
        // A cancel arriving while validation runs retires this exact prepare owner.
        if i.rejected.contains_key(id) {
            return Ok(i.reply(id));
        }
        if let Err(e) = i.idle() {
            return Ok(i.reject(id, e.code));
        }
        let intent = match checked {
            Ok(v) => v,
            Err(e) => return Ok(i.reject(id, e.code)),
        };
        let mut next = i.doc.clone();
        next.operation = Some(SavedOperation {
            request: Request::Create(input.clone()),
            completed: false,
            status: operation(id, "prepared", None),
            intent: Some(intent),
            recycle: None,
        });
        i.save(store, next)?;
        Ok(i.reply(id))
    }
    pub fn start(&self, store: &MetaStore, id: &str) -> Result<Reply> {
        if self.is_recycle(store, id)? {
            return self.start_recycle(store, id);
        }
        let own = self.0.admission.activity().map_err(|_| error("busy"))?;
        let global = managed_update::activity().map_err(|_| error("busy"))?;
        let mut i = self.lock()?;
        i.load(store)?;
        let Some(op) = i
            .doc
            .operation
            .as_ref()
            .filter(|v| v.status.operation_id == id)
        else {
            return Ok(i.reply(id));
        };
        if op.status.state != "prepared" {
            return Ok(i.reply(id));
        }
        let intent = op.intent.clone().ok_or(error("unknown"))?;
        if i.working.is_some() {
            return Err(error("busy"));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let mut next = i.doc.clone();
        next.operation.as_mut().unwrap().status = operation(id, "running", None);
        i.save(store, next)?;
        i.working = Some((id.into(), cancel.clone()));
        let manager = self.clone();
        let worker_store = store.clone();
        let key = id.to_owned();
        // Thread ownership retains both gates through final readback, including errors.
        let spawned = std::thread::Builder::new()
            .name("farfold-worktree".into())
            .spawn(move || {
                let _own = own;
                let _global = global;
                manager.run(&worker_store, &key, intent, cancel);
            });
        if spawned.is_err() {
            i.working = None;
            let mut next = i.doc.clone();
            next.operation.as_mut().unwrap().status = operation(id, "failed", Some("unavailable"));
            i.save(store, next)?;
        }
        Ok(i.reply(id))
    }
    fn run(&self, store: &MetaStore, id: &str, mut intent: Intent, cancel: Arc<AtomicBool>) {
        let result = (|| -> Result<Snapshot> {
            if cancel.load(Ordering::SeqCst) {
                return Err(error("cancelled"));
            }
            create::revalidate(&intent)?;
            let source = inspect::snapshot(Path::new(&intent.source.root))?;
            let checkout = super::checkout::Checkout::prepare(&source, intent.input.branch.oid())?;
            if cancel.load(Ordering::SeqCst) {
                return Err(error("cancelled"));
            }
            // Atomic mkdir reserves a new, empty leaf. Failure never reuses another directory.
            std::fs::create_dir(&intent.target).map_err(|e| {
                error(if e.kind() == std::io::ErrorKind::AlreadyExists {
                    "targetExists"
                } else {
                    "unavailable"
                })
            })?;
            intent.target_stamp = Some(inspect::stamp(Path::new(&intent.target))?);
            {
                let mut i = self.lock()?;
                let mut next = i.doc.clone();
                let op = next
                    .operation
                    .as_mut()
                    .filter(|o| o.status.operation_id == id)
                    .ok_or(error("unknown"))?;
                op.intent = Some(intent.clone());
                i.save(store, next)?;
            }
            if cancel.load(Ordering::SeqCst) {
                return Err(error("cancelled"));
            }
            // Commit the dispatch intention before starting Git. On a crash this remains unknown.
            intent.dispatched = true;
            {
                let mut i = self.lock()?;
                let mut next = i.doc.clone();
                next.operation.as_mut().ok_or(error("unknown"))?.intent = Some(intent.clone());
                i.save(store, next)?;
            }
            create::add(&intent, &cancel)?;
            checkout.materialize(&intent, &cancel)?;
            create::verify(&intent)
        })();
        let Ok(mut i) = self.lock() else {
            return;
        };
        let mut next = i.doc.clone();
        let Some(op) = next
            .operation
            .as_mut()
            .filter(|o| o.status.operation_id == id)
        else {
            i.working = None;
            return;
        };
        let requested = cancel.load(Ordering::SeqCst);
        match result {
            Ok(s) => {
                let location = Location {
                    id: id.into(),
                    revision: 0,
                    path: s.root.clone(),
                    repository_root: s.repository_root().into(),
                    branch: s.branch.clone(),
                    head_oid: s.head.clone().unwrap_or_default(),
                    ownership: "created".into(),
                    availability: "verified".into(),
                };
                next.locations.push(SavedLocation {
                    location: location.clone(),
                    identity: Identity::from(&s),
                });
                op.completed = true;
                op.status = operation(id, "ready", None);
                op.status.location = Some(location);
            }
            Err(e) => {
                let has_material = intent.target_stamp.is_some()
                    || intent.dispatched
                    || std::fs::symlink_metadata(&intent.target).is_ok();
                let state = if has_material {
                    "unknown"
                } else if e.code == "cancelled" {
                    "cancelled"
                } else {
                    "failed"
                };
                op.status = operation(id, state, Some(e.code));
            }
        }
        op.status.cancel_requested = requested;
        let saved = i.save(store, next.clone());
        if saved.is_err() {
            if let Some(op) = next.operation.as_mut() {
                op.status.state = "unknown".into();
                op.status.settled = true;
                op.status.code = Some("storageUnknown".into());
                op.status.location = None;
            }
            i.doc = next;
        }
        i.working = None;
    }
    pub fn status(&self, store: &MetaStore, id: &str) -> Result<Reply> {
        let mut i = self.lock()?;
        if i.rejected.contains_key(id) {
            return Ok(i.reply(id));
        }
        if !i.loaded {
            i.load(store)?;
        }
        Ok(i.reply(id))
    }
    pub fn cancel(&self, store: &MetaStore, id: &str) -> Result<Reply> {
        if self.is_recycle(store, id)? {
            return self.cancel_recycle(store, id);
        }
        let mut i = self.lock()?;
        if i.rejected.contains_key(id) {
            return Ok(i.reply(id));
        }
        if !i.loaded {
            i.load(store)?;
        }
        if !super::types::id(id) {
            return Err(error("invalidOperation"));
        }
        if let Some((key, flag)) = &i.working
            && key == id
        {
            flag.store(true, Ordering::SeqCst);
            let mut next = i.doc.clone();
            if let Some(op) = &mut next.operation {
                op.status.state = "cancelling".into();
                op.status.cancel_requested = true;
            }
            let _ = i.save(store, next);
            return Ok(i.reply(id));
        }
        if i.doc
            .operation
            .as_ref()
            .is_some_and(|o| o.status.operation_id == id && o.status.state == "prepared")
        {
            let mut next = i.doc.clone();
            let op = next.operation.as_mut().unwrap();
            op.status = operation(id, "cancelled", None);
            op.status.cancel_requested = true;
            i.save(store, next)?;
            return Ok(i.reply(id));
        }
        if i.preparing.contains(id) || !i.seen.contains(id) {
            i.reserve(id)?;
            let mut cancelled = operation(id, "cancelled", None);
            cancelled.cancel_requested = true;
            i.rejected.insert(id.into(), cancelled);
        }
        Ok(i.reply(id))
    }
    pub fn adopt(&self, store: &MetaStore, id: &str, ticket: &str, path: &str) -> Result<Reply> {
        let _permit = self.0.admission.activity().map_err(|_| error("busy"))?;
        let _global = managed_update::activity().map_err(|_| error("busy"))?;
        let source = {
            let mut i = self.lock()?;
            i.load(store)?;
            let request = Request::Adopt {
                inspection_id: ticket.into(),
                tree_path: path.into(),
            };
            if i.seen.contains(id) {
                if i.requests.get(id).is_some_and(|r| r != &request) {
                    return Err(error("operationConflict"));
                }
                return Ok(i.reply(id));
            }
            i.reserve(id)?;
            i.requests.insert(id.into(), request);
            if let Err(e) = i.idle() {
                return Ok(i.reject(id, e.code));
            }
            let Some(t) = i
                .tickets
                .remove(ticket)
                .filter(|t| t.created.elapsed() < Duration::from_secs(600))
            else {
                return Ok(i.reject(id, "inspectionExpired"));
            };
            if !t.snapshot.trees.iter().any(|t| t.path == path) {
                return Ok(i.reject(id, "changed"));
            }
            i.preparing.insert(id.into());
            t.snapshot
        };
        let checked = (|| {
            source.identity()?;
            let current = inspect::snapshot(Path::new(path))?;
            if current.root != path
                || current.common_dir != source.common_dir
                || current.common_stamp != source.common_stamp
                || !current.trees.iter().any(|t| t.path == path)
                || current.head.is_none()
            {
                return Err(error("changed"));
            }
            Ok(current)
        })();
        let mut i = self.lock()?;
        i.preparing.remove(id);
        i.load(store)?;
        if i.rejected.contains_key(id) {
            return Ok(i.reply(id));
        }
        if let Err(e) = i.idle() {
            return Ok(i.reject(id, e.code));
        }
        let s = match checked {
            Ok(v) => v,
            Err(e) => return Ok(i.reject(id, e.code)),
        };
        if i.doc.locations.len() >= 256 {
            return Ok(i.reject(id, "capacity"));
        }
        if i.doc.locations.iter().any(|v| v.location.path == path) {
            return Ok(i.reject(id, "alreadyKnown"));
        }
        let location = Location {
            id: id.into(),
            revision: 0,
            path: s.root.clone(),
            repository_root: s.repository_root().into(),
            branch: s.branch.clone(),
            head_oid: s.head.clone().unwrap_or_default(),
            ownership: "existing".into(),
            availability: "verified".into(),
        };
        let mut next = i.doc.clone();
        next.locations.push(SavedLocation {
            location: location.clone(),
            identity: Identity::from(&s),
        });
        let mut status = operation(id, "ready", None);
        status.location = Some(location);
        next.operation = Some(SavedOperation {
            request: Request::Adopt {
                inspection_id: ticket.into(),
                tree_path: path.into(),
            },
            completed: true,
            status,
            intent: None,
            recycle: None,
        });
        i.save(store, next)?;
        Ok(i.reply(id))
    }
    pub fn check_location(&self, store: &MetaStore, id: &str) -> Result<Location> {
        let _permit = self.0.admission.activity().map_err(|_| error("busy"))?;
        let _global = managed_update::activity().map_err(|_| error("busy"))?;
        let saved = {
            let mut i = self.lock()?;
            i.load(store)?;
            if i.working.is_some() {
                return Err(error("busy"));
            }
            i.doc
                .locations
                .iter()
                .find(|v| v.location.id == id)
                .cloned()
                .ok_or(error("missing"))?
        };
        let checked = (|| {
            saved.identity.check()?;
            let s = inspect::snapshot(Path::new(&saved.location.path))?;
            if !saved.identity.matches(&s)
                || s.head.is_none()
                || !s
                    .trees
                    .iter()
                    .any(|t| t.path == s.root && t.branch == s.branch)
            {
                return Err(error("changed"));
            }
            Ok(s)
        })();
        let mut i = self.lock()?;
        i.load(store)?;
        let mut next = i.doc.clone();
        let entry = next
            .locations
            .iter_mut()
            .find(|v| v.location.id == id && v.location.revision == saved.location.revision)
            .ok_or(error("changed"))?;
        entry.location.revision = next_revision(entry.location.revision)?;
        match &checked {
            Ok(s) => {
                entry.location.availability = "verified".into();
                entry.location.head_oid = s.head.clone().unwrap();
                entry.location.branch = s.branch.clone();
            }
            Err(e) => {
                entry.location.availability = match e.code {
                    "missing" => "missing",
                    "changed" | "unsafePath" => "changed",
                    _ => "unknown",
                }
                .into();
            }
        }
        let location = entry.location.clone();
        i.save(store, next)?;
        checked?;
        Ok(location)
    }
    pub fn forget(&self, store: &MetaStore, id: &str, revision: u64) -> Result<Forgotten> {
        let _permit = self.0.admission.activity().map_err(|_| error("busy"))?;
        let _global = managed_update::activity().map_err(|_| error("busy"))?;
        let mut i = self.lock()?;
        i.load(store)?;
        i.idle()?;
        let Some(pos) = i
            .doc
            .locations
            .iter()
            .position(|v| v.location.id == id && v.location.revision == revision)
        else {
            return Err(error("changed"));
        };
        let mut next = i.doc.clone();
        next.locations.remove(pos);
        if next
            .operation
            .as_ref()
            .is_some_and(|o| o.status.location.as_ref().is_some_and(|l| l.id == id))
        {
            next.operation = None;
        }
        i.save(store, next)?;
        Ok(Forgotten { forgotten: true })
    }
    pub fn recheck(&self, store: &MetaStore, id: &str) -> Result<Reply> {
        if self.is_recycle(store, id)? {
            return self.recheck_recycle(store, id);
        }
        let _own = self.0.admission.activity().map_err(|_| error("busy"))?;
        let _global = managed_update::activity().map_err(|_| error("busy"))?;
        {
            let mut i = self.lock()?;
            i.recover(store)?;
        }
        let current = self.status(store, id)?;
        let Reply::Operation(op) = current else {
            return Ok(current);
        };
        if !op.settled {
            return Ok(Reply::Operation(op));
        }
        // Only a previously saved location has a captured identity. Unknown material is retained
        // for explicit review/adoption; matching path alone never proves this operation succeeded.
        if let Some(l) = &op.location {
            let checked = self.check_location(store, &l.id);
            let mut i = self.lock()?;
            let mut next = i.doc.clone();
            if let Some(saved) = next
                .operation
                .as_mut()
                .filter(|s| s.status.operation_id == id)
            {
                match checked {
                    Ok(l) => {
                        saved.status.state = "ready".into();
                        saved.status.reviewed = false;
                        saved.status.location = Some(l);
                        saved.status.code = None;
                    }
                    Err(e) => {
                        saved.status.state = "unknown".into();
                        saved.status.code = Some(e.code.into());
                        saved.status.location = None;
                    }
                }
                i.save(store, next)?;
                return Ok(i.reply(id));
            }
        }
        Ok(Reply::Operation(op))
    }
    pub fn acknowledge(&self, store: &MetaStore, id: &str) -> Result<Reply> {
        let _permit = self.0.admission.activity().map_err(|_| error("busy"))?;
        let _global = managed_update::activity().map_err(|_| error("busy"))?;
        let mut i = self.lock()?;
        i.recover(store)?;
        if i.working.is_some() {
            return Err(error("busy"));
        }
        let mut next = i.doc.clone();
        let Some(op) = next
            .operation
            .as_mut()
            .filter(|o| o.status.operation_id == id)
        else {
            return Ok(i.reply(id));
        };
        if !op.status.settled || op.status.state != "unknown" {
            return Err(error("busy"));
        }
        if let Some(intent) = &op.intent
            && !next.materials.iter().any(|m| m.operation_id == id)
        {
            if next.materials.len() >= 256 {
                return Err(error("capacity"));
            }
            next.materials.push(Material {
                operation_id: id.into(),
                path: intent.target.clone(),
                repository_root: intent.source.repository_root.clone(),
            });
        }
        op.status.reviewed = true;
        i.save(store, next)?;
        Ok(i.reply(id))
    }
    pub(crate) fn seal_maintenance(
        &self,
        store: Option<&MetaStore>,
    ) -> std::result::Result<UpdatePermit, String> {
        self.seal_exit(store, false).map_err(|code| {
            if code == "EXIT_CONFIRMATION_REQUIRED" {
                "工作位置操作的结果尚未确认，请先查看并确认".into()
            } else {
                "工作位置操作仍未结束，请先核对操作状态".into()
            }
        })
    }
    pub(crate) fn seal_exit(
        &self,
        store: Option<&MetaStore>,
        confirm: bool,
    ) -> std::result::Result<UpdatePermit, String> {
        let permit = self
            .0
            .admission
            .update()
            .map_err(|_| "WORKTREE_EXIT_BLOCKED".to_string())?;
        let mut i = self.lock().map_err(|_| "WORKTREE_EXIT_BLOCKED")?;
        if let Some(store) = store
            && i.load(store).is_err()
        {
            if i.working.is_some() {
                return Err("WORKTREE_EXIT_BLOCKED".into());
            }
            if !confirm {
                return Err("EXIT_CONFIRMATION_REQUIRED".into());
            }
            return Ok(permit);
        }
        if i.working.is_some() || i.doc.operation.as_ref().is_some_and(|o| !o.status.settled) {
            return Err("WORKTREE_EXIT_BLOCKED".into());
        }
        if !confirm
            && i.doc
                .operation
                .as_ref()
                .is_some_and(|o| o.status.state == "unknown" && !o.status.reviewed)
        {
            return Err("EXIT_CONFIRMATION_REQUIRED".into());
        }
        Ok(permit)
    }
}

fn new_id() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|_| error("unavailable"))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;
