//! One current intent and location metadata, never a Git/Agent event ledger.
use super::{
    inspect::{Snapshot, Stamp},
    types::*,
};
use crate::meta_store::MetaStore;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    Adopt {
        inspection_id: String,
        tree_path: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedOperation {
    pub request: Request,
    pub completed: bool,
    pub status: Operation,
    pub intent: Option<Intent>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Document {
    pub version: u32,
    pub locations: Vec<SavedLocation>,
    pub materials: Vec<Material>,
    pub operation: Option<SavedOperation>,
}
impl Default for Document {
    fn default() -> Self {
        Self {
            version: 1,
            locations: Vec::new(),
            materials: Vec::new(),
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
impl Document {
    pub fn valid(&self) -> bool {
        let mut ids = HashSet::new();
        self.version == 1
            && self.locations.len() <= 256
            && self.materials.len() <= 256
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
            && self.operation.as_ref().is_none_or(|v| {
                let s = &v.status;
                id(&s.operation_id)
                    && s.kind == "operation"
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
            })
    }
}
pub(super) fn read(store: &MetaStore) -> Result<(Option<String>, Document)> {
    let raw = store
        .worktree_raw()
        .map_err(|_| error("storageUnavailable"))?;
    let value = match &raw {
        None => Document::default(),
        Some(s) if s.len() <= 4 * 1024 * 1024 => {
            serde_json::from_str(s).map_err(|_| error("storageInvalid"))?
        }
        Some(_) => return Err(error("storageInvalid")),
    };
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
