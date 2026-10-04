//! Private single-threaded MCP relay. Invoke its entry branch before Tauri,
//! logging, plugins or threads. Bodies never enter stderr, logs or files.
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    env,
    ffi::OsStr,
    io,
    mem::{self, size_of},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{
            ffi::OsStrExt,
            fs::{FileTypeExt, MetadataExt},
            net::UnixStream,
        },
    },
    path::Path,
    ptr,
    time::{Duration, Instant},
};

pub const MODE: &str = "--farfold-browser-mcp-helper";
pub const CAPABILITY_ENV: &str = "FARFOLD_BROWSER_CAPABILITY";
const TIMEOUT: Duration = Duration::from_secs(1);
const INPUT_LIMIT: usize = 65_536;
const BROKER_LIMIT: usize = 1_300_000;
const OUTPUT_LIMIT: usize = 600_000;
const CONTROL_LIMIT: usize = 256_000;
const CONTROL_FRAMES: usize = 256;
// Public macOS sys/fcntl.h; cached libc does not export this constant.
const F_SETNOSIGPIPE: libc::c_int = 73;

/// None selects normal startup. Some must immediately exit without app setup.
pub fn run_if_requested() -> Option<i32> {
    let mut args = env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(MODE)) {
        return None;
    }
    let capability = env::var_os(CAPABILITY_ENV);
    // SAFETY: this required entry point precedes all threads/environment readers.
    unsafe { env::remove_var(CAPABILITY_ENV) };
    let result = (|| {
        let path = args.next().ok_or(())?;
        if args.next().is_some() {
            return Err(());
        }
        let capability = capability.ok_or(())?;
        let bytes = capability.as_bytes();
        if bytes.len() != 64 || !bytes.iter().all(u8::is_ascii_hexdigit) {
            return Err(());
        }
        let capability = std::str::from_utf8(bytes).map_err(|_| ())?;
        let stream = connect_bounded(Path::new(&path)).map_err(|_| ())?;
        authenticate(&stream, capability)?;
        // Authentication completes before any stdin read/forwarding.
        set_nonblocking(0).map_err(|_| ())?;
        set_nonblocking(1).map_err(|_| ())?;
        if unsafe { libc::fcntl(1, F_SETNOSIGPIPE, 1) } < 0 {
            return Err(());
        }
        stream.set_nonblocking(true).map_err(|_| ())?;
        Worker::new(stream).run()
    })();
    Some(result.unwrap_or(1))
}

