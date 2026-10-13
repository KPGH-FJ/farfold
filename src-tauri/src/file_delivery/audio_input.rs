//! Exact selected PCM WAV bytes, without decoding, conversion or transcription.
use std::path::Path;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;

use super::{DeliveryError, VerifiedFile, capture};

pub(crate) const MAX_AUDIO_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SECONDS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioReadFailure {
    pub code: &'static str,
}

impl AudioReadFailure {
    pub fn check(message: &str) -> Self {
        use crate::file_read_check::{FailureKind, classify_error};
        Self {
            code: match classify_error(message) {
                FailureKind::Pending => "readPending",
                FailureKind::Busy => "readBusy",
                FailureKind::Unavailable => "unreadable",
            },
        }
    }
}

impl From<DeliveryError> for AudioReadFailure {
    fn from(error: DeliveryError) -> Self {
        Self {
            code: match error {
                DeliveryError::Changed => "changed",
                DeliveryError::TooLarge => "limit",
                _ => "unreadable",
            },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCapture {
    pub file: VerifiedFile,
    pub data: String,
    pub mime_type: &'static str,
    pub channels: u16,
    pub sample_rate: u32,
    pub bits_per_sample: u16,
    pub frames: u64,
    /// Rounded up, so short valid recordings never display as zero duration.
    pub duration_ms: u64,
}

#[derive(Debug, PartialEq, Eq)]
struct WaveInfo {
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
    frames: u64,
    duration_ms: u64,
}

fn failure(code: &'static str) -> AudioReadFailure {
    AudioReadFailure { code }
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn wave_info(bytes: &[u8]) -> Result<WaveInfo, AudioReadFailure> {
    if bytes.len() as u64 > MAX_AUDIO_BYTES {
        return Err(failure("limit"));
    }
    if bytes.len() < 12 {
        return Err(failure("invalid"));
    }
    if bytes.get(8..12) == Some(b"WAVE") && matches!(&bytes[..4], b"RIFX" | b"RF64" | b"BW64") {
        return Err(failure("unsupported"));
    }
    if &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(failure("invalid"));
    }
    if u64::from(u32_at(bytes, 4)) + 8 != bytes.len() as u64 {
        return Err(failure("invalid"));
    }
    let mut offset = 12usize;
    let mut format = None;
    let mut data_size = None;
    // Walk every chunk, including after data. Chunk sizes exclude header/pad;
    // the RIFF size includes all chunks and each odd-sized chunk's pad byte.
    while offset < bytes.len() {
        if bytes.len() - offset < 8 {
            return Err(failure("invalid"));
        }
        let id = &bytes[offset..offset + 4];
        let size = u32_at(bytes, offset + 4) as usize;
        let start = offset + 8;
        let end = start.checked_add(size).ok_or_else(|| failure("invalid"))?;
        let next = end
            .checked_add(size % 2)
            .ok_or_else(|| failure("invalid"))?;
        if next > bytes.len() {
            return Err(failure("invalid"));
        }
        match id {
            b"fmt " => {
                if format.is_some() || data_size.is_some() || size < 16 {
                    return Err(failure("invalid"));
                }
                let fmt = &bytes[start..end];
                if u16_at(fmt, 0) != 1 || !(size == 16 || (size == 18 && u16_at(fmt, 16) == 0)) {
                    return Err(failure("unsupported"));
                }
                let channels = u16_at(fmt, 2);
                let sample_rate = u32_at(fmt, 4);
                let bits = u16_at(fmt, 14);
                if !(1..=2).contains(&channels)
                    || !(8_000..=96_000).contains(&sample_rate)
                    || !matches!(bits, 8 | 16)
                {
                    return Err(failure("unsupported"));
                }
                let alignment = channels * (bits / 8);
                if u16_at(fmt, 12) != alignment
                    || u32_at(fmt, 8) != sample_rate * u32::from(alignment)
                {
                    return Err(failure("invalid"));
                }
                format = Some((channels, sample_rate, bits, alignment));
            }
            b"data" => {
                if format.is_none() || data_size.is_some() || size == 0 {
                    return Err(failure("invalid"));
                }
                data_size = Some(size as u64);
            }
            _ => {} // Metadata/unknown chunks remain untouched in the payload.
        }
        offset = next;
    }
    let (channels, sample_rate, bits_per_sample, alignment) =
        format.ok_or_else(|| failure("invalid"))?;
    let data_size = data_size.ok_or_else(|| failure("invalid"))?;
    if data_size % u64::from(alignment) != 0 {
        return Err(failure("invalid"));
    }
    let frames = data_size / u64::from(alignment);
    if frames > u64::from(sample_rate) * MAX_SECONDS {
        return Err(failure("durationLimit"));
    }
    Ok(WaveInfo {
        channels,
        sample_rate,
        bits_per_sample,
        frames,
        duration_ms: (frames * 1000).div_ceil(u64::from(sample_rate)),
    })
}

/// One bounded official block. The caller also bounds the sum for the prompt.
pub(crate) fn prompt_audio_bytes(data: &str, mime_type: &str) -> Result<u64, AudioReadFailure> {
    if mime_type != "audio/wav" {
        return Err(failure("unsupported"));
    }
    if data.len() as u64 > MAX_AUDIO_BYTES.div_ceil(3) * 4 {
        return Err(failure("limit"));
    }
    let bytes = STANDARD.decode(data).map_err(|_| failure("invalid"))?;
    wave_info(&bytes)?;
    Ok(bytes.len() as u64)
}

pub fn read_audio_input(
    path: &Path,
    expected: Option<&VerifiedFile>,
) -> Result<AudioCapture, AudioReadFailure> {
    let parent = path.parent().ok_or_else(|| failure("unreadable"))?;
    // Never use a caller-supplied root/path to expand the one selected URI.
    if expected.is_some_and(|file| Path::new(&file.path) != path) {
        return Err(failure("changed"));
    }
    let (file, bytes) = capture(parent, path, MAX_AUDIO_BYTES)?;
    if expected.is_some_and(|expected| expected != &file) {
        return Err(failure("changed"));
    }
    let info = wave_info(&bytes)?;
    Ok(AudioCapture {
        file,
        data: STANDARD.encode(bytes),
        mime_type: "audio/wav",
        channels: info.channels,
        sample_rate: info.sample_rate,
        bits_per_sample: info.bits_per_sample,
        frames: info.frames,
        duration_ms: info.duration_ms,
    })
}

#[cfg(test)]
#[path = "audio_input_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "audio_input_fixture_tests.rs"]
mod fixture_tests;
