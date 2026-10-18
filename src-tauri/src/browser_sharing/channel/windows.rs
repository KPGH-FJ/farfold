use super::Endpoint;
use crate::windows_pipe::logon_sid;
pub(crate) use crate::windows_pipe::{set_nowait, write_handle};
use std::{
    cell::{Cell, RefCell},
    fs::File,
    io::{self, Read, Write},
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Path, PathBuf},
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::Pipes::*,
};
pub(crate) struct Guard;
pub(crate) type Handle = HANDLE;
pub(crate) const READ: i16 = 1;
pub(crate) const WRITE: i16 = 2;
const PREFIX: &str = r"\\.\pipe\farfold-page-";
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn block() -> io::Error {
    io::Error::from(io::ErrorKind::WouldBlock)
}
pub(crate) fn token(stream: &Stream) -> Handle {
    stream.file.as_raw_handle()
}
pub(crate) fn listener_token(_listener: &Listener) -> Handle {
    ptr::null_mut()
}
pub(crate) struct Stream {
    file: File,
    nonblocking: Cell<bool>,
    read_wait: Cell<Option<Duration>>,
    write_wait: Cell<Option<Duration>>,
}
impl Stream {
    fn from_file(file: File) -> Self {
        Self {
            file,
            nonblocking: Cell::new(true),
            read_wait: Cell::new(None),
            write_wait: Cell::new(None),
        }
    }
    pub fn set_nonblocking(&self, value: bool) -> io::Result<()> {
        set_nowait(token(self))?;
        self.nonblocking.set(value);
        Ok(())
    }
    pub fn set_read_timeout(&self, value: Option<Duration>) -> io::Result<()> {
        self.read_wait.set(value);
        self.nonblocking.set(false);
        Ok(())
    }
    pub fn set_write_timeout(&self, value: Option<Duration>) -> io::Result<()> {
        self.write_wait.set(value);
        self.nonblocking.set(false);
        Ok(())
    }
    fn perform(
        &self,
        writing: bool,
        mut call: impl FnMut() -> io::Result<usize>,
    ) -> io::Result<usize> {
        let timeout = if writing {
            self.write_wait.get()
        } else {
            self.read_wait.get()
        };
        let deadline = Instant::now() + timeout.unwrap_or(Duration::from_secs(1));
        loop {
            match call() {
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock && !self.nonblocking.get() =>
                {
                    if Instant::now() >= deadline {
                        return Err(io::Error::from(io::ErrorKind::TimedOut));
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                result => return result,
            }
        }
    }
}
impl Read for Stream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.perform(false, || read_nowait(self, bytes))
    }
}
impl Write for Stream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.perform(true, || write_nowait(self, bytes))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(crate) fn read_handle(handle: HANDLE, bytes: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    let ok = unsafe {
        ReadFile(
            handle,
            bytes.as_mut_ptr(),
            bytes.len().min(u32::MAX as usize) as u32,
            &mut n,
            ptr::null_mut(),
        )
    };
    if ok != 0 {
        return Ok(n as usize);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error().map(|e| e as u32) {
        Some(ERROR_BROKEN_PIPE) => Ok(0),
        Some(ERROR_NO_DATA | ERROR_PIPE_LISTENING) => Err(block()),
        _ => Err(error),
    }
}
pub(crate) fn read_nowait(stream: &Stream, bytes: &mut [u8]) -> io::Result<usize> {
    read_handle(token(stream), bytes)
}
pub(crate) fn write_nowait(stream: &Stream, bytes: &[u8]) -> io::Result<usize> {
    write_handle(token(stream), bytes)
}
pub(crate) fn poll_ready(handle: Handle, interests: i16) -> bool {
    if interests & WRITE != 0 {
        return true;
    }
    let mut available = 0;
    unsafe {
        PeekNamedPipe(
            handle,
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            &mut available,
            ptr::null_mut(),
        ) == 0
            || available > 0
    }
}
pub(crate) fn wait_fd(_handle: Handle, _interests: i16, timeout: i32) {
    std::thread::sleep(Duration::from_millis(timeout.clamp(0, 5) as u64));
}
pub(crate) fn wait_ready(handle: Handle, interests: i16, deadline: Instant) -> io::Result<()> {
    loop {
        if Instant::now() >= deadline {
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        }
        if poll_ready(handle, interests) {
            return Ok(());
        }
        wait_fd(handle, interests, 5);
    }
}
pub(crate) struct Listener {
    path: PathBuf,
    sid: String,
    pending: RefCell<Option<Stream>>,
}
impl Listener {
    fn instance(&self) -> io::Result<Stream> {
        let sddl = wide(&format!("D:P(A;;GRGW;;;{})", self.sid));
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
        let path: Vec<_> = self.path.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            CreateNamedPipeW(
                path.as_ptr(),
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
        if handle == INVALID_HANDLE_VALUE {
            return Err(error);
        }
        Ok(Stream::from_file(unsafe { File::from_raw_handle(handle) }))
    }
    pub fn accept(&self) -> io::Result<(Stream, ())> {
        let mut pending = self.pending.borrow_mut();
        if pending.is_none() {
            *pending = Some(self.instance()?);
        }
        let stream = pending.as_ref().expect("created pipe");
        let ok = unsafe { ConnectNamedPipe(token(stream), ptr::null_mut()) };
        let error = io::Error::last_os_error();
        if ok != 0 || error.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) {
            return Ok((pending.take().expect("connected pipe"), ()));
        }
        if error.raw_os_error() == Some(ERROR_NO_DATA as i32) {
            pending.take(); // A client connected then disappeared before authentication.
            return Err(block());
        }
        if error.raw_os_error() == Some(ERROR_PIPE_LISTENING as i32) {
            return Err(block());
        }
        Err(error)
    }
}
pub(crate) fn create() -> io::Result<Endpoint> {
    let mut random = [0u8; 24];
    getrandom::fill(&mut random).map_err(|_| io::Error::from(io::ErrorKind::Other))?;
    let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let path = PathBuf::from(format!("{PREFIX}{name}"));
    let listener = Listener {
        path: path.clone(),
        sid: logon_sid()?,
        pending: RefCell::new(None),
    };
    *listener.pending.borrow_mut() = Some(listener.instance()?);
    Ok(Endpoint {
        guard: Guard,
        listener,
        path,
        name,
    })
}
pub(crate) fn connect(path: &Path) -> io::Result<Stream> {
    let text = path
        .to_str()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    if text
        .strip_prefix(PREFIX)
        .is_none_or(|tail| tail.len() != 48 || !tail.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let encoded = wide(text);
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let handle = unsafe {
            CreateFileW(
                encoded.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                ptr::null(),
                OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                ptr::null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            let file = unsafe { File::from_raw_handle(handle) };
            set_nowait(file.as_raw_handle())?;
            return Ok(Stream::from_file(file));
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_PIPE_BUSY as i32) || Instant::now() >= deadline {
            return Err(error);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::OwnedHandle;
    #[test]
    fn one_authenticated_channel_can_carry_bidirectional_stop_without_a_second_instance() {
        let endpoint = create().unwrap();
        assert!(endpoint.listener.instance().is_err());
        let client = connect(&endpoint.path).unwrap();
        let (server, _) = endpoint.listener.accept().unwrap();
        let stop = b"{\"kind\":\"stop\",\"barrier\":7}\n";
        assert_eq!(write_nowait(&server, stop).unwrap(), stop.len());
        let mut input = [0u8; 128];
        wait_ready(
            token(&client),
            READ,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        let length = read_nowait(&client, &mut input).unwrap();
        assert_eq!(&input[..length], stop);
        let ack = b"{\"kind\":\"stopped\",\"barrier\":7,\"stdoutClosed\":true}\n";
        assert_eq!(write_nowait(&client, ack).unwrap(), ack.len());
        wait_ready(
            token(&server),
            READ,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        let length = read_nowait(&server, &mut input).unwrap();
        assert_eq!(&input[..length], ack);
        assert!(connect(Path::new(r"\\another-host\pipe\farfold-page-123")).is_err());
    }
    #[test]
    fn inherited_anonymous_pipe_mode_is_verified_and_full_output_is_nonblocking() {
        let mut reader = ptr::null_mut();
        let mut writer = ptr::null_mut();
        assert_ne!(
            unsafe { CreatePipe(&mut reader, &mut writer, ptr::null(), 4096) },
            0
        );
        let reader = unsafe { OwnedHandle::from_raw_handle(reader) };
        let writer = unsafe { OwnedHandle::from_raw_handle(writer) };
        set_nowait(reader.as_raw_handle()).unwrap();
        set_nowait(writer.as_raw_handle()).unwrap();
        let bytes = [42u8; 4096];
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut blocked = false;
        for _ in 0..256 {
            match write_handle(writer.as_raw_handle(), &bytes) {
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    blocked = true;
                    break;
                }
                Err(error) => panic!("{error}"),
            }
            assert!(Instant::now() < deadline);
        }
        assert!(
            blocked,
            "bounded pipe must reach backpressure without a blocking write"
        );
        drop(writer);
        let mut drained = [0u8; 8192];
        loop {
            match read_handle(reader.as_raw_handle(), &mut drained) {
                Ok(0) => break,
                Ok(_) => {}
                Err(error) => panic!("{error}"),
            }
        }
    }
}
