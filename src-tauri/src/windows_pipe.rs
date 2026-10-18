//! Local byte-pipe primitives; immediate polling only, never overlapped IO.
use std::{
    fs::File,
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Pipes::*, Threading::*},
};
#[cfg(test)]
#[path = "windows_pipe_tests.rs"]
mod tests;
fn block() -> io::Error {
    io::Error::from(io::ErrorKind::WouldBlock)
}
pub(crate) fn set_nowait(handle: HANDLE) -> io::Result<()> {
    if unsafe { GetFileType(handle) } != FILE_TYPE_PIPE {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
    if unsafe { SetNamedPipeHandleState(handle, &mode, ptr::null(), ptr::null()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut actual = 0;
    if unsafe {
        GetNamedPipeHandleStateW(
            handle,
            &mut actual,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
        )
    } == 0
        || actual & PIPE_NOWAIT == 0
    {
        return Err(io::Error::from(io::ErrorKind::Unsupported));
    }
    Ok(())
}
pub(crate) fn write_handle(handle: HANDLE, bytes: &[u8]) -> io::Result<usize> {
    let mut n = 0;
    if unsafe {
        WriteFile(
            handle,
            bytes.as_ptr(),
            bytes.len().min(u32::MAX as usize) as u32,
            &mut n,
            ptr::null_mut(),
        )
    } != 0
    {
        return if n == 0 && !bytes.is_empty() {
            Err(block())
        } else {
            Ok(n as usize)
        };
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error().map(|e| e as u32) {
        Some(ERROR_NO_DATA | ERROR_PIPE_BUSY) => Err(block()),
        _ => Err(error),
    }
}
// Use this logon session's SID, not Everyone/anonymous/default named-pipe ACL.
pub(crate) fn logon_sid() -> io::Result<String> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut length = 0;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenLogonSid,
            ptr::null_mut(),
            0,
            &mut length,
        );
    }
    if length == 0 || length > 65536 {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenLogonSid,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let groups = unsafe { &*buffer.as_ptr().cast::<TOKEN_GROUPS>() };
    if groups.GroupCount != 1 {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    let mut text = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(groups.Groups[0].Sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe {
        let mut n = 0;
        while n < 256 && *text.add(n) != 0 {
            n += 1;
        }
        String::from_utf16(std::slice::from_raw_parts(text, n))
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))
    };
    unsafe {
        LocalFree(text.cast());
    }
    result
}
/// Self-connect before spawn. Only the reader handle becomes child stdin;
/// the random name never enters argv, environment, configuration, or diagnostics.
pub(crate) fn stdin_pair() -> io::Result<(File, File)> {
    let mut random = [0u8; 24];
    getrandom::fill(&mut random).map_err(|_| io::Error::from(io::ErrorKind::Other))?;
    let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let name: Vec<u16> = format!(r"\\.\pipe\farfold-stdin-{suffix}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let sddl: Vec<u16> = format!("D:P(A;;GRGW;;;{})", logon_sid()?)
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let raw = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            65536,
            65536,
            1000,
            &attributes,
        )
    };
    let error = io::Error::last_os_error();
    unsafe {
        LocalFree(descriptor);
    }
    if raw == INVALID_HANDLE_VALUE {
        return Err(error);
    }
    let writer = unsafe { File::from_raw_handle(raw) };
    let raw = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ,
            0,
            ptr::null(),
            OPEN_EXISTING,
            SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let reader = unsafe { File::from_raw_handle(raw) };
    let connected = unsafe { ConnectNamedPipe(writer.as_raw_handle(), ptr::null_mut()) };
    if connected == 0
        && io::Error::last_os_error().raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32)
    {
        return Err(io::Error::last_os_error());
    }
    // Detect an unexpected peer on either end before selected code can run.
    let (mut client, mut server) = (0, 0);
    if unsafe { GetNamedPipeClientProcessId(writer.as_raw_handle(), &mut client) } == 0
        || unsafe { GetNamedPipeServerProcessId(reader.as_raw_handle(), &mut server) } == 0
        || client != unsafe { GetCurrentProcessId() }
        || server != unsafe { GetCurrentProcessId() }
    {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    set_nowait(writer.as_raw_handle())?;
    let mut mode = 0;
    if unsafe {
        GetNamedPipeHandleStateW(
            reader.as_raw_handle(),
            &mut mode,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
        )
    } == 0
        || mode & PIPE_NOWAIT != 0
    {
        return Err(io::Error::from(io::ErrorKind::Unsupported));
    }
    Ok((writer, reader))
}
