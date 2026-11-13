//! One private HTTP endpoint for one already-owned Agent process. Request
//! identity is checked on admission and before every final write. The existing
//! fixed-page protocol, user permission, and native operation gates are reused.
use super::*;
use std::net::Shutdown;

#[path = "transport_uds_http.rs"]
mod http;
#[path = "transport_uds_output.rs"]
mod output;
#[cfg(test)]
#[path = "transport_uds_tests.rs"]
mod tests;

use output::{Output, Progress};
pub(super) type PeerCheck = Arc<dyn Fn(&Stream) -> bool + Send + Sync>;
const MAX_CLIENTS: usize = 32;
const INPUT_WAIT: Duration = Duration::from_secs(5);

struct Client {
    key: u64,
    stream: Stream,
    input: Vec<u8>,
    deadline: Instant,
    accepted: bool,
    output: Option<Output>,
    dead: bool,
}
impl Client {
    fn new(key: u64, stream: Stream) -> std::io::Result<Self> {
        stream.set_nonblocking(true)?;
        Ok(Self {
            key,
            stream,
            input: Vec::new(),
            deadline: Instant::now() + INPUT_WAIT,
            accepted: false,
            output: None,
            dead: false,
        })
    }
    fn close(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
        self.dead = true;
        self.output = None;
    }
    fn request(&mut self, verify: &dyn Fn(&Stream) -> bool) -> Result<Option<http::Request>, ()> {
        if self.accepted || self.dead {
            return Ok(None);
        }
        if Instant::now() >= self.deadline {
            return Err(());
        }
        let mut bytes = [0u8; 8192];
        match self.stream.read(&mut bytes) {
            Ok(0) => return Err(()),
            Ok(n) => self.input.extend_from_slice(&bytes[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return Err(()),
        }
        let request = http::parse(&self.input)?;
        if request.is_some() {
            if !verify(&self.stream) {
                return Err(());
            }
            self.accepted = true;
            self.input.clear();
        }
        Ok(request)
    }
    fn write(&mut self, verify: &dyn Fn(&Stream) -> bool) -> Result<Progress, ()> {
        if self.dead || !verify(&self.stream) {
            return Err(());
        }
        self.output.as_mut().ok_or(())?.advance(&mut self.stream)
    }
}

/// Drops all request-owned presentation/output state after the actual response
/// socket is closed. This does not revoke the user's independent page grant.
fn discard_call(wire: &mut Wire) {
    wire.waiting = None;
    wire.pending = None;
    if let Some(delivery) = wire.delivery.take()
        && let Some(scope) = delivery.scope
    {
        scope.cancel_action();
    }
    wire.packets.clear();
    wire.deferred = None;
    wire.finish_stopped_screenshot();
}
fn drain_listener(listener: &Listener) -> bool {
    for _ in 0..1024 {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.shutdown(Shutdown::Both);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return true,
            Err(_) => return false,
        }
    }
    false
}
fn stop_calls(clients: &mut [Client], active: &mut Option<u64>, wire: &mut Wire) -> bool {
    let mut clean = true;
    for client in clients {
        if client.output.as_ref().is_some_and(|out| out.offset != 0) {
            clean = false;
        }
        client.close();
    }
    *active = None;
    discard_call(wire);
    clean
}
fn stop_replies(wire: &mut Wire, clean: bool) {
    if let Some(barrier) = wire.barrier.take() {
        for reply in barrier.replies {
            let _ = reply.send(if clean {
                Ok(())
            } else {
                Err("停止共享尚未确认，请重试".into())
            });
        }
    }
}

impl Worker {
    /// Same production completion projection as the stdio worker. The HTTP
    /// response still passes its own final output gate and full-write witness.
    fn finish_pending_read(&self, wire: &mut Wire) -> bool {
        if wire.delivery.is_some() {
            return true;
        }
        let Some(read) = wire.pending.as_ref() else {
            return true;
        };
        let result = match read.result.try_recv() {
            Ok(value) => value,
            Err(mpsc::TryRecvError::Empty) => return true,
            Err(mpsc::TryRecvError::Disconnected) => Err(ToolFailure::Unconfirmed),
        };
        let id = read.id.clone();
        let scope = read.scope.clone();
        let control = read.request.control();
        wire.pending = None;
        let (value, scope) = match result {
            Ok(page) => (protocol::snapshot(id, page), Some(scope)),
            Err(error) => {
                if !scope.grant_is_valid() {
                    (self.on_invalidated)(scope);
                }
                (operation_error_reply(id, control, error), None)
            }
        };
        match scope {
            Some(scope) if control => wire.control_reply(value, scope),
            scope => wire.reply(value, scope, false),
        }
        .is_ok()
    }

