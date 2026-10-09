use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::io::{Cursor, Write};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

fn package(extra: &[(&str, &[u8])]) -> Vec<u8> {
    package_with(extra, CompressionMethod::Deflated)
}

fn package_with(extra: &[(&str, &[u8])], method: CompressionMethod) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("[Content_Types].xml", b"<Types/>".as_slice()),
        ("_rels/.rels", b"<Relationships/>".as_slice()),
        ("word/document.xml", b"<document/>".as_slice()),
    ]
    .iter()
    .chain(extra)
    {
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

fn capture(bytes: &[u8]) -> Result<DocxCapture, DocumentError> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sample.docx");
    std::fs::write(&path, bytes).unwrap();
    let expected = super::super::inspect(dir.path(), &path).unwrap();
    let result = read_docx(&expected);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    result
}

#[test]
fn docx_capture_retains_only_xml_and_byte_recognized_png_jpeg_candidates() {
    let png = b"\x89PNG\r\n\x1a\nnot-decoded-here";
    let jpeg = b"\xff\xd8\xffnot-decoded-here";
    let bytes = package(&[
        ("word/media/renamed.bin", png),
        ("word/media/no-extension", jpeg),
        ("word/media/fake.png", b"not an image"),
        ("word/media/vector.svg", b"<svg/>"),
        ("word/embedded.dat", b"ignored but validated"),
    ]);
    let captured = capture(&bytes).unwrap();
    assert_eq!(captured.parts.len(), 5);
    assert_eq!(captured.entries.len(), 8);
    for (name, expected) in [
        ("word/media/renamed.bin", png.as_slice()),
        ("word/media/no-extension", jpeg.as_slice()),
    ] {
        let part = captured
            .parts
            .iter()
            .find(|part| part.name == name)
            .unwrap();
        assert_eq!(STANDARD.decode(&part.data).unwrap(), expected);
    }
    assert!(
        !captured
            .parts
            .iter()
            .any(|part| part.name.ends_with(".png"))
    );
    assert!(captured.inflated_bytes > (png.len() + jpeg.len()) as u64);
}

#[test]
fn docx_capture_rejects_over_budget_image_candidates() {
    let mut large = vec![0; 8 * 1024 * 1024 + 1];
    large[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    assert!(matches!(
        capture(&package(&[("word/media/large", &large)])),
        Err(DocumentError::Limit)
    ));
}

#[test]
fn docx_capture_rejects_excess_candidate_image_count() {
    let names: Vec<_> = (0..257).map(|n| format!("word/media/{n}")).collect();
    let entries: Vec<_> = names
        .iter()
        .map(|name| (name.as_str(), b"\xff\xd8\xff".as_slice()))
        .collect();
    assert!(matches!(
        capture(&package(&entries)),
        Err(DocumentError::Limit)
    ));
}

#[test]
fn docx_capture_checks_exact_version_and_does_not_extract() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("version.docx");
    let bytes = package(&[]);
    std::fs::write(&path, &bytes).unwrap();
    let expected = super::super::inspect(dir.path(), &path).unwrap();
    assert_eq!(read_docx(&expected).unwrap().file, expected);
    let mut forged = expected.clone();
    forged.version.push('0');
    assert!(matches!(
        read_docx(&forged),
        Err(DocumentError::File(super::super::DeliveryError::Changed))
    ));
    std::fs::write(&path, package(&[("new.xml", b"changed")])).unwrap();
    assert!(matches!(
        read_docx(&expected),
        Err(DocumentError::File(super::super::DeliveryError::Changed))
    ));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/evidence/2026-10-09-capability-hardening/docx-fixtures")
            .join(name),
    )
    .unwrap()
}

