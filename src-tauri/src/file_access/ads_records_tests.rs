//! Portable DATA stream reducer controls; no native Windows proof.
use super::*;

const MINIMUM: usize = 33; // Test offer contract; no sizeof/native claim.
const ABC_SHA: [u8; 32] = [
    0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
    0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
];
const EMPTY_SHA: [u8; 32] = [
    0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f, 0xb9, 0x24,
    0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b, 0x78, 0x52, 0xb8, 0x55,
];
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn inventory_packet(items: &[(&[u16], i64, i64)], padding: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    for (index, (name, size, allocation)) in items.iter().enumerate() {
        let length = INVENTORY_HEADER + name.len() * 2;
        let span = (length + 7) & !7;
        let next = if index + 1 == items.len() {
            0
        } else {
            span as u32
        };
        bytes.extend(next.to_le_bytes());
        bytes.extend(((name.len() * 2) as u32).to_le_bytes());
        bytes.extend(size.to_le_bytes());
        bytes.extend(allocation.to_le_bytes());
        for unit in *name {
            bytes.extend(unit.to_le_bytes());
        }
        if next != 0 {
            bytes.resize(bytes.len() + span - length, padding);
        }
    }
    bytes
}
fn inventory(raw: &[u8]) -> Result<Inventory, Failure> {
    Inventory::decode(
        0,
        raw.len(),
        raw,
        &mut WorkBudget::new(1 << 20),
        &AtomicBool::new(false),
        |left, right| Ok(left.cmp(right)),
    )
}
fn backup(id: u32, attributes: u32, name: &[u16], body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend(id.to_le_bytes());
    bytes.extend(attributes.to_le_bytes());
    bytes.extend((body.len() as u64).to_le_bytes());
    bytes.extend(((name.len() * 2) as u32).to_le_bytes());
    for unit in name {
        bytes.extend(unit.to_le_bytes());
    }
    bytes.extend(body);
    bytes
}
fn decode_parts(inventory: &Inventory, parts: &[&[u8]]) -> Result<Observation, Failure> {
    let mut budget = WorkBudget::new(4 << 20);
    let cancel = AtomicBool::new(false);
    let mut streams = Streams::new(inventory, &mut budget, &cancel, MINIMUM)?;
    for part in parts.iter().filter(|part| !part.is_empty()) {
        assert!(streams.offer()? >= part.len());
        assert_eq!(streams.push(part)?, None);
    }
    streams.offer()?;
    streams.push(&[])?.ok_or(Failure::InvalidRecord)
}
fn two_streams() -> (Inventory, Vec<u8>) {
    let name = wide(":资料:$DATA");
    let inv = inventory(&inventory_packet(
        &[(&DEFAULT_SPELLING, 3, 4096), (&name, 4, 4096)],
        0xc7,
    ))
    .unwrap();
    let mut wire = backup(1, 0, &[], b"abc");
    wire.extend(backup(4, 0, &name, b"a\0\xffz"));
    (inv, wire)
}

#[test]
fn data_hash_and_all_header_name_payload_splits_use_the_real_reducer() {
    let (inv, bytes) = two_streams();
    let expected = decode_parts(&inv, &[&bytes]).unwrap();
    assert_eq!(expected.count, 2);
    assert_eq!(expected.logical_bytes, 7);
    assert_eq!(expected.default_size, 3);
    assert!(expected.default_present);
    assert_eq!(expected.default_sha256, ABC_SHA);
    // Includes every header/name/body boundary, embedded NUL and 0xff DATA.
    for split in 0..=bytes.len() {
        assert_eq!(
            decode_parts(&inv, &[&bytes[..split], &bytes[split..]]).unwrap(),
            expected,
            "split {split}"
        );
    }
    let bytewise = bytes.chunks(1).collect::<Vec<_>>();
    assert_eq!(decode_parts(&inv, &bytewise).unwrap(), expected);
    let mut altered = bytes.clone();
    *altered.last_mut().unwrap() ^= 1;
    assert_ne!(
        decode_parts(&inv, &[&altered]).unwrap().sha256,
        expected.sha256
    );
}

