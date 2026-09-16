use crate::acp_client_resources::AcpClientResources;
use serde_json::{Value, json};
use std::os::unix::process::CommandExt;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME: usize = 1024 * 1024;
const MAX_EVENTS: usize = 256;
const MAX_PENDING: usize = 32;
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AcpDispatchError {
    NotSent(&'static str),
    Rejected { code: i64, data: Option<Value> },
    Unknown(String),
}

impl std::fmt::Display for AcpDispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotSent(message) => f.write_str(message),
            Self::Rejected { code, .. } => write!(f, "ACP 请求失败（错误码 {code}）"),
            Self::Unknown(message) => f.write_str(message),
        }
    }
}

type Response = Result<Value, AcpDispatchError>;

pub(crate) struct AcpPendingResponse {
    wire: Arc<Wire>,
    id: String,
    receiver: mpsc::Receiver<Response>,
    consumed: bool,
}

impl AcpPendingResponse {
    pub(crate) fn wait(self) -> Response {
        let result = self.receiver.recv().unwrap_or_else(|_| {
            Err(AcpDispatchError::Unknown(
                "ACP 响应通道断开；操作结果尚未确认".into(),
            ))
        });
        self.finish(result)
    }

    pub(crate) fn wait_timeout(self, timeout: Duration) -> Response {
        let result = self.receiver.recv_timeout(timeout).unwrap_or_else(|_| {
            Err(AcpDispatchError::Unknown(
                "ACP 回执超时或通道断开；操作结果尚未确认".into(),
            ))
        });
        self.finish(result)
    }

    fn finish(mut self, result: Response) -> Response {
        self.consumed = true;
        if let Ok(mut inbox) = self.wire.inbox.lock() {
            inbox.pending.remove(&self.id);
            if matches!(result, Err(AcpDispatchError::Unknown(_))) {
                inbox.unknown_result = true;
            }
        }
        result
    }
}

impl Drop for AcpPendingResponse {
    fn drop(&mut self) {
        if !self.consumed
            && let Ok(mut inbox) = self.wire.inbox.lock()
        {
            inbox.pending.remove(&self.id);
            inbox.unknown_result = true;
        }
    }
}

#[derive(Default)]
struct Inbox {
    pending: HashMap<String, mpsc::SyncSender<Response>>,
    client_requests: HashMap<String, ClientRequest>,
    resource_requests: HashSet<String>,
    events: VecDeque<Value>,
    event_bytes: usize,
    dropped: u64,
    failure: Option<String>,
    unknown_result: bool,
}

#[derive(Debug, Clone)]
struct ClientRequest {
    response_id: Value,
    method: String,
    session_id: Option<String>,
    option_ids: Vec<String>,
    responding: bool,
}

enum WriteCommand {
    Frame(PendingWrite),
}

struct PendingWrite {
    bytes: Vec<u8>,
    ack: mpsc::SyncSender<Result<(), AcpDispatchError>>,
    cancelled: Arc<AtomicBool>,
    fail_connection: bool,
}

struct Wire {
    writer: Mutex<Option<mpsc::SyncSender<WriteCommand>>>,
    inbox: Mutex<Inbox>,
    next_id: AtomicU64,
    event_ready: Condvar,
    eof_shutdown_requested: AtomicBool,
    resources: Mutex<Option<Arc<AcpClientResources>>>,
}

impl Wire {
    fn frame(envelope: &Value) -> Result<Vec<u8>, AcpDispatchError> {
        let mut bytes = serde_json::to_vec(envelope)
            .map_err(|_| AcpDispatchError::NotSent("ACP 请求编码失败"))?;
        if bytes.len() > MAX_FRAME {
            return Err(AcpDispatchError::NotSent("ACP 请求超过大小限制"));
        }
        bytes.push(b'\n');
        Ok(bytes)
    }

