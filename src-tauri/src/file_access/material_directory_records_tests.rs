use super::*;
use crate::file_access::material_carrier_records::{RESIDENT_LIMIT, WORK_LIMIT};
use std::io::Cursor;
fn frame(id: u32, flags: u32, name: &[u16], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(id.to_le_bytes());
    out.extend(flags.to_le_bytes());
    out.extend((data.len() as u64).to_le_bytes());
    out.extend((name.len() as u32 * 2).to_le_bytes());
    for u in name {
        out.extend(u.to_le_bytes());
    }
    out.extend(data);
    out
}
fn descriptor() -> Vec<u8> {
    let mut b = vec![0u8; 20];
    b[0] = 1;
    b[2..4].copy_from_slice(&0x8004u16.to_le_bytes());
    b
}
fn named() -> Vec<u16> {
    [vec![58, 97, 0xd800], ":$DATA".encode_utf16().collect()].concat()
}
fn ea() -> Vec<u8> {
    let mut b = vec![0u8; 8];
    b[5] = 1;
    b[6..8].copy_from_slice(&2u16.to_le_bytes());
    b.extend(b"X\0\0\xff");
    b
}
fn run(bytes: &[u8], expected: &Expected, profile: Profile) -> Result<Parsed> {
    parse(
        Cursor::new(bytes),
        expected,
        profile,
        &mut WorkBudget::new(WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(RESIDENT_LIMIT),
    )
}
fn fixture() -> (Vec<u8>, Expected) {
    let mut b = frame(2, 0, &[], &ea());
    b.extend(frame(4, 0, &named(), b"a\0\xff"));
    b.extend(frame(3, 2, &[], &descriptor()));
    (b, [(named(), 3)].into())
}
#[test]
fn empty_directory_is_typed_not_a_zero_default_regular_file() {
    let p = run(&[], &Expected::new(), Profile::PayloadOnly).unwrap();
    assert_eq!(p.bytes, 0);
    assert!(p.security.is_none() && !p.has_ea());
    assert_eq!(
        run(
            &frame(1, 0, &[], &[]),
            &Expected::new(),
            Profile::PayloadOnly
        ),
        Err(Error::Unsupported)
    );
    assert!(
        crate::file_access::material_carrier_records::parse(
            Cursor::new([]),
            &[(Vec::new(), 0)].into(),
            &mut WorkBudget::new(WORK_LIMIT),
            &AtomicBool::new(false),
            &Resident::new(RESIDENT_LIMIT)
        )
        .is_err()
    );
}
struct Split<'a>(&'a [u8]);
impl Read for Split<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let n = 7.min(out.len()).min(self.0.len());
        out[..n].copy_from_slice(&self.0[..n]);
        self.0 = &self.0[n..];
        Ok(n)
    }
}
#[test]
fn actual_parser_pairs_raw_ads_ea_and_full_security_across_short_reads() {
    let (b, e) = fixture();
    let p = run(&b, &e, Profile::WithFullSecurity).unwrap();
    let q = parse(
        Split(&b),
        &e,
        Profile::WithFullSecurity,
        &mut WorkBudget::new(WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(RESIDENT_LIMIT),
    )
    .unwrap();
    assert_eq!(p, q);
    assert!(p.same_contents(&q));
    assert_eq!(p.ea.as_ref().unwrap().count, 1);
    assert!(p.security.is_some());
    let hash: [u8; 32] = Sha256::digest(&b).into();
    assert_eq!(p.sha256, hash);
}
#[test]
fn security_profiles_cannot_turn_partial_or_missing_bytes_into_full() {
    let (b, e) = fixture();
    assert_eq!(run(&b, &e, Profile::PayloadOnly), Err(Error::Unsupported));
    let partial = frame(4, 0, &named(), b"a\0\xff");
    assert!(run(&partial, &e, Profile::WithFullSecurity).is_err());
    assert!(
        run(&partial, &e, Profile::PayloadOnly)
            .unwrap()
            .security
            .is_none()
    );
}
#[test]
fn unsupported_kind_duplicate_alias_and_invalid_ea_are_refusals() {
    for id in [1, 5, 6, 7, 8, 9, 10, u32::MAX] {
        assert_eq!(
            run(
                &frame(id, 0, &[], &[]),
                &Expected::new(),
                Profile::PayloadOnly
            ),
            Err(Error::Unsupported)
        );
    }
    let mut duplicate = frame(4, 0, &named(), b"a");
    duplicate.extend(frame(4, 0, &named(), b"b"));
    assert_eq!(
        run(&duplicate, &[(named(), 1)].into(), Profile::PayloadOnly),
        Err(Error::Invalid)
    );
    assert!(
        run(
            &frame(2, 0, &[], b"not-an-ea-record"),
            &Expected::new(),
            Profile::PayloadOnly
        )
        .is_err()
    );
    let wrong = [(":A:$DATA".encode_utf16().collect(), 1)].into();
    assert_eq!(
        run(
            &frame(4, 0, &":a:$DATA".encode_utf16().collect::<Vec<_>>(), b"x"),
            &wrong,
            Profile::PayloadOnly
        ),
        Err(Error::Changed)
    );
}
#[test]
fn truncation_budget_and_cancellation_never_complete_a_full_directory() {
    let (b, e) = fixture();
    for end in 0..b.len() {
        assert!(
            run(&b[..end], &e, Profile::WithFullSecurity).is_err(),
            "prefix {end}"
        );
    }
    for (cancel, work, wanted) in [
        (true, WORK_LIMIT, Error::Cancelled),
        (false, 1, Error::Limit),
    ] {
        assert_eq!(
            parse(
                Cursor::new(&b),
                &e,
                Profile::WithFullSecurity,
                &mut WorkBudget::new(work),
                &AtomicBool::new(cancel),
                &Resident::new(RESIDENT_LIMIT)
            ),
            Err(wanted)
        );
    }
}
#[test]
fn equal_length_native_payload_drift_changes_actual_contents_and_digest() {
    let mut b = frame(4, 0, &named(), b"abc");
    let e = [(named(), 3)].into();
    let a = run(&b, &e, Profile::PayloadOnly).unwrap();
    *b.last_mut().unwrap() ^= 1;
    let changed = run(&b, &e, Profile::PayloadOnly).unwrap();
    assert!(!a.same_contents(&changed));
    assert_ne!(a.sha256, changed.sha256);
}
#[test]
fn returned_catalog_keeps_shared_resident_until_retired() {
    let memory = Resident::new(CATALOG_RESIDENT + 2 * BLOCK);
    let p = parse(
        Cursor::new([]),
        &Expected::new(),
        Profile::PayloadOnly,
        &mut WorkBudget::new(WORK_LIMIT),
        &AtomicBool::new(false),
        &memory,
    )
    .unwrap();
    assert!(memory.lease(2 * BLOCK + 1).is_err());
    drop(p);
    assert!(memory.lease(CATALOG_RESIDENT + 2 * BLOCK).is_ok());
}
