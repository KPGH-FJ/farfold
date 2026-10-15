use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::io::{Cursor, Write};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nINERT_PNG_CANDIDATE";
const JPEG: &[u8] = b"\xff\xd8\xffINERT_JPEG_CANDIDATE";

fn package(extra: &[(&str, &[u8])], method: CompressionMethod) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("[Content_Types].xml", b"<Types/>".as_slice()),
        ("_rels/.rels", b"<Relationships/>".as_slice()),
        ("ppt/presentation.xml", b"<presentation/>".as_slice()),
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

fn capture(bytes: &[u8]) -> Result<PptxCapture, PresentationError> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("selected.pptx");
    std::fs::write(&path, bytes).unwrap();
    let file = super::super::inspect(dir.path(), &path).unwrap();
    let result = read_pptx(&file);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    result
}

fn code(bytes: &[u8]) -> &'static str {
    PptxReadFailure::from(capture(bytes).unwrap_err()).code
}

fn signature(bytes: &[u8], sig: &[u8; 4]) -> usize {
    bytes.windows(4).position(|window| window == sig).unwrap()
}

fn put16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn put32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

#[test]
fn pptx_capture_is_passive_and_keeps_the_complete_manifest_and_dto() {
    let extras = [
        ("ppt/slides/slide7.xml", b"<slide/>".as_slice()),
        ("ppt/slides/_rels/slide7.xml.rels", b"<rels/>"),
        ("ppt/media/renamed.dat", PNG),
        ("ppt/media/no-extension", JPEG),
        ("ppt/media/fake.png", b"not an image"),
        ("ppt/media/vector.svg", b"<svg/>"),
        ("ppt/vbaProject.bin", b"INERT_BINARY"),
    ];
    let captured = capture(&package(&extras, CompressionMethod::Stored)).unwrap();
    assert_eq!(captured.entries.len(), 10);
    assert_eq!(captured.parts.len(), 7);
    for (name, expected) in extras.iter().take(4) {
        let part = captured
            .parts
            .iter()
            .find(|part| part.name == *name)
            .unwrap();
        assert_eq!(STANDARD.decode(&part.data).unwrap(), *expected);
    }
    for (name, _) in extras.iter().skip(4) {
        assert!(captured.entries.iter().any(|entry| entry == name));
        assert!(!captured.parts.iter().any(|part| &part.name == name));
    }
    let base_size = b"<Types/><Relationships/><presentation/>".len();
    assert_eq!(
        captured.inflated_bytes,
        (base_size + extras.iter().map(|(_, bytes)| bytes.len()).sum::<usize>()) as u64
    );
    let json = serde_json::to_value(&captured).unwrap();
    let mut keys: Vec<_> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["entries", "file", "inflatedBytes", "parts"]);
    assert_eq!(json["file"], serde_json::to_value(&captured.file).unwrap());
    assert!(json["parts"].as_array().unwrap().iter().all(|part| {
        part.as_object().unwrap().len() == 2 && part["name"].is_string() && part["data"].is_string()
    }));
}

#[test]
fn pptx_authored_slide_layout_theme_and_png_bytes_reach_the_capture_contract() {
    let bytes =
        include_bytes!("../../../src/runtime/fixtures/pptx/author-two-slide-layout-theme.pptx");
    let captured = capture(bytes).unwrap();
    for name in [
        "ppt/presentation.xml",
        "ppt/slides/slide1.xml",
        "ppt/slides/slide2.xml",
    ] {
        assert!(
            captured.parts.iter().any(|part| part.name == name),
            "{name}"
        );
    }
    assert!(captured.parts.iter().any(|part| {
        STANDARD
            .decode(&part.data)
            .unwrap()
            .starts_with(b"\x89PNG\r\n\x1a\n")
    }));
    assert_eq!(captured.file.sha256, super::super::content_hash(bytes));
}

