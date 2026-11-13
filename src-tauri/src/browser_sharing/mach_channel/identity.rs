use super::{PeerIdentity, ffi};
use std::ffi::c_void;
use std::ptr;

struct Object(*const c_void);
impl Drop for Object {
    fn drop(&mut self) {
        unsafe { ffi::CFRelease(self.0) };
    }
}
impl Object {
    fn new(pointer: *const c_void) -> Result<Self, ()> {
        if pointer.is_null() {
            Err(())
        } else {
            Ok(Self(pointer))
        }
    }
    fn copied(call: impl FnOnce(*mut *const c_void) -> i32) -> Result<Self, ()> {
        let mut pointer = ptr::null();
        let status = call(&mut pointer);
        let object = Self::new(pointer)?;
        if status != 0 {
            return Err(());
        }
        Ok(object)
    }
}

type Csops = unsafe extern "C" fn(i32, u32, *mut c_void, usize, *mut ffi::AuditToken) -> i32;
fn csops() -> Result<Csops, ()> {
    let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"csops_audittoken".as_ptr()) };
    if pointer.is_null() {
        return Err(());
    }
    // ABI follows the reviewed Apple XNU/Security sources and the local
    // audited-message probe. It is resolved dynamically, not assumed present
    // in the public SDK. Missing support never falls back to PID-only checks.
    Ok(unsafe { std::mem::transmute::<*mut c_void, Csops>(pointer) })
}

fn self_requirement() -> Result<Object, ()> {
    let code = Object::copied(|out| unsafe { ffi::SecCodeCopySelf(0, out) })?;
    if unsafe { ffi::SecCodeCheckValidity(code.0, 0, ptr::null()) } != 0 {
        return Err(());
    }
    Object::copied(|out| unsafe { ffi::SecCodeCopyDesignatedRequirement(code.0, 0, out) })
}

pub(super) fn ready() -> Result<(), ()> {
    csops()?;
    self_requirement()?;
    Ok(())
}

pub(super) fn authenticate(mut token: ffi::AuditToken) -> Result<PeerIdentity, ()> {
    let pid = unsafe { ffi::audit_token_to_pid(token) };
    let uid = unsafe { ffi::audit_token_to_euid(token) };
    let pid_version = unsafe { ffi::audit_token_to_pidversion(token) };
    if pid <= 0 || uid != unsafe { libc::geteuid() } {
        return Err(());
    }
    let check = csops()?;
    let current_token = |token: &mut ffi::AuditToken| {
        let mut flags = 0_u32;
        unsafe {
            check(
                pid,
                0, // CS_OPS_STATUS; the supplied audit token includes exec pidversion.
                (&mut flags as *mut u32).cast(),
                std::mem::size_of::<u32>(),
                token,
            ) == 0
        }
    };
    if !current_token(&mut token) {
        return Err(());
    }
    let requirement = self_requirement()?;
    let data = Object::new(unsafe {
        ffi::CFDataCreate(
            ptr::null(),
            (&token as *const ffi::AuditToken).cast(),
            std::mem::size_of::<ffi::AuditToken>() as isize,
        )
    })?;
    let keys = [unsafe { ffi::kSecGuestAttributeAudit }];
    let values = [data.0];
    let attributes = Object::new(unsafe {
        ffi::CFDictionaryCreate(
            ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            (&raw const ffi::kCFTypeDictionaryKeyCallBacks).cast(),
            (&raw const ffi::kCFTypeDictionaryValueCallBacks).cast(),
        )
    })?;
    let peer = Object::copied(|out| unsafe {
        ffi::SecCodeCopyGuestWithAttributes(ptr::null(), attributes.0, 0, out)
    })?;
    if unsafe { ffi::SecCodeCheckValidity(peer.0, 0, requirement.0) } != 0
        || !current_token(&mut token)
    {
        return Err(());
    }
    Ok(PeerIdentity {
        pid: pid as u32,
        uid,
        pid_version,
    })
}
