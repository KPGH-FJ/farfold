use super::{recovery_pack::SavedRecovery, storage::SavedOperation, types::id};
use std::path::Path;
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn path(s: &str) -> bool {
    !s.is_empty() && s.len() <= 4096 && !s.contains('\0') && Path::new(s).is_absolute()
}
pub(super) fn recovery(r: &SavedRecovery) -> bool {
    let v = &r.receipt;
    #[cfg(windows)]
    if r.windows_program_origin.as_ref().is_some_and(|origin| {
        origin
            .matches(&r.source.original.identity, &r.receipt.retained_path)
            .is_err()
    }) {
        return false;
    }
    id(&r.operation_id)
        && r.source.valid()
        && r.source.archive.id == v.archive_id
        && r.source.archive.revision == v.archive_revision
        && r.source.archive.original_path == v.original_path
        && r.source.archive.retained_path == v.retained_path
        && r.source.archive.repository_root == v.repository_root
        && r.source.archive.head_oid == v.head_oid
        && r.source.archive.branch == v.branch
        && id(&v.id)
        && id(&v.archive_id)
        && v.revision <= 9_007_199_254_740_991
        && v.archive_revision <= 9_007_199_254_740_991
        && [
            &v.original_path,
            &v.retained_path,
            &v.repository_root,
            &v.path,
            &r.parent,
        ]
        .iter()
        .all(|s| path(s))
        && v.original_path != v.retained_path
        && v.path != v.original_path
        && v.path != v.retained_path
        && Path::new(&v.path).parent() == Some(Path::new(&r.parent))
        && super::types::oid(&v.head_oid)
        && matches!(v.object_format.as_str(), "sha1" | "sha256")
        && v.bundle_bytes > 0
        && v.bundle_bytes <= super::recovery_roots::MAX_BYTES
        && [
            &v.bundle_sha256,
            &v.manifest_sha256,
            &v.roots_sha256,
            &v.content_sha256,
        ]
        .iter()
        .all(|s| hash(s))
        && v.root_count > 0
        && v.root_count <= 4096
        && v.object_count <= 50_000
        && matches!(
            v.availability.as_str(),
            "verified" | "missing" | "changed" | "unknown"
        )
}
pub(super) fn operation(o: &SavedOperation) -> bool {
    let Some(i) = &o.removal else {
        return false;
    };
    let s = &o.status;
    i.saved.valid()
        && if cfg!(windows) {
            i.content.profile == Some(super::MaterialProfile::WindowsRetainedTreeV1)
        } else {
            i.content.profile.is_none()
        }
        && i.roots.count > 0
        && i.roots.count <= 4096
        && hash(&i.roots.sha256)
        && hash(&i.profile_sha256)
        && id(&i.recovery_id)
        && path(&i.recovery_path)
        && i.recovery.as_ref().is_none_or(|r| {
            recovery(r)
                && r.receipt.id == i.recovery_id
                && r.receipt.path == i.recovery_path
                && r.receipt.archive_id == i.saved.archive.id
                && r.receipt.archive_revision == i.saved.archive.revision
                && r.receipt.roots_sha256 == i.roots.sha256
                && r.receipt.content_sha256 == i.content.sha256
        })
        && (!i.dispatched || i.confirmation.is_some())
        && o.intent.is_none()
        && o.recycle.is_none()
        && s.location.is_none()
        && s.target_path.is_none()
        && s.archive.is_none()
        && s.original_path.as_ref() == Some(&i.saved.archive.original_path)
        && s.retained_path.as_ref() == Some(&i.saved.archive.retained_path)
        && s.delete_dispatched == Some(i.dispatched)
        && matches!(
            s.removal_phase.as_deref(),
            Some(
                "preparingRecovery"
                    | "verifyingRecovery"
                    | "awaitingConfirmation"
                    | "deleting"
                    | "checkingOutcome"
                    | "finished"
            )
        )
        && (s.state != "prepared"
            || (!i.dispatched
                && s.removal_phase.as_deref() == Some("awaitingConfirmation")
                && s.maintenance_active
                && i.recovery.is_some()))
        && (s.state != "ready"
            || (i.dispatched
                && s.removed.is_some()
                && s.recovery.is_some()
                && s.removal_phase.as_deref() == Some("finished")))
        && s.recovery.as_ref().is_none_or(|r| {
            i.recovery.as_ref().is_some_and(|v| {
                let mut expected = v.receipt.clone();
                expected.availability = r.availability.clone();
                expected == *r
            })
        })
        && s.removed.as_ref().is_none_or(|r| {
            s.state == "ready"
                && r.record_id == i.saved.archive.id
                && r.original_path == i.saved.archive.original_path
                && r.retained_path == i.saved.archive.retained_path
                && r.recovery_id == i.recovery_id
        })
}