#[test]
fn pptx_capture_requires_all_seven_selected_source_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("selected.unrelated-extension");
    let bytes = package(&[], CompressionMethod::Stored);
    std::fs::write(&path, &bytes).unwrap();
    let file = super::super::inspect(dir.path(), &path).unwrap();
    assert_eq!(read_pptx(&file).unwrap().file, file);
    for field in [
        "root",
        "path",
        "resolvedPath",
        "name",
        "size",
        "sha256",
        "version",
    ] {
        let mut json = serde_json::to_value(&file).unwrap();
        json[field] = if field == "size" {
            serde_json::json!(file.size + 1)
        } else {
            serde_json::json!(format!("{}-forged", json[field].as_str().unwrap()))
        };
        let forged = serde_json::from_value(json).unwrap();
        assert!(read_pptx(&forged).is_err(), "accepted changed {field}");
    }
    std::fs::write(
        &path,
        package(&[("new.xml", b"changed")], CompressionMethod::Stored),
    )
    .unwrap();
    assert_eq!(
        PptxReadFailure::from(read_pptx(&file).unwrap_err()).code,
        "changed"
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn pptx_capture_enforces_image_bytes_even_with_an_xml_name() {
    let mut image = vec![0; MAX_IMAGE];
    image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    let bytes = package(
        &[("ppt/media/renamed.xml", &image)],
        CompressionMethod::Deflated,
    );
    let captured = capture(&bytes).unwrap();
    assert_eq!(
        STANDARD
            .decode(&captured.parts.last().unwrap().data)
            .unwrap(),
        image
    );
    image.push(0);
    assert_eq!(
        code(&package(
            &[("ppt/media/renamed.xml", &image)],
            CompressionMethod::Deflated
        )),
        "limit"
    );
}

#[test]
fn pptx_capture_enforces_candidate_count_without_extension_authority() {
    let names: Vec<_> = (0..=MAX_IMAGES)
        .map(|n| format!("ppt/media/{n}.xml"))
        .collect();
    let entries: Vec<_> = names.iter().map(|name| (name.as_str(), JPEG)).collect();
    assert_eq!(
        capture(&package(
            &entries[..MAX_IMAGES],
            CompressionMethod::Deflated
        ))
        .unwrap()
        .parts
        .len(),
        MAX_IMAGES + 3
    );
    assert_eq!(
        code(&package(&entries, CompressionMethod::Deflated)),
        "limit"
    );
}

#[test]
fn pptx_capture_checks_crc_for_images_and_discarded_binaries() {
    for payload in [PNG, b"IGNORED_BINARY".as_slice()] {
        let mut bytes = package(&[("ppt/media/data", payload)], CompressionMethod::Stored);
        let offset = bytes
            .windows(payload.len())
            .position(|window| window == payload)
            .unwrap();
        bytes[offset + payload.len() - 1] ^= 1;
        assert_eq!(code(&bytes), "invalid");
    }
}

#[test]
fn pptx_capture_rejects_unsafe_paths_and_duplicate_names() {
    for name in [
        "../escape.xml",
        "/absolute.xml",
        "a/./b.xml",
        "a\\b.xml",
        "a/%2e%2e/b.xml",
    ] {
        assert_eq!(
            code(&package(&[(name, b"x")], CompressionMethod::Stored)),
            "invalid",
            "{name}"
        );
    }
    let mut bytes = package(
        &[("a.xml", b"a"), ("b.xml", b"b")],
        CompressionMethod::Stored,
    );
    let aliases: Vec<_> = bytes
        .windows(5)
        .enumerate()
        .filter_map(|(at, window)| (window == b"b.xml").then_some(at))
        .collect();
    assert_eq!(aliases.len(), 2);
    for at in aliases {
        bytes[at] = b'a';
    }
    assert_eq!(code(&bytes), "invalid");
}

#[test]
fn pptx_capture_returns_encrypted_unsupported_and_invalid_container_codes() {
    let original = package(&[], CompressionMethod::Stored);
    let central = signature(&original, b"PK\x01\x02");
    let local = signature(&original, b"PK\x03\x04");
    let mut encrypted = original.clone();
    put16(&mut encrypted, central + 8, 1);
    put16(&mut encrypted, local + 6, 1);
    assert_eq!(code(&encrypted), "encrypted");
    let mut unsupported = original.clone();
    put16(&mut unsupported, central + 10, 99);
    assert_eq!(code(&unsupported), "unsupported");
    let mut symlink = original.clone();
    put32(&mut symlink, central + 38, 0o120777 << 16);
    assert_eq!(code(&symlink), "unsupported");
    let mut mismatch = original;
    put32(&mut mismatch, local + 22, 999);
    assert_eq!(code(&mismatch), "invalid");
    assert_eq!(code(b"not a ZIP"), "unsupported");
}

#[test]
fn pptx_capture_reuses_archive_entry_part_and_inflation_limits() {
    let names: Vec<_> = (0..2046).map(|n| format!("ppt/ignored/{n}")).collect();
    let entries: Vec<_> = names
        .iter()
        .map(|name| (name.as_str(), b"x".as_slice()))
        .collect();
    assert_eq!(
        capture(&package(&entries[..2045], CompressionMethod::Stored))
            .unwrap()
            .entries
            .len(),
        2048
    );
    assert_eq!(code(&package(&entries, CompressionMethod::Stored)), "limit");
    let mut part = package(&[], CompressionMethod::Stored);
    let central = signature(&part, b"PK\x01\x02");
    put32(&mut part, central + 24, 16 * 1024 * 1024 + 1);
    assert_eq!(code(&part), "limit");
    // Five individually legal declared parts exceed the shared 64 MiB total.
    // Adjust corresponding local headers too, so the total is the first failure.
    let mut total = package(
        &[("a.xml", b"a"), ("b.xml", b"b")],
        CompressionMethod::Stored,
    );
    let headers: Vec<_> = total
        .windows(4)
        .enumerate()
        .filter_map(|(at, window)| (window == b"PK\x01\x02").then_some(at))
        .collect();
    assert_eq!(headers.len(), 5);
    for central in headers {
        let local =
            u32::from_le_bytes(total[central + 42..central + 46].try_into().unwrap()) as usize;
        put32(&mut total, central + 24, 16 * 1024 * 1024);
        put32(&mut total, local + 22, 16 * 1024 * 1024);
    }
    assert_eq!(code(&total), "limit");
}

#[test]
fn pptx_capture_does_not_widen_the_archive_source_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("too-large.pptx");
    let handle = std::fs::File::create(&path).unwrap();
    handle.set_len(ooxml_archive::MAX_ARCHIVE + 1).unwrap();
    drop(handle);
    let file = super::super::inspect(dir.path(), &path).unwrap();
    assert_eq!(
        PptxReadFailure::from(read_pptx(&file).unwrap_err()).code,
        "limit"
    );
}

