use crate::{
    acp_transport::AcpTransport,
    runtime_registry::{PI_RUNTIME_BINARY_SHA256, file_sha256},
};
use serde_json::{Value, json};
use std::{
    io::Write,
    net::TcpListener,
    path::PathBuf,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) struct RejectModelServer {
    pub(crate) endpoint: String,
    pub(crate) requests: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

#[test]
fn malformed_pi_form_closes_owned_transport_without_leaving_pending_requests() {
    let temp = tempfile::tempdir().unwrap();
    let script = temp.path().join("malformed.py");
    let mut form = crate::pi_acp_interactions::form_fixture();
    form["params"]["requestedSchema"]["properties"]["value"]["type"] = json!("string");
    std::fs::write(&script, format!("import sys,json\njson.loads(sys.stdin.readline())\nprint({},flush=True)\nfor line in sys.stdin: pass\n", serde_json::to_string(&form.to_string()).unwrap())).unwrap();
    let transport =
        Arc::new(AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap());
    let registry = crate::interaction_registry::InteractionRegistry::default();
    let router = crate::runtime_event_router::RuntimeEventRouter::with_capacity_and_observers(
        32,
        None,
        Some(registry.clone()),
    );
    let mut binding =
        crate::runtime_registry::RuntimeBinding::from(crate::runtime_registry::PI_ACP_RUNTIME);
    binding.installation_id =
        crate::host_ids::InstallationId::parse("pi-acp-malformed-install").unwrap();
    binding.adapter_id =
        crate::host_ids::AdapterId::parse(crate::pi_acp_interactions::PI_ACP_ADAPTER_ID).unwrap();
    router.activate_connection(binding.clone(), 1).unwrap();
    let wire = transport.clone();
    let pending = thread::spawn(move || {
        wire.request_unbounded("session/prompt", json!({"sessionId":"native-session"}))
    });
    let (events, _) = transport.wait_events(Duration::from_secs(2)).unwrap();
    assert_eq!(events.len(), 1);
    assert!(
        router
            .route_acp(binding, 1, &transport, events[0].clone())
            .is_err()
    );
    assert!(pending.join().unwrap().is_err());
    assert!(!transport.is_running().unwrap());
    assert!(registry.snapshots().unwrap().is_empty());
}

impl RejectModelServer {
    pub(crate) fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let count = requests.clone();
        let done = stop.clone();
        let worker = thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        count.fetch_add(1, Ordering::AcqRel);
                        stream
                            .set_write_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let _ = stream.write_all(b"HTTP/1.1 500 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(error) => panic!("fixture listener failed: {error}"),
                }
            }
        });
        Self {
            endpoint,
            requests,
            stop,
            worker: Some(worker),
        }
    }
}

impl Drop for RejectModelServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