    fn write_timeout(&self, envelope: &Value, timeout: Duration) -> Result<(), AcpDispatchError> {
        let bytes = Self::frame(envelope)?;
        let writer = self
            .writer
            .lock()
            .map_err(|_| AcpDispatchError::NotSent("ACP 输入状态不可用"))?
            .as_ref()
            .cloned()
            .ok_or(AcpDispatchError::NotSent("ACP 连接已经关闭"))?;
        let (ack_sender, ack_receiver) = mpsc::sync_channel(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        let pending = PendingWrite {
            bytes,
            ack: ack_sender,
            cancelled: cancelled.clone(),
            fail_connection: true,
        };
        let deadline = Instant::now() + timeout;
        let mut pending = Some(pending);
        loop {
            let Some(command) = pending.take() else {
                break;
            };
            match writer.try_send(WriteCommand::Frame(command)) {
                Ok(()) => break,
                Err(TrySendError::Disconnected(_)) => {
                    return Err(AcpDispatchError::NotSent("ACP 连接已经关闭"));
                }
                Err(TrySendError::Full(WriteCommand::Frame(command))) => {
                    if Instant::now() >= deadline {
                        command.cancelled.store(true, Ordering::Release);
                        return Err(AcpDispatchError::NotSent("ACP 写入队列已满；请求未发送"));
                    }
                    pending = Some(command);
                    thread::sleep(Duration::from_millis(5));
                }
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        ack_receiver.recv_timeout(remaining).map_err(|_| {
            cancelled.store(true, Ordering::Release);
            AcpDispatchError::Unknown("ACP 写入超时；操作结果尚未确认".into())
        })?
    }

    fn fail(&self, message: &str) {
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.failure.get_or_insert_with(|| message.to_owned());
            for (_, sender) in inbox.pending.drain() {
                let _ = sender.send(Err(AcpDispatchError::Unknown(message.to_owned())));
            }
        }
        self.event_ready.notify_all();
        if let Ok(resources) = self.resources.lock()
            && let Some(resources) = resources.as_ref()
        {
            resources.shutdown();
        }
    }

    fn has_unresolved_work(&self) -> Result<bool, String> {
        let inbox = self.inbox.lock().map_err(|_| "ACP 请求状态不可用")?;
        Ok(inbox.unknown_result
            || !inbox.pending.is_empty()
            || !inbox.client_requests.is_empty()
            || !inbox.resource_requests.is_empty()
            || self.has_live_terminals()?)
    }

    fn has_live_terminals(&self) -> Result<bool, String> {
        match self
            .resources
            .lock()
            .map_err(|_| "ACP resources unavailable")?
            .as_ref()
        {
            Some(resources) => resources.has_live_terminals(),
            None => Ok(false),
        }
    }

    fn queue_event(&self, envelope: Value, size: usize) -> Result<(), String> {
        let mut inbox = self.inbox.lock().map_err(|_| "ACP 事件状态不可用")?;
        if size > MAX_FRAME {
            inbox.dropped += 1;
            self.event_ready.notify_one();
            return Ok(());
        }
        while inbox.events.len() >= MAX_EVENTS || inbox.event_bytes + size > MAX_FRAME {
            let Some(old) = inbox.events.pop_front() else {
                break;
            };
            inbox.event_bytes = inbox.event_bytes.saturating_sub(old.to_string().len());
            inbox.dropped += 1;
        }
        inbox.event_bytes += size;
        inbox.events.push_back(envelope);
        self.event_ready.notify_one();
        Ok(())
    }

    fn write_reverse_error_or_fail(&self, envelope: &Value) -> Result<(), String> {
        let bytes = Self::frame(envelope).map_err(|error| error.to_string())?;
        let writer = self
            .writer
            .lock()
            .map_err(|_| "ACP 输入状态不可用".to_string())?
            .as_ref()
            .cloned()
            .ok_or("ACP 连接已经关闭".to_string())?;
        let (ack, _) = mpsc::sync_channel(1);
        let pending = PendingWrite {
            bytes,
            ack,
            cancelled: Arc::new(AtomicBool::new(false)),
            fail_connection: false,
        };
        match writer.try_send(WriteCommand::Frame(pending)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Disconnected(_)) => {
                let message = "ACP 反向请求拒绝无法写入；连接结果未知：连接已经关闭".to_string();
                self.fail(&message);
                Err(message)
            }
            Err(TrySendError::Full(_)) => {
                let message = "ACP 反向请求拒绝无法写入；连接结果未知：写入队列已满".to_string();
                self.fail(&message);
                Err(message)
            }
        }
    }

    fn write_response(&self, request_id: Value, result: Value) -> Result<(), AcpDispatchError> {
        self.write_timeout(
            &json!({"jsonrpc":"2.0","id":request_id,"result":result}),
            WRITE_TIMEOUT,
        )
    }

    fn receive(self: &Arc<Self>, envelope: Value, size: usize) -> Result<(), String> {
        if !envelope.is_object() {
            return Err("ACP 返回了无效协议消息".into());
        }
        if envelope.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err("ACP JSON-RPC 版本无效".into());
        }
        if envelope.get("method").is_some() {
            let Some(method) = envelope["method"].as_str() else {
                return Err("ACP 方法名称无效".into());
            };
            let request_id = envelope.get("id").cloned();
            if let Some(request_id) = request_id {
                // Bulk history expands response reads, not interactive request
                // capacity. Reject before creating an invisible pending request.
                if size > MAX_FRAME {
                    let key = json_rpc_id_key(&request_id)?;
                    let inbox = self.inbox.lock().map_err(|_| "ACP 反向请求状态不可用")?;
                    if inbox.client_requests.contains_key(&key)
                        || inbox.resource_requests.contains(&key)
                    {
                        return Err("Duplicate ACP client request id".into());
                    }
                    drop(inbox);
                    return self.write_reverse_error_or_fail(&json!({
                        "jsonrpc":"2.0", "id":request_id,
                        "error":{"code":-32602,"message":"ACP client requests must not exceed 1 MiB"}
                    }));
                }
                if AcpClientResources::supports(method) {
                    let resources = self
                        .resources
                        .lock()
                        .map_err(|_| "ACP resource state unavailable")?
                        .clone();
                    if let Some(resources) = resources {
                        let key = json_rpc_id_key(&request_id)?;
                        let mut inbox = self
                            .inbox
                            .lock()
                            .map_err(|_| "ACP resource request state unavailable")?;
                        let limit = if method == "terminal/wait_for_exit" {
                            MAX_PENDING - 8
                        } else {
                            MAX_PENDING
                        };
                        if inbox.failure.is_some() || inbox.resource_requests.len() >= limit {
                            drop(inbox);
                            return self.write_reverse_error_or_fail(&json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32000,"message":"ACP resources are unavailable or busy"}}));
                        }
                        if inbox.client_requests.contains_key(&key)
                            || !inbox.resource_requests.insert(key.clone())
                        {
                            return Err("Duplicate ACP client request id".into());
                        }
                        drop(inbox);
                        let method = method.to_string();
                        let params = envelope["params"].clone();
                        self.queue_event(envelope, size)?;
                        let wire = self.clone();
                        thread::Builder::new().name("acp-resource-request".into()).spawn(move || {
                            let response = match resources.handle(&method, params) {
                                Ok(result) => json!({"jsonrpc":"2.0","id":request_id,"result":result}),
                                Err(message) => json!({"jsonrpc":"2.0","id":request_id,"error":{"code":-32000,"message":message}}),
                            };
                            if wire.write_timeout(&response, WRITE_TIMEOUT).is_err() { wire.fail("ACP resource response was not confirmed"); }
                            if let Ok(mut inbox) = wire.inbox.lock() { inbox.resource_requests.remove(&key); }
                        }).map_err(|_| "Cannot start ACP resource request worker")?;
                        return Ok(());
                    }
                }
                if method == "session/request_permission" || method == "elicitation/create" {
                    let id = json_rpc_id_key(&request_id)?;
                    let session_id = envelope
                        .pointer("/params/sessionId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let option_ids = envelope
                        .pointer("/params/options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(|option| option.get("optionId").and_then(Value::as_str))
                                .map(str::to_string)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let mut inbox = self.inbox.lock().map_err(|_| "ACP 反向请求状态不可用")?;
                    if inbox.client_requests.contains_key(&id)
                        || inbox.resource_requests.contains(&id)
                    {
                        return Err("Duplicate ACP client request id".into());
                    }
                    if inbox.client_requests.len() >= MAX_PENDING {
                        drop(inbox);
                        self.write_reverse_error_or_fail(&json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": "Farfold has too many pending ACP client requests"
                            }
                        }))?;
                        self.queue_event(envelope, size)?;
                        return Ok(());
                    } else {
                        inbox.client_requests.insert(
                            id,
                            ClientRequest {
                                response_id: request_id,
                                method: method.to_string(),
                                session_id,
                                option_ids,
                                responding: false,
                            },
                        );
                    }
                    drop(inbox);
                    self.queue_event(envelope, size)?;
                    return Ok(());
                }
                self.queue_event(envelope, size)?;
                self.write_reverse_error_or_fail(&json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": "Farfold has not enabled this ACP client request"
                    }
                }))?;
            } else {
                self.queue_event(envelope, size)?;
            }
            return Ok(());
        }
        let id = envelope
            .get("id")
            .and_then(Value::as_str)
            .ok_or("ACP 响应缺少请求身份")?;
        let mut inbox = self.inbox.lock().map_err(|_| "ACP 响应状态不可用")?;
        let Some(sender) = inbox.pending.remove(id) else {
            inbox.dropped += 1;
            self.event_ready.notify_one();
            return Ok(());
        };
        let response = match (envelope.get("result"), envelope.get("error")) {
            (Some(value), None) => Ok(value.clone()),
            (None, Some(error))
                if error.is_object() && error["code"].is_i64() && error["message"].is_string() =>
            {
                if error.pointer("/data/farfoldOutcomeUnknown") == Some(&Value::Bool(true)) {
                    Err(AcpDispatchError::Unknown(
                        "ACP 未确认操作结果；请停止或重新连接核对，系统不会自动重发。".into(),
                    ))
                } else {
                    Err(AcpDispatchError::Rejected {
                        code: error["code"].as_i64().unwrap(),
                        data: error.get("data").cloned(),
                    })
                }
            }
            _ => Err(AcpDispatchError::Unknown(
                "ACP 控制响应格式无效；操作结果尚未确认".into(),
            )),
        };
        if matches!(response, Err(AcpDispatchError::Unknown(_))) {
            inbox.unknown_result = true;
        }
        let _ = sender.send(response);
        Ok(())
    }
}

