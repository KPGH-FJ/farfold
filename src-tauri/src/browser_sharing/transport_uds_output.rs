//! Sole owner of the final HTTP bytes. A partial response is closed, never
//! replaced with a second JSON value or counted as a delivered tool result.
use super::{FixedPageReadScope, Packet, Value, WRITE_WAIT, protocol};
use std::{
    io::{self, Write},
    time::{Duration, Instant},
};

pub(super) struct Output {
    bytes: Vec<u8>,
    pub offset: usize,
    deadline: Instant,
    pub delivery: Option<u64>,
    scope: Option<FixedPageReadScope>,
    control: bool,
    id: Value,
    pub list: bool,
    pub initialized: bool,
}

pub(super) enum Progress {
    Pending,
    Complete,
    Withdrawn(FixedPageReadScope),
    Partial(FixedPageReadScope),
}
impl Output {
    pub(super) fn json(value: Value, list: bool, initialized: bool) -> Result<Self, ()> {
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let body = serde_json::to_vec(&value).map_err(|_| ())?;
        Ok(Self {
            bytes: super::http::response(200, &body)?,
            offset: 0,
            deadline: Instant::now() + WRITE_WAIT,
            delivery: None,
            scope: None,
            control: false,
            id,
            list,
            initialized,
        })
    }
    pub(super) fn empty(status: u16) -> Result<Self, ()> {
        Ok(Self {
            bytes: super::http::response(status, &[])?,
            offset: 0,
            deadline: Instant::now() + Duration::from_secs(1),
            delivery: None,
            scope: None,
            control: false,
            id: Value::Null,
            list: false,
            initialized: false,
        })
    }
    pub(super) fn packet(packet: Packet) -> Result<Self, ()> {
        let envelope: Value = serde_json::from_slice(&packet.bytes).map_err(|_| ())?;
        if envelope.get("kind").and_then(Value::as_str) != Some("response") {
            return Err(());
        }
        let mut output = Self::json(envelope.get("message").cloned().ok_or(())?, false, false)?;
        output.scope = packet.scope;
        output.control = packet.control;
        output.delivery = packet.delivery;
        output.deadline = packet.deadline;
        Ok(output)
    }
    pub(super) fn advance(&mut self, writer: &mut impl Write) -> Result<Progress, ()> {
        if Instant::now() >= self.deadline {
            return Err(());
        }
        if let Some(scope) = self.scope.as_ref().filter(|s| !s.is_valid()).cloned() {
            if self.offset != 0 {
                return Ok(Progress::Partial(scope));
            }
            let value = if self.control {
                protocol::control_unknown(self.id.clone())
            } else {
                protocol::tool_error(self.id.clone(), "读取许可已停止")
            };
            let body = serde_json::to_vec(&value).map_err(|_| ())?;
            self.bytes = super::http::response(200, &body)?;
            self.scope = None;
            return Ok(Progress::Withdrawn(scope));
        }
        match writer.write(&self.bytes[self.offset..]) {
            Ok(0) => Err(()),
            Ok(n) => {
                self.offset += n;
                Ok(if self.offset == self.bytes.len() {
                    Progress::Complete
                } else {
                    Progress::Pending
                })
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                Ok(Progress::Pending)
            }
            Err(_) => Err(()),
        }
    }
}
