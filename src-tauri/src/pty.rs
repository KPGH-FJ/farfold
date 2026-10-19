//! Embedded PTY sessions.
//!
//! One `PtyManager` owns every spawned pseudo-terminal. Output chunks stream
//! to the frontend over a `tauri::ipc::Channel` as base64; input, resize, and
//! exit-wait are separate commands. Used by terminal-style login flows.

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::shell_env;

pub(crate) const DEFAULT_COLS: u16 = 100;
pub(crate) const DEFAULT_ROWS: u16 = 28;
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Output sink: the command layer wraps the frontend `Channel`; tests pass a
/// collecting closure. Receives `{id, data?}` (base64) and `{id, exit}` frames.
pub(crate) type PtySink = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Confirmed terminal-exit latch: child/group cleanup and actual control-master
/// destruction precede the exit sink and every `pty_await` notification.
type ExitLatch = Arc<(Mutex<Option<u32>>, Condvar)>;
type MasterSlot = Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>;

fn drop_master(master: &MasterSlot) -> Result<(), ()> {
    // Taking, not cloning, transfers the last control object to this owner.
    // Never hold this mutex while an upstream destructor or callback runs.
    let master = {
        let mut slot = master
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        slot.take().ok_or(())?
    };
    drop(master);
    Ok(())
}

fn finish_exit(
    master: &MasterSlot,
    exit: &ExitLatch,
    id: &str,
    code: u32,
    on_output: &PtySink,
) -> Result<(), ()> {
    drop_master(master)?;
    crate::logging::info("pty", format_args!("exit: {id} code {code}"));
    // Authentication/configuration release follows actual master destruction.
    on_output(serde_json::json!({"id": id, "exit": code}));
    let mut slot = exit.0.lock().map_err(|_| ())?;
    *slot = Some(code);
    drop(slot);
    exit.1.notify_all();
    Ok(())
}

// Borrowed view of the EXISTING sole worker, not another owner/thread/permit.
struct TerminalOwner<'a> {
    child: &'a mut dyn portable_pty::Child,
    _group: &'a crate::process_platform::OwnedGroup,
    pid: Option<u32>,
    stop: &'a AtomicBool,
    master: &'a MasterSlot,
    exit: &'a ExitLatch,
    id: &'a str,
    on_output: &'a PtySink,
}
impl TerminalOwner<'_> {
    fn settle(&mut self) -> bool {
        let settled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut code = None;
            let mut stopping = None;
            let mut terminated = false;
            let mut killed = false;
            loop {
                if (self.stop.load(Ordering::SeqCst) || code.is_some()) && stopping.is_none() {
                    stopping = Some(Instant::now());
                    if let Some(pid) = self.pid {
                        crate::supervisor::signal_owned_group(pid, crate::supervisor::HANGUP);
                    } else {
                        let _ = self.child.kill();
                    }
                }
                if let Some(started) = stopping {
                    if !terminated && started.elapsed() >= Duration::from_millis(250) {
                        if let Some(pid) = self.pid {
                            crate::supervisor::signal_owned_group(pid, crate::supervisor::TERM);
                        }
                        terminated = true;
                    }
                    if !killed && started.elapsed() >= Duration::from_secs(2) {
                        if let Some(pid) = self.pid {
                            crate::supervisor::signal_owned_group(pid, crate::supervisor::KILL);
                        } else {
                            let _ = self.child.kill();
                        }
                        killed = true;
                    }
                }
                if code.is_none()
                    && let Ok(Some(status)) = self.child.try_wait()
                {
                    code = Some(status.exit_code());
                }
                if code.is_some() && !self.pid.is_some_and(crate::supervisor::owned_group_alive) {
                    break;
                }
                thread::sleep(Duration::from_millis(if killed { 100 } else { 25 }));
            }
            finish_exit(
                self.master,
                self.exit,
                self.id,
                code.unwrap_or(1),
                self.on_output,
            )
        }));
        if matches!(settled, Ok(Ok(()))) {
            return true;
        }
        self.stop.store(true, Ordering::SeqCst);
        // Setting stop alone cannot work after this sole loop unwound. Preserve
        // the SAME Child/Job and actively fulfill termination/reap first.
        self.reap_after_failure();
        // If a control object was never attempted, retire it on this same worker
        // only AFTER reap. None/panic/block is never an exit receipt; do not
        // repeat the sink, clear the unknown state, or release activity here.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop_master(self.master)));
        false
    }
    fn reap_after_failure(&mut self) {
        loop {
            #[cfg(windows)]
            self._group.terminate();
            #[cfg(unix)]
            if let Some(pid) = self.pid {
                crate::supervisor::signal_owned_group(pid, crate::supervisor::KILL);
            }
            // Trait code can panic as well as return an I/O error. Neither may
            // unwind away this original owner or falsely confirm cleanup.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.child.kill()));
            let reaped = matches!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.child.try_wait())),
                Ok(Ok(Some(_)))
            );
            #[cfg(windows)]
            let inactive = !self._group.active();
            #[cfg(unix)]
            let inactive = !self.pid.is_some_and(crate::supervisor::owned_group_alive);
            if reaped && inactive {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}

