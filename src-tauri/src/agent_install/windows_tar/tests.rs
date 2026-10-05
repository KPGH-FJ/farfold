use super::*;
use std::cell::Cell;

fn archive(entries: &[(tar::EntryType, &str, &[u8])]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (kind, name, content) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_entry_type(*kind);
        // Set literal malicious names too; append_data intentionally rejects
        // those before an extractor could exercise its input checks.
        let raw = header.as_mut_bytes();
        raw[..100].fill(0);
        raw[..name.len()].copy_from_slice(name.as_bytes());
        header.set_cksum();
        builder.append(&header, *content).unwrap();
    }
    builder.into_inner().unwrap()
}

#[test]
fn windows_tar_extracts_only_ordinary_files_and_directories() {
    let root = tempfile::tempdir().unwrap();
    let bytes = archive(&[
        (tar::EntryType::Directory, "./", b""),
        (tar::EntryType::Directory, "bin/", b""),
        (
            tar::EntryType::Regular,
            "bin/program.exe",
            b"synthetic bytes",
        ),
    ]);
    unpack(&bytes[..], root.path(), || Ok(())).unwrap();
    assert_eq!(
        std::fs::read(root.path().join("bin/program.exe")).unwrap(),
        b"synthetic bytes"
    );
}

#[test]
fn windows_tar_rejects_escaping_device_and_stream_names_before_writing() {
    for name in [
        "/outside.exe",
        "../outside.exe",
        "bin/../outside.exe",
        "C:/outside.exe",
        "bin\\outside.exe",
        "program.exe:stream",
        "CON.exe",
        "bin/CONIN$",
        "bin/LPT¹.exe",
        "bin/name.",
        "bin/name ",
    ] {
        let root = tempfile::tempdir().unwrap();
        let bytes = archive(&[(tar::EntryType::Regular, name, b"no")]);
        assert!(
            unpack(&bytes[..], root.path(), || Ok(())).is_err(),
            "{name:?}"
        );
        assert_eq!(
            std::fs::read_dir(root.path()).unwrap().count(),
            0,
            "{name:?}"
        );
    }
}

#[test]
fn windows_tar_rejects_links_and_special_files() {
    for kind in [
        tar::EntryType::Symlink,
        tar::EntryType::Link,
        tar::EntryType::Fifo,
        tar::EntryType::Char,
    ] {
        let root = tempfile::tempdir().unwrap();
        let bytes = archive(&[(kind, "program.exe", b"")]);
        assert!(unpack(&bytes[..], root.path(), || Ok(())).is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}

#[test]
fn windows_tar_bounds_declared_expansion_and_entry_count() {
    let root = tempfile::tempdir().unwrap();
    let bytes = archive(&[(tar::EntryType::Regular, "large.exe", &[7; 4096])]);
    assert!(unpack_bounded(&bytes[..], root.path(), || Ok(()), 2048, 10).is_err());
    assert!(!root.path().join("large.exe").exists());
    let bytes = archive(&[
        (tar::EntryType::Regular, "first.exe", b""),
        (tar::EntryType::Regular, "second.exe", b""),
    ]);
    assert!(unpack_bounded(&bytes[..], root.path(), || Ok(()), 10_000, 1).is_err());
    assert!(root.path().join("first.exe").exists());
    assert!(!root.path().join("second.exe").exists());
}

#[test]
fn windows_tar_cancellation_is_checked_again_during_file_reads() {
    let root = tempfile::tempdir().unwrap();
    let bytes = archive(&[(tar::EntryType::Regular, "program.exe", &[7; 4096])]);
    let cancelled = Cell::new(false);
    let result = unpack(&bytes[..], root.path(), || {
        if root.path().join("program.exe").exists() {
            cancelled.set(true);
            Err("cancelled".into())
        } else {
            Ok(())
        }
    });
    assert!(result.is_err());
    assert!(
        cancelled.get(),
        "cancellation must be observed after opening the file, before reading its contents"
    );
    assert_eq!(
        std::fs::metadata(root.path().join("program.exe"))
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn windows_tar_cancellation_before_unpack_preserves_candidate() {
    let root = tempfile::tempdir().unwrap();
    let bytes = archive(&[(tar::EntryType::Regular, "program.exe", b"no")]);
    assert!(unpack(&bytes[..], root.path(), || Err("cancelled".into())).is_err());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn windows_tar_does_not_replace_an_existing_candidate_file() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("program.exe"), b"keep").unwrap();
    let bytes = archive(&[(tar::EntryType::Regular, "program.exe", b"replacement")]);
    assert!(unpack(&bytes[..], root.path(), || Ok(())).is_err());
    assert_eq!(
        std::fs::read(root.path().join("program.exe")).unwrap(),
        b"keep"
    );
}
