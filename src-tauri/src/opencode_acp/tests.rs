use super::identity::managed_acp_binding;
use super::*;
use crate::host_ids::{ProviderConfigVersionId, ProviderConnectionId};
use crate::host_store::provider_projection::TurnProviderBindingAuthority;

#[test]
fn acp_binding_uses_distinct_protocol_identity() {
    let binding = acp_binding(&PathBuf::from("/tmp/opencode")).unwrap();
    assert_eq!(binding.product_id.as_str(), "opencode");
    assert_eq!(binding.adapter_id.as_str(), OPENCODE_ACP_ADAPTER_ID);
    assert_ne!(
        binding.connection_id.as_str(),
        crate::runtime_registry::OPENCODE_RUNTIME.default_connection_id
    );
}

#[test]
fn acp_native_session_registers_host_navigation_identity() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let binding = acp_binding(Path::new("/tmp/opencode")).unwrap();

    let (farfold_session_id, navigation) = register_acp_runtime_and_session(
        &store,
        &binding,
        &workspace,
        Path::new("/tmp/opencode"),
        "ses_acp_host",
    )
    .map(|(session_id, _, navigation)| (session_id, navigation))
    .unwrap();

    let restore_state = serde_json::to_value(navigation.restore_state.as_ref().unwrap())
        .expect("restore state serializes for frontend navigation");
    assert_eq!(restore_state["lastSessionId"], farfold_session_id.as_str());
    let restore_updated_at = restore_state["updatedAt"].as_i64().unwrap();
    let session = navigation
        .session_index
        .sessions
        .iter()
        .find(|session| session.farfold_session_id == farfold_session_id)
        .unwrap();
    assert_eq!(session.runtime_product_id, binding.product_id);
    assert_eq!(session.installation_id, binding.installation_id);
    assert_eq!(session.runtime_build_id, binding.runtime_build_id);
    assert_eq!(session.adapter_id.as_str(), OPENCODE_ACP_ADAPTER_ID);
    assert_eq!(session.connection_id, binding.connection_id);
    assert_eq!(session.native_session_id.as_str(), "ses_acp_host");
    assert_eq!(
        session.working_copy_path,
        workspace.canonicalize().unwrap().to_string_lossy()
    );
    assert_eq!(session.title, "OpenCode ACP");
    assert_eq!(session.last_opened_at, restore_updated_at);
}

#[test]
#[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
fn fixed_opencode_acp_registry_record_survives_session_registration_and_restore() {
    let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
        .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
    let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let installation = derived_host_id(
        "system-installation",
        &["opencode", &binary.to_string_lossy()],
    );
    let runtime_build_id = derived_host_id(
        "runtime-build",
        &[
            &installation,
            OPENCODE_ACP_VERSION,
            OPENCODE_ACP_BINARY_SHA256,
        ],
    );
    let connection = derived_host_id("connection", &[&installation, OPENCODE_ACP_ADAPTER_ID]);
    let binding = RuntimeBinding {
        product_id: RuntimeProductId::parse("opencode").unwrap(),
        installation_id: InstallationId::parse(installation.clone()).unwrap(),
        runtime_build_id: RuntimeBuildId::parse(runtime_build_id).unwrap(),
        adapter_id: AdapterId::parse(OPENCODE_ACP_ADAPTER_ID).unwrap(),
        connection_id: ConnectionId::parse(connection).unwrap(),
    };
    let now = i64::try_from(now_millis()).unwrap();
    let inspection = json!({
        "runtime": {
            "productId": "opencode",
            "installationId": installation,
            "adapterId": OPENCODE_ACP_ADAPTER_ID,
        },
        "displayName": "OpenCode ACP",
        "selectedPath": binary.clone(),
        "canonicalPath": binary.clone(),
        "source": "manual",
        "distribution": "system",
        "observedVersion": OPENCODE_ACP_VERSION,
        "expectedVersion": OPENCODE_ACP_VERSION,
        "artifactSha256": OPENCODE_ACP_BINARY_SHA256,
        "expectedSha256": OPENCODE_ACP_BINARY_SHA256,
        "compatible": true,
        "launchReferenceAvailable": true,
        "activation": "checked_not_active",
        "verifiedAt": now,
    });
    let registration = RuntimeRegistration {
        runtime_product_id: binding.product_id.clone(),
        display_name: "OpenCode".to_string(),
        installation_id: binding.installation_id.clone(),
        runtime_build_id: binding.runtime_build_id.clone(),
        adapter_id: binding.adapter_id.clone(),
        distribution: RuntimeDistribution::System,
        observed_version: OPENCODE_ACP_VERSION.to_string(),
        artifact_sha256: OPENCODE_ACP_BINARY_SHA256.to_string(),
        connection_id: binding.connection_id.clone(),
        connection_label: "OpenCode ACP system local".to_string(),
        connection_kind: RuntimeConnectionKind::SystemLocal,
        created_at: now,
        verified_at: now,
    };
    let launch_json = inspection.to_string();
    store
        .accept_runtime_system_installation(&registration, &binary, &launch_json, now)
        .unwrap();

    let (verified_binding, verified_path) =
        crate::runtime_registry::verified_system_runtime_binding(
            &store,
            crate::runtime_registry::ManagedRuntimeKey::OpencodeAcp,
            binding.installation_id.as_str(),
            binding.connection_id.as_str(),
        )
        .unwrap();
    assert_eq!(verified_binding, binding);
    assert_eq!(verified_path, binary);
    register_acp_runtime_and_session(&store, &binding, &workspace, &binary, "ses_registry_acp")
        .unwrap();
    let saved = store
        .runtime_system_installations(&binding.product_id)
        .unwrap()
        .into_iter()
        .find(|record| record.installation_id == binding.installation_id)
        .unwrap();
    assert_eq!(saved.launch_json, launch_json);
    assert!(
        crate::runtime_registry::saved_from_installation(
            crate::runtime_registry::ManagedRuntimeKey::OpencodeAcp,
            saved,
        )
        .is_ok()
    );
    assert_eq!(
        verified_saved_acp_binding(&store, &binding).unwrap(),
        binary
    );
    let managed = managed_acp_registered_binding(
        &store,
        &binary,
        &ProviderConnectionId::parse("provider-registry-qa").unwrap(),
        &ProviderConfigVersionId::parse("config-registry-qa").unwrap(),
    )
    .unwrap();
    assert_eq!(managed.installation_id, binding.installation_id);
    assert_eq!(managed.runtime_build_id, binding.runtime_build_id);
    assert_ne!(managed.connection_id, binding.connection_id);
    register_acp_runtime_and_session(
        &store,
        &managed,
        &workspace,
        &binary,
        "ses_registry_managed_acp",
    )
    .unwrap();
    assert_eq!(
        store
            .runtime_system_installations(&binding.product_id)
            .unwrap()
            .len(),
        1
    );
}

#[test]
#[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
fn fixed_opencode_acp_host_create_open_and_reuse_registry_installation_without_model_turn() {
    let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
        .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
    let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let app_data_root = temp.path().join("app-data");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&app_data_root).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let inspection = crate::runtime_registry::inspect_managed_runtime_candidate(
        crate::runtime_registry::ManagedRuntimeCandidateInput {
            runtime: crate::runtime_registry::ManagedRuntimeKey::OpencodeAcp,
            path: binary.clone(),
            source: Some(crate::runtime_registry::ManagedRuntimeCandidateSource::Manual),
        },
    )
    .unwrap();
    assert!(inspection.compatible);
    let registration = crate::runtime_registry::managed_system_registration(&inspection)
        .expect("compatible ACP inspection can become a system registration");
    let inspection_json = serde_json::to_string(&inspection).unwrap();
    store
        .accept_runtime_system_installation(
            &registration,
            &inspection.canonical_path,
            &inspection_json,
            inspection.verified_at,
        )
        .unwrap();
    let (binding, verified_path) = crate::runtime_registry::verified_system_runtime_binding(
        &store,
        crate::runtime_registry::ManagedRuntimeKey::OpencodeAcp,
        registration.installation_id.as_str(),
        registration.connection_id.as_str(),
    )
    .unwrap();
    assert_eq!(verified_path, binary);

    let runtime = OpenCodeAcpRuntime::default();
    let created = create_registered_host_session_with_app_data(
        &app_data_root,
        runtime.clone(),
        RuntimeEventRouter::default(),
        store.clone(),
        OpenCodeAcpHostCreateInput {
            binding: binding.clone(),
            binary_path: binary.clone(),
            working_copy_path: workspace.clone(),
            managed_provider: None,
        },
    )
    .unwrap();
    assert_eq!(created.installation_id, binding.installation_id.as_str());
    assert!(created.runtime_generation > 0);
    let stopped = opencode_acp_stop_blocking(runtime).unwrap();
    assert_eq!(stopped.state, "stopped");

    let reopened_runtime = OpenCodeAcpRuntime::default();
    let reopened = open_registered_host_session_with_app_data(
        &app_data_root,
        reopened_runtime.clone(),
        RuntimeEventRouter::default(),
        store.clone(),
        OpenCodeAcpHostOpenInput {
            binding: binding.clone(),
            farfold_session_id: created.farfold_session_id.clone(),
            working_copy_path: workspace.clone(),
            native_session_id: created.native_session_id.clone(),
        },
    )
    .unwrap();
    assert!(reopened.runtime_generation > 0);
    let stopped = opencode_acp_stop_blocking(reopened_runtime).unwrap();
    assert_eq!(stopped.state, "stopped");

    let saved = store
        .runtime_system_installations(&binding.product_id)
        .unwrap()
        .into_iter()
        .find(|record| record.installation_id == binding.installation_id)
        .unwrap();
    assert_eq!(saved.launch_json, inspection_json);
    let listed = crate::runtime_registry::saved_from_installation(
        crate::runtime_registry::ManagedRuntimeKey::OpencodeAcp,
        saved,
    )
    .unwrap();

    let reused_runtime = OpenCodeAcpRuntime::default();
    let reused = create_registered_host_session_with_app_data(
        &app_data_root,
        reused_runtime.clone(),
        RuntimeEventRouter::default(),
        store.clone(),
        OpenCodeAcpHostCreateInput {
            binding: binding.clone(),
            binary_path: listed.inspection.canonical_path.clone(),
            working_copy_path: workspace.clone(),
            managed_provider: None,
        },
    )
    .unwrap();
    assert!(reused.runtime_generation > 0);
    let stopped = opencode_acp_stop_blocking(reused_runtime).unwrap();
    assert_eq!(stopped.state, "stopped");

    let provider = crate::managed_provider::save_api_key_in_dir(
        &app_data_root,
        Some(&store),
        crate::managed_provider::ManagedProviderApiKeySaveInput {
            provider_key: "openai".into(),
            label: "Host create fixture".into(),
            account_label: "qa".into(),
            endpoint: "https://fixture.example.invalid/v1".into(),
            api_kind: "openai-chat-completions".into(),
            api_key: "fixture-not-a-secret".into(),
            model_id: "fixture-model".into(),
            context_window: Some(128000),
            max_tokens: Some(8192),
            reasoning: Some(false),
            image_input: Some(false),
            supports_developer_role: Some(false),
            supports_reasoning_effort: Some(false),
        },
    )
    .unwrap();
    let runtime = OpenCodeAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let managed = create_registered_host_session_with_app_data(
        &app_data_root,
        runtime.clone(),
        router.clone(),
        store.clone(),
        OpenCodeAcpHostCreateInput {
            binding: binding.clone(),
            binary_path: binary.clone(),
            working_copy_path: workspace.clone(),
            managed_provider: Some(crate::managed_provider::ManagedProviderSelection {
                provider_connection_id: provider.provider_connection_id.clone(),
                provider_config_version_id: provider.current_config_version_id.clone(),
            }),
        },
    )
    .unwrap();
    let target = store
        .session_open_target(&managed.farfold_session_id)
        .unwrap();
    assert_ne!(target.connection_id, binding.connection_id);
    assert_eq!(
        verified_acp_creation_target(
            &store,
            target.installation_id.as_str(),
            target.connection_id.as_str()
        )
        .unwrap()
        .0,
        target.binding()
    );
    assert!(
        verified_acp_creation_target(
            &store,
            target.installation_id.as_str(),
            "connection-unknown"
        )
        .is_err()
    );
    let inherited = create_registered_host_session_with_app_data(
        &app_data_root,
        runtime.clone(),
        router,
        store.clone(),
        OpenCodeAcpHostCreateInput {
            binding: target.binding(),
            binary_path: binary,
            working_copy_path: workspace,
            managed_provider: None,
        },
    )
    .unwrap();
    let next = store
        .session_open_target(&inherited.farfold_session_id)
        .unwrap();
    assert_eq!(next.connection_id, target.connection_id);
    assert_ne!(next.native_session_id, target.native_session_id);
    assert!(
        current_status(&runtime, None)
            .unwrap()
            .managed_provider
            .unwrap()
            .runtime_model_id
            .ends_with("/fixture-model")
    );
    opencode_acp_stop_blocking(runtime).unwrap();
}

fn fixture_connection(script_body: &str) -> (tempfile::TempDir, OpenCodeAcpConnection) {
    let temp = tempfile::tempdir().unwrap();
    let script = temp.path().join("fixture.py");
    std::fs::write(&script, script_body).unwrap();
    let transport =
        Arc::new(AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap());
    let binding = acp_binding(Path::new("/tmp/opencode")).unwrap();
    (
        temp,
        OpenCodeAcpConnection {
            transport,
            binding,
            generation: 1,
            cwd: PathBuf::from("/tmp"),
            binary_path: PathBuf::from("/tmp/opencode"),
            session_id: Some("ses_keep".to_string()),
            agent_name: Some("OpenCode".to_string()),
            agent_version: OPENCODE_ACP_VERSION.to_string(),
            protocol_version: 1,
            question_bridge: false,
            load_session: true,
            config_options: json!([]),
            managed_provider: None,
            private_launch_dir: None,
            last_error: None,
            dropped_events: 0,
            initialized_at_ms: 1,
            operations: AcpSessionOperations::default(),
            event_pump_stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        },
    )
}

