use super::*;
use std::{
    cell::Cell,
    io::{self, Cursor},
};

struct Short<'a> {
    input: Cursor<&'a [u8]>,
    max: usize,
    calls: &'a Cell<usize>,
}
impl Read for Short<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.calls.set(self.calls.get() + 1);
        let offered = output.len().min(self.max);
        self.input.read(&mut output[..offered])
    }
}
fn run(left: &[u8], right: &[u8]) -> Comparison {
    compare(
        &mut Cursor::new(left),
        left.len() as u64,
        &mut Cursor::new(right),
        right.len() as u64,
        &mut Budget::new(WORK_LIMIT),
        &AtomicBool::new(false),
    )
    .unwrap()
}
#[test]
fn actual_binary_chunks_and_unequal_short_reads_preserve_byte_alignment() {
    let bytes: Vec<u8> = (0..=255).cycle().take(BLOCK + 19).collect();
    let left_calls = Cell::new(0);
    let right_calls = Cell::new(0);
    let mut left = Short {
        input: Cursor::new(bytes.as_slice()),
        max: 7,
        calls: &left_calls,
    };
    let mut right = Short {
        input: Cursor::new(bytes.as_slice()),
        max: 31,
        calls: &right_calls,
    };
    let got = compare(
        &mut left,
        bytes.len() as u64,
        &mut right,
        bytes.len() as u64,
        &mut Budget::new(WORK_LIMIT),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(got.equal);
    assert_eq!(got.expected_sha256, got.actual_sha256);
    assert_eq!(got.expected_bytes, (BLOCK + 19) as u64);
    assert_eq!(got.actual_bytes, got.expected_bytes);
    assert!(left_calls.get() > right_calls.get());
    assert!(right_calls.get() > 2);
}
#[test]
fn known_sha256_and_empty_default_are_observed_through_real_readers() {
    let got = run(b"abc", b"abc");
    assert!(got.equal);
    assert_eq!(
        got.expected_sha256,
        [
            186, 120, 22, 191, 143, 1, 207, 234, 65, 65, 64, 222, 93, 174, 34, 35, 176, 3, 97, 163,
            150, 23, 122, 156, 180, 16, 255, 97, 242, 0, 21, 173
        ]
    );
    let empty = run(b"", b"");
    assert!(empty.equal);
    assert_eq!(empty.expected_bytes, 0);
    assert_eq!(
        empty.actual_sha256,
        [
            227, 176, 196, 66, 152, 252, 28, 20, 154, 251, 244, 200, 153, 111, 185, 36, 39, 174,
            65, 228, 100, 155, 147, 76, 164, 149, 153, 27, 120, 82, 184, 85
        ]
    );
}
#[test]
fn mismatch_after_a_complete_block_is_not_silently_truncated_or_prefix_equal() {
    let left = vec![3u8; BLOCK + 19];
    let mut right = left.clone();
    right[BLOCK + 18] = 4;
    let got = run(&left, &right);
    assert!(!got.equal);
    assert_ne!(got.expected_sha256, got.actual_sha256);
    assert_eq!(got.expected_bytes, left.len() as u64);
    assert_eq!(got.actual_bytes, right.len() as u64);
}
#[test]
fn different_real_lengths_are_a_complete_raw_difference_not_missing_tail_success() {
    let got = run(b"same-prefix", b"same-prefix-tail");
    assert!(!got.equal);
    assert_eq!(got.expected_bytes, 11);
    assert_eq!(got.actual_bytes, 16);
    assert!(!run(b"", b"one").equal);
}
#[test]
fn declared_truncation_and_overlong_input_are_refused_on_both_sides() {
    for (left, left_len, right, right_len) in [
        (&b"abc"[..], 4, &b"abc"[..], 3),
        (&b"abc"[..], 2, &b"abc"[..], 3),
        (&b"abc"[..], 3, &b"abc"[..], 4),
        (&b"abc"[..], 3, &b"abc"[..], 2),
    ] {
        assert_eq!(
            compare(
                &mut Cursor::new(left),
                left_len,
                &mut Cursor::new(right),
                right_len,
                &mut Budget::new(WORK_LIMIT),
                &AtomicBool::new(false)
            ),
            Err(Error::Changed)
        );
    }
}
#[test]
fn byte_budget_and_blob_cap_refuse_before_an_unfunded_read() {
    let calls = Cell::new(0);
    let mut input = Short {
        input: Cursor::new(b"abc".as_slice()),
        max: 3,
        calls: &calls,
    };
    assert_eq!(
        compare(
            &mut input,
            3,
            &mut Cursor::new(b"abc"),
            3,
            &mut Budget::new(0),
            &AtomicBool::new(false)
        ),
        Err(Error::Limit)
    );
    assert_eq!(calls.get(), 0);
    assert_eq!(
        compare(
            &mut input,
            MAX_BLOB + 1,
            &mut Cursor::new(b"abc"),
            3,
            &mut Budget::new(WORK_LIMIT),
            &AtomicBool::new(false)
        ),
        Err(Error::Limit)
    );
    assert_eq!(calls.get(), 0);
    // A zero-length EOF probe still needs one offered byte of budget; returned
    // zero bytes are not charged, and no EOF is inferred when no query occurred.
    assert_eq!(
        compare(
            &mut Cursor::new(b"abc"),
            3,
            &mut Cursor::new(b"abc"),
            3,
            &mut Budget::new(6),
            &AtomicBool::new(false)
        ),
        Err(Error::Limit)
    );
    assert!(
        compare(
            &mut Cursor::new(b"abc"),
            3,
            &mut Cursor::new(b"abc"),
            3,
            &mut Budget::new(7),
            &AtomicBool::new(false)
        )
        .unwrap()
        .equal
    );
}
#[test]
fn pre_cancel_and_cancel_after_actual_read_never_publish_a_comparison() {
    let calls = Cell::new(0);
    let mut input = Short {
        input: Cursor::new(b"abc".as_slice()),
        max: 3,
        calls: &calls,
    };
    assert_eq!(
        compare(
            &mut input,
            3,
            &mut Cursor::new(b"abc"),
            3,
            &mut Budget::new(WORK_LIMIT),
            &AtomicBool::new(true)
        ),
        Err(Error::Cancelled)
    );
    assert_eq!(calls.get(), 0);
    struct Cancels<'a> {
        cancel: &'a AtomicBool,
        input: Cursor<&'a [u8]>,
    }
    impl Read for Cancels<'_> {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            let got = self.input.read(out)?;
            self.cancel.store(true, Ordering::SeqCst);
            Ok(got)
        }
    }
    let cancel = AtomicBool::new(false);
    let mut input = Cancels {
        cancel: &cancel,
        input: Cursor::new(b"abc"),
    };
    assert_eq!(
        compare(
            &mut input,
            3,
            &mut Cursor::new(b"abc"),
            3,
            &mut Budget::new(WORK_LIMIT),
            &cancel
        ),
        Err(Error::Cancelled)
    );
}
#[test]
fn actual_read_errors_keep_object_or_material_side_and_native_code() {
    struct Fails(i32);
    impl Read for Fails {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::from_raw_os_error(self.0))
        }
    }
    assert_eq!(
        compare(
            &mut Fails(13),
            1,
            &mut Cursor::new(b"a"),
            1,
            &mut Budget::new(WORK_LIMIT),
            &AtomicBool::new(false)
        ),
        Err(Error::Io {
            side: "object",
            code: Some(13)
        })
    );
    assert_eq!(
        compare(
            &mut Cursor::new(b"a"),
            1,
            &mut Fails(87),
            1,
            &mut Budget::new(WORK_LIMIT),
            &AtomicBool::new(false)
        ),
        Err(Error::Io {
            side: "material",
            code: Some(87)
        })
    );
}
const ID: &str = "a48cf0de7af6613887a8f33ce5957001234ac817";
fn record(mode: &str, id: &str, size: &str, path: &[u8]) -> Vec<u8> {
    let mut bytes = format!("{mode} blob {id} {size}\t").into_bytes();
    bytes.extend(path);
    bytes.push(0);
    bytes
}
#[test]
fn selected_tree_path_and_object_must_belong_to_the_same_admitted_graph() {
    let raw = record("100644", ID, "7", b"owned.txt");
    let objects = [ID.to_owned()];
    let cancel = AtomicBool::new(false);
    let selected = select(&raw, b"owned.txt", &objects, 40, &cancel).unwrap();
    assert_eq!(selected.path.as_slice(), b"owned.txt");
    assert_eq!(selected.oid, ID);
    assert_eq!(selected.bytes, 7);
    assert_eq!(selected.tree_output_bytes, raw.len() as u64);
    assert_eq!(
        select(&raw, b"other.txt", &objects, 40, &cancel),
        Err(Error::NotSelected)
    );
    assert_eq!(
        select(&raw, b"owned.txt", &["b".repeat(40)], 40, &cancel),
        Err(Error::Changed)
    );
}
#[test]
fn wrong_width_duplicate_path_and_incomplete_or_empty_records_refuse() {
    let raw = record("100644", ID, "7", b"owned.txt");
    let objects = [ID.to_owned()];
    let cancel = AtomicBool::new(false);
    assert_eq!(
        select(&raw, b"owned.txt", &objects, 64, &cancel),
        Err(Error::Unsupported)
    );
    let mut duplicate = raw.clone();
    duplicate.extend(&raw);
    assert_eq!(
        select(&duplicate, b"owned.txt", &objects, 40, &cancel),
        Err(Error::Invalid)
    );
    assert_eq!(
        select(&raw[..raw.len() - 1], b"owned.txt", &objects, 40, &cancel),
        Err(Error::Invalid)
    );
    let mut empty_record = raw;
    empty_record.push(0);
    assert_eq!(
        select(&empty_record, b"owned.txt", &objects, 40, &cancel),
        Err(Error::Invalid)
    );
}
#[test]
fn symlinks_gitmodules_oversize_and_bad_size_do_not_become_regular_default_authority() {
    let objects = [ID.to_owned()];
    let cancel = AtomicBool::new(false);
    for (mode, size, path, expected) in [
        ("120000", "7", b"owned.txt".as_slice(), Error::Unsupported),
        ("100644", "7", b".gitmodules".as_slice(), Error::Unsupported),
        ("100644", "268435457", b"owned.txt".as_slice(), Error::Limit),
        ("100644", "+7", b"owned.txt".as_slice(), Error::Unsupported),
    ] {
        assert_eq!(
            select(&record(mode, ID, size, path), path, &objects, 40, &cancel),
            Err(expected)
        );
    }
    let excessive = vec![0; MAX_TREE_OUTPUT + 1];
    assert_eq!(
        select(&excessive, b"owned.txt", &objects, 40, &cancel),
        Err(Error::Limit)
    );
}
#[test]
fn cancellation_blocks_selection_before_publishing_any_entry() {
    assert_eq!(
        select(
            &record("100644", ID, "7", b"owned.txt"),
            b"owned.txt",
            &[ID.to_owned()],
            40,
            &AtomicBool::new(true)
        ),
        Err(Error::Cancelled)
    );
}
