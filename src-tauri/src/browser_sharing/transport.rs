//! One authenticated local MCP connection. The helper owns its standard stdout.
//! Shared-page stop succeeds only after the helper acknowledges its output gate.
//! No page content or bearer secret is logged or persisted by this module.
use super::{
    channel::{self, Listener, Stream, poll_ready, wait_fd},
    helper,
    permission::PermissionWait,
    protocol,
};
use crate::browser_workspace::{FixedPageReadScope, ToolFailure, ToolRequest};
use agent_client_protocol::schema::v1::{EnvVariable, McpServerStdio};
use serde_json::Value;
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::sync::{oneshot, watch};

#[path = "transport_admission.rs"]
mod admission;

#[cfg(target_os = "macos")]
#[path = "transport_uds.rs"]
mod uds;
#[cfg(target_os = "macos")]
pub(super) type PeerCheck = Arc<dyn Fn(&Stream) -> bool + Send + Sync>;

#[cfg(test)]
#[path = "transport_lifecycle_tests.rs"]
mod lifecycle_tests;

const BOOTSTRAP_TTL: Duration = Duration::from_secs(180);
const WRITE_WAIT: Duration = Duration::from_secs(1);
const MAX_REQUEST: usize = 65_536;
const MAX_RESPONSE: usize = 600_000;
pub(crate) type SharedPage = Arc<Mutex<Option<FixedPageReadScope>>>;
pub(super) type Callback = Arc<dyn Fn() + Send + Sync>;
pub(super) type Closed = Arc<dyn Fn(bool) + Send + Sync>;
pub(super) type Permission =
    Arc<dyn Fn(&ToolRequest) -> Result<PermissionWait, String> + Send + Sync>;
pub(super) type Invalidated = Arc<dyn Fn(FixedPageReadScope) + Send + Sync>;

fn operation_error_reply(id: Value, control: bool, error: ToolFailure) -> Value {
    match (control, error) {
        (true, ToolFailure::ControlNotApplied(reason)) => {
            protocol::control_not_applied(id, &reason)
        }
        (true, _) => protocol::control_unknown(id),
        (false, ToolFailure::ScreenshotUnavailable) => protocol::tool_error(
            id,
            "本次无法安全提供网页截图，未返回网页内容。如需文字，请另行请求观察。",
        ),
        (false, _) => protocol::tool_error(
            id,
            "网页读取或观察的结果未确认，请等待或关闭网页；不要自动重试",
        ),
    }
}

fn permission_error_reply(id: Value, control: bool, error: &str) -> Value {
    if control {
        // The permission callback failed before any operation was started.
        protocol::control_not_applied(id, error)
    } else {
        protocol::tool_error(id, "请先在当前对话中打开可读取的公开网页")
    }
}

/// Consumed exactly once into the official request. Intentionally no Debug/Clone.
pub(crate) struct HelperLaunch {
    name: String,
    command: PathBuf,
    endpoint: PathBuf,
    capability: String,
}
impl HelperLaunch {
    pub(crate) fn into_server(self) -> McpServerStdio {
        McpServerStdio::new(self.name, self.command)
            .args(vec![
                helper::MODE.into(),
                self.endpoint.to_string_lossy().into_owned(),
            ])
            .env(vec![EnvVariable::new(
                helper::CAPABILITY_ENV,
                self.capability,
            )])
    }
}
#[derive(Clone)]
pub(crate) struct TransportHandle(Arc<HandleInner>);
struct HandleInner {
    page: SharedPage,
    controls: mpsc::Sender<Control>,
    shutdown: Arc<AtomicBool>,
    completed: watch::Receiver<u8>,
    #[cfg(target_os = "macos")]
    initialized: Arc<AtomicBool>,
    #[cfg(target_os = "macos")]
    listed: Arc<AtomicBool>,
}
enum Control {
    Quiesce(Option<oneshot::Sender<Result<(), String>>>),
}
fn revoke_page(page: &SharedPage) {
    let old = page.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(scope) = old {
        scope.revoke();
    }
}
impl Drop for HandleInner {
    fn drop(&mut self) {
        revoke_page(&self.page);
        self.shutdown.store(true, Ordering::Release);
    }
}
impl TransportHandle {
    #[cfg(target_os = "macos")]
    pub(crate) fn locally_ready(&self) -> bool {
        self.0.initialized.load(Ordering::Acquire)
            && self.0.listed.load(Ordering::Acquire)
            && *self.0.completed.borrow() == 0
    }
    /// Cancels observation/output pending before this barrier. A partial JSON
    /// reply closes the transport; on_closed is called before this ACK.
    pub(crate) async fn quiesce(&self) -> Result<(), String> {
        revoke_page(&self.0.page);
        if *self.0.completed.borrow() != 0 {
            return self.closed().await;
        }
        let (send, receive) = oneshot::channel();
        if self.0.controls.send(Control::Quiesce(Some(send))).is_err() {
            return self.closed().await;
        }
        match tokio::time::timeout(Duration::from_secs(3), receive).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => self.closed().await,
            Err(_) => Err("停止共享尚未确认，请重试".into()),
        }
    }
    pub(crate) fn shutdown(&self) {
        revoke_page(&self.0.page);
        self.0.shutdown.store(true, Ordering::Release);
    }
    pub(crate) async fn closed(&self) -> Result<(), String> {
        let mut done = self.0.completed.clone();
        tokio::time::timeout(Duration::from_secs(3), async {
            while *done.borrow() == 0 {
                done.changed()
                    .await
                    .map_err(|_| "网页工具关闭尚未确认".to_owned())?;
            }
            if *done.borrow() == 1 {
                Ok(())
            } else {
                Err("停止共享尚未确认，请重试".into())
            }
        })
        .await
        .map_err(|_| "网页工具关闭尚未确认，请重试".to_owned())?
    }
}

