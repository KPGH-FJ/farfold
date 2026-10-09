use super::*;

#[test]
fn generic_inspection_can_verify_a_file_above_the_binary_preview_limit() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("large.txt");
    File::create(&path)
        .unwrap()
        .set_len(MAX_FILE_BYTES + 1)
        .unwrap();
    let result = inspect(root.path(), &path);
    assert!(
        result.is_ok(),
        "ordinary-file verification should not inherit the media allocation limit: {result:?}"
    );
    assert_eq!(result.unwrap().size, MAX_FILE_BYTES + 1);
}

#[test]
fn p17_wire_contract_text_blocks() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("wire.txt");
    let text = format!("\u{feff}开始\r\n{}中\r\n尾", "x".repeat(128 * 1024 * 2));
    std::fs::write(&path, text.as_bytes()).unwrap();
    let file = inspect(root.path(), &path).unwrap();
    let first = read_text_block(&file, 0, false).unwrap();
    let blocks: Vec<_> = (0..first.block_count)
        .map(|index| read_text_block(&file, index, false).unwrap())
        .collect();
    assert_eq!(
        blocks
            .iter()
            .map(|block| block.text.as_str())
            .collect::<String>(),
        text
    );
    println!(
        "P17_BLOCK_CONTRACT={}",
        serde_json::to_string(&blocks).unwrap()
    );
}

#[test]
#[ignore = "explicit 256 MiB performance and memory measurement, not a routine fixture"]
fn ordinary_256_mib_streaming_benchmark() {
    #[cfg(unix)]
    fn peak_memory(label: &str) {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        assert_eq!(
            unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
            0
        );
        println!(
            "{label}_ru_maxrss={}",
            unsafe { usage.assume_init() }.ru_maxrss
        );
    }
    #[cfg(unix)]
    peak_memory("before");
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("large.txt");
    let mut writer = File::create(&path).unwrap();
    let mut chunk = [b'a'; 64 * 1024];
    chunk[chunk.len() - 1] = b'\n';
    for _ in 0..MAX_VERIFIED_FILE_BYTES / chunk.len() as u64 {
        writer.write_all(&chunk).unwrap();
    }
    writer.sync_all().unwrap();
    drop(writer);
    let inspect_start = std::time::Instant::now();
    let file = inspect(root.path(), &path).unwrap();
    println!("inspect_ms={}", inspect_start.elapsed().as_millis());
    let first_start = std::time::Instant::now();
    let first = read_text_block(&file, 0, false).unwrap();
    println!(
        "first_block_ms={} blocks={} returned_bytes={}",
        first_start.elapsed().as_millis(),
        first.block_count,
        first.text.len()
    );
    let last_start = std::time::Instant::now();
    let last = read_text_block(&file, u64::MAX, true).unwrap();
    println!(
        "last_block_ms={} last_index={}",
        last_start.elapsed().as_millis(),
        last.block_index
    );
    assert_eq!(last.byte_end, MAX_VERIFIED_FILE_BYTES);
    let copy_start = std::time::Instant::now();
    let receipt = copy(&file, &root.path().join("copy.txt")).unwrap();
    println!(
        "copy_ms={} copied_bytes={}",
        copy_start.elapsed().as_millis(),
        receipt.size
    );
    assert_eq!(receipt.sha256, file.sha256);
    assert_eq!(receipt.size, MAX_VERIFIED_FILE_BYTES);
    #[cfg(unix)]
    peak_memory("after");
}
