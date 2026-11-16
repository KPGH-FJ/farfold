use super::{HANDSHAKE_WAIT, ffi};
use std::ffi::CString;
use std::mem::size_of;
use std::time::Duration;

const MESSAGE_ID: i32 = 17_001;
const REQUEST: u32 = 1;
const GRANT: u32 = 2;
const REJECT: u32 = 3;
const LIMIT: usize = 4096;

pub(super) struct ReceivePort(ffi::Port);
impl ReceivePort {
    pub(super) fn new() -> Result<Self, ()> {
        let mut port = 0;
        if unsafe { ffi::mach_port_allocate(ffi::task(), 1, &mut port) } != 0 || port == 0 {
            return Err(());
        }
        Ok(Self(port))
    }
    pub(super) fn raw(&self) -> ffi::Port {
        self.0
    }
    pub(super) fn receive(&self, timeout: Duration) -> Result<Option<Received>, ()> {
        let mut buffer = Buffer([0; LIMIT]);
        // Omitting MACH_RCV_LARGE intentionally discards an oversized message;
        // it must not remain at the head and deny every later valid helper.
        let status = unsafe {
            ffi::mach_msg(
                buffer.0.as_mut_ptr().cast(),
                ffi::RECEIVE,
                0,
                LIMIT as u32,
                self.0,
                milliseconds(timeout),
                0,
            )
        };
        if status == ffi::TIMED_OUT || status == ffi::TOO_LARGE {
            return Ok(None);
        }
        if status & !ffi::ERROR_MASK == ffi::BODY_ERROR {
            // A received body error can still own rights/resources that were
            // copied out. The kernel supplies a destructible partial message.
            unsafe { ffi::mach_msg_destroy(buffer.0.as_mut_ptr().cast()) };
            return Err(());
        }
        if status != 0 {
            return Err(());
        }
        Ok(Some(Received { buffer }))
    }
}
impl Drop for ReceivePort {
    fn drop(&mut self) {
        unsafe { ffi::mach_port_destroy(ffi::task(), self.0) };
    }
}

pub(super) struct SendRight(ffi::Port);
impl SendRight {
    pub(super) fn lookup(name: &str) -> Result<Self, ()> {
        let name = CString::new(name).map_err(|_| ())?;
        let mut port = 0;
        if unsafe { ffi::bootstrap_look_up(ffi::bootstrap_port, name.as_ptr(), &mut port) } != 0
            || port == 0
        {
            return Err(());
        }
        Ok(Self(port))
    }
    pub(super) fn from_fd(fd: i32) -> Result<Self, ()> {
        let mut port = 0;
        if unsafe { ffi::fileport_makeport(fd, &mut port) } != 0 || port == 0 {
            return Err(());
        }
        Ok(Self(port))
    }
    fn take(mut self) -> ffi::Port {
        std::mem::take(&mut self.0)
    }
}
impl Drop for SendRight {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { ffi::mach_port_deallocate(ffi::task(), self.0) };
        }
    }
}

#[repr(C, align(8))]
struct Buffer([u8; LIMIT]);

pub(super) struct Received {
    buffer: Buffer,
}
impl Received {
    fn shape(&self) -> Option<(ffi::Packet, ffi::AuditToken)> {
        // Buffer is at least Packet sized and aligned, including for messages
        // whose actual size is smaller. The read is checked before use.
        let packet = unsafe { self.buffer.0.as_ptr().cast::<ffi::Packet>().read() };
        if packet.header.size as usize != size_of::<ffi::Packet>()
            || packet.header.id != MESSAGE_ID
            || packet.header.bits & ffi::COMPLEX == 0
            || packet.header.voucher != 0
        {
            return None;
        }
        let at = (packet.header.size as usize + 3) & !3;
        let trailer = unsafe {
            self.buffer
                .0
                .as_ptr()
                .add(at)
                .cast::<ffi::AuditTrailer>()
                .read_unaligned()
        };
        if trailer.kind != 0
            || trailer.size < size_of::<ffi::AuditTrailer>() as u32
            || trailer.size as usize > LIMIT - at
        {
            return None;
        }
        Some((packet, trailer.audit))
    }

