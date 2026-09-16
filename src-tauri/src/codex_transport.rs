//! Codex 0.143.0 JSONL control transport. No Agent loop, retries, or public
//! arbitrary-RPC command. Authentication payloads stay in memory, never logs.
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME: usize = 1024 * 1024;
const MAX_EVENTS: usize = 256;
const MAX_PENDING: usize = 32;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);
/// Only a correlated, well-formed native error proves rejection. A failed
/// write may already have delivered a prefix (or the full request), and a
/// response timeout says nothing about execution. Never release task admission
/// merely because either of those operations returned an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DispatchError {
    NotSent(&'static str),
    Rejected { code: i64 },
    Unknown(String),
}

impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotSent(message) => f.write_str(message),
            Self::Rejected { code } => write!(f, "Codex 控制请求失败（错误码 {code}）"),
            Self::Unknown(message) => f.write_str(message),
        }
    }
}

type Response = Result<Value, DispatchError>;

#[derive(Default)]
struct Inbox {
    pending: HashMap<String, mpsc::SyncSender<Response>>,
    events: VecDeque<Value>,
    event_bytes: usize,
    dropped: u64,
    failure: Option<String>,
}

#[derive(Default)]
struct ServerRequests {
    pending: HashMap<String, (Value, String, String)>,
    seen: HashSet<String>,
}

struct Wire {
    server_requests: Mutex<ServerRequests>,
    stdin: Mutex<Option<ChildStdin>>,
    inbox: Mutex<Inbox>,
    next_id: AtomicU64,
    event_ready: Condvar,
    consumer_started: AtomicBool,
    eof_shutdown_requested: AtomicBool,
}

impl Wire {
    fn write(&self, envelope: &Value) -> Result<(), DispatchError> {
        let mut bytes = serde_json::to_vec(envelope)
            .map_err(|_| DispatchError::NotSent("Codex 请求编码失败"))?;
        if bytes.len() > MAX_FRAME {
            return Err(DispatchError::NotSent("Codex 请求超过大小限制"));
        }
        bytes.push(b'\n');
        let mut input = self
            .stdin
            .lock()
            .map_err(|_| DispatchError::NotSent("Codex 输入状态不可用"))?;
        let result = input
            .as_mut()
            .ok_or(DispatchError::NotSent("Codex 连接已经关闭"))?
            .write_all(&bytes)
            .map_err(|_| {
                DispatchError::Unknown("无法完整写入 Codex 连接；操作结果尚未确认".into())
            });
        if let Err(DispatchError::Unknown(message)) = &result {
            // A partial JSONL frame must never be followed by another request.
            input.take();
            drop(input);
            self.fail(message);
        }
        result
    }

