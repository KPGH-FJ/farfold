//! `terminal/*` client capability over [`crate::pty::PtyManager`].
//!
//! `terminal/create` spawns the requested command on a PTY in the session
//! workspace (the request `cwd` must resolve inside it, same rule as
//! `fs/*`). Environment = login shell env + request env, minus `HOME` —
//! the agent's keychain-injected variables never enter this merge, so a
//! terminal cannot inherit credentials the agent process itself holds.
//!
//! Output accumulates per terminal as a lossy-UTF-8 tail buffer (at least
//! 1 MB retained regardless of the requested `outputByteLimit`) and
//! streams to the session channel as `{kind:"terminalOutput",...}`.
//! `terminal/wait_for_exit` asks the pump to park its responder as an
//! exit-waiter; `terminal/kill`/`terminal/release` map onto SIGHUP plus
//! registry removal. Session teardown kills every terminal it created.
//!
//! [`handle_request`] returns a [`RequestPlan`] instead of a `Responder`
//! so the whole handler stays testable — `Responder` has no public
//! constructor outside the crate's dispatch path.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use agent_client_protocol::Responder;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::Value;

use crate::acp_client::fs_ops::resolve_within;
use crate::acp_client::pump::{PendingElicitations, SessionSink};
use crate::pty::{self, PtyManager, PtySink};
use crate::shell_env;

/// Tail bytes always retained per terminal, even when the agent asks for
/// a smaller `outputByteLimit`.
const MIN_OUTPUT_RETAIN: usize = 1024 * 1024;

/// terminal_id → live terminal record, shared across the whole manager so
/// ids never collide between sessions.
pub(crate) type TerminalMap = Arc<Mutex<HashMap<String, TerminalEntry>>>;

/// native session id → artifacts produced for it (`fileDiff`, `terminal`).
/// One map per `(agent_id, cwd)` connection.
pub(crate) type ArtifactMap = Arc<Mutex<HashMap<String, Vec<Value>>>>;

/// Everything a session pump needs to serve client-capability requests.
#[derive(Clone)]
pub(crate) struct SessionOps {
    pub pty: Arc<PtyManager>,
    pub terminals: TerminalMap,
    pub elicitations: PendingElicitations,
    pub artifacts: ArtifactMap,
}

pub(crate) struct TerminalEntry {
    session_id: String,
    pty_id: String,
    output: String,
    truncated: bool,
    byte_limit: usize,
    exit: Option<u32>,
    pub(crate) waiters: Vec<Responder<Value>>,
}

impl TerminalEntry {
    fn push_output(&mut self, text: &str) {
        self.output.push_str(text);
        if self.output.len() > self.byte_limit {
            // Truncate from the front on a char boundary to stay within
            // the limit, per the protocol contract.
            let mut drop = self.output.len() - self.byte_limit;
            while !self.output.is_char_boundary(drop) {
                drop += 1;
            }
            self.output.drain(..drop);
            self.truncated = true;
        }
    }

    fn exit_status(&self) -> Value {
        match self.exit {
            Some(code) => serde_json::json!({"exitCode": code}),
            None => Value::Null,
        }
    }
}

/// What the pump should do with the request's responder.
pub(crate) enum RequestPlan {
    /// Respond now; an artifact may ride along (`fileDiff`/`terminal`).
    Respond(Result<Value, String>, Option<Value>),
    /// Park the responder as an exit-waiter on this terminal.
    ParkWaiter { terminal_id: String },
}

/// The JSON-RPC result sent to a resolved exit-waiter.
pub(crate) fn exit_response(code: u32) -> Value {
    serde_json::json!({"exitCode": code})
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {key}"))
}

/// Request env merged over the login shell env; `HOME` cannot be
/// overridden (a stolen HOME would redirect credential stores).
fn merged_env(params: &Value) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = shell_env::command_env().into_iter().collect();
    if let Some(vars) = params.get("env").and_then(Value::as_array) {
        for var in vars {
            let name = var.get("name").and_then(Value::as_str).unwrap_or("");
            let value = var.get("value").and_then(Value::as_str).unwrap_or("");
            if name.is_empty() || name == "HOME" {
                continue;
            }
            env.retain(|(existing, _)| existing != name);
            env.push((name.to_string(), value.to_string()));
        }
    }
    env
}

