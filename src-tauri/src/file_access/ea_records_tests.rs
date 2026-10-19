use super::*;
fn packet(items: &[(&[u8], u8, &[u8])], padding: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    for (index, (name, flags, value)) in items.iter().enumerate() {
        let size = 8 + name.len() + 1 + value.len();
        let next = if index + 1 == items.len() {
            0
        } else {
            (size + 3) & !3
        };
        bytes.extend((next as u32).to_le_bytes());
        bytes.push(*flags);
        bytes.push(name.len() as u8);
        bytes.extend((value.len() as u16).to_le_bytes());
        bytes.extend(*name);
        bytes.push(0);
        bytes.extend(*value);
        if next != 0 {
            bytes.resize(bytes.len() + next - size, padding);
        }
    }
    bytes
}
fn observe(raw: &[u8]) -> Result<Observation, Failure> {
    complete(
        0,
        raw.len(),
        raw,
        &mut WorkBudget::new(QUERY_BYTES as u64),
        &AtomicBool::new(false),
    )
}
#[test]
fn order_padding_and_buffer_capacity_do_not_change_the_record_digest() {
    let a = packet(
        &[(b"beta", 0, b"\0\xff\x01"), (b"alpha", 0x80, b"opaque\0")],
        0xcd,
    );
    let b = packet(
        &[(b"alpha", 0x80, b"opaque\0"), (b"beta", 0, b"\0\xff\x01")],
        0,
    );
    let expected = observe(&a).unwrap();
    assert_eq!(expected, observe(&b).unwrap());
    assert_eq!(expected.count, 2);
    let mut allocation = a.clone();
    allocation.extend([0xff; 48]);
    assert_eq!(
        complete(
            0,
            a.len(),
            &allocation,
            &mut WorkBudget::new(1000),
            &AtomicBool::new(false)
        )
        .unwrap(),
        expected
    );
    let mut changed = b.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert_ne!(observe(&changed).unwrap(), expected);
}
#[test]
fn zero_length_values_are_observed_not_silently_removed() {
    let one = observe(&packet(&[(b"empty-value", 0, b"")], 0)).unwrap();
    let empty = complete(
        NO_EAS,
        0,
        &[0xcc; 64],
        &mut WorkBudget::new(64),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(one.count, 1);
    assert_eq!(empty.count, 0);
    assert_ne!(one, empty);
}
#[test]
fn returned_status_and_actual_information_must_both_prove_completion() {
    let raw = packet(&[(b"a", 0, b"b")], 0);
    for (status, used) in [(NO_EAS, raw.len()), (0, 0), (0, raw.len() + 1)] {
        assert!(
            complete(
                status,
                used,
                &raw,
                &mut WorkBudget::new(100),
                &AtomicBool::new(false)
            )
            .is_err()
        );
    }
    for status in [
        BUFFER_OVERFLOW,
        BUFFER_TOO_SMALL,
        0x103,
        0xC0000022_u32 as i32,
        0xC000004F_u32 as i32,
        0xC0000010_u32 as i32,
        42,
    ] {
        assert!(
            complete(
                status,
                0,
                &raw,
                &mut WorkBudget::new(100),
                &AtomicBool::new(false)
            )
            .is_err()
        );
    }
    assert!(
        complete(
            NO_EAS,
            0,
            &raw,
            &mut WorkBudget::new(100),
            &AtomicBool::new(false)
        )
        .is_ok()
    );
}
#[test]
fn ambiguous_ascii_names_unsupported_flags_and_missing_nul_are_refused() {
    for names in [(b"same".as_slice(), b"SAME".as_slice()), (b"same", b"same")] {
        assert!(
            observe(&packet(
                &[(names.0, 0, b"first"), (names.1, 0, b"second")],
                0
            ))
            .is_err()
        );
    }
    for name in [
        b"".as_slice(),
        b"a/b",
        b"a\\b",
        b"a:b",
        b"a\0b",
        b"a\x1fb",
        b"\x80",
    ] {
        assert!(observe(&packet(&[(name, 0, b"v")], 0)).is_err());
    }
    assert!(observe(&packet(&[(&[b'a'; 255], 0, b"v")], 0)).is_err());
    assert!(observe(&packet(&[(&[b'a'; 254], 0, b"v")], 0)).is_ok());
    assert!(observe(&packet(&[(b"a", 1, b"v")], 0)).is_err());
    let mut raw = packet(&[(b"a", 0, b"v")], 0);
    raw[9] = 1;
    assert!(observe(&raw).is_err());
}
#[test]
fn offsets_cannot_overlap_jump_outside_skip_a_header_or_cycle() {
    let valid = packet(&[(b"a", 0, b"v"), (b"b", 0, b"w")], 0x99);
    for offset in [1u32, 4, 8, 13, 24, u32::MAX] {
        let mut raw = valid.clone();
        raw[..4].copy_from_slice(&offset.to_le_bytes());
        assert!(observe(&raw).is_err(), "offset {offset}");
    }
    for length in 0..11 {
        assert!(observe(&valid[..length]).is_err());
    }
    let mut raw = valid.clone();
    raw[6..8].copy_from_slice(&u16::MAX.to_le_bytes());
    assert!(observe(&raw).is_err());
}
#[test]
fn every_completed_initial_and_verification_response_consumes_one_shared_budget() {
    let raw = packet(&[(b"name", 0, b"value")], 0);
    let mut budget = WorkBudget::new((2 * raw.len()) as u64);
    let first = complete(0, raw.len(), &raw, &mut budget, &AtomicBool::new(false)).unwrap();
    assert_eq!(budget.used, raw.len() as u64);
    assert_eq!(
        complete(0, raw.len(), &raw, &mut budget, &AtomicBool::new(false)).unwrap(),
        first
    );
    assert_eq!(budget.used, (2 * raw.len()) as u64);
    assert_eq!(budget.capacity(), Err(Failure::Limit));
    let mut too_small = WorkBudget::new((2 * raw.len() - 1) as u64);
    complete(0, raw.len(), &raw, &mut too_small, &AtomicBool::new(false)).unwrap();
    assert!(complete(0, raw.len(), &raw, &mut too_small, &AtomicBool::new(false)).is_err());
    let mut cancelled_budget = WorkBudget::new(raw.len() as u64);
    assert_eq!(
        complete(
            0,
            raw.len(),
            &raw,
            &mut cancelled_budget,
            &AtomicBool::new(true)
        ),
        Err(Failure::Cancelled)
    );
    assert_eq!(cancelled_budget.used, raw.len() as u64); // completed work is not erased
}

#[test]
fn terminal_next_zero_cannot_hide_another_full_record_in_information() {
    let first = packet(&[(b"a", 0, b"v")], 0);
    let expected = observe(&first).unwrap();
    let mut raw = first.clone();
    raw.resize((raw.len() + 3) & !3, 0xbd);
    // The first next offset is still zero, but Information includes a second
    // complete record. R1 discarded it; complete-or-refuse must reject it.
    raw.extend(packet(&[(b"hidden", 0, b"opaque")], 0));
    assert_eq!(observe(&raw), Err(Failure::InvalidRecord));
    assert_eq!(observe(&first).unwrap(), expected);
}
#[test]
fn exact_or_minimal_aligned_terminal_spans_ignore_nonzero_padding_only() {
    for value in [b"".as_slice(), b"v", b"vv", b"vvv"] {
        let exact = packet(&[(b"a", 0, value)], 0);
        let expected = observe(&exact).unwrap();
        let mut aligned = exact.clone();
        aligned.resize((aligned.len() + 3) & !3, 0xd7);
        assert_eq!(observe(&aligned).unwrap(), expected);
        // No second full record is needed to make an oversized tail invalid.
        aligned.push(0);
        assert_eq!(observe(&aligned), Err(Failure::InvalidRecord));
    }
}
#[test]
fn nonterminal_offsets_cannot_hide_unlinked_records_inside_an_oversized_gap() {
    let first = packet(&[(b"a", 0, b"v")], 0);
    let mut raw = first.clone();
    raw.resize((raw.len() + 3) & !3, 0xa7);
    raw.extend(packet(&[(b"hidden", 0, b"opaque")], 0));
    raw.resize((raw.len() + 3) & !3, 0x9e);
    let next = raw.len() as u32;
    raw[..4].copy_from_slice(&next.to_le_bytes());
    raw.extend(packet(&[(b"last", 0, b"v")], 0));
    assert_eq!(observe(&raw), Err(Failure::InvalidRecord));
    // Properly linked ordinary records, including nonzero minimal padding,
    // continue through the same production decoder.
    assert!(observe(&packet(&[(b"a", 0, b"v"), (b"last", 0, b"v")], 0xa7)).is_ok());
}
