use super::*;
use serde_json::json;
use std::time::Duration;

#[test]
fn startup_diagnostics_matches_only_our_outgoing_initialize_id() {
    let d = Diagnostics::with_tap(None);
    let id: RequestId = "request-private-canary".to_string().into();
    let request = RawJsonRpcMessage::request(
        "initialize".into(),
        json!({"private":"payload-canary"}),
        id.clone(),
    )
    .unwrap();
    d.inspect(&request, true);
    d.inspect(
        &RawJsonRpcMessage::response("other".to_string().into(), Ok(json!({}))),
        false,
    );
    d.inspect(
        &RawJsonRpcMessage::response(id.clone(), Ok(json!({}))),
        true,
    );
    assert_eq!(
        d.state.lock().unwrap().snapshot.initialize_response,
        Response::NotObserved
    );
    d.inspect(
        &RawJsonRpcMessage::response(id, Err(agent_client_protocol::Error::invalid_params())),
        false,
    );
    let value = encode(&d.state.lock().unwrap().snapshot);
    assert_eq!(value["initializeResponse"], "matched_error");
    assert!(!value.to_string().contains("canary"));
}

#[test]
fn startup_diagnostics_late_observation_cannot_rewrite_timeout() {
    let d = Diagnostics::with_tap(None);
    d.phase(Phase::Initialize);
    d.outcome(Outcome::Timeout);
    d.phase(Phase::Cleanup);
    d.accepted();
    d.outcome(Outcome::Success);
    let value = encode(&d.state.lock().unwrap().snapshot);
    assert_eq!(value["startupOutcome"], "timeout");
    assert_eq!(value["failurePhase"], "initialize");
    assert_eq!(value["initializeAccepted"], true);
}

#[test]
fn startup_diagnostics_wait_errors_and_absent_child_are_not_reap_facts() {
    let d = Diagnostics::with_tap(None);
    assert!(!d.state.lock().unwrap().snapshot.child_reaped);
    d.started();
    d.exit(&Err(std::io::Error::other("private-canary")));
    let value = encode(&d.state.lock().unwrap().snapshot);
    assert_eq!(value["childReaped"], false);
    assert_eq!(value["waitFailed"], true);
    assert_eq!(value["exitCode"], serde_json::Value::Null);
    assert!(!value.to_string().contains("canary"));
}

#[test]
fn startup_diagnostics_rebuilds_only_fixed_types_and_rejects_false_exit_metadata() {
    let mut value = encode(&Snapshot::default());
    value["argv"] = json!("private-canary");
    assert!(!safe_record(&value).unwrap().to_string().contains("canary"));
    value["phase"] = json!("private-canary");
    assert!(safe_record(&value).is_none());
    value = encode(&Snapshot::default());
    value["exitCode"] = json!(3);
    assert!(safe_record(&value).is_none());
}

fn wait_final(dir: &Path, expected: &str) -> serde_json::Value {
    let until = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let mut latest = None;
        for entry in std::fs::read_dir(dir).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            assert!(!text.contains("payload-canary"));
            for line in text.lines() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line)
                    && v["event"] == "startup"
                    && v["candidateCleanup"] == expected
                {
                    latest = Some(v);
                }
            }
        }
        if let Some(value) = latest {
            return value;
        }
        assert!(std::time::Instant::now() < until, "final slot not written");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn startup_diagnostics_final_slot_survives_full_queue_and_sender_release() {
    let dir = tempfile::tempdir().unwrap();
    let tap = DebugTap::open(dir.path(), "fixture").unwrap();
    let guard = tap.lock().unwrap();
    let d = Diagnostics::with_tap(Some(tap.clone()));
    let ordinary = json!({"version":1,"ts":1,"dir":"in","event":"response","bytes":1,"error":"none","body":"payload-canary"});
    for _ in 0..256 {
        d.record(ordinary.clone());
    }
    d.outcome(Outcome::Failed);
    d.cleanup(Cleanup::Deleted);
    drop(d);
    drop(guard);
    assert_eq!(
        wait_final(dir.path(), "deleted")["startupOutcome"],
        "failed"
    );
}

#[test]
fn startup_diagnostics_final_slot_survives_rotation_and_ordinary_cap() {
    let dir = tempfile::tempdir().unwrap();
    let tap = DebugTap::open(dir.path(), "fixture").unwrap();
    let ordinary =
        json!({"version":1,"ts":1,"dir":"in","event":"response","bytes":1,"error":"none"});
    {
        let mut tap = tap.lock().unwrap();
        for _ in 0..50000 {
            tap.write_record(&ordinary);
        }
    }
    let d = Diagnostics::with_tap(Some(tap));
    d.cleanup(Cleanup::Deleted);
    drop(d);
    assert_eq!(
        wait_final(dir.path(), "deleted")["candidateCleanup"],
        "deleted"
    );
}

