//! Real owned files at the final production receipt boundary. No user files.
use super::*;
use std::fs;

fn fixture() -> (tempfile::TempDir, TemporaryExport, PathBuf, DeliveryReceipt) {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("output.bin");
    let mut temporary =
        TemporaryExport::create(open_directory(&directory.path().canonicalize().unwrap()).unwrap())
            .unwrap();
    temporary.file.write_all(b"original\0bytes\n").unwrap();
    temporary.file.sync_all().unwrap();
    temporary.publish(destination.file_name().unwrap()).unwrap();
    let receipt = DeliveryReceipt {
        kind: DeliveryKind::FileCopy,
        destination: path_text(&destination).unwrap(),
        size: 15,
        sha256: content_hash(b"original\0bytes\n"),
        source_version: Some("owned-verified-source".into()),
        destination_file: None,
    };
    (directory, temporary, destination, receipt)
}

fn rewritten_before_final_observation(bytes: &[u8]) {
    let (directory, temporary, destination, receipt) = fixture();
    let before = file_access::stamp(&temporary.file).unwrap();
    fs::write(&destination, bytes).unwrap();
    let current = File::open(&destination).unwrap();
    assert!(file_access::same_object(&temporary.file, &current).unwrap());
    assert_eq!(
        file_access::stamp(&current).unwrap().identity,
        before.identity
    );
    let result = published_receipt(
        &temporary,
        &destination,
        &directory.path().canonicalize().unwrap(),
        receipt,
    );
    println!(
        "published_receipt_observation={}",
        serde_json::json!({
            "sameObject": true,
            "actualSize": bytes.len(),
            "actualSha256": content_hash(bytes),
            "outcome": match &result {
                Ok(receipt) => serde_json::json!({"kind":"completed", "claimedSize":receipt.size, "claimedSha256":receipt.sha256}),
                Err(error) => serde_json::json!({"kind":"error", "code":format!("{error:?}")}),
            },
        })
    );
    assert!(matches!(result, Err(DeliveryError::DestinationChanged)));
    drop(temporary);
    assert_eq!(fs::read(&destination).unwrap(), bytes);
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn unchanged_published_bytes_accept_the_original_receipt() {
    let (directory, temporary, destination, expected) = fixture();
    let receipt = published_receipt(
        &temporary,
        &destination,
        &directory.path().canonicalize().unwrap(),
        expected.clone(),
    )
    .unwrap();
    assert_eq!(receipt.destination, expected.destination);
    assert_eq!(receipt.sha256, expected.sha256);
    assert_eq!(receipt.size, expected.size);
    assert_eq!(receipt.source_version, expected.source_version);
    assert_eq!(
        receipt.destination_file,
        Some(inspect(directory.path(), &destination).unwrap())
    );
    assert_eq!(
        content_hash(&fs::read(destination).unwrap()),
        receipt.sha256
    );
}

#[test]
fn completed_copy_keeps_its_own_identity_after_later_same_byte_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.txt");
    let destination = directory.path().join("copy.txt");
    fs::write(&source, b"owned content").unwrap();
    let file = inspect(directory.path(), &source).unwrap();
    let receipt = copy(&file, &destination).unwrap();
    let saved = receipt.destination_file.unwrap();
    assert_ne!(saved.version, file.version);
    assert_eq!(saved.sha256, file.sha256);
    assert_eq!(saved.path, receipt.destination);
    assert_eq!(revalidate_for_open(&saved).unwrap(), saved.resolved_path);
    let before = file_access::stamp(&File::open(&destination).unwrap()).unwrap();
    let modified = fs::metadata(&destination).unwrap().modified().unwrap();
    fs::rename(&destination, directory.path().join("retained-copy.txt")).unwrap();
    fs::write(&destination, b"owned content").unwrap();
    File::options()
        .write(true)
        .open(&destination)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let after = file_access::stamp(&File::open(&destination).unwrap()).unwrap();
    assert_eq!(before.modified, after.modified);
    assert_ne!(before.identity, after.identity);
    assert_eq!(
        inspect(directory.path(), &destination).unwrap().sha256,
        saved.sha256
    );
    assert_eq!(revalidate_for_open(&saved), Err(DeliveryError::Changed));
    assert_eq!(fs::read(&source).unwrap(), b"owned content");
}

#[test]
fn saved_copy_rejects_changed_bytes_and_missing_destination() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.txt");
    let destination = directory.path().join("copy.txt");
    fs::write(&source, b"owned content").unwrap();
    let file = inspect(directory.path(), &source).unwrap();
    let saved = copy(&file, &destination).unwrap().destination_file.unwrap();
    fs::write(&destination, b"other content").unwrap();
    assert_eq!(revalidate_for_open(&saved), Err(DeliveryError::Changed));
    fs::rename(&destination, directory.path().join("retained-copy.txt")).unwrap();
    assert!(revalidate_for_open(&saved).is_err());
    assert_eq!(fs::read(&source).unwrap(), b"owned content");
}

