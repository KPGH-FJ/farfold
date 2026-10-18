//! Memory-only tickets. Never persist an observation as readiness or authority.
use super::*;
use crate::worktrees::{
    preparation::{self, Observation},
    preparation_types::{
        PreparationCoverage, PreparationInspection, PreparationNodeKind, PreparationValidation,
    },
};
use std::time::{SystemTime, UNIX_EPOCH};

const TICKET_LIMIT: usize = 32;
const TICKET_TTL: Duration = Duration::from_secs(300);
#[derive(Clone)]
pub(super) struct PreparationTicket {
    saved: SavedLocation,
    relative: String,
    observation: Observation,
    created: Instant,
}
fn timestamp() -> Result<u64> {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| error("unavailable"))?
        .as_millis();
    u64::try_from(ms)
        .ok()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or(error("unavailable"))
}
fn current(inner: &Inner, saved: &SavedLocation) -> Result<()> {
    if inner.working.is_some() || inner.maintenance.is_some() {
        return Err(error("busy"));
    }
    if inner
        .doc
        .locations
        .iter()
        .find(|v| v.location.id == saved.location.id)
        != Some(saved)
    {
        return Err(error("changed"));
    }
    if saved.location.availability != "verified" {
        return Err(error("changed"));
    }
    Ok(())
}
impl Worktrees {
    pub fn preparation_inspect(
        &self,
        store: &MetaStore,
        location_id: &str,
        expected_revision: u64,
        project_relative_path: &str,
    ) -> Result<PreparationInspection> {
        self.preparation_inspect_with(
            store,
            location_id,
            expected_revision,
            project_relative_path,
            || {},
        )
    }
    fn preparation_inspect_with(
        &self,
        store: &MetaStore,
        location_id: &str,
        expected_revision: u64,
        project_relative_path: &str,
        after_capture: impl FnOnce(),
    ) -> Result<PreparationInspection> {
        crate::worktrees::mutation_supported()?;
        preparation::relative_segments(project_relative_path)?;
        let _permit = self.0.admission.activity().map_err(|_| error("busy"))?;
        let _global = managed_update::activity().map_err(|_| error("busy"))?;
        let saved = {
            let mut inner = self.lock()?;
            inner.load(store)?;
            let saved = inner
                .doc
                .locations
                .iter()
                .find(|v| v.location.id == location_id)
                .cloned()
                .ok_or(error("missing"))?;
            current(&inner, &saved)?;
            if saved.location.revision != expected_revision {
                return Err(error("changed"));
            }
            inner
                .preparation_tickets
                .retain(|_, v| v.created.elapsed() < TICKET_TTL);
            if inner.preparation_tickets.len() >= TICKET_LIMIT {
                return Err(error("capacity"));
            }
            saved
        };
        let observation = preparation::collect(&saved, project_relative_path)?;
        after_capture();
        let observed_at_ms = timestamp()?;
        let mut inner = self.lock()?;
        inner.load(store)?;
        current(&inner, &saved)?;
        // Re-evaluate after collection because parallel reads may have filled capacity.
        inner
            .preparation_tickets
            .retain(|_, v| v.created.elapsed() < TICKET_TTL);
        if inner.preparation_tickets.len() >= TICKET_LIMIT {
            return Err(error("capacity"));
        }
        let id = new_id()?;
        let output = PreparationInspection {
            inspection_id: id.clone(),
            location: saved.location.clone(),
            project_relative_path: project_relative_path.into(),
            project_path: observation.project_path.clone(),
            observed_at_ms,
            git: observation.git.summary.clone(),
            facts: observation.facts.clone(),
            coverage: PreparationCoverage {
                scope: "fixedNameMetadata",
                checked_names: observation.facts.len(),
                complete: observation
                    .facts
                    .iter()
                    .all(|f| f.node_kind != PreparationNodeKind::Unreadable),
            },
        };
        inner.preparation_tickets.insert(
            id,
            PreparationTicket {
                saved,
                relative: project_relative_path.into(),
                observation,
                created: Instant::now(),
            },
        );
        Ok(output)
    }
    pub fn preparation_validate(
        &self,
        store: &MetaStore,
        inspection_id: &str,
    ) -> Result<PreparationValidation> {
        self.preparation_validate_with(store, inspection_id, || {})
    }
    fn preparation_validate_with(
        &self,
        store: &MetaStore,
        inspection_id: &str,
        after_capture: impl FnOnce(),
    ) -> Result<PreparationValidation> {
        crate::worktrees::mutation_supported()?;
        let _permit = self.0.admission.activity().map_err(|_| error("busy"))?;
        let _global = managed_update::activity().map_err(|_| error("busy"))?;
        let ticket = {
            let mut inner = self.lock()?;
            inner.load(store)?;
            inner
                .preparation_tickets
                .retain(|_, v| v.created.elapsed() < TICKET_TTL);
            let ticket = inner
                .preparation_tickets
                .get(inspection_id)
                .cloned()
                .ok_or(error("inspectionExpired"))?;
            if let Err(failure) = current(&inner, &ticket.saved) {
                inner.preparation_tickets.remove(inspection_id);
                return Err(failure);
            }
            ticket
        };
        let observed = preparation::collect(&ticket.saved, &ticket.relative);
        after_capture();
        let mut inner = self.lock()?;
        inner.load(store)?;
        let checked = (|| {
            let registered = inner
                .preparation_tickets
                .get(inspection_id)
                .ok_or(error("inspectionExpired"))?;
            if registered.created != ticket.created || ticket.created.elapsed() >= TICKET_TTL {
                return Err(error("inspectionExpired"));
            }
            current(&inner, &ticket.saved)?;
            if observed? != ticket.observation {
                return Err(error("changed"));
            }
            Ok(PreparationValidation {
                inspection_id: inspection_id.into(),
                valid: true,
            })
        })();
        if checked.is_err() {
            // No later return-to-old-path can revive a ticket rejected here.
            inner.preparation_tickets.remove(inspection_id);
        }
        checked
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "preparation_manager_tests.rs"]
mod tests;