struct ControlFrame {
    bytes: Vec<u8>,
    offset: usize,
    deadline: Instant,
    terminal: bool,
}
struct OutputFrame {
    bytes: Vec<u8>,
    offset: usize,
    deadline: Instant,
    delivery: u64,
    page: bool,
    id: Value,
}
struct Worker {
    stream: UnixStream,
    broker_input: Vec<u8>,
    stdin_input: Vec<u8>,
    controls: VecDeque<ControlFrame>,
    output: Option<OutputFrame>,
    inflight: Option<Value>,
    stdin_eof: bool,
    stdin_paused: bool,
    stdout_closed: bool,
    exit_code: Option<i32>,
}
impl Worker {
    fn new(stream: UnixStream) -> Self {
        Self {
            stream,
            broker_input: Vec::new(),
            stdin_input: Vec::new(),
            controls: VecDeque::new(),
            output: None,
            inflight: None,
            stdin_eof: false,
            stdin_paused: false,
            stdout_closed: false,
            exit_code: None,
        }
    }
    fn close_stdout(&mut self) -> Result<(), ()> {
        self.output = None;
        if self.stdout_closed {
            return Ok(());
        }
        if unsafe { libc::close(1) } != 0 && !fd_closed(1) {
            return Err(());
        }
        self.stdout_closed = true;
        Ok(())
    }
    fn queue(&mut self, value: Value, terminal: bool, priority: bool) -> Result<bool, ()> {
        let bytes = line(&value, INPUT_LIMIT + 1024)?;
        if self.controls.len() >= CONTROL_FRAMES {
            return Err(());
        }
        let queued: usize = self.controls.iter().map(|f| f.bytes.len() - f.offset).sum();
        if !priority && queued + bytes.len() > CONTROL_LIMIT {
            return Ok(false);
        }
        let frame = ControlFrame {
            bytes,
            offset: 0,
            deadline: Instant::now() + TIMEOUT,
            terminal,
        };
        if priority {
            // Preserve a partial JSON line and earlier terminal ACKs; put stop
            // ahead of unsent ordinary request/written packets.
            let at = self
                .controls
                .iter()
                .take_while(|f| f.offset > 0 || f.terminal)
                .count();
            self.controls.insert(at, frame);
        } else {
            self.controls.push_back(frame);
        }
        Ok(true)
    }
    fn terminate(&mut self, packet: Value, code: i32) -> Result<(), ()> {
        self.close_stdout()?;
        self.stdin_input.clear();
        self.inflight = None;
        self.exit_code = Some(code);
        self.controls.retain(|f| f.offset > 0 || f.terminal);
        self.queue(packet, true, true)?;
        Ok(())
    }
    fn fail(&mut self) -> Result<(), ()> {
        if self.exit_code.is_some() {
            self.close_stdout()?;
            return Err(());
        }
        self.terminate(json!({"kind":"failed"}), 1)
    }
    fn stop(&mut self, barrier: u64, close: bool) -> Result<(), ()> {
        let partial = self.output.as_ref().is_some_and(|f| f.page && f.offset > 0);
        // Already-observed input must never cross this barrier into a future
        // grant. Closing is the conservative boundary for buffered requests.
        if close || partial || self.stdout_closed || !self.stdin_input.is_empty() {
            return self.terminate(
                json!({"kind":"stopped","barrier":barrier,"stdoutClosed":true}),
                0,
            );
        }
        if let Some(frame) = self.output.as_mut().filter(|f| f.page) {
            frame.bytes = line(
                &json!({"jsonrpc":"2.0","id":frame.id,"result":{
                "content":[{"type":"text","text":"网页分享已停止"}],"isError":true}}),
                OUTPUT_LIMIT,
            )?;
            frame.offset = 0;
            frame.page = false;
            frame.deadline = Instant::now() + TIMEOUT;
        }
        // Preserve existing request/written FIFO: the broker must observe every
        // old request before this ACK. Pause input until that ACK fully drains.
        // Controls still drain before stdout, including the replacement error.
        self.stdin_paused = true;
        if !self.queue(
            json!({"kind":"stopped","barrier":barrier,"stdoutClosed":false}),
            true,
            false,
        )? {
            return Err(());
        }
        Ok(())
    }
    fn broker_message(&mut self, message: Value) -> Result<(), ()> {
        match message.get("kind").and_then(Value::as_str) {
            Some("stop") => self.stop(
                message.get("barrier").and_then(Value::as_u64).ok_or(())?,
                message.get("close").and_then(Value::as_bool).ok_or(())?,
            ),
            Some("response") if self.exit_code.is_none() => {
                if self.output.is_some() {
                    return Err(());
                }
                let delivery = message.get("delivery").and_then(Value::as_u64).ok_or(())?;
                let page = message.get("page").and_then(Value::as_bool).ok_or(())?;
                let response = message.get("message").ok_or(())?;
                let id = self.inflight.as_ref().ok_or(())?;
                if response.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
                    || response.get("id") != Some(id)
                    || (response.get("result").is_some() == response.get("error").is_some())
                {
                    return Err(());
                }
                self.output = Some(OutputFrame {
                    bytes: line(response, OUTPUT_LIMIT)?,
                    offset: 0,
                    deadline: Instant::now() + TIMEOUT,
                    delivery,
                    page,
                    id: id.clone(),
                });
                Ok(())
            }
            Some("response") if self.exit_code.is_some() => Ok(()),
            _ => Err(()),
        }
    }
    // false means control EOF. Drain complete packets before any stdout write.
    fn read_broker(&mut self) -> Result<bool, ()> {
        let mut total = 0;
        loop {
            while let Some(end) = self.broker_input.iter().position(|b| *b == b'\n') {
                if end + 1 > BROKER_LIMIT {
                    return Err(());
                }
                let bytes: Vec<u8> = self.broker_input.drain(..=end).collect();
                self.broker_message(serde_json::from_slice(&bytes).map_err(|_| ())?)?;
            }
            if self.broker_input.len() >= BROKER_LIMIT {
                return Err(());
            }
            let mut bytes = [0_u8; 8192];
            let capacity = bytes.len().min(BROKER_LIMIT - self.broker_input.len());
            let count = unsafe {
                libc::recv(
                    self.stream.as_raw_fd(),
                    bytes.as_mut_ptr().cast(),
                    capacity,
                    libc::MSG_DONTWAIT,
                )
            };
            if count == 0 {
                return Ok(false);
            }
            if count < 0 {
                match io::Error::last_os_error().kind() {
                    io::ErrorKind::Interrupted => continue,
                    io::ErrorKind::WouldBlock => return Ok(true),
                    _ => return Err(()),
                }
            }
            self.broker_input
                .extend_from_slice(&bytes[..count as usize]);
            total += count as usize;
            if total > BROKER_LIMIT * 2 {
                return Err(());
            }
        }
    }
    fn forward_stdin(&mut self) -> Result<(), ()> {
        while let Some(end) = self.stdin_input.iter().position(|b| *b == b'\n') {
            if end + 1 > INPUT_LIMIT {
                return Err(());
            }
            let request: Value =
                serde_json::from_slice(&self.stdin_input[..=end]).map_err(|_| ())?;
            if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
                || request.get("method").and_then(Value::as_str).is_none()
            {
                return Err(());
            }
            let id = request.get("id").cloned();
            if id
                .as_ref()
                .is_some_and(|id| !(id.is_null() || id.is_string() || id.is_number()))
            {
                return Err(());
            }
            if id.is_some() && self.inflight.is_some() {
                return Ok(());
            }
            if !self.queue(json!({"kind":"request","message":request}), false, false)? {
                return Ok(());
            }
            self.stdin_input.drain(..=end);
            if id.is_some() {
                self.inflight = id;
            }
        }
        if self.stdin_input.len() >= INPUT_LIMIT || (self.stdin_eof && !self.stdin_input.is_empty())
        {
            return Err(());
        }
        Ok(())
    }
    fn read_stdin(&mut self) -> Result<(), ()> {
        self.forward_stdin()?;
        if self.stdin_eof || self.stdin_input.len() >= INPUT_LIMIT {
            return Ok(());
        }
        let mut bytes = [0_u8; 8192];
        let capacity = bytes.len().min(INPUT_LIMIT - self.stdin_input.len());
        let count = unsafe { libc::read(0, bytes.as_mut_ptr().cast(), capacity) };
        if count == 0 {
            self.stdin_eof = true;
        } else if count > 0 {
            self.stdin_input.extend_from_slice(&bytes[..count as usize]);
        } else if !matches!(
            io::Error::last_os_error().kind(),
            io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
        ) {
            return Err(());
        }
        self.forward_stdin()
    }
    fn write_controls(&mut self) -> Result<(), ()> {
        while let Some(frame) = self.controls.front_mut() {
            if Instant::now() >= frame.deadline {
                return Err(());
            }
            let bytes = &frame.bytes[frame.offset..];
            let count = unsafe {
                libc::send(
                    self.stream.as_raw_fd(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    libc::MSG_DONTWAIT,
                )
            };
            if count > 0 {
                frame.offset += count as usize;
                if frame.offset == frame.bytes.len() {
                    self.controls.pop_front();
                }
            } else if count == 0 {
                return Err(());
            } else {
                match io::Error::last_os_error().kind() {
                    io::ErrorKind::Interrupted => continue,
                    io::ErrorKind::WouldBlock => return Ok(()),
                    _ => return Err(()),
                }
            }
        }
        self.stdin_paused = false;
        Ok(())
    }
    fn write_stdout(&mut self) -> Result<(), ()> {
        if self.stdout_closed || !self.controls.is_empty() {
            return Ok(());
        }
        let Some(frame) = self.output.as_mut() else {
            return Ok(());
        };
        if Instant::now() >= frame.deadline {
            return Err(());
        }
        let bytes = &frame.bytes[frame.offset..];
        let count = unsafe { libc::write(1, bytes.as_ptr().cast(), bytes.len()) };
        if count > 0 {
            frame.offset += count as usize;
            if frame.offset == frame.bytes.len() {
                let delivery = frame.delivery;
                self.output = None;
                self.inflight = None;
                if !self.queue(json!({"kind":"written","delivery":delivery}), false, false)? {
                    return Err(());
                }
            }
        } else if count == 0 {
            return Err(());
        } else if !matches!(
            io::Error::last_os_error().kind(),
            io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
        ) {
            return Err(());
        }
        Ok(())
    }
    fn expired(&self) -> bool {
        let now = Instant::now();
        self.output.as_ref().is_some_and(|f| now >= f.deadline)
            || self.controls.front().is_some_and(|f| now >= f.deadline)
    }
    fn poll(&self) -> Result<(), ()> {
        let mut fds = [
            libc::pollfd {
                fd: self.stream.as_raw_fd(),
                events: libc::POLLIN
                    | if self.controls.is_empty() {
                        0
                    } else {
                        libc::POLLOUT
                    },
                revents: 0,
            },
            libc::pollfd {
                fd: if !self.stdin_eof
                    && !self.stdin_paused
                    && self.exit_code.is_none()
                    && self.stdin_input.len() < INPUT_LIMIT
                {
                    0
                } else {
                    -1
                },
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: if !self.stdout_closed && self.output.is_some() && self.controls.is_empty() {
                    1
                } else {
                    -1
                },
                events: libc::POLLOUT,
                revents: 0,
            },
        ];
        let now = Instant::now();
        let mut millis = 50;
        for deadline in self
            .output
            .as_ref()
            .map(|f| f.deadline)
            .into_iter()
            .chain(self.controls.front().map(|f| f.deadline))
        {
            millis = millis.min(
                deadline
                    .saturating_duration_since(now)
                    .as_millis()
                    .saturating_add(1)
                    .min(50) as i32,
            );
        }
        let result = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, millis) };
        if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(());
        }
        Ok(())
    }
    fn run(mut self) -> Result<i32, ()> {
        loop {
            match self.read_broker() {
                Ok(false) => {
                    self.close_stdout()?;
                    return Ok(0);
                }
                Ok(true) => {}
                Err(()) => {
                    self.broker_input.clear();
                    self.fail()?;
                }
            }
            if self.expired() {
                self.fail()?;
            }
            if self.exit_code.is_none() && !self.stdin_paused && self.read_stdin().is_err() {
                self.fail()?;
            }
            if self.write_controls().is_err() {
                self.fail()?;
            }
            // Drain control again immediately before the one nonblocking stdout syscall.
            match self.read_broker() {
                Ok(false) => {
                    self.close_stdout()?;
                    return Ok(0);
                }
                Ok(true) => {}
                Err(()) => {
                    self.broker_input.clear();
                    self.fail()?;
                }
            }
            if self.expired() {
                self.fail()?;
            }
            if self.write_stdout().is_err() {
                self.fail()?;
            }
            if self.controls.is_empty() {
                if let Some(code) = self.exit_code {
                    return Ok(code);
                }
                if self.stdin_eof
                    && self.stdin_input.is_empty()
                    && self.inflight.is_none()
                    && self.output.is_none()
                {
                    self.close_stdout()?;
                    return Ok(0);
                }
            }
            if self.poll().is_err() {
                self.fail()?;
            }
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.close_stdout();
    }
}

