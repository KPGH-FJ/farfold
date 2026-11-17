//! Content-free, versioned protocol diagnostics. Raw events stay in memory.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

mod permission_input;
pub(super) use permission_input::PermissionObservation;

#[cfg(test)]
use agent_client_protocol::LineDirection;

/// Per-file cap for structured diagnostics; rotates once then stops writing.
const TAP_FILE_CAP: u64 = 2 * 1024 * 1024;

static TAP_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const EVENTS: &[&str] = &[
    "initialize",
    "authenticate",
    "session/new",
    "session/load",
    "session/prompt",
    "session/update",
    "session/cancel",
    "session/request_permission",
    "session/set_config_option",
    "session/list",
    "response",
    "other",
];
const UPDATE_CLASSES: &[&str] = &[
    "assistant_text",
    "assistant_image",
    "assistant_other",
    "tool_image",
    "tool",
    "other",
];

fn update_class(update: &serde_json::Value) -> &'static str {
    match update
        .get("sessionUpdate")
        .and_then(serde_json::Value::as_str)
    {
        Some("agent_message_chunk") => match update
            .pointer("/content/type")
            .and_then(serde_json::Value::as_str)
        {
            Some("text") => "assistant_text",
            Some("image") => "assistant_image",
            _ => "assistant_other",
        },
        Some("tool_call" | "tool_call_update") => {
            if update
                .get("content")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|blocks| {
                    blocks.iter().any(|block| {
                        block.get("type").and_then(serde_json::Value::as_str) == Some("content")
                            && block
                                .pointer("/content/type")
                                .and_then(serde_json::Value::as_str)
                                == Some("image")
                    })
                })
            {
                "tool_image"
            } else {
                "tool"
            }
        }
        _ => "other",
    }
}

pub(crate) fn diagnostic_record(line: &str, direction: &str) -> serde_json::Value {
    diagnostic_record_with_permission(line, direction, None)
}

pub(super) fn diagnostic_record_with_permission(
    line: &str,
    direction: &str,
    observation: Option<&mut PermissionObservation>,
) -> serde_json::Value {
    let value = serde_json::from_str::<serde_json::Value>(line).ok();
    let event = value
        .as_ref()
        .and_then(|v| v.get("method"))
        .and_then(|v| v.as_str())
        .filter(|method| EVENTS.contains(method))
        .unwrap_or_else(|| {
            if value
                .as_ref()
                .is_some_and(|v| v.get("result").is_some() || v.get("error").is_some())
            {
                "response"
            } else {
                "other"
            }
        });
    let error = if direction == "err" {
        "stderr"
    } else if value.as_ref().is_some_and(|v| v.get("error").is_some()) {
        "protocol"
    } else {
        "none"
    };
    let mut record = serde_json::json!({"version":1,"ts":now_millis(),"dir":direction,"event":event,"bytes":line.len(),"error":error});
    if direction == "in" && event == "session/update" && error == "none" {
        record["updateClass"] = value
            .as_ref()
            .and_then(|value| value.pointer("/params/update"))
            .map_or("other", update_class)
            .into();
    }
    if direction == "in"
        && let Some(observation) = observation
    {
        observation.annotate(value.as_ref(), &mut record);
    }
    record
}