    fn fail(&self, message: &str) {
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.failure.get_or_insert_with(|| message.to_owned());
            for (_, sender) in inbox.pending.drain() {
                let _ = sender.send(Err(DispatchError::Unknown(message.to_owned())));
            }
        }
        self.event_ready.notify_all();
    }

    fn receive(&self, envelope: Value, size: usize) -> Result<(), String> {
        if !envelope.is_object() {
            return Err("Codex 返回了无效协议消息".into());
        }
        if envelope.get("method").is_some() {
            if !envelope["method"].is_string() {
                return Err("Codex 方法名称无效".into());
            }
            if let Some(id) = envelope.get("id") {
                let key = crate::codex_interactions::request_key(id)?;
                let mut requests = self
                    .server_requests
                    .lock()
                    .map_err(|_| "Codex 交互状态不可用")?;
                if requests.seen.contains(&key) {
                    return Ok(());
                }
                if requests.seen.len() >= 8192 || requests.pending.len() >= 32 {
                    return Err("Codex 交互缓冲已达上限；连接结果需核对".into());
                }
                requests.seen.insert(key.clone());
                if crate::codex_interactions::supported(envelope["method"].as_str().unwrap_or("")) {
                    let parsed =
                        crate::codex_interactions::CodexInteraction::parse(envelope.clone())?;
                    requests
                        .pending
                        .insert(key, (id.clone(), parsed.thread_id, parsed.turn_id));
                } else {
                    self.write(&json!({"id":id,"error":{"code":-32601,
                        "message":"This Farfold connection does not support this interaction"}}))
                        .map_err(|e| e.to_string())?;
                }
            } else if envelope["method"] == "serverRequest/resolved" {
                let key = crate::codex_interactions::request_key(&envelope["params"]["requestId"])?;
                let mut requests = self
                    .server_requests
                    .lock()
                    .map_err(|_| "Codex 交互状态不可用")?;
                if requests.pending.get(&key).is_some_and(|(_, thread, _)| {
                    Some(thread.as_str()) == envelope["params"]["threadId"].as_str()
                }) {
                    requests.pending.remove(&key);
                }
            } else if envelope["method"] == "turn/completed" {
                let mut requests = self
                    .server_requests
                    .lock()
                    .map_err(|_| "Codex 交互状态不可用")?;
                requests.pending.retain(|_, (_, thread, turn)| {
                    Some(thread.as_str()) != envelope["params"]["threadId"].as_str()
                        || Some(turn.as_str()) != envelope["params"]["turn"]["id"].as_str()
                });
            }
            let mut inbox = self.inbox.lock().map_err(|_| "Codex 事件状态不可用")?;
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
            return Ok(());
        }
        let id = envelope
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Codex 响应缺少请求身份")?;
        let mut inbox = self.inbox.lock().map_err(|_| "Codex 响应状态不可用")?;
        let Some(sender) = inbox.pending.remove(id) else {
            // Duplicate or expired control reply: never reapply an operation.
            inbox.dropped += 1;
            self.event_ready.notify_one();
            return Ok(());
        };
        let response = match (envelope.get("result"), envelope.get("error")) {
            (Some(value), None) => Ok(value.clone()),
            (None, Some(error))
                if error.is_object() && error["code"].is_i64() && error["message"].is_string() =>
            {
                // Native messages/data may echo credentials. Keep only the
                // actual protocol code; malformed errors cannot prove rejection.
                Err(DispatchError::Rejected {
                    code: error["code"].as_i64().unwrap(),
                })
            }
            _ => Err(DispatchError::Unknown(
                "Codex 控制响应格式无效；操作结果尚未确认".into(),
            )),
        };
        let _ = sender.send(response);
        Ok(())
    }
}

pub(crate) struct CodexTransport {
    wire: Arc<Wire>,
    child: Mutex<Child>,
}

// A bounded reader must not allocate an arbitrary native tool output line.
fn read_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut frame = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(|_| "读取 Codex 输出失败")?;
        if buffer.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err("Codex 输出在消息中途断开".into())
            };
        }
        let end = buffer.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(buffer.len(), |i| i + 1);
        if frame.len() + count > MAX_FRAME {
            return Err("Codex 消息超过 1 MiB；连接结果未知".into());
        }
        frame.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(Some(frame));
        }
    }
}

