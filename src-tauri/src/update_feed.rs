use crate::update_platform::UpdatePlatform;
use reqwest::Response;
use serde_json::Value;
use std::time::Duration;
use tauri_plugin_updater::{RemoteRelease, RemoteReleaseInner};

// Includes the visible document, its base64 copy, signature, and JSON overhead.
const MAX_RESPONSE_BYTES: usize = 192 * 1024;

#[derive(Clone)]
pub(crate) struct UpdateRelease {
    pub(crate) current_version: String,
    pub(crate) version: String,
    pub(crate) target: String,
    pub(crate) download_url: reqwest::Url,
    pub(crate) signature: String,
    pub(crate) body: Option<String>,
    pub(crate) raw_json: Value,
}

async fn read_metadata_response(mut response: Response) -> Result<Value, String> {
    if response.status() != reqwest::StatusCode::OK {
        return Err("Managed update endpoint did not return signed release metadata".to_string());
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Managed update metadata exceeds its response byte limit".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Managed update metadata download failed".to_string())?
    {
        if chunk.len() > MAX_RESPONSE_BYTES - bytes.len() {
            return Err("Managed update metadata exceeds its response byte limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Managed update metadata is invalid JSON".to_string())
}

fn endpoint_url(
    endpoint: &str,
    version: &str,
    arch: &str,
    platform: UpdatePlatform,
) -> Result<reqwest::Url, String> {
    // Retain the official Tauri endpoint placeholders, including URL-encoded paths.
    let version = semver::Version::parse(version)
        .map_err(|_| "Managed update current version is invalid".to_string())?
        .to_string()
        .replace('+', "%2B");
    let mut endpoint = endpoint.to_string();
    for (key, value) in [
        ("current_version", version.as_str()),
        ("target", platform.target),
        ("arch", arch),
        ("bundle_type", platform.bundle),
    ] {
        endpoint = endpoint
            .replace(&format!("{{{{{key}}}}}"), value)
            .replace(&format!("%7B%7B{key}%7D%7D"), value);
    }
    let url = reqwest::Url::parse(&endpoint)
        .map_err(|_| "Managed update endpoint is invalid".to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Managed update endpoint must be a credential-free HTTPS URL".to_string());
    }
    Ok(url)
}

fn release_from_json(
    raw_json: Value,
    current_version: &str,
    platform: UpdatePlatform,
) -> Result<UpdateRelease, String> {
    // Use the pinned official parser, not a parallel interpretation of Tauri versions/dates.
    let release: RemoteRelease = serde_json::from_value(raw_json.clone())
        .map_err(|_| "Managed update release metadata is invalid".to_string())?;
    let RemoteReleaseInner::Dynamic(artifact) = release.data else {
        return Err("Managed update requires a scoped dynamic release document".to_string());
    };
    Ok(UpdateRelease {
        current_version: current_version.to_string(),
        version: release.version.to_string(),
        target: platform.target.to_string(),
        download_url: artifact.url,
        signature: artifact.signature,
        body: release.notes,
        raw_json,
    })
}

pub(crate) async fn fetch(
    endpoint: &str,
    current_version: &str,
    arch: &str,
    accept_invalid_certificates: bool,
    timeout: Duration,
) -> Result<UpdateRelease, String> {
    let platform = UpdatePlatform::current();
    let endpoint = endpoint_url(endpoint, current_version, arch, platform)?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .danger_accept_invalid_certs(accept_invalid_certificates)
        .connect_timeout(Duration::from_secs(2))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|_| "Cannot create managed update metadata client".to_string())?;
    let response = client
        .get(endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| "Managed update metadata request failed".to_string())?;
    release_from_json(
        read_metadata_response(response).await?,
        current_version,
        platform,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn response(body: Vec<u8>, chunked: bool) -> Response {
        response_status(body, chunked, "200 OK")
    }

    fn response_status(body: Vec<u8>, chunked: bool, status: &'static str) -> Response {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            let mut received = 0;
            while !request[..received]
                .windows(4)
                .any(|part| part == b"\r\n\r\n")
            {
                assert!(received < request.len(), "test request headers too large");
                let count = socket.read(&mut request[received..]).unwrap();
                assert!(count > 0, "test request ended before complete headers");
                received += count;
            }
            let header = if chunked {
                format!(
                    "HTTP/1.1 {status}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                )
            } else {
                format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
            };
            let _ = socket.write_all(header.as_bytes());
            if chunked {
                for chunk in body.chunks(4096) {
                    if write!(socket, "{:x}\r\n", chunk.len()).is_err()
                        || socket.write_all(chunk).is_err()
                        || socket.write_all(b"\r\n").is_err()
                    {
                        return;
                    }
                }
                let _ = socket.write_all(b"0\r\n\r\n");
            } else {
                let _ = socket.write_all(&body);
            }
        });
        tauri::async_runtime::block_on(async {
            reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .unwrap()
                .get(format!("http://{address}/feed"))
                .send()
                .await
                .unwrap()
        })
    }

    #[test]
    fn metadata_transport_rejects_announced_and_chunked_overflow_before_json_parsing() {
        let body = format!("{{\"notes\":\"{}\"}}", "x".repeat(MAX_RESPONSE_BYTES));
        for chunked in [false, true] {
            let response = response(body.as_bytes().to_vec(), chunked);
            let error = tauri::async_runtime::block_on(read_metadata_response(response))
                .expect_err("oversized metadata must be rejected");
            assert!(error.contains("limit"), "{error}");
        }
    }

    #[test]
    fn bounded_metadata_preserves_official_release_fields_and_raw_signature_envelope() {
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/signed-update-metadata.json")).unwrap();
        for chunked in [false, true] {
            let raw = tauri::async_runtime::block_on(read_metadata_response(response(
                serde_json::to_vec(&fixture).unwrap(),
                chunked,
            )))
            .unwrap();
            let release =
                release_from_json(raw, "0.1.2", UpdatePlatform::for_os("macos").unwrap()).unwrap();
            assert_eq!(release.current_version, "0.1.2");
            assert_eq!(release.version, "0.1.3");
            assert_eq!(release.target, "darwin");
            assert_eq!(release.raw_json, fixture);
            assert_eq!(release.signature, "signed-artifact-fixture");
        }
    }

    #[test]
    fn transport_boundary_accepts_exact_limit_and_does_not_echo_invalid_content() {
        let body = format!("\"{}\"", "x".repeat(MAX_RESPONSE_BYTES - 2));
        assert!(
            tauri::async_runtime::block_on(read_metadata_response(response(
                body.into_bytes(),
                true
            )))
            .is_ok()
        );
        let error = tauri::async_runtime::block_on(read_metadata_response(response(
            b"invalid SECRET-MARKER".to_vec(),
            false,
        )))
        .unwrap_err();
        assert_eq!(error, "Managed update metadata is invalid JSON");
    }

    #[test]
    fn no_content_partial_content_and_error_status_never_claim_no_update() {
        for status in [
            "204 No Content",
            "206 Partial Content",
            "401 Unauthorized",
            "500 Internal Server Error",
        ] {
            let error = tauri::async_runtime::block_on(read_metadata_response(response_status(
                Vec::new(),
                false,
                status,
            )))
            .unwrap_err();
            assert_eq!(
                error,
                "Managed update endpoint did not return signed release metadata"
            );
        }
    }

    #[test]
    fn release_parser_rejects_invalid_dates_versions_and_unscoped_static_feed() {
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/signed-update-metadata.json")).unwrap();
        for field in ["version", "pub_date"] {
            let mut raw = fixture.clone();
            raw[field] = Value::String("invalid".to_string());
            assert!(
                release_from_json(raw, "0.1.2", UpdatePlatform::for_os("macos").unwrap()).is_err()
            );
        }
        let mut raw = fixture;
        raw["platforms"] = serde_json::json!({});
        assert!(release_from_json(raw, "0.1.2", UpdatePlatform::for_os("macos").unwrap()).is_err());
    }

    #[test]
    fn windows_feed_uses_its_installer_target_and_never_inherits_mac_scope() {
        let platform = UpdatePlatform::for_os("windows").unwrap();
        let url = endpoint_url(
            "https://example.com/{{target}}/{{arch}}/{{bundle_type}}",
            "0.1.2",
            "x86_64",
            platform,
        )
        .unwrap();
        assert_eq!(url.as_str(), "https://example.com/windows/x86_64/nsis");
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/signed-update-metadata.json")).unwrap();
        let release = release_from_json(fixture, "0.1.2", platform).unwrap();
        // The envelope still carries its original macOS signature. The caller's
        // signed-scope verifier will reject it against this Windows expectation.
        assert_eq!(release.target, "windows");
    }

    #[test]
    fn endpoint_templates_preserve_semver_and_reject_insecure_or_credentialed_urls() {
        let url = endpoint_url(
            "https://example.com/{{target}}/%7B%7Barch%7D%7D/{{bundle_type}}?v={{current_version}}",
            "1.2.3+build.4",
            "aarch64",
            UpdatePlatform::for_os("macos").unwrap(),
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://example.com/darwin/aarch64/app?v=1.2.3%2Bbuild.4"
        );
        for url in [
            "http://example.com/feed",
            "https://user:secret@example.com/feed",
            "https://example.com/feed#fragment",
            "invalid",
        ] {
            assert!(
                endpoint_url(
                    url,
                    "0.1.3",
                    "aarch64",
                    UpdatePlatform::for_os("macos").unwrap()
                )
                .is_err()
            );
        }
    }
}
