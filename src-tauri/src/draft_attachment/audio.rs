//! Candidate classification is not audio validation or permission to send.
use std::path::Path;

use serde::Serialize;

use crate::file_delivery::{self, AudioReadFailure};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCandidate {
    pub mime_type: &'static str,
}

fn mime(path: &Path, bytes: &[u8]) -> Option<&'static str> {
    if bytes.get(8..12) == Some(b"WAVE")
        && matches!(bytes.get(..4), Some(b"RIFF" | b"RIFX" | b"RF64" | b"BW64"))
    {
        return Some("audio/wav");
    }
    if bytes.starts_with(b"ID3")
        || (bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
    {
        return Some("audio/mpeg");
    }
    if bytes.starts_with(b"fLaC") {
        return Some("audio/flac");
    }
    if bytes.starts_with(b"OggS") {
        return Some("audio/ogg");
    }
    if bytes.get(..4) == Some(b"FORM") && matches!(bytes.get(8..12), Some(b"AIFF" | b"AIFC")) {
        return Some("audio/aiff");
    }
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "wav" | "wave" => Some("audio/wav"),
        "mp3" => Some("audio/mpeg"),
        "flac" => Some("audio/flac"),
        "ogg" | "oga" | "opus" => Some("audio/ogg"),
        "m4a" | "m4b" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "aif" | "aiff" | "aifc" => Some("audio/aiff"),
        "wma" => Some("audio/x-ms-wma"),
        _ => None,
    }
}

pub(super) fn candidate(path: &Path) -> Result<Option<AudioCandidate>, AudioReadFailure> {
    let parent = path
        .parent()
        .ok_or(AudioReadFailure { code: "unreadable" })?;
    let bytes = file_delivery::attachment_prefix(parent, path)?;
    Ok(mime(path, &bytes).map(|mime_type| AudioCandidate { mime_type }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_candidate_sniffs_disguised_wave_and_preserves_unsupported_audio_identity() {
        assert_eq!(
            mime(Path::new("note.txt"), b"RIFF\0\0\0\0WAVE"),
            Some("audio/wav")
        );
        assert_eq!(
            mime(Path::new("note.txt"), b"RF64\0\0\0\0WAVE"),
            Some("audio/wav")
        );
        for (name, prefix, expected) in [
            ("note.txt", &b"ID3"[..], "audio/mpeg"),
            ("note.txt", &b"fLaC"[..], "audio/flac"),
            ("note.txt", &b"OggS"[..], "audio/ogg"),
            ("x.M4A", &b""[..], "audio/mp4"),
            ("x.WAV", &b"invalid"[..], "audio/wav"),
        ] {
            assert_eq!(mime(Path::new(name), prefix), Some(expected));
        }
        assert_eq!(mime(Path::new("note.txt"), b"ordinary"), None);
        assert_eq!(mime(Path::new("image.webp"), b"RIFF\0\0\0\0WEBP"), None);
    }

    #[test]
    fn audio_candidate_only_reads_a_prefix_of_the_explicit_selected_file() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.wav");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(b"RIFF\0\0\0\0WAVE").unwrap();
        file.set_len(32 * 1024 * 1024).unwrap();
        assert_eq!(candidate(&path).unwrap().unwrap().mime_type, "audio/wav");
        assert_eq!(
            file_delivery::read_audio_input(&path, None)
                .unwrap_err()
                .code,
            "limit"
        );
        std::fs::remove_file(&path).unwrap();
        assert_eq!(candidate(&path).unwrap_err().code, "unreadable");
    }
}
