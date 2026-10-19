use super::*;
fn ace(rid: u32, mask: u32) -> Vec<u8> {
    let mut out = vec![0x11, 0, 20, 0];
    out.extend(mask.to_le_bytes());
    out.extend([1, 1, 0, 0, 0, 0, 0, 16]);
    out.extend(rid.to_le_bytes());
    out
}
fn descriptor(aces: &[Vec<u8>]) -> Vec<u8> {
    let mut out = vec![0u8; 20];
    out[0] = 1;
    out[2..4].copy_from_slice(&0x8010u16.to_le_bytes());
    out[12..16].copy_from_slice(&20u32.to_le_bytes());
    let length = 8 + aces.iter().map(Vec::len).sum::<usize>();
    out.extend([2, 0]);
    out.extend((length as u16).to_le_bytes());
    out.extend((aces.len() as u16).to_le_bytes());
    out.extend([0, 0]);
    for value in aces {
        out.extend(value);
    }
    out
}
fn observe(bytes: &[u8]) -> Result<Observation, Failure> {
    complete(
        bytes,
        &mut WorkBudget::new(QUERY_BYTES as u64),
        &AtomicBool::new(false),
    )
}
#[test]
fn absent_null_empty_and_stored_label_are_distinct_not_full_sacl() {
    let mut absent = vec![0; 20];
    absent[0] = 1;
    absent[2..4].copy_from_slice(&0x8000u16.to_le_bytes());
    let mut null = absent.clone();
    null[2..4].copy_from_slice(&0x8010u16.to_le_bytes());
    let empty = descriptor(&[]);
    let label = descriptor(&[ace(0x2000, 1)]);
    let values = [&absent, &null, &empty, &label].map(|v| observe(v).unwrap());
    for i in 0..values.len() {
        for j in i + 1..values.len() {
            assert_ne!(values[i].sha256, values[j].sha256);
        }
    }
    assert_eq!(values[3].labels, 1);
    assert_eq!(values[3].logical_bytes, 48);
}
#[test]
fn rid_mask_flags_and_order_change_hash_while_offsets_and_free_storage_do_not() {
    let original = descriptor(&[ace(0x2000, 1)]);
    let first = observe(&original).unwrap();
    assert_ne!(observe(&descriptor(&[ace(0x1000, 1)])).unwrap(), first);
    assert_ne!(observe(&descriptor(&[ace(0x2000, 2)])).unwrap(), first);
    let mut flags = original.clone();
    flags[29] = 0x10;
    assert_ne!(observe(&flags).unwrap(), first);
    let mut padding = original.clone();
    padding[20 + 2..20 + 4].copy_from_slice(&36u16.to_le_bytes());
    padding.extend([0x77; 8]);
    assert_eq!(observe(&padding).unwrap(), first);
    let mut relocated = original[..20].to_vec();
    relocated[12..16].copy_from_slice(&32u32.to_le_bytes());
    relocated.extend([0xaa; 12]);
    relocated.extend_from_slice(&original[20..]);
    assert_eq!(observe(&relocated).unwrap(), first);
    let a = ace(0x1000, 1);
    let b = ace(0x2000, 2);
    assert_ne!(
        observe(&descriptor(&[a.clone(), b.clone()])).unwrap(),
        observe(&descriptor(&[b, a])).unwrap()
    );
}
#[test]
fn every_truncation_bad_span_and_unlinked_tail_is_refused() {
    let valid = descriptor(&[ace(0x2000, 1)]);
    for n in 0..valid.len() {
        assert!(observe(&valid[..n]).is_err(), "prefix {n}");
    }
    for offset in [1u32, 16, 21, u32::MAX] {
        let mut bad = valid.clone();
        bad[12..16].copy_from_slice(&offset.to_le_bytes());
        assert!(observe(&bad).is_err());
    }
    let mut tail = valid.clone();
    tail.extend(ace(0x1000, 1));
    assert!(observe(&tail).is_err());
    let mut missing = valid.clone();
    missing[24..26].copy_from_slice(&2u16.to_le_bytes());
    assert!(observe(&missing).is_err());
    let mut size = valid.clone();
    size[30..32].copy_from_slice(&24u16.to_le_bytes());
    assert!(observe(&size).is_err());
    assert!(observe(&vec![0; QUERY_BYTES + 1]).is_err());
}
#[test]
fn unexpected_full_audit_other_sections_sid_and_absolute_records_are_not_labels() {
    let valid = descriptor(&[ace(0x2000, 1)]);
    let mut audit = valid.clone();
    audit[28] = 2;
    assert_eq!(observe(&audit), Err(Failure::Unsupported));
    for index in [4usize, 8, 16] {
        let mut other = valid.clone();
        other[index..index + 4].copy_from_slice(&20u32.to_le_bytes());
        assert_eq!(observe(&other), Err(Failure::Unsupported));
    }
    for index in [36usize, 37, 43] {
        let mut bad = valid.clone();
        bad[index] ^= 1;
        assert_eq!(observe(&bad), Err(Failure::Unsupported));
    }
    let mut absolute = valid.clone();
    absolute[3] &= !0x80;
    assert_eq!(observe(&absolute), Err(Failure::Unsupported));
    let mut not_present = valid.clone();
    not_present[2] &= !0x10;
    assert_eq!(observe(&not_present), Err(Failure::InvalidRecord));
}
#[test]
fn actual_returned_spans_both_charge_shared_work_and_cancel_cannot_return_empty() {
    let valid = descriptor(&[ace(0x2000, 1)]);
    let cancel = AtomicBool::new(false);
    let mut budget = WorkBudget::new((2 * valid.len()) as u64);
    let first = complete(&valid, &mut budget, &cancel).unwrap();
    assert_eq!(complete(&valid, &mut budget, &cancel).unwrap(), first);
    assert_eq!(complete(&valid, &mut budget, &cancel), Err(Failure::Limit));
    assert_eq!(
        complete(&valid, &mut WorkBudget::new(65536), &AtomicBool::new(true)),
        Err(Failure::Cancelled)
    );
}
