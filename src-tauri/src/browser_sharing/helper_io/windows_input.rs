//! One demand at a time on the helper's original, read-only standard input.
//! Only this reader calls synchronous input APIs; the relay remains responsive.
use super::super::InputStop;
use std::{
    hint::black_box,
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
    sync::{Arc, Condvar, Mutex, MutexGuard},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows_sys::{
    Wdk::Storage::FileSystem::{
        FILE_MODE_INFORMATION, FILE_SYNCHRONOUS_IO_ALERT, FILE_SYNCHRONOUS_IO_NONALERT,
        FileModeInformation, NtQueryInformationFile,
    },
    Win32::{
        Foundation::{
            DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_BROKEN_PIPE, HANDLE, STATUS_PENDING,
        },
        Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType, ReadFile},
        System::{
            IO::{CancelSynchronousIo, IO_STATUS_BLOCK},
            Pipes::PeekNamedPipe,
            Threading::GetCurrentProcess,
        },
    },
};

#[cfg(test)]
#[path = "windows_input_tests.rs"]
mod tests;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::browser_sharing) enum CompletionKind {
    NoData,
    Data(usize),
    Eof,
    Observed,
    Error,
}
#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::browser_sharing) enum Step {
    DemandQueued,
    PeekingMarkedBeforePeek,
    PeekReturned(u32),
    ReadingMarkedBeforeRead,
    CompletedBeforePublish(CompletionKind),
}
#[cfg(test)]
type Observer = Arc<dyn Fn(Step) + Send + Sync>;

