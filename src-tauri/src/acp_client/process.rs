//! Exact Child ownership around the official SDK byte-stream transport.
use super::{lifecycle::ConnectionLife, tap::DebugTap};
use crate::supervisor;
use agent_client_protocol::{AcpAgent, Agent, ByteStreams, Channel, Client, ConnectTo};
use std::{
    os::fd::AsRawFd,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;

#[derive(Clone)]
pub(crate) struct ProcessControl {
    pub pid: Arc<AtomicU32>,
    started: Arc<AtomicBool>,
    stop: watch::Sender<bool>,
    done: watch::Sender<Option<Result<(), String>>>,
}
impl ProcessControl {
    pub fn new() -> Self {
        Self {
            pid: Arc::new(AtomicU32::new(0)),
            started: Arc::new(AtomicBool::new(false)),
            stop: watch::channel(false).0,
            done: watch::channel(None).0,
        }
    }
    pub fn stop(&self) {
        self.stop.send_replace(true);
    }
    pub async fn closed(&self) -> Result<(), String> {
        if !self.started.load(Ordering::SeqCst) {
            return Ok(());
        }
        let mut done = self.done.subscribe();
        loop {
            if let Some(result) = done.borrow().clone() {
                return result;
            }
            done.changed()
                .await
                .map_err(|_| "无法确认连接进程已结束".to_string())?;
        }
    }
}
struct StopOnDrop(ProcessControl);
impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.stop();
    }
}
struct KillOnDrop {
    pid: u32,
    drain_stop: Arc<AtomicBool>,
    armed: bool,
}
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        self.drain_stop.store(true, Ordering::SeqCst);
        if self.armed {
            supervisor::signal_owned_group(self.pid, libc::SIGKILL);
        }
    }
}