#[cfg(test)]
pub(crate) struct ChatFixtureServer {
    pub(crate) port: u16,
    pub(crate) captured: Arc<Mutex<Vec<(String, String, Value)>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl ChatFixtureServer {
    pub(crate) fn start() -> Self {
        use std::{
            io::{Read as _, Write as _},
            net::{TcpListener, TcpStream},
        };

        fn read_chunked_body(mut stream: &TcpStream) -> Result<Vec<u8>, String> {
            let mut body = Vec::new();
            loop {
                let mut line = Vec::new();
                let mut byte = [0_u8; 1];
                loop {
                    stream
                        .read_exact(&mut byte)
                        .map_err(|error| format!("cannot read chunk header: {error}"))?;
                    line.push(byte[0]);
                    if line.ends_with(b"\r\n") {
                        break;
                    }
                }
                let line_text = String::from_utf8(line)
                    .map_err(|error| format!("chunk header is not utf8: {error}"))?;
                let size_hex = line_text
                    .split(';')
                    .next()
                    .ok_or("chunk header is empty")?
                    .trim();
                let size = usize::from_str_radix(size_hex, 16)
                    .map_err(|error| format!("chunk size is invalid: {error}"))?;
                if size == 0 {
                    let mut trailer_end = Vec::new();
                    loop {
                        stream
                            .read_exact(&mut byte)
                            .map_err(|error| format!("cannot read chunk trailer: {error}"))?;
                        trailer_end.push(byte[0]);
                        if trailer_end.ends_with(b"\r\n\r\n") || trailer_end == b"\r\n" {
                            break;
                        }
                    }
                    return Ok(body);
                }
                let start = body.len();
                body.resize(start + size, 0);
                stream
                    .read_exact(&mut body[start..])
                    .map_err(|error| format!("cannot read chunk body: {error}"))?;
                let mut crlf = [0_u8; 2];
                stream
                    .read_exact(&mut crlf)
                    .map_err(|error| format!("cannot read chunk terminator: {error}"))?;
                if crlf != *b"\r\n" {
                    return Err("chunk terminator is invalid".to_string());
                }
            }
        }

        fn read_http_request(mut stream: &TcpStream) -> Option<(String, String, Value)> {
            let mut header = Vec::new();
            let mut buffer = [0_u8; 1];
            while !header.ends_with(b"\r\n\r\n") {
                if stream.read_exact(&mut buffer).is_err() {
                    return None;
                }
                header.push(buffer[0]);
            }
            let header_text = String::from_utf8(header).ok()?;
            let lower_header = header_text.to_ascii_lowercase();
            let chunked = lower_header
                .lines()
                .any(|line| line.trim() == "transfer-encoding: chunked");
            let content_length = header_text
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Content-Length:")
                        .or_else(|| line.strip_prefix("content-length:"))
                })
                .map(str::trim)
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            let path = header_text
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("")
                .to_string();
            let authorization = header_text
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Authorization:")
                        .or_else(|| line.strip_prefix("authorization:"))
                })
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            let sanitized_headers = header_text
                .lines()
                .map(|line| {
                    if line.to_ascii_lowercase().starts_with("authorization:") {
                        "Authorization: <redacted>".to_string()
                    } else {
                        line.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            let raw_body = if chunked {
                match read_chunked_body(stream) {
                    Ok(body) => body,
                    Err(error) => {
                        let body = json!({
                            "_readError": error,
                            "_headers": sanitized_headers,
                            "_rawBodyBytes": 0,
                        });
                        return Some((path, authorization, body));
                    }
                }
            } else {
                let mut body = vec![0_u8; content_length];
                if let Err(error) = stream.read_exact(&mut body) {
                    let body = json!({
                        "_readError": error.to_string(),
                        "_headers": sanitized_headers,
                        "_rawBodyUtf8": String::from_utf8_lossy(&body),
                        "_rawBodyBytes": body.len(),
                    });
                    return Some((path, authorization, body));
                }
                body
            };
            let body = serde_json::from_slice(&raw_body).unwrap_or_else(|error| {
                json!({
                    "_parseError": error.to_string(),
                    "_headers": sanitized_headers,
                    "_rawBodyUtf8": String::from_utf8_lossy(&raw_body),
                    "_rawBodyBytes": raw_body.len(),
                })
            });
            Some((path, authorization, body))
        }

        fn write_chat_completion(mut stream: TcpStream) {
            let chunk = r#"data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}

data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                chunk.len(),
                chunk
            );
            stream.write_all(response.as_bytes()).unwrap();
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let captured = Arc::new(Mutex::new(Vec::<(String, String, Value)>::new()));
        let captured_thread = captured.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_thread = stop.clone();
        let handle = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(45);
            while !stop_thread.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => {
                        // Accepted sockets inherit O_NONBLOCK on macOS; restore
                        // blocking I/O so fixture reads cannot hit WouldBlock.
                        stream.set_nonblocking(false).unwrap();
                        if let Some(request) = read_http_request(&stream) {
                            captured_thread.lock().unwrap().push(request);
                            write_chat_completion(stream);
                        } else {
                            captured_thread.lock().unwrap().push((
                                "<unparsed>".to_string(),
                                String::new(),
                                json!({"_readError": "request header unavailable"}),
                            ));
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(error) => panic!("fixture HTTP server failed: {error}"),
                }
            }
        });
        Self {
            port,
            captured,
            stop,
            handle: Some(handle),
        }
    }

    fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn captured(&self) -> Vec<(String, String, Value)> {
        self.captured.lock().unwrap().clone()
    }
}

impl Drop for ChatFixtureServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
struct ToolCallFixtureServer {
    port: u16,
    captured: Arc<Mutex<Vec<(String, String, Value)>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl ToolCallFixtureServer {
    fn start() -> Self {
        use std::{
            io::{Read as _, Write as _},
            net::{TcpListener, TcpStream},
        };

        fn read_http_request(mut stream: &TcpStream) -> Option<(String, String, Value)> {
            let mut header = Vec::new();
            let mut buffer = [0_u8; 1];
            while !header.ends_with(b"\r\n\r\n") {
                if stream.read_exact(&mut buffer).is_err() {
                    return None;
                }
                header.push(buffer[0]);
            }
            let header_text = String::from_utf8(header).ok()?;
            let content_length = header_text
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Content-Length:")
                        .or_else(|| line.strip_prefix("content-length:"))
                })
                .map(str::trim)
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            let mut body = vec![0_u8; content_length];
            if stream.read_exact(&mut body).is_err() {
                return None;
            }
            let path = header_text
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("")
                .to_string();
            let authorization = header_text
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Authorization:")
                        .or_else(|| line.strip_prefix("authorization:"))
                })
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            let body = serde_json::from_slice(&body).ok()?;
            Some((path, authorization, body))
        }

        fn write_event_stream(mut stream: TcpStream, body: &str) {
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        }

        fn write_tool_call(stream: TcpStream) {
            let chunk = r#"data: {"id":"chatcmpl-tool-fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_bash_1","type":"function","function":{"name":"bash","arguments":"{\"command\":\"cat /etc/hosts\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-tool-fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]

"#;
            write_event_stream(stream, chunk);
        }

        fn write_chat_completion(stream: TcpStream) {
            let chunk = r#"data: {"id":"chatcmpl-tool-fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}

data: {"id":"chatcmpl-tool-fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#;
            write_event_stream(stream, chunk);
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let captured = Arc::new(Mutex::new(Vec::<(String, String, Value)>::new()));
        let captured_thread = captured.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_thread = stop.clone();
        let tool_call_sent = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let tool_call_sent_thread = tool_call_sent.clone();
        let handle = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(45);
            while !stop_thread.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let should_send_tool = if let Some(request) = read_http_request(&stream) {
                            let body_text = request.2.to_string();
                            let is_title_prompt = body_text.contains("title generator");
                            let is_task_prompt = !is_title_prompt
                                && chat_fixture_body_contains(&request.2, "Use bash");
                            captured_thread.lock().unwrap().push(request);
                            is_task_prompt && !tool_call_sent_thread.swap(true, Ordering::SeqCst)
                        } else {
                            captured_thread.lock().unwrap().push((
                                "<unparsed>".to_string(),
                                String::new(),
                                json!({"_readError": "request header unavailable"}),
                            ));
                            false
                        };
                        if should_send_tool {
                            write_tool_call(stream);
                        } else {
                            write_chat_completion(stream);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(error) => panic!("fixture HTTP server failed: {error}"),
                }
            }
        });
        Self {
            port,
            captured,
            stop,
            handle: Some(handle),
        }
    }

    fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn captured(&self) -> Vec<(String, String, Value)> {
        self.captured.lock().unwrap().clone()
    }
}

