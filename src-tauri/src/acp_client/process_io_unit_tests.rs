use super::*;
use std::{collections::VecDeque, time::Duration};

enum Step {
    Pending,
    Bytes(usize),
    Error(io::ErrorKind),
}
struct Scripted {
    steps: VecDeque<Step>,
}
fn script(steps: impl IntoIterator<Item = Step>) -> Scripted {
    Scripted {
        steps: steps.into_iter().collect(),
    }
}
impl AsyncRead for Scripted {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buffer: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        if buffer.is_empty() {
            return Poll::Ready(Ok(0));
        }
        match self.steps.pop_front().unwrap() {
            Step::Pending => Poll::Pending,
            Step::Bytes(count) => {
                buffer[..count].fill(b'x');
                Poll::Ready(Ok(count))
            }
            Step::Error(kind) => Poll::Ready(Err(io::Error::new(kind, "PRIVATE_PIPE_CANARY"))),
        }
    }
}
impl AsyncWrite for Scripted {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.steps.pop_front().unwrap() {
            Step::Pending => Poll::Pending,
            Step::Bytes(count) => Poll::Ready(Ok(count)),
            Step::Error(kind) => Poll::Ready(Err(io::Error::new(kind, "PRIVATE_PIPE_CANARY"))),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "PRIVATE_PIPE_CANARY",
        )))
    }
    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Err(io::Error::other("PRIVATE_PIPE_CANARY")))
    }
}
fn diagnostic() -> (tempfile::TempDir, Arc<Diagnostics>) {
    let root = tempfile::tempdir().unwrap();
    let diagnostics = Diagnostics::open(root.path(), "fixture");
    (root, diagnostics)
}
fn context() -> Context<'static> {
    Context::from_waker(std::task::Waker::noop())
}

#[test]
fn reads_preserve_pending_partial_success_error_and_real_eof() {
    let (_root, diagnostics) = diagnostic();
    let (_input, mut output, _error) = observe(
        script([]),
        script([
            Step::Pending,
            Step::Bytes(2),
            Step::Error(io::ErrorKind::InvalidData),
            Step::Bytes(0),
        ]),
        script([]),
        diagnostics,
    );
    let mut cx = context();
    let mut buffer = [0; 4];
    assert!(matches!(
        Pin::new(&mut output).poll_read(&mut cx, &mut []),
        Poll::Ready(Ok(0))
    ));
    assert!(!output.observation.streams[1].snapshot().eof);
    assert!(
        Pin::new(&mut output)
            .poll_read(&mut cx, &mut buffer)
            .is_pending()
    );
    assert_eq!(output.observation.streams[1].snapshot().bytes, 0);
    assert!(matches!(
        Pin::new(&mut output).poll_read(&mut cx, &mut buffer),
        Poll::Ready(Ok(2))
    ));
    match Pin::new(&mut output).poll_read(&mut cx, &mut buffer) {
        Poll::Ready(Err(error)) => assert_eq!(error.to_string(), "PRIVATE_PIPE_CANARY"),
        _ => panic!("original error must be preserved"),
    }
    assert!(matches!(
        Pin::new(&mut output).poll_read(&mut cx, &mut buffer),
        Poll::Ready(Ok(0))
    ));
    let snapshot = output.observation.streams[1].snapshot();
    assert_eq!(snapshot.bytes, 2);
    assert!(snapshot.eof);
    assert_eq!(snapshot.error_count, 1);
    assert_eq!(snapshot.first_error.unwrap().kind, ErrorKind::InvalidData);
    assert!(
        !serde_json::to_string(&snapshot)
            .unwrap()
            .contains("PRIVATE_PIPE_CANARY")
    );
}

#[test]
fn writes_count_only_accepted_prefix_and_keep_flush_close_errors() {
    let (_root, diagnostics) = diagnostic();
    let (mut input, _output, _error) = observe(
        script([
            Step::Pending,
            Step::Bytes(2),
            Step::Bytes(0),
            Step::Error(io::ErrorKind::BrokenPipe),
            Step::Bytes(3),
        ]),
        script([]),
        script([]),
        diagnostics,
    );
    let mut cx = context();
    for expected in [
        None,
        Some(Ok(2)),
        Some(Ok(0)),
        Some(Err(io::ErrorKind::BrokenPipe)),
        Some(Ok(3)),
    ] {
        let actual = Pin::new(&mut input).poll_write(&mut cx, b"PRIVATE_PIPE_CANARY");
        match (actual, expected) {
            (Poll::Pending, None) => {}
            (Poll::Ready(Ok(actual)), Some(Ok(expected))) => assert_eq!(actual, expected),
            (Poll::Ready(Err(actual)), Some(Err(expected))) => assert_eq!(actual.kind(), expected),
            _ => panic!("original poll result changed"),
        }
    }
    assert!(matches!(
        Pin::new(&mut input).poll_flush(&mut cx),
        Poll::Ready(Err(_))
    ));
    assert!(matches!(
        Pin::new(&mut input).poll_close(&mut cx),
        Poll::Ready(Err(_))
    ));
    let snapshot = input.observation.streams[0].snapshot();
    assert_eq!(snapshot.bytes, 5);
    assert!(!snapshot.eof);
    assert_eq!(snapshot.error_count, 3);
    assert_eq!(
        snapshot.first_error.unwrap(),
        Failure {
            operation: Operation::Write,
            kind: ErrorKind::BrokenPipe
        }
    );
}