    pub(super) fn serve_uds(&mut self, listener: Listener, verify: PeerCheck) -> bool {
        let mut protocol = protocol::Protocol::new(self.execution.screenshots);
        let mut wire = Wire::default();
        let mut clients: Vec<Client> = Vec::new();
        let mut active = None;
        let mut serial = 0u64;
        loop {
            if self.shutdown.load(Ordering::Acquire) {
                let clean = stop_calls(&mut clients, &mut active, &mut wire);
                let drained = drain_listener(&listener);
                stop_replies(&mut wire, clean && drained);
                return clean && drained;
            }
            // Only this thread owns writers. Closing them synchronously is the
            // local output barrier; no remote HTTP response can acknowledge it.
            while let Ok(Control::Quiesce(reply)) = self.controls.try_recv() {
                let clean = stop_calls(&mut clients, &mut active, &mut wire);
                let drained = drain_listener(&listener);
                stop_replies(&mut wire, clean && drained);
                if let Some(reply) = reply {
                    let _ = reply.send(if clean && drained {
                        Ok(())
                    } else {
                        Err("停止共享尚未确认，请重试".into())
                    });
                }
            }
            if wire.barrier.is_some() {
                let clean = cancel_active(&mut clients, &mut active, &mut wire);
                stop_replies(&mut wire, clean);
            }
            clients.retain(|c| !c.dead);
            let mut progressed = false;
            for _ in 0..MAX_CLIENTS {
                match listener.accept() {
                    Ok((stream, _)) => {
                        progressed = true;
                        if clients.len() >= MAX_CLIENTS || !verify(&stream) {
                            let _ = stream.shutdown(Shutdown::Both);
                            continue;
                        }
                        let Some(next) = serial.checked_add(1) else {
                            return false;
                        };
                        serial = next;
                        if let Ok(client) = Client::new(serial, stream) {
                            clients.push(client);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => return false,
                }
            }
            // Read all control requests before progressing native work or output.
            for client in &mut clients {
                let request = match client.request(verify.as_ref()) {
                    Ok(Some(request)) => request,
                    Ok(None) => continue,
                    Err(()) => {
                        client.close();
                        continue;
                    }
                };
                progressed = true;
                let handled = dispatch_request(
                    request,
                    client,
                    &mut protocol,
                    &mut wire,
                    &mut active,
                    |action, wire| self.act(action, wire),
                );
                if handled.is_err() {
                    client.close();
                }
            }
            if active.is_some_and(|key| !clients.iter().any(|c| c.key == key && !c.dead)) {
                active = None;
                discard_call(&mut wire);
            }
            if wire.barrier.is_some() {
                let clean = cancel_active(&mut clients, &mut active, &mut wire);
                stop_replies(&mut wire, clean);
            }
            if let Some(key) = active {
                let Some(client) = clients.iter_mut().find(|c| c.key == key && !c.dead) else {
                    return false;
                };
                if !verify(&client.stream) {
                    client.close();
                    active = None;
                    discard_call(&mut wire);
                    continue;
                }
                if !self.finish_pending_read(&mut wire) || !self.permission_result(&mut wire) {
                    client.close();
                    active = None;
                    discard_call(&mut wire);
                    continue;
                }
                if client.output.is_none()
                    && let Some(packet) = wire.packets.pop_front()
                {
                    match Output::packet(packet) {
                        Ok(output) => {
                            client.output = Some(output);
                            progressed = true;
                        }
                        Err(()) => {
                            client.close();
                            active = None;
                            discard_call(&mut wire);
                        }
                    }
                }
            }
            for client in &mut clients {
                if client.dead || client.output.is_none() {
                    continue;
                }
                let previous = client.output.as_ref().expect("checked output").offset;
                let progress = client.write(verify.as_ref());
                let out = client.output.as_ref().expect("checked output");
                match progress {
                    Ok(Progress::Complete) => {
                        if out.list && protocol.mark_list_delivered() {
                            (self.on_ready)();
                        }
                        if out.initialized
                            && let Some(callback) = &self.on_initialized
                        {
                            callback();
                        }
                        if let Some(delivery) = out.delivery {
                            wire.acknowledge_written(delivery);
                        }
                        if active == Some(client.key) {
                            active = None;
                        }
                        client.close();
                        progressed = true;
                    }
                    Ok(Progress::Withdrawn(scope)) => {
                        if let Some(delivery) = wire.delivery.as_mut() {
                            delivery.scope = None;
                        }
                        if !scope.grant_is_valid() {
                            (self.on_invalidated)(scope);
                        }
                        progressed = true;
                    }
                    Ok(Progress::Partial(scope)) => {
                        if !scope.grant_is_valid() {
                            (self.on_invalidated)(scope);
                        }
                        client.close();
                        progressed = true;
                    }
                    Ok(Progress::Pending) => {
                        progressed |= out.offset != previous;
                    }
                    Err(()) => {
                        client.close();
                        progressed = true;
                    }
                }
            }
            if active.is_some_and(|key| !clients.iter().any(|c| c.key == key && !c.dead)) {
                active = None;
                discard_call(&mut wire);
            }
            if !progressed {
                wait_fd(channel::listener_token(&listener), channel::READ, 20);
            }
        }
    }
}

fn dispatch_request(
    request: http::Request,
    client: &mut Client,
    protocol: &mut protocol::Protocol,
    wire: &mut Wire,
    active: &mut Option<u64>,
    admit: impl FnOnce(protocol::Action, &mut Wire) -> bool,
) -> Result<(), ()> {
    let value = match request {
        http::Request::MethodNotAllowed => {
            client.output = Some(Output::empty(405)?);
            return Ok(());
        }
        http::Request::Post(value) => value,
    };
    // rmcp's modern discovery can fall back to the existing standard
    // initialize protocol. It does not create a second MCP session.
    if value.get("method").and_then(Value::as_str) == Some("server/discover") {
        client.output = Some(Output::json(
            protocol::error(
                value.get("id").cloned().unwrap_or(Value::Null),
                -32601,
                "Method not found",
            ),
            false,
            false,
        )?);
        return Ok(());
    }
    let initialization = value.get("method").and_then(Value::as_str) == Some("initialize");
    match protocol.receive(value) {
        protocol::Action::None => {
            client.output = Some(Output::empty(202)?);
        }
        protocol::Action::Reply { value, list } => {
            let initialized = initialization
                && value
                    .get("result")
                    .and_then(|r| r.get("protocolVersion"))
                    .is_some();
            client.output = Some(Output::json(value, list, initialized)?);
        }
        protocol::Action::Cancel { id } => {
            wire.cancel(&id)?;
            client.output = Some(Output::empty(202)?);
        }
        action @ protocol::Action::Read { .. } => {
            if active.is_some() {
                let protocol::Action::Read { id, .. } = action else {
                    unreachable!();
                };
                client.output = Some(Output::json(
                    protocol::tool_error(id, "请先处理原网页读取请求"),
                    false,
                    false,
                )?);
            } else {
                *active = Some(client.key);
                if !admit(action, wire) {
                    return Err(());
                }
            }
        }
    }
    Ok(())
}

fn cancel_active(clients: &mut [Client], active: &mut Option<u64>, wire: &mut Wire) -> bool {
    let mut clean = true;
    if let Some(key) = active.take()
        && let Some(client) = clients.iter_mut().find(|c| c.key == key)
    {
        clean = client.output.as_ref().is_none_or(|out| out.offset == 0);
        client.close();
    }
    discard_call(wire);
    clean
}