impl CodexTransport {
    pub(crate) fn spawn(command: &mut Command) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "无法启动 Codex App Server")?;
        let stdout = child.stdout.take().expect("piped stdout");
        let wire = Arc::new(Wire {
            stdin: Mutex::new(child.stdin.take()),
            inbox: Mutex::new(Inbox::default()),
            next_id: AtomicU64::new(1),
            event_ready: Condvar::new(),
            consumer_started: AtomicBool::new(false),
            eof_shutdown_requested: AtomicBool::new(false),
            server_requests: Mutex::new(ServerRequests::default()),
        });
        let reader_wire = wire.clone();
        let result = thread::Builder::new()
            .name("codex-stdio".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let result: Result<(), String> = (|| {
                    while let Some(frame) = read_frame(&mut reader)? {
                        let envelope: Value =
                            serde_json::from_slice(&frame).map_err(|_| "Codex 返回了无效 JSON")?;
                        let size = envelope.to_string().len();
                        reader_wire.receive(envelope, size)?;
                    }
                    Err("Codex 输出已断开；需重新连接核对状态".into())
                })();
                if let Err(message) = result {
                    reader_wire.fail(&message);
                }
                // Protocol corruption or EOF closes our input as well, allowing the
                // official server to shut down its threads instead of lingering.
                if let Ok(mut input) = reader_wire.stdin.lock() {
                    input.take();
                }
            });
        if result.is_err() {
            if let Ok(mut input) = wire.stdin.lock() {
                input.take();
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err("无法创建 Codex 输出读取器".into());
        }
        Ok(Self {
            wire,
            child: Mutex::new(child),
        })
    }

    /// The same lock orders native resolution, Stop and user replies. Remove
    /// before write: an unknown partial write must never permit a second reply.
    pub(crate) fn respond(
        &self,
        key: &str,
        thread: &str,
        turn: &str,
        result: Value,
    ) -> Result<(), DispatchError> {
        let mut requests = self
            .wire
            .server_requests
            .lock()
            .map_err(|_| DispatchError::NotSent("Codex 交互状态不可用"))?;
        if !requests
            .pending
            .get(key)
            .is_some_and(|(_, t, r)| t == thread && r == turn)
        {
            return Err(DispatchError::NotSent(
                "Codex 交互已失效、已回复或不属于此轮次",
            ));
        }
        let (id, _, _) = requests.pending.remove(key).expect("checked request");
        self.wire.write(&json!({"id":id,"result":result}))
    }

    pub(crate) fn invalidate_interactions(&self, thread: &str, turn: &str) -> Result<(), String> {
        let mut requests = self
            .wire
            .server_requests
            .lock()
            .map_err(|_| "Codex 交互状态不可用")?;
        requests
            .pending
            .retain(|_, (_, t, r)| t != thread || r != turn);
        Ok(())
    }

    pub(crate) fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.dispatch(method, params)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn dispatch(&self, method: &str, params: Value) -> Response {
        self.request_timeout(method, params, CONTROL_TIMEOUT)
    }

    fn request_timeout(&self, method: &str, params: Value, timeout: Duration) -> Response {
        let id = format!(
            "farfold-{}",
            self.wire.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut inbox = self
                .wire
                .inbox
                .lock()
                .map_err(|_| DispatchError::NotSent("Codex 请求状态不可用"))?;
            if inbox.failure.is_some() {
                return Err(DispatchError::NotSent("Codex 连接已经失效；请求未发送"));
            }
            if inbox.pending.len() >= MAX_PENDING {
                return Err(DispatchError::NotSent("Codex 控制请求过多，请稍后重试"));
            }
            inbox.pending.insert(id.clone(), sender);
        }
        let result = self
            .wire
            .write(&json!({"id":id,"method":method,"params":params}))
            .and_then(|()| {
                receiver.recv_timeout(timeout).map_err(|_| {
                    DispatchError::Unknown(
                        "Codex 控制请求超时或响应通道断开；操作结果尚未确认".to_owned(),
                    )
                })?
            });
        if let Ok(mut inbox) = self.wire.inbox.lock() {
            inbox.pending.remove(&id);
        }
        result
    }

    pub(crate) fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.wire
            .write(&json!({"method":method,"params":params}))
            .map_err(|e| e.to_string())
    }

    /// One ordered consumer, independent of control response waiters. The
    /// reader only queues bounded native envelopes; Host/SQLite/UI work never
    /// runs while holding the wire inbox lock.
    pub(crate) fn consume_events(
        &self,
        mut receive: impl FnMut(Vec<Value>, u64, Option<String>) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        if self.wire.consumer_started.swap(true, Ordering::AcqRel) {
            return Err("Codex 事件订阅已启动".into());
        }
        let wire = self.wire.clone();
        let spawned = thread::Builder::new()
            .name("codex-events".into())
            .spawn(move || {
                loop {
                    let batch = (|| {
                        let mut inbox = wire.inbox.lock().map_err(|_| "Codex 事件状态不可用")?;
                        while inbox.events.is_empty()
                            && inbox.dropped == 0
                            && inbox.failure.is_none()
                        {
                            inbox = wire
                                .event_ready
                                .wait(inbox)
                                .map_err(|_| "Codex 事件等待失败")?;
                        }
                        inbox.event_bytes = 0;
                        Ok::<_, String>((
                            inbox.events.drain(..).collect(),
                            std::mem::take(&mut inbox.dropped),
                            inbox.failure.clone(),
                        ))
                    })();
                    let result = match batch {
                        Ok((events, dropped, failure)) => {
                            let ended = failure.is_some();
                            match receive(events, dropped, failure) {
                                Ok(()) if ended => return,
                                other => other,
                            }
                        }
                        Err(e) => Err(e),
                    };
                    if let Err(message) = result {
                        wire.fail(&message);
                        if let Ok(mut input) = wire.stdin.lock() {
                            input.take();
                        }
                        return;
                    }
                }
            });
        if spawned.is_err() {
            self.wire.consumer_started.store(false, Ordering::Release);
            return Err("无法启动 Codex 事件接收".into());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn drain_events(&self) -> Result<(Vec<Value>, u64), String> {
        let mut inbox = self.wire.inbox.lock().map_err(|_| "Codex 事件状态不可用")?;
        inbox.event_bytes = 0;
        Ok((
            inbox.events.drain(..).collect(),
            std::mem::take(&mut inbox.dropped),
        ))
    }

    pub(crate) fn failure(&self) -> Option<String> {
        self.wire.inbox.lock().ok().and_then(|i| i.failure.clone())
    }

    pub(crate) fn is_running(&self) -> Result<bool, String> {
        self.child
            .lock()
            .map_err(|_| "Codex 进程状态不可用")?
            .try_wait()
            .map(|s| s.is_none())
            .map_err(|_| "无法核对 Codex 进程状态".into())
    }

    pub(crate) fn begin_stop(&self) -> Result<(), String> {
        let running = self.is_running()?;
        let owned_input = self
            .wire
            .stdin
            .lock()
            .map_err(|_| "Codex 输入状态不可用")?
            .take();
        if running && owned_input.is_some() {
            self.wire
                .eof_shutdown_requested
                .store(true, Ordering::Release);
        }
        drop(owned_input);
        self.wire.fail("Codex 连接正在关闭；未确认操作需重新核对");
        Ok(())
    }

    pub(crate) fn stop(&self) -> Result<(), String> {
        self.begin_stop()?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let observed = self
                .child
                .lock()
                .map_err(|_| "Codex 进程状态不可用")?
                .try_wait();
            match observed {
                Ok(Some(status))
                    if status.success()
                        && self.wire.eof_shutdown_requested.load(Ordering::Acquire) =>
                {
                    return Ok(());
                }
                Ok(Some(_)) => return Err("Codex 异常退出；后台操作结果仍未知".into()),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                _ => {
                    let mut child = self.child.lock().map_err(|_| "Codex 进程状态不可用")?;
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Codex 未确认正常退出，已终止自有进程；后台操作结果仍未知".into());
                }
            }
        }
    }
}

