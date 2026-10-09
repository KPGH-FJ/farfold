//! Restore only the two Farfold-owned startup records from a reviewed snapshot.
//! No candidate migrations, credential/history imports or live workspace replacement.
use super::{StorageIssue, export};
pub(crate) mod candidate;
use crate::meta_store::MetaStore;
use serde::Serialize;
use std::{collections::BTreeMap, path::Path};

pub(crate) const KEYS: [&str; 2] = ["unsentWork.v1", "agentSetup.v1"];
pub(super) const MAX_DATABASE_BYTES: u64 = 512 * 1024 * 1024;
pub(super) const MAX_VALUE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) type SavedValues = BTreeMap<String, Option<String>>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub id: String,
    pub source_path: String,
    pub values: SavedValues,
}
struct Pending {
    preview: RestorePreview,
    baseline: SavedValues,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReceipt {
    pub id: String,
    pub keys: Vec<String>,
    pub protected_path: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFailure {
    pub code: &'static str,
    pub issue: Option<StorageIssue>,
    pub materials_path: Option<String>,
    pub materials_complete: bool,
}
impl RestoreFailure {
    pub(super) fn new(code: &'static str) -> Self {
        Self {
            code,
            issue: None,
            materials_path: None,
            materials_complete: false,
        }
    }
    pub(super) fn storage(reason: String) -> Self {
        Self {
            issue: Some(StorageIssue::from_receipt(&reason)),
            ..Self::new("storage")
        }
    }
}
#[derive(Default)]
pub(super) struct RestoreState {
    pending: Option<Pending>,
    receipt: Option<RestoreReceipt>,
}
impl RestoreState {
    pub fn active(&self) -> bool {
        self.pending.is_some()
    }
    pub fn cancel(&mut self) {
        self.pending = None;
    }
    pub fn preview(
        &mut self,
        store: &MetaStore,
        source: &Path,
    ) -> Result<RestorePreview, RestoreFailure> {
        self.pending = None;
        let values = candidate::read_candidate(source)?;
        let baseline = store.restore_values().map_err(RestoreFailure::storage)?;
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut nonce).map_err(|_| RestoreFailure::new("unavailable"))?;
        let preview = RestorePreview {
            id: nonce.iter().map(|byte| format!("{byte:02x}")).collect(),
            source_path: source.to_string_lossy().into_owned(),
            values,
        };
        self.pending = Some(Pending {
            preview: preview.clone(),
            baseline,
        });
        Ok(preview)
    }
    pub fn receipt(&self, id: &str) -> Option<RestoreReceipt> {
        self.receipt
            .as_ref()
            .filter(|receipt| receipt.id == id)
            .cloned()
    }
    pub fn apply(
        &mut self,
        store: &MetaStore,
        path: &Path,
        id: &str,
        keys: &[String],
        backup_directory: &Path,
    ) -> Result<RestoreReceipt, RestoreFailure> {
        let mut keys = keys.to_vec();
        keys.sort();
        if keys.is_empty()
            || keys.len() > KEYS.len()
            || keys.iter().any(|key| !KEYS.contains(&key.as_str()))
            || keys.windows(2).any(|pair| pair[0] == pair[1])
        {
            return Err(RestoreFailure::new("selection"));
        }
        if let Some(receipt) = self.receipt(id) {
            if receipt.keys != keys {
                return Err(RestoreFailure::new("selection"));
            }
            return Ok(receipt);
        }
        let pending = self
            .pending
            .as_ref()
            .filter(|pending| pending.preview.id == id)
            .ok_or_else(|| RestoreFailure::new("expired"))?;
        let mut selected = BTreeMap::new();
        for key in &keys {
            let raw = pending
                .preview
                .values
                .get(key)
                .and_then(Option::as_ref)
                .ok_or_else(|| RestoreFailure::new("selection"))?;
            let value: serde_json::Value =
                serde_json::from_str(raw).map_err(|_| RestoreFailure::new("unsupported"))?;
            if !value.is_null()
                && value.get("version").and_then(serde_json::Value::as_u64) != Some(1)
            {
                return Err(RestoreFailure::new("unsupported"));
            }
            selected.insert(key.clone(), raw.clone());
        }
        // Protection must be acknowledged before any transaction can change originals.
        let protected = export::export(path, Some(store), backup_directory).map_err(|failure| {
            RestoreFailure {
                code: "backup",
                issue: Some(failure.issue),
                materials_path: failure.partial_path,
                materials_complete: false,
            }
        })?;
        if let Err(reason) = store.restore_startup_values(&pending.baseline, &selected) {
            let code = if reason == "RESTORE_BASELINE_CHANGED" {
                "changed"
            } else {
                "storage"
            };
            return Err(RestoreFailure {
                code,
                issue: Some(StorageIssue::from_receipt(&reason)),
                materials_path: Some(protected.path),
                materials_complete: true,
            });
        }
        let receipt = RestoreReceipt {
            id: id.to_string(),
            keys: keys.to_vec(),
            protected_path: protected.path,
        };
        self.receipt = Some(receipt.clone());
        self.pending = None;
        Ok(receipt)
    }
}
