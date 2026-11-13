//! ABI declarations from the installed macOS SDK mach/message.h, bootstrap.h,
//! sys/fileport.h and Security/CoreFoundation headers. No third-party protocol.
use std::ffi::{c_char, c_void};
pub(super) type Port = u32;
pub(super) const COMPLEX: u32 = 0x8000_0000;
pub(super) const MOVE_SEND: u32 = 17;
pub(super) const MOVE_SEND_ONCE: u32 = 18;
pub(super) const COPY_SEND: u32 = 19;
pub(super) const MAKE_SEND: u32 = 20;
pub(super) const MAKE_SEND_ONCE: u32 = 21;
pub(super) const SEND: u32 = 0x1 | 0x10;
pub(super) const RECEIVE: u32 = 0x2 | 0x100 | (3 << 24);
pub(super) const TIMED_OUT: i32 = 0x1000_4003;
pub(super) const TOO_LARGE: i32 = 0x1000_4004;
pub(super) const BODY_ERROR: i32 = 0x1000_400c;
pub(super) const ERROR_MASK: i32 = 0x3e00;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(super) struct Header {
    pub bits: u32,
    pub size: u32,
    pub remote: Port,
    pub local: Port,
    pub voucher: Port,
    pub id: i32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(super) struct PortDescriptor {
    pub name: Port,
    pub pad1: u32,
    pub pad2: u16,
    pub disposition: u8,
    pub kind: u8,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(super) struct Packet {
    pub header: Header,
    pub descriptors: u32,
    pub port: PortDescriptor,
    pub code: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(super) struct AuditToken {
    pub values: [u32; 8],
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(super) struct AuditTrailer {
    pub kind: u32,
    pub size: u32,
    pub sequence: u32,
    pub sender: [u32; 2],
    pub audit: AuditToken,
}

unsafe extern "C" {
    static mach_task_self_: Port;
    pub(super) static bootstrap_port: Port;
    pub(super) fn mach_port_allocate(task: Port, right: u32, name: *mut Port) -> i32;
    pub(super) fn mach_port_insert_right(task: Port, name: Port, poly: Port, kind: u32) -> i32;
    pub(super) fn mach_port_destroy(task: Port, name: Port) -> i32;
    pub(super) fn mach_port_deallocate(task: Port, name: Port) -> i32;
    pub(super) fn bootstrap_register(bootstrap: Port, name: *const c_char, port: Port) -> i32;
    pub(super) fn bootstrap_look_up(bootstrap: Port, name: *const c_char, port: *mut Port) -> i32;
    pub(super) fn mach_msg(
        message: *mut Header,
        options: u32,
        send_size: u32,
        receive_limit: u32,
        receive_name: Port,
        timeout: u32,
        notify: Port,
    ) -> i32;
    pub(super) fn mach_msg_destroy(message: *mut Header);
    pub(super) fn fileport_makeport(fd: i32, port: *mut Port) -> i32;
    pub(super) fn fileport_makefd(port: Port) -> i32;
}
pub(super) fn task() -> Port {
    unsafe { mach_task_self_ }
}

#[link(name = "bsm")]
unsafe extern "C" {
    pub(super) fn audit_token_to_pid(token: AuditToken) -> i32;
    pub(super) fn audit_token_to_euid(token: AuditToken) -> u32;
    pub(super) fn audit_token_to_pidversion(token: AuditToken) -> i32;
}

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    pub(super) static kSecGuestAttributeAudit: *const c_void;
    pub(super) fn SecCodeCopySelf(flags: u32, code: *mut *const c_void) -> i32;
    pub(super) fn SecCodeCheckValidity(code: *const c_void, flags: u32, req: *const c_void) -> i32;
    pub(super) fn SecCodeCopyDesignatedRequirement(
        code: *const c_void,
        flags: u32,
        req: *mut *const c_void,
    ) -> i32;
    pub(super) fn SecCodeCopyGuestWithAttributes(
        host: *const c_void,
        attributes: *const c_void,
        flags: u32,
        code: *mut *const c_void,
    ) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    // Only their addresses cross the FFI; Rust does not interpret callbacks.
    pub(super) static kCFTypeDictionaryKeyCallBacks: u8;
    pub(super) static kCFTypeDictionaryValueCallBacks: u8;
    pub(super) fn CFRelease(value: *const c_void);
    pub(super) fn CFDataCreate(
        allocator: *const c_void,
        bytes: *const u8,
        length: isize,
    ) -> *const c_void;
    pub(super) fn CFDictionaryCreate(
        allocator: *const c_void,
        keys: *const *const c_void,
        values: *const *const c_void,
        count: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> *const c_void;
}