fn line(value: &Value, limit: usize) -> Result<Vec<u8>, ()> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| ())?;
    bytes.push(b'\n');
    if bytes.len() > limit {
        return Err(());
    }
    Ok(bytes)
}
fn authenticate(stream: &UnixStream, capability: &str) -> Result<(), ()> {
    let deadline = Instant::now() + TIMEOUT;
    send_bytes(
        stream,
        &line(&json!({"kind":"hello","capability":capability}), 256)?,
        deadline,
    )
    .map_err(|_| ())?;
    let mut bytes = Vec::new();
    loop {
        wait_ready(stream.as_raw_fd(), libc::POLLIN, deadline).map_err(|_| ())?;
        let mut byte = 0_u8;
        let count = unsafe {
            libc::recv(
                stream.as_raw_fd(),
                (&mut byte as *mut u8).cast(),
                1,
                libc::MSG_DONTWAIT,
            )
        };
        if count == 0 {
            return Err(());
        }
        if count < 0 {
            if matches!(
                io::Error::last_os_error().kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
            ) {
                continue;
            }
            return Err(());
        }
        bytes.push(byte);
        if bytes.len() > 256 {
            return Err(());
        }
        if byte == b'\n' {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
            return if value.get("kind").and_then(Value::as_str) == Some("hello_ack") {
                Ok(())
            } else {
                Err(())
            };
        }
    }
}
fn fd_closed(fd: RawFd) -> bool {
    (unsafe { libc::fcntl(fd, libc::F_GETFD) }) == -1
        && io::Error::last_os_error().raw_os_error() == Some(libc::EBADF)
}
fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
fn connect_bounded(path: &Path) -> io::Result<UnixStream> {
    let bytes = path.as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
    if !path.is_absolute()
        || bytes.is_empty()
        || bytes.len() >= address.sun_path.len()
        || bytes.contains(&0)
    {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let uid = unsafe { libc::getuid() };
    let metadata = std::fs::symlink_metadata(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let parent_metadata = std::fs::symlink_metadata(parent)?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != uid
        || metadata.mode() & 0o7777 != 0o600
        || !parent_metadata.file_type().is_dir()
        || parent_metadata.uid() != uid
        || parent_metadata.mode() & 0o7777 != 0o700
    {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    address.sun_len = size_of::<libc::sockaddr_un>() as u8;
    unsafe {
        ptr::copy_nonoverlapping(
            bytes.as_ptr(),
            address.sun_path.as_mut_ptr().cast(),
            bytes.len(),
        );
    }
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    let socket = unsafe { OwnedFd::from_raw_fd(raw) };
    let flags = unsafe { libc::fcntl(raw, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(raw, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    set_nonblocking(raw)?;
    let enabled: libc::c_int = 1;
    if unsafe {
        libc::setsockopt(
            raw,
            libc::SOL_SOCKET,
            libc::SO_NOSIGPIPE,
            (&enabled as *const libc::c_int).cast(),
            size_of::<libc::c_int>() as libc::socklen_t,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe {
        libc::connect(
            raw,
            (&address as *const libc::sockaddr_un).cast(),
            size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    if result < 0 {
        let error = io::Error::last_os_error();
        if !matches!(
            error.raw_os_error(),
            Some(libc::EINPROGRESS | libc::EINTR | libc::EAGAIN)
        ) {
            return Err(error);
        }
        wait_ready(raw, libc::POLLOUT, Instant::now() + TIMEOUT)?;
        let mut error: libc::c_int = 0;
        let mut length = size_of::<libc::c_int>() as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                raw,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut error as *mut libc::c_int).cast(),
                &mut length,
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        if length as usize != size_of::<libc::c_int>() || error != 0 {
            return Err(io::Error::from(io::ErrorKind::ConnectionRefused));
        }
    }
    let stream = UnixStream::from(socket);
    stream.peer_addr()?;
    let mut peer_uid: libc::uid_t = 0;
    let mut peer_gid: libc::gid_t = 0;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut peer_uid, &mut peer_gid) } != 0
        || peer_uid != uid
    {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    Ok(stream)
}
fn wait_ready(fd: RawFd, events: libc::c_short, deadline: Instant) -> io::Result<()> {
    loop {
        let left = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
        let mut descriptor = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        let result = unsafe {
            libc::poll(
                &mut descriptor,
                1,
                (left.as_millis() + 1).min(i32::MAX as u128) as i32,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if result > 0 {
            if descriptor.revents & libc::POLLNVAL != 0 {
                return Err(io::Error::from(io::ErrorKind::InvalidInput));
            }
            if descriptor.revents & (events | libc::POLLERR | libc::POLLHUP) != 0 {
                return Ok(());
            }
        }
    }
}
fn send_bytes(stream: &UnixStream, mut bytes: &[u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        wait_ready(stream.as_raw_fd(), libc::POLLOUT, deadline)?;
        let sent = unsafe {
            libc::send(
                stream.as_raw_fd(),
                bytes.as_ptr().cast(),
                bytes.len(),
                libc::MSG_DONTWAIT,
            )
        };
        if sent > 0 {
            bytes = &bytes[sent as usize..];
            continue;
        }
        if sent == 0 {
            return Err(io::Error::from(io::ErrorKind::WriteZero));
        }
        let error = io::Error::last_os_error();
        if !matches!(
            error.kind(),
            io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
        ) {
            return Err(error);
        }
    }
    Ok(())
}
