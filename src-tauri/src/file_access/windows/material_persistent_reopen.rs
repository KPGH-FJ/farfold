//! Cold reopen of a fixed retained carrier. The manifest provides expectations;
//! held identity, complete framing/native parsing and actual writes prove use.
use super::super::material_mixed_tree_input::{MixedSummary, NativeProof};
use super::*;
use crate::worktrees::{MaterialKind, WindowsMaterial};

pub(crate) fn with_reopened_material<T, F>(
    destination: MaterialStoreRequest,
    expected: &WindowsMaterial,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retired: &mut Option<MaterialStoreRetirement>,
    consume: F,
) -> Result<(T, MaterialSealReceipt)>
where
    F: for<'a> FnOnce(&mut OwnedSealedMaterial<'a>) -> Result<T>,
{
    if retired.is_some() {
        return Err(Error::CleanupUnknown);
    }
    check(cancel)?;
    if !expected.validate() {
        return Err(Error::Invalid);
    }
    let identity = Identity {
        device: expected.volume,
        inode: u128::from_le_bytes(expected.file_id),
    };
    let directories = expected
        .nodes
        .iter()
        .filter(|n| n.kind == MaterialKind::Directory)
        .count();
    let catalog = expected
        .nodes
        .iter()
        .map(|n| NativeProof::from_descriptor(n, &destination.resident, work, cancel))
        .collect::<Result<Vec<_>>>()?;
    let mut store = Box::new(Store {
        file: None,
        stopped: None,
        uncertain: false,
        mixed: None,
        verified: None,
        copied: Some(MixedBytes {
            content: expected.content.clone(),
            summary: MixedSummary {
                nodes: expected.nodes.len(),
                directories,
                regulars: expected.nodes.len() - directories,
                carrier_bytes: expected.bytes,
                carrier_sha256: expected.tree_sha256,
                carrier_identity: identity.clone(),
            },
            whole_sha256: expected.sha256,
            native_catalog: Some(catalog),
        }),
        published: true,
        reading: false,
        sealed_stamp: None,
        restore: None,
        request: destination,
    });
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        store.open(false)?;
        if stamp(store.file.as_ref().ok_or(Error::Invalid)?)
            .map_err(|e| io_error("materialReopenIdentity", e))?
            .identity
            != identity
        {
            return Err(Error::Changed);
        }
        let before = store.verify(work, cancel)?;
        // A valid outer carrier with invented native bytes cannot gain a
        // read/restore success merely because the digest agrees with the file.
        restore::validate_native(&store, work, cancel)?;
        let value = consume(&mut OwnedSealedMaterial {
            store: &mut store,
            work,
            cancel,
        })?;
        if store.verify(work, cancel)? != before {
            return Err(Error::Changed);
        }
        Ok((value, before))
    }))
    .unwrap_or(Err(Error::Unsupported));
    if let Err(cleanup_error) = store.cleanup_all() {
        *retired = Some(MaterialStoreRetirement {
            _store: store,
            _operation_error: result.err(),
            _cleanup_error: cleanup_error,
        });
        return Err(Error::CleanupUnknown);
    }
    result
}