pub(crate) struct AcpTransport {
    wire: Arc<Wire>,
    child: Mutex<Child>,
    process_group: Arc<OwnedProcessGroup>,
}

struct OwnedProcessGroup {
    id: libc::pid_t,
    cleaned: AtomicBool,
}

impl OwnedProcessGroup {
    fn terminate(&self) {
        if !self.cleaned.swap(true, Ordering::AcqRel) {
            // The group is created for this child before exec. Never signal a
            // discovered Runtime, a shared server, or the Host's own group.
            unsafe {
                libc::kill(-self.id, libc::SIGKILL);
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum AcpReadLimit {
    Standard,
    NativeHistory,
}

impl AcpReadLimit {
    fn bytes(self) -> usize {
        match self {
            Self::Standard => MAX_FRAME,
            Self::NativeHistory => 16 * 1024 * 1024,
        }
    }
}

fn read_frame(reader: &mut impl BufRead, limit: AcpReadLimit) -> Result<Option<Vec<u8>>, String> {
    let mut frame = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(|_| "读取 ACP 输出失败")?;
        if buffer.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err("ACP 输出在消息中途断开".into())
            };
        }
        let end = buffer.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(buffer.len(), |index| index + 1);
        if frame.len() + count > limit.bytes() {
            return Err(format!(
                "ACP 消息超过 {} MiB；连接结果未知",
                limit.bytes() / (1024 * 1024)
            ));
        }
        frame.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(Some(frame));
        }
    }
}

pub(crate) fn json_rpc_id_key(value: &Value) -> Result<String, String> {
    if let Some(id) = value.as_str() {
        return Ok(id.to_string());
    }
    if value.is_i64() || value.is_u64() {
        return Ok(value.to_string());
    }
    Err("ACP 反向请求 id 必须为字符串或整数".into())
}

impl AcpTransport {
    pub(crate) fn spawn(command: &mut Command) -> Result<Self, String> {
        Self::spawn_with_read_limit(command, AcpReadLimit::Standard)
    }

