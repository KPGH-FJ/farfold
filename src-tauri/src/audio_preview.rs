//! Ephemeral compatibility decoding, separate from stored or sent attachments.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;

const MAX_BYTES: usize = 16 * 1024 * 1024;
static DECODERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Failure {
    Invalid,
    Unsupported,
    UnsupportedPlatform,
    Limit,
    Busy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    data: String,
    source_sha256: String,
    sample_rate: u32,
    channels: u32,
    frames: u64,
}

#[tauri::command]
pub fn audio_preview_available() -> bool {
    cfg!(target_os = "macos")
}

#[tauri::command]
pub async fn audio_preview_decode(data: String) -> Result<Preview, Failure> {
    if !audio_preview_available() {
        return Err(Failure::UnsupportedPlatform);
    }
    decode_in_worker(move || decode(&data)).await
}

async fn decode_in_worker(
    operation: impl FnOnce() -> Result<Preview, Failure> + Send + 'static,
) -> Result<Preview, Failure> {
    // The permit is moved into the blocking operation. Dropping this request
    // cannot release it while the system decoder is still actually running.
    let permit = DECODERS.try_acquire().map_err(|_| Failure::Busy)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|_| Failure::Invalid)?
}

fn input(data: &str) -> Result<Vec<u8>, Failure> {
    if data.is_empty() || data.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err(Failure::Limit);
    }
    let bytes = STANDARD.decode(data).map_err(|_| Failure::Invalid)?;
    if bytes.len() > MAX_BYTES {
        return Err(Failure::Limit);
    }
    // Only complete FLAC or untagged ADTS is supported by this added route.
    // Unknown prefixes remain eligible for the unchanged original player.
    if !(bytes.starts_with(b"fLaC")
        || (bytes.len() >= 7 && bytes[0] == 0xff && bytes[1] & 0xf6 == 0xf0))
    {
        return Err(Failure::Unsupported);
    }
    Ok(bytes)
}

#[repr(C)]
#[derive(Default)]
#[cfg(any(target_os = "macos", test))]
struct Info {
    sample_rate: u32,
    channels: u32,
    frames: u64,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn ff_audio_preview(
        bytes: *const u8,
        length: usize,
        context: *mut std::ffi::c_void,
        sink: unsafe extern "C" fn(*mut std::ffi::c_void, *const f32, u32, u32) -> i32,
        info: *mut Info,
    ) -> i32;
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn collect(
    context: *mut std::ffi::c_void,
    samples: *const f32,
    frames: u32,
    channels: u32,
) -> i32 {
    if context.is_null() || samples.is_null() || frames > 4096 || !(1..=2).contains(&channels) {
        return 1;
    }
    let output = unsafe { &mut *context.cast::<Vec<u8>>() };
    let count = frames as usize * channels as usize;
    if output.len() > MAX_BYTES || count * 4 > MAX_BYTES - output.len() {
        return 1;
    }
    let needed = output.len() + count * 4;
    if needed > output.capacity() {
        // Amortize repeated chunks without Vec's unconstrained doubling near
        // the cap. Exact block-sized growth could copy the whole prefix once
        // per block; this bounds both requested capacity and growth count.
        let capacity = output
            .capacity()
            .saturating_mul(2)
            .max(needed)
            .min(MAX_BYTES);
        if output.try_reserve_exact(capacity - output.len()).is_err() {
            return 1;
        }
    }
    for value in unsafe { std::slice::from_raw_parts(samples, count) } {
        if !value.is_finite() {
            return 1;
        }
        output.extend_from_slice(&value.to_le_bytes());
    }
    0
}

#[cfg(any(target_os = "macos", test))]
fn wave_header(output: &mut [u8], info: &Info) -> Result<(), Failure> {
    if !(1..=2).contains(&info.channels)
        || !(8_000..=96_000).contains(&info.sample_rate)
        || info.frames == 0
        || info.frames > u64::from(info.sample_rate) * 600
        || output.len() > MAX_BYTES
        || output.len() < 44
        || info.frames.checked_mul(u64::from(info.channels) * 4) != Some((output.len() - 44) as u64)
    {
        return Err(Failure::Invalid);
    }
    let length = output.len() as u32;
    output[..4].copy_from_slice(b"RIFF");
    output[4..8].copy_from_slice(&(length - 8).to_le_bytes());
    output[8..16].copy_from_slice(b"WAVEfmt ");
    output[16..20].copy_from_slice(&16u32.to_le_bytes());
    output[20..22].copy_from_slice(&3u16.to_le_bytes()); // IEEE float, unchanged PCM values.
    output[22..24].copy_from_slice(&(info.channels as u16).to_le_bytes());
    output[24..28].copy_from_slice(&info.sample_rate.to_le_bytes());
    output[28..32].copy_from_slice(&(info.sample_rate * info.channels * 4).to_le_bytes());
    output[32..34].copy_from_slice(&(info.channels as u16 * 4).to_le_bytes());
    output[34..36].copy_from_slice(&32u16.to_le_bytes());
    output[36..40].copy_from_slice(b"data");
    output[40..44].copy_from_slice(&(length - 44).to_le_bytes());
    Ok(())
}

fn decode(data: &str) -> Result<Preview, Failure> {
    let bytes = input(data)?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bytes;
        Err(Failure::UnsupportedPlatform)
    }
    #[cfg(target_os = "macos")]
    {
        use sha2::{Digest, Sha256};
        let mut output = vec![0; 44];
        let mut info = Info::default();
        let result = unsafe {
            ff_audio_preview(
                bytes.as_ptr(),
                bytes.len(),
                (&mut output as *mut Vec<u8>).cast(),
                collect,
                &mut info,
            )
        };
        match result {
            0 => {}
            2 => return Err(Failure::Unsupported),
            3 | 4 => return Err(Failure::Limit),
            _ => return Err(Failure::Invalid),
        }
        wave_header(&mut output, &info)?;
        Ok(Preview {
            data: STANDARD.encode(output),
            source_sha256: Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            sample_rate: info.sample_rate,
            channels: info.channels,
            frames: info.frames,
        })
    }
}

#[cfg(test)]
#[path = "audio_preview_tests.rs"]
mod tests;
