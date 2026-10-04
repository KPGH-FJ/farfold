//! One authenticated local MCP connection. The helper owns its standard stdout.
//! Shared-page stop succeeds only after the helper acknowledges its output gate.
//! No page content or bearer secret is logged or persisted by this module.
use super::{helper, protocol};
use crate::browser_workspace::FixedPageReadScope;
use agent_client_protocol::schema::v1::{EnvVariable, McpServerStdio};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
        },
    },
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

const BOOTSTRAP_TTL: Duration = Duration::from_secs(180);
const WRITE_WAIT: Duration = Duration::from_secs(1);
const MAX_REQUEST: usize = 65_536;
const MAX_RESPONSE: usize = 600_000;
pub(crate) type SharedPage = Arc<Mutex<Option<FixedPageReadScope>>>;
type Callback = Arc<dyn Fn() + Send + Sync>;
type Closed = Arc<dyn Fn(bool) + Send + Sync>;
type Invalidated = Arc<dyn Fn(FixedPageReadScope) + Send + Sync>;

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

pub(crate) fn start(
    app: AppHandle,
    page: SharedPage,
    on_ready: Callback,
    on_closed: Closed,
    on_invalidated: Invalidated,
) -> Result<(TransportHandle, HelperLaunch), String> {
    let directory = tempfile::Builder::new()
        .prefix("ff-page-")
        .tempdir_in("/tmp")
        .map_err(|_| "无法准备网页工具".to_owned())?;
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .map_err(|_| "无法准备网页工具".to_owned())?;
    let endpoint = directory.path().join("mcp.sock");
    let listener = UnixListener::bind(&endpoint).map_err(|_| "无法准备网页工具".to_owned())?;
    fs::set_permissions(&endpoint, fs::Permissions::from_mode(0o600))
        .map_err(|_| "无法准备网页工具".to_owned())?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "无法准备网页工具".to_owned())?;
    let mut random = [0u8; 32];
    if unsafe { libc::getentropy(random.as_mut_ptr().cast(), random.len()) } != 0 {
        return Err("无法准备临时读取许可".into());
    }
    let capability: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    random.fill(0);
    let name = format!(
        "farfold_page_{}",
        directory
            .path()
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("无法准备网页工具名称")?
            .replace('-', "_")
    );
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
                on_closed,
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
struct Worker {
    app: AppHandle,
    page: SharedPage,
    shutdown: Arc<AtomicBool>,
    controls: mpsc::Receiver<Control>,
    on_ready: Callback,
    on_closed: Closed,
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
        })
    }
}
struct Delivery {
    number: u64,
    list: bool,
    scope: Option<FixedPageReadScope>,
}
struct PendingRead {
    id: Value,
    scope: FixedPageReadScope,
    result: mpsc::Receiver<Result<Value, String>>,
    task: tauri::async_runtime::JoinHandle<()>,
}
impl Drop for PendingRead {
    fn drop(&mut self) {
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
    barrier: Option<Barrier>,
    deferred: Option<protocol::Action>,
}
impl Wire {
    fn defer_during_stop(&mut self, action: protocol::Action) -> Result<(), ()> {
        // A request arriving during stop cannot capture a later grant.
        let action = match action {
            protocol::Action::Read { id } => protocol::Action::Reply {
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
        if self.delivery.is_some() {
            return Err(());
        }
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let (value, scope) = if serde_json::to_vec(&value).map_err(|_| ())?.len() >= MAX_RESPONSE {
            (
                protocol::tool_error(id.clone(), "网页内容过大，读取未完成"),
                None,
            )
        } else {
            (value, scope)
        };
        let number = self.serial()?;
        self.packets.push_back(Packet::message(serde_json::json!({"kind":"response","delivery":number,"page":scope.is_some(),"message":value}), scope.clone(), Some(number), id)?);
        self.delivery = Some(Delivery {
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
        if let Some(old) = self.pending.take() {
            let id = old.id.clone();
            drop(old);
            self.reply(protocol::tool_error(id, "读取许可已停止"), None, false)?;
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
    fn accept(&mut self, listener: UnixListener, capability: String) -> bool {
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
                    let _ = channel.set_read_timeout(Some(Duration::from_millis(100)));
                    let _ = channel.set_write_timeout(Some(Duration::from_secs(1)));
                    let Ok(hello) = read_hello(&mut channel) else {
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
                        continue;
                    }
                    // One successful authentication consumes this listener/capability.
                    if channel.write_all(b"{\"kind\":\"hello_ack\"}\n").is_err() {
                        return false;
                    }
                    if channel.set_nonblocking(true).is_err() {
                        return false;
                    }
                    drop(listener);
                    return self.serve(channel);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    wait_fd(listener.as_raw_fd(), libc::POLLIN, 50)
                }
                Err(_) => return true,
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
            protocol::Action::Read { id } => {
                if wire.pending.is_some() || wire.delivery.is_some() {
                    return false;
                }
                let scope = self.page.lock().ok().and_then(|page| page.clone());
                if let Some(scope) = scope.filter(FixedPageReadScope::is_valid) {
                    let (send, receive) = mpsc::channel();
                    let observer = scope.clone();
                    let app = self.app.clone();
                    let task = tauri::async_runtime::spawn(async move {
                        let result = observer.read(&app).await.and_then(|page| {
                            serde_json::to_value(page).map_err(|_| "网页读取未完成".into())
                        });
                        let _ = send.send(result);
                    });
                    wire.pending = Some(PendingRead {
                        id,
                        scope,
                        result: receive,
                        task,
                    });
                } else if wire
                    .reply(protocol::tool_error(id, "当前网页未允许读取"), None, false)
                    .is_err()
                {
                    return false;
                }
            }
        }
        true
    }
    fn serve(&mut self, mut channel: UnixStream) -> bool {
        let mut protocol = protocol::Protocol::default();
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
                        wire.pending = None;
                        let (value, grant) = match result {
                            Ok(page) => (protocol::snapshot(id, page), Some(scope)),
                            Err(_) => {
                                if !scope.is_valid() {
                                    (self.on_invalidated)(scope);
                                }
                                (
                                    protocol::tool_error(id, "当前网页未允许读取或读取许可已停止"),
                                    None,
                                )
                            }
                        };
                        if wire.reply(value, grant, false).is_err() {
                            return false;
                        }
                    }
                    Err(mpsc::TryRecvError::Disconnected) => {
                        let id = read.id.clone();
                        wire.pending = None;
                        if wire
                            .reply(protocol::tool_error(id, "网页读取未完成"), None, false)
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
            if poll_ready(channel.as_raw_fd(), libc::POLLIN) {
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
                        if wire
                            .delivery
                            .as_ref()
                            .is_some_and(|delivery| delivery.number == number)
                        {
                            let delivery = wire.delivery.take().expect("checked delivery");
                            if delivery.list && protocol.mark_list_delivered() {
                                (self.on_ready)();
                            }
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
                                wire.delivery = None;
                            }
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
                        if wire.barrier.is_some() && !matches!(action, protocol::Action::None) {
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
            if let Some(packet) = wire.packets.front_mut() {
                if Instant::now() >= packet.deadline {
                    return false;
                }
                if packet.written == 0
                    && let Some(scope) = packet.scope.as_ref()
                    && !scope.is_valid()
                {
                    let scope = scope.clone();
                    let number = packet.delivery.expect("page delivery");
                    let id = packet.id.clone();
                    let error = protocol::tool_error(id.clone(), "读取许可已停止");
                    let Ok(replacement) = Packet::message(
                        serde_json::json!({"kind":"response","delivery":number,"page":false,"message":error}),
                        None,
                        Some(number),
                        id,
                    ) else {
                        return false;
                    };
                    *packet = replacement;
                    if let Some(delivery) = wire.delivery.as_mut() {
                        delivery.scope = None;
                    }
                    (self.on_invalidated)(scope);
                }
                if poll_ready(channel.as_raw_fd(), libc::POLLOUT) {
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
            let events = libc::POLLIN
                | if wire.packets.is_empty() {
                    0
                } else {
                    libc::POLLOUT
                };
            wait_fd(channel.as_raw_fd(), events, 50);
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
fn read_hello(channel: &mut UnixStream) -> Result<Value, ()> {
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
fn poll_ready(fd: i32, interests: i16) -> bool {
    let mut descriptor = libc::pollfd {
        fd,
        events: interests,
        revents: 0,
    };
    unsafe { libc::poll(&mut descriptor, 1, 0) > 0 }
}
fn wait_fd(fd: i32, interests: i16, timeout: i32) {
    let mut descriptor = libc::pollfd {
        fd,
        events: interests,
        revents: 0,
    };
    unsafe {
        libc::poll(&mut descriptor, 1, timeout);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        wire.defer_during_stop(protocol::Action::Read { id: json!(7) })
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
