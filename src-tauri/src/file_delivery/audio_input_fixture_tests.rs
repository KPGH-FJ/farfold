//! Independent writer/byte oracles exercised through the actual safe capture.
//! Fixtures are committed inputs, never read from an output or user directory.
use super::*;
use serde_json::Value;

const ORACLE: &str = include_str!("../../test-fixtures/audio-input/expected.json");
const FIXTURES: &[(&str, &[u8])] = &[
    (
        "valid-wave-c1-b8-r8000",
        include_bytes!("../../test-fixtures/audio-input/valid-wave-c1-b8-r8000.wav"),
    ),
    (
        "valid-wave-c1-b16-r8000",
        include_bytes!("../../test-fixtures/audio-input/valid-wave-c1-b16-r8000.wav"),
    ),
    (
        "valid-wave-c2-b8-r8000",
        include_bytes!("../../test-fixtures/audio-input/valid-wave-c2-b8-r8000.wav"),
    ),
    (
        "valid-wave-c2-b16-r8000",
        include_bytes!("../../test-fixtures/audio-input/valid-wave-c2-b16-r8000.wav"),
    ),
    (
        "valid-odd-mono8-data",
        include_bytes!("../../test-fixtures/audio-input/valid-odd-mono8-data.wav"),
    ),
    (
        "valid-metadata-odd-before-and-after",
        include_bytes!("../../test-fixtures/audio-input/valid-metadata-odd-before-and-after.wav"),
    ),
    (
        "valid-pcm-fmt18-zero-extension",
        include_bytes!("../../test-fixtures/audio-input/valid-pcm-fmt18-zero-extension.wav"),
    ),
];

#[test]
fn audio_input_independent_writer_capture_and_expected_reread_preserve_whole_file() {
    let oracle: Value = serde_json::from_str(ORACLE).unwrap();
    let samples = oracle["samples"].as_array().unwrap();
    assert_eq!(samples.len(), FIXTURES.len());
    for (id, bytes) in FIXTURES {
        let expected = samples.iter().find(|sample| sample["id"] == *id).unwrap();
        assert_eq!(expected["expected"], "accept", "{id}");
        assert_eq!(
            super::super::content_hash(bytes),
            expected["sha256"],
            "{id}"
        );
        assert_eq!(
            bytes.len() as u64,
            expected["bytes"].as_u64().unwrap(),
            "{id}"
        );
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let path = root.join(format!("独立录音 {id}%.WAVE"));
        std::fs::write(&path, bytes).unwrap();

        let first = read_audio_input(&path, None).unwrap();
        assert_eq!(first.file.root, root.to_str().unwrap(), "{id}");
        assert_eq!(first.file.path, path.to_str().unwrap(), "{id}");
        assert_eq!(first.file.resolved_path, path.to_str().unwrap(), "{id}");
        assert_eq!(
            first.file.name,
            path.file_name().unwrap().to_str().unwrap(),
            "{id}"
        );
        assert_eq!(first.file.size, expected["bytes"].as_u64().unwrap(), "{id}");
        assert_eq!(first.file.sha256, expected["sha256"], "{id}");
        assert_eq!(first.file.version.len(), 64, "{id}");
        assert_eq!(first.mime_type, "audio/wav", "{id}");
        let audio = &expected["audio"];
        assert_eq!(
            u64::from(first.channels),
            audio["channels"].as_u64().unwrap(),
            "{id}"
        );
        assert_eq!(
            u64::from(first.bits_per_sample),
            audio["bitsPerSample"].as_u64().unwrap(),
            "{id}"
        );
        assert_eq!(
            u64::from(first.sample_rate),
            audio["sampleRate"].as_u64().unwrap(),
            "{id}"
        );
        assert_eq!(first.frames, audio["frames"].as_u64().unwrap(), "{id}");
        assert_eq!(
            first.duration_ms,
            audio["durationMs"].as_u64().unwrap(),
            "{id}"
        );
        assert_eq!(
            first.data.len() as u64,
            expected["base64Length"].as_u64().unwrap(),
            "{id}"
        );
        assert_eq!(
            super::super::content_hash(first.data.as_bytes()),
            expected["base64Sha256"],
            "{id}"
        );
        assert_eq!(STANDARD.decode(&first.data).unwrap(), *bytes, "{id}");

        let reread = read_audio_input(&path, Some(&first.file)).unwrap();
        assert_eq!(
            serde_json::to_value(&reread).unwrap(),
            serde_json::to_value(&first).unwrap(),
            "{id}"
        );
        assert_eq!(std::fs::read(path).unwrap(), *bytes, "{id}");
    }
}