#[test]
fn startup_diagnostics_candidate_release_requires_actual_reap_group_and_removal() {
    let d = Diagnostics::with_tap(None);
    assert!(d.candidate_files_releasable()); // no launched Child, after manager check
    d.started();
    d.removed();
    d.group_ended();
    d.exit(&Err(std::io::Error::other("wait-canary")));
    assert!(!d.candidate_files_releasable());
    use std::os::unix::process::ExitStatusExt;
    d.exit(&Ok(std::process::ExitStatus::from_raw(0)));
    assert!(d.candidate_files_releasable());
    let d = Diagnostics::with_tap(None);
    d.started();
    d.exit(&Ok(std::process::ExitStatus::from_raw(0)));
    assert!(!d.candidate_files_releasable());
    d.group_ended();
    assert!(!d.candidate_files_releasable());
    d.removed();
    assert!(d.candidate_files_releasable());
}

fn error_record(d: &Diagnostics, code: i32, id: RequestId) -> serde_json::Value {
    let message = RawJsonRpcMessage::response(
        id,
        Err(
            agent_client_protocol::Error::new(code, "protocol-error-canary")
                .data(json!({"message":"protocol-error-canary"})),
        ),
    );
    let mut record =
        super::super::tap::diagnostic_record(&serde_json::to_string(&message).unwrap(), "out");
    d.annotate_outgoing_error(&message, &mut record);
    super::super::tap::safe_record(&record).unwrap()
}

#[test]
fn protocol_errors_typed_code_classification_never_retains_custom_values() {
    let d = Diagnostics::with_tap(None);
    for (code, class) in [
        (-32700, "parse_error"),
        (-32600, "invalid_request"),
        (-32601, "method_not_found"),
        (-32602, "invalid_params"),
        (-32603, "internal_error"),
        (-32800, "other"),
        (-32000, "other"),
        (-32002, "other"),
        (8675309, "other"),
    ] {
        let value = error_record(&d, code, "protocol-error-canary".to_string().into());
        assert_eq!(value["protocolErrorClass"], class);
        assert_eq!(value["responseIdNull"], false);
        assert_eq!(value["beforeInitializeAccepted"], true);
        assert_eq!(value.as_object().unwrap().len(), 9);
        assert!(!value.to_string().contains("canary"));
        assert!(!value.to_string().contains("8675309"));
    }
}

#[test]
fn protocol_errors_observation_boolean_is_not_initialize_phase_or_outcome() {
    let d = Diagnostics::with_tap(None);
    d.outcome(Outcome::Timeout);
    d.phase(Phase::Cleanup);
    assert_eq!(
        error_record(&d, -32601, RequestId::Null)["beforeInitializeAccepted"],
        true
    );
    d.accepted();
    let value = error_record(&d, -32601, RequestId::Null);
    assert_eq!(value["responseIdNull"], true);
    assert_eq!(value["beforeInitializeAccepted"], false);
    assert_eq!(
        d.state.lock().unwrap().snapshot.startup_outcome,
        Outcome::Timeout
    );
}

#[test]
fn protocol_errors_results_and_requests_receive_no_optional_error_group() {
    let d = Diagnostics::with_tap(None);
    for message in [
        RawJsonRpcMessage::response(
            RequestId::Null,
            Ok(json!({"private":"protocol-error-canary"})),
        ),
        RawJsonRpcMessage::request("protocol-error-canary".into(), json!({}), RequestId::Null)
            .unwrap(),
    ] {
        let mut value =
            super::super::tap::diagnostic_record(&serde_json::to_string(&message).unwrap(), "out");
        d.annotate_outgoing_error(&message, &mut value);
        assert!(value.get("protocolErrorClass").is_none());
        assert!(value.get("responseIdNull").is_none());
        assert!(value.get("beforeInitializeAccepted").is_none());
    }
}

#[test]
fn protocol_errors_contended_observer_does_not_wait_or_invent_a_boolean() {
    let d = Diagnostics::with_tap(None);
    let held = d.state.lock().unwrap();
    let worker = d.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        send.send(error_record(&worker, -32601, RequestId::Null))
            .unwrap();
    });
    let observed = receive.recv_timeout(Duration::from_millis(250));
    drop(held);
    thread.join().unwrap();
    let value = observed.expect("classification must not wait for the observer lock");
    assert!(value.get("protocolErrorClass").is_none());
    assert!(value.get("responseIdNull").is_none());
    assert!(value.get("beforeInitializeAccepted").is_none());
}

#[test]
fn protocol_errors_poisoned_observer_omits_the_entire_group() {
    let d = Diagnostics::with_tap(None);
    let worker = d.clone();
    assert!(
        std::thread::spawn(move || {
            let _held = worker.state.lock().unwrap();
            panic!("controlled observer poison");
        })
        .join()
        .is_err()
    );
    let value = error_record(&d, -32601, RequestId::Null);
    assert!(value.get("protocolErrorClass").is_none());
    assert!(value.get("responseIdNull").is_none());
    assert!(value.get("beforeInitializeAccepted").is_none());
}
