use super::super::{MAX_TEXT_BYTES, search_source};
use super::*;
use std::{fs, path::Path};

fn fixture(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf, VerifiedFile) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("selected.pdf");
    fs::write(&path, bytes).unwrap();
    let file = super::super::inspect(dir.path(), &path).unwrap();
    (dir, path, file)
}

fn sized_pdf(size: usize) -> Vec<u8> {
    let mut bytes = b"%PDF-1.7\nwhole selected bytes\0".to_vec();
    bytes.resize(size, 0xff);
    bytes
}

fn failure(file: &VerifiedFile) -> &'static str {
    match read_pdf_search(file) {
        Err(error) => PdfInputReadFailure::from(error).code,
        Ok(_) => panic!("expected PDF search rejection; capture content omitted"),
    }
}

#[test]
fn search_rejects_one_mib_plus_one_while_original_pdf_input_stays_usable() {
    let bytes = sized_pdf(MAX_TEXT_BYTES as usize + 1);
    let (_dir, path, file) = fixture(&bytes);
    assert_eq!(
        STANDARD
            .decode(read_pdf_input(&file).unwrap().data)
            .unwrap(),
        bytes
    );
    assert_eq!(failure(&file), "limit");
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn search_exact_one_mib_preserves_complete_bytes_and_receipt_without_parsing() {
    let bytes = sized_pdf(MAX_TEXT_BYTES as usize);
    let (dir, path, file) = fixture(&bytes);
    let capture = read_pdf_search(&file).unwrap();
    assert_eq!(capture.file, file);
    assert_eq!(capture.file.sha256, super::super::content_hash(&bytes));
    assert_eq!(STANDARD.decode(capture.data).unwrap(), bytes);
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn search_oversize_open_and_post_open_growth_stop_before_complete_hashing() {
    let (_dir, path, file) = fixture(b"%PDF-1.7\nsmall");
    let opened = search_source::open(&file).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAX_TEXT_BYTES + 1)
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
    assert_eq!(failure(&file), "limit");
}

#[test]
fn search_rejects_all_seven_stale_fields_same_bytes_replacement_and_tail_drift() {
    let bytes = b"%PDF-1.7\nwhole source\noriginal tail";
    let (dir, path, file) = fixture(bytes);
    let other = dir.path().join("other.pdf");
    fs::write(&other, bytes).unwrap();
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
        assert_eq!(failure(&changed), "changed", "field {field}");
    }
    let opened = search_source::open(&file).unwrap();
    fs::rename(&other, &path).unwrap();
    assert!(matches!(
        search_source::capture(&file, opened),
        Err(DeliveryError::Changed)
    ));
    assert_eq!(failure(&file), "changed");
    let current = super::super::inspect_text(&path).unwrap();
    assert_eq!(
        STANDARD
            .decode(read_pdf_search(&current).unwrap().data)
            .unwrap(),
        bytes
    );
    let mut changed = bytes.to_vec();
    *changed.last_mut().unwrap() ^= 1;
    fs::write(&path, &changed).unwrap();
    assert_eq!(failure(&current), "changed");
    assert_eq!(fs::read(path).unwrap(), changed);
}

#[cfg(unix)]
#[test]
fn search_redirected_selected_path_is_changed_before_body_reading() {
    let bytes = b"%PDF-1.7\nsame bytes";
    let (dir, path, _) = fixture(bytes);
    let alias = dir.path().join("alias.pdf");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    let file = super::super::inspect_text(&alias).unwrap();
    assert_eq!(read_pdf_search(&file).unwrap().file, file);
    let opened = search_source::open(&file).unwrap();
    let other = dir.path().join("other.pdf");
    fs::write(&other, bytes).unwrap();
    fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&other, &alias).unwrap();
    assert!(matches!(
        search_source::capture(&file, opened),
        Err(DeliveryError::Changed)
    ));
    assert!(matches!(
        search_source::open(&file),
        Err(DeliveryError::Changed)
    ));
    assert_eq!(failure(&file), "changed");
}

#[test]
fn search_passes_complete_authored_samples_to_parser_without_extension_authority() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../docs/evidence/2026-10-09-capability-hardening/pdf-input/fixtures");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("selected.bin");
    for name in [
        "01-pages-hidden-crop-ocr.pdf",
        "02-encoding-ligature-unmapped.pdf",
        "03-image-only.pdf",
        "04-encrypted.pdf",
        "05-late-page-damaged.pdf",
        "06-whole-utf8-over-limit.pdf",
    ] {
        let bytes = fs::read(root.join(name)).unwrap();
        fs::write(&path, &bytes).unwrap();
        let file = super::super::inspect_text(&path).unwrap();
        let capture = read_pdf_search(&file).unwrap();
        assert_eq!(capture.file, file);
        assert_eq!(STANDARD.decode(&capture.data).unwrap(), bytes);
        assert_eq!(
            serde_json::to_value(&capture).unwrap(),
            serde_json::to_value(read_pdf_input(&file).unwrap()).unwrap()
        );
        assert_eq!(fs::read(root.join(name)).unwrap(), bytes);
    }
    // The capture makes no encryption, decoded-text or page-success claim.
    for bytes in [b"".as_slice(), b"%PDF", b" %PDF-1.7", b"PK\x03\x04"] {
        let (_dir, _, file) = fixture(bytes);
        assert_eq!(failure(&file), "invalid");
    }
    let current = super::super::inspect_text(&path).unwrap();
    fs::remove_file(path).unwrap();
    assert_eq!(failure(&current), "unreadable");
}
