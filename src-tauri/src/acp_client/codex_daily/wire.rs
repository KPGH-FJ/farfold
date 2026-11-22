//! Fixed, bounded App Server exchange for an owned, unsent Codex thread.
use super::super::extension_inventory::{Code, Result, output, process::FixedExchange};
use serde::{
    Deserialize, Deserializer,
    de::{IgnoredAny, MapAccess, Visitor, value::MapAccessDeserializer},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fmt::{self, Write as _},
    io,
    marker::PhantomData,
    path::{Component, Path, PathBuf},
};

const PROVIDER: &str = "openai";

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

#[derive(Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct Event<T> {
    #[serde(deserialize_with = "object")]
    params: T,
}

fn non_null<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

// Serde accepts positional arrays for structs; this protocol has named objects.
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

fn read<'de, T: Deserialize<'de>>(line: &'de [u8]) -> Result<T> {
    serde_json::from_slice(line).map_err(|_| Code::InvalidOutput.into())
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
    fn identity(&self) -> Result<AccountIdentity> {
        let current = self
            .active_session_id
            .as_deref()
            .filter(|value| selection(value, 256))
            .ok_or(Code::Unavailable)?;
        let mut active = self
            .sessions
            .iter()
            .filter(|session| session.session_id == current || session.is_active);
        let one = active.next().ok_or(Code::Unavailable)?;
        if !one.is_active || one.session_id != current || active.next().is_some() {
            return Err(Code::InvalidOutput.into());
        }
        let user = one
            .user_id
            .as_deref()
            .filter(|value| selection(value, 256))
            .ok_or(Code::Unavailable)?;
        let workspace = one
            .selected_workspace_account_id
            .as_deref()
            .filter(|value| selection(value, 256))
            .ok_or(Code::Unavailable)?;
        // Offline cached workspaces may be empty. A nonempty inventory must
        // independently identify the workspace reported by the active account.
        if !one.workspaces.is_empty()
            && one
                .workspaces
                .iter()
                .filter(|entry| entry.account_id == workspace)
                .count()
                != 1
        {
            return Err(Code::InvalidOutput.into());
        }
        Ok(AccountIdentity {
            user_id: user.into(),
            workspace_id: workspace.into(),
        })
    }
}

/// Values are read from the vendor's cached account response and kept in this
/// process. A separately signed-in profile can have a different login ID.
#[derive(PartialEq, Eq)]
pub(super) struct AccountIdentity {
    user_id: String,
    workspace_id: String,
}