impl Drop for ToolCallFixtureServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn chat_fixture_request_summary(captured: &[(String, String, Value)]) -> Vec<Value> {
    captured
        .iter()
        .map(|(path, authorization, body)| {
            json!({
                "path": path,
                "hasFixtureAuthorization": authorization.starts_with("Bearer sk-"),
                "model": body.get("model").cloned().unwrap_or(Value::Null),
                "messages": body.get("messages").cloned().unwrap_or(Value::Null),
                "input": body.get("input").cloned().unwrap_or(Value::Null),
                "prompt": body.get("prompt").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn chat_fixture_body_contains(body: &Value, needle: &str) -> bool {
    body.get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| {
            messages
                .iter()
                .any(|message| message.to_string().contains(needle))
        })
        || body
            .get("input")
            .is_some_and(|input| input.to_string().contains(needle))
        || body
            .get("prompt")
            .is_some_and(|prompt| prompt.to_string().contains(needle))
}

fn wait_for_permission_event(
    router: &RuntimeEventRouter,
    request_id: &str,
    native_session_id: &str,
) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = serde_json::to_value(router.snapshot(None, None).unwrap()).unwrap();
        if let Some(event) = snapshot
            .get("events")
            .and_then(Value::as_array)
            .and_then(|events| {
                events
                    .iter()
                    .find(|event| {
                        event
                            .pointer("/nativeEnvelope/payload/id")
                            .is_some_and(|id| {
                                id.as_str() == Some(request_id)
                                    || request_id
                                        .parse::<i64>()
                                        .is_ok_and(|value| id.as_i64() == Some(value))
                            })
                            && event
                                .pointer("/nativeEnvelope/payload/method")
                                .and_then(Value::as_str)
                                == Some("session/request_permission")
                            && event
                                .pointer("/nativeEnvelope/payload/params/sessionId")
                                .and_then(Value::as_str)
                                == Some(native_session_id)
                    })
                    .cloned()
            })
        {
            return event;
        }
        if std::time::Instant::now() >= deadline {
            panic!("permission event was not routed: {snapshot}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

struct PiCapabilityStopGuard<'a>(&'a crate::pi_capabilities::PiCapabilities);

impl Drop for PiCapabilityStopGuard<'_> {
    fn drop(&mut self) {
        let _ = crate::pi_capabilities::stop_process(self.0);
    }
}

struct OpenCodeAcpStopGuard(OpenCodeAcpRuntime);

impl Drop for OpenCodeAcpStopGuard {
    fn drop(&mut self) {
        let _ = opencode_acp_stop_blocking(self.0.clone());
    }
}

#[test]
fn event_pump_routes_updates_and_permission_before_prompt_finishes() {
    let (_temp, connection) = fixture_connection(
        r#"
import json,sys,time
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_keep","update":{"sessionUpdate":"agent_message_chunk","messageId":"msg_1","content":{"type":"text","text":"streamed"}}}}),flush=True)
print(json.dumps({"jsonrpc":"2.0","id":"agent-permission-1","method":"session/request_permission","params":{"sessionId":"ses_keep","toolCall":{"toolCallId":"call_1","title":"Run tool"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["result"]["outcome"]["optionId"]=="allow-once"
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#,
    );
    let binding = connection.binding.clone();
    let generation = connection.generation;
    let transport = connection.transport.clone();
    let stop = connection.event_pump_stop.clone();
    let handle = Arc::new(Mutex::new(connection));
    let interactions = crate::interaction_registry::InteractionRegistry::default();
    let router =
        RuntimeEventRouter::with_capacity_and_observers(16, None, Some(interactions.clone()));
    start_event_pump(handle, router.clone(), stop.clone()).unwrap();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let prompt = transport.clone();
    thread::spawn(move || {
        sender
            .send(prompt.request_unbounded(
                "session/prompt",
                json!({"sessionId":"ses_keep","prompt":[{"type":"text","text":"go"}]}),
            ))
            .unwrap();
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let snapshot = serde_json::to_value(router.snapshot(None, None).unwrap()).unwrap();
        let saw_update = snapshot["events"].as_array().is_some_and(|events| {
            events.iter().any(|event| {
                event
                    .pointer("/nativeEnvelope/payload/method")
                    .and_then(Value::as_str)
                    == Some("session/update")
            })
        });
        let pending = serde_json::to_value(interactions.snapshots().unwrap()).unwrap();
        let saw_permission = pending.as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["interactionId"] == "agent-permission-1"
                    && item["nativeSessionId"] == "ses_keep"
            })
        });
        if saw_update && saw_permission {
            break;
        }
        if std::time::Instant::now() >= deadline {
            panic!("snapshot={snapshot} pending={pending}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(receiver.try_recv().is_err());
    interactions
        .begin_response(
            binding.clone(),
            generation,
            "agent-permission-1",
            Some("ses_keep"),
        )
        .unwrap();
    transport
        .respond_client_request(
            "agent-permission-1",
            json!({"outcome":"selected","optionId":"allow-once"}),
        )
        .unwrap();
    interactions
        .finish_response(binding, generation, "agent-permission-1", true)
        .unwrap();
    assert_eq!(
        receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()["stopReason"],
        "end_turn"
    );
    stop.store(true, Ordering::Release);
    transport.stop().unwrap();
}

#[test]
fn event_pump_and_status_reads_preserve_native_history_order() {
    let (_temp, connection) = fixture_connection(
        r#"
import json,sys,time
request=json.loads(sys.stdin.readline())
for index in range(64):
    print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_keep","update":{"sessionUpdate":"agent_message_chunk","messageId":"msg_"+str(index),"content":{"type":"text","text":str(index)}}}}),flush=True)
    time.sleep(0.002)
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
for line in sys.stdin: pass
"#,
    );
    let transport = connection.transport.clone();
    let stop = connection.event_pump_stop.clone();
    let handle = Arc::new(Mutex::new(connection));
    let router = RuntimeEventRouter::with_capacity_and_observers(128, None, None);
    start_event_pump(handle.clone(), router.clone(), stop.clone()).unwrap();
    let prompt_transport = transport.clone();
    let prompt = thread::spawn(move || {
        prompt_transport.request_unbounded("session/prompt", json!({"sessionId":"ses_keep"}))
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let events = loop {
        {
            let mut connection = handle.lock().unwrap();
            thread::sleep(Duration::from_millis(3));
            update_events(&mut connection, &router).unwrap();
        }
        let snapshot = serde_json::to_value(router.snapshot(None, None).unwrap()).unwrap();
        let events = snapshot["events"].as_array().unwrap().clone();
        if events.len() == 64 {
            break events;
        }
        assert!(std::time::Instant::now() < deadline);
        thread::sleep(Duration::from_millis(1));
    };
    let texts: Vec<_> = events
        .iter()
        .map(|event| {
            event
                .pointer("/nativeEnvelope/payload/params/update/content/text")
                .and_then(Value::as_str)
                .unwrap()
                .parse::<usize>()
                .unwrap()
        })
        .collect();
    assert_eq!(texts, (0..64).collect::<Vec<_>>());
    prompt.join().unwrap().unwrap();
    stop.store(true, Ordering::Release);
    transport.stop().unwrap();
}

#[test]
fn host_switch_closes_idle_connection_but_preserves_pending_operation() {
    let (_temp, mut connection) = fixture_connection("import sys\nfor line in sys.stdin: pass\n");
    let operation = connection
        .operations
        .begin(
            AcpSessionOperationKind::Load,
            Some("ses_keep".into()),
            None,
            false,
        )
        .unwrap();
    let runtime = OpenCodeAcpRuntime::default();
    let handle = Arc::new(Mutex::new(connection));
    *runtime.state.lock().unwrap() = OpenCodeAcpLifecycle::Running(handle.clone());
    let stop = handle.lock().unwrap().event_pump_stop.clone();
    start_event_pump(handle.clone(), RuntimeEventRouter::default(), stop).unwrap();
    assert!(stop_idle_connection_for_host_switch(&runtime).is_err());
    assert!(handle.lock().unwrap().transport.is_running().unwrap());
    handle
        .lock()
        .unwrap()
        .operations
        .complete(operation)
        .unwrap();
    stop_idle_connection_for_host_switch(&runtime).unwrap();
    assert!(matches!(
        *runtime.state.lock().unwrap(),
        OpenCodeAcpLifecycle::Stopped
    ));
    assert!(!handle.lock().unwrap().transport.is_running().unwrap());
}

#[test]
fn host_recovery_rejects_stale_generation_and_confirms_owned_process_exit() {
    let (_temp, connection) = fixture_connection("import sys\nfor line in sys.stdin: pass\n");
    let binding = connection.binding.clone();
    let cwd = connection.cwd.clone();
    let generation = connection.generation;
    let native = NativeSessionId::parse("ses_keep").unwrap();
    let transport = connection.transport.clone();
    let runtime = OpenCodeAcpRuntime::default();
    runtime.generation.store(generation, Ordering::SeqCst);
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    assert!(
        stop_session_for_host_recovery(&runtime, &binding, &cwd, &native, generation + 1).is_err()
    );
    assert!(transport.is_running().unwrap());
    let stopped =
        stop_session_for_host_recovery(&runtime, &binding, &cwd, &native, generation).unwrap();
    assert!(!stopped.running);
    assert_eq!(stopped.generation, generation + 1);
    assert!(!transport.is_running().unwrap());
    assert_eq!(stopped.session_id.as_deref(), Some("ses_keep"));
    assert_eq!(
        stopped.runtime_connection_id,
        binding.connection_id.as_str()
    );
}

#[test]
fn status_after_process_loss_retains_binding_for_host_recovery() {
    let (_temp, connection) = fixture_connection("import sys\nsys.exit(9)\n");
    let binding = connection.binding.clone();
    let cwd = connection.cwd.clone();
    let generation = connection.generation;
    let transport = connection.transport.clone();
    let runtime = OpenCodeAcpRuntime::default();
    runtime.generation.store(generation, Ordering::SeqCst);
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while transport.is_running().unwrap() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let observed = current_status(&runtime, None).unwrap();
    assert!(!observed.running);
    assert_eq!(
        observed.runtime_connection_id,
        binding.connection_id.as_str()
    );
    assert!(observed.last_error.is_some());
    let native = NativeSessionId::parse("ses_keep").unwrap();
    let stopped =
        stop_session_for_host_recovery(&runtime, &binding, &cwd, &native, generation).unwrap();
    assert!(!stopped.running);
    assert_eq!(stopped.generation, generation + 1);
}

#[test]
fn acp_permission_reply_requires_current_generation_and_replies_once() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("permission-replied");
    let script = temp.path().join("fixture.py");
    std::fs::write(
            &script,
            r#"
import json,sys,pathlib
marker=pathlib.Path("__MARKER__")
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"ses_keep","toolCall":{"toolCallId":"call_1","title":"Run tool"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["id"]==0
assert reply["result"]["outcome"]["outcome"]=="selected"
assert reply["result"]["outcome"]["optionId"]=="allow-once"
marker.write_text("replied")
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#
            .replace("__MARKER__", &marker.to_string_lossy()),
        )
        .unwrap();
    let transport =
        Arc::new(AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap());
    let binding = acp_binding(Path::new("/tmp/opencode")).unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let connection = OpenCodeAcpConnection {
        transport,
        binding,
        generation: 1,
        cwd: workspace.canonicalize().unwrap(),
        binary_path: PathBuf::from("/tmp/opencode"),
        session_id: Some("ses_keep".to_string()),
        agent_name: Some("OpenCode".to_string()),
        agent_version: OPENCODE_ACP_VERSION.to_string(),
        protocol_version: 1,
        question_bridge: false,
        load_session: true,
        config_options: json!([]),
        managed_provider: None,
        private_launch_dir: None,
        last_error: None,
        dropped_events: 0,
        initialized_at_ms: 1,
        operations: AcpSessionOperations::default(),
        event_pump_stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let binding = connection.binding.clone();
    let generation = connection.generation;
    let transport = connection.transport.clone();
    let runtime = OpenCodeAcpRuntime::default();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let (farfold_session_id, _, _) = register_acp_runtime_and_session(
        &store,
        &binding,
        &connection.cwd,
        &connection.binary_path,
        "ses_keep",
    )
    .unwrap();
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    let interactions = crate::interaction_registry::InteractionRegistry::default();
    let router =
        RuntimeEventRouter::with_capacity_and_observers(16, None, Some(interactions.clone()));
    let prompt = transport.clone();
    let marker_arg = marker.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        sender
            .send(prompt.request_unbounded(
                "session/prompt",
                json!({"sessionId":"ses_keep","prompt":[{"type":"text","text":"go"}]}),
            ))
            .unwrap();
        let _ = marker_arg;
    });
    let (events, _) = transport.wait_events(Duration::from_secs(2)).unwrap();
    let permission = events
        .into_iter()
        .find(|event| event["method"] == "session/request_permission")
        .expect("permission request is routed before prompt returns");
    router
        .route(
            binding.clone(),
            json!({"generation": generation, "kind": "acp", "payload": permission}),
        )
        .unwrap();
    let stale = respond_permission_blocking(
        runtime.clone(),
        store.clone(),
        interactions.clone(),
        OpenCodeAcpPermissionResponseInput {
            farfold_session_id: farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
            runtime_generation: generation + 1,
            request_id: "0".to_string(),
            option_id: "allow-once".to_string(),
        },
    )
    .unwrap_err();
    assert!(stale.contains("Runtime generation"));
    assert!(!marker.exists());
    respond_permission_blocking(
        runtime.clone(),
        store,
        interactions.clone(),
        OpenCodeAcpPermissionResponseInput {
            farfold_session_id,
            native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
            runtime_generation: generation,
            request_id: "0".to_string(),
            option_id: "allow-once".to_string(),
        },
    )
    .unwrap();
    assert_eq!(
        receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()["stopReason"],
        "end_turn"
    );
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "replied");
    let repeated = interactions.begin_response(binding, generation, "0", Some("ses_keep"));
    assert!(repeated.is_err());
    let _ = opencode_acp_stop_blocking(runtime);
}

#[test]
fn acp_permission_reject_uses_the_native_option_id() {
    let (temp, mut connection) = fixture_connection(
        r#"
import json,sys
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":"agent-permission-1","method":"session/request_permission","params":{"sessionId":"ses_keep","toolCall":{"toolCallId":"call_1","title":"Run tool"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["id"]=="agent-permission-1"
assert reply["result"]["outcome"]["outcome"]=="selected"
assert reply["result"]["outcome"]["optionId"]=="reject-once"
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#,
    );
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    connection.cwd = workspace.canonicalize().unwrap();
    let binding = connection.binding.clone();
    let generation = connection.generation;
    let transport = connection.transport.clone();
    let runtime = OpenCodeAcpRuntime::default();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let (farfold_session_id, _, _) = register_acp_runtime_and_session(
        &store,
        &binding,
        &workspace.canonicalize().unwrap(),
        &connection.binary_path,
        "ses_keep",
    )
    .unwrap();
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    let interactions = crate::interaction_registry::InteractionRegistry::default();
    let router =
        RuntimeEventRouter::with_capacity_and_observers(16, None, Some(interactions.clone()));
    let prompt = transport.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        sender
            .send(prompt.request_unbounded(
                "session/prompt",
                json!({"sessionId":"ses_keep","prompt":[{"type":"text","text":"go"}]}),
            ))
            .unwrap();
    });
    let (events, _) = transport.wait_events(Duration::from_secs(2)).unwrap();
    let permission = events
        .into_iter()
        .find(|event| event["method"] == "session/request_permission")
        .expect("permission request is routed before prompt returns");
    router
        .route(
            binding,
            json!({"generation": generation, "kind": "acp", "payload": permission}),
        )
        .unwrap();
    respond_permission_blocking(
        runtime.clone(),
        store,
        interactions,
        OpenCodeAcpPermissionResponseInput {
            farfold_session_id,
            native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
            runtime_generation: generation,
            request_id: "agent-permission-1".to_string(),
            option_id: "reject-once".to_string(),
        },
    )
    .unwrap();
    assert_eq!(
        receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()["stopReason"],
        "end_turn"
    );
    let _ = opencode_acp_stop_blocking(runtime);
}

#[test]
fn config_option_updates_apply_only_to_current_native_session() {
    let (_temp, mut connection) = fixture_connection(
        r#"
import json,sys
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_old","update":{"sessionUpdate":"config_option_update","configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"old","options":[{"value":"old","name":"Old"}]}]}}}),flush=True)
print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_keep","update":{"sessionUpdate":"config_option_update","configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"current","options":[{"value":"current","name":"Current"}]}]}}}),flush=True)
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"ok":True}}),flush=True)
"#,
    );
    connection.config_options = json!([
        {"id":"model","name":"Model","type":"select","currentValue":"initial","options":[{"value":"initial","name":"Initial"}]}
    ]);
    let router = RuntimeEventRouter::default();
    assert_eq!(
        connection
            .transport
            .request_timeout("initialize", json!({}), Duration::from_secs(2))
            .unwrap()["ok"],
        true
    );
    update_events(&mut connection, &router).unwrap();
    assert_eq!(connection.config_options[0]["currentValue"], "current");
}