pub(super) fn start(
    app: AppHandle,
    page: SharedPage,
    on_ready: Callback,
    on_closed: Closed,
    on_permission: Permission,
    on_invalidated: Invalidated,
) -> Result<(TransportHandle, HelperLaunch), String> {
    let channel::Endpoint {
        guard: directory,
        listener,
        path: endpoint,
        name,
    } = channel::create().map_err(|_| "无法准备网页工具".to_owned())?;
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| "无法准备临时读取许可")?;
    let capability: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    random.fill(0);
    let name = format!("farfold_page_{name}");
    let launch = HelperLaunch {
        name,
        command: std::env::current_exe().map_err(|_| "找不到网页工具程序".to_owned())?,
        endpoint,
        capability: capability.clone(),
    };
    let shutdown = Arc::new(AtomicBool::new(false));
    let (controls, control_rx) = mpsc::channel();
    let (completed_tx, completed) = watch::channel(0u8);
    let handle = TransportHandle(Arc::new(HandleInner {
        page: page.clone(),
        controls,
        shutdown: shutdown.clone(),
        completed,
        #[cfg(target_os = "macos")]
        initialized: Arc::new(AtomicBool::new(false)),
        #[cfg(target_os = "macos")]
        listed: Arc::new(AtomicBool::new(false)),
    }));
    std::thread::Builder::new()
        .name("farfold-page-mcp".into())
        .spawn(move || {
            let _directory = directory;
            let mut worker = Worker {
                app,
                page,
                shutdown,
                controls: control_rx,
                on_ready,
                #[cfg(target_os = "macos")]
                on_initialized: None,
                on_closed,
                on_permission,
                on_invalidated,
                closed_notified: false,
            };
            let clean = worker.accept(listener, capability);
            worker.notify_closed(clean);
            let _ = completed_tx.send(if clean { 1 } else { 2 });
        })
        .map_err(|_| "无法启动网页工具".to_owned())?;
    Ok((handle, launch))
}

#[cfg(target_os = "macos")]
#[path = "transport_uds_start.rs"]
mod uds_start;
#[cfg(target_os = "macos")]
pub(super) use uds_start::{LocalEndpoint, start_uds};

struct Worker {
    app: AppHandle,
    page: SharedPage,
    shutdown: Arc<AtomicBool>,
    controls: mpsc::Receiver<Control>,
    on_ready: Callback,
    #[cfg(target_os = "macos")]
    on_initialized: Option<Callback>,
    on_closed: Closed,
    on_permission: Permission,
    on_invalidated: Invalidated,
    closed_notified: bool,
}
struct Packet {
    bytes: Vec<u8>,
    written: usize,
    deadline: Instant,
    scope: Option<FixedPageReadScope>,
    delivery: Option<u64>,
    id: Value,
    // Derived from the issued ToolRequest, never from page-owned JSON fields.
    control: bool,
}
impl Packet {
    fn message(
        value: Value,
        scope: Option<FixedPageReadScope>,
        delivery: Option<u64>,
        id: Value,
    ) -> Result<Self, ()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| ())?;
        if bytes.len() > 1_300_000 {
            return Err(());
        }
        bytes.push(b'\n');
        Ok(Self {
            bytes,
            written: 0,
            deadline: Instant::now() + WRITE_WAIT,
            scope,
            delivery,
            id,
            control: false,
        })
    }

    fn withdraw_invalid(&mut self) -> Result<Option<FixedPageReadScope>, ()> {
        let Some(scope) = self
            .scope
            .as_ref()
            .filter(|scope| self.written == 0 && !scope.is_valid())
            .cloned()
        else {
            return Ok(None);
        };
        let number = self.delivery.ok_or(())?;
        let control = self.control;
        let message = if control {
            protocol::control_unknown(self.id.clone())
        } else {
            protocol::tool_error(self.id.clone(), "读取许可已停止")
        };
        let mut replacement = Self::message(
            serde_json::json!({"kind":"response","delivery":number,"page":false,"control":control,"message":message}),
            None,
            Some(number),
            self.id.clone(),
        )?;
        replacement.control = control;
        *self = replacement;
        Ok(Some(scope))
    }
}
struct Delivery {
    id: Value,
    number: u64,
    list: bool,
    scope: Option<FixedPageReadScope>,
}
struct WaitingRead {
    id: Value,
    permission: PermissionWait,
    request: ToolRequest,
}

