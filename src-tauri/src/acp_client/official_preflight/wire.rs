//! Only the official preparation requests for a new, unsent temporary thread.
use super::super::extension_inventory::{Code, Result, output, process::FixedExchange};
use super::Receipt;
use serde::{
    Deserialize, Deserializer,
    de::{IgnoredAny, MapAccess, Visitor, value::MapAccessDeserializer},
};
use serde_json::{Value, json};
use std::{fmt, io, marker::PhantomData, path::Path};

#[derive(Deserialize)]
struct Header<'a> {
    #[serde(default, deserialize_with = "non_null")]
    id: Option<u64>,
    #[serde(borrow, default, deserialize_with = "non_null")]
    method: Option<&'a str>,
    #[serde(default, deserialize_with = "non_null")]
    result: Option<IgnoredAny>,
    #[serde(default, deserialize_with = "non_null")]
    error: Option<RpcError>,
}

#[derive(Deserialize)]
struct RpcError {
    code: i64,
}

#[derive(Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct Reply<T> {
    #[serde(deserialize_with = "object")]
    result: T,
}

fn non_null<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

// serde also accepts positional arrays for structs. These wire objects have named fields.
fn object<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<T, D::Error> {
    struct Named<T>(PhantomData<T>);
    impl<'de, T: Deserialize<'de>> Visitor<'de> for Named<T> {
        type Value = T;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a JSON object")
        }
        fn visit_map<A: MapAccess<'de>>(self, map: A) -> std::result::Result<T, A::Error> {
            T::deserialize(MapAccessDeserializer::new(map))
        }
    }
    d.deserialize_map(Named(PhantomData))
}

fn objects<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Vec<T>, D::Error> {
    #[derive(Deserialize)]
    #[serde(bound(deserialize = "T: Deserialize<'de>"))]
    struct Entry<T>(#[serde(deserialize_with = "object")] T);
    Ok(Vec::<Entry<T>>::deserialize(d)?
        .into_iter()
        .map(|entry| entry.0)
        .collect())
}

#[derive(Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct Event<T> {
    #[serde(deserialize_with = "object")]
    params: T,
}