#[test]
fn late_config_option_response_cannot_overwrite_newer_selection() {
    let (_temp, mut connection) = fixture_connection(
        r#"
import json,sys,time
first=json.loads(sys.stdin.readline())
second=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":second["id"],"result":{"configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"new","options":[{"value":"new","name":"New"}]}]}}),flush=True)
time.sleep(0.05)
print(json.dumps({"jsonrpc":"2.0","id":first["id"],"result":{"configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"old","options":[{"value":"old","name":"Old"}]}]}}),flush=True)
"#,
    );
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    connection.cwd = workspace.canonicalize().unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let (farfold_session_id, _, _) = register_acp_runtime_and_session(
        &store,
        &connection.binding,
        &connection.cwd,
        &connection.binary_path,
        "ses_keep",
    )
    .unwrap();
    let runtime = OpenCodeAcpRuntime::default();
    let handle = Arc::new(Mutex::new(connection));
    *runtime.state.lock().unwrap() = OpenCodeAcpLifecycle::Running(handle);
    let turns = crate::turn_coordinator::TurnCoordinator::default();
    let first_runtime = runtime.clone();
    let first_store = store.clone();
    let first_turns = turns.clone();
    let first_session = farfold_session_id.clone();
    let first = thread::spawn(move || {
        set_config_option_blocking(
            first_runtime,
            first_store,
            first_turns,
            OpenCodeAcpSetConfigOptionInput {
                farfold_session_id: first_session,
                native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                config_id: "model".to_string(),
                value: json!("old"),
                value_type: None,
            },
        )
    });
    std::thread::sleep(Duration::from_millis(20));
    let second = set_config_option_blocking(
        runtime.clone(),
        store,
        turns,
        OpenCodeAcpSetConfigOptionInput {
            farfold_session_id,
            native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
            config_id: "model".to_string(),
            value: json!("new"),
            value_type: None,
        },
    )
    .unwrap();
    assert_eq!(second.config_options[0]["currentValue"], "new");
    let stale = first.join().unwrap().unwrap_err();
    assert!(stale.contains("晚到结果已丢弃"));
    let status = current_status(&runtime, None).unwrap();
    assert_eq!(status.config_options[0]["currentValue"], "new");
    let _ = opencode_acp_stop_blocking(runtime);
}

#[test]
fn config_option_change_is_rejected_while_session_has_active_turn() {
    let (_temp, mut connection) = fixture_connection(
        r#"
import sys
for _ in sys.stdin:
    pass
"#,
    );
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    connection.cwd = workspace.canonicalize().unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let binding = connection.binding.clone();
    let (farfold_session_id, _, _) = register_acp_runtime_and_session(
        &store,
        &binding,
        &connection.cwd,
        &connection.binary_path,
        "ses_keep",
    )
    .unwrap();
    let target = store.session_open_target(&farfold_session_id).unwrap();
    let generation = connection.generation;
    let transport = connection.transport.clone();
    let runtime = OpenCodeAcpRuntime::default();
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    let turns = crate::turn_coordinator::TurnCoordinator::default();
    turns
        .admit(crate::turn_coordinator::TurnAdmissionRequest {
            farfold_session_id: farfold_session_id.clone(),
            working_copy_id: target.working_copy_id.clone(),
            runtime_product_id: target.runtime_product_id.clone(),
            installation_id: target.installation_id.clone(),
            runtime_connection_id: target.connection_id.clone(),
            native_session_id: target.native_session_id.clone(),
            runtime_generation: generation,
            started_at: 1,
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
            provider_binding_authority: TurnProviderBindingAuthority::CurrentAppliedProjection,
        })
        .unwrap();
    let error = set_config_option_blocking(
        runtime.clone(),
        store,
        turns,
        OpenCodeAcpSetConfigOptionInput {
            farfold_session_id,
            native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
            config_id: "model".to_string(),
            value: json!("new"),
            value_type: None,
        },
    )
    .unwrap_err();
    assert!(error.contains("空闲"));
    assert!(transport.drain_events().unwrap().0.is_empty());
    let _ = opencode_acp_stop_blocking(runtime);
}

#[test]
fn failed_close_keeps_the_bound_session_identity() {
    let (_temp, connection) = fixture_connection(
        r#"
import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"no"}}),flush=True)
"#,
    );
    let runtime = OpenCodeAcpRuntime::default();
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    let router = RuntimeEventRouter::default();
    let error = opencode_acp_close_session_blocking(runtime.clone(), router.clone()).unwrap_err();
    assert!(error.contains("错误码"));
    let status = opencode_acp_status_blocking(runtime, router).unwrap();
    assert_eq!(status.session_id.as_deref(), Some("ses_keep"));
    assert!(status.last_error.unwrap().contains("错误码"));
}

#[test]
fn active_session_blocks_new_or_load_until_close_is_confirmed() {
    let (_temp, connection) = fixture_connection(
        r#"
import time
time.sleep(60)
"#,
    );
    let runtime = OpenCodeAcpRuntime::default();
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    let router = RuntimeEventRouter::default();
    let new_error =
        opencode_acp_new_session_blocking(runtime.clone(), router.clone(), None).unwrap_err();
    assert!(new_error.contains("已绑定 Session"));
    let load_error = opencode_acp_load_session_blocking(
        runtime,
        router,
        None,
        OpenCodeAcpLoadInput {
            session_id: "ses_other".to_string(),
        },
    )
    .unwrap_err();
    assert!(load_error.contains("已绑定 Session"));
}

#[test]
fn managed_provider_private_config_is_confirmed_before_projection() {
    let temp = tempfile::tempdir().unwrap();
    let app_data = temp.path().join("app-data");
    let acp_root = temp.path().join("managed-acp-root");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&app_data).unwrap();
    std::fs::create_dir(&acp_root).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let saved = crate::managed_provider::save_api_key_in_dir(
        &app_data,
        Some(&store),
        crate::managed_provider::ManagedProviderApiKeySaveInput {
            provider_key: "openai".to_string(),
            label: "OpenAI Fixture".to_string(),
            account_label: "work".to_string(),
            endpoint: "https://fixture.example.invalid/v1".to_string(),
            api_kind: "openai-chat-completions".to_string(),
            api_key: "sk-fixture-managed".to_string(),
            model_id: "gpt-fixture".to_string(),
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            reasoning: Some(false),
            image_input: Some(false),
            supports_developer_role: Some(true),
            supports_reasoning_effort: Some(false),
        },
    )
    .unwrap();
    let input = OpenCodeAcpManagedSessionInput {
        binary_path: PathBuf::from("/tmp/opencode"),
        cwd: workspace.clone(),
        provider_connection_id: saved.provider_connection_id.clone(),
        provider_config_version_id: saved.current_config_version_id.clone(),
        operation_id: "managed-acp-test".to_string(),
    };
    let binding = managed_acp_binding(
        Path::new("/tmp/opencode"),
        &saved.provider_connection_id,
        &saved.current_config_version_id,
    )
    .unwrap();
    let prepared = prepare_managed_acp_provider(
        &app_data,
        &acp_root,
        "managed-acp-test",
        &binding,
        &store,
        &input,
        true,
    )
    .expect("managed ACP config is prepared from committed Host version");
    let config = std::fs::read_to_string(
        prepared
            .config_root
            .join("xdg-config")
            .join("opencode")
            .join("opencode.json"),
    )
    .unwrap();
    assert!(config.contains("https://fixture.example.invalid/v1"));
    assert!(config.contains("sk-fixture-managed"));
    assert!(config.contains(prepared.binding.provider_connection_id.as_str()));

    let (_fixture, mut connection) = fixture_connection(
        r#"
import time
time.sleep(60)
"#,
    );
    connection.cwd = workspace.canonicalize().unwrap();
    connection.managed_provider = Some(prepared.binding.clone());
    let router = RuntimeEventRouter::default();
    let result = session_result_from_response(
        &mut connection,
        json!({
            "sessionId": "ses_managed",
            "configOptions": [{
                "id": "model",
                "name": "Model",
                "type": "select",
                "currentValue": prepared.binding.runtime_model_id,
                "options": [{
                    "value": prepared.binding.runtime_model_id,
                    "name": "GPT Fixture"
                }]
            }]
        }),
        None,
        &router,
        Some(&store),
        true,
    )
    .unwrap();
    assert_eq!(result.session_id, "ses_managed");
    assert_eq!(
        result
            .status
            .managed_provider
            .unwrap()
            .provider_config_version_id,
        saved.current_config_version_id
    );
    let projection = serde_json::to_value(
        store
            .provider_projection_snapshot(&saved.provider_connection_id)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(projection["projections"][0]["applyState"], "applied");
    assert_eq!(
        projection["projections"][0]["runtimeProviderId"],
        saved.provider_connection_id.as_str()
    );
    assert_eq!(
        projection["projections"][0]["runtimeModelId"],
        prepared.binding.runtime_model_id
    );
}

#[test]
fn managed_provider_projection_requires_native_config_option_confirmation() {
    let temp = tempfile::tempdir().unwrap();
    let app_data = temp.path().join("app-data");
    let acp_root = temp.path().join("managed-acp-root");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&app_data).unwrap();
    std::fs::create_dir(&acp_root).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let saved = crate::managed_provider::save_api_key_in_dir(
        &app_data,
        Some(&store),
        crate::managed_provider::ManagedProviderApiKeySaveInput {
            provider_key: "openai".to_string(),
            label: "OpenAI Fixture".to_string(),
            account_label: "work".to_string(),
            endpoint: "https://fixture.example.invalid/v1".to_string(),
            api_kind: "openai-chat-completions".to_string(),
            api_key: "sk-fixture-managed".to_string(),
            model_id: "gpt-fixture".to_string(),
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            reasoning: Some(false),
            image_input: Some(false),
            supports_developer_role: Some(true),
            supports_reasoning_effort: Some(false),
        },
    )
    .unwrap();
    let input = OpenCodeAcpManagedSessionInput {
        binary_path: PathBuf::from("/tmp/opencode"),
        cwd: workspace.clone(),
        provider_connection_id: saved.provider_connection_id.clone(),
        provider_config_version_id: saved.current_config_version_id.clone(),
        operation_id: "managed-acp-mismatch-test".to_string(),
    };
    let binding = managed_acp_binding(
        Path::new("/tmp/opencode"),
        &saved.provider_connection_id,
        &saved.current_config_version_id,
    )
    .unwrap();
    let prepared = prepare_managed_acp_provider(
        &app_data,
        &acp_root,
        "managed-acp-mismatch-test",
        &binding,
        &store,
        &input,
        true,
    )
    .unwrap();
    let (_fixture, mut connection) = fixture_connection(
        r#"
import time
time.sleep(60)
"#,
    );
    connection.cwd = workspace.canonicalize().unwrap();
    connection.managed_provider = Some(prepared.binding);
    let error = session_result_from_response(
        &mut connection,
        json!({
            "sessionId": "ses_wrong",
            "configOptions": [{
                "id": "model",
                "name": "Model",
                "type": "select",
                "currentValue": "other/model",
                "options": [{"value": "other/model", "name": "Other"}]
            }]
        }),
        None,
        &RuntimeEventRouter::default(),
        Some(&store),
        true,
    )
    .unwrap_err();
    assert!(error.contains("did not confirm"));
    assert!(
        store
            .provider_projection_snapshot(&saved.provider_connection_id)
            .unwrap()
            .projections
            .is_empty()
    );
}

#[test]
fn managed_provider_private_configs_do_not_cross_accounts_or_endpoints() {
    let temp = tempfile::tempdir().unwrap();
    let app_data = temp.path().join("app-data");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&app_data).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let save = |account_label: &str, endpoint: &str, api_key: &str, model_id: &str| {
        crate::managed_provider::save_api_key_in_dir(
            &app_data,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: format!("OpenAI {account_label}"),
                account_label: account_label.to_string(),
                endpoint: endpoint.to_string(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: api_key.to_string(),
                model_id: model_id.to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap()
    };
    let first = save(
        "work",
        "https://work.example.invalid/v1",
        "sk-work",
        "gpt-work",
    );
    let second = save(
        "personal",
        "https://personal.example.invalid/v1",
        "sk-personal",
        "gpt-personal",
    );
    assert_ne!(first.provider_connection_id, second.provider_connection_id);

    let prepare = |saved: &crate::managed_provider::ManagedProviderApiKeySaveResult,
                   operation_id: &str| {
        let acp_root = temp.path().join(format!("{operation_id}-root"));
        std::fs::create_dir(&acp_root).unwrap();
        let binding = managed_acp_binding(
            Path::new("/tmp/opencode"),
            &saved.provider_connection_id,
            &saved.current_config_version_id,
        )
        .unwrap();
        let prepared = prepare_managed_acp_provider(
            &app_data,
            &acp_root,
            operation_id,
            &binding,
            &store,
            &OpenCodeAcpManagedSessionInput {
                binary_path: PathBuf::from("/tmp/opencode"),
                cwd: workspace.clone(),
                provider_connection_id: saved.provider_connection_id.clone(),
                provider_config_version_id: saved.current_config_version_id.clone(),
                operation_id: operation_id.to_string(),
            },
            true,
        )
        .unwrap();
        let config = std::fs::read_to_string(
            prepared
                .config_root
                .join("xdg-config")
                .join("opencode")
                .join("opencode.json"),
        )
        .unwrap();
        (prepared, config)
    };
    let (first_prepared, first_config) = prepare(&first, "managed-acp-work");
    let (second_prepared, second_config) = prepare(&second, "managed-acp-personal");

    assert!(first_config.contains("https://work.example.invalid/v1"));
    assert!(first_config.contains("sk-work"));
    assert!(first_config.contains(first.provider_connection_id.as_str()));
    assert!(!first_config.contains("https://personal.example.invalid/v1"));
    assert!(!first_config.contains("sk-personal"));
    assert!(!first_config.contains(second.provider_connection_id.as_str()));
    assert!(second_config.contains("https://personal.example.invalid/v1"));
    assert!(second_config.contains("sk-personal"));
    assert!(second_config.contains(second.provider_connection_id.as_str()));
    assert!(!second_config.contains("https://work.example.invalid/v1"));
    assert!(!second_config.contains("sk-work"));
    assert!(!second_config.contains(first.provider_connection_id.as_str()));
    assert_ne!(
        first_prepared.binding.runtime_model_id,
        second_prepared.binding.runtime_model_id
    );
}

#[test]
fn product_stop_cleans_only_private_config_not_persistent_profile() {
    let (_temp, mut connection) = fixture_connection(
        r#"
pass
"#,
    );
    let temp = tempfile::tempdir().unwrap();
    let profile_root = temp.path().join("profile");
    let config_root = temp.path().join("config-launch");
    std::fs::create_dir(&profile_root).unwrap();
    std::fs::create_dir(&config_root).unwrap();
    std::fs::write(profile_root.join("native-session.sqlite3"), b"session").unwrap();
    std::fs::write(config_root.join("opencode.json"), b"{}").unwrap();
    connection.private_launch_dir = Some(config_root.clone());
    connection.transport.mark_eof_shutdown_requested_for_test();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while connection.transport.is_running().unwrap() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    let runtime = OpenCodeAcpRuntime::default();
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));

    let stopped = opencode_acp_stop_blocking(runtime).unwrap();

    assert_eq!(stopped.state, "stopped");
    assert!(!config_root.exists());
    assert_eq!(
        std::fs::read(profile_root.join("native-session.sqlite3")).unwrap(),
        b"session"
    );
}