impl Drop for CodexTransport {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_stdio_timeout_rejects_late_reply_and_eof_releases_the_owned_process() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("protocol-fixture.py");
        std::fs::write(
            &script,
            r#"
import json,sys,time
for line in sys.stdin:
    request=json.loads(line)
    if request['method']=='slow': time.sleep(0.12)
    print(json.dumps({'id':request['id'],'result':{'method':request['method']}}),flush=True)
"#,
        )
        .unwrap();
        let transport =
            CodexTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        let error = transport
            .request_timeout("slow", json!({}), Duration::from_millis(20))
            .unwrap_err();
        assert!(matches!(error, DispatchError::Unknown(_)));
        assert!(error.to_string().contains("尚未确认"));
        assert_eq!(
            transport.request("second", json!({})).unwrap()["method"],
            "second"
        );
        assert_eq!(transport.drain_events().unwrap().1, 1);
        assert!(transport.wire.inbox.lock().unwrap().pending.is_empty());
        transport.stop().unwrap();
        assert!(!transport.is_running().unwrap());
        assert!(transport.request("after-stop", json!({})).is_err());
    }

    #[test]
    fn native_rejection_timeout_and_preflight_failure_have_distinct_outcomes() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("received.txt");
        let script = temp.path().join("server.py");
        std::fs::write(&script, r#"
import json,sys,time,pathlib
for line in sys.stdin:
    r=json.loads(line)
    with open(sys.argv[1], 'a') as f:f.write(r['method']+'\n')
    if r['method']=='slow':time.sleep(.12)
    reply={'id':r['id']}
    if r['method']=='reject':reply['error']={'code':-32600,'message':'secret-fixture','data':{'key':'secret-fixture'}}
    elif r['method']=='malformed':reply['error']={'message':'secret-fixture'}
    else:reply['result']={}
    print(json.dumps(reply),flush=True)
"#).unwrap();
        let transport =
            CodexTransport::spawn(Command::new("/usr/bin/python3").arg(script).arg(&marker))
                .unwrap();
        assert!(matches!(
            transport.dispatch("oversize", json!({"text":"x".repeat(MAX_FRAME)})),
            Err(DispatchError::NotSent(_))
        ));
        assert!(!marker.exists());
        let error = transport.dispatch("reject", json!({})).unwrap_err();
        assert_eq!(error, DispatchError::Rejected { code: -32600 });
        assert!(!format!("{error:?} {error}").contains("secret-fixture"));
        assert!(matches!(
            transport.dispatch("malformed", json!({})),
            Err(DispatchError::Unknown(_))
        ));
        assert!(matches!(
            transport.request_timeout("slow", json!({}), Duration::from_millis(20)),
            Err(DispatchError::Unknown(_))
        ));
        transport.request("barrier", json!({})).unwrap();
        assert_eq!(
            std::fs::read_to_string(marker).unwrap(),
            "reject\nmalformed\nslow\nbarrier\n"
        );
        transport.stop().unwrap();
        assert!(matches!(
            transport.dispatch("after-stop", json!({})),
            Err(DispatchError::NotSent(_))
        ));
    }

    #[test]
    fn server_replies_are_single_use_and_native_resolution_or_stop_fences_late_clicks() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("requests.py");
        let marker = temp.path().join("responses");
        std::fs::write(&script, r#"
import json,sys
for line in sys.stdin:
 r=json.loads(line)
 if 'method' not in r:
  with open(sys.argv[1],'a') as f: f.write(json.dumps(r)+'\n')
  continue
 n=r['params']['n']
 request={'id':n,'method':'item/commandExecution/requestApproval','params':{'threadId':'thread','turnId':'turn','itemId':'item','availableDecisions':['accept','cancel']}}
 print(json.dumps(request),flush=True)
 print(json.dumps(request),flush=True)
 if r['method']=='resolved':print(json.dumps({'method':'serverRequest/resolved','params':{'threadId':'thread','requestId':n}}),flush=True)
 print(json.dumps({'id':r['id'],'result':{}}),flush=True)
"#).unwrap();
        let transport =
            CodexTransport::spawn(Command::new("/usr/bin/python3").arg(script).arg(&marker))
                .unwrap();
        transport.request("ask", json!({"n":1})).unwrap();
        let key = crate::codex_interactions::request_key(&json!(1)).unwrap();
        assert!(
            transport
                .respond(&key, "other", "turn", json!({"decision":"accept"}))
                .is_err()
        );
        transport
            .respond(&key, "thread", "turn", json!({"decision":"accept"}))
            .unwrap();
        assert!(
            transport
                .respond(&key, "thread", "turn", json!({"decision":"accept"}))
                .is_err()
        );
        transport.request("resolved", json!({"n":2})).unwrap();
        let key = crate::codex_interactions::request_key(&json!(2)).unwrap();
        assert!(
            transport
                .respond(&key, "thread", "turn", json!({"decision":"accept"}))
                .is_err()
        );
        transport.request("ask", json!({"n":3})).unwrap();
        transport.invalidate_interactions("thread", "turn").unwrap();
        let key = crate::codex_interactions::request_key(&json!(3)).unwrap();
        assert!(
            transport
                .respond(&key, "thread", "turn", json!({"decision":"accept"}))
                .is_err()
        );
        transport.stop().unwrap();
        let replies = std::fs::read_to_string(marker).unwrap();
        let values = replies
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(values, vec![json!({"id":1,"result":{"decision":"accept"}})]);
    }

    #[test]
    fn stalled_event_consumer_does_not_block_replies_and_reports_bounded_loss() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("server.py");
        std::fs::write(&script, r#"
import json,sys
print(json.dumps({'method':'ready','params':{}}),flush=True)
for line in sys.stdin:
    r=json.loads(line)
    for i in range(600): print(json.dumps({'method':'native/event','params':{'index':i}}),flush=True)
    print(json.dumps({'id':r['id'],'result':{'accepted':True}}),flush=True)
"#).unwrap();
        let transport =
            CodexTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap();
        let (entered, observed) = mpsc::channel();
        let (release, wait) = mpsc::sync_channel(1);
        let (batches, received) = mpsc::channel();
        let mut first = true;
        transport
            .consume_events(move |events, dropped, failure| {
                if first {
                    first = false;
                    entered.send(()).unwrap();
                    wait.recv_timeout(Duration::from_secs(5)).unwrap();
                }
                batches.send((events, dropped, failure)).unwrap();
                Ok(())
            })
            .unwrap();
        assert!(transport.consume_events(|_, _, _| Ok(())).is_err());
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        let response = transport.request_timeout("burst", json!({}), Duration::from_secs(2));
        release.send(()).unwrap();
        assert_eq!(response.unwrap()["accepted"], true);
        let first = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first.0[0]["method"], "ready");
        let second = received.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(second.0.len(), MAX_EVENTS);
        assert_eq!(second.1, 600 - MAX_EVENTS as u64);
        assert_eq!(second.0.last().unwrap()["params"]["index"], 599);
        transport.stop().unwrap();
        assert!(
            received
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .2
                .is_some()
        );
    }

    #[test]
    fn jsonl_reader_preserves_unicode_and_rejects_partial_or_oversize_frames() {
        let mut reader = BufReader::with_capacity(1, "{\"text\":\"你好\"}\n{}\n".as_bytes());
        let first = read_frame(&mut reader).unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&first).unwrap()["text"],
            "你好"
        );
        assert_eq!(read_frame(&mut reader).unwrap().unwrap(), b"{}\n");
        assert!(read_frame(&mut reader).unwrap().is_none());
        assert!(read_frame(&mut BufReader::new(&b"{\"partial\":"[..])).is_err());
        assert!(read_frame(&mut BufReader::new(&vec![b'x'; MAX_FRAME + 1][..])).is_err());
    }

    #[test]
    fn replies_correlate_out_of_order_and_do_not_expose_native_error_secrets() {
        let wire = Wire {
            stdin: Mutex::new(None),
            inbox: Mutex::new(Inbox::default()),
            next_id: AtomicU64::new(1),
            event_ready: Condvar::new(),
            consumer_started: AtomicBool::new(false),
            eof_shutdown_requested: AtomicBool::new(false),
            server_requests: Mutex::new(ServerRequests::default()),
        };
        let (one, r1) = mpsc::sync_channel(1);
        let (two, r2) = mpsc::sync_channel(1);
        wire.inbox
            .lock()
            .unwrap()
            .pending
            .extend([("one".into(), one), ("two".into(), two)]);
        wire.receive(json!({"id":"two","result":{"ok":2}}), 30)
            .unwrap();
        wire.receive(
            json!({"id":"one","error":{"code":-32001,"message":"secret-fixture"}}),
            60,
        )
        .unwrap();
        assert_eq!(r2.recv().unwrap().unwrap()["ok"], 2);
        let error = r1.recv().unwrap().unwrap_err();
        assert_eq!(error, DispatchError::Rejected { code: -32001 });
        assert!(!error.to_string().contains("secret-fixture"));
        wire.receive(json!({"id":"one","result":{}}), 30).unwrap();
        assert_eq!(wire.inbox.lock().unwrap().dropped, 1);
        for _ in 0..MAX_EVENTS + 3 {
            let event = json!({"method":"future/event","params":{"native":true}});
            let size = event.to_string().len();
            wire.receive(event, size).unwrap();
        }
        let inbox = wire.inbox.lock().unwrap();
        assert_eq!(inbox.events.len(), MAX_EVENTS);
        assert_eq!(inbox.dropped, 4);
        assert_eq!(inbox.events[0]["params"]["native"], true);
    }
}