const CHUNK: usize = 8192;
const ADMISSION_WAIT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    Starting,
    Idle,
    Queued(usize),
    Peeking,
    Reading,
    Complete,
}
#[derive(Debug)]
enum Outcome {
    NoData,
    Data(usize),
    PeekEof,
    ReadEof,
    Observed,
}
struct State {
    phase: Phase,
    buffer: Option<Box<[u8; CHUNK]>>,
    result: Option<io::Result<Outcome>>,
    paused: bool,
    retiring: bool,
}
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    #[cfg(test)]
    observer: Option<Observer>,
}
pub(crate) struct Input {
    shared: Arc<Shared>,
    thread: JoinHandle<()>,
}
fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}
fn block() -> io::Error {
    io::ErrorKind::WouldBlock.into()
}
impl Shared {
    fn lock(&self) -> io::Result<MutexGuard<'_, State>> {
        self.state.lock().map_err(|_| invalid())
    }
}
impl Input {
    pub(crate) fn from_handle(handle: HANDLE) -> io::Result<Self> {
        Self::create(
            handle,
            #[cfg(test)]
            None,
        )
    }
    #[cfg(test)]
    pub(in crate::browser_sharing) fn from_handle_observed(
        handle: HANDLE,
        observer: Observer,
    ) -> io::Result<Self> {
        Self::create(handle, Some(observer))
    }
    fn create(handle: HANDLE, #[cfg(test)] observer: Option<Observer>) -> io::Result<Self> {
        let mut raw = ptr::null_mut();
        let process = unsafe { GetCurrentProcess() };
        if unsafe {
            DuplicateHandle(
                process,
                handle,
                process,
                &mut raw,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let original = unsafe { OwnedHandle::from_raw_handle(raw) };
        if unsafe { GetFileType(original.as_raw_handle()) } != FILE_TYPE_PIPE {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                phase: Phase::Starting,
                buffer: Some(Box::new([0; CHUNK])),
                result: None,
                paused: false,
                retiring: false,
            }),
            wake: Condvar::new(),
            #[cfg(test)]
            observer,
        });
        let reader_state = shared.clone();
        let thread = thread::Builder::new()
            .name("browser-tool-input".into())
            .spawn(move || run(original, reader_state))?;
        let input = Self { shared, thread };
        let deadline = Instant::now() + ADMISSION_WAIT;
        {
            let mut state = input.shared.lock()?;
            while state.phase == Phase::Starting {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(io::ErrorKind::TimedOut.into());
                }
                state = input
                    .shared
                    .wake
                    .wait_timeout(state, left)
                    .map_err(|_| invalid())?
                    .0;
            }
            if state.phase != Phase::Idle {
                return Err(state
                    .result
                    .take()
                    .and_then(Result::err)
                    .unwrap_or_else(invalid));
            }
        }
        Ok(input)
    }
    pub(crate) fn read_into(&mut self, bytes: &mut Vec<u8>, limit: usize) -> io::Result<bool> {
        let mut state = self.shared.lock()?;
        if state.paused || state.retiring {
            return Err(block());
        }
        if state.phase == Phase::Complete {
            let outcome = state.result.take().ok_or_else(invalid)??;
            state.phase = Phase::Idle;
            match outcome {
                Outcome::Data(count) => {
                    if count > limit.saturating_sub(bytes.len()) || count > CHUNK {
                        return Err(invalid());
                    }
                    bytes.extend_from_slice(&state.buffer.as_ref().ok_or_else(invalid)?[..count]);
                    return Ok(false);
                }
                Outcome::PeekEof | Outcome::ReadEof => return Ok(true),
                Outcome::NoData => return Err(block()),
                Outcome::Observed => return Err(invalid()),
            }
        }
        if state.phase == Phase::Idle {
            let capacity = CHUNK.min(limit.saturating_sub(bytes.len()));
            if capacity > 0 {
                state.phase = Phase::Queued(capacity);
                self.shared.wake.notify_one();
            }
        }
        Err(block())
    }
    pub(crate) fn pause(&mut self) -> io::Result<InputStop> {
        let (state, cancel) = {
            let mut state = self.shared.lock()?;
            let cancel = !state.paused && state.phase == Phase::Peeking;
            state.paused = true;
            if matches!(state.phase, Phase::Queued(_)) {
                state.phase = Phase::Idle;
            }
            (stop_state(&state), cancel)
        };
        if cancel {
            // A request only: NOT_FOUND and success are not completion evidence.
            unsafe {
                CancelSynchronousIo(self.thread.as_raw_handle());
            }
        }
        Ok(state)
    }
    pub(crate) fn stop_state(&self) -> io::Result<InputStop> {
        let state = self.shared.lock()?;
        Ok(stop_state(&state))
    }
    pub(crate) fn resume(&mut self) -> io::Result<()> {
        let mut state = self.shared.lock()?;
        if state.retiring || stop_state(&state) != InputStop::Clear {
            return Err(invalid());
        }
        state.paused = false;
        Ok(())
    }
    pub(crate) fn retire(&mut self) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.retiring = true;
            state.paused = true;
            self.shared.wake.notify_one();
        }
        // The reader retains its actual handle/buffer until its I/O completes.
        // No join and no input-handle close on this relay thread. The private
        // helper entry always exits the process immediately after returning.
        unsafe {
            CancelSynchronousIo(self.thread.as_raw_handle());
        }
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        self.retire();
    }
}
fn stop_state(state: &State) -> InputStop {
    match state.phase {
        Phase::Idle | Phase::Queued(_) => InputStop::Clear,
        Phase::Starting | Phase::Peeking => InputStop::Pending,
        Phase::Reading => InputStop::Dirty,
        Phase::Complete => match state.result.as_ref() {
            Some(Ok(Outcome::NoData | Outcome::PeekEof)) => InputStop::Clear,
            _ => InputStop::Dirty,
        },
    }
}