#[test]
fn managed_acp_runtime_target_keeps_old_version_after_provider_update() {
    let temp = tempfile::tempdir().unwrap();
    let app_data = temp.path().join("app-data");
    let acp_root = temp.path().join("acp-root");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&app_data).unwrap();
    std::fs::create_dir(&acp_root).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let first = crate::managed_provider::save_api_key_in_dir(
        &app_data,
        Some(&store),
        crate::managed_provider::ManagedProviderApiKeySaveInput {
            provider_key: "openai".to_string(),
            label: "OpenAI Fixture".to_string(),
            account_label: "work".to_string(),
            endpoint: "https://fixture.example.invalid/v1".to_string(),
            api_kind: "openai-chat-completions".to_string(),
            api_key: "sk-first".to_string(),
            model_id: "gpt-first".to_string(),
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            reasoning: Some(false),
            image_input: Some(false),
            supports_developer_role: Some(true),
            supports_reasoning_effort: Some(false),
        },
    )
    .unwrap();
    let first_binding = managed_acp_binding(
        Path::new("/tmp/opencode"),
        &first.provider_connection_id,
        &first.current_config_version_id,
    )
    .unwrap();
    let first_input = OpenCodeAcpManagedSessionInput {
        binary_path: PathBuf::from("/tmp/opencode"),
        cwd: workspace.clone(),
        provider_connection_id: first.provider_connection_id.clone(),
        provider_config_version_id: first.current_config_version_id.clone(),
        operation_id: "old-version".to_string(),
    };
    let first_prepared = prepare_managed_acp_provider(
        &app_data,
        &acp_root,
        "old-version",
        &first_binding,
        &store,
        &first_input,
        true,
    )
    .unwrap();
    let (_fixture, mut first_connection) = fixture_connection(
        r#"
import time
time.sleep(60)
"#,
    );
    first_connection.binding = first_binding.clone();
    first_connection.cwd = workspace.canonicalize().unwrap();
    first_connection.managed_provider = Some(first_prepared.binding.clone());
    session_result_from_response(
        &mut first_connection,
        json!({
            "sessionId": "ses_old_version",
            "configOptions": [{
                "id": "model",
                "name": "Model",
                "type": "select",
                "currentValue": first_prepared.binding.runtime_model_id,
                "options": [{"value": first_prepared.binding.runtime_model_id, "name": "First"}]
            }]
        }),
        None,
        &RuntimeEventRouter::default(),
        Some(&store),
        true,
    )
    .unwrap();

    let second = crate::managed_provider::save_api_key_in_dir(
        &app_data,
        Some(&store),
        crate::managed_provider::ManagedProviderApiKeySaveInput {
            provider_key: "openai".to_string(),
            label: "OpenAI Fixture".to_string(),
            account_label: "work".to_string(),
            endpoint: "https://fixture.example.invalid/v1".to_string(),
            api_kind: "openai-chat-completions".to_string(),
            api_key: "sk-second".to_string(),
            model_id: "gpt-second".to_string(),
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            reasoning: Some(false),
            image_input: Some(false),
            supports_developer_role: Some(true),
            supports_reasoning_effort: Some(false),
        },
    )
    .unwrap();
    let second_binding = managed_acp_binding(
        Path::new("/tmp/opencode"),
        &second.provider_connection_id,
        &second.current_config_version_id,
    )
    .unwrap();
    assert_ne!(first_binding.connection_id, second_binding.connection_id);

    let old_target = managed_provider_for_runtime_target(&store, &first_binding)
        .unwrap()
        .unwrap();
    assert_eq!(
        old_target.provider_config_version_id,
        first.current_config_version_id
    );
    assert!(old_target.runtime_model_id.ends_with("/gpt-first"));
    let restore_input = OpenCodeAcpManagedSessionInput {
        binary_path: PathBuf::from("/tmp/opencode"),
        cwd: workspace.clone(),
        provider_connection_id: first.provider_connection_id.clone(),
        provider_config_version_id: old_target.provider_config_version_id.clone(),
        operation_id: "restore-old-version".to_string(),
    };
    let restored = prepare_managed_acp_provider(
        &app_data,
        &acp_root,
        "restore-old-version",
        &first_binding,
        &store,
        &restore_input,
        false,
    )
    .unwrap();
    assert!(restored.binding.runtime_model_id.ends_with("/gpt-first"));
    let (_fixture, mut restored_connection) = fixture_connection(
        r#"
import time
time.sleep(60)
"#,
    );
    restored_connection.binding = first_binding;
    restored_connection.cwd = workspace.canonicalize().unwrap();
    restored_connection.managed_provider = Some(restored.binding.clone());
    let loaded = session_result_from_response(
        &mut restored_connection,
        json!({
            "configOptions": [{
                "id": "model",
                "name": "Model",
                "type": "select",
                "currentValue": restored.binding.runtime_model_id,
                "options": [{"value": restored.binding.runtime_model_id, "name": "First"}]
            }]
        }),
        Some("ses_old_version".to_string()),
        &RuntimeEventRouter::default(),
        None,
        false,
    )
    .unwrap();
    assert_eq!(loaded.session_id, "ses_old_version");
    let after_restore = store
        .provider_projection_snapshot(&first.provider_connection_id)
        .unwrap();
    assert_eq!(
        after_restore.connection.current_config_version_id,
        second.current_config_version_id
    );
    assert_eq!(
        after_restore.projections[0].config_version_id,
        second.current_config_version_id
    );
    assert_eq!(
        after_restore.projections[0].apply_state,
        ProviderApplyState::Pending
    );
}

#[test]
fn acp_prompt_completion_and_cancel_use_official_session_methods() {
    let (_temp, connection) = fixture_connection(
        r#"
import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if request["method"]=="session/prompt":
        assert request["params"]["sessionId"]=="ses_keep"
        assert request["params"]["prompt"][0]["text"]=="hello acp"
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_keep","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}}),flush=True)
        print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
    elif request["method"]=="session/cancel":
        assert request["params"]["sessionId"]=="ses_keep"
        break
"#,
    );
    let runtime = OpenCodeAcpRuntime::default();
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    let native = NativeSessionId::parse("ses_keep").unwrap();
    let result = prompt_text(&runtime, &native, "hello acp").unwrap();
    assert_eq!(result["stopReason"], "end_turn");
    cancel_session(&runtime, &native).unwrap();
    let handle = running_connection(&runtime).unwrap();
    let transport = handle.lock().unwrap().transport.clone();
    let (events, _) = transport.drain_events().unwrap();
    assert_eq!(events[0]["method"], "session/update");
}

#[test]
fn idle_host_stop_rejects_stale_generation_before_stopping_owned_connection() {
    let (_temp, connection) = fixture_connection("import sys\nfor line in sys.stdin: pass\n");
    let binding = connection.binding.clone();
    let cwd = connection.cwd.clone();
    let generation = connection.generation;
    let native = NativeSessionId::parse("ses_keep").unwrap();
    let runtime = OpenCodeAcpRuntime::default();
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    assert!(stop_idle_host_session(&runtime, &binding, &cwd, &native, generation + 1).is_err());
    assert!(
        running_connection(&runtime)
            .unwrap()
            .lock()
            .unwrap()
            .transport
            .is_running()
            .unwrap()
    );
    let stopped = stop_idle_host_session(&runtime, &binding, &cwd, &native, generation).unwrap();
    assert!(!stopped.running);
    assert!(running_connection(&runtime).is_err());
}

#[test]
fn host_acp_submit_treats_confirmed_cancelled_prompt_as_terminal_not_accepted() {
    let (temp, mut connection) = fixture_connection(
        r#"
import json,sys
first=json.loads(sys.stdin.readline())
assert first["method"]=="session/prompt"
print(json.dumps({"jsonrpc":"2.0","id":first["id"],"result":{"stopReason":"cancelled"}}),flush=True)
second=json.loads(sys.stdin.readline())
assert second["method"]=="session/prompt"
print(json.dumps({"jsonrpc":"2.0","id":second["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#,
    );
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    connection.cwd = workspace.canonicalize().unwrap();
    let binding = connection.binding.clone();
    let runtime = OpenCodeAcpRuntime::default();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let (farfold_session_id, _, _) = register_acp_runtime_and_session(
        &store,
        &binding,
        &connection.cwd,
        &connection.binary_path,
        "ses_keep",
    )
    .unwrap();
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    let controller = Arc::new(crate::session_controller::HostSessionController::default());
    let coordinator = crate::turn_coordinator::TurnCoordinator::default();
    coordinator.attach_host_store(store.clone()).unwrap();
    let submission = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
        &controller,
        &store,
        &runtime,
        &coordinator,
        crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
            farfold_session_id: farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
            text: "cancel me".to_string(),
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
        },
    )
    .unwrap();
    match submission {
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Cancelled { detail } => {
            assert!(detail.contains("已取消"));
        }
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { .. } => {
            panic!("cancelled prompt must not be accepted");
        }
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Unknown { detail }
        | crate::turn_coordinator::HostOpenCodeTurnSubmission::Failed { detail } => {
            panic!("confirmed cancellation must release Host Turn, got unknown: {detail}");
        }
    }
    let snapshot = serde_json::to_value(coordinator.snapshot().unwrap()).unwrap();
    assert_eq!(snapshot["activeTurns"].as_array().unwrap().len(), 0);
    let second = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
        &controller,
        &store,
        &runtime,
        &coordinator,
        crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
            farfold_session_id,
            native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
            text: "next turn".to_string(),
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
        },
    )
    .unwrap();
    assert!(matches!(
        second,
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { .. }
    ));
    let database = rusqlite::Connection::open_with_flags(
        temp.path().join("host.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let completed: i64 = database.query_row(
                "SELECT COUNT(*) FROM turn_change_reviews WHERE completed_at IS NOT NULL AND terminal_reason = 'working_copy_not_managed'",
                [], |row| row.get(0),
            ).unwrap();
    assert_eq!(
        completed, 2,
        "both ACP terminal paths must finish their captured review"
    );
    let snapshot = serde_json::to_value(coordinator.snapshot().unwrap()).unwrap();
    assert_eq!(snapshot["activeTurns"].as_array().unwrap().len(), 0);
    let _ = opencode_acp_stop_blocking(runtime);
}

#[test]
fn host_acp_abort_cancels_pending_permission_and_allows_next_turn() {
    let (temp, mut connection) = fixture_connection(
        r#"
import json,sys
first=json.loads(sys.stdin.readline())
assert first["method"]=="session/prompt"
print(json.dumps({"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"ses_keep","toolCall":{"toolCallId":"call_1","title":"Run tool"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["id"]==0
assert reply["result"]["outcome"]["outcome"]=="cancelled"
cancel=json.loads(sys.stdin.readline())
assert cancel["method"]=="session/cancel"
assert cancel["params"]["sessionId"]=="ses_keep"
print(json.dumps({"jsonrpc":"2.0","id":first["id"],"result":{"stopReason":"cancelled"}}),flush=True)
second=json.loads(sys.stdin.readline())
assert second["method"]=="session/prompt"
print(json.dumps({"jsonrpc":"2.0","id":second["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#,
    );
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    connection.cwd = workspace.canonicalize().unwrap();
    let binding = connection.binding.clone();
    let generation = connection.generation;
    let transport = connection.transport.clone();
    let stop = connection.event_pump_stop.clone();
    let handle = Arc::new(Mutex::new(connection));
    let runtime = OpenCodeAcpRuntime::default();
    *runtime.state.lock().unwrap() = OpenCodeAcpLifecycle::Running(handle.clone());
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let (farfold_session_id, _, _) = register_acp_runtime_and_session(
        &store,
        &binding,
        &workspace.canonicalize().unwrap(),
        Path::new("/tmp/opencode"),
        "ses_keep",
    )
    .unwrap();
    let interactions = crate::interaction_registry::InteractionRegistry::default();
    let router =
        RuntimeEventRouter::with_capacity_and_observers(16, None, Some(interactions.clone()));
    start_event_pump(handle, router, stop.clone()).unwrap();
    let controller = Arc::new(crate::session_controller::HostSessionController::default());
    let coordinator = crate::turn_coordinator::TurnCoordinator::default();
    let submit_runtime = runtime.clone();
    let submit_store = store.clone();
    let submit_controller = controller.clone();
    let submit_coordinator = coordinator.clone();
    let submit_session_id = farfold_session_id.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        sender
            .send(
                crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
                    &submit_controller,
                    &submit_store,
                    &submit_runtime,
                    &submit_coordinator,
                    crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                        farfold_session_id: submit_session_id,
                        native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                        text: "needs permission".to_string(),
                        provider_connection_id: None,
                        provider_config_version_id: None,
                        runtime_provider_id: None,
                        runtime_model_id: None,
                    },
                ),
            )
            .unwrap();
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let pending = serde_json::to_value(interactions.snapshots().unwrap()).unwrap();
        if pending.as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["interactionId"] == "0"
                    && item["runtimeGeneration"] == generation
                    && item["nativeSessionId"] == "ses_keep"
            })
        }) {
            break;
        }
        if std::time::Instant::now() >= deadline {
            panic!("permission was not registered");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    crate::turn_coordinator::host_opencode_acp_turn_abort_blocking(
        &controller,
        &store,
        &runtime,
        &interactions,
        &coordinator,
        crate::turn_coordinator::HostOpenCodeAcpTurnAbortInput {
            farfold_session_id: farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
        },
    )
    .unwrap();
    let cancelled = receiver
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    assert!(matches!(
        cancelled,
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Cancelled { .. }
    ));
    assert!(interactions.snapshots().unwrap().is_empty());
    let second = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
        &controller,
        &store,
        &runtime,
        &coordinator,
        crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
            farfold_session_id,
            native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
            text: "next turn".to_string(),
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
        },
    )
    .unwrap();
    assert!(matches!(
        second,
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { .. }
    ));
    stop.store(true, Ordering::Release);
    transport.stop().unwrap();
}

#[test]
fn acp_prompt_disconnect_keeps_result_unknown() {
    let (_temp, connection) = fixture_connection(
        r#"
import json,sys
json.loads(sys.stdin.readline())
sys.exit(0)
"#,
    );
    let runtime = OpenCodeAcpRuntime::default();
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    let native = NativeSessionId::parse("ses_keep").unwrap();
    let result = prompt_text(&runtime, &native, "hello acp");
    assert!(matches!(
        result,
        Err(AcpDispatchError::Unknown(_) | AcpDispatchError::NotSent(_))
    ));
}

#[test]
#[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
fn fixed_opencode_acp_program_can_initialize_create_load_and_close_without_model_turn() {
    let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
        .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
    let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let cwd = temp.path().join("workspace");
    std::fs::create_dir(&cwd).unwrap();
    let home = temp.path().join("home");
    let data = temp.path().join("data");
    std::fs::create_dir(&home).unwrap();
    std::fs::create_dir(&data).unwrap();
    let mut command = Command::new(&binary);
    command
        .arg("acp")
        .arg("--pure")
        .arg("--cwd")
        .arg(&cwd)
        .current_dir(&cwd)
        .env_clear()
        .env("HOME", &home)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("OPENCODE_CONFIG_DIR", data.join("config"))
        .env("XDG_CONFIG_HOME", data.join("xdg-config"))
        .env("XDG_DATA_HOME", data.join("xdg-data"))
        .env("XDG_CACHE_HOME", data.join("xdg-cache"))
        .env("XDG_STATE_HOME", data.join("xdg-state"));
    let transport = AcpTransport::spawn(&mut command).unwrap();
    let initialize = transport
        .request_timeout(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {}}),
            Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(initialize["protocolVersion"], 1);
    assert_eq!(initialize["agentInfo"]["version"], OPENCODE_ACP_VERSION);
    assert_eq!(initialize["agentCapabilities"]["loadSession"], true);
    let created = transport
        .request_timeout(
            "session/new",
            json!({"cwd": cwd.clone(), "mcpServers": []}),
            Duration::from_secs(10),
        )
        .unwrap();
    let session_id = created["sessionId"].as_str().unwrap().to_string();
    assert!(!session_id.is_empty());
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let binding = acp_binding(&binary).unwrap();
    let (farfold_session_id, _, navigation) =
        register_acp_runtime_and_session(&store, &binding, &cwd, &binary, &session_id).unwrap();
    assert_eq!(
        verified_saved_acp_binding(&store, &binding).unwrap(),
        binary
    );
    assert_eq!(
        serde_json::to_value(navigation.restore_state.unwrap()).unwrap()["lastSessionId"],
        farfold_session_id.as_str()
    );
    let loaded = transport
        .request_timeout(
            "session/load",
            json!({"cwd": cwd.clone(), "sessionId": session_id, "mcpServers": []}),
            Duration::from_secs(10),
        )
        .unwrap();
    assert!(loaded["configOptions"].is_array());
    transport
        .request_timeout(
            "session/close",
            json!({"sessionId": created["sessionId"].as_str().unwrap()}),
            Duration::from_secs(10),
        )
        .unwrap();
    transport.stop().unwrap();
    assert!(!transport.is_running().unwrap());
}

