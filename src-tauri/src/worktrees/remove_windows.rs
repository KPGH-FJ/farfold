//! No git worktree remove/path sweep: dispose only complete, retained original owners.
use super::*;
pub(in crate::worktrees) fn delete(
    material: &super::super::material_owner::Owner,
    intent: &RemoveIntent,
    cancel: &AtomicBool,
    before_dispatch: impl FnOnce() -> Result<()>,
) -> Result<()> {
    #[cfg(test)]
    let started = std::time::Instant::now();
    #[cfg(test)]
    let phase = |name| {
        eprintln!(
            "FARFOLD_REMOVE_NATIVE elapsedMs={} phase={name}",
            started.elapsed().as_millis()
        );
    };
    #[cfg(test)]
    phase("capture.enter");
    let plan = capture(material, &intent.saved, cancel)?;
    same_plan(intent, &plan)?;
    #[cfg(test)]
    phase("verify-package.enter");
    let restored = recovery_pack::verify(
        material,
        intent.recovery.as_ref().ok_or(error("recoveryInvalid"))?,
        cancel,
    )?;
    if !plan.matches(&restored) {
        return Err(error("recoveryChanged"));
    }
    #[cfg(test)]
    phase("freeze-source.enter");
    let snapshot = recycle::verify_at(material, &intent.saved, true, cancel)?;
    let graph = git::source_roots::SourceGraph::capture(&snapshot, cancel)?;
    let frozen = graph.freeze_for_remove(cancel)?;
    let mut current = Capture {
        roots: frozen.roots.clone(),
        objects: frozen.objects.clone(),
        content: plan.content.clone(),
        configs: frozen.configs.clone(),
        attributes: frozen.attributes.clone(),
    };
    if current != plan {
        return Err(error("recoveryChanged"));
    }
    let request = frozen.deletion_request(
        recovery_pack::material::retained_full(plan.content.profile.as_ref())?,
        cancel,
    )?;
    #[cfg(test)]
    phase("delete-tree.enter");
    material.remove_complete_tree(request, cancel, |content| {
        current.content = content;
        same_plan(intent, &current)?;
        if current != plan || !current.matches(&restored) {
            return Err(error("recoveryChanged"));
        }
        #[cfg(test)]
        phase("dispatch.enter");
        before_dispatch()
    })?;
    let mut dispatched = intent.clone();
    dispatched.dispatched = true;
    #[cfg(test)]
    phase("verify-deleted.enter");
    verify_deleted(material, &dispatched, &AtomicBool::new(false))
}
