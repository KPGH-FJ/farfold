//! Windows-only owned-fixture observations; never an alternate production reader.
use super::*;
use serde_json::json;
use std::io::{Read, Write};

fn note<T>(variant: &str, phase: &str, ordinal: usize, result: io::Result<T>) -> io::Result<T> {
    let (ok, kind, code) = match &result {
        Ok(_) => (true, None, None),
        Err(error) => (
            false,
            Some(format!("{:?}", error.kind())),
            error.raw_os_error(),
        ),
    };
    eprintln!(
        "FARFOLD_NATIVE_PHASE {}",
        json!({"variant":variant,"phase":phase,"ordinal":ordinal,"ok":ok,"ioKind":kind,"rawOsCode":code})
    );
    result
}

fn required<T>(phase: &str, result: io::Result<T>) -> T {
    match result {
        Ok(value) => value,
        Err(_) => panic!("owned canonical fixture failed at {phase}; see fixed phase record"),
    }
}

fn metadata_note(
    variant: &str,
    ordinal: usize,
    result: Result<Option<EntryMetadata>, MetadataFailure>,
) {
    let record = match result {
        Ok(value) => {
            json!({"variant":variant,"phase":"metadataChild","ordinal":ordinal,"ok":true,"present":value.is_some(),"kind":value.map(|v|format!("{:?}",v.kind))})
        }
        Err(failure) => {
            json!({"variant":variant,"phase":"metadataChild","ordinal":ordinal,"ok":false,"nativePhase":failure.phase,"ioKind":format!("{:?}",failure.kind),"rawOsCode":failure.code,"ntStatus":failure.nt_status})
        }
    };
    eprintln!("FARFOLD_NATIVE_PHASE {record}");
}

fn identity_note(phase: &str, first: &Identity, second: &Identity) {
    eprintln!(
        "FARFOLD_NATIVE_PHASE {}",
        json!({"phase":phase,"volumeEqual":first.device==second.device,"file128Equal":first.inode==second.inode,"fullIdentityEqual":first==second})
    );
    assert!(
        first == second,
        "same owned object must keep full volume/file identity"
    );
}

// This exact owned-fixture handle is diagnostic only. It never substitutes for
// a rejected production path, and its result grants no read/write authority.
fn root_handle(path: &Path, share: u32) -> io::Result<File> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_GENERIC_READ,
            share,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_handle(raw) })
}

