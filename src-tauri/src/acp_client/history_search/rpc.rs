//! One fixed metadata/read-pages exchange. Never resumes or configures a thread.
use super::{requests::Job, text, types::*};
use crate::acp_client::extension_inventory as inventory;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    io::{self, Write},
};
#[derive(Clone, Copy)]
enum Step {
    Initialize,
    Metadata,
    Page,
    Done,
}
pub(super) struct Read {
    hits: Vec<Hit>,
    state: RowState,
    code: Option<Code>,
    error: Option<Code>,
}
impl Read {
    pub fn publish(self, job: &Job, index: usize) -> Result<()> {
        let mut accepted = false;
        job.update(|v| {
            // Serialize cancellation and publication with the same operation lock.
            if !job.operation.interested() {
                return;
            }
            v.hits.extend(self.hits);
            v.rows[index].state = self.state;
            v.rows[index].code = self.code;
            accepted = true;
        });
        if !accepted {
            return Err(Code::Cancelled.into());
        }
        self.error.map_or(Ok(()), |code| Err(code.into()))
    }
}
pub(super) struct Exchange<'a> {
    job: &'a Job,
    index: usize,
    step: Step,
    id: u64,
    pending: Vec<u8>,
    sent: usize,
    cursors: HashSet<String>,
    turns: HashSet<String>,
    error: Option<Code>,
    hits: Vec<Hit>,
    row_state: RowState,
    row_code: Option<Code>,
}
impl<'a> Exchange<'a> {
    pub fn new(job: &'a Job, index: usize) -> Self {
        let mut value = Self {
            job,
            index,
            step: Step::Initialize,
            id: 1,
            pending: vec![],
            sent: 0,
            cursors: HashSet::new(),
            turns: HashSet::new(),
            error: None,
            hits: vec![],
            row_state: RowState::Reading,
            row_code: None,
        };
        value.send("initialize",json!({"clientInfo":{"name":"farfold_history_search","title":"Farfold","version":env!("CARGO_PKG_VERSION")}}));
        value
    }
    fn send(&mut self, method: &str, params: Value) {
        self.pending = serde_json::to_vec(&json!({"id":self.id,"method":method,"params":params}))
            .expect("fixed typed JSON");
        self.pending.push(b'\n');
        self.sent = 0;
    }
    fn row_id(&self) -> &str {
        &self.job.source.rows[self.index].id
    }
    fn native_id(&self) -> &str {
        self.job.source.rows[self.index]
            .native_session_id
            .as_deref()
            .unwrap_or_default()
    }
    fn finish_row(&mut self, state: RowState, code: Option<Code>) {
        self.row_state = state;
        self.row_code = code;
        self.step = Step::Done;
    }
    fn page(&mut self, cursor: Option<String>) {
        self.id += 1;
        self.step = Step::Page;
        self.send("thread/turns/list",json!({"threadId":self.native_id(),"cursor":cursor,"limit":10,"sortDirection":"asc","itemsView":"full"}));
    }
    fn accept(&mut self, value: Value) -> Result<()> {
        let obj = value.as_object().ok_or(Code::InvalidOutput)?;
        if obj.contains_key("method") {
            if obj
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(|v| !v.is_empty())
                && !obj.contains_key("id")
                && !obj.contains_key("result")
                && !obj.contains_key("error")
            {
                return Ok(());
            }
            return Err(Code::InvalidOutput.into());
        }
        if self.sent != self.pending.len()
            || obj.get("id").and_then(Value::as_u64) != Some(self.id)
            || matches!(self.step, Step::Done)
        {
            return Err(Code::InvalidOutput.into());
        }
        if let Some(error) = obj.get("error") {
            if obj.contains_key("result")
                || error.get("code").and_then(Value::as_i64).is_none()
                || error.get("message").and_then(Value::as_str).is_none()
            {
                return Err(Code::InvalidOutput.into());
            }
            self.error = Some(if error["code"] == -32601 {
                Code::Unsupported
            } else {
                Code::QueryFailed
            });
            self.step = Step::Done;
            return Ok(());
        }
        let result = obj.get("result").ok_or(Code::InvalidOutput)?;
        match self.step {
            Step::Initialize => {
                if !result
                    .get("userAgent")
                    .and_then(Value::as_str)
                    .is_some_and(identifier)
                {
                    return Err(Code::InvalidOutput.into());
                }
                self.id += 1;
                self.step = Step::Metadata;
                self.send(
                    "thread/read",
                    json!({"threadId":self.native_id(),"includeTurns":false}),
                );
                let mut pending = b"{\"method\":\"initialized\"}\n".to_vec();
                pending.append(&mut self.pending);
                self.pending = pending;
            }
            Step::Metadata => {
                let thread = result.get("thread").ok_or(Code::InvalidOutput)?;
                if thread.get("id").and_then(Value::as_str) != Some(self.native_id())
                    || thread.get("cwd").and_then(Value::as_str)
                        != Some(self.job.source.rows[self.index].cwd.as_str())
                {
                    return Err(Code::IndexChanged.into());
                }
                self.page(None);
            }
            Step::Page => self.read_page(result)?,
            Step::Done => return Err(Code::InvalidOutput.into()),
        }
        Ok(())
    }
    fn read_page(&mut self, result: &Value) -> Result<()> {
        self.job.within()?;
        let data = result
            .get("data")
            .and_then(Value::as_array)
            .filter(|v| v.len() <= 10)
            .ok_or(Code::InvalidOutput)?;
        let cursor = match result.get("nextCursor") {
            Some(Value::Null) => None,
            Some(Value::String(v)) if identifier(v) => Some(v.clone()),
            _ => return Err(Code::InvalidOutput.into()),
        };
        if let Some(cursor) = &cursor
            && !self.cursors.insert(cursor.clone())
        {
            return Err(Code::InvalidOutput.into());
        }
        let mut blocks = 0;
        let mut hits = vec![];
        for turn in data {
            let tid = turn
                .get("id")
                .and_then(Value::as_str)
                .filter(|v| identifier(v))
                .ok_or(Code::InvalidOutput)?;
            if !self.turns.insert(tid.into()) {
                return Err(Code::InvalidOutput.into());
            }
            // Official omitted itemsView defaults to Full, explicit summary is incomplete.
            if turn.get("itemsView").is_some_and(|v| v != "full") {
                return Err(Code::Unsupported.into());
            }
            let items = turn
                .get("items")
                .and_then(Value::as_array)
                .ok_or(Code::InvalidOutput)?;
            let mut ids = HashSet::new();
            for item in items {
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|v| identifier(v))
                    .ok_or(Code::InvalidOutput)?;
                if !ids.insert(id) {
                    return Err(Code::InvalidOutput.into());
                }
                let kind = item
                    .get("type")
                    .and_then(Value::as_str)
                    .ok_or(Code::InvalidOutput)?;
                let parts: Vec<(usize, &str)> = match kind {
                    "agentMessage" => vec![(
                        0,
                        item.get("text")
                            .and_then(Value::as_str)
                            .ok_or(Code::InvalidOutput)?,
                    )],
                    "userMessage" => {
                        let content = item
                            .get("content")
                            .and_then(Value::as_array)
                            .ok_or(Code::InvalidOutput)?;
                        let mut values = vec![];
                        for (i, p) in content.iter().enumerate() {
                            if p.get("type").and_then(Value::as_str) == Some("text") {
                                values.push((
                                    i,
                                    p.get("text")
                                        .and_then(Value::as_str)
                                        .ok_or(Code::InvalidOutput)?,
                                ));
                            }
                        }
                        values
                    }
                    _ => vec![],
                };
                for (part_index, part) in parts {
                    self.job.within()?;
                    if part.len() > 1048576 {
                        return Err(Code::OutputLimit.into());
                    }
                    blocks += 1;
                    if let Some(found) = text::find(part, &self.job.request.query) {
                        hits.push(Hit {
                            row_id: self.row_id().into(),
                            turn_id: tid.into(),
                            item_id: id.into(),
                            part_index,
                            role: if kind == "userMessage" {
                                "user"
                            } else {
                                "assistant"
                            },
                            text: found.text,
                            text_truncated: found.text_truncated,
                            matches: found.ranges,
                            matches_truncated: found.ranges_truncated,
                        });
                    }
                }
            }
        }
        let remaining = 200usize.saturating_sub(self.job.snapshot().hits.len() + self.hits.len());
        let limited = hits.len() > remaining;
        let matched = hits.len();
        hits.truncate(remaining);
        self.job.update(|v| {
            let row = &mut v.rows[self.index];
            row.pages_read += 1;
            row.text_blocks_read += blocks;
            row.matched_text_blocks += matched;
        });
        self.hits.extend(hits);
        if limited {
            self.finish_row(RowState::Partial, Some(Code::ResultLimit));
            return Ok(());
        }
        if let Some(cursor) = cursor {
            if self.job.snapshot().rows[self.index].pages_read >= 20 {
                self.finish_row(RowState::Partial, Some(Code::ResultLimit));
            } else {
                self.page(Some(cursor));
            }
        } else {
            self.finish_row(RowState::Complete, None);
        }
        Ok(())
    }
    pub fn finish(self, remaining: &[u8], failure: Option<Failure>) -> Read {
        let error = self.error.or(failure.map(|v| v.code)).or_else(|| {
            (!remaining.iter().all(u8::is_ascii_whitespace) || !matches!(self.step, Step::Done))
                .then_some(Code::InvalidOutput)
        });
        Read {
            hits: self.hits,
            state: if error.is_some() {
                if self.job.snapshot().rows[self.index].pages_read > 0 {
                    RowState::Partial
                } else {
                    RowState::Failed
                }
            } else {
                self.row_state
            },
            code: error.or(self.row_code),
            error,
        }
    }
}
impl inventory::process::FixedExchange for Exchange<'_> {
    fn write(&mut self, writer: &mut std::process::ChildStdin) -> inventory::Result<()> {
        if self.sent == self.pending.len() {
            return Ok(());
        }
        match writer.write(&self.pending[self.sent..]) {
            Ok(0) => Err(inventory::Code::QueryFailed.into()),
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
            Err(_) => Err(inventory::Code::QueryFailed.into()),
        }
    }
    fn received(&mut self, bytes: &mut Vec<u8>) -> inventory::Result<()> {
        while let Some(end) = bytes.iter().position(|b| *b == b'\n') {
            if !inventory::output::bounded_depth(&bytes[..end]) {
                return Err(inventory::Code::InvalidOutput.into());
            }
            let value = serde_json::from_slice(&bytes[..end])
                .map_err(|_| inventory::Code::InvalidOutput)?;
            if let Err(error) = self.accept(value) {
                self.error = Some(error.code);
                return Err(inventory::Code::InvalidOutput.into());
            }
            bytes[..=end].fill(0);
            bytes.drain(..=end);
        }
        Ok(())
    }
    fn done(&self) -> bool {
        matches!(self.step, Step::Done)
    }
}
