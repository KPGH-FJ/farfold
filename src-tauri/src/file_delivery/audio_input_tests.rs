use super::*;

fn chunk(id: &[u8; 4], bytes: &[u8]) -> Vec<u8> {
    let mut out = id.to_vec();
    out.extend((bytes.len() as u32).to_le_bytes());
    out.extend(bytes);
    if !bytes.len().is_multiple_of(2) {
        out.push(0);
    }
    out
}

fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = chunks.iter().flatten().copied().collect();
    let mut bytes = b"RIFF".to_vec();
    bytes.extend((payload.len() as u32 + 4).to_le_bytes());
    bytes.extend(b"WAVE");
    bytes.extend(payload);
    bytes
}

fn fmt(channels: u16, rate: u32, bits: u16) -> Vec<u8> {
    let align = channels * bits / 8;
    let mut data = 1u16.to_le_bytes().to_vec();
    data.extend(channels.to_le_bytes());
    data.extend(rate.to_le_bytes());
    data.extend((rate * u32::from(align)).to_le_bytes());
    data.extend(align.to_le_bytes());
    data.extend(bits.to_le_bytes());
    chunk(b"fmt ", &data)
}

fn wave(channels: u16, rate: u32, bits: u16, frames: usize) -> Vec<u8> {
    riff(&[
        fmt(channels, rate, bits),
        chunk(
            b"data",
            &vec![128; frames * usize::from(channels * bits / 8)],
        ),
    ])
}

fn assert_code(bytes: &[u8], code: &str) {
    assert_eq!(wave_info(bytes).unwrap_err().code, code);
}

#[test]
fn audio_input_valid_pcm_preserves_every_byte_and_exact_source() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("renamed.txt");
    for channels in [1, 2] {
        for bits in [8, 16] {
            for rate in [8_000, 44_100, 96_000] {
                let bytes = wave(channels, rate, bits, 3);
                std::fs::write(&path, &bytes).unwrap();
                let first = read_audio_input(&path, None).unwrap();
                assert_eq!(STANDARD.decode(&first.data).unwrap(), bytes);
                assert_eq!(first.file.sha256, super::super::content_hash(&bytes));
                assert_eq!(
                    (
                        first.channels,
                        first.sample_rate,
                        first.bits_per_sample,
                        first.frames
                    ),
                    (channels, rate, bits, 3)
                );
                assert_eq!(first.duration_ms, 1);
                let same = read_audio_input(&path, Some(&first.file)).unwrap();
                assert_eq!(same.data, first.data);
                assert_eq!(same.file, first.file);
                assert_eq!(
                    prompt_audio_bytes(&same.data, "audio/wav").unwrap(),
                    bytes.len() as u64
                );
            }
        }
    }
}

#[test]
fn audio_input_walks_unknown_chunks_and_padding_before_and_after_data() {
    let bytes = riff(&[
        chunk(b"JUNK", &[1]),
        fmt(1, 8_000, 8),
        chunk(b"LIST", b"metadata"),
        chunk(b"data", &[1, 2, 3]),
        chunk(b"JUNK", &[5, 6, 7]),
    ]);
    assert_eq!(wave_info(&bytes).unwrap().frames, 3);
    // WAVEFORMATEX with no extension remains integer PCM, not extensible PCM.
    let mut extended = fmt(1, 8_000, 8);
    extended[4..8].copy_from_slice(&18u32.to_le_bytes());
    extended.extend([0, 0]);
    assert!(wave_info(&riff(&[extended.clone(), chunk(b"data", &[1])])).is_ok());
    extended[24] = 1;
    assert_code(&riff(&[extended, chunk(b"data", &[1])]), "unsupported");
    for cut in [1, 2, 7] {
        let mut broken = bytes[..bytes.len() - cut].to_vec();
        let size = broken.len() as u32 - 8;
        broken[4..8].copy_from_slice(&size.to_le_bytes());
        assert_code(&broken, "invalid");
    }
}