pub(crate) struct ProcessTransport {
    pub agent: AcpAgent,
    pub control: ProcessControl,
    pub life: Arc<ConnectionLife>,
    pub data_dir: PathBuf,
    pub agent_id: String,
    pub cwd: String,
    pub tap: Option<Arc<Mutex<DebugTap>>>,
}
impl ConnectTo<Client> for ProcessTransport {
    async fn connect_to(
        self,
        client: impl ConnectTo<Agent>,
    ) -> Result<(), agent_client_protocol::Error> {
        let (stdin, stdout, stderr, mut child) = self.agent.spawn_process()?;
        let pid = child.id();
        let drain_stop = Arc::new(AtomicBool::new(false));
        let mut guard = KillOnDrop {
            pid,
            drain_stop: drain_stop.clone(),
            armed: true,
        };
        self.control.pid.store(pid, Ordering::SeqCst);
        self.control.started.store(true, Ordering::SeqCst);
        let process = self.control.clone();
        let _stop_on_drop = StopOnDrop(process.clone());
        let mut stop = process.stop.subscribe();
        let mut connection_stop = self.life.stop_receiver();
        let data_dir = self.data_dir;
        // A bounded channel contains safe records only. Filesystem diagnostics
        // cannot hold stdout/stderr or delay process termination.
        let diagnostics = self.tap.map(|tap| {
            let (send, receive) = std::sync::mpsc::sync_channel::<serde_json::Value>(64);
            std::thread::spawn(move || {
                while let Ok(record) = receive.recv() {
                    if let Ok(mut tap) = tap.lock() {
                        tap.write_record(&record);
                    }
                }
            });
            send
        });
        let stderr_records = diagnostics.clone();
        // This is genuinely blocking OS IO, isolated from protocol workers. Poll
        // bounds shutdown even when a descendant holds stderr open indefinitely.
        let drain = std::thread::spawn(move || {
            let fd = stderr.as_raw_fd();
            let mut buffer = [0u8; 8192];
            while !drain_stop.load(Ordering::SeqCst) {
                let mut descriptor = libc::pollfd {
                    fd,
                    events: libc::POLLIN,
                    revents: 0,
                };
                let ready = unsafe { libc::poll(&mut descriptor, 1, 50) };
                if ready < 0 {
                    break;
                }
                if ready == 0 {
                    continue;
                }
                let read = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
                if read == 0 {
                    break;
                }
                if read < 0 {
                    continue;
                }
                if let Some(records) = &stderr_records {
                    let _ = records.try_send(serde_json::json!({"version":1,"ts":super::tap::now_millis(),"dir":"err","event":"other","bytes":read,"error":"stderr"}));
                }
            }
        });
        // This one task owns the exact Child until wait/reap completes. Dropping
        // protocol futures only requests shutdown; it never abandons the Child.
        let done = process.done.clone();
        let (registered, registration_result) = tokio::sync::oneshot::channel();
        let command = self.agent.config().command().to_string_lossy().into_owned();
        super::manager::runtime().spawn(async move {
            let registration_dir = data_dir.clone();
            let mut registration_task = tauri::async_runtime::spawn_blocking(move || {
                supervisor::register_pid(&registration_dir, &self.agent_id, &self.cwd, &command, pid)
            });
            let mut exit = None;
            let mut unexpected_exit = false;
            let registration = if *stop.borrow() || *connection_stop.borrow() { None } else {
                tokio::select! {
                    result = &mut registration_task => Some(result.map_err(|_| "无法保存连接进程".to_string()).and_then(|result| result)),
                    value = child.status() => { exit = Some(value); unexpected_exit = true; None },
                    _ = stop.changed() => None,
                    _ = connection_stop.changed() => None,
                }
            };
            let registered_ok = matches!(registration, Some(Ok(_)));
            let _ = registered.send(match &registration {
                Some(result) => result.as_ref().map(|_| ()).map_err(Clone::clone),
                None => Err("连接已结束".to_string()),
            });
            if registered_ok && !*stop.borrow() && !*connection_stop.borrow() {
                tokio::select! {
                    value = child.status() => { exit = Some(value); unexpected_exit = true; }
                    _ = stop.changed() => {}
                    _ = connection_stop.changed() => {}
                }
            }
            supervisor::signal_owned_group(pid, libc::SIGTERM);
            guard.drain_stop.store(true, Ordering::SeqCst);
            // The drain performs only poll/read and bounded try_send. It owns
            // stderr until this bounded join; diagnostic writes are independent.
            let draining = tauri::async_runtime::spawn_blocking(move || drain.join());
            let started = tokio::time::Instant::now();
            let mut killed = false;
            loop {
                if exit.is_none() {
                    exit = child.try_status().transpose();
                }
                if exit.is_some() && !supervisor::owned_group_alive(pid) {
                    break;
                }
                if !killed && started.elapsed() >= Duration::from_secs(2) {
                    supervisor::signal_owned_group(pid, libc::SIGKILL);
                    killed = true;
                }
                // The caller stops waiting after five seconds, while this exact
                // owner stays alive until reap and group termination are facts.
                tokio::time::sleep(Duration::from_millis(
                    if started.elapsed() < Duration::from_secs(5) {
                        25
                    } else {
                        250
                    },
                ))
                .await;
            }
            guard.armed = false;
            let _ = tokio::time::timeout(Duration::from_millis(100), draining).await;
            let outcome = if unexpected_exit
                && !exit
                    .as_ref()
                    .is_some_and(|r| r.as_ref().is_ok_and(|s| s.success()))
            {
                Err("Agent 已意外退出".to_string())
            } else {
                Ok(())
            };
            // Completion is an OS fact. A slow registry filesystem must not
            // keep a reaped process alive in the manager's state.
            drop(guard);
            done.send_replace(Some(outcome));
            let registration = match registration {
                Some(result) => result,
                None => registration_task.await.map_err(|_| "无法保存连接进程".to_string()).and_then(|result| result),
            };
            if let Ok(registration) = registration {
                let _ = tauri::async_runtime::spawn_blocking(move || supervisor::unregister_pid(&data_dir, &registration)).await;
            }

        });
        registration_result
            .await
            .map_err(|_| agent_client_protocol::util::internal_error("无法确认连接进程"))?
            .map_err(agent_client_protocol::util::internal_error)?;
        let transport = ByteStreams::new(stdin, stdout);
        let (wire, wire_future) = ConnectTo::<Client>::into_channel_and_future(transport);
        let (endpoint, endpoint_future) = client.into_channel_and_future();
        let outgoing_records = diagnostics.clone();
        let incoming_records = diagnostics;
        let bridge = Channel::bridge_with_inspection(
            endpoint,
            wire,
            move |message| {
                if let Some(records) = &outgoing_records
                    && let Ok(line) = serde_json::to_string(message)
                {
                    let _ = records.try_send(super::tap::diagnostic_record(&line, "out"));
                }
                Ok(())
            },
            move |message| {
                if let Some(records) = &incoming_records
                    && let Ok(line) = serde_json::to_string(message)
                {
                    let _ = records.try_send(super::tap::diagnostic_record(&line, "in"));
                }
                Ok(())
            },
        );
        tokio::select! {
            outcome = async { tokio::try_join!(wire_future, endpoint_future, bridge).map(|_| ()) } => outcome,
            outcome = process.closed() => outcome.map_err(agent_client_protocol::util::internal_error),
        }
    }
}
