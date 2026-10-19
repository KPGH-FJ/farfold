//! Real same-owner/edge controls plus explicit FullSD composition only.
use super::*;
use crate::{
    file_access::{self, CarrierFailure as E, EaWorkBudget, MixedMemory, MixedRequest, PinnedPath},
    worktrees::{material_owner::Owner, recovery_pack::material},
};
use std::{io::Cursor, os::windows::ffi::OsStrExt};
fn budget() -> EaWorkBudget {
    EaWorkBudget::new(file_access::SHAPE_WORK_LIMIT)
}
#[test]
fn real_managed_edge_keeps_original_read_context_after_outer_graph_drop_until_last_owner() {
    let f = Fixture::new();
    let cancel = AtomicBool::new(false);
    let graph = SourceGraph::capture(&f.snapshot(), &cancel).unwrap();
    let before = f.bytes();
    let proof = graph.managed_root_git_edge();
    drop(graph);
    proof.verify(&mut budget(), &cancel).unwrap();
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(f.private.join("HEAD"))
            .is_err()
    );
    assert_eq!(f.bytes(), before);
    drop(proof);
    let reopened = fs::OpenOptions::new()
        .write(true)
        .open(f.private.join("HEAD"))
        .unwrap();
    drop(reopened);
}
#[test]
fn real_foreign_root_raw_name_and_actual_foreign_edge_never_mint_an_exclusion() {
    let f = Fixture::new();
    let cancel = AtomicBool::new(false);
    let graph = SourceGraph::capture(&f.snapshot(), &cancel).unwrap();
    let before = f.bytes();
    let proof = graph.managed_root_git_edge();
    let entries =
        file_access::directory_entries(&graph.owner.source.scope.root, 10, &cancel).unwrap();
    let (raw, listed) = entries
        .iter()
        .find(|(raw, _)| raw.as_slice() == [46, 103, 105, 116])
        .unwrap();
    proof
        .matches(graph.owner.source.scope.root.file(), raw, listed)
        .unwrap();
    let foreign = tempfile::tempdir().unwrap();
    fs::write(foreign.path().join(".git"), b"owned-foreign-edge").unwrap();
    let other = PinnedPath::directory(&foreign.path().canonicalize().unwrap()).unwrap();
    let foreign_entries = file_access::directory_entries(&other, 10, &cancel).unwrap();
    let foreign_listed = foreign_entries.get(raw).unwrap();
    assert!(matches!(
        proof.matches(graph.owner.source.scope.root.file(), raw, foreign_listed),
        Err(E::Changed)
    ));
    assert!(matches!(
        proof.matches(other.file(), raw, listed),
        Err(E::Changed)
    ));
    assert!(matches!(
        proof.matches(
            graph.owner.source.scope.root.file(),
            &[46, 103, 105, 116, 120],
            listed
        ),
        Err(E::Changed)
    ));
    assert_eq!(f.bytes(), before);
}
#[test]
fn managed_recheck_uses_original_shared_work_and_cancel_without_advancing_source() {
    let f = Fixture::new();
    let cancel = AtomicBool::new(false);
    let graph = SourceGraph::capture(&f.snapshot(), &cancel).unwrap();
    let before = f.bytes();
    let proof = graph.managed_root_git_edge();
    assert!(matches!(
        proof.verify(&mut EaWorkBudget::new(0), &cancel),
        Err(E::Limit)
    ));
    assert!(matches!(
        proof.verify(&mut budget(), &AtomicBool::new(true)),
        Err(E::Cancelled)
    ));
    proof.verify(&mut budget(), &cancel).unwrap();
    assert_eq!(f.bytes(), before);
}
fn request(
    f: &Fixture,
    graph: &SourceGraph,
    memory: &MixedMemory,
    cancel: &AtomicBool,
) -> MixedRequest {
    material::worktree_source(
        graph,
        PinnedPath::directory_full_security(&f.root).unwrap(),
        f.root.file_name().unwrap().encode_wide().collect(),
        memory,
        cancel,
    )
    .unwrap()
}
#[test]
#[ignore = "manual: explicit combined FullSecurity access on every owned source, no privilege change/fallback"]
fn actual_worktree_capsule_excludes_only_root_git_and_keeps_nested_git_bytes_after_source_close() {
    let f = Fixture::new();
    let cancel = AtomicBool::new(false);
    fs::create_dir(f.root.join("nested")).unwrap();
    fs::write(f.root.join("nested/.git"), b"nested-git-is-real-payload").unwrap();
    let graph = SourceGraph::capture(&f.snapshot(), &cancel).unwrap();
    let memory = MixedMemory::default();
    let source = request(&f, &graph, &memory, &cancel);
    let destination = f.root.parent().unwrap().join("reserved-capsule-material");
    fs::create_dir(&destination).unwrap();
    let parent = PinnedPath::directory(destination.parent().unwrap()).unwrap();
    let target = parent
        .child(
            &"reserved-capsule-material"
                .encode_utf16()
                .collect::<Vec<_>>(),
            true,
        )
        .unwrap();
    let dest = material::reserved(
        destination.parent().unwrap(),
        &destination,
        &inspect::pinned_stamp(&parent).unwrap(),
        &inspect::pinned_stamp(&target).unwrap(),
        &memory,
    )
    .unwrap();
    drop((parent, target, graph));
    let owner = Owner::default();
    let (_, receipt) = owner
        .sealed_material(source, dest, &cancel, |sealed| {
            let receipt = sealed.verify()?;
            assert_eq!(
                (receipt.nodes, receipt.directories, receipt.regulars),
                (4, 2, 2)
            );
            // Only the original SourceOwner kept these locks. Mixed known cleanup
            // released it before the published material reader is called.
            let moved = f.root.with_file_name("removed-capsule-source");
            fs::rename(&f.root, &moved).unwrap();
            fs::remove_dir_all(moved).unwrap();
            let _lease = sealed.reserve_output(2 * 65536)?;
            let mut output = vec![0u8; 65536];
            let mut found_nested = false;
            let mut found_public = false;
            for index in 0..receipt.nodes {
                let mut cursor = Cursor::new(output.as_mut_slice());
                sealed.copy_node(index, &mut cursor)?;
                let used = cursor.position() as usize;
                found_nested |= output[..used]
                    .windows(b"nested-git-is-real-payload".len())
                    .any(|w| w == b"nested-git-is-real-payload");
                found_public |= output[..used]
                    .windows(b"public\n".len())
                    .any(|w| w == b"public\n");
            }
            assert!(found_nested && found_public);
            Ok(())
        })
        .unwrap();
    assert_eq!(receipt.nodes, 4);
    assert!(destination.join("material.bin").is_file());
    assert!(!owner.occupied());
}
#[test]
#[ignore = "manual: explicit combined FullSecurity access on every owned source, no privilege change/fallback"]
fn actual_managed_private_namespace_change_during_consumer_fails_final_source_fence() {
    let f = Fixture::new();
    let cancel = AtomicBool::new(false);
    let graph = SourceGraph::capture(&f.snapshot(), &cancel).unwrap();
    let memory = MixedMemory::default();
    let source = request(&f, &graph, &memory, &cancel);
    let mut retired = None;
    let marker = f.private.join("unrecognized-after-consumer");
    let result = file_access::with_mixed_tree_input(
        source,
        &mut budget(),
        &cancel,
        &mut retired,
        |mut input| {
            input.verify()?;
            fs::write(&marker, b"owned-change").unwrap();
            Ok(())
        },
    );
    assert!(matches!(result, Err(E::Changed)));
    assert!(retired.is_none());
    drop(graph);
    fs::remove_file(marker).unwrap();
}

