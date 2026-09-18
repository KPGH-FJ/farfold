//! Raw protocol tap for connection diagnostics.
//!
//! Appends every stdin/stdout/stderr line to `acp-<agent>-<ts>.jsonl` under
//! the app log dir, rotating once at the cap. The tap preserves wire bytes
//! the typed schema drops (e.g. `_meta` extensions); it is diagnostics only,
//! never a runtime input.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use agent_client_protocol::LineDirection;

/// Per-file cap for the raw protocol tap; rotates once then stops writing.
const TAP_FILE_CAP: u64 = 2 * 1024 * 1024;

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Raw protocol tap: appends every stdin/stdout/stderr line to
/// `acp-<agent>-<ts>.jsonl` under the log dir, rotating once at the cap.
pub(crate) struct DebugTap {
    path: PathBuf,
    file: Option<std::io::BufWriter<std::fs::File>>,
    written: u64,
    rotated: bool,
    stopped: bool,
}

impl DebugTap {
    pub(crate) fn open(log_dir: &Path, agent_id: &str) -> Option<Arc<Mutex<Self>>> {
        std::fs::create_dir_all(log_dir).ok()?;
        let path = log_dir.join(format!("acp-{agent_id}-{}.jsonl", now_millis()));
        let file = std::fs::File::create(&path).ok()?;
        Some(Arc::new(Mutex::new(Self {
            path,
            file: Some(std::io::BufWriter::new(file)),
            written: 0,
            rotated: false,
            stopped: false,
        })))
    }

    pub(crate) fn write(&mut self, line: &str, direction: LineDirection) {
        if self.stopped {
            return;
        }
        let direction = match direction {
            LineDirection::Stdin => "out",
            LineDirection::Stdout => "in",
            LineDirection::Stderr => "err",
        };
        let record = serde_json::json!({"ts": now_millis(), "dir": direction, "line": line});
        let mut encoded = record.to_string();
        encoded.push('\n');
        let Some(file) = self.file.as_mut() else {
            self.stopped = true;
            return;
        };
        if file.write_all(encoded.as_bytes()).is_err() {
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
}

impl Drop for DebugTap {
    fn drop(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush();
        }
    }
}
