use super::*;
use std::io::Cursor;
fn descriptor() -> Vec<u8> {
    let mut out = vec![0u8; 20];
    out[0] = 1;
    out[2..4].copy_from_slice(&0x8004u16.to_le_bytes());
    out
}
fn stream(id: u32, flags: u32, name: &[u16], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(id.to_le_bytes());
    out.extend(flags.to_le_bytes());
    out.extend((body.len() as u64).to_le_bytes());
    out.extend((name.len() as u32 * 2).to_le_bytes());
    for unit in name {
        out.extend(unit.to_le_bytes());
    }
    out.extend(body);
    out
}
fn fixture() -> (Vec<u8>, Expected) {
    let named: Vec<u16> = [vec![58, 0xd800], ":$DATA".encode_utf16().collect()].concat();
    let default: Vec<u8> = (0..=255).collect();
    let mut raw = stream(1, 0, &[], &default);
    raw.extend(stream(4, 0, &named, b"\0\xffADS"));
    raw.extend(stream(2, 0, &[], b"opaque-native-EA"));
    raw.extend(stream(3, 2, &[], &descriptor()));
    (raw, [(Vec::new(), 256), (named, 5)].into())
}
fn run(raw: &[u8], expected: &Expected) -> Result<Parsed> {
    parse(
        Cursor::new(raw),
        expected,
        &mut WorkBudget::new(WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(RESIDENT_LIMIT),
    )
}
struct Split<'a> {
    body: &'a [u8],
    first: usize,
    reads: usize,
}
impl Read for Split<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let limit = if self.reads == 0 { self.first } else { 7 };
        self.reads += 1;
        let n = limit.min(out.len()).min(self.body.len());
        out[..n].copy_from_slice(&self.body[..n]);
        self.body = &self.body[n..];
        Ok(n)
    }
}
#[test]
fn all_bytes_utf16_and_every_boundary_use_actual_stream_parser() {
    let (raw, expected) = fixture();
    let original = run(&raw, &expected).unwrap();
    assert_eq!(original.bytes, raw.len() as u64);
    assert!(original.has_ea());
    for cut in 1..raw.len() {
        let actual = parse(
            Split {
                body: &raw,
                first: cut,
                reads: 0,
            },
            &expected,
            &mut WorkBudget::new(WORK_LIMIT),
            &AtomicBool::new(false),
            &Resident::new(RESIDENT_LIMIT),
        )
        .unwrap();
        assert_eq!(actual, original, "split {cut}");
    }
}
#[test]
fn security_extent_is_exact_for_each_physical_order_and_not_an_ordinary_facet() {
    let security = stream(3, 2, &[], &descriptor());
    let data = stream(1, 0, &[], b"payload");
    let ea = stream(2, 0, &[], b"opaque-EA");
    let expected = [(Vec::new(), 7)].into();
    let mut reference = None;
    for (raw, start) in [
        ([security.clone(), data.clone(), ea.clone()].concat(), 0),
        (
            [data.clone(), security.clone(), ea.clone()].concat(),
            data.len(),
        ),
        (
            [data.clone(), ea.clone(), security.clone()].concat(),
            data.len() + ea.len(),
        ),
    ] {
        let parsed = run(&raw, &expected).unwrap();
        let extent = parsed.security_record.clone().unwrap();
        assert_eq!(extent, start as u64..(start + security.len()) as u64);
        assert_eq!(&raw[extent.start as usize..extent.end as usize], security);
        assert_eq!(parsed.sha256, <[u8; 32]>::from(Sha256::digest(&raw)));
        if let Some(previous) = &reference {
            assert!(parsed.same_contents(previous));
        }
        reference = Some(parsed);
    }
    let ordinary = parse_profile(
        Cursor::new(&data),
        &expected,
        false,
        &mut WorkBudget::new(WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(RESIDENT_LIMIT),
    )
    .unwrap();
    assert!(ordinary.security_record.is_none());
}
#[test]
fn full_security_observed_empty_default_preserves_physical_bytes_without_padding() {
    let expected = [(Vec::new(), 0)].into();
    let security = stream(3, 2, &[], &descriptor());
    let raw = [stream(1, 0, &[], &[]), security.clone()].concat();
    let omitted = run(&security, &expected).unwrap();
    let emitted = run(&raw, &expected).unwrap();
    assert_eq!(omitted.bytes, security.len() as u64);
    assert_eq!(omitted.sha256, <[u8; 32]>::from(Sha256::digest(&security)));
    assert_eq!(emitted.bytes, raw.len() as u64);
    assert_eq!(emitted.sha256, <[u8; 32]>::from(Sha256::digest(&raw)));
    assert_ne!(omitted, emitted);
    assert!(omitted.same_contents(&emitted));
    assert_eq!(omitted.semantic_sha256(), emitted.semantic_sha256());
    assert!(omitted.security.is_some());
    assert_eq!(omitted.security, emitted.security);
}
#[test]
fn every_truncated_prefix_refuses_complete_carrier() {
    let (raw, expected) = fixture();
    for end in 0..raw.len() {
        assert!(run(&raw[..end], &expected).is_err());
    }
}
#[test]
fn unsupported_streams_and_modified_when_read_never_reach_writer() {
    let (raw, expected) = fixture();
    for id in [5, 6, 7, 8, 9, 10, 11, u32::MAX] {
        let mut changed = raw.clone();
        changed[..4].copy_from_slice(&id.to_le_bytes());
        assert_eq!(run(&changed, &expected), Err(Error::Unsupported));
    }
    let mut changed = raw;
    changed[4..8].copy_from_slice(&1u32.to_le_bytes());
    assert_eq!(run(&changed, &expected), Err(Error::Unsupported));
}
#[test]
fn duplicate_and_case_changed_names_do_not_silently_merge() {
    let (mut raw, expected) = fixture();
    raw.extend(stream(1, 0, &[], &vec![0; 256]));
    assert_eq!(run(&raw, &expected), Err(Error::Invalid));
    let mut raw = stream(1, 0, &[], b"x");
    raw.extend(stream(
        4,
        0,
        &":A:$DATA".encode_utf16().collect::<Vec<_>>(),
        b"z",
    ));
    raw.extend(stream(3, 0, &[], &descriptor()));
    let expected = [(Vec::new(), 1), (":a:$DATA".encode_utf16().collect(), 1)].into();
    assert_eq!(run(&raw, &expected), Err(Error::Changed));
}
#[test]
fn header_overflow_and_metadata_cap_refuse_before_body_allocation() {
    let mut raw = stream(3, 0, &[], &[]);
    raw[8..16].copy_from_slice(&u64::MAX.to_le_bytes());
    assert_eq!(run(&raw, &[(Vec::new(), 0)].into()), Err(Error::Limit));
    raw[8..16].copy_from_slice(&(BLOCK as u64 + 1).to_le_bytes());
    assert!(run(&raw, &[(Vec::new(), 0)].into()).is_err());
}
#[test]
fn cancellation_and_shared_work_are_real_failures() {
    let (raw, expected) = fixture();
    assert_eq!(
        parse(
            Cursor::new(&raw),
            &expected,
            &mut WorkBudget::new(WORK_LIMIT),
            &AtomicBool::new(true),
            &Resident::new(RESIDENT_LIMIT)
        ),
        Err(Error::Cancelled)
    );
    assert_eq!(
        parse(
            Cursor::new(&raw),
            &expected,
            &mut WorkBudget::new(raw.len() as u64 - 1),
            &AtomicBool::new(false),
            &Resident::new(RESIDENT_LIMIT)
        ),
        Err(Error::Limit)
    );
}
#[test]
fn valid_payload_drift_is_not_equivalent_even_when_lengths_match() {
    let (raw, expected) = fixture();
    let original = run(&raw, &expected).unwrap();
    let mut changed = raw.clone();
    changed[20] ^= 0xff;
    let other = run(&changed, &expected).unwrap();
    assert!(!original.same_contents(&other));
    assert_ne!(original.sha256, other.sha256);
}

#[test]
fn resident_catalog_reservation_is_released_and_never_overcommitted() {
    let memory = Resident::new(CATALOG_RESIDENT + BLOCK);
    let held = memory.lease(CATALOG_RESIDENT).unwrap();
    assert!(matches!(memory.lease(BLOCK + 1), Err(Error::Limit)));
    drop(held);
    assert!(memory.lease(CATALOG_RESIDENT + BLOCK).is_ok());
}

#[test]
fn material_semantic_digest_uses_all_streams_without_backup_order() {
    let expected = [(Vec::new(), 4)].into();
    let data = stream(1, 0, &[], b"data");
    let security = stream(3, 2, &[], &descriptor());
    let a = run(&[data.clone(), security.clone()].concat(), &expected).unwrap();
    let b = run(&[security, data].concat(), &expected).unwrap();
    assert_ne!(a.sha256, b.sha256);
    assert!(a.same_contents(&b));
    assert_eq!(a.semantic_sha256(), b.semantic_sha256());
    let changed = run(
        &[stream(1, 0, &[], b"DATA"), stream(3, 2, &[], &descriptor())].concat(),
        &expected,
    )
    .unwrap();
    assert_ne!(a.semantic_sha256(), changed.semantic_sha256());
}

#[test]
fn ordinary_payload_is_explicit_and_cannot_accept_or_downgrade_full_security() {
    let expected: Expected = [(Vec::new(), 0)].into();
    let raw = stream(1, 0, &[], &[]);
    let resident = Resident::new(RESIDENT_LIMIT);
    let cancel = AtomicBool::new(false);
    let mut work = WorkBudget::new(WORK_LIMIT);
    let ordinary = parse_profile(
        Cursor::new(&raw),
        &expected,
        false,
        &mut work,
        &cancel,
        &resident,
    )
    .unwrap();
    assert!(ordinary.security.is_none());
    assert_eq!(ordinary.bytes, 20);
    assert!(parse(Cursor::new(&raw), &expected, &mut work, &cancel, &resident).is_err());
    let full = [raw, stream(3, 2, &[], &descriptor())].concat();
    assert!(
        parse(Cursor::new(&full), &expected, &mut work, &cancel, &resident)
            .unwrap()
            .security
            .is_some()
    );
    assert!(
        parse_profile(
            Cursor::new(&full),
            &expected,
            false,
            &mut work,
            &cancel,
            &resident
        )
        .is_err()
    );
}

fn ordinary(raw: &[u8], expected: &Expected) -> Result<Parsed> {
    parse_profile(
        Cursor::new(raw),
        expected,
        false,
        &mut WorkBudget::new(WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(RESIDENT_LIMIT),
    )
}

#[test]
fn ordinary_observed_empty_default_needs_no_physical_backup_record() {
    let expected = [(Vec::new(), 0)].into();
    let absent = ordinary(&[], &expected).unwrap();
    let emitted = ordinary(&stream(1, 0, &[], &[]), &expected).unwrap();
    assert_eq!(absent.bytes, 0);
    assert_eq!(absent.sha256, <[u8; 32]>::from(Sha256::digest([])));
    assert_eq!(emitted.bytes, 20);
    assert_ne!(absent.sha256, emitted.sha256);
    assert_ne!(absent, emitted);
    assert!(absent.same_contents(&emitted));
    assert_eq!(absent.semantic_sha256(), emitted.semantic_sha256());
    assert!(absent.security.is_none());
}

#[test]
fn ordinary_omitted_zero_default_keeps_exact_named_data_and_ea_semantics() {
    let named: Vec<u16> = ":owned:$DATA".encode_utf16().collect();
    let expected = [(Vec::new(), 0), (named.clone(), 3)].into();
    let raw = [
        stream(2, 0, &[], b"opaque-native-EA"),
        stream(4, 0, &named, b"ADS"),
    ]
    .concat();
    let observed = ordinary(&raw, &expected).unwrap();
    let explicit = ordinary(&[stream(1, 0, &[], &[]), raw.clone()].concat(), &expected).unwrap();
    assert!(observed.has_ea());
    assert_eq!(observed.bytes, raw.len() as u64);
    assert!(observed.same_contents(&explicit));
    assert_eq!(observed.semantic_sha256(), explicit.semantic_sha256());
    assert_ne!(observed.sha256, explicit.sha256);
    let changed = ordinary(
        &[
            stream(2, 0, &[], b"opaque-native-EA"),
            stream(4, 0, &named, b"ads"),
        ]
        .concat(),
        &expected,
    )
    .unwrap();
    assert!(!observed.same_contents(&changed));
}

#[test]
fn ordinary_empty_default_exception_cannot_hide_missing_or_invalid_material() {
    let empty: Expected = [(Vec::new(), 0)].into();
    assert!(ordinary(&[], &[(Vec::new(), 1)].into()).is_err());
    for size in [0, 1] {
        let named: Vec<u16> = ":required:$DATA".encode_utf16().collect();
        assert!(ordinary(&[], &[(Vec::new(), 0), (named, size)].into()).is_err());
    }
    let zero = stream(1, 0, &[], &[]);
    for end in 1..zero.len() {
        assert!(ordinary(&zero[..end], &empty).is_err());
    }
    assert!(ordinary(&[zero.clone(), zero].concat(), &empty).is_err());
    assert!(ordinary(&stream(3, 2, &[], &descriptor()), &empty).is_err());
    assert!(run(&[], &empty).is_err());
    assert!(ordinary(&[], &Expected::new()).is_err());
}

#[test]
fn full_security_omitted_zero_default_keeps_named_ea_and_security_semantics() {
    let named: Vec<u16> = ":owned:$DATA".encode_utf16().collect();
    let expected = [(Vec::new(), 0), (named.clone(), 3)].into();
    let raw = [
        stream(2, 0, &[], b"opaque-native-EA"),
        stream(4, 0, &named, b"ADS"),
        stream(3, 2, &[], &descriptor()),
    ]
    .concat();
    let observed = run(&raw, &expected).unwrap();
    let explicit = run(&[stream(1, 0, &[], &[]), raw.clone()].concat(), &expected).unwrap();
    assert!(observed.has_ea() && observed.security.is_some());
    assert_eq!(observed.bytes, raw.len() as u64);
    assert_eq!(observed.sha256, <[u8; 32]>::from(Sha256::digest(&raw)));
    assert!(observed.same_contents(&explicit));
    assert_eq!(observed.semantic_sha256(), explicit.semantic_sha256());
    assert_ne!(observed.sha256, explicit.sha256);
    for (ea, ads) in [
        (b"changed-native-EA".as_slice(), b"ADS".as_slice()),
        (b"opaque-native-EA".as_slice(), b"ads".as_slice()),
    ] {
        let changed = run(
            &[
                stream(2, 0, &[], ea),
                stream(4, 0, &named, ads),
                stream(3, 2, &[], &descriptor()),
            ]
            .concat(),
            &expected,
        )
        .unwrap();
        assert!(!observed.same_contents(&changed));
        assert_ne!(observed.semantic_sha256(), changed.semantic_sha256());
    }
    let mut changed_descriptor = descriptor();
    changed_descriptor[2..4].copy_from_slice(&0x8014u16.to_le_bytes());
    let changed = run(
        &[
            stream(2, 0, &[], b"opaque-native-EA"),
            stream(4, 0, &named, b"ADS"),
            stream(3, 2, &[], &changed_descriptor),
        ]
        .concat(),
        &expected,
    )
    .unwrap();
    assert_ne!(observed.security, changed.security);
    assert!(!observed.same_contents(&changed));
    assert_ne!(observed.semantic_sha256(), changed.semantic_sha256());
}

#[test]
fn full_security_empty_default_still_requires_all_other_complete_material() {
    let empty: Expected = [(Vec::new(), 0)].into();
    let security = stream(3, 2, &[], &descriptor());
    assert!(run(&[], &empty).is_err());
    assert!(run(&stream(1, 0, &[], &[]), &empty).is_err());
    assert!(run(&stream(3, 2, &[], &[]), &empty).is_err());
    assert!(run(&security, &Expected::new()).is_err());
    assert!(run(&security, &[(Vec::new(), 1)].into()).is_err());
    for size in [0, 1] {
        let named: Vec<u16> = ":required:$DATA".encode_utf16().collect();
        assert!(run(&security, &[(Vec::new(), 0), (named, size)].into()).is_err());
    }
    for end in 0..security.len() {
        assert!(run(&security[..end], &empty).is_err());
    }
    let zero = stream(1, 0, &[], &[]);
    for end in 1..zero.len() {
        assert!(run(&[security.clone(), zero[..end].to_vec()].concat(), &empty).is_err());
    }
    assert!(run(&[security.clone(), security.clone()].concat(), &empty).is_err());
    assert!(run(&[security, zero.clone(), zero].concat(), &empty).is_err());
}
