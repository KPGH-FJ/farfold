//! One bounded observer per connection. Never owns a process or request ledger.
use super::tap::DebugTap;
use agent_client_protocol::{
    RawJsonRpcMessage,
    schema::v1::{ErrorCode, RequestId, Response as RpcResponse},
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Arc, Mutex, mpsc},
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Spawn,
    Registration,
    Initialize,
    Cleanup,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Outcome {
    Unknown,
    Success,
    Cancelled,
    Failed,
    Timeout,
    Ended,
    StartFailed,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Response {
    NotObserved,
    MatchedResult,
    MatchedError,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Cleanup {
    NotApplicable,
    Pending,
    Deleted,
    Retained,
    Unconfirmed,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum FileLimitValue {
    Finite {
        value: u64,
    },
    Infinite,
    #[default]
    Unavailable,
}
impl FileLimitValue {
    #[cfg(unix)]
    fn from_raw(value: libc::rlim_t) -> Self {
        if value == libc::RLIM_INFINITY {
            Self::Infinite
        } else {
            // rlim_t is unsigned, but its width differs across Unix targets.
            #[allow(clippy::unnecessary_cast)]
            let value = value as u64;
            Self::Finite { value }
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct FileLimits {
    soft: FileLimitValue,
    hard: FileLimitValue,
}
impl FileLimits {
    fn capture() -> Self {
        #[cfg(unix)]
        {
            let mut limits = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            // This observes our process without opening a descriptor, spawning
            // another program or modifying limits. Never read an unwritten value.
            let observed = (unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limits) } == 0)
                .then_some(limits);
            Self::from_observed(observed)
        }
        #[cfg(not(unix))]
        {
            Self::default()
        }
    }
    #[cfg(unix)]
    fn from_observed(observed: Option<libc::rlimit>) -> Self {
        observed.map_or_else(Self::default, |limits| Self {
            soft: FileLimitValue::from_raw(limits.rlim_cur),
            hard: FileLimitValue::from_raw(limits.rlim_max),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SpawnFailure {
    os_error: Option<i32>,
    file_limit: FileLimits,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    phase: Phase,
    failure_phase: Option<Phase>,
    startup_outcome: Outcome,
    initialize_response: Response,
    initialize_accepted: bool,
    child_started: bool,
    child_reaped: bool,
    wait_failed: bool,
    exit_code: Option<u8>,
    exit_signal: Option<u8>,
    term_requested: bool,
    kill_requested: bool,
    exit_observed_before_term: bool,
    group_ended: bool,
    connection_removed: bool,
    candidate_cleanup: Cleanup,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    spawn_failure: Option<SpawnFailure>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            phase: Phase::Spawn,
            failure_phase: None,
            startup_outcome: Outcome::Unknown,
            initialize_response: Response::NotObserved,
            initialize_accepted: false,
            child_started: false,
            child_reaped: false,
            wait_failed: false,
            exit_code: None,
            exit_signal: None,
            term_requested: false,
            kill_requested: false,
            exit_observed_before_term: false,
            group_ended: false,
            connection_removed: false,
            candidate_cleanup: Cleanup::NotApplicable,
            spawn_failure: None,
        }
    }
}
struct State {
    snapshot: Snapshot,
    last_startup_phase: Phase,
    // Only our single outgoing initialize request; never serialized or logged.
    initialize_id: Option<RequestId>,
    revision: u64,
}
impl Default for State {
    fn default() -> Self {
        Self {
            snapshot: Snapshot::default(),
            last_startup_phase: Phase::Spawn,
            initialize_id: None,
            revision: 1,
        }
    }
}

pub(crate) struct Diagnostics {
    state: Arc<Mutex<State>>,
    records: Option<mpsc::SyncSender<Option<serde_json::Value>>>,
}
impl Diagnostics {
    pub(crate) fn open(log_dir: &Path, agent_id: &str) -> Arc<Self> {
        Self::with_tap(DebugTap::open(log_dir, agent_id))
    }
    fn with_tap(tap: Option<Arc<Mutex<DebugTap>>>) -> Arc<Self> {
        let state = Arc::new(Mutex::new(State::default()));
        let records = tap.map(|tap| {
            let (send, receive) = mpsc::sync_channel(64);
            let observer = state.clone();
            // No sender is held by this worker; final owner release terminates
            // it after reading the latest independent summary slot.
            std::thread::spawn(move || {
                let mut last = 0;
                loop {
                    let next = receive.recv();
                    if let Ok(Some(record)) = &next
                        && let Ok(mut tap) = tap.lock()
                    {
                        tap.write_record(record);
                    }
                    let summary = observer.lock().ok().and_then(|s| {
                        (s.revision != last).then(|| (s.revision, encode(&s.snapshot)))
                    });
                    if let Some((revision, record)) = summary {
                        if let Ok(mut tap) = tap.lock() {
                            tap.write_summary(&record);
                        }
                        last = revision;
                    }
                    if next.is_err() {
                        break;
                    }
                }
            });
            send
        });
        Arc::new(Self { state, records })
    }
    pub(crate) fn record(&self, record: serde_json::Value) {
        if let Some(send) = &self.records {
            let _ = send.try_send(Some(record));
        }
    }
    fn update(&self, change: impl FnOnce(&mut State)) {
        let mut changed = false;
        if let Ok(mut state) = self.state.lock() {
            let before = state.snapshot.clone();
            change(&mut state);
            if before != state.snapshot {
                state.revision += 1;
                changed = true;
            }
        }
        // No polling or blocking send: a full queue already provides a wake,
        // and the worker reads the independent latest slot after every wake.
        if changed && let Some(send) = &self.records {
            let _ = send.try_send(None);
        }
    }
    pub(crate) fn phase(&self, phase: Phase) {
        self.update(|s| {
            s.snapshot.phase = phase;
            if phase != Phase::Cleanup {
                s.last_startup_phase = phase;
            }
        });
    }
    pub(crate) fn outcome(&self, outcome: Outcome) {
        self.update(|s| {
            if s.snapshot.startup_outcome == Outcome::Unknown {
                s.snapshot.startup_outcome = outcome;
                s.snapshot.failure_phase =
                    (!matches!(outcome, Outcome::Success | Outcome::Unknown))
                        .then_some(s.last_startup_phase);
            }
        });
    }
    pub(crate) fn accepted(&self) {
        self.update(|s| s.snapshot.initialize_accepted = true);
    }
    pub(crate) fn started(&self) {
        self.update(|s| {
            s.snapshot.child_started = true;
            s.snapshot.phase = Phase::Registration;
            s.last_startup_phase = Phase::Registration;
        });
    }
    /// Only an actual failed asynchronous launch may call this. The returned
    /// error does not identify OS spawn versus later setup, imply resource
    /// exhaustion or choose the caller's outcome. No error text is stored.
    pub(crate) fn spawn_failed(&self, error: &std::io::Error) {
        let failure = SpawnFailure {
            os_error: error.raw_os_error(),
            file_limit: FileLimits::capture(),
        };
        self.update(|s| {
            s.snapshot.spawn_failure.get_or_insert(failure);
        });
    }
    pub(crate) fn signal_requested(&self, kill: bool, exit_already_observed: bool) {
        self.update(|s| {
            if kill {
                s.snapshot.kill_requested = true;
            } else {
                if !s.snapshot.term_requested {
                    s.snapshot.exit_observed_before_term = exit_already_observed;
                }
                s.snapshot.term_requested = true;
            }
        });
    }
    pub(crate) fn exit(&self, status: &Result<std::process::ExitStatus, std::io::Error>) {
        self.update(|s| match status {
            Ok(status) => {
                s.snapshot.child_reaped = true;
                s.snapshot.exit_code = status.code().and_then(|v| v.try_into().ok());
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    s.snapshot.exit_signal = status.signal().and_then(|v| v.try_into().ok());
                }
            }
            Err(_) => s.snapshot.wait_failed = true,
        });
    }
    pub(crate) fn group_ended(&self) {
        self.update(|s| s.snapshot.group_ended = true);
    }
    pub(crate) fn removed(&self) {
        self.update(|s| s.snapshot.connection_removed = true);
    }
    pub(crate) fn cleanup(&self, status: Cleanup) {
        self.update(|s| s.snapshot.candidate_cleanup = status);
    }
    /// Called after the existing manager close/removal check. An unsuccessful
    /// wait or poisoned observer cannot authorize deletion of executable files.
    pub(crate) fn candidate_files_releasable(&self) -> bool {
        self.state.lock().is_ok_and(|state| {
            !state.snapshot.child_started
                || (state.snapshot.child_reaped
                    && state.snapshot.group_ended
                    && state.snapshot.connection_removed)
        })
    }
    pub(crate) fn inspect(&self, message: &RawJsonRpcMessage, outgoing: bool) {
        self.update(|s| match message {
            RawJsonRpcMessage::Request(request)
                if outgoing
                    && request.method.as_ref() == "initialize"
                    && s.initialize_id.is_none()
                    && s.snapshot.initialize_response == Response::NotObserved =>
            {
                s.initialize_id = Some(request.id.clone());
                s.snapshot.phase = Phase::Initialize;
                s.last_startup_phase = Phase::Initialize;
            }
            RawJsonRpcMessage::Response(response)
                if !outgoing
                    && message.response_id() == s.initialize_id.as_ref()
                    && s.initialize_id.is_some() =>
            {
                s.snapshot.initialize_response = match response {
                    RpcResponse::Result { .. } => Response::MatchedResult,
                    RpcResponse::Error { .. } => Response::MatchedError,
                };
                s.initialize_id = None;
            }
            _ => {}
        });
    }
    /// Classify only an observed typed outgoing error. This does not identify
    /// the handler or establish when the corresponding request was received.
    pub(crate) fn annotate_outgoing_error(
        &self,
        message: &RawJsonRpcMessage,
        record: &mut serde_json::Value,
    ) {
        self.annotate_error(message, record, false);
    }
    /// Only a typed Error observed on the incoming bridge qualifies. Local
    /// request decode/EOF/timeout failures are not remote error observations.
    pub(crate) fn annotate_incoming_error(
        &self,
        message: &RawJsonRpcMessage,
        record: &mut serde_json::Value,
    ) {
        self.annotate_error(message, record, true);
    }
    fn annotate_error(
        &self,
        message: &RawJsonRpcMessage,
        record: &mut serde_json::Value,
        incoming: bool,
    ) {
        let RawJsonRpcMessage::Response(RpcResponse::Error { id, error }) = message else {
            return;
        };
        // Diagnostics must not wait for another observer or invent a boolean
        // after contention/poison. Omit the whole optional group instead.
        let Ok(state) = self.state.try_lock() else {
            return;
        };
        let before_accepted = !state.snapshot.initialize_accepted;
        drop(state);
        let class = match error.code {
            ErrorCode::ParseError => "parse_error",
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::MethodNotFound => "method_not_found",
            ErrorCode::InvalidParams => "invalid_params",
            ErrorCode::InternalError => "internal_error",
            ErrorCode::RequestCancelled if incoming => "request_cancelled",
            ErrorCode::AuthRequired if incoming => "auth_required",
            ErrorCode::ResourceNotFound if incoming => "resource_not_found",
            _ => "other",
        };
        let Some(record) = record.as_object_mut() else {
            return;
        };
        record.insert("protocolErrorClass".into(), class.into());
        record.insert(
            "responseIdNull".into(),
            matches!(id, RequestId::Null).into(),
        );
        record.insert("beforeInitializeAccepted".into(), before_accepted.into());
    }
}
fn encode(snapshot: &Snapshot) -> serde_json::Value {
    let mut value = serde_json::to_value(snapshot).expect("fixed snapshot serializes");
    value["version"] = 2.into();
    value["event"] = "startup".into();
    value["ts"] = super::tap::now_millis().into();
    value
}
pub(crate) fn safe_record(value: &serde_json::Value) -> Option<serde_json::Value> {
    if value.get("version")?.as_u64() != Some(2) || value.get("event")?.as_str() != Some("startup")
    {
        return None;
    }
    let ts = value.get("ts")?.as_u64()?;
    let snapshot: Snapshot = serde_json::from_value(value.clone()).ok()?;
    if snapshot.exit_signal.is_some_and(|s| s == 0 || s > 127)
        || (!snapshot.child_reaped
            && (snapshot.exit_code.is_some() || snapshot.exit_signal.is_some()))
        || (snapshot.exit_code.is_some() && snapshot.exit_signal.is_some())
        || (snapshot.child_reaped && !snapshot.child_started)
        || (snapshot.spawn_failure.is_some()
            && (snapshot.child_started
                || snapshot.initialize_accepted
                || snapshot.startup_outcome == Outcome::Success
                || snapshot
                    .failure_phase
                    .is_some_and(|phase| phase != Phase::Spawn)))
    {
        return None;
    }
    let mut safe = encode(&snapshot);
    safe["ts"] = ts.into();
    Some(safe)
}

#[cfg(test)]
mod tests;