impl AccountIdentity {
    pub(super) fn fingerprint(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(b"Farfold Codex App Server ChatGPT account\0");
        for value in [&self.user_id, &self.workspace_id] {
            digest.update((value.len() as u64).to_be_bytes());
            digest.update(value.as_bytes());
        }
        let mut fingerprint = String::with_capacity(64);
        for byte in digest.finalize() {
            let _ = write!(fingerprint, "{byte:02x}");
        }
        fingerprint
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadResult {
    #[serde(deserialize_with = "object")]
    thread: Thread,
    #[serde(default)]
    runtime_workspace_roots: Vec<String>,
    #[serde(flatten)]
    settings: Settings,
}

#[derive(Deserialize)]
struct ThreadMetadata {
    #[serde(deserialize_with = "object")]
    thread: Thread,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    model: String,
    model_provider: String,
    reasoning_effort: String,
    approval_policy: String,
    approvals_reviewer: String,
    cwd: String,
    #[serde(deserialize_with = "object")]
    sandbox: Sandbox,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sandbox {
    #[serde(rename = "type")]
    kind: String,
    network_access: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    id: String,
    session_id: String,
    cwd: String,
    ephemeral: bool,
    name: Option<String>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    path: Option<PathBuf>,
    turns: [IgnoredAny; 0],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Related {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadStatus {
    thread_id: String,
    #[serde(deserialize_with = "object")]
    status: Status,
}

#[derive(Deserialize)]
struct Status {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleChanged {
    thread_id: String,
    thread_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolStartup {
    thread_id: String,
    status: ToolStartupState,
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
#[serde(deny_unknown_fields)]
struct Empty {}

fn selection(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn valid_thread_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                lower_hex(byte)
            }
        })
}

fn valid_path(path: &Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::RootDir | Component::Normal(_)))
}

enum Operation {
    Account,
    Start {
        title: String,
        account_sha256: String,
    },
    Resume {
        account_sha256: String,
    },
}

impl Operation {
    fn expected_account(&self) -> Option<&str> {
        match self {
            Self::Start { account_sha256, .. } | Self::Resume { account_sha256 } => {
                Some(account_sha256)
            }
            Self::Account => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, PartialOrd)]
enum Step {
    Initialize = 1,
    Accounts,
    Open,
    Persist,
    ReadPersisted,
    VerifyAccount,
    Done,
}

pub(super) struct Receipt {
    pub(super) thread_id: String,
    pub(super) account_sha256: String,
    pub(super) cwd: String,
    pub(super) model: String,
    pub(super) effort: String,
    pub(super) provider: &'static str,
    pub(super) path: Option<PathBuf>,
}

pub(super) struct Exchange {
    operation: Operation,
    step: Step,
    cwd: String,
    model: String,
    effort: String,
    history_root: PathBuf,
    thread_id: Option<String>,
    path: Option<PathBuf>,
    account: Option<AccountIdentity>,
    pending: Vec<u8>,
    written: usize,
}

impl Exchange {
    #[cfg(target_os = "macos")]
    pub(super) fn stage(&self) -> &'static str {
        match self.step {
            Step::Initialize => "initialize",
            Step::Accounts => "account",
            Step::Open => "open",
            Step::Persist => "name",
            Step::ReadPersisted => "read",
            Step::VerifyAccount => "verify_account",
            Step::Done => "close",
        }
    }
    pub(super) fn account() -> Result<Self> {
        Self::new(Operation::Account, None, "", "", "", Path::new(""))
    }

    pub(super) fn start(
        cwd: &str,
        model: &str,
        effort: &str,
        title: &str,
        expected_account: &AccountIdentity,
        history_root: &Path,
    ) -> Result<Self> {
        if !selection(title, 120) {
            return Err(Code::InvalidRequest.into());
        }
        Self::new(
            Operation::Start {
                title: title.into(),
                account_sha256: expected_account.fingerprint(),
            },
            None,
            cwd,
            model,
            effort,
            history_root,
        )
    }

    pub(super) fn resume(
        cwd: &str,
        model: &str,
        effort: &str,
        id: &str,
        expected_account_sha256: &str,
        history_root: &Path,
    ) -> Result<Self> {
        if !valid_thread_id(id)
            || expected_account_sha256.len() != 64
            || !expected_account_sha256.bytes().all(lower_hex)
        {
            return Err(Code::InvalidRequest.into());
        }
        Self::new(
            Operation::Resume {
                account_sha256: expected_account_sha256.into(),
            },
            Some(id.into()),
            cwd,
            model,
            effort,
            history_root,
        )
    }

    fn new(
        operation: Operation,
        thread_id: Option<String>,
        cwd: &str,
        model: &str,
        effort: &str,
        history_root: &Path,
    ) -> Result<Self> {
        if !matches!(operation, Operation::Account)
            && (!valid_path(Path::new(cwd))
                || !valid_path(history_root)
                || history_root.parent().is_none()
                || !selection(cwd, 4096)
                || !selection(model, 256)
                || !selection(effort, 64))
        {
            return Err(Code::InvalidRequest.into());
        }
        let mut exchange = Self {
            operation,
            step: Step::Initialize,
            cwd: cwd.into(),
            model: model.into(),
            effort: effort.into(),
            history_root: history_root.into(),
            thread_id,
            path: None,
            account: None,
            pending: vec![],
            written: 0,
        };
        exchange.call(Step::Initialize, "initialize", json!({
            "clientInfo":{"name":"farfold_codex_daily","title":"Farfold","version":env!("CARGO_PKG_VERSION")},
            "capabilities":{"experimentalApi":true},
        }))?;
        Ok(exchange)
    }

    fn queue(&mut self, value: Value) -> Result<()> {
        serde_json::to_writer(&mut self.pending, &value).map_err(|_| Code::InvalidRequest)?;
        self.pending.push(b'\n');
        Ok(())
    }

    fn call(&mut self, step: Step, method: &str, params: Value) -> Result<()> {
        self.step = step;
        self.queue(json!({"jsonrpc":"2.0","id":step as u64,"method":method,"params":params}))
    }

    fn read_account(&mut self, step: Step) -> Result<()> {
        self.call(
            step,
            "accountSession/list",
            json!({"refreshWorkspaceMetadata":false}),
        )
    }

    fn open(&mut self) -> Result<()> {
        match self.operation {
            Operation::Start { .. } => self.call(
                Step::Open,
                "thread/start",
                json!({
                    "model":self.model,"modelProvider":PROVIDER,"cwd":self.cwd,
                    "sandbox":"read-only","approvalPolicy":"on-request",
                    "approvalsReviewer":"user","ephemeral":false,
                    "config":{"model_reasoning_effort":self.effort,"web_search":"disabled"},
                }),
            ),
            Operation::Resume { .. } => self.call(
                Step::Open,
                "thread/resume",
                // An unsent thread's saved metadata can contain no reasoning
                // effort. The server clears the process default on cold open
                // unless the resume request itself restates the saved choice.
                json!({
                    "threadId":self.thread_id,"excludeTurns":true,
                    "config":{"model_reasoning_effort":self.effort},
                }),
            ),
            Operation::Account => Err(Code::InvalidRequest.into()),
        }
    }

    fn bind_thread(&mut self, id: &str) -> Result<()> {
        if !valid_thread_id(id) {
            return Err(Code::InvalidOutput.into());
        }
        match &self.thread_id {
            Some(known) if known != id => Err(Code::InvalidOutput.into()),
            Some(_) => Ok(()),
            None => {
                self.thread_id = Some(id.into());
                Ok(())
            }
        }
    }

    fn thread(&mut self, thread: Thread, require_path: bool) -> Result<()> {
        let Thread {
            id,
            session_id,
            cwd,
            ephemeral,
            name,
            path,
            turns: [],
        } = thread;
        if id != session_id || cwd != self.cwd || ephemeral || (require_path && path.is_none()) {
            return Err(Code::InvalidOutput.into());
        }
        if self.step == Step::ReadPersisted
            && let Operation::Start { title, .. } = &self.operation
            && name.as_ref() != Some(title)
        {
            return Err(Code::InvalidOutput.into());
        }
        self.bind_thread(&id)?;
        if let Some(path) = path {
            if !valid_path(&path)
                || !path.starts_with(&self.history_root)
                || path == self.history_root
                || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
                || !path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .is_some_and(|stem| stem.starts_with("rollout-") && stem.ends_with(&id))
                || self.path.as_ref().is_some_and(|known| known != &path)
            {
                return Err(Code::InvalidOutput.into());
            }
            self.path = Some(path);
        }
        Ok(())
    }

    fn settings(&self, settings: &Settings) -> Result<()> {
        if settings.model != self.model
            || settings.model_provider != PROVIDER
            || settings.cwd != self.cwd
            || settings.sandbox.kind != "readOnly"
            || settings.sandbox.network_access
            || settings.approval_policy != "on-request"
            || settings.approvals_reviewer != "user"
            || settings.reasoning_effort != self.effort
        {
            return Err(Code::InvalidOutput.into());
        }
        Ok(())
    }

    fn accept_open(&mut self, result: ThreadResult) -> Result<()> {
        let resumed = matches!(self.operation, Operation::Resume { .. });
        self.thread(result.thread, resumed)?;
        if result
            .runtime_workspace_roots
            .iter()
            .any(|root| root != &self.cwd)
        {
            return Err(Code::InvalidOutput.into());
        }
        self.settings(&result.settings)?;
        match &self.operation {
            Operation::Start { title, .. } => self.call(
                Step::Persist,
                "thread/name/set",
                json!({"threadId":self.thread_id,"name":title}),
            ),
            _ => self.read_account(Step::VerifyAccount),
        }
    }

    fn notification(&mut self, method: &str, line: &[u8]) -> Result<()> {
        if matches!(method, "configWarning" | "remoteControl/status/changed") {
            return Ok(());
        }
        if self.step < Step::Open {
            return match method {
                "account/updated" | "account/rateLimits/updated" => Ok(()),
                _ => Err(Code::InvalidOutput.into()),
            };
        }
        match method {
            "thread/started" if self.step == Step::Open || self.thread_id.is_some() => {
                self.thread(read::<Event<ThreadMetadata>>(line)?.params.thread, false)
            }
            "thread/status/changed" => {
                let event = read::<Event<ThreadStatus>>(line)?.params;
                if !matches!(event.status.kind.as_str(), "idle" | "notLoaded") {
                    return Err(Code::InvalidOutput.into());
                }
                self.bind_thread(&event.thread_id)
            }
            "thread/closed" | "warning" | "thread/goal/cleared" => {
                self.bind_thread(&read::<Event<Related>>(line)?.params.thread_id)
            }
            "thread/name/updated" if self.step >= Step::Persist => {
                let Operation::Start { title, .. } = &self.operation else {
                    return Err(Code::InvalidOutput.into());
                };
                let event = read::<Event<TitleChanged>>(line)?.params;
                if event.thread_name.as_ref() != Some(title) {
                    return Err(Code::InvalidOutput.into());
                }
                self.bind_thread(&event.thread_id)
            }
            "mcpServer/startupStatus/updated" => {
                let event = read::<Event<ToolStartup>>(line)?.params;
                self.bind_thread(&event.thread_id)?;
                if event.status == ToolStartupState::Ready {
                    return Err(Code::Unavailable.into());
                }
                Ok(())
            }
            _ => Err(Code::InvalidOutput.into()),
        }
    }

    fn frame(&mut self, line: &[u8]) -> Result<()> {
        if !line.trim_ascii_start().starts_with(b"{") || !output::bounded_depth(line) {
            return Err(Code::InvalidOutput.into());
        }
        let header: Header<'_> = read(line)?;
        if let Some(method) = header.method {
            if header.id.is_some() || header.result.is_some() || header.error.is_some() {
                return Err(Code::InvalidOutput.into());
            }
            return self.notification(method, line);
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
            return Err(if error.code == -32601 {
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
                let reply: Reply<Initialize> = read(line)?;
                if !selection(&reply.result.user_agent, 1024) {
                    return Err(Code::InvalidOutput.into());
                }
                self.queue(json!({"jsonrpc":"2.0","method":"initialized","params":{}}))?;
                self.read_account(Step::Accounts)
            }
            Step::Accounts => {
                let account = read::<Reply<Accounts>>(line)?.result.identity()?;
                if self
                    .operation
                    .expected_account()
                    .is_some_and(|expected| expected != account.fingerprint())
                {
                    return Err(Code::SelectionChanged.into());
                }
                self.account = Some(account);
                if matches!(self.operation, Operation::Account) {
                    self.step = Step::Done;
                    return Ok(());
                }
                self.open()
            }
            Step::Open => self.accept_open(read::<Reply<ThreadResult>>(line)?.result),
            Step::Persist => {
                let _: Reply<Empty> = read(line)?;
                self.call(
                    Step::ReadPersisted,
                    "thread/read",
                    json!({"threadId":self.thread_id,"includeTurns":false}),
                )
            }
            Step::ReadPersisted => {
                self.thread(read::<Reply<ThreadMetadata>>(line)?.result.thread, true)?;
                self.read_account(Step::VerifyAccount)
            }
            Step::VerifyAccount => {
                let account = read::<Reply<Accounts>>(line)?.result.identity()?;
                if self.account.as_ref() != Some(&account) {
                    return Err(Code::SelectionChanged.into());
                }
                self.step = Step::Done;
                Ok(())
            }
            _ => Err(Code::InvalidOutput.into()),
        }
    }

    pub(super) fn finish(self, bytes: &[u8]) -> Result<Receipt> {
        if !self.complete(bytes) || matches!(self.operation, Operation::Account) {
            return Err(Code::InvalidOutput.into());
        }
        Ok(Receipt {
            thread_id: self.thread_id.ok_or(Code::InvalidOutput)?,
            account_sha256: self.account.ok_or(Code::InvalidOutput)?.fingerprint(),
            cwd: self.cwd,
            model: self.model,
            effort: self.effort,
            provider: PROVIDER,
            path: self.path,
        })
    }

    pub(super) fn finish_account(self, bytes: &[u8]) -> Result<AccountIdentity> {
        if !self.complete(bytes) || !matches!(self.operation, Operation::Account) {
            return Err(Code::InvalidOutput.into());
        }
        self.account.ok_or(Code::InvalidOutput.into())
    }

    fn complete(&self, bytes: &[u8]) -> bool {
        self.step == Step::Done && bytes.iter().all(u8::is_ascii_whitespace)
    }
}

impl FixedExchange for Exchange {
    fn write(&mut self, writer: &mut dyn io::Write) -> Result<()> {
        if self.written == self.pending.len() {
            return Ok(());
        }
        match writer.write(&self.pending[self.written..]) {
            Ok(0) => Err(Code::QueryFailed.into()),
            Ok(written) => {
                self.written += written;
                Ok(())
            }
            Err(error)
                if matches!(
                    error.kind(),
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
        while let Some(end) = bytes[start..].iter().position(|&byte| byte == b'\n') {
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