fn create_terminal(
    ops: &SessionOps,
    session_id: &str,
    cwd: &Path,
    events: &SessionSink,
    params: &Value,
) -> Result<(String, String), String> {
    let command = required_str(params, "command")?;
    let args: Vec<String> = params
        .get("args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let cwd = match params.get("cwd").and_then(Value::as_str) {
        Some(requested) => resolve_within(cwd, Path::new(requested))?,
        None => cwd
            .canonicalize()
            .map_err(|error| format!("cannot resolve workspace: {error}"))?,
    };
    let byte_limit = params
        .get("outputByteLimit")
        .and_then(Value::as_u64)
        .map(|limit| usize::try_from(limit).unwrap_or(usize::MAX))
        .unwrap_or(MIN_OUTPUT_RETAIN)
        .max(MIN_OUTPUT_RETAIN);
    let env = merged_env(params);
    let title = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");

    let terminals = ops.terminals.clone();
    let events = events.clone();
    let sink: PtySink = Arc::new(move |frame| {
        let id = frame.get("id").and_then(Value::as_str).unwrap_or("");
        if let Some(data) = frame.get("data").and_then(Value::as_str) {
            let text = BASE64
                .decode(data)
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default();
            if let Ok(mut map) = terminals.lock()
                && let Some(entry) = map.get_mut(id)
            {
                entry.push_output(&text);
            }
            events(serde_json::json!({
                "kind": "terminalOutput",
                "terminalId": id,
                "data": text,
            }));
        } else if let Some(code) = frame.get("exit").and_then(Value::as_u64) {
            let code = u32::try_from(code).unwrap_or(1);
            if let Ok(mut map) = terminals.lock()
                && let Some(entry) = map.get_mut(id)
            {
                entry.exit = Some(code);
                for waiter in entry.waiters.drain(..) {
                    let _ = waiter.respond(exit_response(code));
                }
            }
            events(serde_json::json!({
                "kind": "terminalOutput",
                "terminalId": id,
                "exit": code,
            }));
        }
    });
    // The pty id doubles as the terminal id: the sink resolves entries by
    // the frame's `id` before it is even inserted below (first output can
    // race the insert — a miss just skips buffering that chunk).
    let pty_id = ops.pty.spawn(
        command,
        &args,
        &env,
        &cwd,
        portable_pty::PtySize {
            rows: pty::DEFAULT_ROWS,
            cols: pty::DEFAULT_COLS,
            pixel_width: 0,
            pixel_height: 0,
        },
        sink,
    )?;
    ops.terminals
        .lock()
        .map_err(|_| "terminal map lock poisoned")?
        .insert(
            pty_id.clone(),
            TerminalEntry {
                session_id: session_id.to_string(),
                pty_id: pty_id.clone(),
                output: String::new(),
                truncated: false,
                byte_limit,
                exit: None,
                waiters: Vec::new(),
            },
        );
    Ok((pty_id, title))
}

fn lookup_entry<'m>(
    map: &'m mut HashMap<String, TerminalEntry>,
    session_id: &str,
    params: &Value,
) -> Result<&'m mut TerminalEntry, String> {
    let terminal_id = required_str(params, "terminalId")?;
    let entry = map
        .get_mut(terminal_id)
        .ok_or_else(|| format!("terminal {terminal_id} is not live"))?;
    if entry.session_id != session_id {
        return Err(format!("terminal {terminal_id} belongs to another session"));
    }
    Ok(entry)
}

