use super::*;
use std::io::{self, Cursor};

fn stream(data: &[u8]) -> Vec<u8> {
    let mut raw = vec![0; 20];
    raw[..4].copy_from_slice(&1u32.to_le_bytes());
    raw[8..16].copy_from_slice(&(data.len() as u64).to_le_bytes());
    raw.extend(data);
    raw
}
fn parsed(raw: &[u8], length: usize) -> records::Parsed {
    records::parse_profile(
        Cursor::new(raw),
        &[(Vec::new(), length as u64)].into(),
        false,
        &mut WorkBudget::new(records::WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(records::RESIDENT_LIMIT),
    )
    .unwrap()
}
fn bytes(file: &File) -> Vec<u8> {
    let mut input = file;
    input.rewind().unwrap();
    let mut result = Vec::new();
    input.read_to_end(&mut result).unwrap();
    result
}
fn run<R: Read + Seek>(input: R, file: &File, proof: &records::Parsed) -> Result<()> {
    restore(
        input,
        file,
        proof,
        &mut WorkBudget::new(records::WORK_LIMIT),
        &AtomicBool::new(false),
        &Resident::new(records::RESIDENT_LIMIT),
    )
}
#[test]
fn exact_short_payload_uses_original_file_and_refuses_native_threshold() {
    assert_eq!(size_of::<WIN32_STREAM_ID>() + 1, 25);
    for size in 1..=5 {
        let payload: Vec<u8> = [0, 255, 3, 128, 5][..size].to_vec();
        let raw = stream(&payload);
        let proof = parsed(&raw, size);
        let target = tempfile::tempfile().unwrap();
        let before = stamp(&target).unwrap();
        let result = run(Cursor::new(&raw), &target, &proof);
        if size < 5 {
            result.unwrap();
            assert_eq!(bytes(&target), payload);
        } else {
            assert_eq!(result, Err(Error::Unsupported));
            assert!(bytes(&target).is_empty());
        }
        assert_eq!(stamp(&target).unwrap().identity, before.identity);
    }
}

struct WrongSeek(Cursor<Vec<u8>>);
impl Read for WrongSeek {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        self.0.read(out)
    }
}
impl Seek for WrongSeek {
    fn seek(&mut self, at: SeekFrom) -> io::Result<u64> {
        self.0.seek(at).map(|actual| actual + 1)
    }
}
#[test]
fn changed_truncated_extra_or_mispositioned_input_cannot_write_target() {
    let raw = stream(&[0, 255, 3]);
    let proof = parsed(&raw, 3);
    let target = tempfile::tempfile().unwrap();
    let before = stamp(&target).unwrap();
    let mut changed = raw.clone();
    changed[20] ^= 1;
    assert_eq!(
        run(Cursor::new(changed), &target, &proof),
        Err(Error::Changed)
    );
    assert!(bytes(&target).is_empty());
    assert!(matches!(
        run(Cursor::new(&raw[..raw.len() - 1]), &target, &proof),
        Err(Error::Io {
            phase: "shortDefaultRead",
            ..
        })
    ));
    assert!(bytes(&target).is_empty());
    assert_eq!(
        run(
            Cursor::new([raw.clone(), vec![0]].concat()),
            &target,
            &proof
        ),
        Err(Error::Changed)
    );
    assert!(bytes(&target).is_empty());
    assert_eq!(
        run(WrongSeek(Cursor::new(raw)), &target, &proof),
        Err(Error::Changed)
    );
    assert!(bytes(&target).is_empty());
    assert_eq!(stamp(&target).unwrap().identity, before.identity);
}
#[test]
fn nonempty_target_budget_and_cancellation_refuse_before_payload_write() {
    let raw = stream(&[0, 255, 3]);
    let proof = parsed(&raw, 3);
    let target = tempfile::tempfile().unwrap();
    let before = stamp(&target).unwrap();
    for (limit, cancelled, memory, error) in [
        (9, false, records::RESIDENT_LIMIT, Error::Limit),
        (
            records::WORK_LIMIT,
            true,
            records::RESIDENT_LIMIT,
            Error::Cancelled,
        ),
        (records::WORK_LIMIT, false, 24, Error::Limit),
    ] {
        assert_eq!(
            restore(
                Cursor::new(&raw),
                &target,
                &proof,
                &mut WorkBudget::new(limit),
                &AtomicBool::new(cancelled),
                &Resident::new(memory)
            ),
            Err(error)
        );
        assert!(bytes(&target).is_empty());
        assert_eq!(stamp(&target).unwrap().identity, before.identity);
    }
    let mut original = &target;
    original.write_all(b"preserved").unwrap();
    assert_eq!(run(Cursor::new(raw), &target, &proof), Err(Error::Changed));
    assert_eq!(bytes(&target), b"preserved");
    assert_eq!(stamp(&target).unwrap().identity, before.identity);
}
#[test]
fn missing_original_write_right_is_reported_without_reopening_target() {
    let temp = crate::test_support::tempdir().unwrap();
    let path = temp.path().join("read-only-handle.bin");
    std::fs::write(&path, []).unwrap();
    let target = File::open(&path).unwrap();
    let before = stamp(&target).unwrap();
    let raw = stream(&[0, 255, 3]);
    let proof = parsed(&raw, 3);
    assert!(matches!(
        run(Cursor::new(raw), &target, &proof),
        Err(Error::Io {
            phase: "shortDefaultWrite",
            code: Some(5)
        })
    ));
    assert!(bytes(&target).is_empty());
    assert_eq!(stamp(&target).unwrap().identity, before.identity);
}