#[test]
#[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
fn fixed_opencode_acp_program_reads_managed_private_config_without_model_turn() {
    let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
        .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
    let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let app_data = temp.path().join("app-data");
    let launch_root = temp.path().join("launch");
    let cwd = temp.path().join("workspace");
    std::fs::create_dir(&app_data).unwrap();
    std::fs::create_dir(&launch_root).unwrap();
    std::fs::create_dir(&cwd).unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let saved = crate::managed_provider::save_api_key_in_dir(
        &app_data,
        Some(&store),
        crate::managed_provider::ManagedProviderApiKeySaveInput {
            provider_key: "openai".to_string(),
            label: "OpenAI Fixture".to_string(),
            account_label: "fixture".to_string(),
            endpoint: "https://fixture.example.invalid/v1".to_string(),
            api_kind: "openai-chat-completions".to_string(),
            api_key: "sk-fixture-do-not-send".to_string(),
            model_id: "gpt-fixture".to_string(),
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            reasoning: Some(false),
            image_input: Some(false),
            supports_developer_role: Some(true),
            supports_reasoning_effort: Some(false),
        },
    )
    .unwrap();
    let input = OpenCodeAcpManagedSessionInput {
        binary_path: binary.clone(),
        cwd: cwd.clone(),
        provider_connection_id: saved.provider_connection_id,
        provider_config_version_id: saved.current_config_version_id,
        operation_id: "real-managed-acp".to_string(),
    };
    let binding = managed_acp_binding(
        &binary,
        &input.provider_connection_id,
        &input.provider_config_version_id,
    )
    .unwrap();
    let prepared = prepare_managed_acp_provider(
        &app_data,
        &launch_root,
        "real-managed-acp",
        &binding,
        &store,
        &input,
        true,
    )
    .unwrap();
    let mut command = Command::new(&binary);
    command
        .arg("acp")
        .arg("--pure")
        .arg("--cwd")
        .arg(&cwd)
        .current_dir(&cwd)
        .env_clear()
        .env("HOME", prepared.profile_root.join("home"))
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("OPENCODE_CONFIG_DIR", prepared.config_root.join("config"))
        .env("XDG_CONFIG_HOME", prepared.config_root.join("xdg-config"))
        .env("XDG_DATA_HOME", prepared.profile_root.join("xdg-data"))
        .env("XDG_CACHE_HOME", prepared.profile_root.join("xdg-cache"))
        .env("XDG_STATE_HOME", prepared.profile_root.join("xdg-state"));
    protect_directory(&prepared.profile_root.join("home")).unwrap();
    let transport = AcpTransport::spawn(&mut command).unwrap();
    let initialize = transport
        .request_timeout(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {}}),
            Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(initialize["agentInfo"]["version"], OPENCODE_ACP_VERSION);
    let created = transport
        .request_timeout(
            "session/new",
            json!({"cwd": cwd.clone(), "mcpServers": []}),
            Duration::from_secs(10),
        )
        .unwrap();
    assert!(acp_config_options_select_target(
        &created["configOptions"],
        &prepared.binding.runtime_model_id
    ));
    transport.stop().unwrap();
}

#[test]
#[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
fn fixed_opencode_acp_program_uses_chat_completions_with_managed_key_and_model() {
    use std::{
        io::{Read as _, Write as _},
        net::{TcpListener, TcpStream},
    };

    fn read_http_request(mut stream: &TcpStream) -> (String, String, Value) {
        let mut header = Vec::new();
        let mut buffer = [0_u8; 1];
        while !header.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut buffer).unwrap();
            header.push(buffer[0]);
        }
        let header_text = String::from_utf8(header).unwrap();
        let content_length = header_text
            .lines()
            .find_map(|line| {
                line.strip_prefix("Content-Length:")
                    .or_else(|| line.strip_prefix("content-length:"))
            })
            .map(str::trim)
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = vec![0_u8; content_length];
        stream.read_exact(&mut body).unwrap();
        let path = header_text
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("")
            .to_string();
        let authorization = header_text
            .lines()
            .find_map(|line| {
                line.strip_prefix("Authorization:")
                    .or_else(|| line.strip_prefix("authorization:"))
            })
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let body = serde_json::from_slice(&body).unwrap();
        (path, authorization, body)
    }

    fn write_chat_completion(mut stream: TcpStream) {
        let chunk = r#"data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}

data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
            chunk.len(),
            chunk
        );
        stream.write_all(response.as_bytes()).unwrap();
    }

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener
        .set_nonblocking(false)
        .expect("fixture listener is blocking");
    let port = listener.local_addr().unwrap().port();
    let captured = Arc::new(Mutex::new(Vec::<(String, String, Value)>::new()));
    let captured_thread = captured.clone();
    let stop_server = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_server_thread = stop_server.clone();
    let server = thread::spawn(move || {
        listener
            .set_nonblocking(true)
            .expect("fixture listener can be nonblocking");
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !stop_server_thread.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    let request = read_http_request(&stream);
                    captured_thread.lock().unwrap().push(request);
                    write_chat_completion(stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("fixture HTTP server failed: {error}"),
            }
        }
    });

    let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
        .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
    let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let app_data = temp.path().join("app-data");
    let launch_root = temp.path().join("launch");
    let cwd = temp.path().join("workspace");
    std::fs::create_dir(&app_data).unwrap();
    std::fs::create_dir(&launch_root).unwrap();
    std::fs::create_dir(&cwd).unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let saved = crate::managed_provider::save_api_key_in_dir(
        &app_data,
        Some(&store),
        crate::managed_provider::ManagedProviderApiKeySaveInput {
            provider_key: "openai".to_string(),
            label: "OpenAI Fixture".to_string(),
            account_label: "fixture-http".to_string(),
            endpoint: format!("http://127.0.0.1:{port}/v1"),
            api_kind: "openai-chat-completions".to_string(),
            api_key: "sk-fixture-capture".to_string(),
            model_id: "gpt-fixture".to_string(),
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            reasoning: Some(false),
            image_input: Some(false),
            supports_developer_role: Some(true),
            supports_reasoning_effort: Some(false),
        },
    )
    .unwrap();
    let input = OpenCodeAcpManagedSessionInput {
        binary_path: binary.clone(),
        cwd: cwd.clone(),
        provider_connection_id: saved.provider_connection_id,
        provider_config_version_id: saved.current_config_version_id,
        operation_id: "real-managed-acp-chat-completions".to_string(),
    };
    let binding = managed_acp_binding(
        &binary,
        &input.provider_connection_id,
        &input.provider_config_version_id,
    )
    .unwrap();
    let prepared = prepare_managed_acp_provider(
        &app_data,
        &launch_root,
        "real-managed-acp-chat-completions",
        &binding,
        &store,
        &input,
        true,
    )
    .unwrap();
    protect_directory(&prepared.profile_root.join("home")).unwrap();
    let mut command = Command::new(&binary);
    command
        .arg("acp")
        .arg("--pure")
        .arg("--cwd")
        .arg(&cwd)
        .current_dir(&cwd)
        .env_clear()
        .env("HOME", prepared.profile_root.join("home"))
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("OPENCODE_CONFIG_DIR", prepared.config_root.join("config"))
        .env("XDG_CONFIG_HOME", prepared.config_root.join("xdg-config"))
        .env("XDG_DATA_HOME", prepared.profile_root.join("xdg-data"))
        .env("XDG_CACHE_HOME", prepared.profile_root.join("xdg-cache"))
        .env("XDG_STATE_HOME", prepared.profile_root.join("xdg-state"));
    let transport = Arc::new(AcpTransport::spawn(&mut command).unwrap());
    transport
        .request_timeout(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {}}),
            Duration::from_secs(10),
        )
        .unwrap();
    let created = transport
        .request_timeout(
            "session/new",
            json!({"cwd": cwd.clone(), "mcpServers": []}),
            Duration::from_secs(10),
        )
        .unwrap();
    let native_session_id = NativeSessionId::parse(created["sessionId"].as_str().unwrap())
        .expect("native session id parses");
    let runtime = OpenCodeAcpRuntime::default();
    *runtime.state.lock().unwrap() =
        OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(OpenCodeAcpConnection {
            transport: transport.clone(),
            binding,
            generation: 1,
            cwd,
            binary_path: binary,
            session_id: Some(native_session_id.as_str().to_string()),
            agent_name: Some("OpenCode".to_string()),
            agent_version: OPENCODE_ACP_VERSION.to_string(),
            protocol_version: 1,
            question_bridge: false,
            load_session: true,
            config_options: created["configOptions"].clone(),
            managed_provider: Some(prepared.binding),
            private_launch_dir: Some(prepared.config_root),
            last_error: None,
            dropped_events: 0,
            initialized_at_ms: 1,
            operations: AcpSessionOperations::default(),
            event_pump_stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })));
    let prompt = prompt_text(&runtime, &native_session_id, "fixture hello").unwrap();
    assert_eq!(prompt["stopReason"], "end_turn");
    stop_server.store(true, Ordering::Release);
    let _ = TcpStream::connect(("127.0.0.1", port));
    server.join().unwrap();
    let requests = captured.lock().unwrap();
    assert!(!requests.is_empty());
    assert!(requests.iter().all(|(path, authorization, body)| {
        path == "/v1/chat/completions"
            && authorization == "Bearer sk-fixture-capture"
            && body.get("model").and_then(Value::as_str) == Some("gpt-fixture")
    }));
    assert!(
        requests
            .iter()
            .any(|(_, _, body)| { body.to_string().contains("fixture hello") })
    );
    let _ = opencode_acp_stop_blocking(runtime);
}