/// Handle one `terminal/*` request for `session_id`. The pump turns the
/// returned plan into a JSON-RPC response (or parks the responder).
pub(crate) fn handle_request(
    ops: &SessionOps,
    session_id: &str,
    cwd: &Path,
    events: &SessionSink,
    method: &str,
    params: &Value,
) -> RequestPlan {
    if method == "terminal/wait_for_exit" {
        return match params.get("terminalId").and_then(Value::as_str) {
            Some(terminal_id) => match terminal_wait_state(ops, session_id, terminal_id) {
                Ok(None) => RequestPlan::ParkWaiter {
                    terminal_id: terminal_id.to_string(),
                },
                Ok(Some(code)) => RequestPlan::Respond(Ok(exit_response(code)), None),
                Err(error) => RequestPlan::Respond(Err(error), None),
            },
            None => RequestPlan::Respond(Err("missing terminalId".to_string()), None),
        };
    }
    let outcome: Result<(Value, Option<Value>), String> = (|| match method {
        "terminal/create" => {
            let (terminal_id, title) = create_terminal(ops, session_id, cwd, events, params)?;
            let artifact = serde_json::json!({
                "type": "terminal",
                "terminalId": terminal_id,
                "title": title,
                "ts": super::tap::now_millis(),
            });
            Ok((
                serde_json::json!({"terminalId": terminal_id}),
                Some(artifact),
            ))
        }
        "terminal/output" => {
            let mut map = ops
                .terminals
                .lock()
                .map_err(|_| "terminal map lock poisoned")?;
            let entry = lookup_entry(&mut map, session_id, params)?;
            Ok((
                serde_json::json!({
                    "output": entry.output,
                    "truncated": entry.truncated,
                    "exitStatus": entry.exit_status(),
                }),
                None,
            ))
        }
        "terminal/kill" => {
            let mut map = ops
                .terminals
                .lock()
                .map_err(|_| "terminal map lock poisoned")?;
            let entry = lookup_entry(&mut map, session_id, params)?;
            ops.pty.close(&entry.pty_id)?;
            Ok((serde_json::json!({}), None))
        }
        "terminal/release" => {
            let mut map = ops
                .terminals
                .lock()
                .map_err(|_| "terminal map lock poisoned")?;
            let terminal_id = required_str(params, "terminalId")?.to_string();
            match map.get(&terminal_id) {
                Some(entry) if entry.session_id == session_id => {}
                Some(_) => {
                    return Err(format!("terminal {terminal_id} belongs to another session"));
                }
                None => return Err(format!("terminal {terminal_id} is not live")),
            }
            let mut entry = map.remove(&terminal_id).expect("checked above");
            for waiter in entry.waiters.drain(..) {
                let _ = waiter.respond_with_error(agent_client_protocol::util::internal_error(
                    "terminal released",
                ));
            }
            ops.pty.close(&entry.pty_id)?;
            Ok((serde_json::json!({}), None))
        }
        other => Err(format!("unsupported terminal method {other}")),
    })();
    match outcome {
        Ok((response, artifact)) => RequestPlan::Respond(Ok(response), artifact),
        Err(error) => RequestPlan::Respond(Err(error), None),
    }
}

/// `terminal/wait_for_exit` resolution: `Ok(None)` parks the responder,
/// `Ok(Some(code))` answers immediately.
fn terminal_wait_state(
    ops: &SessionOps,
    session_id: &str,
    terminal_id: &str,
) -> Result<Option<u32>, String> {
    let map = ops
        .terminals
        .lock()
        .map_err(|_| "terminal map lock poisoned")?;
    let entry = map
        .get(terminal_id)
        .ok_or_else(|| format!("terminal {terminal_id} is not live"))?;
    if entry.session_id != session_id {
        return Err(format!("terminal {terminal_id} belongs to another session"));
    }
    Ok(entry.exit)
}

/// Park a `wait_for_exit` responder on the terminal, or answer right away
/// if the exit landed between the plan and the park.
pub(crate) fn park_waiter(terminals: &TerminalMap, terminal_id: &str, responder: Responder<Value>) {
    if let Ok(mut map) = terminals.lock()
        && let Some(entry) = map.get_mut(terminal_id)
    {
        match entry.exit {
            Some(code) => {
                let _ = responder.respond(exit_response(code));
            }
            None => entry.waiters.push(responder),
        }
        return;
    }
    let _ = responder.respond_with_error(agent_client_protocol::util::internal_error(format!(
        "terminal {terminal_id} is not live"
    )));
}