#[cfg(unix)]
#[test]
fn saved_copy_redirect_to_its_source_never_opens_source() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.txt");
    let destination = directory.path().join("copy.txt");
    fs::write(&source, b"owned content").unwrap();
    let file = inspect(directory.path(), &source).unwrap();
    let saved = copy(&file, &destination).unwrap().destination_file.unwrap();
    fs::rename(&destination, directory.path().join("retained-copy.txt")).unwrap();
    std::os::unix::fs::symlink(&source, &destination).unwrap();
    assert!(revalidate_for_open(&saved).is_err());
    assert_eq!(fs::read(&source).unwrap(), b"owned content");
}

#[test]
fn text_snapshot_does_not_claim_verified_disk_copy_actions() {
    let directory = tempfile::tempdir().unwrap();
    let receipt = export_text("draft", &directory.path().join("draft.txt")).unwrap();
    assert!(receipt.destination_file.is_none());
    assert!(
        serde_json::to_value(receipt)
            .unwrap()
            .get("destinationFile")
            .is_none()
    );
}

#[test]
fn same_size_rewrite_before_final_observation_is_rejected_and_retained() {
    rewritten_before_final_observation(b"modified\0bytes\n");
}

#[test]
fn shortened_file_before_final_observation_is_rejected_and_retained() {
    rewritten_before_final_observation(b"short");
}

#[test]
fn grown_file_before_final_observation_is_rejected_and_retained() {
    rewritten_before_final_observation(b"original\0bytes\nappended");
}

#[test]
fn replaced_object_with_original_bytes_is_rejected_and_retained() {
    let (directory, temporary, destination, expected) = fixture();
    let removed = directory.path().join("retained-original.bin");
    fs::rename(&destination, &removed).unwrap();
    fs::write(&destination, b"original\0bytes\n").unwrap();
    assert!(matches!(
        published_receipt(
            &temporary,
            &destination,
            &directory.path().canonicalize().unwrap(),
            expected,
        ),
        Err(DeliveryError::DestinationChanged)
    ));
    drop(temporary);
    assert_eq!(fs::read(&destination).unwrap(), b"original\0bytes\n");
    assert_eq!(fs::read(&removed).unwrap(), b"original\0bytes\n");
}

#[test]
fn real_copy_rejects_changed_owned_temporary_before_publication_and_retains_output() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.bin");
    fs::write(&source, b"original\0bytes\n").unwrap();
    let file = inspect(directory.path(), &source).unwrap();
    let output = tempfile::tempdir().unwrap();
    let destination = output.path().join("copy.bin");
    let result = stream_copy(
        &file,
        &destination,
        || false,
        || {
            let leaves = fs::read_dir(output.path())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            assert_eq!(leaves.len(), 1);
            let path = &leaves[0];
            assert!(
                path.file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with(".farfold-export-")
            );
            let original = File::open(path).unwrap();
            fs::write(path, b"modified\0bytes\n").unwrap();
            assert!(file_access::same_object(&original, &File::open(path).unwrap()).unwrap());
            true
        },
        |_| {},
    );
    println!(
        "real_copy_observation={}",
        serde_json::json!({
            "actualSha256": content_hash(&fs::read(&destination).unwrap()),
            "sourceSha256": file.sha256,
            "outcome": match &result {
                CopyOutcome::Completed(receipt) => serde_json::json!({"kind":"completed", "claimedSha256":receipt.sha256}),
                CopyOutcome::Unknown(error) => serde_json::json!({"kind":"unknown", "code":format!("{error:?}")}),
                CopyOutcome::Failed(error) => serde_json::json!({"kind":"failed", "code":format!("{error:?}")}),
                CopyOutcome::Cancelled => serde_json::json!({"kind":"cancelled"}),
                CopyOutcome::CleanupUnknown => serde_json::json!({"kind":"cleanupUnknown"}),
            },
        })
    );
    assert!(matches!(
        result,
        CopyOutcome::Unknown(DeliveryError::DestinationChanged)
    ));
    assert_eq!(fs::read(&destination).unwrap(), b"modified\0bytes\n");
    assert_eq!(fs::read(&source).unwrap(), b"original\0bytes\n");
    assert_eq!(fs::read_dir(output.path()).unwrap().count(), 1);
}

#[test]
fn large_binary_copy_final_receipt_matches_published_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.bin");
    let bytes = (0..2 * 1024 * 1024)
        .map(|i| (i % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(&source, &bytes).unwrap();
    let file = inspect(directory.path(), &source).unwrap();
    let destination = directory.path().join("copy.bin");
    let result = stream_copy(&file, &destination, || false, || true, |_| {});
    let CopyOutcome::Completed(receipt) = result else {
        panic!("unchanged real copy must complete");
    };
    assert!(receipt.size > MAX_TEXT_BYTES);
    assert_eq!(receipt.size, bytes.len() as u64);
    assert_eq!(
        receipt.sha256,
        content_hash(&fs::read(destination).unwrap())
    );
    assert_eq!(
        receipt.source_version.as_deref(),
        Some(file.version.as_str())
    );
    assert_eq!(fs::read(source).unwrap(), bytes);
}
