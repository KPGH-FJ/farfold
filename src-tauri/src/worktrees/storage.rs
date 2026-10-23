//! One current intent and location metadata, never a Git/Agent event ledger.
use super::{
    inspect::{Snapshot, Stamp},
    recycle_types::*,
    types::*,
};
use crate::meta_store::MetaStore;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Identity {
    pub root: String,
    pub repository_root: String,
    pub git_dir: String,
    pub common_dir: String,
    pub root_stamp: Stamp,
    pub git_stamp: Stamp,
    pub common_stamp: Stamp,
}
impl From<&Snapshot> for Identity {
    fn from(s: &Snapshot) -> Self {
        Self {
            root: s.root.clone(),
            repository_root: s.repository_root().into(),
            git_dir: s.git_dir.clone(),
            common_dir: s.common_dir.clone(),
            root_stamp: s.root_stamp.clone(),
            git_stamp: s.git_stamp.clone(),
            common_stamp: s.common_stamp.clone(),
        }
    }
}
impl Identity {
    pub fn check(&self) -> Result<()> {
        super::inspect::same(&self.root, &self.root_stamp)?;
        super::inspect::same(&self.git_dir, &self.git_stamp)?;
        super::inspect::same(&self.common_dir, &self.common_stamp)
    }
    pub fn matches(&self, s: &Snapshot) -> bool {
        self.root == s.root
            && self.repository_root == s.repository_root()
            && self.git_dir == s.git_dir
            && self.common_dir == s.common_dir
            && self.root_stamp == s.root_stamp
            && self.git_stamp == s.git_stamp
            && self.common_stamp == s.common_stamp
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedLocation {
    pub location: Location,
    pub identity: Identity,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Intent {
    pub input: Create,
    pub source: Identity,
    pub parent: String,
    pub parent_stamp: Stamp,
    pub target: String,
    pub target_stamp: Option<Stamp>,
    pub dispatched: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) enum Request {
    Create(Create),
    Recycle(RecycleInput),
    Remove(super::remove_types::RemoveInput),
    Recover(super::remove_types::RecoverInput),
    Adopt {
        inspection_id: String,
        tree_path: String,
    },
}
impl Request {
    pub fn action(&self) -> &'static str {
        match self {
            Self::Create(_) => "create",
            Self::Adopt { .. } => "adopt",
            Self::Recycle(r) => r.action.name(),
            Self::Remove(_) => "remove",
            Self::Recover(_) => "recover",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedArchive {
    #[serde(default)]
    pub removal_operation: Option<String>,
    pub archive: Archive,
    pub original: SavedLocation,
    pub parent: String,
    pub parent_stamp: Stamp,
    pub retained_parent: String,
    pub retained_parent_stamp: Option<Stamp>,
    pub material: MaterialSummary,
    pub index_sha256: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecycleIntent {
    pub saved: SavedArchive,
    pub action: RecycleAction,
    pub dispatched: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct RemoveIntent {
    pub saved: SavedArchive,
    pub roots: super::remove_types::RootsSummary,
    pub content: MaterialSummary,
    pub profile_sha256: String,
    pub recovery_id: String,
    pub recovery_path: String,
    pub recovery: Option<super::recovery_pack::SavedRecovery>,
    pub dispatched: bool,
    pub confirmation: Option<super::remove_types::RemoveConfirmation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecoverIntent {
    pub input: super::remove_types::RecoverInput,
    pub recovery: super::recovery_pack::SavedRecovery,
    pub parent: String,
    pub parent_stamp: Stamp,
    pub target: String,
    pub target_stamp: Option<Stamp>,
    pub dispatched: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedOperation {
    pub request: Request,
    pub completed: bool,
    pub status: Operation,
    pub intent: Option<Intent>,
    #[serde(default)]
    pub recycle: Option<RecycleIntent>,
    #[serde(default)]
    pub removal: Option<RemoveIntent>,
    #[serde(default)]
    pub recovery: Option<RecoverIntent>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Document {
    pub version: u32,
    pub locations: Vec<SavedLocation>,
    #[serde(default)]
    pub archives: Vec<SavedArchive>,
    pub materials: Vec<Material>,
    #[serde(default)]
    pub recoveries: Vec<super::recovery_pack::SavedRecovery>,
    pub operation: Option<SavedOperation>,
}
impl Default for Document {
    fn default() -> Self {
        Self {
            version: 3,
            locations: Vec::new(),
            archives: Vec::new(),
            materials: Vec::new(),
            recoveries: Vec::new(),
            operation: None,
        }
    }
}
fn path(s: &str) -> bool {
    s.len() <= 4096 && !s.contains('\0') && Path::new(s).is_absolute()
}
fn identity(i: &Identity) -> bool {
    path(&i.root) && path(&i.repository_root) && path(&i.git_dir) && path(&i.common_dir)
}
pub(super) fn archive_material_profile_valid(profile: Option<&MaterialProfile>) -> bool {
    #[cfg(windows)]
    {
        super::recycle::archive_profile_supported(profile)
    }
    #[cfg(not(windows))]
    {
        profile.is_none()
    }
}
impl SavedArchive {
    pub fn valid(&self) -> bool {
        let a = &self.archive;
        let l = &self.original.location;
        self.removal_operation.as_ref().is_none_or(|v| id(v))
            && id(&a.id)
            && a.id == l.id
            && a.revision <= 9_007_199_254_740_991
            && path(&a.original_path)
            && path(&a.retained_path)
            && a.original_path != a.retained_path
            && path(&a.repository_root)
            && oid(&a.head_oid)
            && a.ownership == "created"
            && matches!(
                a.availability.as_str(),
                "verified" | "missing" | "changed" | "unknown"
            )
            && l.ownership == "created"
            && l.path == a.original_path
            && l.repository_root == a.repository_root
            && l.branch == a.branch
            && l.head_oid == a.head_oid
            && identity(&self.original.identity)
            && self.original.identity.root == a.original_path
            && path(&self.parent)
            && path(&self.retained_parent)
            && Path::new(&a.original_path).parent() == Some(Path::new(&self.parent))
            && Path::new(&a.retained_path).parent() == Some(Path::new(&self.retained_parent))
            && Path::new(&self.retained_parent).parent() == Some(Path::new(&self.parent))
            // Exact same-object archive profiles; retained restoration remains separate.
            && archive_material_profile_valid(self.material.profile.as_ref())
            && self.material.entries <= 100_000
            && self.material.bytes <= 1024 * 1024 * 1024
            && self.material.sha256.len() == 64
            && oid(&self.material.sha256)
            && self
                .index_sha256
                .as_ref()
                .is_none_or(|s| s.len() == 64 && oid(s))
    }
}
impl Document {
    pub fn valid(&self) -> bool {
        let mut ids = HashSet::new();
        let mut recovery_ids = HashSet::new();
        self.version == 3
            && self.locations.len() <= 256
            && self.archives.len() <= 256
            && self.materials.len() <= 256
            && self.recoveries.len() <= 256
            && self.recoveries.iter().all(|r| {
                super::remove_validation::recovery(r) && recovery_ids.insert(&r.receipt.id)
            })
            && self
                .materials
                .iter()
                .all(|m| id(&m.operation_id) && path(&m.path) && path(&m.repository_root))
            && self.locations.iter().all(|v| {
                let l = &v.location;
                id(&l.id)
                    && ids.insert(&l.id)
                    && l.revision <= 9_007_199_254_740_991
                    && path(&l.path)
                    && path(&l.repository_root)
                    && oid(&l.head_oid)
                    && matches!(l.ownership.as_str(), "created" | "existing")
                    && matches!(
                        l.availability.as_str(),
                        "verified" | "missing" | "changed" | "unknown"
                    )
                    && l.path == v.identity.root
                    && identity(&v.identity)
                    && l.branch.as_ref().is_none_or(|s| {
                        s.starts_with("refs/heads/") && s.len() <= 4096 && !s.contains('\0')
                    })
            })
            && self
                .archives
                .iter()
                .all(|v| v.valid() && ids.insert(&v.archive.id))
            && self.operation.as_ref().is_none_or(|v| {
                let s = &v.status;
                id(&s.operation_id)
                    && s.kind == "operation"
                    && s.action == v.request.action()
                    && s.original_path.is_some() == s.retained_path.is_some()
                    && match &v.request {
                        Request::Recycle(r) => {
                            v.recovery.is_none()
                                && v.removal.is_none()
                                && s.removal_phase.is_none()
                                && s.delete_dispatched.is_none()
                                && s.recovery.is_none()
                                && s.removed.is_none()
                                && v.recycle.as_ref().is_some_and(|i| {
                                    i.action == r.action
                                        && s.original_path.as_ref()
                                            == Some(&i.saved.archive.original_path)
                                        && s.retained_path.as_ref()
                                            == Some(&i.saved.archive.retained_path)
                                })
                        }
                        Request::Remove(_) => {
                            v.recovery.is_none() && super::remove_validation::operation(v)
                        }
                        Request::Recover(_) => super::recover::valid_operation(v),
                        _ => {
                            v.recovery.is_none()
                                && v.removal.is_none()
                                && s.removal_phase.is_none()
                                && s.delete_dispatched.is_none()
                                && s.recovery.is_none()
                                && s.removed.is_none()
                                && v.recycle.is_none()
                                && !s.maintenance_active
                                && s.archive.is_none()
                                && s.original_path.is_none()
                        }
                    }
                    && matches!(
                        s.state.as_str(),
                        "prepared"
                            | "running"
                            | "cancelling"
                            | "ready"
                            | "cancelled"
                            | "failed"
                            | "unknown"
                    )
                    && s.code.as_ref().is_none_or(|c| c.len() <= 128)
                    && v.intent.as_ref().is_none_or(|i| {
                        identity(&i.source)
                            && path(&i.parent)
                            && path(&i.target)
                            && oid(i.input.branch.oid())
                            && i.input.directory_name.len() <= 200
                    })
                    && v.recycle
                        .as_ref()
                        .is_none_or(|r| r.saved.valid() && v.request.action() == r.action.name())
            })
    }
}
pub(super) fn read(store: &MetaStore) -> Result<(Option<String>, Document)> {
    let raw = store
        .worktree_raw()
        .map_err(|_| error("storageUnavailable"))?;
    let mut value: Document = match &raw {
        None => Document::default(),
        Some(s) if s.len() <= 4 * 1024 * 1024 => {
            serde_json::from_str(s).map_err(|_| error("storageInvalid"))?
        }
        Some(_) => return Err(error("storageInvalid")),
    };
    if value.version == 2 && raw.is_some() {
        let raw: serde_json::Value =
            serde_json::from_str(raw.as_ref().ok_or(error("storageInvalid"))?)
                .map_err(|_| error("storageInvalid"))?;
        if raw.get("archives").is_none()
            || (raw["operation"].is_object()
                && ["action", "maintenanceActive"]
                    .iter()
                    .any(|k| raw["operation"]["status"].get(k).is_none()))
        {
            return Err(error("storageInvalid"));
        }
    }
    if value.version == 1 {
        let old: serde_json::Value =
            serde_json::from_str(raw.as_ref().ok_or(error("storageInvalid"))?)
                .map_err(|_| error("storageInvalid"))?;
        if old.get("archives").is_some()
            || old["operation"].get("recycle").is_some()
            || [
                "action",
                "maintenanceActive",
                "archive",
                "originalPath",
                "retainedPath",
            ]
            .into_iter()
            .any(|k| old["operation"]["status"].get(k).is_some())
        {
            return Err(error("storageInvalid"));
        }
        value.version = 2;
        if let Some(op) = &mut value.operation {
            op.status.action = op.request.action().into();
        }
    }
    if value.version == 2 {
        let old: serde_json::Value =
            serde_json::from_str(raw.as_ref().ok_or(error("storageInvalid"))?)
                .map_err(|_| error("storageInvalid"))?;
        if old["archives"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v.get("removal_operation").is_some()))
            || old.get("recoveries").is_some()
            || old["operation"].get("removal").is_some()
            || old["operation"].get("recovery").is_some()
            || ["removalPhase", "deleteDispatched", "recovery", "removed"]
                .iter()
                .any(|k| old["operation"]["status"].get(k).is_some())
        {
            return Err(error("storageInvalid"));
        }
        value.version = 3;
    } else if value.version == 3 && raw.is_some() {
        let old: serde_json::Value =
            serde_json::from_str(raw.as_ref().unwrap()).map_err(|_| error("storageInvalid"))?;
        if old.get("recoveries").is_none()
            || old.get("archives").is_none()
            || (old["operation"].is_object()
                && ["action", "maintenanceActive"]
                    .iter()
                    .any(|k| old["operation"]["status"].get(k).is_none()))
        {
            return Err(error("storageInvalid"));
        }
    }
    if !value.valid() {
        return Err(error("storageInvalid"));
    }
    Ok((raw, value))
}
pub(super) fn save(
    store: &MetaStore,
    expected: &Option<String>,
    next: &Document,
) -> Result<String> {
    if !next.valid() {
        return Err(error("storageInvalid"));
    }
    let raw = serde_json::to_string(next).map_err(|_| error("storageInvalid"))?;
    if raw.len() > 4 * 1024 * 1024 {
        return Err(error("tooLarge"));
    }
    match store.worktree_compare_write(expected.as_deref(), &raw) {
        Ok(true) => Ok(raw),
        Ok(false) => Err(error("storageConflict")),
        Err(_) => Err(error("storageUnknown")),
    }
}