    pub(super) fn request_token(&self) -> Option<ffi::AuditToken> {
        let (packet, token) = self.shape()?;
        (packet.code == REQUEST
            && packet.descriptors == 0
            && packet.header.remote != 0
            && packet.header.bits & 0x1f == ffi::MOVE_SEND_ONCE
            && packet.port.name == 0
            && packet.port.pad1 == 0
            && packet.port.pad2 == 0
            && packet.port.disposition == 0
            && packet.port.kind == 0)
            .then_some(token)
    }

    pub(super) fn grant(&self) -> Result<(ffi::AuditToken, ffi::Port), ()> {
        let (packet, token) = self.shape().ok_or(())?;
        if packet.code != GRANT
            || packet.descriptors != 1
            || packet.header.remote != 0
            || packet.header.bits & 0x1f != 0
            || packet.port.name == 0
            || packet.port.kind != 0 // MACH_MSG_PORT_DESCRIPTOR
            || packet.port.disposition != ffi::MOVE_SEND as u8
            || packet.port.pad1 != 0
            || packet.port.pad2 != 0
        {
            return Err(());
        }
        Ok((token, packet.port.name))
    }

    pub(super) fn reply(&mut self, fdport: Option<SendRight>) -> Result<(), ()> {
        // Only a validated request may transfer its one-use reply right.
        self.request_token().ok_or(())?;
        let header = unsafe { &mut *self.buffer.0.as_mut_ptr().cast::<ffi::Header>() };
        let remote = std::mem::take(&mut header.remote);
        let mut packet = packet(if fdport.is_some() { GRANT } else { REJECT });
        packet.header.bits = ffi::COMPLEX | ffi::MOVE_SEND_ONCE;
        packet.header.remote = remote;
        if let Some(port) = fdport {
            packet.descriptors = 1;
            packet.port.name = port.take();
            packet.port.disposition = ffi::MOVE_SEND as u8;
        }
        let status = send(&mut packet);
        if status != 0 {
            // A failed send returns these moved rights to the message. Destroy
            // exactly that message; no RAII wrapper also owns those rights.
            unsafe { ffi::mach_msg_destroy(&mut packet.header) };
            return Err(());
        }
        Ok(())
    }
}
impl Drop for Received {
    fn drop(&mut self) {
        // Kernel-received descriptors may own resources even when our protocol
        // rejects the shape. Destroy them, never convert foreign fileports.
        unsafe { ffi::mach_msg_destroy(self.buffer.0.as_mut_ptr().cast()) };
    }
}

fn packet(code: u32) -> ffi::Packet {
    ffi::Packet {
        header: ffi::Header {
            size: size_of::<ffi::Packet>() as u32,
            id: MESSAGE_ID,
            ..Default::default()
        },
        code,
        ..Default::default()
    }
}
fn send(packet: &mut ffi::Packet) -> i32 {
    unsafe {
        ffi::mach_msg(
            &mut packet.header,
            ffi::SEND,
            size_of::<ffi::Packet>() as u32,
            0,
            0,
            milliseconds(HANDSHAKE_WAIT),
            0,
        )
    }
}
pub(super) fn request(service: &SendRight, reply: &ReceivePort) -> Result<(), ()> {
    let mut packet = packet(REQUEST);
    packet.header.bits = ffi::COMPLEX | ffi::COPY_SEND | (ffi::MAKE_SEND_ONCE << 8);
    packet.header.remote = service.0;
    packet.header.local = reply.0;
    // COPY_SEND and MAKE_SEND_ONCE borrow existing local rights; there are no
    // moved descriptors for the caller to destroy on failure.
    if send(&mut packet) == 0 {
        Ok(())
    } else {
        Err(())
    }
}
fn milliseconds(duration: Duration) -> u32 {
    u32::try_from(duration.as_millis()).unwrap_or(u32::MAX)
}

#[cfg(test)]
#[path = "message_tests.rs"]
mod tests;
