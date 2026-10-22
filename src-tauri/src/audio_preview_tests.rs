use super::*;

#[test]
fn input_limits_and_unrecognized_types_do_not_enter_decoder() {
    assert_eq!(input(""), Err(Failure::Limit));
    assert_eq!(input("not base64"), Err(Failure::Invalid));
    assert_eq!(
        input(&STANDARD.encode(b"RIFFWAVE")),
        Err(Failure::Unsupported)
    );
    assert_eq!(
        input(&"A".repeat(MAX_BYTES.div_ceil(3) * 4 + 1)),
        Err(Failure::Limit)
    );
}

#[test]
fn output_geometry_must_match_actual_complete_pcm() {
    let mut wave = vec![0; 44 + 800 * 4];
    let mut info = Info {
        sample_rate: 8000,
        channels: 1,
        frames: 800,
    };
    wave_header(&mut wave, &info).unwrap();
    assert_eq!(&wave[..4], b"RIFF");
    assert_eq!(&wave[20..22], &3u16.to_le_bytes());
    assert_eq!(&wave[40..44], &3200u32.to_le_bytes());
    info.frames += 1;
    assert_eq!(wave_header(&mut wave, &info), Err(Failure::Invalid));
    info.frames = 800;
    info.channels = 3;
    assert_eq!(wave_header(&mut wave, &info), Err(Failure::Invalid));
}

#[tokio::test]
async fn cancelled_request_keeps_production_slot_until_worker_returns() {
    let (started, ready) = tokio::sync::oneshot::channel();
    let (finish, unfinished) = std::sync::mpsc::channel();
    let request = tokio::spawn(decode_in_worker(move || {
        started.send(()).unwrap();
        // A bound protects the test runner even if an assertion fails.
        unfinished
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        Err(Failure::Invalid)
    }));
    ready.await.unwrap();
    assert_eq!(DECODERS.available_permits(), 1);
    request.abort();
    assert!(matches!(request.await, Err(error) if error.is_cancelled()));
    assert_eq!(DECODERS.available_permits(), 1);
    let second = DECODERS.try_acquire().unwrap();
    assert!(matches!(
        decode_in_worker(|| Err(Failure::Invalid)).await,
        Err(Failure::Busy)
    ));
    drop(second);
    finish.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while DECODERS.available_permits() != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn actual_short_flac_keeps_all_samples_and_rejects_bad_data() {
    // Complete 800-frame, 8 kHz, mono silent FLAC. Original browser error4
    // specimen; this exercises the actual memory decoder, not HTML playback.
    let data = "ZkxhQ4AAACIQABAAAAANAAANAfQA8AAAAyBq0A9H2K1PEgBbIrLKpI94//h0CAADH/cAAABK+A==";
    let result = decode(data).unwrap();
    assert_eq!(
        (result.frames, result.sample_rate, result.channels),
        (800, 8000, 1)
    );
    let wave = STANDARD.decode(result.data).unwrap();
    assert_eq!(wave.len(), 44 + 800 * 4);
    assert!(wave[44..].iter().all(|byte| *byte == 0));
    assert_eq!(
        result.source_sha256,
        "219b60a0b78353e43373db25cb911cbc01fcdbbd6ba7fbb185d9e741fefe6c33"
    );
    assert!(decode(&STANDARD.encode(b"fLaCbad")).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn sink_rejects_nonfinite_and_oversized_chunks() {
    let mut out: Vec<u8> = vec![0; 44];
    let samples = [f32::NAN];
    let ctx = (&mut out as *mut Vec<u8>).cast();
    assert_ne!(unsafe { collect(ctx, samples.as_ptr(), 1, 1) }, 0);
    assert_ne!(unsafe { collect(ctx, samples.as_ptr(), 4097, 1) }, 0);
    assert_ne!(unsafe { collect(ctx, samples.as_ptr(), 1, 3) }, 0);
    assert_eq!(out.len(), 44);
}

#[cfg(target_os = "macos")]
#[test]
fn long_decode_keeps_capacity_bounded_without_growing_for_every_block() {
    let mut out: Vec<u8> = vec![0; 44];
    let samples = [0.0f32; 4096 * 2];
    let mut growths = 0;
    for _ in 0..511 {
        let previous = out.capacity();
        let ctx = (&mut out as *mut Vec<u8>).cast();
        assert_eq!(unsafe { collect(ctx, samples.as_ptr(), 4096, 2) }, 0);
        growths += usize::from(out.capacity() != previous);
        assert!(out.capacity() <= MAX_BYTES);
    }
    assert!(
        growths <= 16,
        "capacity grew {growths} times for 511 blocks"
    );
    let before = (out.len(), out.capacity());
    let ctx = (&mut out as *mut Vec<u8>).cast();
    assert_ne!(unsafe { collect(ctx, samples.as_ptr(), 4096, 2) }, 0);
    assert_eq!((out.len(), out.capacity()), before);
}