#[test]
fn one_million_byte_body_uses_short_reads_and_known_sha256_vector() {
    // Public SHA-256 million-'a' vector, independent of reducer framing.
    let expected = [
        0xcd, 0xc7, 0x6e, 0x5c, 0x99, 0x14, 0xfb, 0x92, 0x81, 0xa1, 0xc7, 0xe2, 0x84, 0xd7, 0x3e,
        0x67, 0xf1, 0x80, 0x9a, 0x48, 0xa4, 0x97, 0x20, 0x0e, 0x04, 0x6d, 0x39, 0xcc, 0xc7, 0x11,
        0x2c, 0xd0,
    ];
    let inv = inventory(&inventory_packet(&[(&[], 1_000_000, 1_003_520)], 0)).unwrap();
    // Only the test fixture allocates a full payload. Production Body retains
    // one digest plus a remaining byte count and hashes the borrowed chunks.
    let wire = backup(1, 0, &[], &vec![b'a'; 1_000_000]);
    let chunks = wire.chunks(65_535).collect::<Vec<_>>();
    let result = decode_parts(&inv, &chunks).unwrap();
    assert_eq!(result.default_size, 1_000_000);
    assert_eq!(result.default_sha256, expected);
}

#[test]
fn every_truncated_prefix_fails_even_when_a_prefix_ends_at_an_earlier_record() {
    let (inv, bytes) = two_streams();
    for length in 0..bytes.len() {
        assert!(
            decode_parts(&inv, &[&bytes[..length]]).is_err(),
            "prefix {length}"
        );
    }
    assert!(decode_parts(&inv, &[&bytes]).is_ok());
}

#[test]
fn exact_pairing_refuses_duplicate_extra_missing_size_and_spelling_changes() {
    let (inv, bytes) = two_streams();
    let mut duplicate = bytes.clone();
    duplicate.extend(backup(1, 0, &[], b"abc"));
    assert_eq!(decode_parts(&inv, &[&duplicate]), Err(Failure::Changed));
    let mut extra = bytes.clone();
    extra.extend(backup(4, 0, &wide(":extra:$DATA"), b"x"));
    assert_eq!(decode_parts(&inv, &[&extra]), Err(Failure::Changed));
    assert_eq!(
        decode_parts(&inv, &[&backup(1, 0, &[], b"abc")]),
        Err(Failure::Changed)
    );
    let mut wrong_size = backup(1, 0, &[], b"abc");
    wrong_size.extend(backup(4, 0, &wide(":资料:$DATA"), b"abc"));
    assert_eq!(decode_parts(&inv, &[&wrong_size]), Err(Failure::Changed));
    let mut changed_name = backup(1, 0, &[], b"abc");
    changed_name.extend(backup(4, 0, &wide(":资料x:$DATA"), b"a\0\xffz"));
    assert_eq!(decode_parts(&inv, &[&changed_name]), Err(Failure::Changed));
    let upper = inventory(&inventory_packet(
        &[(&[], 3, 0), (&wide(":Name:$DATA"), 1, 0)],
        0,
    ))
    .unwrap();
    let mut lower = backup(1, 0, &[], b"abc");
    lower.extend(backup(4, 0, &wide(":name:$DATA"), b"x"));
    assert_eq!(decode_parts(&upper, &[&lower]), Err(Failure::Changed));
}

