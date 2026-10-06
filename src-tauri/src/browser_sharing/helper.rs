//! Private single-threaded MCP relay. Invoke its entry branch before Tauri,
//! logging, plugins or threads. Bodies never enter stderr, logs or files.
use super::{
    channel::{self, Stream},
    helper_io, protocol,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    env,
    ffi::OsStr,
    io,
    path::Path,
    time::{Duration, Instant},
};

pub const MODE: &str = "--farfold-browser-mcp-helper";
pub const CAPABILITY_ENV: &str = "FARFOLD_BROWSER_CAPABILITY";
const TIMEOUT: Duration = Duration::from_secs(1);
const INPUT_LIMIT: usize = 65_536;
const BROKER_LIMIT: usize = 1_300_000;
const OUTPUT_LIMIT: usize = 600_000;
const CONTROL_LIMIT: usize = 256_000;
const CONTROL_FRAMES: usize = 256;

/// None selects normal startup. Some must immediately exit without app setup.
pub fn run_if_requested() -> Option<i32> {
    let mut args = env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(MODE)) {
        return None;
    }
    let capability = env::var_os(CAPABILITY_ENV);
    // SAFETY: this required entry point precedes all threads/environment readers.
    unsafe { env::remove_var(CAPABILITY_ENV) };
    let result = (|| {
        let path = args.next().ok_or(())?;
        if args.next().is_some() {
            return Err(());
        }
        let capability = capability.ok_or(())?;
        let capability = capability.to_str().ok_or(())?;
        let bytes = capability.as_bytes();
        if bytes.len() != 64 || !bytes.iter().all(u8::is_ascii_hexdigit) {
            return Err(());
        }
        let capability = std::str::from_utf8(bytes).map_err(|_| ())?;
        let stream = channel::connect(Path::new(&path)).map_err(|_| ())?;
        authenticate(&stream, capability)?;
        // Authentication completes before any stdin read/forwarding.
        helper_io::prepare().map_err(|_| ())?;
        stream.set_nonblocking(true).map_err(|_| ())?;
        Worker::new(stream).run()
    })();
    Some(result.unwrap_or(1))
}

