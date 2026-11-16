//! Original authenticated-helper byte pump, shared by stdio transports.
use super::*;
pub(super) trait ChannelPolicy {
    fn observe(&self, wire: &Wire);
    fn admit(&self) -> bool;
    fn available(&self) -> bool;
    fn catalog_available(&self) -> bool;
    fn catalog_delivered(&self);
}

impl Worker {
    pub(super) fn serve(&mut self, channel: Stream) -> bool {
        self.serve_channel(channel, None)
    }

    pub(super) fn serve_channel(
        &mut self,
        mut channel: Stream,
        lease: Option<&dyn ChannelPolicy>,
    ) -> bool {
        let mut protocol = protocol::Protocol::new(self.execution.screenshots);
        let mut input = Vec::new();
        let mut wire = Wire::default();
        loop {
            if let Some(lease) = lease {
                lease.observe(&wire);
            }
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
                    Ok(0) => return lease.is_some() && wire.clean_eof() && input.is_empty(),
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
                            if let Some(lease) = lease {
                                lease.catalog_delivered();
                            }
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
                                if lease.is_none() {
                                    self.notify_closed(true);
                                }
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
                        if request.get("method").and_then(Value::as_str) == Some("tools/call")
                            && lease.is_some_and(|owner| owner.catalog_available())
                        {
                            protocol.inherit_delivered_catalog();
                        }
                        let action = protocol.receive(request);
                        let action = match action {
                            protocol::Action::Read { id, request }
                                if lease.is_some_and(|lease| !lease.admit()) =>
                            {
                                protocol::Action::Reply {
                                    value: permission_error_reply(
                                        id,
                                        request.control(),
                                        "网页读取尚未准备完成",
                                    ),
                                    list: false,
                                }
                            }
                            action => action,
                        };
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
                && lease.is_none_or(|lease| lease.available())
                && !self.permission_result(&mut wire)
            {
                return false;
            }
            if let Some(packet) = wire.packets.front_mut() {
                if lease.is_some_and(|owner| !owner.available())
                    && let Some(scope) = &packet.scope
                {
                    scope.cancel_action();
                    // Never finish a partial page frame after its owner retired.
                    // An incomplete output stays unknown rather than becoming an ACK.
                    if packet.written != 0 {
                        return false;
                    }
                }
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

impl Wire {
    // EOF cannot stand in for an output ACK. The sole additional clean case is
    // a locally queued stop that began with no request/result at all; racing
    // that empty stop against an idle discovery helper's EOF creates no output.
    pub(super) fn clean_eof(&self) -> bool {
        self.idle()
            || (self
                .barrier
                .as_ref()
                .is_some_and(|barrier| barrier.idle_at_start)
                && self.delivery.is_none()
                && self.pending.is_none()
                && self.waiting.is_none()
                && self.deferred.is_none()
                && self.screenshot_receipt.is_none()
                && self
                    .packets
                    .iter()
                    .all(|packet| packet.delivery.is_none() && packet.scope.is_none()))
    }
    pub(super) fn idle(&self) -> bool {
        self.packets.is_empty()
            && self.delivery.is_none()
            && self.pending.is_none()
            && self.waiting.is_none()
            && self.barrier.is_none()
            && self.deferred.is_none()
            && self.screenshot_receipt.is_none()
    }
}