/// Rebuild from validated fields; never forward arbitrary fields from disk.
pub(crate) fn safe_record(value: &serde_json::Value) -> Option<serde_json::Value> {
    if value.get("version").and_then(serde_json::Value::as_u64) == Some(2) {
        return super::startup_diagnostics::safe_record(value);
    }
    if value.get("version")?.as_u64()? != 1 {
        return None;
    }
    let dir = value.get("dir")?.as_str()?;
    let event = value.get("event")?.as_str()?;
    let error = value.get("error")?.as_str()?;
    if !["in", "out", "err"].contains(&dir)
        || !EVENTS.contains(&event)
        || !["none", "stderr", "protocol"].contains(&error)
    {
        return None;
    }
    let mut safe = serde_json::json!({"version":1,"ts":value.get("ts")?.as_u64()?,"dir":dir,"event":event,"bytes":value.get("bytes")?.as_u64()?,"error":error});
    if let Some(sequence) = value
        .get("wireSequence")
        .and_then(serde_json::Value::as_u64)
        && sequence > 0
    {
        safe["wireSequence"] = sequence.into();
    }
    if dir == "in"
        && event == "session/update"
        && error == "none"
        && let Some(class) = value.get("updateClass").and_then(serde_json::Value::as_str)
        && UPDATE_CLASSES.contains(&class)
    {
        safe["updateClass"] = class.into();
    }
    if dir == "in"
        && event == "session/request_permission"
        && error == "none"
        && let Some(summary) = value.get("permissionInput")
        && let Some(checked) = permission_input::safe_permission_input(summary)
    {
        safe["permissionInput"] = checked;
    }
    // Additive v1 group: old records stay readable. A partial/untrusted group
    // is omitted together; no arbitrary error, request or code value survives.
    if ["in", "out"].contains(&dir)
        && event == "response"
        && error == "protocol"
        && let Some(class) = value
            .get("protocolErrorClass")
            .and_then(serde_json::Value::as_str)
        && ([
            "parse_error",
            "invalid_request",
            "method_not_found",
            "invalid_params",
            "internal_error",
            "other",
        ]
        .contains(&class)
            || (dir == "in"
                && ["request_cancelled", "auth_required", "resource_not_found"].contains(&class)))
        && let Some(null_id) = value
            .get("responseIdNull")
            .and_then(serde_json::Value::as_bool)
        && let Some(before_accepted) = value
            .get("beforeInitializeAccepted")
            .and_then(serde_json::Value::as_bool)
    {
        safe["protocolErrorClass"] = class.into();
        safe["responseIdNull"] = null_id.into();
        safe["beforeInitializeAccepted"] = before_accepted.into();
    }
    Some(safe)
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Structured diagnostics only; rotating once at the cap.
pub(crate) struct DebugTap {
    path: PathBuf,
    file: Option<std::io::BufWriter<std::fs::File>>,
    written: u64,
    rotated: bool,
    stopped: bool,
    summary_written: u64,
}

impl DebugTap {
    pub(crate) fn open(log_dir: &Path, _agent_id: &str) -> Option<Arc<Mutex<Self>>> {
        std::fs::create_dir_all(log_dir).ok()?;
        let path = log_dir.join(format!(
            "protocol-v1-{}-{}.jsonl",
            now_millis(),
            TAP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let file = std::fs::File::create(&path).ok()?;
        Some(Arc::new(Mutex::new(Self {
            path,
            file: Some(std::io::BufWriter::new(file)),
            written: 0,
            rotated: false,
            stopped: false,
            summary_written: 0,
        })))
    }

    #[cfg(test)]
    pub(crate) fn write(&mut self, line: &str, direction: LineDirection) {
        if self.stopped {
            return;
        }
        let direction = match direction {
            LineDirection::Stdin => "out",
            LineDirection::Stdout => "in",
            LineDirection::Stderr => "err",
        };
        let record = diagnostic_record(line, direction);
        self.write_record(&record);
    }

    pub(crate) fn write_record(&mut self, record: &serde_json::Value) {
        if self.stopped {
            return;
        }
        let Some(safe) = safe_record(record) else {
            return;
        };
        let mut encoded = safe.to_string();
        encoded.push('\n');
        let Some(file) = self.file.as_mut() else {
            self.stopped = true;
            return;
        };
        // An export while the connection is still alive must see these records.
        if file
            .write_all(encoded.as_bytes())
            .and_then(|_| file.flush())
            .is_err()
        {
            self.stopped = true;
            return;
        }
        self.written += encoded.len() as u64;
        if self.written >= TAP_FILE_CAP {
            if self.rotated {
                let _ = file.flush();
                self.stopped = true;
                return;
            }
            self.rotated = true;
            let _ = file.flush();
            drop(self.file.take());
            let rotated_path = self.path.with_extension("jsonl.1");
            let _ = std::fs::rename(&self.path, &rotated_path);
            self.file = std::fs::File::create(&self.path)
                .ok()
                .map(std::io::BufWriter::new);
            self.written = 0;
        }
    }

    /// A small independent budget remains available after ordinary traffic is
    /// capped. Only fixed snapshots may use it, always on the same IO worker.
    pub(crate) fn write_summary(&mut self, record: &serde_json::Value) {
        let Some(safe) = super::startup_diagnostics::safe_record(record) else {
            return;
        };
        let encoded = format!("{}\n", safe);
        const SUMMARY_CAP: u64 = 64 * 1024;
        if self.summary_written + encoded.len() as u64 > SUMMARY_CAP {
            return;
        }
        if let Some(file) = self.file.as_mut()
            && file
                .write_all(encoded.as_bytes())
                .and_then(|_| file.flush())
                .is_ok()
        {
            self.summary_written += encoded.len() as u64;
        }
    }
}

impl Drop for DebugTap {
    fn drop(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incoming_update_diagnostics_keep_only_fixed_content_classes() {
        let updates = [
            (
                serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"update-private-canary"}}),
                "assistant_text",
            ),
            (
                serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"image","data":"update-private-canary"}}),
                "assistant_image",
            ),
            (
                serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"update-private-canary"}}),
                "assistant_other",
            ),
            (
                serde_json::json!({"sessionUpdate":"tool_call_update","content":[{"type":"content","content":{"type":"image","data":"update-private-canary"}}]}),
                "tool_image",
            ),
            (
                serde_json::json!({"sessionUpdate":"tool_call","content":[{"type":"content","content":{"type":"text","text":"update-private-canary"}}]}),
                "tool",
            ),
            (
                serde_json::json!({"sessionUpdate":"update-private-canary"}),
                "other",
            ),
        ];
        for (update, class) in updates {
            let line = serde_json::json!({"method":"session/update","params":{"sessionId":"update-private-canary","update":update}}).to_string();
            let mut record = diagnostic_record(&line, "in");
            assert_eq!(record["updateClass"], class);
            let saved = safe_record(&record).unwrap();
            assert_eq!(saved["updateClass"], class);
            assert!(!saved.to_string().contains("canary"));
            assert!(diagnostic_record(&line, "out").get("updateClass").is_none());
            record["updateClass"] = "update-private-canary".into();
            assert!(safe_record(&record).unwrap().get("updateClass").is_none());
            record["updateClass"] = class.into();
            record["event"] = "response".into();
            assert!(safe_record(&record).unwrap().get("updateClass").is_none());
        }
    }

    #[test]
    fn spawn_failure_tap_preserves_only_typed_facts_for_records_and_summaries() {
        let expected = serde_json::json!({
            "version":2,"event":"startup","ts":1,"phase":"cleanup","failurePhase":"spawn",
            "startupOutcome":"cancelled","initializeResponse":"not_observed","initializeAccepted":false,
            "childStarted":false,"childReaped":false,"waitFailed":false,"exitCode":null,"exitSignal":null,
            "termRequested":false,"killRequested":false,"exitObservedBeforeTerm":false,"groupEnded":false,
            "connectionRemoved":true,"candidateCleanup":"deleted",
            "spawnFailure":{"osError":24,"fileLimit":{"soft":{"kind":"finite","value":256},"hard":{"kind":"infinite"}}}
        });
        let mut input = expected.clone();
        for field in ["argv", "env", "message", "path"] {
            input[field] = "spawn-private-canary".into();
            input["spawnFailure"][field] = "spawn-private-canary".into();
        }
        let dir = tempfile::tempdir().unwrap();
        let tap = DebugTap::open(dir.path(), "fixture").unwrap();
        tap.lock().unwrap().write_record(&input);
        tap.lock().unwrap().write_summary(&input);
        let text = std::fs::read_to_string(&tap.lock().unwrap().path).unwrap();
        assert!(!text.contains("canary"));
        let records: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(records, vec![expected.clone(), expected]);
    }

    #[test]
    fn protocol_errors_validator_keeps_only_the_complete_fixed_group() {
        for class in [
            "parse_error",
            "invalid_request",
            "method_not_found",
            "invalid_params",
            "internal_error",
            "other",
        ] {
            let expected = serde_json::json!({"version":1,"ts":1,"dir":"out","event":"response","bytes":2,"error":"protocol","protocolErrorClass":class,"responseIdNull":true,"beforeInitializeAccepted":false});
            let mut input = expected.clone();
            for field in ["message", "data", "id", "method", "env", "argv", "code"] {
                input[field] = "protocol-error-canary".into();
            }
            assert_eq!(safe_record(&input), Some(expected));
        }
    }

    #[test]
    fn protocol_errors_incoming_validator_keeps_only_allowlisted_fields() {
        for class in [
            "parse_error",
            "invalid_request",
            "method_not_found",
            "invalid_params",
            "internal_error",
            "request_cancelled",
            "auth_required",
            "resource_not_found",
            "other",
        ] {
            let expected = serde_json::json!({"version":1,"ts":1,"dir":"in","event":"response","bytes":2,"error":"protocol","protocolErrorClass":class,"responseIdNull":true,"beforeInitializeAccepted":false});
            let mut input = expected.clone();
            for field in ["message", "data", "id", "method", "env", "argv", "code"] {
                input[field] = "incoming-private-canary".into();
            }
            assert_eq!(safe_record(&input), Some(expected));
        }
    }

    #[test]
    fn protocol_errors_incoming_validator_rejects_direction_escalation_and_partial_groups() {
        let group = serde_json::json!({"version":1,"ts":1,"dir":"in","event":"response","bytes":2,"error":"protocol","protocolErrorClass":"auth_required","responseIdNull":false,"beforeInitializeAccepted":false});
        let fields = [
            "protocolErrorClass",
            "responseIdNull",
            "beforeInitializeAccepted",
        ];
        let mut candidates = Vec::new();
        for field in fields {
            let mut value = group.clone();
            value.as_object_mut().unwrap().remove(field);
            candidates.push(value);
        }
        for class in ["auth_required", "request_cancelled", "resource_not_found"] {
            let mut value = group.clone();
            value["dir"] = "out".into();
            value["protocolErrorClass"] = class.into();
            candidates.push(value);
        }
        for (field, value) in [
            ("protocolErrorClass", serde_json::json!("local_decode")),
            ("protocolErrorClass", serde_json::json!(8675309)),
            ("responseIdNull", serde_json::json!("false")),
            ("beforeInitializeAccepted", serde_json::Value::Null),
            ("dir", serde_json::json!("err")),
            ("event", serde_json::json!("session/prompt")),
            ("error", serde_json::json!("none")),
        ] {
            let mut input = group.clone();
            input[field] = value;
            candidates.push(input);
        }
        for input in candidates {
            let safe = safe_record(&input).unwrap();
            assert_eq!(safe.as_object().unwrap().len(), 6);
            assert!(fields.iter().all(|field| safe.get(field).is_none()));
        }
    }

    #[test]
    fn protocol_errors_validator_strips_partial_untrusted_and_wrong_context_groups() {
        let group = serde_json::json!({"version":1,"ts":1,"dir":"out","event":"response","bytes":2,"error":"protocol","protocolErrorClass":"method_not_found","responseIdNull":true,"beforeInitializeAccepted":false});
        let fields = [
            "protocolErrorClass",
            "responseIdNull",
            "beforeInitializeAccepted",
        ];
        let mut candidates = Vec::new();
        for field in fields {
            let mut value = group.clone();
            value.as_object_mut().unwrap().remove(field);
            candidates.push(value);
        }
        for (field, value) in [
            (
                "protocolErrorClass",
                serde_json::json!("protocol-error-canary"),
            ),
            ("protocolErrorClass", serde_json::json!(-32601)),
            ("responseIdNull", serde_json::json!("true")),
            ("responseIdNull", serde_json::Value::Null),
            ("beforeInitializeAccepted", serde_json::json!(0)),
            ("dir", serde_json::json!("err")),
            ("event", serde_json::json!("other")),
            ("error", serde_json::json!("none")),
        ] {
            let mut input = group.clone();
            input[field] = value;
            candidates.push(input);
        }
        for input in candidates {
            let safe = safe_record(&input).unwrap();
            assert_eq!(safe.as_object().unwrap().len(), 6);
            for field in fields {
                assert!(safe.get(field).is_none());
            }
            assert!(!safe.to_string().contains("canary"));
        }
    }

    #[test]
    fn protocol_tap_never_persists_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let tap = DebugTap::open(dir.path(), "fixture").unwrap();
        for (line, direction) in [
            (
                r#"{"method":"session/prompt","params":{"text":"secret-canary"}}"#,
                LineDirection::Stdin,
            ),
            (
                r#"{"method":"session/update","params":{"file":"secret-canary"}}"#,
                LineDirection::Stdout,
            ),
            ("secret-canary", LineDirection::Stderr),
        ] {
            tap.lock().unwrap().write(line, direction);
        }
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            assert_eq!(text.lines().count(), 3);
            assert!(!text.contains("secret-canary"));
            assert!(!text.contains("\"line\""));
        }
    }
}