#[test]
fn audio_input_rejects_whole_length_duplicates_missing_order_and_truncated_chunks() {
    let valid = wave(1, 8_000, 8, 2);
    for size in [0, valid.len() as u32 - 9, valid.len() as u32 - 7, u32::MAX] {
        let mut bytes = valid.clone();
        bytes[4..8].copy_from_slice(&size.to_le_bytes());
        assert_code(&bytes, "invalid");
    }
    for chunks in [
        vec![fmt(1, 8_000, 8)],
        vec![chunk(b"data", &[1])],
        vec![chunk(b"data", &[1]), fmt(1, 8_000, 8)],
        vec![fmt(1, 8_000, 8), fmt(1, 8_000, 8), chunk(b"data", &[1])],
        vec![fmt(1, 8_000, 8), chunk(b"data", &[1]), chunk(b"data", &[1])],
        vec![fmt(1, 8_000, 8), chunk(b"data", &[])],
        vec![chunk(b"fmt ", &[0; 15]), chunk(b"data", &[1])],
    ] {
        assert_code(&riff(&chunks), "invalid");
    }
    for bytes in [&b""[..], &b"RIFF"[..], &b"RIFF\0\0\0\0WAVEtail"[..]] {
        assert_code(bytes, "invalid");
    }
    let mut overrun = valid;
    overrun[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_code(&overrun, "invalid");
}

#[test]
fn audio_input_rejects_unsupported_encoding_and_invalid_alignment_or_rates() {
    for tag in [0, 3, 6, 7, 0xfffe, 0xffff] {
        let mut bytes = wave(1, 8_000, 8, 2);
        bytes[20..22].copy_from_slice(&(tag as u16).to_le_bytes());
        assert_code(&bytes, "unsupported");
    }
    for (channels, rate, bits) in [
        (0, 8_000, 8),
        (3, 8_000, 8),
        (1, 7_999, 8),
        (1, 96_001, 8),
        (1, 8_000, 24),
    ] {
        assert_code(&wave(channels, rate, bits, 2), "unsupported");
    }
    for signature in [b"RIFX", b"RF64", b"BW64"] {
        let mut bytes = wave(1, 8_000, 8, 2);
        bytes[..4].copy_from_slice(signature);
        assert_code(&bytes, "unsupported");
    }
    for offset in [28, 32] {
        let mut bytes = wave(2, 44_100, 16, 2);
        bytes[offset] ^= 1;
        assert_code(&bytes, "invalid");
    }
    assert_code(
        &riff(&[fmt(2, 44_100, 16), chunk(b"data", &[0; 3])]),
        "invalid",
    );
}

#[test]
fn audio_input_limits_are_inclusive_and_do_not_truncate_or_approximate_duration() {
    let exactly = wave(1, 8_000, 8, 8_000 * 600);
    assert_eq!(wave_info(&exactly).unwrap().duration_ms, 600_000);
    assert_code(&wave(1, 8_000, 8, 8_000 * 600 + 1), "durationLimit");
    let exact_bytes = wave(1, 96_000, 8, MAX_AUDIO_BYTES as usize - 44);
    assert_eq!(exact_bytes.len() as u64, MAX_AUDIO_BYTES);
    assert!(wave_info(&exact_bytes).is_ok());
    let too_large = wave(1, 96_000, 8, MAX_AUDIO_BYTES as usize - 43);
    assert_code(&too_large, "limit");
    assert_eq!(
        prompt_audio_bytes("not-base64!", "audio/wav")
            .unwrap_err()
            .code,
        "invalid"
    );
    assert_eq!(
        prompt_audio_bytes("", "audio/mp3").unwrap_err().code,
        "unsupported"
    );
}

#[test]
fn audio_input_recheck_binds_all_source_fields_and_cannot_switch_selected_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.wav");
    let bytes = wave(1, 8_000, 8, 2);
    std::fs::write(&path, &bytes).unwrap();
    let first = read_audio_input(&path, None).unwrap();
    for field in 0..7 {
        let mut forged = first.file.clone();
        match field {
            0 => forged.root.push('x'),
            1 => forged.path.push('x'),
            2 => forged.resolved_path.push('x'),
            3 => forged.name.push('x'),
            4 => forged.size += 1,
            5 => forged.sha256 = "0".repeat(64),
            _ => forged.version = "0".repeat(64),
        }
        assert_eq!(
            read_audio_input(&path, Some(&forged)).unwrap_err().code,
            "changed"
        );
    }
    let other = dir.path().join("b.wav");
    std::fs::write(&other, &bytes).unwrap();
    assert_eq!(
        read_audio_input(&other, Some(&first.file))
            .unwrap_err()
            .code,
        "changed"
    );
    let mut changed = bytes;
    changed[44] ^= 1;
    std::fs::write(&path, changed).unwrap();
    assert_eq!(
        read_audio_input(&path, Some(&first.file)).unwrap_err().code,
        "changed"
    );
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        read_audio_input(&path, Some(&first.file)).unwrap_err().code,
        "unreadable"
    );
    assert_eq!(
        read_audio_input(dir.path(), None).unwrap_err().code,
        "unreadable"
    );
}

#[cfg(unix)]
#[test]
fn audio_input_recheck_detects_same_bytes_replacement_and_symlink_redirect() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("selected");
    std::fs::create_dir(&parent).unwrap();
    let a = parent.join("a.wav");
    let b = parent.join("b.wav");
    let bytes = wave(1, 8_000, 8, 2);
    std::fs::write(&a, &bytes).unwrap();
    std::fs::write(&b, &bytes).unwrap();
    let first = read_audio_input(&a, None).unwrap();
    std::fs::rename(&b, &a).unwrap();
    assert_eq!(
        read_audio_input(&a, Some(&first.file)).unwrap_err().code,
        "changed"
    );
    let link = parent.join("link.wav");
    std::os::unix::fs::symlink(&a, &link).unwrap();
    let linked = read_audio_input(&link, None).unwrap();
    std::fs::remove_file(&link).unwrap();
    let outside = dir.path().join("outside.wav");
    std::fs::write(&outside, &bytes).unwrap();
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(read_audio_input(&link, Some(&linked.file)).is_err());
}
