//! Embedded PTY sessions.
//!
//! One `PtyManager` owns every spawned pseudo-terminal. Output chunks stream
//! to the frontend over a `tauri::ipc::Channel` as base64; input, resize, and
//! exit-wait are separate commands. Used by terminal-style login flows now and
//! by the `terminal/*` client capability in a later slice — it stays generic.

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::shell_env;

pub(crate) const DEFAULT_COLS: u16 = 100;
pub(crate) const DEFAULT_ROWS: u16 = 28;

/// Output sink: the command layer wraps the frontend `Channel`; tests pass a
/// collecting closure. Receives `{id, data?}` (base64) and `{id, exit}` frames.
pub(crate) type PtySink = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Child-exit latch: the waiter thread stores the exit code and wakes every
/// `pty_await` blocked on the condvar.
type ExitLatch = Arc<(Mutex<Option<u32>>, Condvar)>;

struct PtySession {
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    /// Kept alive for the session's lifetime; dropping it hangs up the pty.
    /// `MasterPty` is `Send` but not `Sync`, so it lives behind the mutex.
    master: Mutex<Box<dyn MasterPty + Send>>,
    pid: Option<u32>,
    exit: ExitLatch,
}

/// Owns all live PTY sessions, keyed by generated id.
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    counter: AtomicU64,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Arc<PtySession>>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "pty manager lock poisoned".to_string())
    }

    /// Spawn `{command, args}` on a new PTY in `cwd` with `env` overlaid on the
    /// login-shell environment. Output chunks are sent to `on_output` as
    /// `{id, data: <base64>}` until the child exits or the reader hits EOF.
    pub fn spawn(
        &self,
        command: &str,
        args: &[String],
        env: &[(String, String)],
        cwd: &Path,
        size: PtySize,
        on_output: PtySink,
    ) -> Result<String, String> {
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|error| format!("cannot open pty: {error}"))?;

        let mut builder = CommandBuilder::new(command);
        builder.args(args.iter().map(String::as_str));
        builder.cwd(cwd.as_os_str());
        for (name, value) in env {
            builder.env(name.as_str(), value.as_str());
        }
        let mut child = pair
            .slave
            .spawn_command(builder)
            .map_err(|error| format!("cannot spawn {command} on pty: {error}"))?;
        let pid = child.process_id();

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("cannot clone pty reader: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("cannot take pty writer: {error}"))?;

        let id = format!(
            "pty-{}-{}",
            now_millis(),
            self.counter.fetch_add(1, Ordering::SeqCst)
        );
        let exit: ExitLatch = Arc::new((Mutex::new(None), Condvar::new()));

        // Waiter thread: owns the child, records the exit code, wakes awaits.
        {
            let exit = exit.clone();
            let id = id.clone();
            let on_output = on_output.clone();
            thread::spawn(move || {
                let code = match child.wait() {
                    Ok(status) => status.exit_code(),
                    Err(_) => 1,
                };
                if let Ok(mut slot) = exit.0.lock() {
                    *slot = Some(code);
                }
                exit.1.notify_all();
                on_output(serde_json::json!({"id": id, "exit": code}));
            });
        }

        // Reader thread: streams master output to the frontend channel.
        {
            let id = id.clone();
            thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => {
                            on_output(serde_json::json!({
                                "id": id,
                                "data": BASE64.encode(&buffer[..count]),
                            }));
                        }
                    }
                }
            });
        }

        let session = Arc::new(PtySession {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            pid,
            exit,
        });
        self.lock()?.insert(id.clone(), session);
        Ok(id)
    }

    /// Write user input bytes to the session's stdin.
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let session = self
            .lock()?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("pty {id} is not running"))?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "pty writer lock poisoned".to_string())?;
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|error| format!("cannot write to pty {id}: {error}"))
    }

    /// Resize the session's terminal window.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self
            .lock()?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("pty {id} is not running"))?;
        session
            .master
            .lock()
            .map_err(|_| "pty master lock poisoned".to_string())?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("cannot resize pty {id}: {error}"))
    }

    /// Block until the session exits and return its exit code. Sessions that
    /// already exited resolve immediately. Consumes the session.
    pub fn await_exit(&self, id: &str) -> Result<u32, String> {
        let session = self
            .lock()?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("pty {id} is not running"))?;
        let code = {
            let (slot, condvar) = &*session.exit;
            let mut guard = slot
                .lock()
                .map_err(|_| "pty exit lock poisoned".to_string())?;
            while guard.is_none() {
                guard = condvar
                    .wait(guard)
                    .map_err(|_| "pty exit lock poisoned".to_string())?;
            }
            guard.unwrap_or(1)
        };
        // Await consumes the session; a second await on the same id errors.
        self.lock()?.remove(id);
        Ok(code)
    }

    /// Signal the child with SIGHUP and drop the session (also hangs up the
    /// pty master). Idempotent.
    pub fn close(&self, id: &str) -> Result<(), String> {
        let session = self.lock()?.remove(id);
        if let Some(session) = session {
            hangup(session.pid);
        }
        Ok(())
    }

    /// Hang up every session (app exit path).
    pub fn stop_for_shutdown(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                hangup(session.pid);
            }
        }
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Best-effort SIGHUP; the master drop that follows also terminates the pty.
fn hangup(pid: Option<u32>) {
    if let Some(pid) = pid {
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGHUP) };
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn pty_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    match cwd {
        Some(value) if !value.trim().is_empty() => {
            let path = PathBuf::from(value);
            if path.is_dir() {
                Ok(path)
            } else {
                Err(format!("pty working directory does not exist: {value}"))
            }
        }
        _ => std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "cannot resolve home directory".to_string()),
    }
}