struct ControlFrame {
    bytes: Vec<u8>,
    offset: usize,
    deadline: Instant,
    terminal: bool,
}
struct OutputFrame {
    bytes: Vec<u8>,
    offset: usize,
    deadline: Instant,
    delivery: u64,
    page: bool,
    id: Value,
    control: bool,
}
struct Worker {
    stream: Stream,
    broker_input: Vec<u8>,
    stdin_input: Vec<u8>,
    controls: VecDeque<ControlFrame>,
    output: Option<OutputFrame>,
    inflight: Option<Value>,
    stdin_eof: bool,
    stdin_paused: bool,
    stdout_closed: bool,
    exit_code: Option<i32>,
}
impl Worker {
    fn new(stream: Stream) -> Self {
        Self {
            stream,
            broker_input: Vec::new(),
            stdin_input: Vec::new(),
            controls: VecDeque::new(),
            output: None,
            inflight: None,
            stdin_eof: false,
            stdin_paused: false,
            stdout_closed: false,
            exit_code: None,
        }
    }
    fn close_stdout(&mut self) -> Result<(), ()> {
        self.output = None;
        if self.stdout_closed {
            return Ok(());
        }
        helper_io::close_stdout().map_err(|_| ())?;
        self.stdout_closed = true;
        Ok(())
    }
    fn queue(&mut self, value: Value, terminal: bool, priority: bool) -> Result<bool, ()> {
        let bytes = line(&value, INPUT_LIMIT + 1024)?;
        if self.controls.len() >= CONTROL_FRAMES {
            return Err(());
        }
        let queued: usize = self.controls.iter().map(|f| f.bytes.len() - f.offset).sum();
        if !priority && queued + bytes.len() > CONTROL_LIMIT {
            return Ok(false);
        }
        let frame = ControlFrame {
            bytes,
            offset: 0,
            deadline: Instant::now() + TIMEOUT,
            terminal,
        };
        if priority {
            // Preserve a partial JSON line and earlier terminal ACKs; put stop
            // ahead of unsent ordinary request/written packets.
            let at = self
                .controls
                .iter()
                .take_while(|f| f.offset > 0 || f.terminal)
                .count();
            self.controls.insert(at, frame);
        } else {
            self.controls.push_back(frame);
        }
        Ok(true)
    }
    fn terminate(&mut self, packet: Value, code: i32) -> Result<(), ()> {
        self.close_stdout()?;
        self.stdin_input.clear();
        self.inflight = None;
        self.exit_code = Some(code);
        self.controls.retain(|f| f.offset > 0 || f.terminal);
        self.queue(packet, true, true)?;
        Ok(())
    }
    fn fail(&mut self) -> Result<(), ()> {
        if self.exit_code.is_some() {
            self.close_stdout()?;
            return Err(());
        }
        self.terminate(json!({"kind":"failed"}), 1)
    }
    fn stop(&mut self, barrier: u64, close: bool) -> Result<(), ()> {
        // Already-observed input must never cross this barrier into a future
        // grant. Closing is the conservative boundary for buffered requests.
        if self.stop_requires_close(close) {
            return self.terminate(
                json!({"kind":"stopped","barrier":barrier,"stdoutClosed":true}),
                0,
            );
        }
        if let Some(frame) = self.output.as_mut().filter(|f| f.page) {
            let message = if frame.control {
                protocol::control_unknown(frame.id.clone())
            } else {
                protocol::tool_error(frame.id.clone(), "网页分享已停止")
            };
            frame.bytes = line(&message, OUTPUT_LIMIT)?;
            frame.offset = 0;
            frame.page = false;
            frame.deadline = Instant::now() + TIMEOUT;
        }
        // Preserve existing request/written FIFO: the broker must observe every
        // old request before this ACK. Pause input until that ACK fully drains.
        // Controls still drain before stdout, including the replacement error.
        self.stdin_paused = true;
        if !self.queue(
            json!({"kind":"stopped","barrier":barrier,"stdoutClosed":false}),
            true,
            false,
        )? {
            return Err(());
        }
        Ok(())
    }
    fn stop_requires_close(&self, close: bool) -> bool {
        close
            || self.output.as_ref().is_some_and(|f| f.page && f.offset > 0)
            || self.stdout_closed
            || !self.stdin_input.is_empty()
    }
    fn broker_message(&mut self, message: Value) -> Result<(), ()> {
        match message.get("kind").and_then(Value::as_str) {
            Some("stop") => self.stop(
                message.get("barrier").and_then(Value::as_u64).ok_or(())?,
                message.get("close").and_then(Value::as_bool).ok_or(())?,
            ),
            Some("response") if self.exit_code.is_none() => {
                if self.output.is_some() {
                    return Err(());
                }
                let delivery = message.get("delivery").and_then(Value::as_u64).ok_or(())?;
                let page = message.get("page").and_then(Value::as_bool).ok_or(())?;
                let control = message.get("control").and_then(Value::as_bool).ok_or(())?;
                let response = message.get("message").ok_or(())?;
                let id = self.inflight.as_ref().ok_or(())?;
                if response.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
                    || response.get("id") != Some(id)
                    || (response.get("result").is_some() == response.get("error").is_some())
                {
                    return Err(());
                }
                self.output = Some(OutputFrame {
                    bytes: line(response, OUTPUT_LIMIT)?,
                    offset: 0,
                    deadline: Instant::now() + TIMEOUT,
                    delivery,
                    page,
                    id: id.clone(),
                    control,
                });
                Ok(())
            }
            Some("response") if self.exit_code.is_some() => Ok(()),
            _ => Err(()),
        }
    }
    // false means control EOF. Drain complete packets before any stdout write.
    fn read_broker(&mut self) -> Result<bool, ()> {
        let mut total = 0;
        loop {
            while let Some(end) = self.broker_input.iter().position(|b| *b == b'\n') {
                if end + 1 > BROKER_LIMIT {
                    return Err(());
                }
                let bytes: Vec<u8> = self.broker_input.drain(..=end).collect();
                self.broker_message(serde_json::from_slice(&bytes).map_err(|_| ())?)?;
            }
            if self.broker_input.len() >= BROKER_LIMIT {
                return Err(());
            }
            let mut bytes = [0_u8; 8192];
            let capacity = bytes.len().min(BROKER_LIMIT - self.broker_input.len());
            let count = match channel::read_nowait(&self.stream, &mut bytes[..capacity]) {
                Ok(0) => return Ok(false),
                Ok(n) => n,
                Err(error) => match error.kind() {
                    io::ErrorKind::Interrupted => continue,
                    io::ErrorKind::WouldBlock => return Ok(true),
                    _ => return Err(()),
                },
            };
            self.broker_input.extend_from_slice(&bytes[..count]);
            total += count;
            if total > BROKER_LIMIT * 2 {
                return Err(());
            }
        }
    }
    fn forward_stdin(&mut self) -> Result<(), ()> {
        while let Some(end) = self.stdin_input.iter().position(|b| *b == b'\n') {
            if end + 1 > INPUT_LIMIT {
                return Err(());
            }
            let request: Value =
                serde_json::from_slice(&self.stdin_input[..=end]).map_err(|_| ())?;
            if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
                || request.get("method").and_then(Value::as_str).is_none()
            {
                return Err(());
            }
            let id = request.get("id").cloned();
            if id
                .as_ref()
                .is_some_and(|id| !(id.is_null() || id.is_string() || id.is_number()))
            {
                return Err(());
            }
            if id.is_some() && self.inflight.is_some() {
                // Keep ordinary requests in order, but let cancellation for the
                // active request cross queued requests. Otherwise the user's
                // stop could wait behind the very approval it must cancel.
                if self.forward_cancellation(end + 1)? {
                    continue;
                }
                if self.stdin_input.len() >= INPUT_LIMIT {
                    return Err(());
                }
                return Ok(());
            }
            if !self.queue(json!({"kind":"request","message":request}), false, false)? {
                return Ok(());
            }
            self.stdin_input.drain(..=end);
            if id.is_some() {
                self.inflight = id;
            }
        }
        if self.stdin_input.len() >= INPUT_LIMIT || (self.stdin_eof && !self.stdin_input.is_empty())
        {
            return Err(());
        }
        Ok(())
    }
    fn forward_cancellation(&mut self, mut start: usize) -> Result<bool, ()> {
        while let Some(relative) = self.stdin_input[start..].iter().position(|b| *b == b'\n') {
            let end = start + relative + 1;
            let request: Value =
                serde_json::from_slice(&self.stdin_input[start..end]).map_err(|_| ())?;
            if request.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
                && request.get("id").is_none()
                && request.get("method").and_then(Value::as_str) == Some("notifications/cancelled")
                && request.get("params").and_then(|p| p.get("requestId")) == self.inflight.as_ref()
            {
                if !self.queue(json!({"kind":"request","message":request}), false, false)? {
                    return Ok(false);
                }
                self.stdin_input.drain(start..end);
                return Ok(true);
            }
            start = end;
        }
        Ok(false)
    }
    fn read_stdin(&mut self) -> Result<(), ()> {
        self.forward_stdin()?;
        if self.stdin_eof || self.stdin_input.len() >= INPUT_LIMIT {
            return Ok(());
        }
        let mut bytes = [0_u8; 8192];
        let capacity = bytes.len().min(INPUT_LIMIT - self.stdin_input.len());
        match helper_io::read_stdin(&mut bytes[..capacity]) {
            Ok(0) => self.stdin_eof = true,
            Ok(n) => self.stdin_input.extend_from_slice(&bytes[..n]),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) => {}
            Err(_) => return Err(()),
        }
        self.forward_stdin()
    }
    fn write_controls(&mut self) -> Result<(), ()> {
        while let Some(frame) = self.controls.front_mut() {
            if Instant::now() >= frame.deadline {
                return Err(());
            }
            let bytes = &frame.bytes[frame.offset..];
            let count = match channel::write_nowait(&self.stream, bytes) {
                Ok(n) => n,
                Err(error) => match error.kind() {
                    io::ErrorKind::Interrupted => continue,
                    io::ErrorKind::WouldBlock => return Ok(()),
                    _ => return Err(()),
                },
            };
            if count > 0 {
                frame.offset += count;
                if frame.offset == frame.bytes.len() {
                    self.controls.pop_front();
                }
            } else if count == 0 {
                return Err(());
            }
        }
        self.stdin_paused = false;
        Ok(())
    }
    fn write_stdout(&mut self) -> Result<(), ()> {
        if self.stdout_closed || !self.controls.is_empty() {
            return Ok(());
        }
        let Some(frame) = self.output.as_mut() else {
            return Ok(());
        };
        if Instant::now() >= frame.deadline {
            return Err(());
        }
        let bytes = &frame.bytes[frame.offset..];
        let count = match helper_io::write_stdout(bytes) {
            Ok(n) => n,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) =>
            {
                return Ok(());
            }
            Err(_) => return Err(()),
        };
        if count > 0 {
            frame.offset += count;
            if frame.offset == frame.bytes.len() {
                let delivery = frame.delivery;
                self.output = None;
                self.inflight = None;
                if !self.queue(json!({"kind":"written","delivery":delivery}), false, false)? {
                    return Err(());
                }
            }
        } else {
            return Err(());
        }
        Ok(())
    }
    fn expired(&self) -> bool {
        let now = Instant::now();
        self.output.as_ref().is_some_and(|f| now >= f.deadline)
            || self.controls.front().is_some_and(|f| now >= f.deadline)
    }
    fn poll(&self) -> Result<(), ()> {
        let now = Instant::now();
        let mut millis = 50;
        for deadline in self
            .output
            .as_ref()
            .map(|f| f.deadline)
            .into_iter()
            .chain(self.controls.front().map(|f| f.deadline))
        {
            millis = millis.min(
                deadline
                    .saturating_duration_since(now)
                    .as_millis()
                    .saturating_add(1)
                    .min(50) as i32,
            );
        }
        helper_io::wait(
            &self.stream,
            !self.controls.is_empty(),
            !self.stdin_eof
                && !self.stdin_paused
                && self.exit_code.is_none()
                && self.stdin_input.len() < INPUT_LIMIT,
            !self.stdout_closed && self.output.is_some() && self.controls.is_empty(),
            millis,
        )
        .map_err(|_| ())
    }
    fn run(mut self) -> Result<i32, ()> {
        loop {
            match self.read_broker() {
                Ok(false) => {
                    self.close_stdout()?;
                    return Ok(0);
                }
                Ok(true) => {}
                Err(()) => {
                    self.broker_input.clear();
                    self.fail()?;
                }
            }
            if self.expired() {
                self.fail()?;
            }
            if self.exit_code.is_none() && !self.stdin_paused && self.read_stdin().is_err() {
                self.fail()?;
            }
            if self.write_controls().is_err() {
                self.fail()?;
            }
            // Drain control again immediately before the one nonblocking stdout syscall.
            match self.read_broker() {
                Ok(false) => {
                    self.close_stdout()?;
                    return Ok(0);
                }
                Ok(true) => {}
                Err(()) => {
                    self.broker_input.clear();
                    self.fail()?;
                }
            }
            if self.expired() {
                self.fail()?;
            }
            if self.write_stdout().is_err() {
                self.fail()?;
            }
            if self.controls.is_empty() {
                if let Some(code) = self.exit_code {
                    return Ok(code);
                }
                if self.stdin_eof
                    && self.stdin_input.is_empty()
                    && self.inflight.is_none()
                    && self.output.is_none()
                {
                    self.close_stdout()?;
                    return Ok(0);
                }
            }
            if self.poll().is_err() {
                self.fail()?;
            }
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.close_stdout();
    }
}

