use super::*;
use std::mem::ManuallyDrop;

fn received(packet: ffi::Packet, trailer: ffi::AuditTrailer) -> ManuallyDrop<Received> {
    // Parser-only bytes: no kernel rights exist, so never call mach_msg_destroy.
    let mut buffer = Buffer([0; LIMIT]);
    unsafe {
        buffer.0.as_mut_ptr().cast::<ffi::Packet>().write(packet);
        buffer
            .0
            .as_mut_ptr()
            .add(size_of::<ffi::Packet>())
            .cast::<ffi::AuditTrailer>()
            .write_unaligned(trailer);
    }
    ManuallyDrop::new(Received { buffer })
}
fn trailer() -> ffi::AuditTrailer {
    ffi::AuditTrailer {
        size: size_of::<ffi::AuditTrailer>() as u32,
        ..Default::default()
    }
}

#[test]
fn request_requires_exact_shape_and_one_use_reply_without_incoming_fileports() {
    let mut good = packet(REQUEST);
    good.header.bits = ffi::COMPLEX | ffi::MOVE_SEND_ONCE;
    good.header.remote = 42;
    assert!(received(good, trailer()).request_token().is_some());
    let changes: [fn(&mut ffi::Packet); 7] = [
        |p| p.code = 9,
        |p| p.header.id += 1,
        |p| p.header.size -= 4,
        |p| p.header.bits = ffi::COMPLEX | ffi::MOVE_SEND,
        |p| p.header.voucher = 3,
        |p| p.descriptors = 1,
        |p| p.port.name = 9,
    ];
    for change in changes {
        let mut bad = good;
        change(&mut bad);
        assert!(received(bad, trailer()).request_token().is_none());
    }
    for size in [0, 8, 51, LIMIT as u32] {
        let mut bad = trailer();
        bad.size = size;
        assert!(received(good, bad).request_token().is_none());
    }
}

#[test]
fn grant_requires_exact_one_fileport_and_audit_trailer() {
    let mut good = packet(GRANT);
    good.header.bits = ffi::COMPLEX;
    good.descriptors = 1;
    good.port.name = 42;
    good.port.disposition = ffi::MOVE_SEND as u8;
    assert!(received(good, trailer()).grant().is_ok());
    let changes: [fn(&mut ffi::Packet); 7] = [
        |p| p.code = REJECT,
        |p| p.descriptors = 2,
        |p| p.port.kind = 1,
        |p| p.port.disposition = ffi::MOVE_SEND_ONCE as u8,
        |p| p.header.remote = 9,
        |p| p.header.bits |= ffi::MOVE_SEND,
        |p| p.port.pad1 = 1,
    ];
    for change in changes {
        let mut bad = good;
        change(&mut bad);
        assert!(received(bad, trailer()).grant().is_err());
    }
}
