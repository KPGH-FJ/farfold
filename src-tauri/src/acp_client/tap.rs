//! Content-free, versioned protocol diagnostics. Raw events stay in memory.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

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

pub(crate) fn diagnostic_record(line: &str, direction: &str) -> serde_json::Value {
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
    serde_json::json!({"version":1,"ts":now_millis(),"dir":direction,"event":event,"bytes":line.len(),"error":error})
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
    Some(
        serde_json::json!({"version":1,"ts":value.get("ts")?.as_u64()?,"dir":dir,"event":event,"bytes":value.get("bytes")?.as_u64()?,"error":error}),
    )
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
