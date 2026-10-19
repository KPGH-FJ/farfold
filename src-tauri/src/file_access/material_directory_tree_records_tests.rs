use super::*;
use std::io::Cursor;
fn meta(id: u128, leaf: Vec<u16>) -> facet::Metadata {
    facet::Metadata {
        security_full: false,
        raw_leaf: leaf,
        source_volume: 7,
        source_id: id,
        created: 1,
        accessed: 2,
        modified: 3,
        attributes: 0x10,
    }
}
fn fixture(metas: Vec<(u32, facet::Metadata)>) -> Vec<u8> {
    let resident = Resident::new(super::super::material_carrier_records::RESIDENT_LIMIT);
    let mut work = WorkBudget::new(super::super::material_carrier_records::WORK_LIMIT);
    let cancel = AtomicBool::new(false);
    let mut output = Vec::new();
    let mut writer = Writer::begin(
        &mut output,
        metas.len(),
        false,
        &mut work,
        &cancel,
        &resident,
    )
    .unwrap();
    for (parent, meta) in metas {
        let mut typed = Vec::new();
        let extent = facet::NativeExtent {
            bytes: 0,
            sha256: Sha256::digest([]).into(),
        };
        let length = facet::append(
            &mut Cursor::new([]),
            &mut typed,
            &meta,
            &extent,
            &mut work,
            &cancel,
            &resident,
        )
        .unwrap();
        let verified =
            facet::verify_exact(&mut Cursor::new(&typed), &mut work, &cancel, &resident).unwrap();
        writer
            .append(
                parent,
                &mut Cursor::new(&typed),
                length,
                verified.record_sha256,
                &mut work,
                &cancel,
            )
            .unwrap();
    }
    writer.finish(&mut work, &cancel).unwrap();
    output
}
fn verify(bytes: &[u8]) -> Result<Verified> {
    verify_exact(
        &mut Cursor::new(bytes),
        &mut WorkBudget::new(super::super::material_carrier_records::WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(super::super::material_carrier_records::RESIDENT_LIMIT),
        |a, b| Ok(a == b),
    )
}
fn ordinary() -> Vec<u8> {
    fixture(vec![
        (ROOT, meta(1u128 << 100, vec![82])),
        (0, meta((1u128 << 100) + 1, vec![0x61, 0xd800])),
    ])
}
#[test]
fn streaming_two_actual_typed_records_keep_raw_parent_full_ids_and_native_ranges() {
    let b = ordinary();
    let result = verify(&b).unwrap();
    assert_eq!(result.nodes.len(), 2);
    assert!(!result.full);
    assert_eq!(result.bytes, b.len() as u64);
    assert_ne!(result.sha256, [0; 32]);
    let a = &result.nodes[0];
    let c = &result.nodes[1];
    assert_eq!(a.parent, ROOT);
    assert_eq!(c.parent, 0);
    assert_eq!(a.metadata.source_id, 1u128 << 100);
    assert_eq!(c.metadata.raw_leaf, [0x61, 0xd800]);
    for node in &result.nodes {
        assert_eq!(node.native_bytes, 0);
        let empty: [u8; 32] = Sha256::digest([]).into();
        assert_eq!(node.native_sha256, empty);
        assert_eq!(
            node.native_start + node.native_bytes + 40,
            node.typed_start + node.typed_bytes
        );
        assert_ne!(node.record_sha256, [0; 32]);
    }
}
#[test]
fn regular_alias_and_future_tags_are_not_skeleton_success() {
    for kind in [0, 2, 3, 255] {
        let mut b = ordinary();
        b[16] = kind;
        assert!(matches!(verify(&b), Err(Error::Unsupported)));
    }
}
#[test]
fn forward_parent_cycle_and_duplicate_directory_identity_are_refused() {
    let mut b = ordinary();
    b[21..25].copy_from_slice(&0u32.to_le_bytes());
    assert!(matches!(verify(&b), Err(Error::Invalid)));
    let b = fixture(vec![(ROOT, meta(99, vec![82])), (0, meta(99, vec![67]))]);
    assert!(matches!(verify(&b), Err(Error::Changed)));
}
#[test]
fn exact_sibling_duplicates_and_native_comparison_policy_are_not_ignored() {
    let b = fixture(vec![
        (ROOT, meta(1, vec![82])),
        (0, meta(2, vec![65])),
        (0, meta(3, vec![65])),
    ]);
    assert!(matches!(verify(&b), Err(Error::Changed)));
    let b = fixture(vec![
        (ROOT, meta(1, vec![82])),
        (0, meta(2, vec![65])),
        (0, meta(3, vec![97])),
    ]);
    let result = verify_exact(
        &mut Cursor::new(b),
        &mut WorkBudget::new(super::super::material_carrier_records::WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(super::super::material_carrier_records::RESIDENT_LIMIT),
        |a, b| {
            Ok(a.iter()
                .map(|v| if *v == 97 { 65 } else { *v })
                .eq(b.iter().map(|v| if *v == 97 { 65 } else { *v })))
        },
    );
    assert!(matches!(result, Err(Error::Changed)));
}
#[test]
fn truncation_payload_tamper_suffix_and_budget_fail_without_a_completed_tree() {
    let b = ordinary();
    for cut in [0, 15, 64, b.len() - 1] {
        assert!(verify(&b[..cut]).is_err());
    }
    let mut changed = b.clone();
    changed[65 + 20] ^= 1;
    assert!(verify(&changed).is_err());
    let mut extra = b.clone();
    extra.push(1);
    assert!(matches!(verify(&extra), Err(Error::Changed)));
    let limited = verify_exact(
        &mut Cursor::new(&b),
        &mut WorkBudget::new(15),
        &AtomicBool::new(false),
        &Resident::new(1024),
        |a, b| Ok(a == b),
    );
    assert!(matches!(limited, Err(Error::Limit)));
    let memory = verify_exact(
        &mut Cursor::new(&b),
        &mut WorkBudget::new(1024),
        &AtomicBool::new(false),
        &Resident::new(1),
        |a, b| Ok(a == b),
    );
    assert!(matches!(memory, Err(Error::Limit)));
}
#[test]
fn cancellation_and_unfinished_writer_cannot_emit_a_tree_completion() {
    let mut out = Vec::new();
    let resident = Resident::new(super::super::material_carrier_records::RESIDENT_LIMIT);
    let mut work = WorkBudget::new(1024);
    let cancelled = AtomicBool::new(true);
    assert!(matches!(
        Writer::begin(&mut out, 1, false, &mut work, &cancelled, &resident),
        Err(Error::Cancelled)
    ));
    assert!(out.is_empty());
    let cancel = AtomicBool::new(false);
    let writer = Writer::begin(&mut out, 1, false, &mut work, &cancel, &resident).unwrap();
    assert!(matches!(
        writer.finish(&mut work, &cancel),
        Err(Error::Invalid)
    ));
    assert_eq!(out.len(), 16);
}