#[test]
#[ignore = "runs the fixed Pi adapter and Node distribution; no model or account access"]
fn fixed_pi_adapter_uses_shared_transport_forms_and_withdrawal_without_model() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let pi = manifest.join("resources/pi-runtime/pi");
    let node = manifest.join("capability-bridge/runtime/node");
    let adapter = manifest.join("pi-acp-adapter/dist/index.js");
    assert_eq!(file_sha256(&pi).unwrap(), PI_RUNTIME_BINARY_SHA256);
    assert_eq!(
        file_sha256(&node).unwrap(),
        "5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c"
    );
    assert!(
        adapter.is_file(),
        "Build the fixed adapter before this explicit contract test"
    );
    let fixtures = manifest.join("target/d-stage-pi-candidate-0912");
    std::fs::create_dir_all(&fixtures).unwrap();
    let temp = tempfile::Builder::new()
        .prefix("host-transport-")
        .tempdir_in(fixtures)
        .unwrap();
    let model = RejectModelServer::start();
    let store = crate::host_store::HostStore::open(temp.path().join("host.sqlite3"));
    let selection = crate::acp_provider_profile::tests::save_fixture(
        temp.path(),
        &store,
        &model.endpoint,
        "openai-chat-completions",
        "fixture-not-a-credential",
    );
    let mut binding = crate::acp_provider_profile::tests::pi_binding();
    binding.installation_id =
        crate::host_ids::InstallationId::parse("pi-acp-contract-install").unwrap();
    let prepared = crate::acp_provider_profile::prepare(
        temp.path(),
        &temp.path().join("pi-acp"),
        "native-contract",
        &binding,
        &store,
        &selection,
        true,
    )
    .unwrap();
    let home = prepared.profile_root.join("home");
    let agent = prepared.config_root.clone();
    let sessions = prepared.profile_root.join("sessions");
    std::fs::create_dir_all(&home).unwrap();
    let cwd = temp.path().join("project");
    std::fs::create_dir_all(agent.join("extensions")).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::copy(
        manifest.join("../scripts/fixtures/pi-acp-capability-probe.ts"),
        agent.join("extensions/probe.ts"),
    )
    .unwrap();
    let (transport, initialized) = crate::acp_runtime::initialize_transport(
            Command::new(&node)
                .arg(&adapter)
                .current_dir(&cwd)
                .env_clear()
                .env("HOME", &home)
                .env(
                    "PATH",
                    format!("{}:/usr/bin:/bin", node.parent().unwrap().display()),
                )
                .env("PI_CODING_AGENT_DIR", &agent)
                .env("PI_CODING_AGENT_SESSION_DIR", &sessions)
                .envs(&prepared.environment)
                .env("PI_ACP_PI_COMMAND", &pi)
                .env("TMPDIR", temp.path())
                .env("XDG_CONFIG_HOME", home.join("config"))
                .env("XDG_CACHE_HOME", home.join("cache"))
                .env("XDG_DATA_HOME", home.join("data")),
        &cwd,
        json!({
        "fs":{"readTextFile":true,"writeTextFile":true},"terminal":true,"elicitation":{"form":{}},"_meta":{"farfoldPi":{"version":1}}
        }),
        "0.0.33-farfold.1",
        Duration::from_secs(15),
    ).unwrap();
    assert_eq!(
        initialized.pointer("/agentCapabilities/_meta/farfoldPi/ui"),
        Some(&Value::Bool(true))
    );
    let session = transport
        .request("session/new", json!({"cwd":cwd,"mcpServers":[]}))
        .unwrap();
    let session_id = session["sessionId"].as_str().unwrap().to_string();
    assert!(
        session["configOptions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|option| option["id"] == "model"
                && option["currentValue"] == prepared.binding.runtime_model_id)
    );
    let descriptor = &session["_meta"]["farfoldPi"]["nativeSession"];
    assert_eq!(descriptor["version"], 1);
    assert_eq!(descriptor["sessionId"], session_id);
    assert_eq!(descriptor["cwd"], json!(cwd));
    assert!(
        std::path::Path::new(descriptor["sessionFile"].as_str().unwrap()).starts_with(&sessions)
    );
    transport.bind_client_session(Some(&session_id)).unwrap();
    let registry = crate::interaction_registry::InteractionRegistry::default();
    let router = crate::runtime_event_router::RuntimeEventRouter::with_capacity_and_observers(
        2048,
        None,
        Some(registry.clone()),
    );
    router.activate_connection(binding.clone(), 1).unwrap();
    let mut answered = Vec::new();
    let mut withdrawn = Vec::new();
    let mut notifications = Vec::new();
    for command in ["/farfold-d-probe", "/farfold-d-timeout"] {
        let wire = transport.clone();
        let session = session_id.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        let prompt = thread::spawn(move || {
            let _ = sender.send(wire.request_unbounded(
                "session/prompt",
                json!({"sessionId":session,"prompt":[{"type":"text","text":command}]}),
            ));
        });
        let mut timeout_request_key = None;
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut result = None;
        while result.is_none() {
            assert!(
                Instant::now() < deadline,
                "native form did not settle through the Host transport"
            );
            let (events, dropped) = transport.wait_events(Duration::from_millis(25)).unwrap();
            assert_eq!(dropped, 0);
            for event in events {
                router
                    .route_acp(binding.clone(), 1, &transport, event.clone())
                    .unwrap();
                match event["method"].as_str() {
                    Some("elicitation/create") => {
                        assert_eq!(event["params"]["sessionId"], session_id);
                        let native = &event["params"]["_meta"]["farfoldPi"]["event"];
                        let request_id =
                            super::acp_transport::json_rpc_id_key(&event["id"]).unwrap();
                        let parsed =
                            crate::pi_acp_interactions::PiAcpDialog::parse(&event).unwrap();
                        assert_eq!(parsed.request_key, request_id);
                        assert_eq!(registry.snapshots().unwrap().len(), 1);
                        if native["title"] == "D timeout" {
                            // Retain a key only to assert a later UI answer is rejected.
                            timeout_request_key = Some(request_id);
                            let wrong = json!({"jsonrpc":"2.0","method":"_pi/ui_withdrawn","params":{"sessionId":"wrong-session","nativeRequestId":native["id"],"version":1,"reason":"timeout"}});
                            router
                                .route_acp(binding.clone(), 1, &transport, wrong)
                                .unwrap();
                            let stale = json!({"jsonrpc":"2.0","method":"_pi/ui_withdrawn","params":{"sessionId":session_id,"nativeRequestId":native["id"],"version":1,"reason":"timeout"}});
                            router
                                .route_acp(binding.clone(), 0, &transport, stale)
                                .unwrap();
                            assert_eq!(registry.snapshots().unwrap().len(), 1);
                            continue;
                        }
                        let value = match native["method"].as_str().unwrap() {
                            "select" => json!("Two"),
                            "confirm" => json!(false),
                            "input" => json!("D input response"),
                            "editor" => json!("D editor response\nSecond line"),
                            other => panic!("unexpected form {other}"),
                        };
                        registry
                            .begin_response(binding.clone(), 1, &request_id, Some(&session_id))
                            .unwrap();
                        transport
                            .respond_client_request(
                                &request_id,
                                json!({"action":"accept","content":{"value":value}}),
                            )
                            .unwrap();
                        registry
                            .finish_response(binding.clone(), 1, &request_id, true)
                            .unwrap();
                        assert!(
                            transport
                                .respond_client_request(&request_id, json!({"action":"cancel"}))
                                .is_err()
                        );
                        answered.push(native["method"].clone());
                    }
                    Some("_pi/ui_withdrawn") => {
                        assert_eq!(event["params"]["sessionId"], session_id);
                        assert_eq!(event["params"]["version"], 1);
                        assert_eq!(event["params"]["reason"], "timeout");
                        let request = timeout_request_key
                            .take()
                            .expect("timeout fixture must have opened a form");
                        assert!(registry.snapshots().unwrap().is_empty());
                        assert!(
                            registry
                                .begin_response(binding.clone(), 1, &request, Some(&session_id))
                                .is_err()
                        );
                        assert!(
                            transport
                                .respond_client_request(
                                    &request,
                                    json!({"action":"accept","content":{"value":"late"}})
                                )
                                .is_err()
                        );
                        withdrawn.push(event);
                    }
                    Some("_pi/ui") => notifications.push(event),
                    Some("session/request_permission") => {
                        panic!("Pi forms must not become tool permissions")
                    }
                    _ => {}
                }
            }
            if result.is_none() {
                result = receiver.try_recv().ok();
            }
        }
        assert_eq!(result.unwrap().unwrap()["stopReason"], "end_turn");
        assert!(!transport.has_unresolved_work().unwrap());
        assert!(timeout_request_key.is_none());
        assert!(registry.snapshots().unwrap().is_empty());
        prompt.join().unwrap();
    }
    assert_eq!(
        answered,
        vec![
            json!("select"),
            json!("confirm"),
            json!("input"),
            json!("editor")
        ]
    );
    assert_eq!(withdrawn.len(), 1);
    assert!(
        notifications
            .iter()
            .any(|event| event["params"]["event"]["message"] == "D-TIMEOUT-RESULT:null")
    );
    assert!(!transport.has_unresolved_work().unwrap());
    assert_eq!(model.requests.load(Ordering::Acquire), 0);
    transport.stop().unwrap();
}