    pub(crate) fn spawn_with_read_limit(
        command: &mut Command,
        read_limit: AcpReadLimit,
    ) -> Result<Self, String> {
        let mut child = command
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法启动 ACP Agent：{error}"))?;
        let process_group = Arc::new(OwnedProcessGroup {
            id: child.id() as libc::pid_t,
            cleaned: AtomicBool::new(false),
        });
        let stdout = child.stdout.take().expect("piped stdout");
        let mut stdin = child.stdin.take().expect("piped stdin");
        let (write_sender, write_receiver) = mpsc::sync_channel::<WriteCommand>(MAX_PENDING);
        let wire = Arc::new(Wire {
            writer: Mutex::new(Some(write_sender)),
            inbox: Mutex::new(Inbox::default()),
            next_id: AtomicU64::new(1),
            event_ready: Condvar::new(),
            eof_shutdown_requested: AtomicBool::new(false),
            resources: Mutex::new(None),
        });
        let reader_wire = wire.clone();
        let writer_wire = wire.clone();
        let writer = thread::Builder::new()
            .name("acp-stdio-writer".into())
            .spawn(move || {
                while let Ok(command) = write_receiver.recv() {
                    match command {
                        WriteCommand::Frame(pending) => {
                            if pending.cancelled.load(Ordering::Acquire) {
                                let _ = pending.ack.send(Err(AcpDispatchError::NotSent(
                                    "ACP 写入已取消；请求未发送",
                                )));
                                continue;
                            }
                            let result = stdin.write_all(&pending.bytes).map_err(|_| {
                                AcpDispatchError::Unknown(
                                    "无法完整写入 ACP 连接；操作结果尚未确认".into(),
                                )
                            });
                            if pending.fail_connection
                                && let Err(AcpDispatchError::Unknown(message)) = &result
                            {
                                writer_wire.fail(message);
                            }
                            let _ = pending.ack.send(result);
                        }
                    }
                }
            });
        let reader_group = process_group.clone();
        let spawned = thread::Builder::new()
            .name("acp-stdio".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let result: Result<(), String> = (|| {
                    while let Some(frame) = read_frame(&mut reader, read_limit)? {
                        let envelope: Value =
                            serde_json::from_slice(&frame).map_err(|_| "ACP 返回了无效 JSON")?;
                        let size = envelope.to_string().len();
                        reader_wire.receive(envelope, size)?;
                    }
                    Err("ACP 输出已断开；需重新连接核对状态".into())
                })();
                reader_group.terminate();
                if let Err(message) = result {
                    reader_wire.fail(&message);
                }
                if let Ok(mut writer) = reader_wire.writer.lock() {
                    writer.take();
                }
            });
        if writer.is_err() || spawned.is_err() {
            if let Ok(mut writer) = wire.writer.lock() {
                writer.take();
            }
            process_group.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err("无法创建 ACP 输出读取器".into());
        }
        Ok(Self {
            wire,
            child: Mutex::new(child),
            process_group,
        })
    }

    #[cfg(test)]
    pub(crate) fn request(&self, method: &str, params: Value) -> Response {
        self.request_timeout(method, params, Duration::from_secs(15))
    }

    pub(crate) fn request_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Response {
        let id = format!(
            "farfold-acp-{}",
            self.wire.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut inbox = self
                .wire
                .inbox
                .lock()
                .map_err(|_| AcpDispatchError::NotSent("ACP 请求状态不可用"))?;
            if inbox.failure.is_some() {
                return Err(AcpDispatchError::NotSent("ACP 连接已经失效；请求未发送"));
            }
            if inbox.pending.len() >= MAX_PENDING {
                return Err(AcpDispatchError::NotSent("ACP 控制请求过多，请稍后重试"));
            }
            inbox.pending.insert(id.clone(), sender);
        }
        let result = self
            .wire
            .write_timeout(
                &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
                WRITE_TIMEOUT,
            )
            .and_then(|()| {
                receiver.recv_timeout(timeout).map_err(|_| {
                    AcpDispatchError::Unknown(
                        "ACP 控制请求超时或响应通道断开；操作结果尚未确认".into(),
                    )
                })?
            });
        if let Ok(mut inbox) = self.wire.inbox.lock() {
            inbox.pending.remove(&id);
            if matches!(result, Err(AcpDispatchError::Unknown(_))) {
                inbox.unknown_result = true;
            }
        }
        result
    }

    pub(crate) fn request_unbounded(&self, method: &str, params: Value) -> Response {
        self.begin_request_unbounded(method, params)?.wait()
    }

    pub(crate) fn begin_request_unbounded(
        &self,
        method: &str,
        params: Value,
    ) -> Result<AcpPendingResponse, AcpDispatchError> {
        let id = format!(
            "farfold-acp-{}",
            self.wire.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut inbox = self
                .wire
                .inbox
                .lock()
                .map_err(|_| AcpDispatchError::NotSent("ACP 请求状态不可用"))?;
            if inbox.failure.is_some() {
                return Err(AcpDispatchError::NotSent("ACP 连接已经失效；请求未发送"));
            }
            if inbox.pending.len() >= MAX_PENDING {
                return Err(AcpDispatchError::NotSent("ACP 控制请求过多，请稍后重试"));
            }
            inbox.pending.insert(id.clone(), sender);
        }
        if let Err(error) = self.wire.write_timeout(
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            WRITE_TIMEOUT,
        ) {
            if let Ok(mut inbox) = self.wire.inbox.lock() {
                inbox.pending.remove(&id);
                if matches!(error, AcpDispatchError::Unknown(_)) {
                    inbox.unknown_result = true;
                }
            }
            return Err(error);
        }
        Ok(AcpPendingResponse {
            wire: self.wire.clone(),
            id,
            receiver,
            consumed: false,
        })
    }

    pub(crate) fn notify_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<(), AcpDispatchError> {
        self.wire.write_timeout(
            &json!({"jsonrpc":"2.0","method":method,"params":params}),
            timeout,
        )
    }

    pub(crate) fn drain_events(&self) -> Result<(Vec<Value>, u64), String> {
        let mut inbox = self.wire.inbox.lock().map_err(|_| "ACP 事件状态不可用")?;
        inbox.event_bytes = 0;
        Ok((
            inbox.events.drain(..).collect(),
            std::mem::take(&mut inbox.dropped),
        ))
    }

    pub(crate) fn wait_for_events(&self, timeout: Duration) -> Result<(), String> {
        let inbox = self.wire.inbox.lock().map_err(|_| "ACP 事件状态不可用")?;
        let _guard = self
            .wire
            .event_ready
            .wait_timeout_while(inbox, timeout, |inbox| {
                inbox.events.is_empty() && inbox.failure.is_none()
            })
            .map_err(|_| "ACP 事件状态不可用")?
            .0;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn wait_events(&self, timeout: Duration) -> Result<(Vec<Value>, u64), String> {
        self.wait_for_events(timeout)?;
        self.drain_events()
    }

    pub(crate) fn respond_client_request(
        &self,
        request_id: &str,
        outcome: Value,
    ) -> Result<(), AcpDispatchError> {
        self.respond_client_request_inner(request_id, outcome, None)
            .map(|_| ())
    }

    pub(crate) fn withdraw_form_request(
        &self,
        request_id: &str,
        session_id: &str,
    ) -> Result<bool, AcpDispatchError> {
        self.respond_client_request_inner(request_id, json!({"action":"cancel"}), Some(session_id))
    }

    fn respond_client_request_inner(
        &self,
        request_id: &str,
        outcome: Value,
        withdrawal_session: Option<&str>,
    ) -> Result<bool, AcpDispatchError> {
        let validate_selected = |request: &ClientRequest| -> Result<(), AcpDispatchError> {
            if outcome.get("outcome").and_then(Value::as_str) == Some("selected") {
                let option_id = outcome.get("optionId").and_then(Value::as_str).ok_or(
                    AcpDispatchError::NotSent("ACP 权限 selected outcome 缺少 optionId"),
                )?;
                if !request.option_ids.iter().any(|known| known == option_id) {
                    return Err(AcpDispatchError::NotSent(
                        "ACP 权限 optionId 不属于原生请求",
                    ));
                }
            }
            Ok(())
        };
        {
            let mut inbox = self
                .wire
                .inbox
                .lock()
                .map_err(|_| AcpDispatchError::NotSent("ACP 反向请求状态不可用"))?;
            let Some(request) = inbox.client_requests.get_mut(request_id) else {
                return if withdrawal_session.is_some() {
                    Ok(false)
                } else {
                    Err(AcpDispatchError::NotSent("ACP 反向请求不存在或已回复"))
                };
            };
            if let Some(session) = withdrawal_session
                && (request.method != "elicitation/create"
                    || request.session_id.as_deref() != Some(session))
            {
                return Err(AcpDispatchError::NotSent("ACP 撤销不属于此原生会话表单"));
            }
            if request.method != "session/request_permission"
                && request.method != "elicitation/create"
            {
                return Err(AcpDispatchError::NotSent("ACP 反向请求类型不支持"));
            }
            if request.responding {
                if withdrawal_session.is_some() {
                    return Ok(false);
                }
                return Err(AcpDispatchError::NotSent("ACP 反向请求已有回复正在发送"));
            }
            if request.method == "session/request_permission" {
                validate_selected(request)?;
            }
            request.responding = true;
        }
        let response_id = {
            let inbox = self
                .wire
                .inbox
                .lock()
                .map_err(|_| AcpDispatchError::NotSent("ACP 反向请求状态不可用"))?;
            inbox
                .client_requests
                .get(request_id)
                .map(|request| request.response_id.clone())
                .ok_or(AcpDispatchError::NotSent("ACP 反向请求不存在或已回复"))?
        };
        let response_result = {
            let inbox = self
                .wire
                .inbox
                .lock()
                .map_err(|_| AcpDispatchError::NotSent("ACP 反向请求状态不可用"))?;
            let method = inbox
                .client_requests
                .get(request_id)
                .map(|request| request.method.as_str())
                .ok_or(AcpDispatchError::NotSent("ACP 反向请求不存在或已回复"))?;
            if method == "session/request_permission" {
                json!({ "outcome": outcome })
            } else {
                outcome
            }
        };
        let result = self.wire.write_response(response_id, response_result);
        if let Ok(mut inbox) = self.wire.inbox.lock() {
            match &result {
                Ok(()) | Err(AcpDispatchError::Unknown(_)) => {
                    inbox.client_requests.remove(request_id);
                }
                Err(AcpDispatchError::NotSent(_)) | Err(AcpDispatchError::Rejected { .. }) => {
                    if let Some(request) = inbox.client_requests.get_mut(request_id) {
                        request.responding = false;
                    }
                }
            }
        }
        result.map(|_| true)
    }

    pub(crate) fn cancel_pending_client_requests(
        &self,
        session_id: &str,
    ) -> Result<Vec<String>, AcpDispatchError> {
        let requests = {
            let inbox = self
                .wire
                .inbox
                .lock()
                .map_err(|_| AcpDispatchError::NotSent("ACP 反向请求状态不可用"))?;
            inbox
                .client_requests
                .iter()
                .filter(|(_, request)| request.session_id.as_deref() == Some(session_id))
                .map(|(id, request)| (id.clone(), request.method.clone()))
                .collect::<Vec<_>>()
        };
        let mut responded = Vec::new();
        for (request_id, method) in requests {
            let outcome = if method == "session/request_permission" {
                json!({ "outcome": "cancelled" })
            } else {
                json!({ "action": "cancel" })
            };
            self.respond_client_request(&request_id, outcome)?;
            responded.push(request_id);
        }
        Ok(responded)
    }

    pub(crate) fn failure(&self) -> Option<String> {
        self.wire
            .inbox
            .lock()
            .ok()
            .and_then(|inbox| inbox.failure.clone())
    }

    pub(crate) fn has_unresolved_work(&self) -> Result<bool, String> {
        self.wire.has_unresolved_work()
    }

    pub(crate) fn is_running(&self) -> Result<bool, String> {
        self.child
            .lock()
            .map_err(|_| "ACP 进程状态不可用")?
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|_| "无法核对 ACP 进程状态".into())
    }

    #[cfg(test)]
    pub(crate) fn mark_eof_shutdown_requested_for_test(&self) {
        self.wire
            .eof_shutdown_requested
            .store(true, Ordering::Release);
    }

    pub(crate) fn begin_idle_stop(&self) -> Result<(), String> {
        {
            let mut inbox = self.wire.inbox.lock().map_err(|_| "ACP 请求状态不可用")?;
            if inbox.failure.is_some()
                || inbox.unknown_result
                || !inbox.pending.is_empty()
                || !inbox.client_requests.is_empty()
                || !inbox.resource_requests.is_empty()
                || self.wire.has_live_terminals()?
            {
                return Err("OpenCode ACP 仍有活动或未确认操作；请先处理或明确终止连接".into());
            }
            // Close request admission under the same lock that registers work.
            inbox.failure = Some("ACP 闲置连接正在切换".into());
        }
        self.begin_stop()
    }

    pub(crate) fn begin_stop(&self) -> Result<(), String> {
        let running = self.is_running()?;
        let writer = self
            .wire
            .writer
            .lock()
            .map_err(|_| "ACP 输入状态不可用")?
            .take();
        if running && writer.is_some() {
            self.wire
                .eof_shutdown_requested
                .store(true, Ordering::Release);
        }
        drop(writer);
        self.wire.fail("ACP 连接正在关闭；未确认操作需重新核对");
        Ok(())
    }

    pub(crate) fn enable_client_resources(&self, cwd: &std::path::Path) -> Result<(), String> {
        let mut resources = self
            .wire
            .resources
            .lock()
            .map_err(|_| "ACP resource state unavailable")?;
        if resources.is_some() {
            return Err("ACP resource authority is already configured".into());
        }
        *resources = Some(Arc::new(AcpClientResources::new(cwd)?));
        Ok(())
    }

    pub(crate) fn bind_client_session(&self, session: Option<&str>) -> Result<(), String> {
        if let Some(resources) = self
            .wire
            .resources
            .lock()
            .map_err(|_| "ACP resource state unavailable")?
            .as_ref()
        {
            resources.bind(session)?;
        }
        Ok(())
    }

    pub(crate) fn stop(&self) -> Result<(), String> {
        self.begin_stop()?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let observed = self
                .child
                .lock()
                .map_err(|_| "ACP 进程状态不可用")?
                .try_wait();
            match observed {
                Ok(Some(status))
                    if status.success()
                        && self.wire.eof_shutdown_requested.load(Ordering::Acquire) =>
                {
                    return Ok(());
                }
                Ok(Some(status)) if status.success() && !self.wire.has_unresolved_work()? => {
                    return Ok(());
                }
                Ok(Some(_)) => return Err("ACP 异常退出；后台操作结果仍未知".into()),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                _ => {
                    let mut child = self.child.lock().map_err(|_| "ACP 进程状态不可用")?;
                    self.process_group.terminate();
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("ACP 未确认正常退出，已终止自有进程；后台操作结果仍未知".into());
                }
            }
        }
    }
}

