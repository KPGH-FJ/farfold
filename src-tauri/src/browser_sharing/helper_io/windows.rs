use crate::browser_sharing::channel::{self, Stream};
use std::{io, ptr, time::Duration};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_INVALID_HANDLE, GetHandleInformation, HANDLE, INVALID_HANDLE_VALUE,
    },
    System::Console::{GetStdHandle, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle},
};
fn input() -> HANDLE {
    unsafe { GetStdHandle(STD_INPUT_HANDLE) }
}
fn output() -> HANDLE {
    unsafe { GetStdHandle(STD_OUTPUT_HANDLE) }
}
pub(crate) fn prepare() -> io::Result<()> {
    // SetNamedPipeHandleState explicitly supports CreatePipe handles. Refuse
    // console/file/unsupported inherited handles instead of allowing blocking I/O.
    channel::set_nowait(input())?;
    channel::set_nowait(output())?;
    Ok(())
}
pub(crate) fn close_stdout() -> io::Result<()> {
    let handle = output();
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Ok(());
    }
    if unsafe { CloseHandle(handle) } == 0 {
        let mut flags = 0;
        if unsafe { GetHandleInformation(handle, &mut flags) } != 0
            || io::Error::last_os_error().raw_os_error() != Some(ERROR_INVALID_HANDLE as i32)
        {
            return Err(io::Error::last_os_error());
        }
    }
    // Prevent a later standard-library flush from addressing a reused handle.
    unsafe {
        SetStdHandle(STD_OUTPUT_HANDLE, ptr::null_mut());
    }
    Ok(())
}
pub(crate) fn read_stdin(bytes: &mut [u8]) -> io::Result<usize> {
    channel::read_handle(input(), bytes)
}
pub(crate) fn write_stdout(bytes: &[u8]) -> io::Result<usize> {
    channel::write_handle(output(), bytes)
}
pub(crate) fn wait(
    _stream: &Stream,
    _controls: bool,
    _stdin: bool,
    _stdout: bool,
    millis: i32,
) -> io::Result<()> {
    std::thread::sleep(Duration::from_millis(millis.clamp(0, 5) as u64));
    Ok(())
}