#[test]
#[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
fn fixed_opencode_acp_real_permission_wait_can_cancel_and_continue() {
    let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
        .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
    let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
    let server = ToolCallFixtureServer::start();
    let temp = tempfile::tempdir().unwrap();
    let app_data_root = temp.path().join("app-data");
    let host_path = temp.path().join("host.sqlite3");
    let cwd = temp.path().join("workspace");
    std::fs::create_dir(&app_data_root).unwrap();
    std::fs::create_dir(&cwd).unwrap();

    let store = HostStore::open(host_path);
    let saved = crate::managed_provider::save_api_key_in_dir(
        &app_data_root,
        Some(&store),
        crate::managed_provider::ManagedProviderApiKeySaveInput {
            provider_key: "openai".to_string(),
            label: "OpenAI Tool Fixture".to_string(),
            account_label: "permission-cancel".to_string(),
            endpoint: server.endpoint(),
            api_kind: "openai-chat-completions".to_string(),
            api_key: "sk-tool-fixture".to_string(),
            model_id: "gpt-fixture".to_string(),
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            reasoning: Some(false),
            image_input: Some(false),
            supports_developer_role: Some(true),
            supports_reasoning_effort: Some(false),
        },
    )
    .unwrap();
    let runtime = OpenCodeAcpRuntime::default();
    let interactions = crate::interaction_registry::InteractionRegistry::default();
    let router =
        RuntimeEventRouter::with_capacity_and_observers(32, None, Some(interactions.clone()));
    let event_router = router.clone();
    let created = opencode_acp_new_managed_session_blocking_with_app_data(
        &app_data_root,
        runtime.clone(),
        router,
        store.clone(),
        OpenCodeAcpManagedSessionInput {
            binary_path: binary,
            cwd: cwd.clone(),
            provider_connection_id: saved.provider_connection_id.clone(),
            provider_config_version_id: saved.current_config_version_id.clone(),
            operation_id: "real-permission-cancel".to_string(),
        },
    )
    .unwrap();
    let _guard = OpenCodeAcpStopGuard(runtime.clone());
    let farfold_session_id = created
        .farfold_session_id
        .clone()
        .expect("managed new session registers Host session");
    let native_session_id =
        NativeSessionId::parse(created.session_id.clone()).expect("native session id parses");
    let generation = created.status.generation;
    let controller = Arc::new(crate::session_controller::HostSessionController::default());
    let coordinator = crate::turn_coordinator::TurnCoordinator::default();
    let submit_runtime = runtime.clone();
    let submit_store = store.clone();
    let submit_controller = controller.clone();
    let submit_coordinator = coordinator.clone();
    let submit_session_id = farfold_session_id.clone();
    let submit_native_id = native_session_id.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(
            crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
                &submit_controller,
                &submit_store,
                &submit_runtime,
                &submit_coordinator,
                crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                    farfold_session_id: submit_session_id,
                    native_session_id: submit_native_id,
                    text: "Use bash to read /etc/hosts once.".to_string(),
                    provider_connection_id: None,
                    provider_config_version_id: None,
                    runtime_provider_id: None,
                    runtime_model_id: None,
                },
            ),
        );
    });

    let pending = {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let snapshots = serde_json::to_value(interactions.snapshots().unwrap()).unwrap();
            if let Some(permission) = snapshots.as_array().and_then(|items| {
                items
                    .iter()
                    .find(|item| {
                        item["kind"] == "open_code_permission"
                            && item["runtimeGeneration"] == generation
                            && item["nativeSessionId"] == created.session_id
                    })
                    .cloned()
            }) {
                break permission;
            }
            if let Ok(result) = receiver.try_recv() {
                let events =
                    serde_json::to_value(event_router.snapshot(None, None).unwrap()).unwrap();
                panic!(
                    "prompt finished before permission was registered: {result:?}; events={events}; requests={}",
                    serde_json::to_string(&chat_fixture_request_summary(&server.captured()))
                        .unwrap()
                );
            }
            if std::time::Instant::now() >= deadline {
                let events =
                    serde_json::to_value(event_router.snapshot(None, None).unwrap()).unwrap();
                panic!(
                    "permission was not registered; interactions={snapshots}; events={events}; requests={}",
                    serde_json::to_string(&chat_fixture_request_summary(&server.captured()))
                        .unwrap()
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    assert_eq!(pending["runtimeGeneration"], generation);
    assert_eq!(pending["nativeSessionId"], created.session_id);
    assert_eq!(pending["state"], "pending");
    let request_id = pending["interactionId"]
        .as_str()
        .expect("permission request id is recorded")
        .to_string();
    let permission_event =
        wait_for_permission_event(&event_router, &request_id, &created.session_id);
    assert!(
        permission_event
            .pointer("/nativeEnvelope/payload/params/toolCall/title")
            .is_some_and(|title| title.to_string().contains("/etc/hosts"))
    );
    let option_kinds = permission_event["nativeEnvelope"]["payload"]["params"]["options"]
        .as_array()
        .expect("permission options are recorded")
        .iter()
        .filter_map(|option| option.get("kind").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(
        option_kinds,
        vec!["allow_once", "allow_always", "reject_once"]
    );

    crate::turn_coordinator::host_opencode_acp_turn_abort_blocking(
        &controller,
        &store,
        &runtime,
        &interactions,
        &coordinator,
        crate::turn_coordinator::HostOpenCodeAcpTurnAbortInput {
            farfold_session_id: farfold_session_id.clone(),
            native_session_id: native_session_id.clone(),
        },
    )
    .unwrap();
    let cancelled = receiver
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    assert!(
        matches!(
            cancelled,
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Cancelled { .. }
        ),
        "expected cancelled OpenCode ACP submission, got {cancelled:?}"
    );
    assert!(
        serde_json::to_value(interactions.snapshots().unwrap())
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["interactionId"].as_str() != Some(request_id.as_str()))
    );

    let next = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
        &controller,
        &store,
        &runtime,
        &coordinator,
        crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
            farfold_session_id,
            native_session_id,
            text: "Say ok.".to_string(),
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
        },
    )
    .unwrap();
    assert!(matches!(
        next,
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { .. }
    ));
    let requests = server.captured();
    assert!(
        requests
            .iter()
            .any(|(_, _, body)| chat_fixture_body_contains(body, "Use bash"))
    );
    assert!(
        requests
            .iter()
            .any(|(_, _, body)| chat_fixture_body_contains(body, "Say ok."))
    );
}

#[test]
#[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
fn fixed_opencode_acp_managed_session_stops_cold_restores_old_version_and_new_uses_current() {
    let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
        .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
    let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
    let server = ChatFixtureServer::start();
    let temp = tempfile::tempdir().unwrap();
    let app_data_root = temp.path().join("app-data");
    let host_path = temp.path().join("host.sqlite3");
    let cwd = temp.path().join("workspace");
    std::fs::create_dir(&app_data_root).unwrap();
    std::fs::create_dir(&cwd).unwrap();

    let store = HostStore::open(host_path.clone());
    let first = crate::managed_provider::save_api_key_in_dir(
        &app_data_root,
        Some(&store),
        crate::managed_provider::ManagedProviderApiKeySaveInput {
            provider_key: "openai".to_string(),
            label: "OpenAI Fixture".to_string(),
            account_label: "shared".to_string(),
            endpoint: server.endpoint(),
            api_kind: "openai-chat-completions".to_string(),
            api_key: "sk-first-fixture".to_string(),
            model_id: "gpt-first".to_string(),
            context_window: Some(200_000),
            max_tokens: Some(16_000),
            reasoning: Some(false),
            image_input: Some(false),
            supports_developer_role: Some(true),
            supports_reasoning_effort: Some(false),
        },
    )
    .unwrap();
    let first_binding = managed_acp_binding(
        &binary,
        &first.provider_connection_id,
        &first.current_config_version_id,
    )
    .unwrap();
    let first_runtime = OpenCodeAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let first_result = opencode_acp_new_managed_session_blocking_with_app_data(
        &app_data_root,
        first_runtime.clone(),
        router.clone(),
        store.clone(),
        OpenCodeAcpManagedSessionInput {
            binary_path: binary.clone(),
            cwd: cwd.clone(),
            provider_connection_id: first.provider_connection_id.clone(),
            provider_config_version_id: first.current_config_version_id.clone(),
            operation_id: "product-create-v1".to_string(),
        },
    )
    .unwrap();
    let first_session_id = first_result.session_id.clone();
    let farfold_session_id = first_result
        .farfold_session_id
        .clone()
        .expect("managed new session registers Host session");
    assert_eq!(
        first_result
            .status
            .managed_provider
            .as_ref()
            .unwrap()
            .provider_config_version_id,
        first.current_config_version_id
    );
    let first_profile_root = app_data_root
        .join("opencode-acp-experiment")
        .join("profiles")
        .join(safe_path_segment(first_binding.connection_id.as_str()));
    let first_config_root = app_data_root
        .join("opencode-acp-experiment")
        .join("launch-configs")
        .join("product-create-v1");
    let first_native_session_id = NativeSessionId::parse(first_session_id.clone()).unwrap();
    let seeded = prompt_text(
        &first_runtime,
        &first_native_session_id,
        "cold replay seed one",
    )
    .expect("first seed prompt succeeds before cold restore");
    assert_eq!(seeded["stopReason"], "end_turn");
    let seeded_second = prompt_text(
        &first_runtime,
        &first_native_session_id,
        "cold replay seed two",
    )
    .expect("second seed prompt succeeds before cold restore");
    assert_eq!(seeded_second["stopReason"], "end_turn");
    let stopped = opencode_acp_stop_blocking(first_runtime).unwrap();
    assert_eq!(stopped.state, "stopped");
    assert!(first_profile_root.exists());
    assert!(
        !first_config_root.exists(),
        "normal product stop removes only the owned launch config"
    );

    let second = crate::managed_provider::save_api_key_in_dir(
        &app_data_root,
        Some(&store),
        crate::managed_provider::ManagedProviderApiKeySaveInput {
            provider_key: "openai".to_string(),
            label: "OpenAI Fixture".to_string(),
            account_label: "shared".to_string(),
            endpoint: server.endpoint(),
            api_kind: "openai-chat-completions".to_string(),
            api_key: "sk-second-fixture".to_string(),
            model_id: "gpt-second".to_string(),
            context_window: Some(210_000),
            max_tokens: Some(17_000),
            reasoning: Some(false),
            image_input: Some(false),
            supports_developer_role: Some(true),
            supports_reasoning_effort: Some(false),
        },
    )
    .unwrap();
    assert_eq!(first.provider_connection_id, second.provider_connection_id);
    assert_ne!(
        first.current_config_version_id,
        second.current_config_version_id
    );

    let reopened_store = HostStore::open(host_path);
    let restored_runtime = OpenCodeAcpRuntime::default();
    let restored_router = RuntimeEventRouter::default();
    let opened = open_registered_host_session_with_app_data(
        &app_data_root,
        restored_runtime.clone(),
        restored_router.clone(),
        reopened_store.clone(),
        OpenCodeAcpHostOpenInput {
            binding: first_binding.clone(),
            farfold_session_id: farfold_session_id.clone(),
            working_copy_path: cwd.clone(),
            native_session_id: first_session_id.clone(),
        },
    )
    .unwrap();
    assert!(opened.runtime_generation > 0);
    std::thread::sleep(Duration::from_millis(500));
    let _ =
        opencode_acp_status_blocking(restored_runtime.clone(), restored_router.clone()).unwrap();
    let replay = serde_json::to_value(restored_router.snapshot(None, None).unwrap()).unwrap();
    let replay_events = replay["events"].as_array().unwrap();
    for expected in ["cold replay seed one", "cold replay seed two"] {
        assert!(
            replay_events.iter().any(|event| event["kind"] == "acp"
                && event["nativeEnvelope"].to_string().contains(expected)),
            "session/load must replay official ACP events for {expected}; private DB reads are not allowed"
        );
    }
    let controller = crate::session_controller::HostSessionController::default();
    let coordinator = crate::turn_coordinator::TurnCoordinator::default();
    let forged_restored_submission =
        crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
            &controller,
            &reopened_store,
            &restored_runtime,
            &coordinator,
            crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                farfold_session_id: farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(first_session_id.clone()).unwrap(),
                text: "restore v1 forged hello".to_string(),
                provider_connection_id: Some(second.provider_connection_id.clone()),
                provider_config_version_id: Some(second.current_config_version_id.clone()),
                runtime_provider_id: Some("forged-provider".to_string()),
                runtime_model_id: Some("forged-model".to_string()),
            },
        );
    assert!(
        forged_restored_submission
            .unwrap_err()
            .contains("does not match the active managed Runtime Session"),
        "stale or forged ACP Provider receipt must be rejected"
    );

    let restored_submission = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
        &controller,
        &reopened_store,
        &restored_runtime,
        &coordinator,
        crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
            farfold_session_id: farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(first_session_id.clone()).unwrap(),
            text: "restore v1 hello".to_string(),
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
        },
    )
    .unwrap();
    let restored_turn_id = match restored_submission {
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { submission } => {
            submission.turn_id
        }
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Unknown { detail }
        | crate::turn_coordinator::HostOpenCodeTurnSubmission::Failed { detail } => {
            panic!("restored v1 submit should be accepted, got unknown: {detail}")
        }
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Cancelled { detail } => {
            panic!("restored v1 submit should be accepted, got cancelled: {detail}")
        }
    };
    let restored_turn_binding = reopened_store
        .test_turn_provider_binding(&restored_turn_id)
        .unwrap()
        .expect("restored v1 submit binds Provider version");
    assert_eq!(restored_turn_binding.0, first.current_config_version_id);
    assert_eq!(
        restored_turn_binding.1,
        format!("{}/gpt-first", first.provider_connection_id.as_str())
    );
    assert_eq!(restored_turn_binding.2, first_binding.connection_id);
    let snapshot_after_restore = reopened_store
        .provider_projection_snapshot(&first.provider_connection_id)
        .unwrap();
    assert_eq!(
        snapshot_after_restore.connection.current_config_version_id,
        second.current_config_version_id
    );
    assert_eq!(
        snapshot_after_restore.projections[0].config_version_id,
        second.current_config_version_id
    );
    let _ = opencode_acp_stop_blocking(restored_runtime);

    let second_runtime = OpenCodeAcpRuntime::default();
    let second_result = opencode_acp_new_managed_session_blocking_with_app_data(
        &app_data_root,
        second_runtime.clone(),
        RuntimeEventRouter::default(),
        reopened_store,
        OpenCodeAcpManagedSessionInput {
            binary_path: binary,
            cwd,
            provider_connection_id: second.provider_connection_id.clone(),
            provider_config_version_id: second.current_config_version_id.clone(),
            operation_id: "product-create-v2".to_string(),
        },
    )
    .unwrap();
    assert_eq!(
        second_result
            .status
            .managed_provider
            .as_ref()
            .unwrap()
            .provider_config_version_id,
        second.current_config_version_id
    );
    let second_native = NativeSessionId::parse(second_result.session_id).unwrap();
    let second_session_id = second_native.as_str().to_string();
    let second_submission = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
        &controller,
        &store,
        &second_runtime,
        &coordinator,
        crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
            farfold_session_id: second_result
                .farfold_session_id
                .clone()
                .expect("second managed session registers Host session"),
            native_session_id: second_native,
            text: "new v2 hello".to_string(),
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
        },
    )
    .unwrap();
    let second_turn_id = match second_submission {
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { submission } => {
            submission.turn_id
        }
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Unknown { detail }
        | crate::turn_coordinator::HostOpenCodeTurnSubmission::Failed { detail } => {
            panic!("new v2 submit should be accepted, got unknown: {detail}")
        }
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Cancelled { detail } => {
            panic!("new v2 submit should be accepted, got cancelled: {detail}")
        }
    };
    let second_turn_binding = store
        .test_turn_provider_binding(&second_turn_id)
        .unwrap()
        .expect("new v2 submit binds Provider version");
    assert_eq!(second_turn_binding.0, second.current_config_version_id);
    assert_eq!(
        second_turn_binding.1,
        format!("{}/gpt-second", second.provider_connection_id.as_str())
    );
    assert_ne!(second_turn_binding.2, first_binding.connection_id);
    assert!(!second_session_id.is_empty());
    let _ = opencode_acp_stop_blocking(second_runtime);

    let captured = server.captured();
    assert!(captured.iter().any(|(path, authorization, body)| {
        path == "/v1/chat/completions"
            && authorization == "Bearer sk-first-fixture"
            && body.get("model").and_then(Value::as_str) == Some("gpt-first")
            && body.to_string().contains("restore v1 hello")
    }));
    assert!(captured.iter().any(|(path, authorization, body)| {
        path == "/v1/chat/completions"
            && authorization == "Bearer sk-second-fixture"
            && body.get("model").and_then(Value::as_str) == Some("gpt-second")
            && body.to_string().contains("new v2 hello")
    }));
}