fn final_query(file: &File, flags: u32) -> io::Result<()> {
    let count = unsafe { GetFinalPathNameByHandleW(handle(file), ptr::null_mut(), 0, flags) };
    if count == 0 {
        return Err(io::Error::last_os_error());
    }
    if count > 32768 {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    let mut wide = vec![0u16; count as usize + 1];
    let length = unsafe {
        GetFinalPathNameByHandleW(handle(file), wide.as_mut_ptr(), wide.len() as u32, flags)
    };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize >= wide.len() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    // No raw path or digest is emitted, and no returned spelling is reopened.
    Ok(())
}

// A separate observation after a failed production call. It uses the original
// spelling and the same rights/shares; it cannot identify an unobserved branch
// retrospectively. Each actual native error remains its own phase record.
fn secondary_walk(variant: &str, path: &Path, pinned: bool) {
    if note(variant, "secondaryAbsolute", 0, absolute(path)).is_err() {
        return;
    }
    let mut parts = path.components();
    let Some(Component::Prefix(prefix)) = parts.next() else {
        return;
    };
    let drive = match prefix.kind() {
        Prefix::Disk(d) | Prefix::VerbatimDisk(d) => d,
        _ => return,
    };
    let share = FILE_SHARE_READ | FILE_SHARE_WRITE | if pinned { 0 } else { FILE_SHARE_DELETE };
    let root = std::path::PathBuf::from(format!("\\\\?\\{}:\\", drive as char));
    let Ok(mut parent) = note(variant, "secondaryRootCreate", 0, root_handle(&root, share)) else {
        return;
    };
    if note(variant, "secondaryRootStamp", 0, stamp(&parent)).is_err() {
        metadata_note(variant, 0, metadata_file(&parent).map(Some));
        return;
    }
    let _ = note(
        variant,
        "secondaryRootFinalDos",
        0,
        final_query(&parent, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS),
    );
    let _ = note(
        variant,
        "secondaryRootFinalGuid",
        0,
        final_query(&parent, FILE_NAME_NORMALIZED | VOLUME_NAME_GUID),
    );
    for (index, part) in parts.filter(|part| *part != Component::RootDir).enumerate() {
        assert!(
            index < 64,
            "owned fixture has an unexpected component count"
        );
        let Component::Normal(part) = part else {
            return;
        };
        match note(
            variant,
            "secondaryComponentOpenAndPolicy",
            index + 1,
            open_at_shared(&parent, part, true, false, share),
        ) {
            Ok(next) => {
                if note(variant, "secondaryComponentStamp", index + 1, stamp(&next)).is_err() {
                    return;
                }
                parent = next;
            }
            Err(_) => {
                metadata_note(variant, index + 1, metadata_child(&parent, part));
                return;
            }
        }
    }
}

#[test]
fn ci5_owned_original_and_canonical_open_stamp_and_metadata_phases() {
    let fixture = tempfile::tempdir().expect("exclusive diagnostic fixture");
    let original = fixture.path();
    let canonical = required(
        "canonicalize",
        note("canonical", "canonicalize", 0, original.canonicalize()),
    );
    for name in ["plain.txt", "Évidence.txt"] {
        required(
            "fixtureWrite",
            note(
                "fixture",
                "fixtureWrite",
                0,
                std::fs::write(original.join(name), b"owned fixed bytes"),
            ),
        );
    }
    required(
        "fixtureDirectory",
        note(
            "fixture",
            "fixtureDirectory",
            0,
            std::fs::create_dir(original.join("child")),
        ),
    );
    eprintln!(
        "FARFOLD_NATIVE_PHASE {}",
        json!({"phase":"fixtureSpelling","spellingChanged":original.as_os_str()!=canonical.as_os_str()})
    );

    let share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
    let a = required(
        "rawOwnedRoot",
        note(
            "original",
            "ownedRootHandle",
            0,
            root_handle(original, share),
        ),
    );
    let b = required(
        "canonicalOwnedRoot",
        note(
            "canonical",
            "ownedRootHandle",
            0,
            root_handle(&canonical, share),
        ),
    );
    let a_stamp = required(
        "rawOwnedStamp",
        note("original", "ownedRootStamp", 0, stamp(&a)),
    );
    let b_stamp = required(
        "canonicalOwnedStamp",
        note("canonical", "ownedRootStamp", 0, stamp(&b)),
    );
    identity_note(
        "originalCanonicalSameObject",
        &a_stamp.identity,
        &b_stamp.identity,
    );
    drop((a, b));

    // Original spelling may be a policy-rejected alias. It is not a fallback
    // or a prerequisite for the separate canonical positive.
    let original_pin = note("original", "pinnedOpen", 0, PinnedPath::directory(original));
    if original_pin.is_err() {
        secondary_walk("originalPinnedSecondary", original, true);
    }
    let original_delivery = note("original", "deliveryOpen", 0, open_directory(original));
    if original_delivery.is_err() {
        secondary_walk("originalDeliverySecondary", original, false);
    }
    let canonical_pin = note(
        "canonical",
        "pinnedOpen",
        0,
        PinnedPath::directory(&canonical),
    );
    if canonical_pin.is_err() {
        secondary_walk("canonicalPinnedSecondary", &canonical, true);
    }
    let canonical_delivery = note("canonical", "deliveryOpen", 0, open_directory(&canonical));
    if canonical_delivery.is_err() {
        secondary_walk("canonicalDeliverySecondary", &canonical, false);
    }
    let pin = required("canonicalPinnedOpen", canonical_pin);
    let directory = required("canonicalDeliveryOpen", canonical_delivery);
    let directory_stamp = required(
        "canonicalStamp",
        note("canonical", "deliveryStamp", 0, stamp(&directory)),
    );
    identity_note(
        "canonicalPinnedDeliverySameObject",
        pin.identity(),
        &directory_stamp.identity,
    );
    if let Ok(value) = original_pin {
        identity_note(
            "originalCanonicalPinnedSameObject",
            value.identity(),
            pin.identity(),
        );
    }
    if let Ok(value) = original_delivery {
        let observed = required(
            "originalDeliveryStamp",
            note("original", "deliveryStamp", 0, stamp(&value)),
        );
        identity_note(
            "originalCanonicalDeliverySameObject",
            &observed.identity,
            &directory_stamp.identity,
        );
    }
    for (ordinal, child) in ["plain.txt", "Évidence.txt", "child"]
        .into_iter()
        .enumerate()
    {
        let result = metadata_child(pin.file(), OsStr::new(child));
        metadata_note("canonical", ordinal + 1, result.clone());
        let observed = result
            .unwrap_or_else(|_| panic!("canonical metadata child failed; see phase record"))
            .expect("owned child must exist");
        assert_eq!(
            observed.kind,
            if ordinal == 2 {
                MetadataKind::Directory
            } else {
                MetadataKind::File
            }
        );
        if ordinal < 2 {
            let file = required(
                "canonicalChildOpen",
                note(
                    "canonical",
                    "childOpen",
                    ordinal + 1,
                    open_relative(&directory, Path::new(child)),
                ),
            );
            let full = required(
                "canonicalChildStamp",
                note("canonical", "childStamp", ordinal + 1, stamp(&file)),
            );
            identity_note(
                "metadataFull128MatchesActualChild",
                &observed.identity,
                &full.identity,
            );
        }
    }
    required("pinVerify", note("canonical", "pinVerify", 0, pin.verify()));
    // End of scope closes every handle before TempDir cleanup.
}

#[test]
fn ci5_canonical_exact_create_sync_publish_reopen_and_collision_phases() {
    const PAYLOAD: &[u8] = b"owned exact publication\n";
    const SENTINEL: &[u8] = b"keep existing target\n";
    let fixture = tempfile::tempdir().expect("exclusive diagnostic fixture");
    let canonical = required(
        "canonicalize",
        note(
            "publication",
            "canonicalize",
            0,
            fixture.path().canonicalize(),
        ),
    );
    let parent = required(
        "open",
        note("publication", "open", 0, open_directory(&canonical)),
    );
    let parent_before = required(
        "parentStamp",
        note("publication", "parentStamp", 0, stamp(&parent)),
    );
    let mut temporary = required(
        "create",
        note("publication", "create", 0, TemporaryExport::create(parent)),
    );
    required(
        "write",
        note("publication", "write", 0, temporary.file.write_all(PAYLOAD)),
    );
    required(
        "sync",
        note("publication", "sync", 0, temporary.file.sync_all()),
    );
    let before = required(
        "temporaryStamp",
        note("publication", "temporaryStamp", 0, stamp(&temporary.file)),
    );
    let published = note(
        "publication",
        "publish",
        0,
        temporary.publish(OsStr::new("published.txt")),
    );
    if published.is_err() {
        temporary.retain_unknown();
    }
    required("publish", published);
    let mut reopened = required(
        "reopen",
        note(
            "publication",
            "reopen",
            0,
            open_relative(&temporary.directory, Path::new("published.txt")),
        ),
    );
    let after = required(
        "reopenStamp",
        note("publication", "reopenStamp", 0, stamp(&reopened)),
    );
    identity_note(
        "publishedFull128SameObject",
        &before.identity,
        &after.identity,
    );
    let mut bytes = Vec::new();
    required(
        "readback",
        note(
            "publication",
            "readback",
            0,
            Read::by_ref(&mut reopened).take(64).read_to_end(&mut bytes),
        ),
    );
    assert_eq!(bytes, PAYLOAD);
    assert_eq!(after.size, PAYLOAD.len() as u64);
    let parent_after = required(
        "parentReopen",
        note("publication", "parentReopen", 0, open_directory(&canonical)),
    );
    let parent_stamp = required(
        "parentReopenStamp",
        note("publication", "parentReopenStamp", 0, stamp(&parent_after)),
    );
    identity_note(
        "publicationParentFull128Unchanged",
        &parent_before.identity,
        &parent_stamp.identity,
    );
    drop((reopened, temporary, parent_after));

    required(
        "sentinelWrite",
        note(
            "collision",
            "sentinelWrite",
            0,
            std::fs::write(canonical.join("existing.txt"), SENTINEL),
        ),
    );
    let parent = required(
        "open",
        note("collision", "open", 0, open_directory(&canonical)),
    );
    let existing = required(
        "existingOpen",
        note(
            "collision",
            "existingOpen",
            0,
            open_relative(&parent, Path::new("existing.txt")),
        ),
    );
    let existing_before = required(
        "existingStamp",
        note("collision", "existingStamp", 0, stamp(&existing)),
    );
    drop(existing);
    let mut temporary = required(
        "create",
        note("collision", "create", 0, TemporaryExport::create(parent)),
    );
    required(
        "write",
        note("collision", "write", 0, temporary.file.write_all(PAYLOAD)),
    );
    required(
        "sync",
        note("collision", "sync", 0, temporary.file.sync_all()),
    );
    let result = note(
        "collision",
        "publish",
        0,
        temporary.publish(OsStr::new("existing.txt")),
    );
    let collision = result
        .as_ref()
        .is_err_and(|e| e.kind() == io::ErrorKind::AlreadyExists);
    if !collision {
        temporary.retain_unknown();
    }
    let mut existing = required(
        "existingReopen",
        note(
            "collision",
            "existingReopen",
            0,
            open_relative(&temporary.directory, Path::new("existing.txt")),
        ),
    );
    let existing_after = required(
        "existingReopenStamp",
        note("collision", "existingReopenStamp", 0, stamp(&existing)),
    );
    identity_note(
        "collisionPreservesFull128ExistingObject",
        &existing_before.identity,
        &existing_after.identity,
    );
    let mut bytes = Vec::new();
    required(
        "existingReadback",
        note(
            "collision",
            "existingReadback",
            0,
            Read::by_ref(&mut existing).take(64).read_to_end(&mut bytes),
        ),
    );
    assert_eq!(bytes, SENTINEL);
    assert!(
        collision,
        "exact exclusive publication must reject the existing target as AlreadyExists"
    );
    required(
        "discard",
        note("collision", "discard", 0, temporary.discard()),
    );
}
