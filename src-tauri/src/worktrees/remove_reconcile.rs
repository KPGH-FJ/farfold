//! Read-only reconciliation survives replacement of the single current intent.
use super::*;
use crate::worktrees::{
    recovery_pack, removal,
    storage::{RemoveIntent, SavedArchive},
};
impl Worktrees {
    pub(super) fn check_removed_archive(
        &self,
        store: &MetaStore,
        saved: &SavedArchive,
    ) -> Result<Listing> {
        let operation_id = saved
            .removal_operation
            .as_ref()
            .ok_or(error("recheckRequired"))?;
        let recovery = {
            let i = self.lock()?;
            i.doc
                .recoveries
                .iter()
                .find(|r| {
                    &r.operation_id == operation_id && r.receipt.archive_id == saved.archive.id
                })
                .cloned()
                .ok_or(error("missingRecovery"))?
        };
        let checked = (|| {
            let m = recovery_pack::verify(&self.0.material, &recovery, &AtomicBool::new(false))?;
            let intent = RemoveIntent {
                saved: recovery.source.clone(),
                roots: m.roots.summary()?,
                content: m.content.clone(),
                profile_sha256: removal::profile_values(&m.configs, &m.attributes)?,
                recovery_id: recovery.receipt.id.clone(),
                recovery_path: recovery.receipt.path.clone(),
                recovery: Some(recovery.clone()),
                dispatched: true,
                confirmation: None,
            };
            removal::verify_deleted(&self.0.material, &intent, &AtomicBool::new(false))
        })();
        let mut i = self.lock()?;
        let mut n = i.doc.clone();
        let index = n
            .archives
            .iter()
            .position(|a| {
                a.archive.id == saved.archive.id
                    && a.archive.revision == saved.archive.revision
                    && a.removal_operation == saved.removal_operation
            })
            .ok_or(error("changed"))?;
        if checked.is_ok() {
            n.archives.remove(index);
        } else {
            let a = &mut n.archives[index];
            a.archive.revision = next_revision(a.archive.revision)?;
            a.archive.availability = "unknown".into();
            // Existing material never proves a cold deletion process ended, so no new disposal grant.
        }
        i.save(store, n)?;
        drop(i);
        self.list(store)
    }
}