#[test]
#[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
fn fixed_shared_saved_connection_drives_pi_bridge_and_opencode_acp_without_reentering_key() {
    let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
        .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
    let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
    let server = ChatFixtureServer::start();
    let temp = tempfile::tempdir().unwrap();
    let app_data_root = temp.path().join("app-data");
    let host_path = temp.path().join("host.sqlite3");
    let cwd = temp.path().join("workspace");
    let pi_agent_dir = temp.path().join("pi-agent");
    std::fs::create_dir(&app_data_root).unwrap();
    std::fs::create_dir(&cwd).unwrap();
    std::fs::create_dir(&pi_agent_dir).unwrap();

    let store = HostStore::open(host_path);
    store
        .register_runtime(&RuntimeRegistration {
            runtime_product_id: RuntimeProductId::parse(
                crate::runtime_registry::PI_RUNTIME.product_id,
            )
            .unwrap(),
            display_name: crate::runtime_registry::PI_RUNTIME.display_name.to_string(),
            installation_id: InstallationId::parse(
                crate::runtime_registry::PI_RUNTIME.installation_id,
            )
            .unwrap(),
            runtime_build_id: RuntimeBuildId::parse(
                crate::runtime_registry::PI_RUNTIME.runtime_build_id,
            )
            .unwrap(),
            adapter_id: AdapterId::parse(crate::runtime_registry::PI_RUNTIME.adapter_id).unwrap(),
            distribution: RuntimeDistribution::Managed,
            observed_version: crate::runtime_registry::PI_RUNTIME.version.to_string(),
            artifact_sha256: crate::runtime_registry::PI_RUNTIME
                .binary_sha256
                .to_string(),
            connection_id: ConnectionId::parse(
                crate::runtime_registry::PI_RUNTIME.default_connection_id,
            )
            .unwrap(),
            connection_label: "Pi native configuration".to_string(),
            connection_kind: RuntimeConnectionKind::ManagedLocal,
            created_at: 1,
            verified_at: 1,
        })
        .unwrap();
    let saved = crate::managed_provider::save_api_key_in_dir(
        &app_data_root,
        Some(&store),
        crate::managed_provider::ManagedProviderApiKeySaveInput {
            provider_key: "openai".to_string(),
            label: "OpenAI Shared Fixture".to_string(),
            account_label: "shared".to_string(),
            endpoint: server.endpoint(),
            api_kind: "openai-chat-completions".to_string(),
            api_key: "sk-shared-fixture".to_string(),
            model_id: "gpt-shared".to_string(),
            context_window: Some(200_000),
            max_tokens: Some(16_000),
            reasoning: Some(true),
            image_input: Some(true),
            supports_developer_role: Some(true),
            supports_reasoning_effort: Some(true),
        },
    )
    .unwrap();
    let listed = crate::managed_provider::list_committed_api_keys_in_dir(&app_data_root, &store)
        .unwrap()
        .into_iter()
        .find(|connection| connection.provider_connection_id == saved.provider_connection_id)
        .expect("Host list returns the saved shared connection");
    assert_eq!(
        listed.current_config_version_id.as_ref(),
        Some(&saved.current_config_version_id)
    );
    assert_eq!(listed.model_id, "gpt-shared");
    assert!(listed.reasoning);
    assert!(listed.image_input);
    assert!(listed.supports_reasoning_effort);

    let pi_capabilities =
        crate::pi_capabilities::PiCapabilities::with_agent_dir_for_test(pi_agent_dir);
    let _pi_stop = PiCapabilityStopGuard(&pi_capabilities);
    let pi_binding = crate::runtime_registry::RuntimeBinding {
        product_id: crate::host_ids::RuntimeProductId::parse(
            crate::runtime_registry::PI_RUNTIME.product_id,
        )
        .unwrap(),
        installation_id: crate::host_ids::InstallationId::parse(
            crate::runtime_registry::PI_RUNTIME.installation_id,
        )
        .unwrap(),
        runtime_build_id: crate::host_ids::RuntimeBuildId::parse(
            crate::runtime_registry::PI_RUNTIME.runtime_build_id,
        )
        .unwrap(),
        adapter_id: crate::host_ids::AdapterId::parse(
            crate::runtime_registry::PI_RUNTIME.adapter_id,
        )
        .unwrap(),
        connection_id: crate::host_ids::ConnectionId::parse(
            crate::runtime_registry::PI_RUNTIME.default_connection_id,
        )
        .unwrap(),
    };
    let before_pi_apply = server.captured().len();
    crate::managed_provider::managed_provider_apply_pi_blocking_with_app_data(
        &app_data_root,
        &store,
        &pi_capabilities,
        &pi_binding,
        crate::managed_provider::ManagedProviderApplyPiInput {
            provider_connection_id: listed.provider_connection_id.clone(),
            provider_config_version_id: listed.current_config_version_id.clone().unwrap(),
            operation_id: "shared-pi-apply".to_string(),
            runtime_product_id: pi_binding.product_id.clone(),
            installation_id: pi_binding.installation_id.clone(),
            runtime_connection_id: pi_binding.connection_id.clone(),
            runtime_provider_id: listed.provider_connection_id.as_str().to_string(),
            runtime_model_id: listed.model_id.clone(),
        },
    )
    .unwrap();
    let before_pi_probe = server.captured().len();
    let pi_probe = crate::pi_capabilities::test_connection_and_wait(
        &pi_capabilities,
        listed.provider_connection_id.as_str().to_string(),
        listed.model_id.clone(),
    )
    .unwrap_or_else(|error| {
        panic!(
            "Pi probe failed: {error}; fixture requests: {}",
            serde_json::to_string_pretty(&chat_fixture_request_summary(&server.captured()))
                .unwrap()
        )
    });
    assert_eq!(pi_probe["model"]["id"], "gpt-shared");
    assert!(
        pi_probe["response"].to_string().contains("ok"),
        "Pi probe response should come from the local fixture stream: {}",
        serde_json::to_string_pretty(&pi_probe).unwrap()
    );
    assert_eq!(pi_probe["bridge"]["sdkVersion"], "0.84.3");
    let pi_dispatches = pi_probe["dispatches"]
        .as_array()
        .expect("Pi probe returns dispatch evidence");
    assert!(
        pi_dispatches.iter().any(|dispatch| {
            dispatch["url"]["path"]
                .as_str()
                .is_some_and(|path| path == "/v1/chat/completions")
                && dispatch["method"] == "POST"
                && dispatch["hasAuthorization"] == true
                && dispatch["body"]["model"] == "gpt-shared"
                && dispatch["body"]["messageRoles"]
                    .as_array()
                    .is_some_and(|roles| roles.iter().any(|role| role == "user"))
        }),
        "Pi probe should dispatch a real local Chat Completions request: {}",
        serde_json::to_string_pretty(&pi_probe).unwrap()
    );
    let after_pi_probe = server.captured();
    let pi_apply_requests = &after_pi_probe[before_pi_apply..before_pi_probe];
    let pi_requests = &after_pi_probe[before_pi_probe..];
    assert!(
        pi_requests.iter().any(|(path, authorization, body)| {
            path == "/v1/chat/completions"
                && authorization == "Bearer sk-shared-fixture"
                && body.get("model").and_then(Value::as_str) == Some("gpt-shared")
                && chat_fixture_body_contains(body, "Reply OK")
        }),
        "Pi probe should use the saved key/model and explicit probe prompt; apply requests: {}; probe requests: {}; all requests: {}; pi response: {}",
        serde_json::to_string_pretty(&chat_fixture_request_summary(pi_apply_requests)).unwrap(),
        serde_json::to_string_pretty(&chat_fixture_request_summary(pi_requests)).unwrap(),
        serde_json::to_string_pretty(&chat_fixture_request_summary(&after_pi_probe)).unwrap(),
        serde_json::to_string_pretty(&pi_probe).unwrap()
    );
    crate::pi_capabilities::stop_process(&pi_capabilities).unwrap();

    let runtime = OpenCodeAcpRuntime::default();
    let _oc_stop = OpenCodeAcpStopGuard(runtime.clone());
    let router = RuntimeEventRouter::default();
    let result = opencode_acp_new_managed_session_blocking_with_app_data(
        &app_data_root,
        runtime.clone(),
        router,
        store.clone(),
        OpenCodeAcpManagedSessionInput {
            binary_path: binary,
            cwd,
            provider_connection_id: saved.provider_connection_id.clone(),
            provider_config_version_id: saved.current_config_version_id.clone(),
            operation_id: "shared-oc-create".to_string(),
        },
    )
    .unwrap();
    let controller = crate::session_controller::HostSessionController::default();
    let coordinator = crate::turn_coordinator::TurnCoordinator::default();
    let before_oc_prompt = server.captured().len();
    let submission = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
        &controller,
        &store,
        &runtime,
        &coordinator,
        crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
            farfold_session_id: result.farfold_session_id.unwrap(),
            native_session_id: NativeSessionId::parse(result.session_id).unwrap(),
            text: "oc shared hello".to_string(),
            provider_connection_id: None,
            provider_config_version_id: None,
            runtime_provider_id: None,
            runtime_model_id: None,
        },
    )
    .unwrap();
    assert!(matches!(
        submission,
        crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { .. }
    ));
    let _ = opencode_acp_stop_blocking(runtime);

    let after_oc_prompt = server.captured();
    let oc_requests = &after_oc_prompt[before_oc_prompt..];
    assert!(
        oc_requests.iter().any(|(path, authorization, body)| {
            path == "/v1/chat/completions"
                && authorization == "Bearer sk-shared-fixture"
                && body.get("model").and_then(Value::as_str) == Some("gpt-shared")
                && chat_fixture_body_contains(body, "oc shared hello")
        }),
        "OpenCode ACP prompt should use the saved key/model and Host-submitted text: {}",
        serde_json::to_string_pretty(&chat_fixture_request_summary(oc_requests)).unwrap()
    );
    let all_requests = server.captured();
    let shared_requests = all_requests
        .iter()
        .filter(|(path, authorization, body)| {
            path == "/v1/chat/completions"
                && authorization == "Bearer sk-shared-fixture"
                && body.get("model").and_then(Value::as_str) == Some("gpt-shared")
        })
        .count();
    assert!(
        shared_requests >= 2,
        "Pi and OpenCode ACP should both use the same saved key/model: {}",
        serde_json::to_string_pretty(&chat_fixture_request_summary(&all_requests)).unwrap()
    );
}