struct PtySession {
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    /// The process owner takes and destroys this object before confirming exit.
    /// Session/resize references share the slot, never an extra master object.
    master: MasterSlot,
    #[cfg(test)]
    pid: Option<u32>,
    stop: Arc<AtomicBool>,
    exit: ExitLatch,
}

/// Owns all live PTY sessions, keyed by generated id.
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    counter: AtomicU64,
    shutting_down: AtomicBool,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
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
        self.spawn_controlled(
            command,
            args,
            env,
            cwd,
            size,
            on_output,
            Arc::new(AtomicBool::new(false)),
        )
    }

    /// A preparation action shares its existing cancellation flag with this
    /// owner. It keeps the same process-group cleanup and exit confirmation.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn spawn_controlled(
        &self,
        command: &str,
        args: &[String],
        env: &[(String, String)],
        cwd: &Path,
        size: PtySize,
        on_output: PtySink,
        stop: Arc<AtomicBool>,
    ) -> Result<String, String> {
        let admission = crate::managed_update::activity()?;
        if stop.load(Ordering::SeqCst) {
            return Err("AUTH_CANCELLED".into());
        }
        // Acquire the registry before launching so a poisoned lock cannot
        // strand a newly spawned child without a reachable session owner.
        let mut sessions = self.lock()?;
        // Check under the same registry lock as shutdown's closing mark and
        // snapshot. A spawn that won the lock is included in that snapshot;
        // a later spawn cannot register after shutdown has inspected owners.
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err("应用正在退出，请稍后重试".into());
        }
        let portable_pty::PtyPair { master, slave } = native_pty_system()
            .openpty(size)
            .map_err(|error| format!("cannot open pty: {error}"))?;

        #[cfg(unix)]
        let mut builder = {
            let mut builder = CommandBuilder::new(command);
            builder.args(args.iter().map(String::as_str));
            builder
        };
        #[cfg(windows)]
        let pending_group = crate::windows_process::pending().map_err(|_| "无法准备终端进程")?;
        #[cfg(windows)]
        let mut builder = {
            let helper =
                crate::windows_process::helper_executable().map_err(|_| "无法定位应用程序")?;
            let mut builder = CommandBuilder::new(helper);
            builder.args(pending_group.helper_argv(
                std::ffi::OsStr::new(command),
                args.iter().map(std::ffi::OsString::from),
                true,
            ));
            builder
        };
        builder.cwd(cwd.as_os_str());
        for (name, value) in env {
            builder.env(name.as_str(), value.as_str());
        }
        let mut reader = master
            .try_clone_reader()
            .map_err(|error| format!("cannot clone pty reader: {error}"))?;
        let writer = master
            .take_writer()
            .map_err(|error| format!("cannot take pty writer: {error}"))?;
        if stop.load(Ordering::SeqCst) {
            return Err("AUTH_CANCELLED".into());
        }
        let mut child = slave
            .spawn_command(builder)
            .map_err(|error| format!("cannot spawn {command} on pty: {error}"))?;
        // ConPTY's slave shares the control object's inner Arc. Retire it before
        // the process owner can take the master and claim its destructor ended.
        drop(slave);
        let master: MasterSlot = Arc::new(Mutex::new(Some(master)));
        let pid = child.process_id();
        #[cfg(windows)]
        let group = pending_group
            .attach_or_reap(pid, || {
                let _ = child.kill();
                matches!(child.try_wait(), Ok(Some(_)))
            })
            .map_err(|_| "无法确认终端进程")?;
        #[cfg(unix)]
        let group = crate::process_platform::OwnedGroup;

        let id = format!(
            "pty-{}-{}",
            now_millis(),
            self.counter.fetch_add(1, Ordering::SeqCst)
        );
        crate::logging::info("pty", format_args!("spawn: {id} (pid {pid:?})"));
        let exit: ExitLatch = Arc::new((Mutex::new(None), Condvar::new()));

        // The sole owner keeps Child/group and control-master destruction.
        // portable-pty starts a new session/group; signals never use a name or
        // a persisted PID. Closing callers can time out without dropping owner.
        {
            let exit = exit.clone();
            let stop = stop.clone();
            let id = id.clone();
            let on_output = on_output.clone();
            let master = master.clone();
            thread::spawn(move || {
                let _admission = admission;
                let _group = group;
                let settled = TerminalOwner {
                    child: child.as_mut(),
                    _group: &_group,
                    pid,
                    stop: &stop,
                    master: &master,
                    exit: &exit,
                    id: &id,
                    on_output: &on_output,
                }
                .settle();
                if !settled {
                    // Reap/inactivity was fulfilled first; uncertain master or
                    // receipt still retains this original owner and admission.
                    crate::logging::info("pty", format_args!("terminal cleanup unconfirmed: {id}"));
                    loop {
                        thread::park();
                    }
                }
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
            master,
            #[cfg(test)]
            pid,
            stop,
            exit,
        });
        sessions.insert(id.clone(), session);
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
            .as_ref()
            .ok_or_else(|| "登录终端正在结束，请等待".to_string())?
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

    /// Request exact-owner shutdown and wait for confirmation. A failed wait
    /// retains the session so callers can retry instead of abandoning a child.
    pub fn close(&self, id: &str) -> Result<Option<u32>, String> {
        self.close_with_timeout(id, CLOSE_TIMEOUT)
    }

    fn close_with_timeout(&self, id: &str, timeout: Duration) -> Result<Option<u32>, String> {
        let session = self.lock()?.get(id).cloned();
        if let Some(session) = session {
            session.stop.store(true, Ordering::SeqCst);
            wait_closed(&session, timeout)?;
            let code = *session
                .exit
                .0
                .lock()
                .map_err(|_| "无法读取登录终端退出状态")?;
            self.lock()?.remove(id);
            return Ok(code);
        }
        Ok(None)
    }

    /// Stop all owners first, then share one shutdown budget. Unconfirmed
    /// sessions stay registered; their owner threads continue reaping.
    pub fn stop_for_shutdown(&self) {
        let sessions = match self.lock() {
            Ok(sessions) => {
                self.shutting_down.store(true, Ordering::SeqCst);
                sessions
                    .iter()
                    .map(|(id, session)| (id.clone(), session.clone()))
                    .collect::<Vec<_>>()
            }
            Err(_) => return,
        };
        for (_, session) in &sessions {
            session.stop.store(true, Ordering::SeqCst);
        }
        let deadline = Instant::now() + CLOSE_TIMEOUT;
        for (id, session) in sessions {
            if wait_closed(&session, deadline.saturating_duration_since(Instant::now())).is_ok()
                && let Ok(mut sessions) = self.lock()
            {
                sessions.remove(&id);
            }
        }
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        // Never synchronously destroy the control master or wait here. The
        // process owner retains its own slot and admission through real cleanup.
        let sessions = self
            .sessions
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for session in sessions.values() {
            session.stop.store(true, Ordering::SeqCst);
        }
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

fn wait_closed(session: &PtySession, timeout: Duration) -> Result<(), String> {
    let (slot, changed) = &*session.exit;
    let guard = slot.lock().map_err(|_| "无法确认登录终端已结束")?;
    let (guard, _) = changed
        .wait_timeout_while(guard, timeout, |code| code.is_none())
        .map_err(|_| "无法确认登录终端已结束")?;
    guard
        .as_ref()
        .map(|_| ())
        .ok_or_else(|| "登录终端尚未结束，请重试关闭".into())
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
        _ => crate::process_platform::home_dir()
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

/// Close the exact PTY child without blocking the application event loop.
#[tauri::command]
pub async fn pty_close(app: AppHandle, id: String) -> Result<Option<u32>, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<PtyManager>().close(&id))
        .await
        .map_err(|_| "登录终端关闭未完成".to_string())?
}

#[cfg(all(test, windows))]
mod windows_tests;

#[cfg(test)]
mod master_owner_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::time::{Duration, Instant};

    #[test]
    fn service_configuration_cancelled_before_spawn_creates_no_child() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("must-not-exist");
        let manager = PtyManager::new();
        let result = manager.spawn_controlled(
            "/bin/sh",
            &["-c".into(), format!("touch '{}'", marker.display())],
            &[],
            directory.path(),
            PtySize::default(),
            Arc::new(|_| {}),
            Arc::new(AtomicBool::new(true)),
        );
        if let Ok(id) = &result {
            manager.await_exit(id).unwrap();
            manager.close(id).unwrap();
        }
        assert_eq!(result.unwrap_err(), "AUTH_CANCELLED");
        assert!(!marker.exists());
        assert!(manager.lock().unwrap().is_empty());
    }

    #[test]
    fn service_configuration_shutdown_rejects_a_late_spawn() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("must-not-exist");
        let manager = PtyManager::new();
        manager.stop_for_shutdown();
        let result = manager.spawn_controlled(
            "/bin/sh",
            &["-c".into(), format!("touch '{}'", marker.display())],
            &[],
            directory.path(),
            PtySize::default(),
            Arc::new(|_| {}),
            Arc::new(AtomicBool::new(false)),
        );
        if let Ok(id) = &result {
            manager.await_exit(id).unwrap();
            manager.close(id).unwrap();
        }
        assert!(
            result.is_err(),
            "the shutdown registry must reject late startup"
        );
        assert!(!marker.exists());
        assert!(
            manager
                .spawn(
                    "/bin/sh",
                    &["-c".into(), "exit 0".into()],
                    &[],
                    directory.path(),
                    PtySize::default(),
                    Arc::new(|_| {})
                )
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn service_configuration_cancel_flag_ends_the_exact_running_child() {
        let manager = PtyManager::new();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let sink = Arc::new(move |frame: serde_json::Value| {
            if frame
                .get("data")
                .and_then(|v| v.as_str())
                .and_then(|v| BASE64.decode(v).ok())
                .is_some_and(|v| String::from_utf8_lossy(&v).contains("ready"))
            {
                let _ = ready_tx.send(());
            }
        });
        let stop = Arc::new(AtomicBool::new(false));
        let id = manager
            .spawn_controlled(
                "/bin/sh",
                &[
                    "-c".into(),
                    "trap '' HUP TERM; printf ready; while :; do read token; done".into(),
                ],
                &[],
                Path::new("/tmp"),
                PtySize::default(),
                sink,
                stop.clone(),
            )
            .unwrap();
        if ready_rx.recv_timeout(Duration::from_secs(3)).is_err() {
            manager.close(&id).unwrap();
            panic!("the cancellation fixture did not become ready");
        }
        let session = manager.lock().unwrap().get(&id).unwrap().clone();
        stop.store(true, Ordering::SeqCst);
        let ended = wait_closed(&session, Duration::from_secs(4));
        // Reap the deliberately uncooperative fixture even on the red version.
        if ended.is_err() {
            manager.close(&id).unwrap();
        }
        assert!(
            ended.is_ok(),
            "the same cancellation flag must reach the child owner"
        );
        assert!(manager.close(&id).unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn exit_waits_for_the_exit_sink_before_releasing_the_session() {
        let manager = PtyManager::new();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let completed = Arc::new(AtomicBool::new(false));
        let sink: PtySink = {
            let release = release.clone();
            let completed = completed.clone();
            Arc::new(move |frame| {
                if frame.get("exit").is_none() {
                    return;
                }
                let _ = entered_tx.send(());
                let mut ready = release.0.lock().unwrap();
                while !*ready {
                    ready = release.1.wait(ready).unwrap();
                }
                completed.store(true, Ordering::SeqCst);
            })
        };
        let id = manager
            .spawn(
                "/bin/sh",
                &["-c".into(), "exit 0".into()],
                &[],
                Path::new("/tmp"),
                PtySize::default(),
                sink,
            )
            .unwrap();
        let entered = entered_rx.recv_timeout(Duration::from_secs(3));
        let published_before_cleanup = manager
            .lock()
            .unwrap()
            .get(&id)
            .unwrap()
            .exit
            .0
            .lock()
            .unwrap()
            .is_some();
        // Always release the real child owner before an assertion, including
        // on the red version. The gate, rather than a sleep, fixes the order.
        *release.0.lock().unwrap() = true;
        release.1.notify_all();
        let code = manager.await_exit(&id).unwrap();
        assert!(entered.is_ok(), "the exact child must reach its exit sink");
        assert!(
            !published_before_cleanup,
            "await/close must not receive an exit receipt before its sink releases ownership"
        );
        assert!(completed.load(Ordering::SeqCst));
        assert_eq!(code, 0);
        assert!(!manager.lock().unwrap().contains_key(&id));
    }

    #[cfg(unix)]
    #[test]
    fn close_preserves_a_terminal_that_already_exited_successfully() {
        let manager = PtyManager::new();
        let id = manager
            .spawn(
                "/bin/sh",
                &["-c".into(), "exit 0".into()],
                &[],
                Path::new("/tmp"),
                PtySize::default(),
                Arc::new(|_| {}),
            )
            .unwrap();
        let session = manager.lock().unwrap().get(&id).unwrap().clone();
        wait_closed(&session, Duration::from_secs(3)).unwrap();
        assert_eq!(manager.close(&id).unwrap(), Some(0));
        assert_eq!(manager.close(&id).unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn close_reaps_a_child_that_ignores_hangup_and_terminate() {
        let manager = Arc::new(PtyManager::new());
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let sink: PtySink = Arc::new(move |frame| {
            if frame
                .get("data")
                .and_then(|v| v.as_str())
                .and_then(|v| BASE64.decode(v).ok())
                .is_some_and(|v| String::from_utf8_lossy(&v).contains("ready"))
            {
                let _ = ready_tx.send(());
            }
        });
        let id = manager
            .spawn(
                "/bin/sh",
                &[
                    "-c".into(),
                    "trap '' HUP TERM; printf ready; while :; do read token; done".into(),
                ],
                &[],
                Path::new("/tmp"),
                PtySize::default(),
                sink,
            )
            .unwrap();
        ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let session = manager.lock().unwrap().get(&id).unwrap().clone();
        assert!(manager.close_with_timeout(&id, Duration::ZERO).is_err());
        assert!(
            manager.lock().unwrap().contains_key(&id),
            "unconfirmed close must retain its owner for retry"
        );
        let started = Instant::now();
        let result = manager.close(&id);
        let reaped = session.exit.0.lock().unwrap().is_some();
        // Always clean up the deliberately uncooperative fixture, even before
        // the regression is fixed. No Agent process is involved.
        if !reaped && let Some(pid) = session.pid {
            crate::supervisor::signal_owned_group(pid, crate::supervisor::KILL);
        }
        result.unwrap();
        assert!(reaped, "close must not report success before child reaping");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!manager.lock().unwrap().contains_key(&id));
    }

    #[cfg(unix)]
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
