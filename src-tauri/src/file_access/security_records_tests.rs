use super::*;

fn test_sid(value: u32) -> Vec<u8> {
    let mut bytes = vec![1, 1, 0, 0, 0, 0, 0, 5];
    bytes.extend(value.to_le_bytes());
    bytes
}
fn packet(reverse_sids: bool, free_acl: usize, free_byte: u8) -> Vec<u8> {
    let mut bytes = vec![1, 0, 4, 0x80];
    bytes.extend((if reverse_sids { 32u32 } else { 20 }).to_le_bytes());
    bytes.extend((if reverse_sids { 20u32 } else { 32 }).to_le_bytes());
    bytes.extend(0u32.to_le_bytes());
    bytes.extend(44u32.to_le_bytes());
    for value in if reverse_sids { [200, 100] } else { [100, 200] } {
        bytes.extend(test_sid(value));
    }
    let mut ace = vec![0, 0, 20, 0];
    ace.extend(1u32.to_le_bytes());
    ace.extend(test_sid(18));
    bytes.extend([2, 0]);
    bytes.extend(((8 + ace.len() + free_acl) as u16).to_le_bytes());
    bytes.extend([1, 0, 0, 0]);
    bytes.extend(ace);
    bytes.resize(bytes.len() + free_acl, free_byte);
    bytes
}
fn observe(bytes: &[u8]) -> Result<Observation, Failure> {
    complete(
        bytes,
        &mut WorkBudget::new(QUERY_BYTES as u64),
        &AtomicBool::new(false),
    )
}
#[test]
fn offsets_and_acl_free_storage_are_not_permission_bytes() {
    let first = observe(&packet(false, 0, 0)).unwrap();
    assert_eq!(first.aces, 1);
    assert_eq!(first.logical_bytes, 72);
    assert_eq!(observe(&packet(true, 0, 0)).unwrap(), first);
    assert_eq!(observe(&packet(false, 8, 0xcd)).unwrap(), first);
    let mut changed = packet(false, 0, 0);
    changed[56] ^= 2; // ACCESS_MASK, not allocation/padding.
    assert_ne!(observe(&changed).unwrap(), first);
}
#[test]
fn absent_null_and_empty_dacl_stay_distinct() {
    let mut absent = vec![0u8; HEADER];
    absent[0] = 1;
    absent[3] = 0x80;
    let a = observe(&absent).unwrap();
    let mut null = absent.clone();
    null[2] = 4;
    let b = observe(&null).unwrap();
    let mut empty = null.clone();
    empty[16..20].copy_from_slice(&20u32.to_le_bytes());
    empty.extend([2, 0, 8, 0, 0, 0, 0, 0]);
    let c = observe(&empty).unwrap();
    assert_ne!(a, b);
    assert_ne!(b, c);
    assert_eq!(c.aces, 0);
}
#[test]
fn non_callback_alignment_is_ignored_but_callback_application_data_is_not() {
    let first = packet(false, 0, 0);
    let mut padded = first.clone();
    padded[46..48].copy_from_slice(&32u16.to_le_bytes()); // ACL allocation
    padded[54..56].copy_from_slice(&24u16.to_le_bytes()); // ACE includes tail
    padded.extend([0xcd; 4]);
    assert_eq!(observe(&padded).unwrap(), observe(&first).unwrap());
    let mut callback = padded.clone();
    callback[52] = 9; // ACCESS_ALLOWED_CALLBACK_ACE
    let a = observe(&callback).unwrap();
    *callback.last_mut().unwrap() ^= 1;
    assert_ne!(observe(&callback).unwrap(), a);
    let mut future = first;
    future[52] = 0x7f;
    assert_eq!(observe(&future), Err(Failure::Unsupported));
}
#[test]
fn all_truncations_offsets_overlap_and_unlinked_tail_refuse() {
    let good = packet(false, 0, 0);
    for n in 0..good.len() {
        assert!(observe(&good[..n]).is_err(), "prefix {n}");
    }
    for (at, value) in [(4, 1u32), (8, 0xffff_fffc), (16, 20)] {
        let mut bad = good.clone();
        bad[at..at + 4].copy_from_slice(&value.to_le_bytes());
        assert!(observe(&bad).is_err());
    }
    let mut tail = good.clone();
    tail.extend(test_sid(500));
    assert!(observe(&tail).is_err());
    let mut bad_count = good.clone();
    bad_count[48..50].copy_from_slice(&2u16.to_le_bytes());
    assert!(observe(&bad_count).is_err());
    let mut short_ace = good.clone();
    short_ace[54..56].copy_from_slice(&0u16.to_le_bytes());
    assert!(observe(&short_ace).is_err());
}
#[test]
fn unknown_sacl_absolute_and_sid_shapes_never_become_empty_security() {
    let good = packet(false, 0, 0);
    let mut absolute = good.clone();
    absolute[3] = 0;
    assert!(observe(&absolute).is_err());
    let mut sacl = good.clone();
    sacl[12..16].copy_from_slice(&20u32.to_le_bytes());
    assert!(observe(&sacl).is_err());
    for (at, value) in [(20, 2), (21, 16), (44, 5)] {
        let mut bad = good.clone();
        bad[at] = value;
        assert!(observe(&bad).is_err());
    }
}
#[test]
fn both_actual_spans_charge_the_same_budget_and_cancel_refuses() {
    let good = packet(false, 0, 0);
    let mut exact = WorkBudget::new((good.len() * 2) as u64);
    let cancel = AtomicBool::new(false);
    let a = complete(&good, &mut exact, &cancel).unwrap();
    assert_eq!(complete(&good, &mut exact, &cancel).unwrap(), a);
    assert_eq!(exact.remaining(), 0);
    let mut short = WorkBudget::new((good.len() * 2 - 1) as u64);
    complete(&good, &mut short, &cancel).unwrap();
    assert_eq!(complete(&good, &mut short, &cancel), Err(Failure::Limit));
    assert_eq!(
        complete(&good, &mut WorkBudget::new(100), &AtomicBool::new(true)),
        Err(Failure::Cancelled)
    );
}