struct PendingRead {
    id: Value,
    scope: FixedPageReadScope,
    result: mpsc::Receiver<Result<Value, ToolFailure>>,
    task: tauri::async_runtime::JoinHandle<()>,
    request: ToolRequest,
    finished: Arc<AtomicBool>,
}
impl Drop for PendingRead {
    fn drop(&mut self) {
        if !self.finished.load(Ordering::Acquire) {
            self.scope.cancel_action();
        }
        self.task.abort();
    }
}
struct Barrier {
    number: u64,
    close: bool,
    deadline: Instant,
    replies: Vec<oneshot::Sender<Result<(), String>>>,
}
#[derive(Default)]
struct Wire {
    next: u64,
    packets: std::collections::VecDeque<Packet>,
    delivery: Option<Delivery>,
    pending: Option<PendingRead>,
    waiting: Option<WaitingRead>,
    barrier: Option<Barrier>,
    deferred: Option<protocol::Action>,
    screenshot_receipt: Option<(Value, super::screenshot_owner::ScreenshotRetirement)>,
}
impl Wire {
    fn defer_during_stop(&mut self, action: protocol::Action) -> Result<(), ()> {
        // A request arriving during stop cannot capture a later grant.
        let action = match action {
            protocol::Action::Read { id, .. } => protocol::Action::Reply {
                value: protocol::tool_error(id, "读取许可已停止"),
                list: false,
            },
            other => other,
        };
        if self.deferred.replace(action).is_some() {
            Err(())
        } else {
            Ok(())
        }
    }
    fn cancel(&mut self, id: &Value) -> Result<(), ()> {
        let waiting = self.waiting.as_ref().is_some_and(|p| &p.id == id);
        let reading = self.pending.as_ref().is_some_and(|p| &p.id == id);
        if waiting || reading {
            let control = self.pending.as_ref().is_some_and(|p| p.request.control());
            self.waiting = None;
            self.pending = None;
            self.reply(
                if control {
                    protocol::control_unknown(id.clone())
                } else {
                    protocol::tool_error(id.clone(), "网页读取已取消")
                },
                None,
                false,
            )?;
        }
        // A response already queued for output must pass the same revocation
        // barrier as explicit stop. No success is synthesized from enqueueing.
        if let Some(delivery) = self.delivery.as_ref().filter(|p| &p.id == id)
            && let Some(scope) = delivery.scope.clone()
        {
            scope.cancel_action();
            self.stop(false, None)?;
        }
        Ok(())
    }
    fn serial(&mut self) -> Result<u64, ()> {
        self.next = self.next.checked_add(1).ok_or(())?;
        Ok(self.next)
    }
    fn reply(
        &mut self,
        value: Value,
        scope: Option<FixedPageReadScope>,
        list: bool,
    ) -> Result<(), ()> {
        self.reply_kind(value, scope, list, false)
    }
    fn control_reply(&mut self, value: Value, scope: FixedPageReadScope) -> Result<(), ()> {
        self.reply_kind(value, Some(scope), false, true)
    }
    fn reply_kind(
        &mut self,
        value: Value,
        scope: Option<FixedPageReadScope>,
        list: bool,
        control: bool,
    ) -> Result<(), ()> {
        if self.delivery.is_some() {
            return Err(());
        }
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let scope = scope.map(|scope| scope.request_scope());
        let (value, scope) = if serde_json::to_vec(&value).map_err(|_| ())?.len() >= MAX_RESPONSE {
            (
                protocol::tool_error(id.clone(), "网页内容过大，读取未完成"),
                None,
            )
        } else {
            (value, scope)
        };
        let number = self.serial()?;
        let mut packet = Packet::message(
            serde_json::json!({"kind":"response","delivery":number,"page":scope.is_some(),"control":control,"message":value}),
            scope.clone(),
            Some(number),
            id.clone(),
        )?;
        packet.control = control;
        self.packets.push_back(packet);
        self.delivery = Some(Delivery {
            id,
            number,
            list,
            scope,
        });
        Ok(())
    }
    fn stop(
        &mut self,
        close: bool,
        reply: Option<oneshot::Sender<Result<(), String>>>,
    ) -> Result<(), ()> {
        if let Some(barrier) = self.barrier.as_mut() {
            if let Some(reply) = reply {
                barrier.replies.push(reply);
            }
            return Ok(());
        }
        if let Some(old) = self.waiting.take() {
            let id = old.id.clone();
            drop(old);
            self.reply(protocol::tool_error(id, "读取许可已停止"), None, false)?;
        }
        if let Some(old) = self.pending.take() {
            let id = old.id.clone();
            let control = old.request.control();
            drop(old);
            self.reply(
                if control {
                    protocol::control_unknown(id)
                } else {
                    protocol::tool_error(id, "读取许可已停止")
                },
                None,
                false,
            )?;
        }
        let number = self.serial()?;
        self.packets.push_back(Packet::message(
            serde_json::json!({"kind":"stop","barrier":number,"close":close}),
            None,
            None,
            Value::Null,
        )?);
        self.barrier = Some(Barrier {
            number,
            close,
            deadline: Instant::now() + Duration::from_millis(2500),
            replies: reply.into_iter().collect(),
        });
        Ok(())
    }
}
fn notify_page_closed(page: &SharedPage, callback: &Closed, confirmed: bool) {
    // The registry owns active -> retiring. Preserve the exact scope until its
    // callback has recorded an unconfirmed transport exit.
    let scope = page.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(scope) = scope {
        scope.revoke();
    }
    callback(confirmed);
}
impl Worker {
    fn notify_closed(&mut self, confirmed: bool) {
        if !self.closed_notified {
            self.closed_notified = true;
            notify_page_closed(&self.page, &self.on_closed, confirmed);
        }
    }
    fn accept(&mut self, listener: Listener, capability: String) -> bool {
        let deadline = Instant::now() + BOOTSTRAP_TTL;
        while Instant::now() < deadline && !self.shutdown.load(Ordering::Acquire) {
            while let Ok(Control::Quiesce(reply)) = self.controls.try_recv() {
                // No authenticated helper has received any page result yet.
                if let Some(reply) = reply {
                    let _ = reply.send(Ok(()));
                }
            }
            match listener.accept() {
                Ok((mut channel, _)) => {
                    #[cfg(all(test, windows))]
                    eprintln!("FARFOLD_P27_CHANNEL_PHASE accepted");
                    let _ = channel.set_read_timeout(Some(Duration::from_millis(100)));
                    let _ = channel.set_write_timeout(Some(Duration::from_secs(1)));
                    let Ok(hello) = read_hello(&mut channel) else {
                        #[cfg(all(test, windows))]
                        eprintln!("FARFOLD_P27_CHANNEL_PHASE hello-read-failed");
                        continue;
                    };
                    let received = hello
                        .get("capability")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if hello.get("kind").and_then(Value::as_str) != Some("hello")
                        || hello.as_object().is_none_or(|object| object.len() != 2)
                        || !same_capability(received.as_bytes(), capability.as_bytes())
                        || Instant::now() >= deadline
                        || self.shutdown.load(Ordering::Acquire)
                    {
                        #[cfg(all(test, windows))]
                        eprintln!("FARFOLD_P27_CHANNEL_PHASE hello-rejected");
                        continue;
                    }
                    // One successful authentication consumes this listener/capability.
                    if channel.write_all(b"{\"kind\":\"hello_ack\"}\n").is_err() {
                        #[cfg(all(test, windows))]
                        eprintln!("FARFOLD_P27_CHANNEL_PHASE hello-ack-failed");
                        return false;
                    }
                    if channel.set_nonblocking(true).is_err() {
                        #[cfg(all(test, windows))]
                        eprintln!("FARFOLD_P27_CHANNEL_PHASE nonblocking-failed");
                        return false;
                    }
                    #[cfg(all(test, windows))]
                    eprintln!("FARFOLD_P27_CHANNEL_PHASE authenticated-serving");
                    drop(listener);
                    return self.serve(channel);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    wait_fd(channel::listener_token(&listener), channel::READ, 50)
                }
                Err(error) => {
                    #[cfg(all(test, windows))]
                    eprintln!(
                        "FARFOLD_P27_CHANNEL_PHASE accept-failed {:?}",
                        error.raw_os_error()
                    );
                    let _ = error;
                    return true;
                }
            }
        }
        true
    }
    fn act(&mut self, action: protocol::Action, wire: &mut Wire) -> bool {
        match action {
            protocol::Action::None => {}
            protocol::Action::Reply { value, list } => {
                if wire.reply(value, None, list).is_err() {
                    return false;
                }
            }
            protocol::Action::Cancel { id } => {
                // Cancelling one call withdraws only its request gate. Page
                // ownership and the user's original grant remain independent.
                if wire.cancel(&id).is_err() {
                    return false;
                }
            }
            protocol::Action::Read { id, request } => {
                match wire.admit_read(id, request, &self.page, self.on_permission.as_ref()) {
                    Ok(Some(read)) => self.begin_read(read.id, read.scope, read.request, wire),
                    Ok(None) => {}
                    Err(()) => return false,
                }
            }
        }
        true
    }
    fn begin_read(
        &self,
        id: Value,
        scope: FixedPageReadScope,
        request: ToolRequest,
        wire: &mut Wire,
    ) {
        let scope = scope.request_scope();
        let (send, receive) = mpsc::channel();
        let observer = scope.clone();
        let app = self.app.clone();
        let finished = Arc::new(AtomicBool::new(false));
        let finished_task = finished.clone();
        let operation = request.clone();
        let task = tauri::async_runtime::spawn(async move {
            let result = observer.tool(&app, operation).await;
            finished_task.store(true, Ordering::Release);
            let _ = send.send(result);
        });
        wire.pending = Some(PendingRead {
            id,
            scope,
            result: receive,
            task,
            request,
            finished,
        });
    }
    fn permission_result(&self, wire: &mut Wire) -> bool {
        match wire.approved_read() {
            Ok(Some(read)) => self.begin_read(read.id, read.scope, read.request, wire),
            Ok(None) => {}
            Err(()) => return false,
        }
        true
    }

