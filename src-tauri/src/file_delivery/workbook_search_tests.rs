use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::io::{Cursor, Write};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

fn package(payload: &[u8], method: CompressionMethod) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("[Content_Types].xml", b"<Types/>".as_slice()),
        ("_rels/.rels", b"<Relationships/>".as_slice()),
        ("xl/workbook.xml", b"<workbook/>".as_slice()),
        (
            "xl/worksheets/sheet1.xml",
            b"<worksheet><c><v>author</v></c></worksheet>".as_slice(),
        ),
        ("xl/ignored.bin", payload),
    ] {
        writer
            .start_file(
                name,
                SimpleFileOptions::default().compression_method(method),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn sized_package(size: usize) -> Vec<u8> {
    let overhead = package(&[], CompressionMethod::Stored).len();
    let bytes = package(&vec![b'x'; size - overhead], CompressionMethod::Stored);
    assert_eq!(bytes.len(), size);
    bytes
}

fn fixture(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf, VerifiedFile) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("selected.xlsx");
    std::fs::write(&path, bytes).unwrap();
    let file = super::super::inspect(dir.path(), &path).unwrap();
    (dir, path, file)
}

#[test]
fn search_rejects_one_mib_plus_one_while_legacy_workbook_stays_usable() {
    let bytes = sized_package(super::super::MAX_TEXT_BYTES as usize + 1);
    let (_dir, path, file) = fixture(&bytes);
    assert!(
        read_workbook(&file).is_ok(),
        "legacy16MiB preview unchanged"
    );
    assert!(matches!(
        read_workbook_search(&file),
        Err(WorkbookError::File(DeliveryError::TooLarge))
    ));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn search_exact_one_mib_preserves_xml_parts_and_complete_receipt() {
    let bytes = sized_package(super::super::MAX_TEXT_BYTES as usize);
    let (dir, path, file) = fixture(&bytes);
    let captured = read_workbook_search(&file).unwrap();
    assert_eq!(captured.file, file);
    assert_eq!(captured.file.sha256, super::super::content_hash(&bytes));
    assert_eq!(captured.entries.len(), 5);
    assert_eq!(captured.parts.len(), 4);
    let sheet = captured
        .parts
        .iter()
        .find(|part| part.name == "xl/worksheets/sheet1.xml")
        .unwrap();
    assert_eq!(
        STANDARD.decode(&sheet.data).unwrap(),
        b"<worksheet><c><v>author</v></c></worksheet>"
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn search_oversize_open_and_post_open_growth_are_bounded_before_hashing() {
    let (_dir, path, file) = fixture(&package(b"small", CompressionMethod::Stored));
    let opened = search_source::open(&file).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(super::super::MAX_TEXT_BYTES + 1)
        .unwrap();
    assert!(matches!(
        search_source::capture(&file, opened),
        Err(DeliveryError::TooLarge)
    ));
    let mut entered_body = false;
    let result = search_source::open(&file).and_then(|opened| {
        entered_body = true;
        search_source::capture(&file, opened)
    });
    assert!(matches!(result, Err(DeliveryError::TooLarge)));
    assert!(!entered_body, "oversize metadata must precede body reading");
    assert!(matches!(
        read_workbook_search(&file),
        Err(WorkbookError::File(DeliveryError::TooLarge))
    ));
}

#[test]
fn search_rejects_all_seven_stale_fields_and_same_byte_inode_replacement() {
    let bytes = package(b"small", CompressionMethod::Deflated);
    let (dir, path, file) = fixture(&bytes);
    let other = dir.path().join("other.xlsx");
    std::fs::write(&other, &bytes).unwrap();
    let other_root = tempfile::tempdir().unwrap();
    for field in 0..7 {
        let mut changed = file.clone();
        match field {
            0 => changed.root = other_root.path().to_str().unwrap().to_owned(),
            1 => changed.path = other.to_str().unwrap().to_owned(),
            2 => changed.resolved_path = other.to_str().unwrap().to_owned(),
            3 => changed.name.push('x'),
            4 => changed.size += 1,
            5 => changed.sha256 = "0".repeat(64),
            _ => changed.version = "0".repeat(64),
        }
        assert!(
            matches!(
                read_workbook_search(&changed),
                Err(WorkbookError::File(DeliveryError::Changed))
            ),
            "field {field}"
        );
    }
    let opened = search_source::open(&file).unwrap();
    std::fs::rename(&other, &path).unwrap();
    assert!(matches!(
        search_source::capture(&file, opened),
        Err(DeliveryError::Changed)
    ));
    assert!(matches!(
        read_workbook_search(&file),
        Err(WorkbookError::File(DeliveryError::Changed))
    ));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[cfg(unix)]
#[test]
fn search_redirected_selected_path_is_changed_before_body_reading() {
    let bytes = package(b"small", CompressionMethod::Stored);
    let (dir, path, _) = fixture(&bytes);
    let alias = dir.path().join("alias.xlsx");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    let file = super::super::inspect_text(&alias).unwrap();
    assert!(read_workbook_search(&file).is_ok());
    let opened = search_source::open(&file).unwrap();
    let other = dir.path().join("other.xlsx");
    std::fs::write(&other, &bytes).unwrap();
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&other, &alias).unwrap();
    assert!(matches!(
        search_source::capture(&file, opened),
        Err(DeliveryError::Changed)
    ));
    assert!(matches!(
        search_source::open(&file),
        Err(DeliveryError::Changed)
    ));
}

#[test]
fn search_crc_checks_ignored_binary_and_rejects_inflate_over_budget() {
    let payload = b"IGNORED_XLSX_SEARCH_CRC";
    let mut bytes = package(payload, CompressionMethod::Stored);
    let offset = bytes
        .windows(payload.len())
        .position(|v| v == payload)
        .unwrap();
    bytes[offset] ^= 1;
    let (_dir, _, file) = fixture(&bytes);
    assert!(matches!(
        read_workbook_search(&file),
        Err(WorkbookError::Invalid)
    ));
    let oversized = package(
        &vec![0; ooxml_archive::MAX_PART as usize + 1],
        CompressionMethod::Deflated,
    );
    assert!(oversized.len() < super::super::MAX_TEXT_BYTES as usize);
    let (_dir, _, file) = fixture(&oversized);
    assert!(matches!(
        read_workbook_search(&file),
        Err(WorkbookError::Limit)
    ));
}

#[test]
fn search_authored_workbook_matches_original_capture_without_extension_authority() {
    let bytes = include_bytes!("../../../src/runtime/fixtures/xlsx-basic.xlsx");
    let (dir, path, _) = fixture(bytes);
    let renamed = dir.path().join("selected.bin");
    std::fs::rename(path, &renamed).unwrap();
    let file = super::super::inspect_text(&renamed).unwrap();
    let actual = read_workbook_search(&file).unwrap();
    assert_eq!(actual.file, file);
    assert_eq!(actual.parts.len(), 6);
    assert_eq!(
        serde_json::to_value(&actual).unwrap(),
        serde_json::to_value(read_workbook(&file).unwrap()).unwrap()
    );
    // The backend only captures parts; workbook content types/relationships and
    // the visible saved-cell search semantics still belong to the shared parser.
    let (_dir, _, file) = fixture(b"not a ZIP despite the xlsx suffix");
    assert!(matches!(
        read_workbook_search(&file),
        Err(WorkbookError::Unsupported)
    ));
}
