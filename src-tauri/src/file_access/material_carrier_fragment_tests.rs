use super::*;
use crate::file_access::material_carrier_records::{RESIDENT_LIMIT, WORK_LIMIT};
use std::io::{self, Cursor, Read, Seek, SeekFrom};
fn metadata() -> Metadata {
    Metadata {
        raw_leaf: vec![0x61, 0xd800, 0x62],
        source_volume: 9,
        source_id: (1u128 << 120) | 7,
        created: 1,
        accessed: 2,
        modified: 3,
        attributes: 0x20,
    }
}
fn body() -> Vec<u8> {
    (0..=255).cycle().take(BLOCK + 301).collect()
}
fn extent(bytes: &[u8]) -> NativeExtent {
    NativeExtent {
        bytes: bytes.len() as u64,
        sha256: Sha256::digest(bytes).into(),
    }
}
fn encode(bytes: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    append(
        &mut Cursor::new(bytes),
        &mut output,
        &metadata(),
        &extent(bytes),
        &mut WorkBudget::new(WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(RESIDENT_LIMIT),
    )
    .unwrap();
    output
}
fn verify(bytes: &[u8]) -> Result<Verified> {
    verify_exact(
        &mut Cursor::new(bytes),
        &mut WorkBudget::new(WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(RESIDENT_LIMIT),
    )
}
#[test]
fn actual_file_spool_preserves_all_bytes_and_unpaired_utf16_and_full128() {
    let input = body();
    let mut source = tempfile::tempfile().unwrap();
    source.write_all(&input).unwrap();
    source.seek(SeekFrom::Start(0)).unwrap();
    let mut output = tempfile::tempfile().unwrap();
    let mut work = WorkBudget::new(WORK_LIMIT);
    let resident = Resident::new(RESIDENT_LIMIT);
    let cancel = AtomicBool::new(false);
    let count = append(
        &mut source,
        &mut output,
        &metadata(),
        &extent(&input),
        &mut work,
        &cancel,
        &resident,
    )
    .unwrap();
    output.seek(SeekFrom::Start(0)).unwrap();
    let saved = verify_exact(&mut output, &mut work, &cancel, &resident).unwrap();
    let expected: [u8; 32] = Sha256::digest(&input).into();
    assert_eq!(saved.metadata, metadata());
    assert_eq!(saved.native.sha256, expected);
    assert_eq!(saved.stored_bytes, count);
    assert_eq!(saved.native.bytes, input.len() as u64);
    assert_ne!(saved.record_sha256, [0; 32]);
    output
        .seek(SeekFrom::Start(
            (FIXED + metadata().raw_leaf.len() * 2) as u64,
        ))
        .unwrap();
    let mut recovered = vec![0u8; input.len()];
    output.read_exact(&mut recovered).unwrap();
    assert_eq!(recovered, input);
}
#[test]
fn data_metadata_footer_mutation_and_trailing_bytes_are_not_accepted() {
    let bytes = encode(&body());
    for at in [18, FIXED + 6, bytes.len() - 1] {
        let mut changed = bytes.clone();
        changed[at] ^= 1;
        assert!(verify(&changed).is_err());
    }
    let mut extra = bytes.clone();
    extra.push(0);
    assert!(verify(&extra).is_err());
    for end in [0, 8, FIXED, bytes.len() - 1] {
        assert!(verify(&bytes[..end]).is_err());
    }
}
#[test]
fn actual_input_extent_or_hash_mismatch_never_emits_completion() {
    let bytes = body();
    for delta in [-1i64, 1] {
        let mut expected = extent(&bytes);
        expected.bytes = (bytes.len() as i64 + delta) as u64;
        let mut out = Vec::new();
        assert!(
            append(
                &mut Cursor::new(&bytes),
                &mut out,
                &metadata(),
                &expected,
                &mut WorkBudget::new(WORK_LIMIT),
                &AtomicBool::new(false),
                &Resident::new(RESIDENT_LIMIT)
            )
            .is_err()
        );
        assert!(verify(&out).is_err());
    }
    let mut expected = extent(&bytes);
    expected.sha256[0] ^= 1;
    let mut out = Vec::new();
    assert!(matches!(
        append(
            &mut Cursor::new(&bytes),
            &mut out,
            &metadata(),
            &expected,
            &mut WorkBudget::new(WORK_LIMIT),
            &AtomicBool::new(false),
            &Resident::new(RESIDENT_LIMIT)
        ),
        Err(Error::Changed)
    ));
    assert!(verify(&out).is_err());
}
#[test]
fn cancelled_or_insufficient_shared_budget_does_not_become_complete() {
    let bytes = body();
    let mut out = Vec::new();
    assert!(matches!(
        append(
            &mut Cursor::new(&bytes),
            &mut out,
            &metadata(),
            &extent(&bytes),
            &mut WorkBudget::new(WORK_LIMIT),
            &AtomicBool::new(true),
            &Resident::new(RESIDENT_LIMIT)
        ),
        Err(Error::Cancelled)
    ));
    assert!(out.is_empty());
    assert!(
        append(
            &mut Cursor::new(&bytes),
            &mut out,
            &metadata(),
            &extent(&bytes),
            &mut WorkBudget::new(2 * BLOCK as u64),
            &AtomicBool::new(false),
            &Resident::new(RESIDENT_LIMIT)
        )
        .is_err()
    );
    assert!(verify(&out).is_err());
}
struct BrokenWriter {
    bytes: Vec<u8>,
    left: usize,
}
impl Write for BrokenWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.left == 0 {
            return Err(io::Error::from_raw_os_error(28));
        }
        let n = bytes.len().min(self.left);
        self.bytes.extend(&bytes[..n]);
        self.left -= n;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[test]
fn actual_partial_output_failure_keeps_incomplete_bytes_and_original_error() {
    let bytes = body();
    let mut out = BrokenWriter {
        bytes: Vec::new(),
        left: FIXED + 6 + 33,
    };
    assert!(matches!(
        append(
            &mut Cursor::new(&bytes),
            &mut out,
            &metadata(),
            &extent(&bytes),
            &mut WorkBudget::new(WORK_LIMIT),
            &AtomicBool::new(false),
            &Resident::new(RESIDENT_LIMIT)
        ),
        Err(Error::Io {
            phase: "fragmentWrite",
            code: Some(28)
        })
    ));
    assert_eq!(out.bytes.len(), FIXED + 6 + 33);
    assert!(verify(&out.bytes).is_err());
}
#[test]
fn invalid_namespace_spelling_and_zero_identity_are_refused_before_output() {
    let bytes = body();
    for raw in [
        vec![],
        vec![46, 46],
        vec![97, 47, 98],
        vec![97, 0],
        vec![97, 46],
    ] {
        let mut meta = metadata();
        meta.raw_leaf = raw;
        let mut out = Vec::new();
        assert!(
            append(
                &mut Cursor::new(&bytes),
                &mut out,
                &meta,
                &extent(&bytes),
                &mut WorkBudget::new(WORK_LIMIT),
                &AtomicBool::new(false),
                &Resident::new(RESIDENT_LIMIT)
            )
            .is_err()
        );
        assert!(out.is_empty());
    }
    let mut meta = metadata();
    meta.source_id = 0;
    let mut out = Vec::new();
    assert!(
        append(
            &mut Cursor::new(&bytes),
            &mut out,
            &meta,
            &extent(&bytes),
            &mut WorkBudget::new(WORK_LIMIT),
            &AtomicBool::new(false),
            &Resident::new(RESIDENT_LIMIT)
        )
        .is_err()
    );
    assert!(out.is_empty());
}
#[test]
fn verified_record_retains_its_logical_metadata_reservation_until_drop() {
    let encoded = encode(&body());
    let resident = Resident::new(2 * BLOCK + 1024);
    let saved = verify_exact(
        &mut Cursor::new(&encoded),
        &mut WorkBudget::new(WORK_LIMIT),
        &AtomicBool::new(false),
        &resident,
    )
    .unwrap();
    assert!(resident.lease(2 * BLOCK + 1).is_err());
    drop(saved);
    assert!(resident.lease(2 * BLOCK + 1).is_ok());
}

#[test]
fn empty_ordinary_native_extent_roundtrips_without_inventing_payload_or_full_security() {
    use crate::file_access::material_carrier_records as records;
    let mut work = WorkBudget::new(WORK_LIMIT);
    let resident = Resident::new(RESIDENT_LIMIT);
    let cancel = AtomicBool::new(false);
    let expected = [(Vec::new(), 0)].into();
    let parsed = records::parse_profile(
        Cursor::new([]),
        &expected,
        false,
        &mut work,
        &cancel,
        &resident,
    )
    .unwrap();
    assert_eq!(parsed.bytes, 0);
    let encoded = encode(&[]);
    let saved = verify(&encoded).unwrap();
    assert_eq!(saved.metadata, metadata());
    assert_eq!(saved.native.bytes, parsed.bytes);
    assert_eq!(saved.native.sha256, parsed.sha256);
    assert_eq!(saved.stored_bytes as usize, FIXED + 6 + 40);
    assert_eq!(saved.stored_bytes as usize, encoded.len());
    // A byte-preservation frame grants no full-security or content authority.
    assert!(records::parse(Cursor::new([]), &expected, &mut work, &cancel, &resident,).is_err());
}

#[test]
fn empty_native_extent_requires_exact_eof_hash_and_footer_and_refuses_partial_headers() {
    let cancel = AtomicBool::new(false);
    let resident = Resident::new(RESIDENT_LIMIT);
    let mut work = WorkBudget::new(WORK_LIMIT);
    let mut wrong_hash = extent(&[]);
    wrong_hash.sha256[0] ^= 1;
    for (source, claimed) in [(vec![0u8], extent(&[])), (Vec::new(), wrong_hash)] {
        let mut out = Vec::new();
        assert!(
            append(
                &mut Cursor::new(source),
                &mut out,
                &metadata(),
                &claimed,
                &mut work,
                &cancel,
                &resident,
            )
            .is_err()
        );
        assert!(verify(&out).is_err());
    }
    let encoded = encode(&[]);
    for end in [0, FIXED, encoded.len() - 1] {
        assert!(verify(&encoded[..end]).is_err());
    }
    let mut trailing = encoded.clone();
    trailing.push(0);
    assert!(verify(&trailing).is_err());
    let mut corrupt = encoded;
    *corrupt.last_mut().unwrap() ^= 1;
    assert!(verify(&corrupt).is_err());
    for bytes in 1..20 {
        let raw = vec![0; bytes];
        let mut out = Vec::new();
        assert!(
            append(
                &mut Cursor::new(&raw),
                &mut out,
                &metadata(),
                &extent(&raw),
                &mut work,
                &cancel,
                &resident,
            )
            .is_err()
        );
        assert!(out.is_empty());
    }
}