#[derive(Deserialize)]
struct Started {
    #[serde(deserialize_with = "object")]
    thread: Thread,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadEvent {
    thread_id: String,
    status: Option<Status>,
}

#[derive(Deserialize)]
struct Status {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Initialize {
    user_agent: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Accounts {
    active_session_id: Option<String>,
    #[serde(deserialize_with = "objects")]
    sessions: Vec<Account>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    session_id: String,
    is_active: bool,
    email: Option<String>,
    user_id: Option<String>,
    selected_workspace_account_id: Option<String>,
    #[serde(deserialize_with = "objects")]
    workspaces: Vec<Workspace>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    account_id: String,
}

impl Accounts {
    fn check(&self) -> Result<()> {
        let Some(current) = self.active_session_id.as_deref().filter(|s| present(s)) else {
            return Err(Code::Unavailable.into());
        };
        let mut matching = self
            .sessions
            .iter()
            .filter(|s| s.session_id == current || s.is_active);
        let Some(active) = matching.next() else {
            return Err(Code::Unavailable.into());
        };
        if matching.next().is_some() || !active.is_active || active.session_id != current {
            return Err(Code::InvalidOutput.into());
        }
        let Some(selected) = active
            .selected_workspace_account_id
            .as_deref()
            .filter(|s| present(s))
        else {
            return Err(Code::Unavailable.into());
        };
        if !active.user_id.as_deref().is_some_and(present)
            || !active.email.as_deref().is_some_and(present)
        {
            return Err(Code::Unavailable.into());
        }
        // The cached inventory may be empty with refreshWorkspaceMetadata=false.
        if !active.workspaces.is_empty()
            && active
                .workspaces
                .iter()
                .filter(|w| w.account_id == selected)
                .count()
                != 1
        {
            return Err(Code::InvalidOutput.into());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadStart {
    model: String,
    model_provider: String,
    reasoning_effort: String,
    approval_policy: String,
    approvals_reviewer: String,
    cwd: String,
    #[serde(default)]
    runtime_workspace_roots: Vec<String>,
    #[serde(deserialize_with = "object")]
    sandbox: Sandbox,
    #[serde(deserialize_with = "object")]
    thread: Thread,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sandbox {
    #[serde(rename = "type")]
    kind: String,
    network_access: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadWarning {
    thread_id: String,
    #[serde(rename = "message")]
    _message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolStartup {
    thread_id: String,
    #[serde(rename = "name")]
    _name: String,
    status: ToolStartupState,
    #[serde(rename = "environmentId")]
    _environment_id: Option<String>,
    #[serde(rename = "error")]
    _error: Option<String>,
    #[serde(rename = "failureReason")]
    _failure_reason: Option<String>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum ToolStartupState {
    Starting,
    Failed,
    Cancelled,
    Ready,
}

#[derive(Deserialize)]
struct Thread {
    id: String,
    ephemeral: bool,
    // Explicit null (no saved path) and an explicitly empty list of turns.
    #[serde(deserialize_with = "Deserialize::deserialize")]
    path: (),
    turns: [IgnoredAny; 0],
    cwd: String,
}

fn present(s: &str) -> bool {
    !s.trim().is_empty() && !s.chars().any(char::is_control)
}

#[derive(Clone, Copy, PartialEq)]
enum Step {
    Initialize = 1,
    Accounts,
    Thread,
    Done,
}

pub(super) struct Exchange {
    step: Step,
    cwd: String,
    model: String,
    effort: String,
    pending: Vec<u8>,
    written: usize,
    thread_id: Option<String>,
}

impl Exchange {
    pub(super) fn new(cwd: &str, model: &str, effort: &str) -> Result<Self> {
        if !Path::new(cwd).is_absolute()
            || !present(cwd)
            || cwd.len() > 4096
            || !present(model)
            || model.trim() != model
            || model.len() > 256
            || !present(effort)
            || effort.trim() != effort
            || effort.len() > 64
        {
            return Err(Code::InvalidRequest.into());
        }
        let mut this = Self {
            step: Step::Initialize,
            cwd: cwd.into(),
            model: model.into(),
            effort: effort.into(),
            pending: vec![],
            written: 0,
            thread_id: None,
        };
        this.queue(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "clientInfo":{"name":"farfold_preparation","title":"Farfold","version":env!("CARGO_PKG_VERSION")},
            "capabilities":{"experimentalApi":true}}}))?;
        Ok(this)
    }

    fn queue(&mut self, message: Value) -> Result<()> {
        serde_json::to_writer(&mut self.pending, &message).map_err(|_| Code::InvalidRequest)?;
        self.pending.push(b'\n');
        Ok(())
    }

    fn check_thread(&mut self, thread: Thread) -> Result<()> {
        let Thread {
            id,
            ephemeral,
            path: (),
            turns: [],
            cwd,
        } = thread;
        if !ephemeral
            || cwd != self.cwd
            || !present(&id)
            || self
                .thread_id
                .as_ref()
                .is_some_and(|expected| expected != &id)
        {
            return Err(Code::InvalidOutput.into());
        }
        self.thread_id = Some(id);
        Ok(())
    }

    fn frame(&mut self, line: &[u8]) -> Result<()> {
        if !line.trim_ascii_start().starts_with(b"{") || !output::bounded_depth(line) {
            return Err(Code::InvalidOutput.into());
        }
        let header: Header<'_> = serde_json::from_slice(line).map_err(|_| Code::InvalidOutput)?;
        if let Some(method) = header.method {
            if header.id.is_some() || header.result.is_some() || header.error.is_some() {
                return Err(Code::InvalidOutput.into());
            }
            return match method {
                "configWarning" | "remoteControl/status/changed" => Ok(()),
                "account/updated" | "account/rateLimits/updated"
                    if matches!(self.step, Step::Initialize | Step::Accounts) =>
                {
                    Ok(())
                }
                "thread/started"
                    if matches!(self.step, Step::Thread | Step::Done)
                        && self.written == self.pending.len() =>
                {
                    let event: Event<Started> =
                        serde_json::from_slice(line).map_err(|_| Code::InvalidOutput)?;
                    self.check_thread(event.params.thread)
                }
                "thread/status/changed" | "thread/closed" if self.step == Step::Done => {
                    let event: Event<ThreadEvent> =
                        serde_json::from_slice(line).map_err(|_| Code::InvalidOutput)?;
                    if self.thread_id.as_ref() != Some(&event.params.thread_id) {
                        return Err(Code::InvalidOutput.into());
                    }
                    match (method, event.params.status) {
                        ("thread/closed", None) => Ok(()),
                        ("thread/status/changed", Some(status))
                            if matches!(status.kind.as_str(), "idle" | "notLoaded") =>
                        {
                            Ok(())
                        }
                        _ => Err(Code::InvalidOutput.into()),
                    }
                }
                "warning" if self.step == Step::Done => {
                    // The official server can emit an informational warning
                    // after its exact thread receipt. Never surface its text.
                    let event: Event<ThreadWarning> =
                        serde_json::from_slice(line).map_err(|_| Code::InvalidOutput)?;
                    if self.thread_id.as_ref() == Some(&event.params.thread_id) {
                        Ok(())
                    } else {
                        Err(Code::InvalidOutput.into())
                    }
                }
                "mcpServer/startupStatus/updated" if self.step == Step::Done => {
                    let event: Event<ToolStartup> =
                        serde_json::from_slice(line).map_err(|_| Code::InvalidOutput)?;
                    if self.thread_id.as_ref() != Some(&event.params.thread_id) {
                        return Err(Code::InvalidOutput.into());
                    }
                    // The offline worker blocks launch and network. Accept its
                    // passive status notifications while withholding a receipt
                    // if a tool connection actually reaches readiness.
                    if event.params.status == ToolStartupState::Ready {
                        Err(Code::Unavailable.into())
                    } else {
                        Ok(())
                    }
                }
                _ => Err(Code::InvalidOutput.into()),
            };
        }
        if self.step == Step::Done
            || self.written != self.pending.len()
            || header.id != Some(self.step as u64)
        {
            return Err(Code::InvalidOutput.into());
        }
        if let Some(error) = header.error {
            if header.result.is_some() {
                return Err(Code::InvalidOutput.into());
            }
            return Err(if self.step == Step::Accounts && error.code == -32601 {
                Code::Unavailable
            } else {
                Code::QueryFailed
            }
            .into());
        }
        if header.result.is_none() {
            return Err(Code::InvalidOutput.into());
        }
        self.pending.clear();
        self.written = 0;
        match self.step {
            Step::Initialize => {
                let reply: Reply<Initialize> =
                    serde_json::from_slice(line).map_err(|_| Code::InvalidOutput)?;
                if !present(&reply.result.user_agent) {
                    return Err(Code::InvalidOutput.into());
                }
                self.step = Step::Accounts;
                self.queue(json!({"jsonrpc":"2.0","method":"initialized","params":{}}))?;
                self.queue(json!({"jsonrpc":"2.0","id":2,"method":"accountSession/list","params":{"refreshWorkspaceMetadata":false}}))
            }
            Step::Accounts => {
                let reply: Reply<Accounts> =
                    serde_json::from_slice(line).map_err(|_| Code::InvalidOutput)?;
                reply.result.check()?;
                self.step = Step::Thread;
                self.queue(json!({"jsonrpc":"2.0","id":3,"method":"thread/start","params":{
                    "model":self.model,"modelProvider":"openai","cwd":self.cwd,
                    "sandbox":"read-only","approvalPolicy":"on-request","approvalsReviewer":"user","ephemeral":true,
                    "config":{"model_reasoning_effort":self.effort,"web_search":"disabled"}}}))
            }
            Step::Thread => {
                let Reply { result: r }: Reply<ThreadStart> =
                    serde_json::from_slice(line).map_err(|_| Code::InvalidOutput)?;
                if r.model != self.model
                    || r.model_provider != "openai"
                    || r.reasoning_effort != self.effort
                    || r.cwd != self.cwd
                    || r.runtime_workspace_roots
                        .iter()
                        .any(|path| path != &self.cwd)
                    || r.sandbox.kind != "readOnly"
                    || r.sandbox.network_access
                    || r.approval_policy != "on-request"
                    || r.approvals_reviewer != "user"
                {
                    return Err(Code::InvalidOutput.into());
                }
                self.check_thread(r.thread)?;
                self.step = Step::Done;
                Ok(())
            }
            Step::Done => Err(Code::InvalidOutput.into()),
        }
    }

    pub(super) fn finish(self, bytes: &[u8]) -> Result<Receipt> {
        if self.step != Step::Done || !bytes.iter().all(u8::is_ascii_whitespace) {
            return Err(Code::InvalidOutput.into());
        }
        Ok(Receipt {
            account_present: true,
            workspace_reported: true,
            model: self.model,
            reasoning_effort: self.effort,
            provider: "openai".into(),
        })
    }
}

impl FixedExchange for Exchange {
    fn write(&mut self, writer: &mut dyn io::Write) -> Result<()> {
        if self.written == self.pending.len() {
            return Ok(());
        }
        match writer.write(&self.pending[self.written..]) {
            Ok(0) => Err(Code::QueryFailed.into()),
            Ok(n) => {
                self.written += n;
                Ok(())
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                Ok(())
            }
            Err(_) => Err(Code::QueryFailed.into()),
        }
    }

    fn received(&mut self, bytes: &mut Vec<u8>) -> Result<()> {
        let mut start = 0;
        while let Some(end) = bytes[start..].iter().position(|&b| b == b'\n') {
            let next = start + end + 1;
            let result = self.frame(&bytes[start..next - 1]);
            bytes[start..next].fill(0);
            result?;
            start = next;
        }
        bytes.drain(..start);
        Ok(())
    }

    fn done(&self) -> bool {
        self.step == Step::Done
    }
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