    fn serve(&mut self, mut channel: Stream) -> bool {
        let mut protocol = protocol::Protocol::new(
            crate::browser_workspace::screenshot_capability::for_mcp_worker(&self.app),
        );
        let mut input = Vec::new();
        let mut wire = Wire::default();
        loop {
            if self.shutdown.load(Ordering::Acquire) && wire.stop(true, None).is_err() {
                return false;
            }
            while let Ok(Control::Quiesce(reply)) = self.controls.try_recv() {
                if wire.stop(false, reply).is_err() {
                    return false;
                }
            }
            if wire
                .barrier
                .as_ref()
                .is_some_and(|barrier| Instant::now() >= barrier.deadline)
            {
                return false;
            }
            if wire.barrier.is_none()
                && wire.delivery.is_none()
                && wire.pending.is_none()
                && wire.waiting.is_none()
                && let Some(action) = wire.deferred.take()
                && !self.act(action, &mut wire)
            {
                return false;
            }
            if wire.delivery.is_none()
                && let Some(read) = wire.pending.as_ref()
            {
                match read.result.try_recv() {
                    Ok(result) => {
                        let id = read.id.clone();
                        let scope = read.scope.clone();
                        let control = read.request.control();
                        wire.pending = None;
                        let (value, grant) = match result {
                            Ok(page) => (protocol::snapshot(id, page), Some(scope)),
                            Err(error) => {
                                if !scope.grant_is_valid() {
                                    (self.on_invalidated)(scope);
                                }
                                let value = operation_error_reply(id, control, error);
                                (value, None)
                            }
                        };
                        let reply = match grant {
                            Some(scope) if control => wire.control_reply(value, scope),
                            grant => wire.reply(value, grant, false),
                        };
                        if reply.is_err() {
                            return false;
                        }
                    }
                    Err(mpsc::TryRecvError::Disconnected) => {
                        let id = read.id.clone();
                        let control = read.request.control();
                        wire.pending = None;
                        if wire
                            .reply(
                                operation_error_reply(id, control, ToolFailure::Unconfirmed),
                                None,
                                false,
                            )
                            .is_err()
                        {
                            return false;
                        }
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            }
            // Read control traffic before attempting an outgoing response. A stop
            // acknowledgement is never inferred from socket EOF or queued writes.
            if poll_ready(channel::token(&channel), channel::READ) {
                let mut bytes = [0u8; 8192];
                match channel.read(&mut bytes) {
                    Ok(0) => return false,
                    Ok(count) => {
                        input.extend_from_slice(&bytes[..count]);
                        if input.len() > 1_300_000 {
                            return false;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => return false,
                }
            }
            while let Some(end) = input.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = input.drain(..=end).collect();
                let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                    return false;
                };
                match message.get("kind").and_then(Value::as_str) {
                    Some("written") => {
                        let Some(number) = message.get("delivery").and_then(Value::as_u64) else {
                            return false;
                        };
                        if wire.acknowledge_written(number) == Some(true)
                            && protocol.mark_list_delivered()
                        {
                            (self.on_ready)();
                        }
                    }
                    Some("stopped") => {
                        let Some(number) = message.get("barrier").and_then(Value::as_u64) else {
                            return false;
                        };
                        let Some(stdout_closed) =
                            message.get("stdoutClosed").and_then(Value::as_bool)
                        else {
                            return false;
                        };
                        if wire
                            .barrier
                            .as_ref()
                            .is_some_and(|barrier| barrier.number == number)
                        {
                            let barrier = wire.barrier.take().expect("checked barrier");
                            if barrier.close && !stdout_closed {
                                return false;
                            }
                            if wire
                                .delivery
                                .as_ref()
                                .is_some_and(|delivery| delivery.scope.is_some())
                            {
                                let delivery = wire.delivery.take().expect("checked delivery");
                                wire.finish_screenshot(&delivery.id);
                            }
                            wire.finish_stopped_screenshot();
                            if stdout_closed {
                                drop(channel);
                                self.notify_closed(true);
                                for reply in barrier.replies {
                                    let _ = reply.send(Ok(()));
                                }
                                return true;
                            }
                            for reply in barrier.replies {
                                let _ = reply.send(Ok(()));
                            }
                        }
                    }
                    Some("request") => {
                        let Some(request) = message.get("message").cloned() else {
                            return false;
                        };
                        if serde_json::to_vec(&request)
                            .map_or(true, |bytes| bytes.len() > MAX_REQUEST)
                        {
                            return false;
                        }
                        let action = protocol.receive(request);
                        if wire.barrier.is_some()
                            && !matches!(
                                action,
                                protocol::Action::None | protocol::Action::Cancel { .. }
                            )
                        {
                            if wire.defer_during_stop(action).is_err() {
                                return false;
                            }
                        } else if !self.act(action, &mut wire) {
                            return false;
                        }
                    }
                    _ => return false,
                }
            }
            // Consume cancellation and stop traffic before an allowed request
            // can start observing. The original request id never changes.
            if wire.barrier.is_none()
                && wire.delivery.is_none()
                && !self.permission_result(&mut wire)
            {
                return false;
            }
            if let Some(packet) = wire.packets.front_mut() {
                if Instant::now() >= packet.deadline {
                    return false;
                }
                let Ok(withdrawn) = packet.withdraw_invalid() else {
                    return false;
                };
                if let Some(scope) = withdrawn {
                    if let Some(delivery) = wire.delivery.as_mut() {
                        delivery.scope = None;
                    }
                    if !scope.grant_is_valid() {
                        (self.on_invalidated)(scope);
                    }
                }
                if poll_ready(channel::token(&channel), channel::WRITE) {
                    match channel.write(&packet.bytes[packet.written..]) {
                        Ok(0) => return false,
                        Ok(count) => {
                            packet.written += count;
                            if packet.written == packet.bytes.len() {
                                wire.packets.pop_front();
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(_) => return false,
                    }
                }
            }
            let events = channel::READ
                | if wire.packets.is_empty() {
                    0
                } else {
                    channel::WRITE
                };
            wait_fd(channel::token(&channel), events, 50);
        }
    }
}
fn same_capability(left: &[u8], right: &[u8]) -> bool {
    if left.len() != 64 || right.len() != 64 {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}
fn read_hello(channel: &mut Stream) -> Result<Value, ()> {
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut bytes = Vec::new();
    loop {
        if Instant::now() >= deadline || bytes.len() > 512 {
            return Err(());
        }
        let mut byte = [0u8];
        match channel.read(&mut byte) {
            Ok(0) => return Err(()),
            Ok(_) if byte[0] == b'\n' => return serde_json::from_slice(&bytes).map_err(|_| ()),
            Ok(_) => bytes.push(byte[0]),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return Err(()),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;

    type ControlCallback = mpsc::Sender<Result<Value, ToolFailure>>;

    fn pending_control_fixture(
        request: ToolRequest,
    ) -> (
        Wire,
        FixedPageReadScope,
        FixedPageReadScope,
        Arc<AtomicUsize>,
        ControlCallback,
    ) {
        let (read_scope, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
        let action_scope = read_scope.one_shot().unwrap();
        let observer = action_scope.clone();
        let applied = Arc::new(AtomicUsize::new(0));
        let effect = applied.clone();
        let (ready_send, ready_receive) = mpsc::channel();
        let (send, receive) = mpsc::channel();
        let callback = send.clone();
        let task = tauri::async_runtime::spawn(async move {
            // Model the guarded native handoff followed by an indefinitely late
            // callback. Aborting this future cannot undo the handed-off effect.
            let dispatched = observer.with_valid(|| {
                effect.fetch_add(1, Ordering::AcqRel);
                Ok(())
            });
            ready_send.send(dispatched).unwrap();
            std::future::pending::<()>().await;
            let _ = send.send(Ok(json!({"outcome":"dispatched","applied":true})));
        });
        ready_receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        let wire = Wire {
            pending: Some(PendingRead {
                id: json!(42),
                scope: action_scope.clone(),
                result: receive,
                task,
                request,
                finished: Arc::new(AtomicBool::new(false)),
            }),
            ..Default::default()
        };
        (wire, read_scope, action_scope, applied, callback)
    }

    fn control_requests() -> [ToolRequest; 2] {
        [
            ToolRequest::Click {
                observation_id: "observation".into(),
                node_ref: "node".into(),
            },
            ToolRequest::Input {
                observation_id: "observation".into(),
                node_ref: "node".into(),
                text: "synthetic input".into(),
            },
        ]
    }

    fn assert_unknown_control_reply(packet: &Packet) {
        let packet: Value = serde_json::from_slice(&packet.bytes).unwrap();
        assert_eq!(packet["message"]["id"], 42);
        assert_eq!(packet["message"]["result"]["isError"], true);
        assert_eq!(
            packet["message"]["result"]["structuredContent"]["outcome"],
            "unknown"
        );
        assert!(packet["message"]["result"]["structuredContent"]["applied"].is_null());
        let text = packet["message"]["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(text.contains("结果未确认"));
        assert!(text.contains("不要自动重试"));
        assert_eq!(packet["page"], false, "fixed status contains no page body");
    }

    #[test]
    fn review_regression_preflight_control_failure_reports_not_applied() {
        for request in control_requests() {
            let (scope, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
            let error = scope
                .preflight_control(&request)
                .err()
                .expect("preflight fails");
            assert_eq!(
                error,
                ToolFailure::ControlNotApplied("网页观察已过期，请重新观察后再操作".into())
            );
            let mut wire = Wire::default();
            wire.reply(operation_error_reply(json!(42), true, error), None, false)
                .unwrap();
            let packet: Value = serde_json::from_slice(&wire.packets[0].bytes).unwrap();
            assert_eq!(
                packet["message"]["result"]["structuredContent"]["outcome"],
                "rejected"
            );
            assert_eq!(
                packet["message"]["result"]["structuredContent"]["applied"],
                false
            );
            assert_eq!(packet["page"], false);
            assert_eq!(
                packet["message"]["result"]["structuredContent"]
                    .as_object()
                    .unwrap()
                    .len(),
                2
            );
            assert!(!packet.to_string().contains("synthetic input"));
            assert!(!packet.to_string().contains("nodeRef"));
            assert!(!packet.to_string().contains("observationId"));
            assert!(
                packet["message"]["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("网页观察已过期")
            );
        }
    }

    #[test]
    fn review_regression_control_permission_preflight_failure_preserves_reason() {
        for request in control_requests() {
            let (scope, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
            let error = scope
                .review_control(&request)
                .err()
                .expect("preflight fails");
            let reply = permission_error_reply(json!(42), request.control(), &error);
            assert_eq!(reply["result"]["structuredContent"]["outcome"], "rejected");
            assert_eq!(reply["result"]["structuredContent"]["applied"], false);
            assert!(
                reply["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("网页观察已过期")
            );
        }
    }

    #[test]
    fn matching_error_text_without_preflight_proof_keeps_unknown() {
        let error = ToolFailure::from("网页观察已过期，请重新观察后再操作".to_owned());
        let mut wire = Wire::default();
        wire.reply(operation_error_reply(json!(42), true, error), None, false)
            .unwrap();
        assert_unknown_control_reply(&wire.packets[0]);
        let packet: Value = serde_json::from_slice(&wire.packets[0].bytes).unwrap();
        assert!(!packet.to_string().contains("网页观察已过期"));
    }

    #[test]
    fn noncontrol_errors_preserve_permission_and_unconfirmed_result_distinction() {
        let reason = "网页观察已过期，请重新观察后再操作";
        let permission = permission_error_reply(json!(42), false, reason);
        assert_eq!(
            permission["result"]["content"][0]["text"],
            "请先在当前对话中打开可读取的公开网页"
        );
        assert!(permission["result"].get("structuredContent").is_none());
        let operation =
            operation_error_reply(json!(42), false, ToolFailure::from(reason.to_owned()));
        assert_eq!(
            operation["result"]["content"][0]["text"],
            "网页读取或观察的结果未确认，请等待或关闭网页；不要自动重试"
        );
        assert!(operation["result"].get("structuredContent").is_none());
    }

    #[test]
    fn review_regression_cancel_after_control_dispatch_preserves_unknown_outcome() {
        for request in control_requests() {
            let (mut wire, read_scope, action_scope, applied, callback) =
                pending_control_fixture(request);
            wire.cancel(&json!(41)).unwrap();
            assert!(wire.pending.is_some());
            wire.cancel(&json!(42)).unwrap();
            assert!(wire.pending.is_none());
            assert_eq!(applied.load(Ordering::Acquire), 1);
            assert!(!action_scope.is_valid());
            assert!(read_scope.is_valid());
            assert!(action_scope.with_valid(|| Ok(())).is_err());
            assert_eq!(wire.packets.len(), 1);
            assert_unknown_control_reply(&wire.packets[0]);
            assert!(
                callback
                    .send(Ok(json!({"outcome":"dispatched","applied":true})))
                    .is_err()
            );
            assert_eq!(
                wire.packets.len(),
                1,
                "late receipt cannot replace or duplicate the result"
            );
        }
    }

    #[test]
    fn review_regression_stop_after_control_dispatch_preserves_unknown_outcome_and_barrier() {
        for request in control_requests() {
            let (mut wire, read_scope, action_scope, applied, callback) =
                pending_control_fixture(request);
            // TransportHandle::quiesce withdraws page authority before sending
            // this stop to the Wire, while the native callback is still pending.
            read_scope.revoke();
            let (send, mut receive) = oneshot::channel();
            wire.stop(false, Some(send)).unwrap();
            assert!(wire.pending.is_none());
            assert_eq!(applied.load(Ordering::Acquire), 1);
            assert!(!action_scope.is_valid());
            assert!(!read_scope.is_valid());
            assert_eq!(wire.packets.len(), 2);
            assert_unknown_control_reply(&wire.packets[0]);
            let stop: Value = serde_json::from_slice(&wire.packets[1].bytes).unwrap();
            assert_eq!(stop["kind"], "stop");
            assert!(wire.barrier.is_some());
            assert!(wire.delivery.is_some());
            assert!(matches!(
                receive.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
            assert!(
                callback
                    .send(Ok(json!({"outcome":"dispatched","applied":true})))
                    .is_err()
            );
            assert_eq!(
                wire.packets.len(),
                2,
                "late receipt cannot cross the stop barrier"
            );
        }
    }

    fn waiting_fixture() -> (Arc<super::super::ToolSession>, PermissionWait) {
        let task = "controlled:/fixture:native";
        let (scope, _) = crate::browser_workspace::sharing_scope_fixture(task, "page-a");
        let owner = super::super::state_tests::session(scope);
        *owner.page.lock().unwrap() = None;
        let permission = owner
            .request_permission(crate::browser_workspace::BrowserInfo {
                task_key: task.into(),
                label: "page-a".into(),
                url: "https://example.com/".into(),
                local_file_name: None,
                preview_mode: None,
                local_storage_persistent: None,
                phase: "ready".into(),
                revision: 3,
                error: None,
            })
            .unwrap();
        (owner, permission)
    }

    #[test]
    fn control_cancelled_before_permission_never_reports_a_dispatched_effect() {
        for request in control_requests() {
            for stop in [false, true] {
                let (owner, permission) = waiting_fixture();
                let mut wire = Wire {
                    waiting: Some(WaitingRead {
                        request: request.clone(),
                        id: json!(42),
                        permission,
                    }),
                    ..Default::default()
                };
                if stop {
                    wire.stop(false, None).unwrap();
                } else {
                    wire.cancel(&json!(42)).unwrap();
                }
                assert!(wire.waiting.is_none());
                assert!(wire.pending.is_none());
                assert!(
                    owner
                        .info("controlled:/fixture:native", "")
                        .pending_request
                        .is_none()
                );
                let packet: Value = serde_json::from_slice(&wire.packets[0].bytes).unwrap();
                assert_eq!(packet["message"]["id"], 42);
                assert_eq!(packet["message"]["result"]["isError"], true);
                assert!(
                    packet["message"]["result"]
                        .get("structuredContent")
                        .is_none()
                );
            }
        }
    }

    #[test]
    fn queued_control_withdrawal_preserves_unknown_status_and_discards_page_fields() {
        for stop in [false, true] {
            let (scope, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
            let mut wire = Wire::default();
            wire.control_reply(
                protocol::snapshot(
                    json!(42),
                    json!({
                        "outcome":"dispatched", "applied":true,
                        "reason":"page-owned body", "entered":"synthetic input"
                    }),
                ),
                scope.one_shot().unwrap(),
            )
            .unwrap();
            let delivery = wire.delivery.as_ref().unwrap().number;
            if stop {
                scope.revoke();
                wire.stop(false, None).unwrap();
            } else {
                wire.cancel(&json!(42)).unwrap();
            }
            assert!(wire.packets[0].withdraw_invalid().unwrap().is_some());
            assert_unknown_control_reply(&wire.packets[0]);
            let packet: Value = serde_json::from_slice(&wire.packets[0].bytes).unwrap();
            assert_eq!(packet["control"], true);
            assert_eq!(packet["delivery"], delivery);
            assert!(!String::from_utf8_lossy(&wire.packets[0].bytes).contains("page-owned"));
            assert!(!String::from_utf8_lossy(&wire.packets[0].bytes).contains("synthetic input"));
            assert!(wire.barrier.is_some());
            assert!(
                wire.delivery.is_some(),
                "no written or stopped ACK was received"
            );
        }
    }

    #[test]
    fn page_data_cannot_mark_a_read_receipt_as_control_and_partial_frames_are_not_replaced() {
        let (scope, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
        let mut wire = Wire::default();
        wire.reply(
            protocol::snapshot(json!(42), json!({"control":true,"outcome":"dispatched"})),
            Some(scope.clone()),
            false,
        )
        .unwrap();
        scope.revoke();
        let original = wire.packets[0].bytes.clone();
        wire.packets[0].written = 1;
        assert!(wire.packets[0].withdraw_invalid().unwrap().is_none());
        assert_eq!(wire.packets[0].bytes, original);
        wire.packets[0].written = 0;
        assert!(wire.packets[0].withdraw_invalid().unwrap().is_some());
        let packet: Value = serde_json::from_slice(&wire.packets[0].bytes).unwrap();
        assert_eq!(packet["control"], false);
        assert_eq!(packet["page"], false);
        assert!(
            packet["message"]["result"]
                .get("structuredContent")
                .is_none()
        );
        assert_eq!(
            packet["message"]["result"]["content"][0]["text"],
            "读取许可已停止"
        );
    }

    #[test]
    fn cancellation_finishes_only_the_original_waiting_call() {
        let (owner, permission) = waiting_fixture();
        let mut wire = Wire {
            waiting: Some(WaitingRead {
                request: ToolRequest::Read,
                id: json!(42),
                permission,
            }),
            ..Default::default()
        };
        wire.cancel(&json!(41)).unwrap();
        assert!(wire.waiting.is_some());
        assert!(
            owner
                .info("controlled:/fixture:native", "")
                .pending_request
                .is_some()
        );
        wire.cancel(&json!(42)).unwrap();
        assert!(wire.waiting.is_none());
        assert!(
            owner
                .info("controlled:/fixture:native", "")
                .pending_request
                .is_none()
        );
        let packet: Value = serde_json::from_slice(&wire.packets[0].bytes).unwrap();
        assert_eq!(packet["message"]["id"], 42);
        assert_eq!(packet["message"]["result"]["isError"], true);
        assert!(
            packet["message"]["result"]
                .get("structuredContent")
                .is_none()
        );
    }

    #[test]
    fn stopping_permission_wait_returns_same_call_error_and_still_waits_for_ack() {
        let (owner, permission) = waiting_fixture();
        let mut wire = Wire {
            waiting: Some(WaitingRead {
                request: ToolRequest::Read,
                id: json!(42),
                permission,
            }),
            ..Default::default()
        };
        let (send, mut receive) = oneshot::channel();
        wire.stop(false, Some(send)).unwrap();
        assert!(wire.waiting.is_none());
        assert!(
            owner
                .info("controlled:/fixture:native", "")
                .pending_request
                .is_none()
        );
        assert_eq!(wire.packets.len(), 2);
        let packet: Value = serde_json::from_slice(&wire.packets[0].bytes).unwrap();
        assert_eq!(packet["message"]["id"], 42);
        assert_eq!(packet["message"]["result"]["isError"], true);
        assert!(matches!(
            receive.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn cancellation_of_queued_page_body_retires_request_and_requires_stdout_barrier() {
        let (scope, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
        let mut wire = Wire::default();
        wire.reply(
            protocol::snapshot(json!(42), json!({"text":"synthetic"})),
            Some(scope.clone()),
            false,
        )
        .unwrap();
        wire.cancel(&json!(42)).unwrap();
        assert!(scope.is_valid());
        assert!(
            !wire
                .delivery
                .as_ref()
                .unwrap()
                .scope
                .as_ref()
                .unwrap()
                .is_valid()
        );
        assert!(wire.barrier.is_some());
        assert!(
            wire.delivery.is_some(),
            "queued stop is not a final stdout receipt"
        );
    }

    #[test]
    fn unknown_transport_exit_preserves_revoked_scope_for_registry_retirement() {
        let (scope, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
        let current: SharedPage = Arc::new(Mutex::new(Some(scope.clone())));
        let retiring: SharedPage = Arc::new(Mutex::new(None));
        let callback_page = current.clone();
        let callback_retiring = retiring.clone();
        let expected = scope.clone();
        let callback: Closed = Arc::new(move |confirmed| {
            assert!(!confirmed);
            let old = callback_page
                .lock()
                .unwrap()
                .take()
                .expect("owner must still have the grant");
            assert!(old.same_grant(&expected));
            assert!(!old.is_valid());
            *callback_retiring.lock().unwrap() = Some(old);
        });
        notify_page_closed(&current, &callback, false);
        assert!(current.lock().unwrap().is_none());
        assert!(
            retiring
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .same_grant(&scope)
        );
    }

    #[test]
    fn read_arriving_during_stop_can_never_capture_a_future_grant() {
        let mut wire = Wire::default();
        wire.stop(false, None).unwrap();
        wire.defer_during_stop(protocol::Action::Read {
            id: json!(7),
            request: ToolRequest::Read,
        })
        .unwrap();
        // Even after the stop barrier is removed, this action is only a fixed error.
        wire.barrier = None;
        let Some(protocol::Action::Reply { value, list: false }) = wire.deferred.take() else {
            panic!("old read must not survive as an observation action");
        };
        assert_eq!(value["id"], 7);
        assert_eq!(value["result"]["isError"], true);
        assert!(value["result"].get("structuredContent").is_none());
    }

    #[test]
    fn enqueuing_stop_is_ordered_and_never_synthesizes_an_ack() {
        let mut wire = Wire::default();
        wire.reply(json!({"jsonrpc":"2.0","id":1,"result":{}}), None, false)
            .unwrap();
        let (send, mut receive) = oneshot::channel();
        wire.stop(false, Some(send)).unwrap();
        assert_eq!(wire.packets.len(), 2);
        let first: Value = serde_json::from_slice(&wire.packets[0].bytes).unwrap();
        let second: Value = serde_json::from_slice(&wire.packets[1].bytes).unwrap();
        assert_eq!(first["kind"], "response");
        assert_eq!(second["kind"], "stop");
        assert!(matches!(
            receive.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        drop(wire);
        assert!(matches!(
            receive.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    #[test]
    fn oversized_response_becomes_a_bounded_fixed_error() {
        let mut wire = Wire::default();
        let large = "\u{0001}".repeat(110_000);
        wire.reply(
            protocol::snapshot(json!(4), json!({"text": large})),
            None,
            false,
        )
        .unwrap();
        assert!(wire.packets[0].bytes.len() < 1000);
        let packet: Value = serde_json::from_slice(&wire.packets[0].bytes).unwrap();
        assert_eq!(packet["message"]["result"]["isError"], true);
        assert!(
            packet["message"]["result"]
                .get("structuredContent")
                .is_none()
        );
    }
}

#[cfg(test)]
pub(super) fn control_state_fixture(page: SharedPage) -> (TransportHandle, Arc<AtomicBool>) {
    let shutdown = Arc::new(AtomicBool::new(false));
    let (controls, _) = mpsc::channel();
    let (_, completed) = watch::channel(0);
    (
        TransportHandle(Arc::new(HandleInner {
            page,
            controls,
            shutdown: shutdown.clone(),
            completed,
            #[cfg(target_os = "macos")]
            initialized: Arc::new(AtomicBool::new(true)),
            #[cfg(target_os = "macos")]
            listed: Arc::new(AtomicBool::new(true)),
        })),
        shutdown,
    )
}
