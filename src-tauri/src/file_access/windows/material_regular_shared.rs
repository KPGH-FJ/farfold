//! Borrowed regular capture entry, no local pool/budget/namespace/Slot/worker.
//! Caller retains exact source and Namespace on failed native abort/cleanup.
use super::*;
use super::{
    directory::Owner,
    material_carrier::{self, FragmentConsumer, FragmentSource},
    material_carrier_native::{self as native, Facts},
    material_pin::MaterialPin,
    material_restore::Namespace,
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_backup_io::RetiredContext,
    material_carrier_records::{Error, Parsed, Resident, Result, WORK_LIMIT, check, io_error},
};
use std::{
    io::{Seek, SeekFrom},
    sync::{MutexGuard, atomic::AtomicBool},
};
#[derive(Clone, Copy)]
pub(super) enum Held<'a> {
    Legacy(&'a PinnedPath),
    Material(&'a MaterialPin),
}
impl<'a> Held<'a> {
    pub fn legacy(pin: &'a PinnedPath) -> Result<Self> {
        let value = Self::Legacy(pin);
        value.require_full()?;
        Ok(value)
    }
    pub fn material(pin: &'a MaterialPin) -> Result<Self> {
        let value = Self::Material(pin);
        value.require_full()?;
        Ok(value)
    }
    fn require_full(self) -> Result<()> {
        let full = match self {
            Self::Legacy(p) => p.full_security_purpose(),
            Self::Material(p) => p.full_security_purpose(),
        };
        if !full {
            return Err(Error::Unsupported);
        }
        Ok(())
    }
    fn file(self) -> &'a File {
        match self {
            Self::Legacy(p) => p.file(),
            Self::Material(p) => Owner::file(p),
        }
    }
    fn verify(self) -> io::Result<()> {
        match self {
            Self::Legacy(p) => p.verify(),
            Self::Material(p) => p.verify(),
        }
    }
    fn query(self) -> Result<MutexGuard<'a, ()>> {
        match self {
            Self::Legacy(p) => p.try_observation_owner().map_err(|_| Error::Unsupported),
            Self::Material(p) => p.try_observation_owner().map_err(|_| Error::Unsupported),
        }
    }
}
pub(super) struct Io<'a> {
    pub work: &'a mut WorkBudget,
    pub cancel: &'a AtomicBool,
    pub resident: &'a Resident,
    pub context: &'a mut Option<RetiredContext>,
}
impl Io<'_> {
    fn ready(&self) -> Result<()> {
        check(self.cancel)?;
        if self.context.is_some() {
            return Err(Error::CleanupUnknown);
        }
        if self.work.remaining() > WORK_LIMIT {
            return Err(Error::Limit);
        }
        Ok(())
    }
}
pub(super) struct Prepared<'a> {
    source: Held<'a>,
    facts: Facts,
    _query: MutexGuard<'a, ()>,
}
pub(super) struct Captured<'a> {
    source: Held<'a>,
    pub facts: Facts,
    pub parsed: Parsed,
    carrier: Identity,
    consumed: bool,
    _query: MutexGuard<'a, ()>,
}
pub(super) fn prepare<'a>(source: Held<'a>, io: &mut Io<'_>) -> Result<Prepared<'a>> {
    io.ready()?;
    source.require_full()?;
    let query = source.query()?;
    source.verify().map_err(|e| io_error("sourceVerify", e))?;
    // Existing facts is the ONLY regular admission/parser premise. In particular
    // full-SD purpose and links==1 are not weakened for a future tree/alias tag.
    let facts = native::facts(source.file(), io.work, io.cancel, io.resident)?;
    Ok(Prepared {
        source,
        facts,
        _query: query,
    })
}
impl<'a> Prepared<'a> {
    pub fn verify_unchanged(&self, io: &mut Io<'_>, phase: &'static str) -> Result<()> {
        io.ready()?;
        if !self.facts.unchanged(&native::facts(
            self.source.file(),
            io.work,
            io.cancel,
            io.resident,
        )?) {
            return Err(Error::Changed);
        }
        self.source.verify().map_err(|e| io_error(phase, e))
    }
    pub fn capture(self, namespace: &Namespace, io: &mut Io<'_>) -> Result<Captured<'a>> {
        io.ready()?;
        let spool = namespace.source_carrier.as_ref().ok_or(Error::Invalid)?;
        // Fresh or explicitly recycled OWNED spool only. Do not silently discard a
        // prior node. No File/path creation is performed by this borrowed entry.
        if spool
            .metadata()
            .map_err(|e| io_error("regularSpoolLength", e))?
            .len()
            != 0
        {
            return Err(Error::Invalid);
        }
        let mut cursor = spool;
        cursor
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("regularSpoolSeek", e))?;
        let parsed = material_carrier::captured(
            self.source.file(),
            spool,
            &self.facts,
            io.work,
            io.cancel,
            io.context,
            io.resident,
        )?;
        let after = native::facts(self.source.file(), io.work, io.cancel, io.resident)?;
        if !self.facts.unchanged(&after) {
            return Err(Error::Changed);
        }
        drop(after);
        self.source
            .verify()
            .map_err(|e| io_error("sourceAfterCapture", e))?;
        let carrier = stamp(spool)
            .map_err(|e| io_error("regularSpoolIdentity", e))?
            .identity;
        Ok(Captured {
            source: self.source,
            facts: self.facts,
            parsed,
            carrier,
            consumed: false,
            _query: self._query,
        })
    }
}
impl<'a> Captured<'a> {
    pub fn carrier_identity(&self) -> &Identity {
        &self.carrier
    }
    pub fn verify_unchanged(&self, io: &mut Io<'_>, phase: &'static str) -> Result<()> {
        io.ready()?;
        if !self.facts.unchanged(&native::facts(
            self.source.file(),
            io.work,
            io.cancel,
            io.resident,
        )?) {
            return Err(Error::Changed);
        }
        self.source.verify().map_err(|e| io_error(phase, e))
    }
    fn spool<'n>(&self, namespace: &'n Namespace) -> Result<&'n File> {
        let file = namespace.source_carrier.as_ref().ok_or(Error::Invalid)?;
        if stamp(file)
            .map_err(|e| io_error("regularSpoolRecheck", e))?
            .identity
            != self.carrier
        {
            return Err(Error::Changed);
        }
        Ok(file)
    }
    pub fn consume_bytes(
        &mut self,
        namespace: &Namespace,
        leaf: &[u16],
        io: &mut Io<'_>,
        consumer: &mut dyn FragmentConsumer,
    ) -> Result<()> {
        io.ready()?;
        if self.consumed {
            return Err(Error::Invalid);
        }
        self.verify_unchanged(io, "regularBeforeConsumer")?;
        let file = self.spool(namespace)?;
        consumer.consume(
            FragmentSource {
                file,
                leaf,
                facts: &self.facts,
                parsed: &self.parsed,
            },
            io.work,
            io.cancel,
            io.resident,
        )?;
        self.verify_unchanged(io, "regularAfterConsumer")?;
        self.consumed = true;
        Ok(())
    }
    // This consumes only the spool proof and checks the SAME owned identity.
    // Return the original Facts/query owner for the caller's final multi-node fence.
    // Caller must already have actually consumed its bytes.
    // Unknown context refuses before any reset; no automatic retry/fallback.
    pub fn recycle(self, namespace: &Namespace, io: &mut Io<'_>) -> Result<Prepared<'a>> {
        io.ready()?;
        if !self.consumed {
            return Err(Error::Invalid);
        }
        self.verify_unchanged(io, "regularBeforeRecycle")?;
        namespace.verify()?;
        let file = self.spool(namespace)?;
        file.set_len(0).map_err(|e| io_error("regularRecycle", e))?;
        let mut cursor = file;
        cursor
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("regularRecycleSeek", e))?;
        Ok(Prepared {
            source: self.source,
            facts: self.facts,
            _query: self._query,
        })
    }
}

#[cfg(test)]
#[path = "material_regular_shared_guard_tests.rs"]
mod tests;
