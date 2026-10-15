use super::super::{DeliveryError, MAX_TEXT_BYTES};
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
            "ppt/slides/slide9.xml",
            "<slide>中文 source</slide>".as_bytes(),
        ),
        ("ppt/ignored.bin", payload),
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
    let path = dir.path().join("selected.pptx");
    std::fs::write(&path, bytes).unwrap();
    let file = super::super::inspect(dir.path(), &path).unwrap();
    (dir, path, file)
}

#[test]
fn pptx_search_rejects_one_mib_plus_one_without_lowering_preview_limit() {
    let bytes = sized_package(MAX_TEXT_BYTES as usize + 1);
    let (_dir, path, file) = fixture(&bytes);
    assert!(read_pptx(&file).is_ok());
    assert!(matches!(
        read_pptx_search(&file),
        Err(PresentationError::File(DeliveryError::TooLarge))
    ));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn pptx_search_exact_one_mib_keeps_receipt_and_all_archive_members() {
    let bytes = sized_package(MAX_TEXT_BYTES as usize);
    let (dir, path, file) = fixture(&bytes);
    let capture = read_pptx_search(&file).unwrap();
    assert_eq!(capture.file, file);
    assert_eq!(capture.entries.len(), 4);
    assert_eq!(capture.parts.len(), 3);
    let slide = capture
        .parts
        .iter()
        .find(|p| p.name == "ppt/slides/slide9.xml")
        .unwrap();
    assert_eq!(
        STANDARD.decode(&slide.data).unwrap(),
        "<slide>中文 source</slide>".as_bytes()
    );
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn pptx_search_rejects_changed_bytes_and_untrusted_size() {
    let (_dir, path, mut file) = fixture(&package(b"small", CompressionMethod::Stored));
    let original = std::fs::read(&path).unwrap();
    let mut changed = original.clone();
    changed[0] ^= 1;
    std::fs::write(&path, &changed).unwrap();
    assert!(matches!(
        read_pptx_search(&file),
        Err(PresentationError::File(DeliveryError::Changed))
    ));
    std::fs::write(&path, sized_package(MAX_TEXT_BYTES as usize + 1)).unwrap();
    file.size = 1;
    assert!(matches!(
        read_pptx_search(&file),
        Err(PresentationError::File(DeliveryError::TooLarge))
    ));
}

#[test]
fn pptx_search_checks_crc_of_discarded_binary_members() {
    let mut bytes = package(b"UNIQUE_IGNORED_PAYLOAD", CompressionMethod::Stored);
    let start = bytes
        .windows(22)
        .position(|w| w == b"UNIQUE_IGNORED_PAYLOAD")
        .unwrap();
    bytes[start] ^= 1;
    let (_dir, _, file) = fixture(&bytes);
    assert!(matches!(
        read_pptx_search(&file),
        Err(PresentationError::Invalid)
    ));
}

#[test]
fn pptx_search_retains_archive_inflation_limit_for_ignored_content() {
    let bytes = package(
        &vec![b'x'; 16 * 1024 * 1024 + 1],
        CompressionMethod::Deflated,
    );
    assert!(bytes.len() <= MAX_TEXT_BYTES as usize);
    let (_dir, _, file) = fixture(&bytes);
    assert!(matches!(
        read_pptx_search(&file),
        Err(PresentationError::Limit)
    ));
}
