//! Fixed read-only JSONL exchange, not a general RPC or conversation client.
use super::{output, skills_output, types::*};
use serde::Deserialize;
use std::io::{self, Write};

#[derive(Deserialize)]
struct Envelope {
    id: Option<u64>,
    method: Option<String>,
    result: Option<Payload>,
    error: Option<RpcError>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Payload {
    Initialize(Initialize),
    Skills(skills_output::Wire),
    // Empty structs may deserialize from []; a map-only variant plus an empty
    // entry check is required for the official exact {} acknowledgement.
    Empty(std::collections::BTreeMap<String, serde::de::IgnoredAny>),
}
#[derive(Deserialize)]
struct RpcError {
    code: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Initialize {
    user_agent: String,
}
#[derive(PartialEq)]
enum Step {
    Initialize,
    ExtraRoots,
    Skills,
    Done,
}
pub(super) struct Exchange {
    step: Step,
    cwd: String,
    extra_roots: Vec<String>,
    pending: Vec<u8>,
    sent: usize,
    result: Option<SkillsInventory>,
    targets: Vec<super::targets::SkillTarget>,
}
impl Exchange {
    #[cfg(test)]
    pub(super) fn new(cwd: &str) -> Result<Self> {
        Self::with_roots(cwd, &[])
    }
    pub(super) fn with_roots(cwd: &str, extra_roots: &[String]) -> Result<Self> {
        super::extra_skill_roots::validate(extra_roots, Kind::Skills)?;
        let pending = serde_json::to_vec(&serde_json::json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"farfold_extension_inventory","title":"Farfold","version":env!("CARGO_PKG_VERSION")}}})).map_err(|_| Code::InvalidRequest)?;
        let mut this = Self {
            step: Step::Initialize,
            cwd: cwd.into(),
            extra_roots: extra_roots.to_vec(),
            pending,
            sent: 0,
            result: None,
            targets: vec![],
        };
        this.pending.push(b'\n');
        Ok(this)
    }
    pub(super) fn write(&mut self, writer: &mut impl Write) -> Result<()> {
        if self.sent == self.pending.len() {
            return Ok(());
        }
        match writer.write(&self.pending[self.sent..]) {
            Ok(0) => Err(Code::QueryFailed.into()),
            Ok(n) => {
                self.sent += n;
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
    pub(super) fn received(&mut self, bytes: &mut Vec<u8>) -> Result<()> {
        while let Some(end) = bytes.iter().position(|b| *b == b'\n') {
            let line = &bytes[..end];
            if !output::bounded_depth(line) {
                return Err(Code::InvalidOutput.into());
            }
            let envelope: Envelope =
                serde_json::from_slice(line).map_err(|_| Code::InvalidOutput)?;
            self.accept(envelope)?;
            bytes[..=end].fill(0);
            bytes.drain(..=end);
        }
        Ok(())
    }
    fn accept(&mut self, envelope: Envelope) -> Result<()> {
        let Envelope {
            id,
            method,
            result,
            error,
        } = envelope;
        // Notifications may interleave, but no unsolicited server request is authorized.
        if let Some(method) = method {
            if id.is_none() && result.is_none() && error.is_none() && !method.is_empty() {
                return Ok(());
            }
            return Err(Code::InvalidOutput.into());
        }
        if self.sent != self.pending.len() {
            return Err(Code::InvalidOutput.into());
        }
        let expected = match self.step {
            Step::Initialize => 1,
            Step::ExtraRoots => 2,
            Step::Skills => {
                if self.extra_roots.is_empty() {
                    2
                } else {
                    3
                }
            }
            Step::Done => return Err(Code::InvalidOutput.into()),
        };
        if id != Some(expected) {
            return Err(Code::InvalidOutput.into());
        }
        if let Some(error) = error {
            return Err(if result.is_none() {
                if self.step == Step::ExtraRoots && error.code == Some(-32601) {
                    Code::Unavailable
                } else {
                    Code::QueryFailed
                }
            } else {
                Code::InvalidOutput
            }
            .into());
        }
        match (&self.step, result) {
            (Step::Initialize, Some(Payload::Initialize(value)))
                if !value.user_agent.is_empty() && value.user_agent.len() <= 4096 =>
            {
                self.pending = b"{\"method\":\"initialized\"}\n".to_vec();
                let next = if self.extra_roots.is_empty() {
                    self.step = Step::Skills;
                    self.list(2)
                } else {
                    self.step = Step::ExtraRoots;
                    serde_json::json!({"id":2,"method":"skills/extraRoots/set","params":{"extraRoots":self.extra_roots}})
                };
                self.pending
                    .extend(serde_json::to_vec(&next).map_err(|_| Code::InvalidRequest)?);
                self.pending.push(b'\n');
                self.sent = 0;
                Ok(())
            }
            (Step::ExtraRoots, Some(Payload::Empty(value))) if value.is_empty() => {
                self.pending =
                    serde_json::to_vec(&self.list(3)).map_err(|_| Code::InvalidRequest)?;
                self.pending.push(b'\n');
                self.sent = 0;
                self.step = Step::Skills;
                Ok(())
            }
            (Step::Skills, Some(Payload::Skills(value))) => {
                let (public, targets) = if self.extra_roots.is_empty() {
                    value.project_private(&self.cwd)?
                } else {
                    value.project_for_scope(&self.cwd, true)?
                };
                self.result = Some(public);
                self.targets = targets;
                self.step = Step::Done;
                Ok(())
            }
            _ => Err(Code::InvalidOutput.into()),
        }
    }
    fn list(&self, id: u64) -> serde_json::Value {
        serde_json::json!({"id":id,"method":"skills/list","params":{"cwds":[self.cwd],"forceReload":true}})
    }
    pub(super) fn take_targets(&mut self) -> Vec<super::targets::SkillTarget> {
        std::mem::take(&mut self.targets)
    }
    pub(super) fn done(&self) -> bool {
        self.step == Step::Done
    }
    pub(super) fn finish(self, bytes: &[u8]) -> Result<SkillsInventory> {
        if !bytes.iter().all(u8::is_ascii_whitespace) {
            return Err(Code::InvalidOutput.into());
        }
        self.result.ok_or_else(|| Code::InvalidOutput.into())
    }
}