struct ModeQuery {
    status: IO_STATUS_BLOCK,
    mode: FILE_MODE_INFORMATION,
}
fn run(original: OwnedHandle, shared: Arc<Shared>) {
    // A pipe may have been inherited in overlapped mode. Its type alone is
    // insufficient for null-OVERLAPPED synchronous ReadFile calls.
    let mut query = Box::new(ModeQuery {
        status: IO_STATUS_BLOCK::default(),
        mode: FILE_MODE_INFORMATION::default(),
    });
    let status = unsafe {
        NtQueryInformationFile(
            original.as_raw_handle(),
            &mut query.status,
            (&mut query.mode as *mut FILE_MODE_INFORMATION).cast(),
            size_of::<FILE_MODE_INFORMATION>() as u32,
            FileModeInformation,
        )
    };
    let accepted = status == 0
        && unsafe { query.status.Anonymous.Status } == 0
        && query.status.Information == size_of::<FILE_MODE_INFORMATION>()
        && query.mode.Mode & (FILE_SYNCHRONOUS_IO_ALERT | FILE_SYNCHRONOUS_IO_NONALERT) != 0;
    if let Ok(mut state) = shared.lock() {
        if accepted {
            state.phase = Phase::Idle;
        } else {
            state.phase = Phase::Complete;
            state.result = Some(Err(io::ErrorKind::Unsupported.into()));
        }
        shared.wake.notify_one();
    } else if status != STATUS_PENDING {
        return;
    }
    if status == STATUS_PENDING {
        // This unexpected admission has been refused. Neither cancellation nor
        // return status proves the query buffers unused. Keep the sole original
        // owner alive until the refusing helper process exits; never admit I/O.
        loop {
            thread::park();
            black_box((&original, &query));
        }
    }
    if !accepted {
        return;
    }
    drop(query);
    loop {
        let (capacity, mut buffer) = {
            let Ok(mut state) = shared.lock() else {
                return;
            };
            loop {
                if state.retiring {
                    return;
                }
                if !state.paused
                    && let Phase::Queued(capacity) = state.phase
                {
                    #[cfg(test)]
                    {
                        drop(state);
                        notify(&shared, Step::DemandQueued);
                        state = match shared.lock() {
                            Ok(state) => state,
                            Err(_) => return,
                        };
                        if state.retiring {
                            return;
                        }
                        if state.paused || state.phase != Phase::Queued(capacity) {
                            continue;
                        }
                    }
                    let Some(buffer) = state.buffer.take() else {
                        return;
                    };
                    state.phase = Phase::Peeking;
                    break (capacity, buffer);
                }
                state = match shared.wake.wait(state) {
                    Ok(state) => state,
                    Err(_) => return,
                };
            }
        };
        #[cfg(test)]
        notify(&shared, Step::PeekingMarkedBeforePeek);
        let result = observe(&original, &shared, capacity, buffer.as_mut());
        #[cfg(test)]
        notify(
            &shared,
            Step::CompletedBeforePublish(match &result {
                Ok(Outcome::NoData) => CompletionKind::NoData,
                Ok(Outcome::Data(n)) => CompletionKind::Data(*n),
                Ok(Outcome::PeekEof | Outcome::ReadEof) => CompletionKind::Eof,
                Ok(Outcome::Observed) => CompletionKind::Observed,
                Err(_) => CompletionKind::Error,
            }),
        );
        let Ok(mut state) = shared.lock() else {
            return;
        };
        // Publication is part of this read. No new demand can begin before the
        // same buffer and exact completion have returned to the original slot.
        state.buffer = Some(buffer);
        state.result = Some(result);
        state.phase = Phase::Complete;
        shared.wake.notify_one();
    }
}
fn observe(
    original: &OwnedHandle,
    shared: &Shared,
    capacity: usize,
    buffer: &mut [u8],
) -> io::Result<Outcome> {
    let mut available = 0;
    if unsafe {
        PeekNamedPipe(
            original.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            &mut available,
            ptr::null_mut(),
        )
    } == 0
    {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
            Ok(Outcome::PeekEof)
        } else {
            Err(error)
        };
    }
    #[cfg(test)]
    notify(shared, Step::PeekReturned(available));
    if available == 0 {
        return Ok(Outcome::NoData);
    }
    {
        let mut state = shared.lock()?;
        if state.paused || state.retiring {
            return Ok(Outcome::Observed);
        }
        state.phase = Phase::Reading;
    }
    #[cfg(test)]
    notify(shared, Step::ReadingMarkedBeforeRead);
    let mut count = 0;
    let capacity = capacity.min(available as usize).min(buffer.len());
    if unsafe {
        ReadFile(
            original.as_raw_handle(),
            buffer.as_mut_ptr(),
            capacity as u32,
            &mut count,
            ptr::null_mut(),
        )
    } == 0
    {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
            Ok(Outcome::ReadEof)
        } else {
            Err(error)
        };
    }
    if count as usize > capacity {
        return Err(invalid());
    }
    if count == 0 {
        Ok(Outcome::ReadEof)
    } else {
        Ok(Outcome::Data(count as usize))
    }
}

#[cfg(test)]
fn notify(shared: &Shared, step: Step) {
    if let Some(observer) = &shared.observer {
        observer(step);
    }
}
