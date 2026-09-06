use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::Value;

const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_SIGNATURE_BYTES: usize = 4096;
const MAX_VALIDITY_SECONDS: u64 = 31 * 24 * 60 * 60;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    payload: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    format_version: u32,
    bundle_id: String,
    target: String,
    arch: String,
    expires_at: u64,
}

pub(crate) struct ExpectedRelease<'a> {
    pub(crate) bundle_id: &'a str,
    pub(crate) target: &'a str,
    pub(crate) arch: &'a str,
    pub(crate) version: &'a str,
    pub(crate) url: &'a str,
    pub(crate) artifact_signature: &'a str,
}

pub(crate) fn verify(
    raw: &Value,
    public_key: &str,
    expected: ExpectedRelease<'_>,
    now_seconds: u64,
) -> Result<(), String> {
    let envelope = raw
        .get("farfoldMetadata")
        .ok_or_else(|| "Managed update signed metadata is missing".to_string())?;
    // Check lengths before cloning or decoding untrusted strings.
    if envelope.as_object().is_none_or(|fields| fields.len() != 2)
        || envelope
            .get("payload")
            .and_then(Value::as_str)
            .is_none_or(|value| value.len() > MAX_PAYLOAD_BYTES.div_ceil(3) * 4)
        || envelope
            .get("signature")
            .and_then(Value::as_str)
            .is_none_or(|value| value.len() > MAX_SIGNATURE_BYTES)
    {
        return Err("Managed update signed metadata exceeds its bounds".to_string());
    }
    let envelope: Envelope = serde_json::from_value(envelope.clone())
        .map_err(|_| "Managed update metadata envelope is invalid".to_string())?;
    let payload = STANDARD
        .decode(&envelope.payload)
        .map_err(|_| "Managed update metadata payload is invalid".to_string())?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err("Managed update metadata payload exceeds its bounds".to_string());
    }
    crate::managed_update::verify_artifact_signature(&payload, &envelope.signature, public_key)
        .map_err(|_| "Managed update metadata signature verification failed".to_string())?;
    let signed: Value = serde_json::from_slice(&payload)
        .map_err(|_| "Managed update signed metadata document is invalid".to_string())?;
    let signed_fields = signed
        .as_object()
        .ok_or_else(|| "Managed update signed metadata must be an object".to_string())?;
    let raw_fields = raw
        .as_object()
        .ok_or_else(|| "Managed update metadata must be an object".to_string())?;
    if signed_fields.contains_key("farfoldMetadata")
        || raw_fields.len() != signed_fields.len() + 1
        || signed_fields
            .iter()
            .any(|(key, value)| raw_fields.get(key) != Some(value))
    {
        return Err("Managed update metadata differs from its signed document".to_string());
    }
    let scope: Scope =
        serde_json::from_value(signed.get("farfold").cloned().unwrap_or(Value::Null))
            .map_err(|_| "Managed update signed release scope is invalid".to_string())?;
    if scope.format_version != 1
        || scope.bundle_id != expected.bundle_id
        || scope.target != expected.target
        || scope.arch != expected.arch
        || signed.get("version").and_then(Value::as_str) != Some(expected.version)
        || signed.get("url").and_then(Value::as_str) != Some(expected.url)
        || signed.get("signature").and_then(Value::as_str) != Some(expected.artifact_signature)
    {
        return Err("Managed update signed release identity does not match".to_string());
    }
    if scope.expires_at <= now_seconds
        || scope.expires_at.saturating_sub(now_seconds) > MAX_VALIDITY_SECONDS
    {
        return Err(
            "Managed update signed metadata is expired or outside its validity window".to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test-only public key and signature generated with the repository publisher.
    // No private signing material is stored in the repository.
    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDNFMkI5MzlCQTY5Mjk1QzgKUldUSWxaS21tNU1yUGgvM0gyZXZoc1VrRzdiM0pjdStRM1lqUzFudUNvWUo4QXlINXhjQkljQzEK";
    const NOW: u64 = 1_789_299_940;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../testdata/signed-update-metadata.json")).unwrap()
    }

    fn expected() -> ExpectedRelease<'static> {
        ExpectedRelease {
            bundle_id: "ai.farfold.test",
            target: "darwin",
            arch: "aarch64",
            version: "0.1.3",
            url: "https://example.com/Farfold.app.tar.gz",
            artifact_signature: "signed-artifact-fixture",
        }
    }

    #[test]
    fn publisher_signature_accepts_only_the_exact_visible_document() {
        verify(&fixture(), KEY, expected(), NOW).unwrap();
        for field in ["version", "url", "signature", "notes", "pub_date"] {
            let mut changed = fixture();
            changed[field] = Value::String("tampered".to_string());
            assert!(
                verify(&changed, KEY, expected(), NOW)
                    .unwrap_err()
                    .contains("differs")
            );
        }
        let mut changed = fixture();
        changed["farfoldMetadata"]["payload"] = Value::String(STANDARD.encode(b"tampered"));
        assert!(
            verify(&changed, KEY, expected(), NOW)
                .unwrap_err()
                .contains("signature verification")
        );
    }

    #[test]
    fn valid_signature_cannot_cross_application_platform_or_release_identity() {
        for field in 0..6 {
            let mut binding = expected();
            match field {
                0 => binding.bundle_id = "ai.farfold.other",
                1 => binding.target = "linux",
                2 => binding.arch = "x86_64",
                3 => binding.version = "0.1.4",
                4 => binding.url = "https://other.example.com/update",
                _ => binding.artifact_signature = "another-artifact",
            }
            assert!(
                verify(&fixture(), KEY, binding, NOW)
                    .unwrap_err()
                    .contains("identity")
            );
        }
    }

    #[test]
    fn metadata_expiry_is_revalidated_and_unbounded_lifetimes_are_refused() {
        assert!(
            verify(&fixture(), KEY, expected(), NOW + 60)
                .unwrap_err()
                .contains("expired")
        );
        assert!(
            verify(&fixture(), KEY, expected(), 0)
                .unwrap_err()
                .contains("validity window")
        );
    }

    #[test]
    fn missing_malformed_oversized_and_wrong_key_metadata_fail_closed() {
        assert!(verify(&serde_json::json!({}), KEY, expected(), NOW).is_err());
        let mut changed = fixture();
        changed["farfoldMetadata"]["payload"] = Value::String("x".repeat(MAX_PAYLOAD_BYTES * 2));
        assert!(
            verify(&changed, KEY, expected(), NOW)
                .unwrap_err()
                .contains("bounds")
        );
        let mut changed = fixture();
        changed["farfoldMetadata"]["extra"] = Value::Bool(true);
        assert!(verify(&changed, KEY, expected(), NOW).is_err());
        assert!(verify(&fixture(), "wrong-key", expected(), NOW).is_err());
    }
}
