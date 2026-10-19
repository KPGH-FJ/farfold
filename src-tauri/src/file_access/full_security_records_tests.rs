use super::*;

fn sid(rid: u32) -> Vec<u8> {
    let mut value = vec![1, 1, 0, 0, 0, 0, 0, 5];
    value.extend(rid.to_le_bytes());
    value
}
fn ace(kind: u8, rid: u32, tail: &[u8]) -> Vec<u8> {
    let mut value = vec![kind, 0x40, 0, 0];
    value.extend(1u32.to_le_bytes());
    if [5, 6, 7, 11, 12, 15].contains(&kind) {
        value.extend(0u32.to_le_bytes());
    }
    value.extend(sid(rid));
    value.extend(tail);
    while !value.len().is_multiple_of(4) {
        value.push(0xa5);
    }
    let size = value.len() as u16;
    value[2..4].copy_from_slice(&size.to_le_bytes());
    value
}
fn acl(entries: &[Vec<u8>]) -> Vec<u8> {
    let mut value = vec![4, 0, 0, 0, 0, 0, 0, 0];
    for entry in entries {
        value.extend(entry);
    }
    let size = value.len() as u16;
    value[2..4].copy_from_slice(&size.to_le_bytes());
    value[4..6].copy_from_slice(&(entries.len() as u16).to_le_bytes());
    value
}
fn descriptor(sacl: Option<&[u8]>, dacl: Option<&[u8]>) -> Vec<u8> {
    let mut value = vec![1, 0, 0, 0];
    value.resize(HEADER, 0);
    let mut control = SELF_RELATIVE;
    for (slot, flag, bytes) in [(12, SACL_PRESENT, sacl), (16, DACL_PRESENT, dacl)] {
        if let Some(bytes) = bytes {
            control |= flag;
            let at = value.len() as u32;
            value[slot..slot + 4].copy_from_slice(&at.to_le_bytes());
            value.extend(bytes);
        }
    }
    value[2..4].copy_from_slice(&control.to_le_bytes());
    value
}
fn parse(bytes: &[u8]) -> Result<Decoded, Failure> {
    complete(
        bytes,
        &mut WorkBudget::new(QUERY_BYTES as u64),
        &AtomicBool::new(false),
    )
}

#[test]
fn full_decoder_retains_audit_callback_resource_order_and_every_returned_byte() {
    let audit = ace(2, 40, &[]);
    let callback = ace(13, 41, b"opaque\0\xff");
    let resource = ace(18, 42, b"attributes\0\x80");
    let sacl = acl(&[audit.clone(), callback.clone(), resource]);
    let bytes = descriptor(Some(&sacl), Some(&acl(&[ace(0, 43, &[])])));
    let first = parse(&bytes).unwrap();
    assert_eq!(first.aces, 4);
    assert_eq!(first.returned_bytes, bytes.len() as u64);
    let mut changed = bytes.clone();
    changed[44] ^= 1; // audit SID subauthority, same total size
    assert_ne!(parse(&changed).unwrap().sha256, first.sha256);
    let reordered = descriptor(
        Some(&acl(&[callback, audit])),
        Some(&acl(&[ace(0, 43, &[])])),
    );
    assert_ne!(parse(&reordered).unwrap().sha256, first.sha256);
    let mut unused = bytes.clone();
    unused[1] = 0xa5; // raw returned representation, not inferred access meaning
    assert_ne!(parse(&unused).unwrap().sha256, first.sha256);
}
#[test]
fn absent_null_empty_sacl_are_distinct_decoded_data_not_a_native_request_proof() {
    let absent = descriptor(None, None);
    let mut null = absent.clone();
    null[2..4].copy_from_slice(&(SELF_RELATIVE | SACL_PRESENT).to_le_bytes());
    let empty = descriptor(Some(&acl(&[])), None);
    let hashes = [
        parse(&absent).unwrap().sha256,
        parse(&null).unwrap().sha256,
        parse(&empty).unwrap().sha256,
    ];
    assert_ne!(hashes[0], hashes[1]);
    assert_ne!(hashes[0], hashes[2]);
    assert_ne!(hashes[1], hashes[2]);
    // This module exposes only Decoded; native Observation's fields remain
    // private in windows/security_full and cannot be minted by this parser.
}
#[test]
fn object_sid_and_both_acl_ranges_refuse_truncation_overlap_and_unlinked_tail() {
    let valid = descriptor(
        Some(&acl(&[ace(7, 40, &[])])),
        Some(&acl(&[ace(5, 41, &[])])),
    );
    parse(&valid).unwrap();
    for end in 0..valid.len() {
        assert!(parse(&valid[..end]).is_err(), "truncated descriptor {end}");
    }
    let mut overlap = valid.clone();
    overlap[16..20].copy_from_slice(&20u32.to_le_bytes());
    assert!(parse(&overlap).is_err());
    let mut unlinked = valid.clone();
    unlinked.extend(acl(&[ace(2, 42, &[])]));
    assert!(parse(&unlinked).is_err());
    let mut outside = valid.clone();
    outside[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(parse(&outside).is_err());
}
#[test]
fn unknown_layout_bad_size_object_flags_and_acl_kind_are_never_silently_dropped() {
    for kind in [3, 4, 8, 14, 16, 22, 255] {
        assert_eq!(
            parse(&descriptor(Some(&acl(&[ace(kind, 40, &[])])), None)),
            Err(Failure::Unsupported)
        );
    }
    let mut object = ace(7, 40, &[]);
    object[8..12].copy_from_slice(&4u32.to_le_bytes());
    assert_eq!(
        parse(&descriptor(Some(&acl(&[object])), None)),
        Err(Failure::Unsupported)
    );
    assert_eq!(
        parse(&descriptor(None, Some(&acl(&[ace(2, 40, &[])])))),
        Err(Failure::Unsupported)
    );
    let mut bad = descriptor(Some(&acl(&[ace(2, 40, &[])])), None);
    bad[30..32].copy_from_slice(&3u16.to_le_bytes());
    assert_eq!(parse(&bad), Err(Failure::InvalidRecord));
}
#[test]
fn owner_and_group_may_share_one_sid_but_neither_can_overlap_the_sacl() {
    let mut bytes = descriptor(Some(&acl(&[ace(2, 40, &[])])), None);
    let at = bytes.len() as u32;
    bytes[4..8].copy_from_slice(&at.to_le_bytes());
    bytes[8..12].copy_from_slice(&at.to_le_bytes());
    bytes.extend(sid(44));
    parse(&bytes).unwrap();
    bytes[4..8].copy_from_slice(&28u32.to_le_bytes());
    assert!(parse(&bytes).is_err());
}
#[test]
fn two_full_queries_charge_the_same_work_and_cancel_does_not_publish_an_empty_sacl() {
    let bytes = descriptor(Some(&acl(&[ace(2, 40, &[])])), None);
    let mut budget = WorkBudget::new((bytes.len() * 2) as u64);
    let cancel = AtomicBool::new(false);
    let first = complete(&bytes, &mut budget, &cancel).unwrap();
    assert_eq!(complete(&bytes, &mut budget, &cancel).unwrap(), first);
    assert_eq!(budget.remaining(), 0);
    assert_eq!(complete(&bytes, &mut budget, &cancel), Err(Failure::Limit));
    assert_eq!(
        complete(&bytes, &mut WorkBudget::new(65536), &AtomicBool::new(true)),
        Err(Failure::Cancelled)
    );
}