impl Drop for AcpTransport {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn dispatched_response_timeout_preserves_unknown_without_holding_the_writer() {
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").args([
            "-u",
            "-c",
            "import sys\nsys.stdin.read()\n",
        ]))
        .unwrap();
        let pending = transport
            .begin_request_unbounded("_pi/steer", json!({"sessionId":"native","message":"test"}))
            .unwrap();
        assert!(matches!(
            pending.wait_timeout(Duration::from_millis(10)),
            Err(AcpDispatchError::Unknown(_))
        ));
        assert!(transport.wire.inbox.lock().unwrap().pending.is_empty());
        assert!(transport.has_unresolved_work().unwrap());
        transport
            .notify_timeout(
                "session/cancel",
                json!({"sessionId":"native"}),
                Duration::from_millis(100),
            )
            .unwrap();
        transport.stop().unwrap();
    }
    #[test]
    fn abandoned_dispatched_request_retains_unknown_outcome_without_leaking_pending_slot() {
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").args([
            "-u",
            "-c",
            "import sys\nsys.stdin.read()\n",
        ]))
        .unwrap();
        let pending = transport
            .begin_request_unbounded("session/prompt", json!({"sessionId":"native"}))
            .unwrap();
        assert_eq!(transport.wire.inbox.lock().unwrap().pending.len(), 1);
        drop(pending);
        assert!(transport.wire.inbox.lock().unwrap().pending.is_empty());
        assert!(transport.has_unresolved_work().unwrap());
        transport.stop().unwrap();
    }

    #[test]
    fn oversized_native_notification_is_counted_without_pending_work_or_connection_failure() {
        use super::{AcpReadLimit, AcpTransport};
        use serde_json::json;
        use std::process::Command;
        let transport = AcpTransport::spawn_with_read_limit(Command::new("/usr/bin/python3").args(["-u", "-c", r#"
import sys,json
request=json.loads(sys.stdin.readline())
print(json.dumps({'jsonrpc':'2.0','method':'_pi/event','params':{'version':1,'sessionId':'native','event':{'type':'future','text':'x'*(1024*1024)}}}),flush=True)
print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'ok':True}}),flush=True)
sys.stdin.read()
"#]), AcpReadLimit::NativeHistory).unwrap();
        assert_eq!(
            transport.request("fixture/probe", json!({})).unwrap()["ok"],
            true
        );
        let (events, dropped) = transport.drain_events().unwrap();
        assert!(events.is_empty());
        assert_eq!(dropped, 1);
        assert!(!transport.has_unresolved_work().unwrap());
        assert!(transport.failure().is_none());
        transport.stop().unwrap();
    }

    #[test]
    fn oversized_reverse_requests_are_rejected_without_invisible_pending_interactions() {
        use super::{AcpReadLimit, AcpTransport};
        use serde_json::json;
        use std::{process::Command, time::Duration};
        for method in ["session/request_permission", "elicitation/create"] {
            let transport = AcpTransport::spawn_with_read_limit(Command::new("/usr/bin/python3").args(["-u", "-c", r#"
import sys,json
request=json.loads(sys.stdin.readline())
params={'sessionId':'native','mode':'form','message':'large form','requestedSchema':{'type':'object','properties':{}},'toolCall':{'toolCallId':'tool','title':'large permission'},'options':[{'optionId':'allow','kind':'allow_once','name':'Allow'}],'_meta':{'large':'x'*(1024*1024)}}
print(json.dumps({'jsonrpc':'2.0','id':7,'method':sys.argv[1],'params':params}),flush=True)
reply=json.loads(sys.stdin.readline())
print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'reply':reply}}),flush=True)
sys.stdin.read()
"#]).arg(method), AcpReadLimit::NativeHistory).unwrap();
            let response =
                transport.request_timeout("fixture/probe", json!({}), Duration::from_secs(1));
            let pending = transport.wire.inbox.lock().unwrap().client_requests.len();
            let (events, dropped) = transport.drain_events().unwrap();
            let stopped = transport.stop();
            let response = response.unwrap_or_else(|error| panic!("{method}: {error}; invisible pending={pending}, visible events={}, dropped={dropped}, stop={stopped:?}", events.len()));
            assert_eq!(response["reply"]["id"], 7);
            assert!(response["reply"]["error"]["code"].is_number());
            assert_eq!(pending, 0);
            stopped.unwrap();
        }
    }

    #[test]
    fn native_history_read_limit_is_explicit_and_bulk_responses_do_not_enter_event_queue() {
        use super::{AcpReadLimit, AcpTransport, MAX_FRAME, read_frame};
        use serde_json::json;
        use std::{io::Cursor, process::Command};
        let large = format!("{}\n", "x".repeat(MAX_FRAME + 10));
        assert!(read_frame(&mut Cursor::new(large.as_bytes()), AcpReadLimit::Standard).is_err());
        assert_eq!(
            read_frame(
                &mut Cursor::new(large.as_bytes()),
                AcpReadLimit::NativeHistory
            )
            .unwrap()
            .unwrap()
            .len(),
            large.len()
        );
        let too_large = vec![b'x'; 16 * MAX_FRAME + 1];
        assert!(read_frame(&mut Cursor::new(too_large), AcpReadLimit::NativeHistory).is_err());
        let transport = AcpTransport::spawn_with_read_limit(Command::new("/usr/bin/python3").args(["-u", "-c", r#"
import sys,json
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'text':'x'*(1024*1024+10)}}),flush=True)
"#]), AcpReadLimit::NativeHistory).unwrap();
        let response = transport.request("_pi/workspace", json!({})).unwrap();
        assert_eq!(response["text"].as_str().unwrap().len(), MAX_FRAME + 10);
        let (events, dropped) = transport.drain_events().unwrap();
        assert!(events.is_empty());
        assert_eq!(dropped, 0);
        assert!(!transport.has_unresolved_work().unwrap());
        transport.stop().unwrap();
    }

    #[test]
    fn file_and_terminal_callbacks_do_not_block_control_responses() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().canonicalize().unwrap();
        let script = cwd.join("resource-fixture.py");
        std::fs::write(&script, r#"
import json,sys,pathlib
def send(value): print(json.dumps(value),flush=True)
def request(id,method,params):
    send({"jsonrpc":"2.0","id":id,"method":method,"params":params})
    reply=json.loads(sys.stdin.readline())
    assert reply["id"]==id, reply
    return reply
prompt=json.loads(sys.stdin.readline())
path=str(pathlib.Path.cwd()/"created.txt")
assert "error" in request(0,"fs/write_text_file",{"sessionId":"wrong","path":path,"content":"wrong"})
assert not pathlib.Path(path).exists()
assert request(1,"fs/write_text_file",{"sessionId":"ses","path":path,"content":"callback-data\n"})["result"]=={}
assert request(2,"fs/read_text_file",{"sessionId":"ses","path":path})["result"]["content"]=="callback-data\n"
terminal=request(3,"terminal/create",{"sessionId":"ses","command":"/bin/sh","args":["-c","sleep 1; printf callback-output"],"outputByteLimit":64})["result"]["terminalId"]
params={"sessionId":"ses","terminalId":terminal}
send({"jsonrpc":"2.0","id":4,"method":"terminal/wait_for_exit","params":params})
send({"jsonrpc":"2.0","id":prompt["id"],"result":{"stopReason":"end_turn"}})
reply=json.loads(sys.stdin.readline())
assert reply["id"]==4 and reply["result"]["exitCode"]==0, reply
output=request(5,"terminal/output",params)["result"]
assert output["output"]=="callback-output" and output["exitStatus"]["exitCode"]==0, output
assert request(6,"terminal/release",params)["result"]=={}
send({"jsonrpc":"2.0","method":"_fixture/done","params":{}})
for line in sys.stdin: pass
"#).unwrap();
        let transport = AcpTransport::spawn(
            Command::new("/usr/bin/python3")
                .arg(script)
                .current_dir(&cwd),
        )
        .unwrap();
        transport.enable_client_resources(&cwd).unwrap();
        transport.bind_client_session(Some("ses")).unwrap();
        let started = Instant::now();
        assert_eq!(
            transport
                .request("session/prompt", json!({"sessionId":"ses"}))
                .unwrap()["stopReason"],
            "end_turn"
        );
        assert!(
            started.elapsed() < Duration::from_millis(800),
            "terminal wait blocked ACP reader"
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let (events, _) = transport.wait_events(Duration::from_millis(50)).unwrap();
            if events
                .iter()
                .any(|event| event["method"] == "_fixture/done")
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "resource callback flow did not finish: {:?}",
                transport.failure()
            );
        }
        assert_eq!(
            std::fs::read_to_string(cwd.join("created.txt")).unwrap(),
            "callback-data\n"
        );
        transport.stop().unwrap();
        assert!(transport.bind_client_session(Some("new")).is_err());
    }
    use super::*;

    #[test]
    fn adapter_exit_closes_owned_descendant_server() {
        let temp = tempfile::tempdir().unwrap();
        let port_file = temp.path().join("port");
        let script = temp.path().join("adapter.py");
        std::fs::write(&script, format!(r#"
import json, subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', 'import socket,time,pathlib,sys; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); pathlib.Path(sys.argv[1]).write_text(str(s.getsockname()[1])); time.sleep(60)', {port:?}], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({{"jsonrpc":"2.0","id":request["id"],"result":{{}}}}),flush=True)
"#, port=port_file.to_string_lossy())).unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        transport.request("initialize", json!({})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !port_file.exists() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        let port: u16 = std::fs::read_to_string(port_file).unwrap().parse().unwrap();
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        assert!(std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok());
        transport.child.lock().unwrap().kill().unwrap();
        while std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() {
            assert!(
                Instant::now() < deadline,
                "owned descendant listener survived adapter exit"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert!(transport.stop().is_err());
    }

    #[test]
    fn explicitly_unknown_adapter_response_is_not_a_rejection() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("unknown.py");
        std::fs::write(&script, r#"
import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"not confirmed","data":{"farfoldOutcomeUnknown":request["method"]=="unknown"}}}),flush=True)
"#).unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        assert!(matches!(
            transport.request("unknown", json!({})),
            Err(AcpDispatchError::Unknown(_))
        ));
        assert!(transport.begin_idle_stop().is_err());
        assert!(matches!(
            transport.request("rejected", json!({})),
            Err(AcpDispatchError::Rejected { code: -32000, .. })
        ));
        transport.stop().unwrap();
    }

    #[test]
    fn timeout_late_reply_and_eof_have_distinct_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-fixture.py");
        std::fs::write(
            &script,
            r#"
import json,sys,time
for line in sys.stdin:
    request=json.loads(line)
    if request["method"]=="slow": time.sleep(0.12)
    print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"method":request["method"]}}),flush=True)
