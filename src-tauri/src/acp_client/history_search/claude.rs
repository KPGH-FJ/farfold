//! Fixed one-reply SDK exchange; text stays private until owned cleanup and source checks.
use super::{launch::Resolved, requests::Job, rpc::Read, text, types::*};
use crate::acp_client::extension_inventory as inventory;
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashSet,
    io::{self, Write},
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    kind: String,
    relation: String,
    coverage: String,
    continuation: String,
    branch: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Block {
    row_id: String,
    message_locator: MessageLocator,
    role: String,
    text: String,
    text_truncated: bool,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Output {
    #[serde(rename_all = "camelCase")]
    Projection {
        checked_official_source: Scope,
        coverage: String,
        code: String,
        limited: bool,
        blocks: Vec<Block>,
    },
    Error {
        code: Code,
    },
}
pub(super) struct Exchange<'a> {
    job: &'a Job,
    index: usize,
    pending: Vec<u8>,
    sent: usize,
    value: Option<Output>,
    error: Option<Code>,
}
impl<'a> Exchange<'a> {
    pub fn new(job: &'a Job, index: usize, resolved: &Resolved) -> Result<Self> {
        let row = &job.source.rows[index];
        let mut pending=serde_json::to_vec(&json!({"launch":{"node":resolved.node,"entry":resolved.entry,"installationRoot":resolved.root},"expectedSdkEntry":resolved.sdk,"request":{"rowId":row.id,"sessionId":row.native_session_id,"cwd":row.cwd}})).map_err(|_|Code::InvalidRequest)?;
        if pending.len() > 32767 {
            return Err(Code::InvalidRequest.into());
        }
        pending.push(b'\n');
        Ok(Self {
            job,
            index,
            pending,
            sent: 0,
            value: None,
            error: None,
        })
    }
    fn projection(&self, output: Output) -> Result<Read> {
        let Output::Projection {
            checked_official_source: s,
            coverage,
            code,
            limited,
            blocks,
        } = output
        else {
            let Output::Error { code } = output else {
                unreachable!()
            };
            return Err(match code {
                Code::Unsupported
                | Code::SourceUnconfirmed
                | Code::SourceChanged
                | Code::SourceTooLarge
                | Code::SelectionChanged
                | Code::EntryUnverified
                | Code::InvalidRequest
                | Code::InvalidOutput
                | Code::OutputLimit
                | Code::QueryFailed => code,
                _ => Code::InvalidOutput,
            }
            .into());
        };
        if s.kind != "officialSdk"
            || s.relation != "registeredExactId"
            || s.coverage != "partial"
            || s.continuation != "unverified"
            || s.branch != "unverified"
            || coverage != "partial"
            || code != "coverageUnconfirmed"
            || blocks.is_empty()
            || blocks.len() > 1600
        {
            return Err(Code::InvalidOutput.into());
        }
        let mut seen = HashSet::new();
        let mut bytes = 0;
        let mut hits = vec![];
        let count = blocks.len();
        for block in blocks {
            self.job.within()?;
            let loc = &block.message_locator;
            bytes += block.text.len();
            if block.row_id != self.job.source.rows[self.index].id
                || loc.kind != "message"
                || !uuid(&loc.message_id)
                || loc.part_index > 9007199254740991
                || !seen.insert((loc.message_id.clone(), loc.part_index))
                || !matches!(block.role.as_str(), "user" | "assistant")
                || block.text.len() > 65536
                || bytes > 1048576
            {
                return Err(Code::InvalidOutput.into());
            }
            if let Some(found) = text::find(&block.text, &self.job.request.query) {
                hits.push(Hit {
                    row_id: block.row_id,
                    locator: Locator::Message {
                        message_locator: block.message_locator,
                    },
                    role: if block.role == "user" {
                        "user"
                    } else {
                        "assistant"
                    },
                    text: found.text,
                    text_truncated: block.text_truncated || found.text_truncated,
                    matches: found.ranges,
                    matches_truncated: found.ranges_truncated,
                });
            }
        }
        let matched = hits.len();
        let remaining = 200usize.saturating_sub(self.job.snapshot().hits.len());
        let limited = limited || hits.len() > remaining;
        hits.truncate(remaining);
        self.job.update(|v| {
            let row = &mut v.rows[self.index];
            row.pages_read = 1;
            row.text_blocks_read = count;
            row.matched_text_blocks = matched;
        });
        Ok(Read {
            hits,
            state: RowState::Partial,
            code: Some(if limited {
                Code::ResultLimit
            } else {
                Code::CoverageUnconfirmed
            }),
            error: None,
        })
    }
    pub fn finish(mut self, bytes: &[u8], failure: Option<Failure>) -> Result<Read> {
        if let Some(code) = self.error.or(failure.map(|e| e.code)) {
            return Err(code.into());
        }
        if !bytes.iter().all(u8::is_ascii_whitespace) {
            return Err(Code::InvalidOutput.into());
        }
        let value = self.value.take().ok_or(Code::InvalidOutput)?;
        self.projection(value)
    }
}
impl inventory::process::FixedExchange for Exchange<'_> {
    fn write(&mut self, writer: &mut dyn Write) -> inventory::Result<()> {
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
            if self.value.is_some()
                || self.sent != self.pending.len()
                || !inventory::output::bounded_depth(&bytes[..end])
            {
                self.error = Some(Code::InvalidOutput);
                return Err(inventory::Code::InvalidOutput.into());
            }
            self.value = Some(
                serde_json::from_slice(&bytes[..end])
                    .map_err(|_| inventory::Code::InvalidOutput)?,
            );
            bytes[..=end].fill(0);
            bytes.drain(..=end);
        }
        Ok(())
    }
    fn done(&self) -> bool {
        self.value.is_some()
    }
}
