//! Actual format functions over synthetic payload bytes, NOT native SD/BackupRead.
use super::*;
use std::io::Cursor;
fn directory(id: u128, name: Vec<u16>) -> facet::Metadata {
    facet::Metadata {
        security_full: true,
        raw_leaf: name,
        source_volume: 7,
        source_id: id,
        created: 1,
        accessed: 2,
        modified: 3,
        attributes: 0x10,
    }
}
fn file(id: u128, name: Vec<u16>) -> regular::Metadata {
    regular::Metadata {
        raw_leaf: name,
        source_volume: 7,
        source_id: id,
        created: 1,
        accessed: 2,
        modified: 3,
        attributes: 0x20,
    }
}
fn typed(kind: Kind, id: u128, name: Vec<u16>) -> (Vec<u8>, [u8; 32]) {
    let native = [(id as u8) + 1; 20];
    let mut work = WorkBudget::new(super::super::material_carrier_records::WORK_LIMIT);
    let resident = Resident::new(super::super::material_carrier_records::RESIDENT_LIMIT);
    let cancel = AtomicBool::new(false);
    let mut output = Vec::new();
    let digest: [u8; 32] = Sha256::digest(native).into();
    let record = match kind {
        Kind::Directory => {
            facet::append(
                &mut Cursor::new(native),
                &mut output,
                &directory(id, name),
                &facet::NativeExtent {
                    bytes: 20,
                    sha256: digest,
                },
                &mut work,
                &cancel,
                &resident,
            )
            .unwrap();
            facet::verify_exact(&mut Cursor::new(&output), &mut work, &cancel, &resident)
                .unwrap()
                .record_sha256
        }
        Kind::Regular => {
            regular::append(
                &mut Cursor::new(native),
                &mut output,
                &file(id, name),
                &regular::NativeExtent {
                    bytes: 20,
                    sha256: digest,
                },
                &mut work,
                &cancel,
                &resident,
            )
            .unwrap();
            regular::verify_exact(&mut Cursor::new(&output), &mut work, &cancel, &resident)
                .unwrap()
                .record_sha256
        }
    };
    (output, record)
}
fn fixture(nodes: &[(Kind, u32, u128, Vec<u16>)]) -> Vec<u8> {
    let resident = Resident::new(super::super::material_carrier_records::RESIDENT_LIMIT);
    let mut work = WorkBudget::new(super::super::material_carrier_records::WORK_LIMIT);
    let cancel = AtomicBool::new(false);
    let mut output = Vec::new();
    let mut writer =
        Writer::begin(&mut output, nodes.len(), &mut work, &cancel, &resident).unwrap();
    for (kind, parent, id, name) in nodes {
        let (typed, hash) = typed(*kind, *id, name.clone());
        writer
            .append(
                Entry {
                    kind: *kind,
                    parent: *parent,
                },
                &mut Cursor::new(&typed),
                typed.len() as u64,
                hash,
                &mut work,
                &cancel,
            )
            .unwrap();
    }
    writer.finish(&mut work, &cancel).unwrap();
    output
}
fn ordinary() -> Vec<u8> {
    fixture(&[
        (Kind::Directory, ROOT, 1 << 100, vec![82]),
        (Kind::Directory, 0, (1 << 100) + 1, vec![68]),
        (Kind::Regular, 1, (1 << 100) + 2, vec![65, 0xd800]),
    ])
}
fn verify(b: &[u8]) -> Result<Verified> {
    verify_exact(
        &mut Cursor::new(b),
        &mut WorkBudget::new(super::super::material_carrier_records::WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(super::super::material_carrier_records::RESIDENT_LIMIT),
        |a, b| Ok(a == b),
    )
}
#[test]
fn complete_mixed_actual_typed_bytes_keep_directory_parent_and_raw_regular_extent() {
    let b = ordinary();
    let r = verify(&b).unwrap();
    assert_eq!(r.nodes.len(), 3);
    assert_eq!(r.bytes, b.len() as u64);
    assert_ne!(r.sha256, [0; 32]);
    assert_eq!(r.nodes[0].kind, Kind::Directory);
    assert_eq!(r.nodes[2].kind, Kind::Regular);
    assert_eq!(r.nodes[2].parent, 1);
    assert_eq!(r.nodes[2].metadata.raw_leaf, [65, 0xd800]);
    for n in &r.nodes {
        assert_eq!(n.metadata.source_volume, 7);
        assert!(n.metadata.source_id > 0);
        assert_eq!(
            (n.metadata.created, n.metadata.accessed, n.metadata.modified),
            (1, 2, 3)
        );
        assert!(n.metadata.attributes != 0);
        assert_eq!(n.native_bytes, 20);
        assert_eq!(
            n.native_start + n.native_bytes + 40,
            n.typed_start + n.typed_bytes
        );
        assert_ne!(n.native_sha256, [0; 32]);
        assert_ne!(n.record_sha256, [0; 32]);
        let x = &b[n.typed_start as usize..(n.typed_start + n.typed_bytes) as usize];
        assert!(x.starts_with(if n.kind == Kind::Directory {
            b"FFDIR1\0\0"
        } else {
            b"FFNODE1\0"
        }));
    }
}
#[test]
fn old_skeleton_header_and_regular_rejection_do_not_become_mixed_success() {
    let mixed = ordinary();
    let resident = Resident::new(super::super::material_carrier_records::RESIDENT_LIMIT);
    assert!(
        super::super::material_directory_tree_records::verify_exact(
            &mut Cursor::new(&mixed),
            &mut WorkBudget::new(super::super::material_carrier_records::WORK_LIMIT),
            &AtomicBool::new(false),
            &resident,
            |a, b| Ok(a == b)
        )
        .is_err()
    );
    let mut old = mixed.clone();
    old[..8].copy_from_slice(b"FFDTREE1");
    assert!(verify(&old).is_err());
    let mut partial = mixed;
    partial[12] = 0;
    assert!(verify(&partial).is_err());
}
#[test]
fn regular_root_or_parent_never_grants_child_authority() {
    let root = fixture(&[(Kind::Regular, ROOT, 1, vec![82])]);
    assert!(matches!(verify(&root), Err(Error::Unsupported)));
    let file_parent = fixture(&[
        (Kind::Directory, ROOT, 1, vec![82]),
        (Kind::Regular, 0, 2, vec![70]),
        (Kind::Regular, 1, 3, vec![67]),
    ]);
    assert!(matches!(verify(&file_parent), Err(Error::Unsupported)));
}
#[test]
fn duplicate_full_ids_alias_and_unknown_tags_stay_refused() {
    let alias = fixture(&[
        (Kind::Directory, ROOT, 1, vec![82]),
        (Kind::Regular, 0, 2, vec![65]),
        (Kind::Regular, 0, 2, vec![66]),
    ]);
    assert!(matches!(verify(&alias), Err(Error::Changed)));
    for tag in [0, 3, 255] {
        let mut b = ordinary();
        b[16] = tag;
        assert!(matches!(verify(&b), Err(Error::Unsupported)));
    }
}
#[test]
fn typed_kind_mismatch_forward_parent_and_case_insensitive_siblings_are_failures() {
    let mut b = ordinary();
    let r = verify(&b).unwrap();
    let prefix = r.nodes[2].typed_start as usize - 49;
    b[prefix] = 1;
    assert!(verify(&b).is_err());
    let mut b = ordinary();
    b[21..25].copy_from_slice(&0u32.to_le_bytes());
    assert!(matches!(verify(&b), Err(Error::Invalid)));
    let b = fixture(&[
        (Kind::Directory, ROOT, 1, vec![82]),
        (Kind::Regular, 0, 2, vec![65]),
        (Kind::Regular, 0, 3, vec![97]),
    ]);
    let r = verify_exact(
        &mut Cursor::new(&b),
        &mut WorkBudget::new(super::super::material_carrier_records::WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(super::super::material_carrier_records::RESIDENT_LIMIT),
        |a, b| {
            Ok(a.iter()
                .map(|v| if *v == 97 { 65 } else { *v })
                .eq(b.iter().map(|v| if *v == 97 { 65 } else { *v })))
        },
    );
    assert!(matches!(r, Err(Error::Changed)));
}
#[test]
fn truncated_corrupt_suffix_cancel_and_shared_budget_never_form_complete_input() {
    let b = ordinary();
    for cut in [0, 15, 65, b.len() - 1] {
        assert!(verify(&b[..cut]).is_err());
    }
    let mut changed = b.clone();
    changed[70] ^= 1;
    assert!(verify(&changed).is_err());
    let mut suffix = b.clone();
    suffix.push(0);
    assert!(verify(&suffix).is_err());
    for (cancel, limit) in [(true, 1024), (false, 15)] {
        assert!(
            verify_exact(
                &mut Cursor::new(&b),
                &mut WorkBudget::new(limit),
                &AtomicBool::new(cancel),
                &Resident::new(1024),
                |a, b| Ok(a == b)
            )
            .is_err()
        );
    }
}
