//! Prepare every fallible macOS pipe wrapper before launching the process.
//! Custom child Stdio bypasses async-process's post-spawn stdio conversion.
//! This does not cover its first reaper-thread panic or other platforms.
use async_io::Async;
use std::io;

pub(super) type Input = Async<io::PipeWriter>;
pub(super) type Output = Async<io::PipeReader>;

pub(super) struct Streams {
    pub stdin: Input,
    pub stdout: Output,
    pub stderr: Output,
}

struct Prepared {
    streams: Streams,
    child_stdin: io::PipeReader,
    child_stdout: io::PipeWriter,
    child_stderr: io::PipeWriter,
}

impl Prepared {
    fn new() -> io::Result<Self> {
        Self::with_factories(io::pipe, Async::new, Async::new)
    }

    fn with_factories(
        mut pipe: impl FnMut() -> io::Result<(io::PipeReader, io::PipeWriter)>,
        writer: impl FnOnce(io::PipeWriter) -> io::Result<Input>,
        mut reader: impl FnMut(io::PipeReader) -> io::Result<Output>,
    ) -> io::Result<Self> {
        // Each pipe endpoint owns its descriptor. Only the parent endpoint is
        // made nonblocking; std::io::pipe supplies blocking, close-on-exec child
        // endpoints without hand-written raw-descriptor ownership.
        let (child_stdin, stdin) = pipe()?;
        let stdin = writer(stdin)?;
        let (stdout, child_stdout) = pipe()?;
        let stdout = reader(stdout)?;
        let (stderr, child_stderr) = pipe()?;
        let stderr = reader(stderr)?;
        Ok(Self {
            streams: Streams {
                stdin,
                stdout,
                stderr,
            },
            child_stdin,
            child_stdout,
            child_stderr,
        })
    }

    fn install(self, command: &mut async_process::Command) -> Streams {
        command
            .stdin(self.child_stdin)
            .stdout(self.child_stdout)
            .stderr(self.child_stderr);
        self.streams
    }
}

pub(super) fn spawn(
    command: async_process::Command,
) -> io::Result<(Streams, async_process::Child)> {
    spawn_prepared(command, Prepared::new)
}

fn spawn_prepared(
    mut command: async_process::Command,
    prepare: impl FnOnce() -> io::Result<Prepared>,
) -> io::Result<(Streams, async_process::Child)> {
    let streams = prepare()?.install(&mut command);
    // On macOS the locked async-process Signal reaper's per-child registration
    // is infallible. All three standard child pipe handles are None here, so
    // its fallible Async::new conversions are skipped after OS spawn.
    let child = command.spawn();
    // Command retains its custom Stdio endpoints. Close those parent copies
    // immediately, even on error, so they cannot keep a pipe's EOF alive.
    drop(command);
    Ok((streams, child?))
}

#[cfg(test)]
#[path = "process_stdio_tests.rs"]
mod tests;