/// PTY spawn request payload for `pty_spawn`.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnSpec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// Spawn a command on a new PTY; output streams back over `on_output`.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    spec: PtySpawnSpec,
    on_output: Channel<serde_json::Value>,
) -> Result<String, String> {
    let cwd = pty_cwd(spec.cwd.as_deref())?;
    let mut merged: Vec<(String, String)> = shell_env::command_env().into_iter().collect();
    merged.extend(spec.env);
    let sink: PtySink = Arc::new(move |frame| {
        let _ = on_output.send(frame);
    });
    app.state::<PtyManager>().spawn(
        &spec.command,
        &spec.args,
        &merged,
        &cwd,
        PtySize {
            rows: spec.rows.unwrap_or(DEFAULT_ROWS),
            cols: spec.cols.unwrap_or(DEFAULT_COLS),
            pixel_width: 0,
            pixel_height: 0,
        },
        sink,
    )
}

/// Write UTF-8 input to a running PTY.
#[tauri::command]
pub fn pty_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    app.state::<PtyManager>().write(&id, data.as_bytes())
}

/// Resize a running PTY.
#[tauri::command]
pub fn pty_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    app.state::<PtyManager>().resize(&id, cols, rows)
}

/// Resolve with the session's exit code once the child terminates.
#[tauri::command]
pub async fn pty_await(app: AppHandle, id: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<PtyManager>().await_exit(&id))
        .await
        .map_err(|error| format!("pty_await failed: {error}"))?
}

/// Hang up and forget a PTY session.
#[tauri::command]
pub fn pty_close(app: AppHandle, id: String) -> Result<(), String> {
    app.state::<PtyManager>().close(&id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn spawn_streams_output_and_reports_exit_code() {
        let manager = PtyManager::new();
        let frames = Arc::new(Mutex::new(Vec::new()));
        let sink: PtySink = {
            let frames = frames.clone();
            Arc::new(move |frame| frames.lock().unwrap().push(frame))
        };
        let id = manager
            .spawn(
                "/bin/sh",
                &["-c".to_string(), "printf hello-pty; exit 3".to_string()],
                &[],
                Path::new("/tmp"),
                PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                sink,
            )
            .expect("spawn sh on pty");
        let code = manager.await_exit(&id).expect("await exit");
        assert_eq!(code, 3);

        // Reader thread may lag the exit notification by a few ms.
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let text: String = {
                let frames = frames.lock().unwrap();
                frames
                    .iter()
                    .filter_map(|frame| frame.get("data").and_then(|d| d.as_str()))
                    .filter_map(|data| BASE64.decode(data).ok())
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .collect()
            };
            if text.contains("hello-pty") || Instant::now() > deadline {
                assert!(text.contains("hello-pty"), "output was: {text:?}");
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