#[test]
fn actual_same_pinned_inventory_query_charges_returned_bytes_and_preserves_complete_legacy_listing()
{
    use std::io::Seek;
    let f = Fixture::new();
    let cancel = AtomicBool::new(false);
    let graph = SourceGraph::capture(&f.snapshot(), &cancel).unwrap();
    let before = f.bytes();
    let pin = &graph.owner.source.scope.git;
    let original = file_access::directory_entries(pin, MAX_ENTRIES - 1, &cancel).unwrap();
    let mut work = budget();
    let initial = work.remaining();
    let actual =
        file_access::directory_entries_with_work(pin, MAX_ENTRIES - 1, &cancel, &mut work).unwrap();
    assert_eq!(actual, original);
    assert!(work.remaining() < initial);
    assert!(matches!(
        file_access::directory_entries_with_work(
            pin,
            MAX_ENTRIES - 1,
            &cancel,
            &mut EaWorkBudget::new(0)
        ),
        Err(file_access::DirectoryFailure::Limit)
    ));
    assert_eq!(
        file_access::directory_entries(pin, MAX_ENTRIES - 1, &cancel).unwrap(),
        original
    );
    graph.recheck(&cancel).unwrap();
    assert_eq!(f.bytes(), before);
    // Exact leaf size+1 admission is separate from returned directory pages.
    // An insufficient reservation must not start any original leaf reader.
    let fee = graph
        .owner
        .inventory
        .leaves
        .iter()
        .filter(|l| l.sha256.is_some())
        .map(|l| l.before.size + 1)
        .sum::<u64>();
    assert!(fee > 0);
    for leaf in &graph.owner.inventory.leaves {
        if leaf.sha256.is_some() {
            let mut file = leaf.pin.file();
            file.rewind().unwrap();
        }
    }
    let proof = graph.managed_root_git_edge();
    assert!(matches!(
        proof.verify(&mut EaWorkBudget::new(fee - 1), &cancel),
        Err(E::Limit)
    ));
    for leaf in &graph.owner.inventory.leaves {
        if leaf.sha256.is_some() {
            let mut file = leaf.pin.file();
            assert_eq!(file.stream_position().unwrap(), 0);
        }
    }
    let mut leaf_only = EaWorkBudget::new(fee);
    assert!(matches!(
        proof.verify(&mut leaf_only, &cancel),
        Err(E::Limit)
    ));
    assert_eq!(leaf_only.remaining(), 0);
    for leaf in &graph.owner.inventory.leaves {
        if leaf.sha256.is_some() {
            let mut file = leaf.pin.file();
            assert_eq!(file.stream_position().unwrap(), leaf.before.size);
        }
    }
}

