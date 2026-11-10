use super::*;
use std::io::Write;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

fn package(entries: &[(&str, &[u8])], method: CompressionMethod) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(
                *name,
                SimpleFileOptions::default().compression_method(method),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
fn valid() -> Vec<u8> {
    package(
        &[
            ("[Content_Types].xml", b"<Types/>"),
            ("_rels/.rels", b"<Relationships/>"),
            ("xl/workbook.xml", b"<workbook/>"),
        ],
        CompressionMethod::Stored,
    )
}
fn signature(bytes: &[u8], sig: &[u8; 4]) -> usize {
    bytes.windows(4).position(|s| s == sig).unwrap()
}
fn put16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}
fn put32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

#[test]
fn captures_one_verified_version_without_extracting_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sample.xlsx");
    std::fs::write(&path, valid()).unwrap();
    let file = super::super::inspect(dir.path(), &path).unwrap();
    let capture = read_workbook(&file).unwrap();
    assert_eq!(capture.file, file);
    assert_eq!(capture.parts.len(), 3);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    std::fs::write(&path, b"different").unwrap();
    assert!(matches!(
        read_workbook(&file),
        Err(WorkbookError::File(DeliveryError::Changed))
    ));
}

#[test]
fn authored_ooxml_fixture_produces_the_browser_capture_contract() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("xlsx-basic.xlsx");
    let bytes = include_bytes!("../../../src/runtime/fixtures/xlsx-basic.xlsx");
    std::fs::write(&path, bytes).unwrap();
    let expected = super::super::inspect(dir.path(), &path).unwrap();
    let captured = read_workbook(&expected).unwrap();
    assert_eq!(captured.file.sha256, super::super::content_hash(bytes));
    assert_eq!(captured.parts.len(), 6);
    assert!(captured.inflated_bytes > bytes.len() as u64);
    // --nocapture preserves an actual backend response for the isolated browser
    // fixture; normal tests do not write evidence or user data.
    println!(
        "XLSX_BACKEND_CAPTURE={}",
        serde_json::to_string(&captured).unwrap()
    );
}
#[test]
fn rejects_duplicate_names_and_path_aliases_before_zip_indexing() {
    for name in [
        "../escape.xml",
        "/absolute.xml",
        "a/./b.xml",
        "a\\b.xml",
        "a/%2e%2e/b.xml",
    ] {
        assert!(
            unpack(&package(&[(name, b"x")], CompressionMethod::Stored)).is_err(),
            "{name}"
        );
    }
    let mut bytes = package(
        &[("a.xml", b"a"), ("b.xml", b"b")],
        CompressionMethod::Stored,
    );
    for at in (0..bytes.len().saturating_sub(4)).collect::<Vec<_>>() {
        if bytes.get(at..at + 5) == Some(b"b.xml") {
            bytes[at] = b'a';
        }
    }
    assert!(matches!(unpack(&bytes), Err(WorkbookError::Invalid)));
}
#[test]
fn validates_crc_even_for_ignored_binary_entries() {
    let mut bytes = package(
        &[
            ("[Content_Types].xml", b"x"),
            ("_rels/.rels", b"x"),
            ("xl/media/payload.bin", b"PAYLOAD"),
        ],
        CompressionMethod::Stored,
    );
    let at = bytes.windows(7).position(|s| s == b"PAYLOAD").unwrap();
    bytes[at] = b'X';
    assert!(matches!(unpack(&bytes), Err(WorkbookError::Invalid)));
}
#[test]
fn rejects_encryption_truncation_header_mismatch_and_excess_entry_count() {
    let mut bytes = valid();
    let local = signature(&bytes, b"PK\x03\x04");
    let central = signature(&bytes, b"PK\x01\x02");
    put16(&mut bytes, local + 6, 1);
    put16(&mut bytes, central + 8, 1);
    assert!(matches!(unpack(&bytes), Err(WorkbookError::Encrypted)));
    let mut bytes = valid();
    bytes.pop();
    assert!(matches!(unpack(&bytes), Err(WorkbookError::Invalid)));
    let mut bytes = valid();
    put32(&mut bytes, local + 22, 999);
    assert!(unpack(&bytes).is_err());
    let mut bytes = valid();
    let end = signature(&bytes, b"PK\x05\x06");
    put16(&mut bytes, end + 10, 2049);
    put16(&mut bytes, end + 8, 2049);
    assert!(matches!(unpack(&bytes), Err(WorkbookError::Limit)));
}
#[test]
fn declared_sizes_do_not_authorize_unbounded_decompression() {
    let payload = vec![b'x'; MAX_PART as usize + 1];
    let mut bytes = package(&[("oversized.xml", &payload)], CompressionMethod::Deflated);
    assert!(matches!(unpack(&bytes), Err(WorkbookError::Limit)));
    // Lie consistently in both headers; actual output still cannot pass.
    let local = signature(&bytes, b"PK\x03\x04");
    let central = signature(&bytes, b"PK\x01\x02");
    put32(&mut bytes, local + 22, 1);
    put32(&mut bytes, central + 24, 1);
    assert!(unpack(&bytes).is_err());
}
#[test]
fn rejects_symlink_and_overlapping_local_records() {
    let mut bytes = valid();
    let central = signature(&bytes, b"PK\x01\x02");
    put32(&mut bytes, central + 38, 0o120777 << 16);
    assert!(matches!(unpack(&bytes), Err(WorkbookError::Unsupported)));
    let mut bytes = valid();
    let second = bytes[central + 4..]
        .windows(4)
        .position(|s| s == b"PK\x01\x02")
        .unwrap()
        + central
        + 4;
    put32(&mut bytes, second + 42, 0);
    assert!(unpack(&bytes).is_err());
}

#[test]
fn workbook_failure_receipts_only_contain_fixed_codes() {
    for (error, code) in [
        (WorkbookError::Invalid, "invalid"),
        (WorkbookError::Limit, "limit"),
        (WorkbookError::Encrypted, "encrypted"),
        (WorkbookError::Unsupported, "unsupported"),
        (WorkbookError::File(DeliveryError::Changed), "changed"),
        (WorkbookError::File(DeliveryError::Unreadable), "unreadable"),
        (WorkbookError::File(DeliveryError::TooLarge), "limit"),
    ] {
        assert_eq!(
            serde_json::to_value(WorkbookReadFailure::from(error)).unwrap(),
            serde_json::json!({"code": code})
        );
    }
}
