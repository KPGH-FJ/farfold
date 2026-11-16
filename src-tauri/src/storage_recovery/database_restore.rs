//! Whole-database recovery is a startup-only file replacement. It never opens
//! an old/new database while files are being moved and never rolls back a
//! released database that may already contain new user writes.
mod files;
mod operation;
mod pending_tools;
#[cfg(all(test, target_os = "macos"))]
mod tests;
mod validate;

use super::restore::{RestoreFailure as Failure, candidate};
use files::FileOps;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const RECORD: &str = "farfold-restore.json";
const LIMIT: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fact {
    bytes: u64,
    sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Original {
    name: String,
    fact: Fact,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Preparing,
    Prepared,
    Installed,
    Released,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    version: u32,
    id: String,
    phase: Phase,
    originals: Vec<Original>,
    database: Fact,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    agents: u64,
    sessions: u64,
    settings: u64,
    dismissed_sessions: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    source_path: String,
    counts: Counts,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: Option<String>,
    pub phase: &'static str,
    protected_path: Option<String>,
    retained_path: Option<String>,
    pub can_continue: bool,
    pub can_restart: bool,
}
impl Status {
    pub(super) fn blocked() -> Self {
        Self {
            id: None,
            phase: "blocked",
            protected_path: None,
            retained_path: None,
            can_continue: false,
            can_restart: false,
        }
    }
}
struct Pending {
    preview: Preview,
    _directory: tempfile::TempDir,
    snapshot: PathBuf,
    fact: Fact,
    previous: Option<Intent>,
}
#[derive(Default)]
pub(super) struct State {
    pending: Option<Pending>,
    attempted: bool,
}
pub(super) fn supported() -> bool {
    cfg!(target_os = "macos")
}
fn nonce() -> Result<String, Failure> {
    let mut value = [0; 24];
    getrandom::fill(&mut value).map_err(|_| Failure::new("unavailable"))?;
    Ok(value.iter().map(|b| format!("{b:02x}")).collect())
}
fn parent(path: &Path) -> Result<&Path, Failure> {
    path.parent().ok_or_else(|| Failure::new("blocked"))
}
fn record(path: &Path) -> Result<PathBuf, Failure> {
    Ok(parent(path)?.join(RECORD))
}
fn container(path: &Path) -> Result<PathBuf, Failure> {
    Ok(parent(path)?.join("Farfold-Restore"))
}
fn work(path: &Path, id: &str) -> Result<PathBuf, Failure> {
    Ok(container(path)?.join(id))
}
fn require_record_if_material_exists(path: &Path, intent: &Option<Intent>) -> Result<(), Failure> {
    // One exact known directory is the sentinel. Never scan similarly named
    // user directories, and never guess that a missing record means no work.
    if intent.is_none() && files::exists(&container(path)?)? {
        return Err(Failure::new("blocked"));
    }
    Ok(())
}
fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl State {
    pub fn active(&self) -> bool {
        self.pending.is_some() || self.attempted
    }
    pub fn preview(&mut self, path: &Path, source: &Path) -> Result<Preview, Failure> {
        pending_tools::reject_known_pending(path)?;
        let previous = operation::read_intent(path)?;
        require_record_if_material_exists(path, &previous)?;
        if !supported()
            || previous
                .as_ref()
                .is_some_and(|i| !matches!(i.phase, Phase::Released | Phase::Preparing))
            || (self.attempted
                && previous
                    .as_ref()
                    .is_none_or(|i| i.phase != Phase::Preparing))
        {
            return Err(Failure::new("unavailable"));
        }
        if let Some(intent) = previous.as_ref().filter(|i| i.phase == Phase::Preparing) {
            operation::preparation_untouched(path, intent)?;
        }
        self.attempted = false;
        self.pending = None;
        let directory = tempfile::tempdir().map_err(files::storage)?;
        let snapshot = directory
            .path()
            .canonicalize()
            .map_err(files::storage)?
            .join("candidate.sqlite3");
        candidate::snapshot_file(source, &snapshot)?;
        let counts = validate::database(&snapshot)?;
        let fact = files::fact(&snapshot)?;
        let preview = Preview {
            id: nonce()?,
            source_path: text(source),
            counts,
        };
        self.pending = Some(Pending {
            preview: preview.clone(),
            _directory: directory,
            snapshot,
            fact,
            previous,
        });
        Ok(preview)
    }
    pub fn cancel(&mut self, path: &Path) -> Result<(), Failure> {
        let old = operation::read_intent(path)?;
        require_record_if_material_exists(path, &old)?;
        match old.as_ref().map(|i| i.phase) {
            Some(Phase::Preparing) => {
                operation::preparation_untouched(path, old.as_ref().unwrap())?
            }
            Some(Phase::Released) | None if !self.attempted => {}
            _ => return Err(Failure::new("unavailable")),
        }
        self.pending = None;
        self.attempted = false;
        Ok(())
    }
    pub fn apply(&mut self, path: &Path, id: &str) -> Result<Status, Failure> {
        if let Some(intent) = operation::read_intent(path)? {
            if intent.id == id {
                // Lost command replies are queried, never a reason to reapply.
                return operation::inspect_intent(path, &intent);
            }
            if !matches!(intent.phase, Phase::Released | Phase::Preparing) {
                return Err(Failure::new("changed"));
            }
        }
        let pending = self
            .pending
            .as_ref()
            .filter(|p| p.preview.id == id)
            .ok_or_else(|| Failure::new("expired"))?;
        self.attempted = true;
        if let Err(error) = operation::prepare(path, pending, &files::Native) {
            // Before an intent is installed, no original has moved. Keep the
            // partial protection folder, but allow a new explicit preview.
            if operation::read_intent(path)
                .ok()
                .is_some_and(|old| old == pending.previous)
            {
                self.attempted = false;
                self.pending = None;
            }
            return Err(error);
        }
        operation::advance(path, id, &files::Native)
    }
    pub fn resume(&mut self, path: &Path, id: &str) -> Result<Status, Failure> {
        if !supported() {
            return Err(Failure::new("unsupported"));
        }
        self.attempted = true;
        operation::advance(path, id, &files::Native)
    }
}

pub(super) fn inspect(path: &Path) -> Result<Option<Status>, Failure> {
    let intent = operation::read_intent(path)?;
    require_record_if_material_exists(path, &intent)?;
    intent
        .map(|i| {
            operation::inspect_intent(path, &i).or_else(|_| {
                let mut view = operation::status(path, &i)?;
                view.phase = "blocked";
                view.can_continue = false;
                view.can_restart = false;
                Ok(view)
            })
        })
        .transpose()
}
/// Only a newly-created recovery state may call this. The process that applies
/// a replacement remains gated by State::active and must be restarted.
pub(super) fn startup(path: &Path) -> Result<bool, Failure> {
    startup_with(path, &files::Native)
}
fn startup_with(path: &Path, io: &impl FileOps) -> Result<bool, Failure> {
    let intent = operation::read_intent(path)?;
    require_record_if_material_exists(path, &intent)?;
    let Some(mut intent) = intent else {
        return Ok(false);
    };
    match intent.phase {
        Phase::Preparing | Phase::Prepared => Err(Failure::new("interrupted")),
        Phase::Installed => {
            operation::installed(path, &intent)?;
            validate::captured_database(path)?;
            operation::installed(path, &intent)?;
            intent.phase = Phase::Released;
            operation::save(path, &intent, true, io)?;
            Ok(true)
        }
        Phase::Released => {
            // Never compare historical snapshot digests after admission.
            if !files::exists(path)? {
                return Err(Failure::new("missing"));
            }
            for material in super::existing_material(path).map_err(Failure::storage)? {
                let metadata = material.symlink_metadata().map_err(files::storage)?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || material.canonicalize().map_err(files::storage)? != material
                {
                    return Err(Failure::new("blocked"));
                }
            }
            // Also covers a prior release whose final directory sync failed.
            // Do not open in that failing attempt; a later retry must sync.
            io.sync_directory(parent(path)?)?;
            Ok(true)
        }
    }
}