"#,
        )
        .unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        let timeout = transport
            .request_timeout("slow", json!({}), Duration::from_millis(20))
            .unwrap_err();
        assert!(matches!(timeout, AcpDispatchError::Unknown(_)));
        assert!(timeout.to_string().contains("尚未确认"));
        assert_eq!(
            transport.request("second", json!({})).unwrap()["method"],
            "second"
        );
        assert_eq!(transport.drain_events().unwrap().1, 1);
        transport.stop().unwrap();
        assert!(!transport.is_running().unwrap());
        assert!(transport.request("after-stop", json!({})).is_err());
    }

    #[test]
    fn events_are_bounded_and_do_not_satisfy_requests() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-events.py");
        std::fs::write(
            &script,
            r#"
import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"x"}}}),flush=True)
    print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"ok":True}}),flush=True)
"#,
        )
        .unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        assert_eq!(
            transport.request("initialize", json!({})).unwrap()["ok"],
            true
        );
        let (events, dropped) = transport.drain_events().unwrap();
        assert_eq!(dropped, 0);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["method"], "session/update");
    }

    #[test]
    fn client_requests_receive_explicit_unsupported_response_without_hanging_agent() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-client-request.py");
        std::fs::write(
            &script,
            r#"
import json,sys
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":"agent-request-1","method":"requestPermission","params":{"sessionId":"s"}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["jsonrpc"]=="2.0"
assert reply["id"]=="agent-request-1"
assert reply["error"]["code"]==-32601
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"ok":True}}),flush=True)
"#,
        )
        .unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        assert_eq!(
            transport.request("initialize", json!({})).unwrap()["ok"],
            true
        );
        let (events, dropped) = transport.drain_events().unwrap();
        assert_eq!(dropped, 0);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["method"], "requestPermission");
    }

    #[test]
    fn responses_without_jsonrpc_version_fail_the_connection() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-bad-jsonrpc.py");
        std::fs::write(
            &script,
            r#"
import json,sys
request=json.loads(sys.stdin.readline())
print(json.dumps({"id":request["id"],"result":{"ok":True}}),flush=True)
"#,
        )
        .unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        let error = transport.request("initialize", json!({})).unwrap_err();
        assert!(error.to_string().contains("JSON-RPC"));
    }

    #[test]
    fn write_timeout_and_stop_do_not_deadlock_when_child_never_reads_stdin() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-no-read.py");
        std::fs::write(
            &script,
            r#"
import time
time.sleep(60)
"#,
        )
        .unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        let large = "x".repeat(900_000);
        for _ in 0..4 {
            let started = Instant::now();
            let result = transport.request_timeout(
                "fill",
                json!({"payload": large}),
                Duration::from_millis(80),
            );
            assert!(matches!(
                result,
                Err(AcpDispatchError::Unknown(_) | AcpDispatchError::NotSent(_))
            ));
            assert!(started.elapsed() < Duration::from_secs(3));
        }
        let started = Instant::now();
        assert!(transport.stop().is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!transport.is_running().unwrap());
    }

    #[test]
    fn saturated_write_queue_and_concurrent_stop_are_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-no-read-many.py");
        std::fs::write(
            &script,
            r#"
import time
time.sleep(60)
"#,
        )
        .unwrap();
        let transport =
            Arc::new(AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap());
        let mut workers = Vec::new();
        for _ in 0..(MAX_PENDING + 8) {
            let transport = transport.clone();
            workers.push(thread::spawn(move || {
                transport.request_timeout(
                    "fill",
                    json!({"payload": "x".repeat(900_000)}),
                    Duration::from_millis(200),
                )
            }));
        }
        thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        let stopped = transport.stop();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(stopped.is_err());
        for worker in workers {
            let result = worker.join().unwrap();
            assert!(matches!(
                result,
                Err(AcpDispatchError::Unknown(_) | AcpDispatchError::NotSent(_))
            ));
        }
        assert!(!transport.is_running().unwrap());
    }

    #[test]
    fn reverse_request_pressure_does_not_block_response_processing() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-request-pressure.py");
        std::fs::write(
            &script,
            r#"
import json,sys
request=json.loads(sys.stdin.readline())
for i in range(8):
    print(json.dumps({"jsonrpc":"2.0","id":"agent-request-"+str(i),"method":"requestPermission","params":{"sessionId":"s"}}),flush=True)
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"ok":True}}),flush=True)
"#,
        )
        .unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        assert_eq!(
            transport
                .request_timeout("initialize", json!({}), Duration::from_secs(2))
                .unwrap()["ok"],
            true
        );
        let (events, dropped) = transport.drain_events().unwrap();
        assert_eq!(dropped, 0);
        assert!(!events.is_empty());
    }

    #[test]
    fn reverse_request_reply_saturation_fails_connection_and_preserves_events() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-reverse-saturation.py");
        std::fs::write(
            &script,
            r#"
import json,sys,time
json.loads(sys.stdin.readline())
for i in range(4096):
    print(json.dumps({"jsonrpc":"2.0","id":"agent-request-"+str(i),"method":"requestPermission","params":{"sessionId":"s"}}),flush=True)
time.sleep(60)
"#,
        )
        .unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        let started = Instant::now();
        let result = transport.request_timeout("initialize", json!({}), Duration::from_secs(8));
        assert!(matches!(
            result,
            Err(AcpDispatchError::Unknown(_) | AcpDispatchError::NotSent(_))
        ));
        assert!(started.elapsed() < Duration::from_secs(8));
        assert!(transport.failure().unwrap().contains("反向请求拒绝"));
        let (events, dropped) = transport.drain_events().unwrap();
        assert!(!events.is_empty());
        assert!(dropped <= 4096);
        assert_eq!(events[0]["method"], "requestPermission");
        let _ = transport.stop();
    }

    #[test]
    fn prompt_keeps_pending_while_updates_and_permission_wait_for_user_response() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-prompt-permission.py");
        let marker = temp.path().join("permission-replied");
        std::fs::write(
            &script,
            format!(
                r#"
import json,sys,time,pathlib
request=json.loads(sys.stdin.readline())
print(json.dumps({{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"ses_keep","update":{{"sessionUpdate":"agent_message_chunk","messageId":"msg_1","content":{{"type":"text","text":"hello"}}}}}}}}),flush=True)
print(json.dumps({{"jsonrpc":"2.0","id":"agent-permission-1","method":"session/request_permission","params":{{"sessionId":"ses_keep","toolCall":{{"toolCallId":"call_1","title":"Run tool"}},"options":[{{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}}]}}}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["id"]=="agent-permission-1"
assert reply["result"]["outcome"]["outcome"]=="selected"
assert reply["result"]["outcome"]["optionId"]=="allow-once"
pathlib.Path({marker:?}).write_text("ok")
print(json.dumps({{"jsonrpc":"2.0","id":request["id"],"result":{{"stopReason":"end_turn"}}}}),flush=True)
"#,
            ),
        )
        .unwrap();
        let transport =
            Arc::new(AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap());
        let (sender, receiver) = mpsc::sync_channel(1);
        let prompt_transport = transport.clone();
        thread::spawn(move || {
            sender
                .send(prompt_transport.request_unbounded(
                    "session/prompt",
                    json!({"sessionId":"ses_keep","prompt":[{"type":"text","text":"go"}]}),
                ))
                .unwrap();
        });
        let mut all_events = Vec::new();
        let mut dropped_total = 0;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline
            && (!all_events
                .iter()
                .any(|event: &Value| event["method"] == "session/update")
                || !all_events
                    .iter()
                    .any(|event: &Value| event["method"] == "session/request_permission"))
        {
            let (events, dropped) = transport.wait_events(Duration::from_millis(100)).unwrap();
            dropped_total += dropped;
            all_events.extend(events);
        }
        assert_eq!(dropped_total, 0);
        assert!(transport.begin_idle_stop().is_err());
        assert!(
            all_events
                .iter()
                .any(|event| event["method"] == "session/update")
        );
        assert!(
            all_events
                .iter()
                .any(|event| event["method"] == "session/request_permission")
        );
        assert!(receiver.try_recv().is_err());
        assert!(!marker.exists());
        transport
            .respond_client_request(
                "agent-permission-1",
                json!({"outcome":"selected","optionId":"allow-once"}),
            )
            .unwrap();
        let result = receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert_eq!(result["stopReason"], "end_turn");
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "ok");
        transport.stop().unwrap();
    }

    #[test]
    fn elicitation_create_is_replied_with_direct_acp_result() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-elicitation.py");
        let marker = temp.path().join("elicitation-replied");
        std::fs::write(
            &script,
            format!(
                r#"
import json,sys,pathlib
request=json.loads(sys.stdin.readline())
print(json.dumps({{"jsonrpc":"2.0","id":"agent-question-1","method":"elicitation/create","params":{{"sessionId":"ses_keep","mode":"form","message":"Choose","requestedSchema":{{"type":"object","properties":{{"choice":{{"type":"string","enum":["ACP bridge","Stop"]}}}},"required":["choice"]}}}}}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["id"]=="agent-question-1"
assert reply["result"]["action"]=="accept"
assert reply["result"]["content"]["choice"]=="ACP bridge"
assert "outcome" not in reply["result"]
pathlib.Path({marker:?}).write_text("ok")
print(json.dumps({{"jsonrpc":"2.0","id":request["id"],"result":{{"stopReason":"end_turn"}}}}),flush=True)
"#,
            ),
        )
        .unwrap();
        let transport =
            Arc::new(AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap());
        let prompt_transport = transport.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            sender
                .send(prompt_transport.request_unbounded(
                    "session/prompt",
                    json!({"sessionId":"ses_keep","prompt":[{"type":"text","text":"ask"}]}),
                ))
                .unwrap();
        });
        let (events, dropped) = transport.wait_events(Duration::from_secs(2)).unwrap();
        assert_eq!(dropped, 0);
        assert_eq!(events[0]["method"], "elicitation/create");
        assert!(receiver.try_recv().is_err());
        transport
            .respond_client_request(
                "agent-question-1",
                json!({"action":"accept","content":{"choice":"ACP bridge"}}),
            )
            .unwrap();
        let result = receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert_eq!(result["stopReason"], "end_turn");
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "ok");
        transport.stop().unwrap();
    }

    #[test]
    fn pending_permission_can_be_cancelled_for_session_without_user_approval() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-cancel-permission.py");
        std::fs::write(
            &script,
            r#"
import json,sys
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":"agent-permission-1","method":"session/request_permission","params":{"sessionId":"ses_keep","toolCall":{"toolCallId":"call_1"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["id"]=="agent-permission-1"
assert reply["result"]["outcome"]["outcome"]=="cancelled"
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"cancelled"}}),flush=True)
"#,
        )
        .unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        let (sender, receiver) = mpsc::sync_channel(1);
        let prompt = Arc::new(transport);
        let worker = prompt.clone();
        thread::spawn(move || {
            sender
                .send(worker.request_unbounded(
                    "session/prompt",
                    json!({"sessionId":"ses_keep","prompt":[{"type":"text","text":"go"}]}),
                ))
                .unwrap();
        });
        let (events, _) = prompt.wait_events(Duration::from_secs(2)).unwrap();
        assert!(
            events
                .iter()
                .any(|event| event["method"] == "session/request_permission")
        );
        assert_eq!(
            prompt.cancel_pending_client_requests("ses_keep").unwrap(),
            vec!["agent-permission-1".to_string()]
        );
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap()["stopReason"],
            "cancelled"
        );
        prompt.stop().unwrap();
    }

    #[test]
    fn permission_response_validates_native_options_and_keeps_retry_before_send() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-permission-options.py");
        std::fs::write(
            &script,
            r#"
import json,sys
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":"agent-permission-1","method":"session/request_permission","params":{"sessionId":"ses_keep","toolCall":{"toolCallId":"call_1"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["result"]["outcome"]["optionId"]=="allow-once"
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#,
        )
        .unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        let (sender, receiver) = mpsc::sync_channel(1);
        let transport = Arc::new(transport);
        let worker = transport.clone();
        thread::spawn(move || {
            sender
                .send(worker.request_unbounded(
                    "session/prompt",
                    json!({"sessionId":"ses_keep","prompt":[{"type":"text","text":"go"}]}),
                ))
                .unwrap();
        });
        let (events, _) = transport.wait_events(Duration::from_secs(2)).unwrap();
        assert!(
            events
                .iter()
                .any(|event| event["method"] == "session/request_permission")
        );
        let rejected = transport
            .respond_client_request(
                "agent-permission-1",
                json!({"outcome":"selected","optionId":"made-up"}),
            )
            .unwrap_err();
        assert!(rejected.to_string().contains("optionId"));
        transport
            .respond_client_request(
                "agent-permission-1",
                json!({"outcome":"selected","optionId":"allow-once"}),
            )
            .unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap()["stopReason"],
            "end_turn"
        );
        assert!(
            transport
                .respond_client_request(
                    "agent-permission-1",
                    json!({"outcome":"selected","optionId":"allow-once"}),
                )
                .is_err()
        );
        transport.stop().unwrap();
    }

    #[test]
    fn numeric_reverse_permission_id_is_replied_with_original_json_rpc_id() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("acp-numeric-permission-id.py");
        std::fs::write(
            &script,
            r#"
import json,sys
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"ses_keep","toolCall":{"toolCallId":"call_1"},"options":[{"optionId":"once","name":"Allow once","kind":"allow_once"}]}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["id"]==0
assert reply["result"]["outcome"]["outcome"]=="selected"
assert reply["result"]["outcome"]["optionId"]=="once"
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#,
        )
        .unwrap();
        let transport = AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        let transport = Arc::new(transport);
        let worker = transport.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            sender
                .send(worker.request_unbounded(
                    "session/prompt",
                    json!({"sessionId":"ses_keep","prompt":[{"type":"text","text":"go"}]}),
                ))
                .unwrap();
        });
        let (events, _) = transport.wait_events(Duration::from_secs(2)).unwrap();
        assert!(
            events
                .iter()
                .any(|event| event["method"] == "session/request_permission" && event["id"] == 0)
        );
        transport
            .respond_client_request("0", json!({"outcome":"selected","optionId":"once"}))
            .unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap()["stopReason"],
            "end_turn"
        );
        transport.stop().unwrap();
    }
}