#[test]
fn pptx_capture_does_not_claim_semantic_acceptance_or_decode_candidates() {
    let xml =
        b"<!DOCTYPE external [<!ENTITY x SYSTEM 'https://invalid.example/no-fetch'>]><slide/>";
    let captured = capture(&package(
        &[
            ("ppt/slides/slide1.xml", xml),
            ("ppt/media/invalid.png", PNG),
        ],
        CompressionMethod::Stored,
    ))
    .unwrap();
    let part = captured
        .parts
        .iter()
        .find(|part| part.name == "ppt/slides/slide1.xml")
        .unwrap();
    assert_eq!(STANDARD.decode(&part.data).unwrap(), xml);
    // The XML and PNG signature are deliberately not parsed or decoded here.
    assert!(
        captured
            .parts
            .iter()
            .any(|part| part.name == "ppt/media/invalid.png")
    );
}

#[test]
fn pptx_failures_expose_only_fixed_codes() {
    use super::super::DeliveryError;
    for (error, expected) in [
        (PresentationError::Invalid, "invalid"),
        (PresentationError::Limit, "limit"),
        (PresentationError::Encrypted, "encrypted"),
        (PresentationError::Unsupported, "unsupported"),
        (PresentationError::File(DeliveryError::Changed), "changed"),
        (PresentationError::File(DeliveryError::TooLarge), "limit"),
        (
            PresentationError::File(DeliveryError::Unreadable),
            "unreadable",
        ),
    ] {
        assert_eq!(
            serde_json::to_value(PptxReadFailure::from(error)).unwrap(),
            serde_json::json!({"code": expected})
        );
    }
    assert_eq!(
        serde_json::to_value(PptxReadFailure::check("private OS error details")).unwrap(),
        serde_json::json!({"code": "unreadable"})
    );
}
