use super::*;

fn fixture(bytes: &[u8]) -> (tempfile::TempDir, VerifiedFile) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("text.txt");
    std::fs::write(&path, bytes).unwrap();
    let file = inspect(directory.path(), &path).unwrap();
    (directory, file)
}

#[test]
fn empty_bom_and_all_line_endings_are_exact() {
    for (bytes, end_line) in [
        (b"".as_slice(), 1),
        (b"a\n", 1),
        (b"a\r\nb\rc\n", 3),
        (b"\xef\xbb\xbfa", 1),
    ] {
        let (_directory, file) = fixture(bytes);
        let block = read_text_block(&file, 0, false).unwrap();
        assert_eq!(block.text.as_bytes(), bytes);
        assert_eq!(
            (block.block_count, block.byte_start, block.byte_end),
            (1, 0, bytes.len() as u64)
        );
        assert_eq!((block.start_line, block.end_line), (1, end_line));
        assert!(!block.starts_mid_line && !block.ends_mid_line);
    }
}

#[test]
fn boundaries_do_not_split_utf8_or_crlf_and_blocks_reconstruct_bytes() {
    let text = format!(
        "{}中\r\n{}😀tail",
        "a".repeat(BLOCK_BYTES - 1),
        "line\r\n".repeat(2001)
    );
    let (_directory, file) = fixture(text.as_bytes());
    let first = read_text_block(&file, 0, false).unwrap();
    assert_eq!(first.byte_end, (BLOCK_BYTES - 1) as u64);
    assert!(first.ends_mid_line);
    let mut reconstructed = String::new();
    let mut end = 0;
    for index in 0..first.block_count {
        let block = read_text_block(&file, index, false).unwrap();
        assert!(block.text.len() <= BLOCK_BYTES);
        assert_eq!(block.byte_start, end);
        assert!(!block.text.ends_with('\r'));
        end = block.byte_end;
        reconstructed.push_str(&block.text);
    }
    assert_eq!(reconstructed, text);
    let second = read_text_block(&file, 1, false).unwrap();
    assert!(second.starts_mid_line);
    assert_eq!(second.end_line, 2000);
}

#[test]
fn invalid_utf8_outside_selected_block_and_incomplete_suffix_are_rejected() {
    for invalid in [vec![255], vec![0xe4, 0xb8]] {
        let mut bytes = vec![b'a'; BLOCK_BYTES * 2];
        bytes.extend(invalid);
        let (_directory, file) = fixture(&bytes);
        assert_eq!(
            read_text_block(&file, 0, false).unwrap_err().code,
            "unsupportedText"
        );
    }
}

#[test]
fn navigation_is_strict_but_verified_new_version_restore_clamps() {
    let (directory, old) = fixture(&vec![b'a'; BLOCK_BYTES + 10]);
    std::fs::write(&old.path, "short").unwrap();
    assert_eq!(read_text_block(&old, 1, true).unwrap_err().code, "changed");
    let new = inspect(directory.path(), Path::new(&old.path)).unwrap();
    assert_eq!(
        read_text_block(&new, 1, false).unwrap_err().code,
        "invalidBlock"
    );
    let restored = read_text_block(&new, u64::MAX, true).unwrap();
    assert_eq!((restored.block_index, restored.block_count), (0, 1));
    assert_eq!(restored.text, "short");
}

#[test]
fn limits_and_fixed_failure_objects_are_not_mixed_with_media_limits() {
    let (directory, file) = fixture(&vec![b'a'; MAX_TEXT_BYTES as usize + 1]);
    assert!(matches!(read_text(&file), Err(DeliveryError::TooLarge)));
    assert!(read_text_block(&file, 0, false).is_ok());
    File::create(directory.path().join("too-large"))
        .unwrap()
        .set_len(MAX_VERIFIED_FILE_BYTES + 1)
        .unwrap();
    assert!(matches!(
        inspect(directory.path(), &directory.path().join("too-large")),
        Err(DeliveryError::TooLarge)
    ));
    let failure = TextBlockFailure { code: "pending" };
    assert_eq!(
        serde_json::to_value(failure).unwrap(),
        serde_json::json!({"code":"pending"})
    );
}