fn line(value: &Value, limit: usize) -> Result<Vec<u8>, ()> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| ())?;
    bytes.push(b'\n');
    if bytes.len() > limit {
        return Err(());
    }
    Ok(bytes)
}
fn authenticate(stream: &Stream, capability: &str) -> Result<(), ()> {
    let deadline = Instant::now() + TIMEOUT;
    send_bytes(
        stream,
        &line(&json!({"kind":"hello","capability":capability}), 256)?,
        deadline,
    )
    .map_err(|_| ())?;
    let mut bytes = Vec::new();
    loop {
        channel::wait_ready(channel::token(stream), channel::READ, deadline).map_err(|_| ())?;
        let mut input = [0u8];
        match channel::read_nowait(stream, &mut input) {
            Ok(0) => return Err(()),
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) =>
            {
                continue;
            }
            Err(_) => return Err(()),
        }
        let byte = input[0];
        bytes.push(byte);
        if bytes.len() > 256 {
            return Err(());
        }
        if byte == b'\n' {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
            return if value.get("kind").and_then(Value::as_str) == Some("hello_ack") {
                Ok(())
            } else {
                Err(())
            };
        }
    }
}
fn send_bytes(stream: &Stream, mut bytes: &[u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        channel::wait_ready(channel::token(stream), channel::WRITE, deadline)?;
        let sent = match channel::write_nowait(stream, bytes) {
            Ok(n) => n,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) =>
            {
                channel::wait_fd(channel::token(stream), channel::WRITE, 5);
                continue;
            }
            Err(error) => return Err(error),
        };
        if sent > 0 {
            bytes = &bytes[sent..];
            continue;
        }
        if sent == 0 {
            return Err(io::Error::from(io::ErrorKind::WriteZero));
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    struct MemoryWorker(Worker);
    impl Drop for MemoryWorker {
        fn drop(&mut self) {
            // This fixture only exercises queued memory frames. Never let its
            // Worker destructor close the test runner's process stdout.
            self.0.stdout_closed = true;
        }
    }

    #[test]
    fn review_regression_stop_with_queued_control_receipt_keeps_only_unknown_status() {
        let (stream, _peer) = Stream::pair().unwrap();
        let mut fixture = MemoryWorker(Worker::new(stream));
        let worker = &mut fixture.0;
        worker.inflight = Some(json!(42));
        worker
            .broker_message(json!({
                "kind":"response", "delivery":7, "page":true, "control":true,
                "message":{
                    "jsonrpc":"2.0", "id":42,
                    "result":{
                        "content":[{"type":"text","text":"page-owned content and entered value"}],
                        "structuredContent":{"applied":true,"outcome":"dispatched","reason":"page-owned reason"},
                        "isError":false
                    }
                }
            }))
            .unwrap();
        assert_eq!(worker.output.as_ref().unwrap().offset, 0);
        worker.stop(8, false).unwrap();
        let output = worker.output.as_ref().expect("fixed status remains queued");
        let message: Value = serde_json::from_slice(&output.bytes).unwrap();
        assert_eq!(message["id"], 42);
        assert_eq!(message["result"]["isError"], true);
        assert_eq!(message["result"]["structuredContent"]["outcome"], "unknown");
        assert!(message["result"]["structuredContent"]["applied"].is_null());
        let text = message["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("结果未确认"));
        assert!(text.contains("不要自动重试"));
        assert!(!String::from_utf8_lossy(&output.bytes).contains("page-owned"));
        assert!(!String::from_utf8_lossy(&output.bytes).contains("entered value"));
        assert!(!output.page);
        assert_eq!(output.delivery, 7);
        assert!(!worker.stdout_closed);
        assert!(worker.stdin_paused);
        let ack: Value = serde_json::from_slice(&worker.controls[0].bytes).unwrap();
        assert_eq!(ack["barrier"], 8);
        assert_eq!(ack["stdoutClosed"], false);
    }

    #[test]
    fn queued_read_stop_does_not_trust_page_owned_control_fields() {
        let (stream, _peer) = Stream::pair().unwrap();
        let mut fixture = MemoryWorker(Worker::new(stream));
        let worker = &mut fixture.0;
        worker.inflight = Some(json!(42));
        worker.broker_message(json!({
            "kind":"response", "delivery":7, "page":true, "control":false,
            "message":{
                "jsonrpc":"2.0", "id":42,
                "result":{"structuredContent":{"control":true,"outcome":"dispatched"},"isError":false}
            }
        })).unwrap();
        worker.stop(8, false).unwrap();
        let output = worker.output.as_ref().unwrap();
        let message: Value = serde_json::from_slice(&output.bytes).unwrap();
        assert_eq!(message["result"]["content"][0]["text"], "网页分享已停止");
        assert!(message["result"].get("structuredContent").is_none());
        assert!(!output.page);
        assert!(!worker.stdout_closed);
    }

    #[test]
    fn partial_page_output_keeps_the_transport_close_boundary_for_read_and_control() {
        for control in [false, true] {
            let (stream, _peer) = Stream::pair().unwrap();
            let mut fixture = MemoryWorker(Worker::new(stream));
            let worker = &mut fixture.0;
            worker.inflight = Some(json!(42));
            worker
                .broker_message(json!({
                    "kind":"response", "delivery":7, "page":true, "control":control,
                    "message":{"jsonrpc":"2.0", "id":42,"result":{"isError":false}}
                }))
                .unwrap();
            assert!(!worker.stop_requires_close(false));
            worker.output.as_mut().unwrap().offset = 1;
            assert!(worker.stop_requires_close(false));
            // Exercise the production close decision without closing the test
            // runner's actual stdout. No replacement can resume a partial JSON.
            worker.output.as_mut().unwrap().offset = 0;
            assert!(worker.stop_requires_close(true));
            worker.stdin_input.extend_from_slice(b"queued old request");
            assert!(worker.stop_requires_close(false));
        }
    }

    #[test]
    fn queued_request_does_not_block_active_request_cancellation() {
        let (stream, _peer) = Stream::pair().unwrap();
        let mut worker = Worker::new(stream);
        // This in-memory test owns no process stdout; keep Drop from closing it.
        worker.stdout_closed = true;
        worker.inflight = Some(json!(10));
        let queued = json!({"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"read_page_snapshot"}});
        let cancel = json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":10,"reason":"not echoed"}});
        worker
            .stdin_input
            .extend(line(&queued, INPUT_LIMIT).unwrap());
        worker
            .stdin_input
            .extend(line(&cancel, INPUT_LIMIT).unwrap());
        worker.forward_stdin().unwrap();
        assert_eq!(worker.inflight, Some(json!(10)));
        assert_eq!(worker.controls.len(), 1);
        let forwarded: Value = serde_json::from_slice(&worker.controls[0].bytes).unwrap();
        assert_eq!(forwarded["message"]["method"], "notifications/cancelled");
        assert_eq!(forwarded["message"]["params"]["requestId"], 10);
        let remaining: Value = serde_json::from_slice(&worker.stdin_input).unwrap();
        assert_eq!(remaining, queued);
    }

    #[test]
    fn cancellation_for_another_request_cannot_jump_the_active_request() {
        let (stream, _peer) = Stream::pair().unwrap();
        let mut worker = Worker::new(stream);
        worker.stdout_closed = true;
        worker.inflight = Some(json!(10));
        for message in [
            json!({"jsonrpc":"2.0","id":11,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":11}}),
        ] {
            worker
                .stdin_input
                .extend(line(&message, INPUT_LIMIT).unwrap());
        }
        worker.forward_stdin().unwrap();
        assert!(worker.controls.is_empty());
        assert_eq!(
            worker.stdin_input.iter().filter(|b| **b == b'\n').count(),
            2
        );
    }
}
