use super::{
    input,
    tests::{id, resign, sample},
    types::*,
};
use crate::file_delivery::{self, ArchiveOutcome};
use std::{
    fs,
    io::Read,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
fn local(p: &mut Prepare, root: &Path, path: &Path) {
    let f = file_delivery::inspect(root, path).unwrap();
    p.candidates[0].representation = Representation::LocalCurrentFile;
    p.selected[0].source = Source::Local {
        file: LocalFile {
            root: f.root,
            path: f.path,
            resolved_path: f.resolved_path,
            name: f.name,
            size: f.size,
            sha256: f.sha256,
            version: f.version,
        },
        selected_by: SelectedBy::DeclaredSource,
    };
    resign(p);
}
fn run(p: &Prepare) -> ArchiveOutcome {
    input::validate(p).unwrap();
    file_delivery::stream_archive(p, || false, || true, |_, _| {})
}
#[test]
fn real_zip_reopens_with_exact_members_bytes_hashes_and_portable_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let dst = dir.path().join("portable.zip");
    let source = dir.path().join("private-source.bin");
    fs::write(&source, [0, 255, 1, 2]).unwrap();
    let mut p = sample(dst.to_str().unwrap().into());
    // A malicious display label is only metadata, never a member path.
    p.candidates[0].display_name = "../../outside.png".into();
    let mut second = p.candidates[0].clone();
    second.candidate_id = id(8);
    second.display_name = "unknown.exe".into();
    second.representation = Representation::ReceivedBytes;
    p.candidates.push(second);
    p.selected.push(Selected {
        candidate_id: id(8),
        source: Source::InlineBinary {
            base64: "AAECAw==".into(),
            decoded_bytes: 4,
        },
    });
    local(&mut p, dir.path(), &source);
    let expected = source.canonicalize().unwrap().to_str().unwrap().to_owned();
    let ArchiveOutcome::Completed(receipt) = run(&p) else {
        panic!("real archive failed")
    };
    let bytes = fs::read(&dst).unwrap();
    assert_eq!(receipt.zip_sha256, input::hash(&bytes));
    assert_eq!(receipt.zip_size, bytes.len() as u64);
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    assert_eq!(
        zip.file_names().collect::<Vec<_>>(),
        [
            "conversation.md",
            "attachments/0001.png",
            "attachments/0002.bin",
            "manifest.json"
        ]
    );
    for (name, bytes) in [
        ("conversation.md", p.markdown.as_bytes()),
        ("attachments/0001.png", &[0, 255, 1, 2]),
        ("attachments/0002.bin", &[0, 1, 2, 3]),
    ] {
        let mut actual = Vec::new();
        zip.by_name(name).unwrap().read_to_end(&mut actual).unwrap();
        assert_eq!(actual, bytes);
    }
    let mut manifest = String::new();
    zip.by_name("manifest.json")
        .unwrap()
        .read_to_string(&mut manifest)
        .unwrap();
    assert_eq!(receipt.manifest_sha256, input::hash(manifest.as_bytes()));
    assert!(!manifest.contains(&expected));
    assert!(!manifest.contains(&p.input_sha256));
    assert!(!manifest.contains("resolvedPath"));
    if let Source::Local { file, .. } = &p.selected[0].source {
        assert!(!manifest.contains(&file.version));
    }
    let m: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(
        m["items"][0]["included"]["sha256"],
        input::hash(&[0, 255, 1, 2])
    );
    assert_eq!(fs::read(source).unwrap(), [0, 255, 1, 2]);
}
#[test]
fn selected_change_aborts_whole_zip_and_preserves_existing_target() {
    let dir = tempfile::tempdir().unwrap();
    let dst = dir.path().join("out.zip");
    let src = dir.path().join("source");
    fs::write(&src, b"old bytes").unwrap();
    let mut p = sample(dst.to_str().unwrap().into());
    local(&mut p, dir.path(), &src);
    fs::write(&src, b"NEW bytes").unwrap();
    assert!(matches!(
        run(&p),
        ArchiveOutcome::Failed("changed", Some(_))
    ));
    assert!(!dst.exists());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    local(&mut p, dir.path(), &src);
    fs::write(&dst, b"existing user data").unwrap();
    assert!(matches!(
        run(&p),
        ArchiveOutcome::Failed("alreadyExists", None)
    ));
    assert_eq!(fs::read(&dst).unwrap(), b"existing user data");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}