#[test]
fn docx_real_authored_rasters_reach_capture_and_xlsx_stays_xml_only() {
    let bytes = fixture("05-inline-png-jpeg.docx");
    let captured = capture(&bytes).unwrap();
    // Retained only when a developer explicitly runs this authored fixture with
    // --nocapture; never prints a selected user document or production request.
    println!(
        "DOCX_BACKEND_CAPTURE={}",
        serde_json::to_string(&captured).unwrap()
    );
    for (name, signature) in [
        ("word/media/red.png", b"\x89PNG\r\n\x1a\n".as_slice()),
        ("word/media/blue.jpg", b"\xff\xd8\xff".as_slice()),
    ] {
        let part = captured.parts.iter().find(|p| p.name == name).unwrap();
        assert!(STANDARD.decode(&part.data).unwrap().starts_with(signature));
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("arbitrary.extension");
    std::fs::write(&path, bytes).unwrap();
    let file = super::super::inspect(dir.path(), &path).unwrap();
    let docx = read_docx(&file).unwrap();
    let xlsx = super::super::read_workbook(&file).unwrap();
    assert_eq!(docx.file, xlsx.file);
    assert_eq!(docx.entries, xlsx.entries);
    assert_eq!(docx.inflated_bytes, xlsx.inflated_bytes);
    assert_eq!(docx.parts.len(), xlsx.parts.len() + 2);
    assert!(
        xlsx.parts
            .iter()
            .all(|p| p.name.ends_with(".xml") || p.name.ends_with(".rels"))
    );
}

#[test]
fn docx_capture_validates_ignored_binary_and_candidate_image_crc() {
    for payload in [
        b"IGNORED_PAYLOAD".as_slice(),
        b"\x89PNG\r\n\x1a\nPIXELS".as_slice(),
    ] {
        let mut bytes = package_with(
            &[("word/media/arbitrary", payload)],
            CompressionMethod::Stored,
        );
        let offset = bytes
            .windows(payload.len())
            .position(|v| v == payload)
            .unwrap();
        bytes[offset + payload.len() - 1] ^= 1;
        assert!(matches!(capture(&bytes), Err(DocumentError::Invalid)));
    }
}

#[test]
fn docx_authored_container_boundaries_are_enforced_without_extraction() {
    for name in [
        "20-zip-crc-invalid.docx",
        "21-duplicate-entry.docx",
        "22-path-escape-entry.docx",
    ] {
        assert!(
            matches!(capture(&fixture(name)), Err(DocumentError::Invalid)),
            "{name}"
        );
    }
    for name in [
        "24-entry-count-over.docx",
        "26-part-size-over.docx",
        "28-total-size-over.docx",
    ] {
        assert!(
            matches!(capture(&fixture(name)), Err(DocumentError::Limit)),
            "{name}"
        );
    }
    let count = capture(&fixture("23-entry-count-at.docx")).unwrap();
    assert_eq!(count.entries.len(), 2048);
    let part = capture(&fixture("25-part-size-at.docx")).unwrap();
    assert!(part.inflated_bytes >= 16 * 1024 * 1024);
    let total = capture(&fixture("27-total-size-at.docx")).unwrap();
    assert_eq!(total.inflated_bytes, 64 * 1024 * 1024);
}

#[test]
fn docx_capture_does_not_confuse_inert_bytes_with_semantic_acceptance() {
    // Capturing these bytes is intentional. The worker must reject the relevant
    // OPC structures and never execute/fetch/render their raw XML or binary data.
    for name in [
        "06-png-pixels-invalid.docx",
        "09-external-relationships.docx",
        "10-altchunk-html.docx",
        "11-macro-content-type.docx",
        "12-vba-marker-entry.docx",
        "17-doctype.docx",
        "19-missing-image-part.docx",
    ] {
        let captured = capture(&fixture(name)).unwrap();
        assert!(
            captured
                .parts
                .iter()
                .any(|p| p.name == "[Content_Types].xml")
        );
        assert!(!captured.entries.is_empty());
        assert!(
            captured
                .parts
                .iter()
                .all(|p| !p.name.ends_with(".bin") && !p.name.ends_with(".html"))
        );
    }
}

#[test]
fn docx_capture_image_budgets_accept_the_exact_boundaries() {
    let mut image = vec![0; 8 * 1024 * 1024];
    image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    let captured = capture(&package(&[("word/media/exact", &image)])).unwrap();
    assert_eq!(
        STANDARD
            .decode(&captured.parts.last().unwrap().data)
            .unwrap()
            .len(),
        image.len()
    );
    let names: Vec<_> = (0..256).map(|n| format!("word/media/{n}")).collect();
    let entries: Vec<_> = names
        .iter()
        .map(|n| (n.as_str(), b"\xff\xd8\xff".as_slice()))
        .collect();
    assert_eq!(capture(&package(&entries)).unwrap().parts.len(), 259);
}

#[test]
fn docx_failures_return_fixed_codes_without_raw_io_details() {
    use super::super::DeliveryError;
    for (error, expected) in [
        (DocumentError::Invalid, "invalid"),
        (DocumentError::Limit, "limit"),
        (DocumentError::Encrypted, "encrypted"),
        (DocumentError::Unsupported, "unsupported"),
        (DocumentError::File(DeliveryError::Changed), "changed"),
        (DocumentError::File(DeliveryError::TooLarge), "limit"),
        (DocumentError::File(DeliveryError::Unreadable), "unreadable"),
    ] {
        assert_eq!(
            serde_json::to_value(DocxReadFailure::from(error)).unwrap(),
            serde_json::json!({"code": expected})
        );
    }
    assert_eq!(
        serde_json::to_value(DocxReadFailure::check("private IO detail must not escape")).unwrap(),
        serde_json::json!({"code": "unreadable"})
    );
}

#[test]
fn docx_and_xlsx_report_the_same_container_failure_codes() {
    for (name, code) in [
        ("20-zip-crc-invalid.docx", "invalid"),
        ("21-duplicate-entry.docx", "invalid"),
        ("22-path-escape-entry.docx", "invalid"),
        ("24-entry-count-over.docx", "limit"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("container");
        std::fs::write(&path, fixture(name)).unwrap();
        let file = super::super::inspect(dir.path(), &path).unwrap();
        let document = DocxReadFailure::from(read_docx(&file).unwrap_err());
        let workbook = super::super::WorkbookReadFailure::from(
            super::super::read_workbook(&file).unwrap_err(),
        );
        assert_eq!(document.code, code, "{name}");
        assert_eq!(workbook.code, code, "{name}");
    }
}