#[test]
fn size_zero_is_explicit_and_never_an_invented_eof_or_omitted_stream() {
    let name = wide(":empty:$DATA");
    let inv = inventory(&inventory_packet(&[(&[], 0, 0), (&name, 0, 0)], 0)).unwrap();
    let mut emitted = backup(1, 0, &[], b"");
    emitted.extend(backup(4, 0, &name, b""));
    let result = decode_parts(&inv, &[&emitted]).unwrap();
    assert_eq!(result.logical_bytes, 0);
    assert_eq!(result.count, 2);
    assert_eq!(result.default_sha256, EMPTY_SHA);
    assert_eq!(
        decode_parts(&inv, &[&backup(1, 0, &[], b"")]),
        Err(Failure::Changed)
    );
    assert_eq!(decode_parts(&inv, &[]), Err(Failure::Changed));
    let mut budget = WorkBudget::new(1000);
    let cancel = AtomicBool::new(false);
    let mut reducer = Streams::new(&inv, &mut budget, &cancel, MINIMUM).unwrap();
    assert_eq!(reducer.push(&[]), Err(Failure::InvalidRecord)); // no armed read
    assert_eq!(reducer.offer(), Err(Failure::InvalidRecord)); // refusal is terminal
}

#[test]
fn inventory_checks_complete_chain_alignment_padding_and_signed_fields() {
    let named = wide(":b:$DATA");
    let raw = inventory_packet(&[(&DEFAULT_SPELLING, 3, 4096), (&named, 1, 4096)], 0xad);
    let expected = inventory(&raw).unwrap();
    let mut terminal_padding = raw.clone();
    terminal_padding.resize((raw.len() + 7) & !7, 0xe7);
    assert_eq!(inventory(&terminal_padding).unwrap(), expected);
    terminal_padding.push(0);
    assert_eq!(inventory(&terminal_padding), Err(Failure::InvalidRecord));
    for next in [1u32, 8, 24, 32, 48, u32::MAX] {
        let mut broken = raw.clone();
        broken[..4].copy_from_slice(&next.to_le_bytes());
        assert!(inventory(&broken).is_err(), "next {next}");
    }
    for field in [4, 8, 16] {
        let mut broken = raw.clone();
        if field == 4 {
            broken[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        } else {
            broken[field..field + 8].copy_from_slice(&(-1i64).to_le_bytes());
        }
        assert_eq!(inventory(&broken), Err(Failure::InvalidRecord));
    }
    let mut unlinked = inventory_packet(&[(&[], 0, 0)], 0);
    unlinked.extend(inventory_packet(&[(&named, 0, 0)], 0));
    assert_eq!(inventory(&unlinked), Err(Failure::InvalidRecord));
    for length in 0..INVENTORY_HEADER {
        assert!(inventory(&raw[..length]).is_err());
    }
}

#[test]
fn inventory_default_aliases_duplicates_and_raw_utf16_have_no_lossy_labels() {
    for names in [
        (&[][..], &DEFAULT_SPELLING[..]),
        (&DEFAULT_SPELLING[..], &DEFAULT_SPELLING[..]),
    ] {
        assert_eq!(
            inventory(&inventory_packet(&[(names.0, 0, 0), (names.1, 0, 0)], 0)),
            Err(Failure::Changed)
        );
    }
    let named = wide(":$DATA:$DATA");
    let inv = inventory(&inventory_packet(&[(&[], 0, 0), (&named, 1, 0)], 0)).unwrap();
    let mut bytes = backup(1, 0, &[], b"");
    bytes.extend(backup(4, 0, &named, b"x"));
    assert_eq!(decode_parts(&inv, &[&bytes]).unwrap().count, 2);
    let raw_surrogate = [58, 0xd800, 58, 36, 68, 65, 84, 65];
    let inv = inventory(&inventory_packet(&[(&[], 0, 0), (&raw_surrogate, 1, 0)], 0)).unwrap();
    assert_eq!(
        inv.entries
            .get(&Key::Named(raw_surrogate.to_vec()))
            .unwrap()
            .raw_name
            .as_slice(),
        &raw_surrogate
    );
    let mut bytes = backup(1, 0, &[], b"");
    bytes.extend(backup(4, 0, &raw_surrogate, b"x"));
    assert!(decode_parts(&inv, &[&bytes]).is_ok());
    for invalid in [
        wide(":$DATA"),
        wide("x:$DATA"),
        wide(":a:$OTHER"),
        wide(":a:b:$DATA"),
        vec![0],
    ] {
        assert!(inventory(&inventory_packet(&[(&invalid, 0, 0)], 0)).is_err());
    }
    let duplicate = wide(":dup:$DATA");
    assert_eq!(
        inventory(&inventory_packet(
            &[(&duplicate, 0, 0), (&duplicate, 0, 0)],
            0
        )),
        Err(Failure::Changed)
    );
}

#[test]
fn native_ordinal_is_a_fallible_required_seam_not_a_rust_casefold_claim() {
    let a = wide(":name:$DATA");
    let b = wide(":NAME:$DATA");
    let bytes = inventory_packet(&[(&a, 1, 0), (&b, 1, 0)], 0);
    assert_eq!(
        Inventory::decode(
            0,
            bytes.len(),
            &bytes,
            &mut WorkBudget::new(1000),
            &AtomicBool::new(false),
            |_, _| Ok(Ordering::Equal)
        ),
        Err(Failure::Changed)
    );
    assert_eq!(
        Inventory::decode(
            0,
            bytes.len(),
            &bytes,
            &mut WorkBudget::new(1000),
            &AtomicBool::new(false),
            |_, _| Err(Failure::Compare)
        ),
        Err(Failure::Compare)
    );
    let names = (0..128)
        .map(|n| wide(&format!(":n{n:03}:$DATA")))
        .collect::<Vec<_>>();
    let items = names
        .iter()
        .rev()
        .map(|name| (name.as_slice(), 0, 0))
        .collect::<Vec<_>>();
    let bytes = inventory_packet(&items, 0);
    let mut comparisons = 0;
    Inventory::decode(
        0,
        bytes.len(),
        &bytes,
        &mut WorkBudget::new(QUERY_BYTES as u64),
        &AtomicBool::new(false),
        |left, right| {
            comparisons += 1;
            Ok(left.cmp(right))
        },
    )
    .unwrap();
    assert!(comparisons <= 128 * 7);
}

#[test]
fn returned_status_information_and_capacity_cannot_be_used_as_partial_success() {
    let raw = inventory_packet(&[(&[], 0, 0)], 0);
    for (status, information) in [
        (OVERFLOW, 0),
        (TOO_SMALL, 0),
        (0x103, 0),
        (42, 0),
        (0, 0),
        (0, raw.len() + 1),
    ] {
        assert!(
            Inventory::decode(
                status,
                information,
                &raw,
                &mut WorkBudget::new(1000),
                &AtomicBool::new(false),
                |a, b| Ok(a.cmp(b))
            )
            .is_err()
        );
    }
    let mut offered = raw.clone();
    offered.resize(100, 0xff);
    assert_eq!(
        Inventory::decode(
            0,
            raw.len(),
            &offered,
            &mut WorkBudget::new(1000),
            &AtomicBool::new(false),
            |a, b| Ok(a.cmp(b))
        )
        .unwrap(),
        inventory(&raw).unwrap()
    );
    assert!(inventory(&vec![0; QUERY_BYTES + 1]).is_err());
}

#[test]
fn only_explicit_opaque_metadata_profile_is_drained_and_it_still_costs_work() {
    let inv = inventory(&inventory_packet(&[(&[], 3, 4096)], 0)).unwrap();
    let baseline = decode_parts(&inv, &[&backup(1, 0, &[], b"abc")]).unwrap();
    for id in [2, 5, 7] {
        let mut bytes = backup(id, 0, &[], b"opaque\0\xff");
        bytes.extend(backup(1, 0, &[], b"abc"));
        assert_eq!(decode_parts(&inv, &[&bytes]).unwrap(), baseline);
    }
    for id in [0, 3, 6, 8, 9, 10, u32::MAX] {
        assert_eq!(
            decode_parts(&inv, &[&backup(id, 0, &[], b"")]),
            Err(Failure::Unsupported)
        );
    }
    assert_eq!(
        decode_parts(&inv, &[&backup(1, 8, &[], b"abc")]),
        Err(Failure::Unsupported)
    );
    assert_eq!(
        decode_parts(&inv, &[&backup(2, 0, &wide("named"), b"")]),
        Err(Failure::Unsupported)
    );
    let mut oversized = backup(2, 0, &[], b"");
    oversized[8..16].copy_from_slice(&(MAX_OPAQUE_BYTES + 1).to_le_bytes());
    assert_eq!(decode_parts(&inv, &[&oversized]), Err(Failure::Limit));
}

#[test]
fn shared_ea_inventory_backup_and_verification_budget_is_not_reset() {
    let raw = inventory_packet(&[(&[], 3, 4096)], 0);
    let wire = backup(1, 0, &[], b"abc");
    let ea = [0, 0, 0, 0, 0, 1, 1, 0, b'a', 0, b'z'];
    let limit = (ea.len() + raw.len() + wire.len() + MINIMUM) as u64;
    let mut budget = WorkBudget::new(limit);
    let cancel = AtomicBool::new(false);
    super::super::ea_records::complete(0, ea.len(), &ea, &mut budget, &cancel).unwrap();
    let inv = Inventory::decode(
        0,
        raw.len(),
        &raw,
        &mut budget,
        &cancel,
        |a, b| Ok(a.cmp(b)),
    )
    .unwrap();
    assert_eq!(budget.remaining(), (wire.len() + MINIMUM) as u64);
    {
        let mut streams = Streams::new(&inv, &mut budget, &cancel, MINIMUM).unwrap();
        streams.offer().unwrap();
        assert_eq!(streams.push(&wire).unwrap(), None);
        streams.offer().unwrap();
        assert!(streams.push(&[]).unwrap().is_some());
    }
    assert_eq!(budget.remaining(), MINIMUM as u64);
    // Verification inventory consumes the same remaining bytes; its second
    // backup cannot be preflighted. The first pass did not buy a new budget.
    let second = Inventory::decode(
        0,
        raw.len(),
        &raw,
        &mut budget,
        &cancel,
        |a, b| Ok(a.cmp(b)),
    )
    .unwrap();
    assert_eq!(budget.remaining(), (MINIMUM - raw.len()) as u64);
    assert!(matches!(
        Streams::new(&second, &mut budget, &cancel, MINIMUM),
        Err(Failure::Limit)
    ));
}

#[test]
fn preflight_reserves_eof_offer_without_charging_projection_and_no_body_is_allocated() {
    let inv = inventory(&inventory_packet(&[(&[], 3, 0)], 0)).unwrap();
    let cancel = AtomicBool::new(false);
    let mut budget = WorkBudget::new((BACKUP_HEADER + 3 + MINIMUM - 1) as u64);
    let initial = budget.remaining();
    assert!(matches!(
        Streams::new(&inv, &mut budget, &cancel, MINIMUM),
        Err(Failure::Limit)
    ));
    assert_eq!(budget.remaining(), initial);
    let too_big = inventory(&inventory_packet(
        &[(&[], (MAX_DATA_BYTES + 1) as i64, 0)],
        0,
    ))
    .unwrap();
    assert!(matches!(
        Streams::new(&too_big, &mut WorkBudget::new(1 << 30), &cancel, MINIMUM),
        Err(Failure::Limit)
    ));
    let mut oversized_name = backup(4, 0, &[], b"");
    oversized_name[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(
        decode_parts(&inv, &[&oversized_name]),
        Err(Failure::InvalidRecord)
    );
    let mut odd_name = backup(4, 0, &[], b"");
    odd_name[16..20].copy_from_slice(&1u32.to_le_bytes());
    assert_eq!(
        decode_parts(&inv, &[&odd_name]),
        Err(Failure::InvalidRecord)
    );
}

#[test]
fn metadata_can_exhaust_offer_headroom_but_cannot_fake_completion() {
    let inv = inventory(&inventory_packet(&[(&[], 0, 0)], 0)).unwrap();
    let cancel = AtomicBool::new(false);
    let mut budget = WorkBudget::new((BACKUP_HEADER + MINIMUM) as u64);
    let mut streams = Streams::new(&inv, &mut budget, &cancel, MINIMUM).unwrap();
    let mut bytes = backup(1, 0, &[], b"");
    bytes.extend(backup(2, 0, &[], b""));
    streams.offer().unwrap();
    assert_eq!(streams.push(&bytes).unwrap(), None);
    assert_eq!(streams.offer(), Err(Failure::Limit));
    assert_eq!(streams.push(&[]), Err(Failure::InvalidRecord));
}

#[test]
fn cancellation_charges_completed_bytes_and_poison_blocks_reuse() {
    let inv = inventory(&inventory_packet(&[(&[], 3, 0)], 0)).unwrap();
    let mut budget = WorkBudget::new(1000);
    let cancel = AtomicBool::new(true);
    assert!(matches!(
        Streams::new(&inv, &mut budget, &cancel, MINIMUM),
        Err(Failure::Cancelled)
    ));
    cancel.store(false, AtomicOrdering::SeqCst);
    {
        let mut streams = Streams::new(&inv, &mut budget, &cancel, MINIMUM).unwrap();
        streams.offer().unwrap();
        cancel.store(true, AtomicOrdering::SeqCst);
        assert_eq!(
            streams.push(&backup(1, 0, &[], b"abc")),
            Err(Failure::Cancelled)
        );
        cancel.store(false, AtomicOrdering::SeqCst);
        assert_eq!(streams.offer(), Err(Failure::InvalidRecord));
    }
    assert_eq!(budget.remaining(), 1000 - (BACKUP_HEADER + 3) as u64);
}

#[test]
fn directory_candidate_requires_actual_armed_eof_and_has_no_default_file() {
    let cancel = AtomicBool::new(false);
    let mut budget = WorkBudget::new(1000);
    let allocation = [0xcc; INVENTORY_HEADER];
    let inv = Inventory::empty_directory(0, 0, &allocation, &mut budget, &cancel).unwrap();
    assert!(!inv.has_default());
    assert_eq!(budget.remaining(), 1000);
    let result = decode_parts(&inv, &[]).unwrap();
    assert_eq!(result.count, 0);
    assert_eq!(result.logical_bytes, 0);
    assert!(!result.default_present);
    assert_eq!(result.default_size, 0);
    assert_eq!(result.default_sha256, [0; 32]);
    // This portable candidate result is NOT a native held-directory proof;
    // native caller must still pair before/after inventory and metadata.
    assert_eq!(
        decode_parts(&inv, &[&backup(1, 0, &[], b"")]),
        Err(Failure::Changed)
    );
    assert!(decode_parts(&inv, &[&[1]]).is_err());
    for (status, used) in [(0, 1), (0x103, 0), (OVERFLOW, 0), (42, 0)] {
        assert!(
            Inventory::empty_directory(
                status,
                used,
                &allocation,
                &mut WorkBudget::new(1000),
                &cancel
            )
            .is_err()
        );
    }
    assert!(
        Inventory::empty_directory(
            0,
            0,
            &[0; INVENTORY_HEADER - 1],
            &mut WorkBudget::new(1000),
            &cancel
        )
        .is_err()
    );
    assert_eq!(
        Inventory::decode(
            0,
            0,
            &allocation,
            &mut WorkBudget::new(1000),
            &cancel,
            |a, b| Ok(a.cmp(b))
        ),
        Err(Failure::Unsupported)
    );
}

#[test]
fn named_directory_streams_pair_without_a_default_and_reject_default_inventory() {
    let name = wide(":directory-note:$DATA");
    let zero = wide(":empty-directory-note:$DATA");
    let raw = inventory_packet(&[(&name, 3, 4096), (&zero, 0, 0)], 0xa7);
    let unclassified = inventory(&raw).unwrap();
    let cancel = AtomicBool::new(false);
    assert!(matches!(
        Streams::new(&unclassified, &mut WorkBudget::new(1000), &cancel, MINIMUM),
        Err(Failure::Unsupported)
    ));
    // Production native owner may mark only an already-held Directory kind.
    let directory = unclassified.for_directory().unwrap();
    let mut wire = backup(4, 0, &name, b"abc");
    wire.extend(backup(4, 0, &zero, b""));
    let result = decode_parts(&directory, &[&wire]).unwrap();
    assert_eq!(result.count, 2);
    assert_eq!(result.logical_bytes, 3);
    assert!(!result.default_present);
    assert_eq!(result.default_size, 0);
    assert_eq!(result.default_sha256, [0; 32]);
    let bytewise = wire.chunks(1).collect::<Vec<_>>();
    assert_eq!(decode_parts(&directory, &bytewise).unwrap(), result);
    let mut changed = backup(4, 0, &name, b"abd");
    changed.extend(backup(4, 0, &zero, b""));
    assert_ne!(
        decode_parts(&directory, &[&changed]).unwrap().sha256,
        result.sha256
    );
    assert_eq!(
        decode_parts(&directory, &[&backup(4, 0, &name, b"abc")]),
        Err(Failure::Changed)
    );
    let mut unexpected_default = wire;
    unexpected_default.extend(backup(1, 0, &[], b""));
    assert_eq!(
        decode_parts(&directory, &[&unexpected_default]),
        Err(Failure::Changed)
    );
    let default_inventory = inventory(&inventory_packet(&[(&[], 0, 0)], 0)).unwrap();
    assert_eq!(default_inventory.for_directory(), Err(Failure::Unsupported));
}

#[test]
fn default_size_getter_does_not_invent_a_directory_default() {
    let default = inventory(&inventory_packet(&[(&DEFAULT_SPELLING, 3, 4096)], 0)).unwrap();
    assert_eq!(default.default_size(), Some(3));
    let named = wide(":named:$DATA");
    let directory = inventory(&inventory_packet(&[(&named, 4, 4096)], 0))
        .unwrap()
        .for_directory()
        .unwrap();
    assert_eq!(directory.default_size(), None);
}

#[test]
fn native_inventory_offer_refuses_subheader_shared_work_before_native_call() {
    for remaining in 0..INVENTORY_HEADER {
        let budget = WorkBudget::new(remaining as u64);
        assert!(matches!(
            Inventory::query_capacity(&budget),
            Err(super::super::ea_records::Failure::Limit)
        ));
        assert_eq!(budget.remaining(), remaining as u64);
    }
}
#[test]
fn native_inventory_offer_keeps_the_same_budget_and_original_query_cap() {
    let mut budget = WorkBudget::new(INVENTORY_HEADER as u64);
    assert_eq!(
        Inventory::query_capacity(&budget).unwrap(),
        INVENTORY_HEADER
    );
    budget.charge(1).unwrap();
    assert!(matches!(
        Inventory::query_capacity(&budget),
        Err(super::super::ea_records::Failure::Limit)
    ));
    assert_eq!(budget.remaining(), INVENTORY_HEADER as u64 - 1);
    let large = WorkBudget::new(QUERY_BYTES as u64 + 7);
    assert_eq!(Inventory::query_capacity(&large).unwrap(), QUERY_BYTES);
    assert_eq!(large.remaining(), QUERY_BYTES as u64 + 7);
}
#[test]
fn malformed_subheader_inventory_is_still_invalid_in_both_decoder_profiles() {
    let raw = [0u8; INVENTORY_HEADER - 1];
    let cancel = AtomicBool::new(false);
    assert!(matches!(
        Inventory::decode(
            TOO_SMALL,
            0,
            &raw,
            &mut WorkBudget::new(1024),
            &cancel,
            |a, b| Ok(a.cmp(b))
        ),
        Err(Failure::InvalidRecord)
    ));
    assert!(matches!(
        Inventory::empty_directory(0, 0, &raw, &mut WorkBudget::new(1024), &cancel),
        Err(Failure::InvalidRecord)
    ));
}