/// Kill every terminal a session created (pump exit / connection loss).
pub(crate) fn release_session(terminals: &TerminalMap, pty: &PtyManager, session_id: &str) {
    let entries: Vec<TerminalEntry> = match terminals.lock() {
        Ok(mut map) => {
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, entry)| entry.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        }
        Err(_) => Vec::new(),
    };
    for mut entry in entries {
        for waiter in entry.waiters.drain(..) {
            let _ = waiter
                .respond_with_error(agent_client_protocol::util::internal_error("session ended"));
        }
        let _ = pty.close(&entry.pty_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn ops() -> (tempfile::TempDir, SessionOps) {
        let dir = tempfile::tempdir().expect("tempdir");
        let ops = SessionOps {
            pty: Arc::new(PtyManager::new()),
            terminals: TerminalMap::default(),
            elicitations: PendingElicitations::default(),
            artifacts: ArtifactMap::default(),
        };
        (dir, ops)
    }

    #[test]
    fn env_merge_keeps_request_vars_but_drops_home() {
        let params = serde_json::json!({
            "env": [
                {"name": "HOME", "value": "/tmp/evil"},
                {"name": "MY_FLAG", "value": "1"},
            ]
        });
        let env: HashMap<String, String> = merged_env(&params).into_iter().collect();
        assert_ne!(
            env.get("HOME").map(String::as_str),
            Some("/tmp/evil"),
            "request must not override HOME"
        );
        assert_eq!(env.get("MY_FLAG").map(String::as_str), Some("1"));
    }

    #[test]
    fn tail_buffer_truncates_from_front_on_char_boundary() {
        let mut entry = TerminalEntry {
            session_id: "s".to_string(),
            pty_id: "p".to_string(),
            output: String::new(),
            truncated: false,
            byte_limit: 8,
            exit: None,
            waiters: Vec::new(),
        };
        entry.push_output("0123456789");
        assert!(entry.truncated);
        assert_eq!(entry.output, "23456789");
        entry.push_output("你好"); // multibyte: boundary-safe trim
        assert!(entry.output.len() <= 8);
    }

    #[test]
    fn rejects_terminal_cwd_outside_workspace() {
        let (dir, ops) = ops();
        let events: SessionSink = Arc::new(|_| {});
        let params = serde_json::json!({"command": "/bin/echo", "cwd": "/etc"});
        let plan = handle_request(&ops, "s1", dir.path(), &events, "terminal/create", &params);
        match plan {
            RequestPlan::Respond(Err(error), None) => {
                assert!(error.contains("outside workspace"), "{error}")
            }
            _ => panic!("expected a rejected create"),
        }
        assert!(ops.terminals.lock().unwrap().is_empty());
    }

    #[test]
    fn create_output_wait_and_release_round_trip() {
        let (dir, ops) = ops();
        let events_log = Arc::new(Mutex::new(Vec::new()));
        let events: SessionSink = {
            let events_log = events_log.clone();
            Arc::new(move |value| events_log.lock().unwrap().push(value))
        };
        let plan = handle_request(
            &ops,
            "s1",
            dir.path(),
            &events,
            "terminal/create",
            &serde_json::json!({
                "command": "/bin/sh",
                "args": ["-c", "printf hello-term; exit 7"],
            }),
        );
        let terminal_id = match plan {
            RequestPlan::Respond(Ok(response), Some(artifact)) => {
                assert_eq!(artifact["type"], "terminal");
                response["terminalId"].as_str().unwrap().to_string()
            }
            _ => panic!("expected a created terminal"),
        };
        // `wait_for_exit` parks while the child is alive, resolves after.
        let parked = handle_request(
            &ops,
            "s1",
            dir.path(),
            &events,
            "terminal/wait_for_exit",
            &serde_json::json!({"terminalId": terminal_id}),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        let code = loop {
            let plan = handle_request(
                &ops,
                "s1",
                dir.path(),
                &events,
                "terminal/wait_for_exit",
                &serde_json::json!({"terminalId": terminal_id}),
            );
            if let RequestPlan::Respond(Ok(response), _) = plan {
                break response["exitCode"].as_u64().unwrap();
            }
            assert!(Instant::now() < deadline, "terminal never exited");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(code, 7);
        let _ = parked;

        // Buffered output plus the streamed channel events both saw it.
        // The reader thread can lag the exit frame slightly, so poll.
        let deadline = Instant::now() + Duration::from_secs(3);
        let output = loop {
            let plan = handle_request(
                &ops,
                "s1",
                dir.path(),
                &events,
                "terminal/output",
                &serde_json::json!({"terminalId": terminal_id}),
            );
            let RequestPlan::Respond(Ok(response), _) = plan else {
                panic!("output request failed")
            };
            assert_eq!(response["exitStatus"]["exitCode"], 7);
            let text = response["output"].as_str().unwrap_or("").to_string();
            if text.contains("hello-term") || Instant::now() > deadline {
                break text;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(output.contains("hello-term"), "buffered: {output:?}");
        let streamed: String = events_log
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["kind"] == "terminalOutput")
            .filter_map(|e| e["data"].as_str().map(str::to_string))
            .collect();
        assert!(streamed.contains("hello-term"), "streamed: {streamed:?}");

        // Another session cannot touch it; release removes it.
        let plan = handle_request(
            &ops,
            "other",
            dir.path(),
            &events,
            "terminal/release",
            &serde_json::json!({"terminalId": terminal_id}),
        );
        assert!(matches!(plan, RequestPlan::Respond(Err(_), _)));
        let plan = handle_request(
            &ops,
            "s1",
            dir.path(),
            &events,
            "terminal/release",
            &serde_json::json!({"terminalId": terminal_id}),
        );
        assert!(matches!(plan, RequestPlan::Respond(Ok(_), _)));
        assert!(ops.terminals.lock().unwrap().is_empty());
    }
}
