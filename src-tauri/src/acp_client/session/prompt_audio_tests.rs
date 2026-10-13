//! Audio admission uses the real sending owner, never a cached/preparation card.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

fn aggregate_audio_fixtures() -> Vec<Vec<u8>> {
    let seed = include_bytes!("../../../test-fixtures/audio-input/aggregate-pcm-seed-1024.bin");
    let oracle: Value = serde_json::from_str(include_str!(
        "../../../test-fixtures/audio-input/aggregate-expected.json"
    ))
    .unwrap();
    let hash = |bytes: &[u8]| {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    assert_eq!(seed.len(), 1024);
    assert_eq!(hash(seed), oracle["seed"]["sha256"]);
    oracle["samples"]
        .as_array()
        .unwrap()
        .iter()
        .map(|sample| {
            let length = sample["bytes"].as_u64().unwrap() as usize;
            let mut bytes = b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x02\0\0\0\0\0\0\0\0\0\x02\0\x08\0data\0\0\0\0".to_vec();
            assert_eq!(bytes.len(), 44);
            bytes[4..8].copy_from_slice(&((length - 8) as u32).to_le_bytes());
            bytes[24..28].copy_from_slice(&96_000u32.to_le_bytes());
            bytes[28..32].copy_from_slice(&192_000u32.to_le_bytes());
            bytes[40..44].copy_from_slice(&((length - 44) as u32).to_le_bytes());
            let invert = match sample["seedMode"].as_str().unwrap() {
                "identity" => false,
                "invert-each-byte-255-minus-value" => true,
                other => panic!("unexpected independent reconstruction mode: {other}"),
            };
            bytes.extend((0..length - 44).map(|n| {
                let byte = seed[n % seed.len()];
                if invert { 255 - byte } else { byte }
            }));
            assert_eq!(sample["expectedIndividual"], "accept");
            assert_eq!(bytes.len() as u64, sample["bytes"].as_u64().unwrap());
            assert_eq!(hash(&bytes), sample["sha256"]);
            assert_eq!(hash(&bytes[44..]), sample["pcmSha256"]);
            let encoded = STANDARD.encode(&bytes);
            assert_eq!(encoded.len() as u64, sample["base64Length"].as_u64().unwrap());
            assert_eq!(hash(encoded.as_bytes()), sample["base64Sha256"]);
            bytes
        })
        .collect()
}

#[tokio::test]
async fn prompt_audio_exact_whole_file_limit_sends_and_two_extra_bytes_never_reach_control() {
    let bytes = aggregate_audio_fixtures();
    assert_eq!(bytes.len(), 3);
    assert_eq!(bytes[0].len() + bytes[1].len(), 16 * 1024 * 1024);
    assert_eq!(bytes[0].len() + bytes[2].len(), 16 * 1024 * 1024 + 2);
    // Counting PCM only would incorrectly admit the second pair, 86 bytes under.
    assert_eq!(
        bytes[0].len() - 44 + bytes[2].len() - 44,
        16 * 1024 * 1024 - 86
    );
    let blocks = |second: usize| -> Vec<ContentBlock> {
        serde_json::from_value(json!([
            {"type":"audio","data":STANDARD.encode(&bytes[0]),"mimeType":"audio/wav"},
            {"type":"audio","data":STANDARD.encode(&bytes[second]),"mimeType":"audio/wav"}
        ]))
        .unwrap()
    };
    let f = Fixture::new(json!({"promptCapabilities":{"audio":true}}));
    let (events, mut notifications) = mpsc::unbounded_channel();
    let id = f
        .manager
        .open_session(
            &f.row,
            &f.cwd,
            None,
            vec![],
            Arc::new(move |event| {
                let _ = events.send(event);
            }),
            &f.store,
        )
        .await
        .unwrap()
        .session_id;
    let (result, sent) = f.intercepted(&id, blocks(2)).await;
    assert_eq!(result, Err("FAILED:PROMPT_AUDIO_LIMIT".into()));
    assert!(
        sent.is_empty(),
        "the whole-file overage must precede pump control"
    );
    assert!(!f.cwd.join("wire.json").exists());

    f.manager
        .session_prompt(&f.row.id, &f.cwd, &id, blocks(1))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while !f.cwd.join("wire.json").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let wire: Value =
        serde_json::from_slice(&std::fs::read(f.cwd.join("wire.json")).unwrap()).unwrap();
    assert_eq!(wire["sessionId"], id);
    let prompt = wire["prompt"].as_array().unwrap();
    assert_eq!(prompt.len(), 2);
    for (block, original) in prompt.iter().zip(&bytes) {
        assert_eq!(block.as_object().unwrap().len(), 3);
        assert_eq!(block["type"], "audio");
        assert_eq!(block["mimeType"], "audio/wav");
        assert_eq!(
            STANDARD.decode(block["data"].as_str().unwrap()).unwrap(),
            *original
        );
    }
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &id)
        .await
        .unwrap();
    // Cancel acknowledgement only confirms delivery; wait for the peer's result.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = notifications.recv().await.unwrap();
            if event["kind"] == "turnEnd" {
                assert_eq!(event["stopReason"], "cancelled");
                break;
            }
        }
    })
    .await
    .unwrap();
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