fn owned_metadata_leaf(path: &std::path::Path, before: Option<crate::file_access::Stamp>) -> Leaf {
    let pin = PinnedPath::regular(path).unwrap();
    let before = before.unwrap_or_else(|| file_access::stamp(pin.file()).unwrap());
    Leaf {
        path: "HEAD".into(),
        pin,
        before,
        sha256: None,
    }
}
#[test]
fn actual_git_metadata_reader_keeps_complete_eof_for_zero_small_and_existing_file_limit() {
    use std::io::Seek;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    for bytes in [0, 3, FILE_BYTES] {
        let path = root.join(format!("owned-metadata-{bytes}"));
        fs::File::create(&path).unwrap().set_len(bytes).unwrap();
        let leaf = owned_metadata_leaf(&path, None);
        let before = leaf.before.clone();
        let raw = read(&leaf, &AtomicBool::new(false)).unwrap();
        assert_eq!(raw.len() as u64, bytes);
        assert!(raw.iter().all(|b| *b == 0));
        assert_eq!(file_access::stamp(leaf.pin.file()).unwrap(), before);
        let mut cursor = leaf.pin.file();
        assert_eq!(cursor.stream_position().unwrap(), bytes);
    }
}
#[test]
fn actual_git_metadata_growth_shrink_cancel_and_over_limit_refuse_with_size_plus_one_offer() {
    use std::io::Seek;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    for (old, new, position) in [(1, 8, 2), (8, 1, 1)] {
        let path = root.join(format!("owned-change-{old}-{new}"));
        fs::write(&path, vec![65u8; old]).unwrap();
        let before = {
            let pin = PinnedPath::regular(&path).unwrap();
            file_access::stamp(pin.file()).unwrap()
        };
        // Mutate only after the first owned pin closes, then provide a known
        // stale stored version. This is not proof of concurrent write bypass.
        fs::write(&path, vec![66u8; new]).unwrap();
        let leaf = owned_metadata_leaf(&path, Some(before.clone()));
        assert_ne!(file_access::stamp(leaf.pin.file()).unwrap(), before);
        assert_eq!(
            read(&leaf, &AtomicBool::new(false)).unwrap_err().code,
            "recoveryChanged"
        );
        let mut cursor = leaf.pin.file();
        assert_eq!(cursor.stream_position().unwrap(), position);
    }
    let path = root.join("owned-over-limit");
    fs::File::create(&path)
        .unwrap()
        .set_len(FILE_BYTES + 1)
        .unwrap();
    let leaf = owned_metadata_leaf(&path, None);
    assert_eq!(
        read(&leaf, &AtomicBool::new(false)).unwrap_err().code,
        "recoveryLimit"
    );
    let mut cursor = leaf.pin.file();
    assert_eq!(cursor.stream_position().unwrap(), 0);
    assert_eq!(
        read(&leaf, &AtomicBool::new(true)).unwrap_err().code,
        "cancelled"
    );
    assert_eq!(cursor.stream_position().unwrap(), 0);
}