#[test]
fn counters_saturate_and_unknown_errors_have_no_original_text() {
    let count = Count::default();
    count.bytes.store(u64::MAX - 1, Ordering::Relaxed);
    add(&count.bytes, 10);
    assert_eq!(count.snapshot().bytes, u64::MAX);
    count.error(Operation::Read, &io::Error::other("PRIVATE_PIPE_CANARY"));
    assert_eq!(count.snapshot().first_error.unwrap().kind, ErrorKind::Other);
    for (kind, expected) in [
        (io::ErrorKind::BrokenPipe, ErrorKind::BrokenPipe),
        (io::ErrorKind::ConnectionReset, ErrorKind::ConnectionReset),
        (
            io::ErrorKind::ConnectionAborted,
            ErrorKind::ConnectionAborted,
        ),
        (io::ErrorKind::NotConnected, ErrorKind::NotConnected),
        (io::ErrorKind::PermissionDenied, ErrorKind::PermissionDenied),
        (io::ErrorKind::Interrupted, ErrorKind::Interrupted),
        (io::ErrorKind::WouldBlock, ErrorKind::WouldBlock),
        (io::ErrorKind::TimedOut, ErrorKind::TimedOut),
        (io::ErrorKind::UnexpectedEof, ErrorKind::UnexpectedEof),
        (io::ErrorKind::WriteZero, ErrorKind::WriteZero),
        (io::ErrorKind::InvalidData, ErrorKind::InvalidData),
        (io::ErrorKind::InvalidInput, ErrorKind::InvalidInput),
    ] {
        assert_eq!(ErrorKind::from(kind), expected);
    }
}

fn records(path: &std::path::Path) -> Vec<serde_json::Value> {
    std::fs::read_dir(path)
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect::<Vec<_>>()
        })
        .collect()
}

#[test]
fn last_parent_drop_publishes_once_without_rewriting_later_lifecycle_state() {
    let (root, diagnostics) = diagnostic();
    let (input, output, error) = observe(script([]), script([]), script([]), diagnostics.clone());
    drop(output);
    drop(input);
    diagnostics.phase(super::super::super::startup_diagnostics::Phase::Initialize);
    diagnostics.outcome(super::super::super::startup_diagnostics::Outcome::Timeout);
    diagnostics.phase(super::super::super::startup_diagnostics::Phase::Cleanup);
    diagnostics.removed();
    assert!(
        !records(root.path())
            .iter()
            .any(|record| record.get("transportIo").is_some())
    );
    drop(error);
    let until = std::time::Instant::now() + Duration::from_secs(3);
    let observed = loop {
        let all = records(root.path());
        let records: Vec<_> = all
            .into_iter()
            .filter(|record| record.get("transportIo").is_some())
            .collect();
        if !records.is_empty() {
            break records;
        }
        assert!(std::time::Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(observed.len(), 1);
    let record = &observed[0];
    assert_eq!(record["phase"], "cleanup");
    assert_eq!(record["failurePhase"], "initialize");
    assert_eq!(record["startupOutcome"], "timeout");
    assert_eq!(record["connectionRemoved"], true);
    let safe = super::super::super::startup_diagnostics::safe_record(record).unwrap();
    assert_eq!(safe["transportIo"]["completion"], "parent_wrappers_dropped");
    let mut injected = safe.clone();
    injected["transportIo"]["stdout"]["rawPayload"] = "PRIVATE_PIPE_CANARY".into();
    injected["transportIo"]["originalError"] = "PRIVATE_PIPE_CANARY".into();
    assert!(
        !super::super::super::tap::safe_record(&injected)
            .unwrap()
            .to_string()
            .contains("PRIVATE_PIPE_CANARY")
    );
    injected["transportIo"]["completion"] = "child_finished".into();
    assert!(super::super::super::tap::safe_record(&injected).is_none());
    let mut old = safe;
    old.as_object_mut().unwrap().remove("transportIo");
    assert!(super::super::super::tap::safe_record(&old).is_some());
}
