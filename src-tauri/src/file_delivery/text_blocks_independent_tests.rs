//! Independent contract challenges; all files are owned temporary fixtures.
use super::*;
use std::io::{Seek, SeekFrom};

const DISPLAY_BYTES: usize = 128 * 1024;
const READ_BYTES: usize = 64 * 1024;

fn fixture(bytes: &[u8]) -> (tempfile::TempDir, VerifiedFile) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("independent.txt");
    std::fs::write(&path, bytes).unwrap();
    let file = inspect(directory.path(), &path).unwrap();
    (directory, file)
}

fn reconstruct(file: &VerifiedFile) -> Vec<TextBlock> {
    let first = read_text_block(file, 0, false).unwrap();
    let count = first.block_count;
    let mut blocks = vec![first];
    for index in 1..count {
        blocks.push(read_text_block(file, index, false).unwrap());
    }
    let mut end = 0;
    for (index, block) in blocks.iter().enumerate() {
        assert_eq!(block.file, *file);
        assert_eq!(block.block_index, index as u64);
        assert_eq!(block.block_count, count);
        assert_eq!(block.byte_start, end);
        assert_eq!(block.byte_end - block.byte_start, block.text.len() as u64);
        assert!(block.text.len() <= DISPLAY_BYTES);
        end = block.byte_end;
    }
    assert_eq!(end, file.size);
    blocks
}

#[test]
fn independent_every_utf8_suffix_length_survives_the_real_read_buffer() {
    for scalar in ["é", "中", "😀"] {
        for prefix_bytes in 1..scalar.len() {
            let text = format!("{}{}\r\nZ", "a".repeat(READ_BYTES - prefix_bytes), scalar);
            let (_directory, file) = fixture(text.as_bytes());
            let block = read_text_block(&file, 0, false).unwrap();
            assert_eq!(block.text, text, "scalar={scalar}, split={prefix_bytes}");
            assert_eq!((block.start_line, block.end_line), (1, 2));
        }
    }
}

#[test]
fn independent_crlf_display_boundary_and_line_budget_are_lossless() {
    let text = format!("{}\r\n尾", "a".repeat(DISPLAY_BYTES - 1));
    let (_directory, file) = fixture(text.as_bytes());
    let blocks = reconstruct(&file);
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].byte_end, (DISPLAY_BYTES - 1) as u64);
    assert_eq!(blocks[1].text, "\r\n尾");
    assert!(blocks[0].ends_mid_line && blocks[1].starts_mid_line);
    assert_eq!((blocks[1].start_line, blocks[1].end_line), (1, 2));
    assert_eq!(
        blocks.iter().map(|b| b.text.as_str()).collect::<String>(),
        text
    );

    let text = format!("{}終", "\r\n".repeat(2000));
    let (_directory, file) = fixture(text.as_bytes());
    let blocks = reconstruct(&file);
    assert_eq!(blocks.len(), 2);
    assert_eq!((blocks[0].start_line, blocks[0].end_line), (1, 2000));
    assert_eq!((blocks[1].start_line, blocks[1].end_line), (2001, 2001));
    assert!(!blocks[0].ends_mid_line && !blocks[1].starts_mid_line);
    assert_eq!(
        blocks.iter().map(|b| b.text.as_str()).collect::<String>(),
        text
    );
}

#[test]
fn independent_combining_text_bom_and_lone_cr_preserve_original_bytes() {
    let text = format!("\u{feff}{}\r末", "中e\u{301}😀".repeat(20_000));
    let (_directory, file) = fixture(text.as_bytes());
    let blocks = reconstruct(&file);
    assert!(blocks.len() > 1);
    assert_eq!(
        blocks.iter().map(|b| b.text.as_str()).collect::<String>(),
        text
    );
    assert_eq!(blocks.last().unwrap().end_line, 2);
    assert!(!blocks.last().unwrap().ends_mid_line);
}

#[test]
fn independent_full_stream_rejects_a_same_length_tail_changed_after_first_chunk() {
    let (_directory, file) = fixture(&vec![b'a'; READ_BYTES * 3]);
    let mut changed = false;
    let result = stream::expected(&file, |_, _| {
        if !changed {
            let mut writer = std::fs::OpenOptions::new()
                .write(true)
                .open(&file.path)
                .unwrap();
            writer.seek(SeekFrom::End(-1)).unwrap();
            writer.write_all(b"Z").unwrap();
            writer.sync_all().unwrap();
            changed = true;
        }
        Ok(())
    });
    assert!(changed);
    assert_eq!(result, Err(DeliveryError::Changed));
}

#[test]
fn independent_atomic_replacement_with_equal_bytes_is_not_the_previous_version() {
    let bytes = vec![b'a'; DISPLAY_BYTES + 1];
    let (directory, file) = fixture(&bytes);
    let replacement = directory.path().join("replacement.txt");
    std::fs::write(&replacement, &bytes).unwrap();
    std::fs::rename(replacement, &file.path).unwrap();
    assert_eq!(
        read_text_block(&file, 1, false).unwrap_err().code,
        "changed"
    );
    let fresh = inspect(directory.path(), Path::new(&file.path)).unwrap();
    assert_eq!(fresh.sha256, file.sha256);
    assert_ne!(fresh.version, file.version);
    assert_eq!(read_text_block(&fresh, 1, false).unwrap().text, "a");
}

#[cfg(unix)]
#[test]
fn independent_same_bytes_symlink_retarget_cannot_reuse_old_receipt() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first.txt");
    let second = directory.path().join("second.txt");
    let alias = directory.path().join("selected.txt");
    std::fs::write(&first, "same bytes").unwrap();
    std::fs::write(&second, "same bytes").unwrap();
    symlink(&first, &alias).unwrap();
    let file = inspect(directory.path(), &alias).unwrap();
    std::fs::remove_file(&alias).unwrap();
    symlink(&second, &alias).unwrap();
    assert_eq!(
        read_text_block(&file, 0, false).unwrap_err().code,
        "changed"
    );
}

#[cfg(unix)]
#[test]
fn independent_root_replacement_rejects_even_the_same_open_leaf() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let previous = directory.path().join("previous");
    std::fs::create_dir(&root).unwrap();
    let path = root.join("file.txt");
    std::fs::write(&path, vec![b'a'; READ_BYTES * 3]).unwrap();
    let file = inspect(&root, &path).unwrap();
    let mut replaced = false;
    let result = stream::expected(&file, |_, _| {
        if !replaced {
            std::fs::rename(&root, &previous).unwrap();
            std::fs::create_dir(&root).unwrap();
            std::fs::hard_link(previous.join("file.txt"), &path).unwrap();
            replaced = true;
        }
        Ok(())
    });
    assert!(replaced);
    assert_eq!(result, Err(DeliveryError::Changed));
}
