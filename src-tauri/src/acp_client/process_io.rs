//! Parent pipe observations only; neither bridge delivery nor child consumption.
use super::super::startup_diagnostics::Diagnostics;
use futures_lite::io::{AsyncRead, AsyncWrite};
use serde::{Deserialize, Serialize};
use std::{
    io,
    pin::Pin,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    task::{Context, Poll},
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Completion {
    ParentWrappersDropped,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Operation {
    Read,
    Write,
    Flush,
    Close,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ErrorKind {
    BrokenPipe,
    ConnectionReset,
    ConnectionAborted,
    NotConnected,
    PermissionDenied,
    Interrupted,
    WouldBlock,
    TimedOut,
    UnexpectedEof,
    WriteZero,
    InvalidData,
    InvalidInput,
    Other,
}
impl From<io::ErrorKind> for ErrorKind {
    fn from(value: io::ErrorKind) -> Self {
        match value {
            io::ErrorKind::BrokenPipe => Self::BrokenPipe,
            io::ErrorKind::ConnectionReset => Self::ConnectionReset,
            io::ErrorKind::ConnectionAborted => Self::ConnectionAborted,
            io::ErrorKind::NotConnected => Self::NotConnected,
            io::ErrorKind::PermissionDenied => Self::PermissionDenied,
            io::ErrorKind::Interrupted => Self::Interrupted,
            io::ErrorKind::WouldBlock => Self::WouldBlock,
            io::ErrorKind::TimedOut => Self::TimedOut,
            io::ErrorKind::UnexpectedEof => Self::UnexpectedEof,
            io::ErrorKind::WriteZero => Self::WriteZero,
            io::ErrorKind::InvalidData => Self::InvalidData,
            io::ErrorKind::InvalidInput => Self::InvalidInput,
            _ => Self::Other,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Failure {
    operation: Operation,
    kind: ErrorKind,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Stream {
    bytes: u64,
    eof: bool,
    error_count: u64,
    first_error: Option<Failure>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    completion: Completion,
    stdin: Stream,
    stdout: Stream,
    stderr: Stream,
}
impl Snapshot {
    pub(crate) fn valid(&self) -> bool {
        !self.stdin.eof
            && [&self.stdin, &self.stdout, &self.stderr]
                .iter()
                .all(|stream| (stream.error_count == 0) == stream.first_error.is_none())
            && self
                .stdin
                .first_error
                .is_none_or(|error| error.operation != Operation::Read)
            && [&self.stdout, &self.stderr].iter().all(|stream| {
                stream
                    .first_error
                    .is_none_or(|error| error.operation == Operation::Read)
            })
    }
}

#[derive(Default)]
struct Count {
    bytes: AtomicU64,
    eof: AtomicBool,
    errors: AtomicU64,
    first_error: OnceLock<Failure>,
}
fn add(count: &AtomicU64, value: u64) {
    let _ = count.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |previous| {
        Some(previous.saturating_add(value))
    });
}
impl Count {
    fn error(&self, operation: Operation, error: &io::Error) {
        add(&self.errors, 1);
        let _ = self.first_error.set(Failure {
            operation,
            kind: error.kind().into(),
        });
    }
    fn snapshot(&self) -> Stream {
        Stream {
            bytes: self.bytes.load(Ordering::Relaxed),
            eof: self.eof.load(Ordering::Relaxed),
            error_count: self.errors.load(Ordering::Relaxed),
            first_error: self.first_error.get().copied(),
        }
    }
}
struct Observation {
    diagnostics: Arc<Diagnostics>,
    streams: [Count; 3],
}
impl Drop for Observation {
    fn drop(&mut self) {
        // Each wrapper drops its inner IO before this Arc. The last parent
        // wrapper emits once, including when a transport future is cancelled.
        // This is not an EOF, process-reap, protocol-decode or child-read claim.
        self.diagnostics.transport_io(Snapshot {
            completion: Completion::ParentWrappersDropped,
            stdin: self.streams[0].snapshot(),
            stdout: self.streams[1].snapshot(),
            stderr: self.streams[2].snapshot(),
        });
    }
}
pub(super) struct Observed<T> {
    inner: T,
    observation: Arc<Observation>,
    stream: usize,
}
pub(super) fn observe<W, R, E>(
    stdin: W,
    stdout: R,
    stderr: E,
    diagnostics: Arc<Diagnostics>,
) -> (Observed<W>, Observed<R>, Observed<E>) {
    let observation = Arc::new(Observation {
        diagnostics,
        streams: std::array::from_fn(|_| Count::default()),
    });
    (
        Observed {
            inner: stdin,
            observation: observation.clone(),
            stream: 0,
        },
        Observed {
            inner: stdout,
            observation: observation.clone(),
            stream: 1,
        },
        Observed {
            inner: stderr,
            observation,
            stream: 2,
        },
    )
}
impl<R: AsyncRead + Unpin> AsyncRead for Observed<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_read(cx, buffer);
        let count = &this.observation.streams[this.stream];
        match &result {
            Poll::Ready(Ok(bytes)) => {
                add(&count.bytes, *bytes as u64);
                if *bytes == 0 && !buffer.is_empty() {
                    count.eof.store(true, Ordering::Relaxed);
                }
            }
            Poll::Ready(Err(error)) => count.error(Operation::Read, error),
            Poll::Pending => {}
        }
        result
    }
}
impl<W: AsyncWrite + Unpin> AsyncWrite for Observed<W> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_write(cx, buffer);
        let count = &this.observation.streams[this.stream];
        match &result {
            Poll::Ready(Ok(bytes)) => add(&count.bytes, *bytes as u64),
            Poll::Ready(Err(error)) => count.error(Operation::Write, error),
            Poll::Pending => {}
        }
        result
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_flush(cx);
        if let Poll::Ready(Err(error)) = &result {
            this.observation.streams[this.stream].error(Operation::Flush, error);
        }
        result
    }
    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let result = Pin::new(&mut this.inner).poll_close(cx);
        if let Poll::Ready(Err(error)) = &result {
            this.observation.streams[this.stream].error(Operation::Close, error);
        }
        result
    }
}

#[cfg(test)]
#[path = "process_io_unit_tests.rs"]
mod tests;
