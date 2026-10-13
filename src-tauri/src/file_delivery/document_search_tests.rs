use super::super::{
    DeliveryError,
    search_source::{capture as capture_search_source, open as open_search_source},
};
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::io::{Cursor, Write};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

fn package(payload: &[u8], method: CompressionMethod) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("[Content_Types].xml", b"<Types/>".as_slice()),
        ("_rels/.rels", b"<Relationships/>".as_slice()),
        (
            "word/document.xml",
            b"<document>author</document>".as_slice(),
        ),
        ("word/ignored.bin", payload),
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
    let path = dir.path().join("selected.docx");
    std::fs::write(&path, bytes).unwrap();
    let file = super::super::inspect(dir.path(), &path).unwrap();
    (dir, path, file)
}

#[test]
fn search_rejects_one_mib_plus_one_while_legacy_docx_stays_usable() {
    let bytes = sized_package(super::super::MAX_TEXT_BYTES as usize + 1);
    let (_dir, path, file) = fixture(&bytes);
    assert!(
        read_docx(&file).is_ok(),
        "legacy16MiB preview must stay usable"
    );
    assert!(matches!(
        read_docx_search(&file),
        Err(DocumentError::File(super::super::DeliveryError::TooLarge))
    ));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn search_exact_one_mib_preserves_all_parts_and_full_source_receipt() {
    let bytes = sized_package(super::super::MAX_TEXT_BYTES as usize);
    let (dir, path, file) = fixture(&bytes);
    let captured = read_docx_search(&file).unwrap();
    assert_eq!(captured.file, file);
    assert_eq!(captured.entries.len(), 4);
    assert_eq!(captured.parts.len(), 3);
    let body = captured
        .parts
        .iter()
        .find(|p| p.name == "word/document.xml")
        .unwrap();
    assert_eq!(
        STANDARD.decode(&body.data).unwrap(),
        b"<document>author</document>"
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn search_oversize_open_and_post_open_growth_never_hash_the_large_body() {
    let bytes = package(b"small", CompressionMethod::Stored);
    let (_dir, path, file) = fixture(&bytes);
    let opened = open_search_source(&file).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(super::super::MAX_TEXT_BYTES + 1)
        .unwrap();
    // Once opened, take(max+1) limits growth and rejects before content hashing.
    assert!(matches!(
        capture_search_source(&file, opened),
        Err(DeliveryError::TooLarge)
    ));
    let mut entered_body = false;
    let result = open_search_source(&file).and_then(|opened| {
        entered_body = true;
        capture_search_source(&file, opened)
    });
    assert!(matches!(result, Err(DeliveryError::TooLarge)));
    assert!(
        !entered_body,
        "oversize metadata must reject before body capture"
    );
}

#[test]
fn search_all_seven_source_fields_and_same_byte_replacement_are_checked() {
    let bytes = package(b"small", CompressionMethod::Deflated);
    let (dir, path, file) = fixture(&bytes);
    let other = dir.path().join("other.docx");
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
                read_docx_search(&changed),
                Err(DocumentError::File(DeliveryError::Changed))
            ),
            "field {field}"
        );
    }
    let opened = open_search_source(&file).unwrap();
    std::fs::rename(&other, &path).unwrap();
    assert!(matches!(
        capture_search_source(&file, opened),
        Err(DeliveryError::Changed)
    ));
    assert!(matches!(
        open_search_source(&file),
        Err(DeliveryError::Changed)
    ));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[cfg(unix)]
#[test]
fn search_redirected_symlink_is_rejected_before_body_capture() {
    let bytes = package(b"small", CompressionMethod::Stored);
    let (dir, path, _) = fixture(&bytes);
    let alias = dir.path().join("alias.docx");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    let expected = super::super::inspect_text(&alias).unwrap();
    assert!(read_docx_search(&expected).is_ok());
    let other = dir.path().join("other.docx");
    std::fs::write(&other, &bytes).unwrap();
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&other, &alias).unwrap();
    assert!(matches!(
        open_search_source(&expected),
        Err(DeliveryError::Changed)
    ));
}

#[test]
fn search_crc_checks_ignored_bytes_and_keeps_inflation_limits() {
    let payload = b"IGNORED_SEARCH_CRC_PAYLOAD";
    let mut bytes = package(payload, CompressionMethod::Stored);
    let offset = bytes
        .windows(payload.len())
        .position(|v| v == payload)
        .unwrap();
    bytes[offset] ^= 1;
    let (_dir, _, file) = fixture(&bytes);
    assert!(matches!(
        read_docx_search(&file),
        Err(DocumentError::Invalid)
    ));
    let large = vec![0; ooxml_archive::MAX_PART as usize + 1];
    let bytes = package(&large, CompressionMethod::Deflated);
    assert!(bytes.len() < super::super::MAX_TEXT_BYTES as usize);
    let (_dir, _, file) = fixture(&bytes);
    assert!(matches!(read_docx_search(&file), Err(DocumentError::Limit)));
}

#[test]
fn search_neither_extension_nor_zip_capture_asserts_docx_semantics() {
    let (_dir, _, file) = fixture(b"not a ZIP despite the docx suffix");
    assert!(matches!(
        read_docx_search(&file),
        Err(DocumentError::Unsupported)
    ));
    // This deliberately minimal package has no OPC semantics. Capture is passive;
    // the shared DOCX worker must still reject invalid types/relationships.
    let bytes = package(b"small", CompressionMethod::Deflated);
    let (dir, path, _) = fixture(&bytes);
    let renamed = dir.path().join("untrusted.bin");
    std::fs::rename(path, &renamed).unwrap();
    let file = super::super::inspect_text(&renamed).unwrap();
    assert_eq!(read_docx_search(&file).unwrap().file, file);
}
