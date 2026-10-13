use super::*;
use std::{fs, io::Write, path::Path};

fn selected(dir: &Path, name: &str, bytes: &[u8]) -> VerifiedFile {
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    super::super::inspect(dir, &path).unwrap()
}

fn failure(file: &VerifiedFile) -> &'static str {
    PdfInputReadFailure::from(read_pdf_input(file).unwrap_err()).code
}

#[test]
fn pdf_input_capture_returns_complete_selected_bytes_without_parsing_or_extracting() {
    let dir = tempfile::tempdir().unwrap();
    let source = b"%PDF-1.7\nnot parsed here\n\0binary tail\xff";
    let file = selected(dir.path(), "chosen.arbitrary", source);
    let capture = read_pdf_input(&file).unwrap();
    assert_eq!(capture.file, file);
    assert_eq!(STANDARD.decode(capture.data).unwrap(), source);
    assert_eq!(fs::read(&file.path).unwrap(), source);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn pdf_input_capture_never_guesses_format_from_extension_or_a_late_header() {
    let dir = tempfile::tempdir().unwrap();
    for bytes in [
        b"".as_slice(),
        b"%PDF".as_slice(),
        b" %PDF-1.7".as_slice(),
        b"<html>%PDF-1.7".as_slice(),
        b"PK\x03\x04not PDF".as_slice(),
    ] {
        let file = selected(dir.path(), "sample.pdf", bytes);
        assert_eq!(failure(&file), "invalid");
        assert_eq!(fs::read(&file.path).unwrap(), bytes);
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn pdf_input_capture_rejects_every_forged_selection_field() {
    let dir = tempfile::tempdir().unwrap();
    let file = selected(dir.path(), "one.pdf", b"%PDF-1.7\nwhole original");
    fs::write(dir.path().join("two.pdf"), b"%PDF-1.7\nwhole original").unwrap();
    let mut cases = Vec::new();
    for field in 0..7 {
        let mut changed = file.clone();
        match field {
            0 => changed.root = dir.path().join("absent").to_str().unwrap().to_owned(),
            1 => changed.path = dir.path().join("two.pdf").to_str().unwrap().to_owned(),
            2 => changed.resolved_path.push('x'),
            3 => changed.name.push('x'),
            4 => changed.size += 1,
            5 => changed.sha256 = "0".repeat(64),
            6 => changed.version = "0".repeat(64),
            _ => unreachable!(),
        }
        cases.push(changed);
    }
    for changed in cases {
        assert!(read_pdf_input(&changed).is_err());
    }
    assert_eq!(read_pdf_input(&file).unwrap().file, file);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn pdf_input_capture_checks_tail_bytes_and_current_version() {
    let dir = tempfile::tempdir().unwrap();
    let original = b"%PDF-1.7\nsame prefix\nfirst tail";
    let changed = b"%PDF-1.7\nsame prefix\nother tail";
    assert_eq!(original.len(), changed.len());
    let file = selected(dir.path(), "tail.pdf", original);
    fs::write(&file.path, changed).unwrap();
    assert_eq!(failure(&file), "changed");
    let current = super::super::inspect(dir.path(), Path::new(&file.path)).unwrap();
    assert_eq!(
        STANDARD
            .decode(read_pdf_input(&current).unwrap().data)
            .unwrap(),
        changed
    );
    fs::remove_file(&file.path).unwrap();
    assert_eq!(failure(&current), "unreadable");
}

#[test]
fn pdf_input_capture_has_its_own_exact_32_mib_cap() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.pdf");
    let mut source = fs::File::create(&path).unwrap();
    source.write_all(b"%PDF-1.7\n").unwrap();
    source.set_len(MAX_FILE_BYTES).unwrap();
    drop(source);
    let file = super::super::inspect(dir.path(), &path).unwrap();
    let capture = read_pdf_input(&file).unwrap();
    let whole = STANDARD.decode(capture.data).unwrap();
    assert_eq!(whole.len() as u64, MAX_FILE_BYTES);
    assert!(whole.starts_with(b"%PDF-1.7\n"));
    assert_eq!(whole.last(), Some(&0));
    drop(whole);
    // The distinct OOXML limit is retained even for exactly the same file.
    assert_eq!(
        super::super::DocxReadFailure::from(super::super::read_docx(&file).unwrap_err()).code,
        "limit"
    );
    assert_eq!(
        super::super::WorkbookReadFailure::from(super::super::read_workbook(&file).unwrap_err())
            .code,
        "limit"
    );
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAX_FILE_BYTES + 1)
        .unwrap();
    let too_large = super::super::inspect(dir.path(), &path).unwrap();
    assert_eq!(failure(&too_large), "limit");
    assert_eq!(fs::metadata(&path).unwrap().len(), MAX_FILE_BYTES + 1);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn pdf_input_capture_keeps_authored_encrypted_and_late_error_files_for_parser_rejection() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../docs/evidence/2026-10-09-capability-hardening/pdf-input/fixtures");
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "01-pages-hidden-crop-ocr.pdf",
        "02-encoding-ligature-unmapped.pdf",
        "03-image-only.pdf",
        "04-encrypted.pdf",
        "05-late-page-damaged.pdf",
        "06-whole-utf8-over-limit.pdf",
    ] {
        let bytes = fs::read(root.join(name)).unwrap();
        let file = selected(dir.path(), "one.pdf", &bytes);
        let capture = read_pdf_input(&file).unwrap();
        assert_eq!(STANDARD.decode(capture.data).unwrap(), bytes);
        assert_eq!(capture.file, file);
        assert_eq!(fs::read(root.join(name)).unwrap(), bytes);
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}