#[test]
fn cancellation_mid_chunk_and_panic_clean_only_the_owned_temporary() {
    for panic in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let dst = dir.path().join("out.zip");
        let mut p = sample(dst.to_str().unwrap().into());
        let text = "x".repeat(200_000);
        p.selected[0].source = Source::InlineText {
            utf8_bytes: text.len() as u64,
            text,
        };
        resign(&mut p);
        let cancelled = AtomicBool::new(false);
        let result = file_delivery::stream_archive(
            &p,
            || cancelled.load(Ordering::SeqCst),
            || true,
            |bytes, _| {
                if bytes > 0 {
                    if panic {
                        panic!("controlled progress panic");
                    }
                    cancelled.store(true, Ordering::SeqCst);
                }
            },
        );
        if panic {
            assert!(matches!(
                result,
                ArchiveOutcome::Failed("unavailable", None)
            ));
        } else {
            assert!(matches!(result, ArchiveOutcome::Cancelled));
        }
        assert!(!dst.exists());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
#[test]
fn zero_selected_is_a_real_transcript_and_omission_zip_not_automatic_completion() {
    let dir = tempfile::tempdir().unwrap();
    let mut p = sample(dir.path().join("zero.zip").to_str().unwrap().into());
    p.selected.clear();
    p.omitted = vec![Omitted {
        candidate_id: id(4),
        reason: Omission::NotSelected,
    }];
    resign(&mut p);
    assert_eq!(Status::ready(&p).state, State::Ready);
    let ArchiveOutcome::Completed(r) = run(&p) else {
        panic!("zero archive")
    };
    assert_eq!(r.included_count, 0);
    assert_eq!(r.omitted_count, 1);
    let zip = zip::ZipArchive::new(fs::File::open(&p.destination).unwrap()).unwrap();
    assert_eq!(zip.len(), 2);
}
#[cfg(unix)]
#[test]
fn stable_parent_swap_before_publication_is_rejected_and_new_directory_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("parent");
    fs::create_dir(&parent).unwrap();
    let moved = dir.path().join("old-parent");
    let p = sample(parent.join("out.zip").to_str().unwrap().into());
    let swapped = AtomicBool::new(false);
    let result = file_delivery::stream_archive(
        &p,
        || false,
        || true,
        |_, _| {
            if !swapped.swap(true, Ordering::SeqCst) {
                fs::rename(&parent, &moved).unwrap();
                fs::create_dir(&parent).unwrap();
            }
        },
    );
    assert!(matches!(result, ArchiveOutcome::Failed("changed", None)));
    assert_eq!(fs::read_dir(parent).unwrap().count(), 0);
    assert_eq!(fs::read_dir(moved).unwrap().count(), 0);
}
#[cfg(unix)]
#[test]
fn local_replace_symlink_missing_and_growth_never_silently_omit_selected_item() {
    for mode in ["replace", "symlink", "missing", "growth"] {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source");
        let dst = dir.path().join("result.zip");
        fs::write(&src, b"verified bytes").unwrap();
        let mut p = sample(dst.to_str().unwrap().into());
        local(&mut p, dir.path(), &src);
        match mode {
            "replace" => {
                fs::rename(&src, dir.path().join("retained-original")).unwrap();
                fs::write(&src, b"verified bytes").unwrap();
            }
            "symlink" => {
                fs::rename(&src, dir.path().join("retained-original")).unwrap();
                std::os::unix::fs::symlink(dir.path().join("retained-original"), &src).unwrap();
            }
            "missing" => fs::remove_file(&src).unwrap(),
            "growth" => fs::write(&src, b"verified bytes plus new content").unwrap(),
            _ => unreachable!(),
        }
        let before: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert!(
            matches!(run(&p), ArchiveOutcome::Failed(_, Some(_))),
            "{mode}"
        );
        assert!(!dst.exists());
        let after: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(before, after);
    }
}
#[test]
fn exact_temporary_replaced_before_cleanup_is_unknown_and_preserves_both_objects() {
    let dir = tempfile::tempdir().unwrap();
    let p = sample(dir.path().join("result.zip").to_str().unwrap().into());
    let cancel = AtomicBool::new(false);
    let once = AtomicBool::new(false);
    let result = file_delivery::stream_archive(
        &p,
        || cancel.load(Ordering::SeqCst),
        || false,
        |_, _| {
            if !once.swap(true, Ordering::SeqCst) {
                let temp = fs::read_dir(dir.path())
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap()
                    .path();
                fs::rename(&temp, dir.path().join("retained-owned-material")).unwrap();
                fs::write(temp, b"replacement must survive").unwrap();
                cancel.store(true, Ordering::SeqCst);
            }
        },
    );
    let (outcome, code) = match &result {
        ArchiveOutcome::Completed(_) => ("completed", None),
        ArchiveOutcome::Cancelled => ("cancelled", None),
        ArchiveOutcome::Failed(code, _) => ("failed", Some(*code)),
        ArchiveOutcome::Unknown(code, _) => ("unknown", Some(*code)),
    };
    eprintln!("FARFOLD_ARCHIVE_REPLACED_TEMP outcome={outcome} code={code:?}");
    assert!(matches!(
        result,
        ArchiveOutcome::Unknown("cleanupUnknown", None)
            | ArchiveOutcome::Unknown("cleanupUnknown", Some(_))
    ));
    assert!(!Path::new(&p.destination).exists());
    let files: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 2);
    assert!(
        files
            .iter()
            .any(|p| fs::read(p).unwrap() == b"replacement must survive")
    );
}