fn audio() -> (Vec<u8>, Vec<ContentBlock>) {
    // Classic RIFF/WAVE: mono unsigned 8-bit PCM, 8 kHz, four exact samples.
    let bytes = b"RIFF\x28\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x40\x1f\0\0\x01\0\x08\0data\x04\0\0\0\0\x7f\x80\xff".to_vec();
    let blocks = serde_json::from_value(json!([
        {"type":"text","text":"selected audio"},
        {"type":"audio","data":STANDARD.encode(&bytes),"mimeType":"audio/wav"}
    ]))
    .unwrap();
    (bytes, blocks)
}

#[tokio::test]
async fn prompt_audio_false_missing_and_malformed_reject_despite_preparation_and_cache() {
    for actual in [
        json!({}),
        json!({"promptCapabilities":{"audio":false}}),
        json!({"promptCapabilities":{"audio":"true"}}),
        json!({"promptCapabilities":{"audio":null}}),
        json!({"promptCapabilities":{"audio":{}}}),
        json!({"promptCapabilities":{"audio":1}}),
    ] {
        let f = Fixture::new(json!({"promptCapabilities":{"audio":true}}));
        f.manager.connect(&f.row, &f.cwd, &f.store).await.unwrap();
        let preparation = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
        assert!(
            preparation
                .handshake
                .get()
                .unwrap()
                .typed
                .agent_capabilities
                .prompt_capabilities
                .audio
        );
        std::fs::write(f.cwd.join("capabilities.json"), actual.to_string()).unwrap();
        let id = f.open().await;
        f.store.set_agent_handshake(&f.row, &json!({"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{"audio":true}}})).unwrap();
        let (result, sent) = f.intercepted(&id, audio().1).await;
        assert_eq!(result, Err("FAILED:PROMPT_AUDIO_UNSUPPORTED".into()));
        assert!(sent.is_empty(), "audio rejection must precede pump control");
        assert!(!f.cwd.join("wire.json").exists());
        f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    }
}

#[tokio::test]
async fn prompt_audio_missing_actual_handshake_rejects_without_sending() {
    let f = Fixture::new(json!({"promptCapabilities":{"audio":true}}));
    let id = f.open().await;
    f.clear_actual_handshake(&id);
    let (result, sent) = f.intercepted(&id, audio().1).await;
    assert_eq!(result, Err("FAILED:PROMPT_AUDIO_UNKNOWN".into()));
    assert!(sent.is_empty());
    assert!(!f.cwd.join("wire.json").exists());
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test]
async fn prompt_audio_actual_supported_wire_preserves_original_bytes_and_busy_guard() {
    let f = Fixture::new(json!({"promptCapabilities":{"audio":false}}));
    f.manager.connect(&f.row, &f.cwd, &f.store).await.unwrap();
    std::fs::write(
        f.cwd.join("capabilities.json"),
        r#"{"promptCapabilities":{"audio":true}}"#,
    )
    .unwrap();
    let (events, mut notifications) = mpsc::unbounded_channel();
    let id = f
        .manager
        .open_session(
            &f.row,
            &f.cwd,
            None,
            vec![],
            Arc::new(move |event| {
                let _ = events.send(event);
            }),
            &f.store,
        )
        .await
        .unwrap()
        .session_id;
    f.store.set_agent_handshake(&f.row, &json!({"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{"audio":false}}})).unwrap();
    let (bytes, blocks) = audio();
    f.manager
        .session_prompt(&f.row.id, &f.cwd, &id, blocks.clone())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !f.cwd.join("wire.json").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let wire: Value =
        serde_json::from_slice(&std::fs::read(f.cwd.join("wire.json")).unwrap()).unwrap();
    assert_eq!(wire["prompt"], serde_json::to_value(&blocks).unwrap());
    assert_eq!(
        STANDARD
            .decode(wire["prompt"][1]["data"].as_str().unwrap())
            .unwrap(),
        bytes
    );
    assert_eq!(wire["prompt"][1].as_object().unwrap().len(), 3);
    assert_eq!(
        f.manager
            .session_prompt(&f.row.id, &f.cwd, &id, blocks)
            .await,
        Err("FAILED: 上次请求尚未结束，请先停止或等待".into())
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(f.cwd.join("wire.json")).unwrap()).unwrap(),
        wire
    );
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &id)
        .await
        .unwrap();
    // Cancel acknowledgement only confirms delivery; wait for the peer's result.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = notifications.recv().await.unwrap();
            if event["kind"] == "turnEnd" {
                assert_eq!(event["stopReason"], "cancelled");
                break;
            }
        }
    })
    .await
    .unwrap();
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test]
async fn prompt_audio_total_and_invalid_payload_reject_before_control_without_fallback() {
    let f = Fixture::new(json!({"promptCapabilities":{"audio":true}}));
    let id = f.open().await;
    let (mut bytes, _) = audio();
    bytes.resize(9 * 1024 * 1024, 128);
    let len = bytes.len() as u32;
    bytes[4..8].copy_from_slice(&(len - 8).to_le_bytes());
    bytes[24..28].copy_from_slice(&96_000u32.to_le_bytes());
    bytes[28..32].copy_from_slice(&96_000u32.to_le_bytes());
    bytes[40..44].copy_from_slice(&(len - 44).to_le_bytes());
    let block = json!({"type":"audio","data":STANDARD.encode(&bytes),"mimeType":"audio/wav"});
    for (value, expected) in [
        (json!([block.clone(), block]), "FAILED:PROMPT_AUDIO_LIMIT"),
        (
            json!([{"type":"audio","data":"invalid!","mimeType":"audio/wav"}]),
            "FAILED:PROMPT_AUDIO_INVALID",
        ),
        (
            json!([{"type":"audio","data":"AA==","mimeType":"audio/mp3"}]),
            "FAILED:PROMPT_AUDIO_FORMAT_UNSUPPORTED",
        ),
    ] {
        let (result, sent) = f
            .intercepted(&id, serde_json::from_value(value).unwrap())
            .await;
        assert_eq!(result, Err(expected.into()));
        assert!(sent.is_empty());
        assert!(!f.cwd.join("wire.json").exists());
    }
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[test]
fn prompt_audio_does_not_change_non_audio_admission() {
    let blocks: Vec<ContentBlock> = serde_json::from_value(json!([
        {"type":"text","text":"ordinary"},
        {"type":"image","data":"AA==","mimeType":"image/png"},
        {"type":"resource_link","name":"file","uri":"file:///fixture"}
    ]))
    .unwrap();
    assert_eq!(audio_admission(None, &blocks), Ok(()));
}
