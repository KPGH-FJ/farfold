//! Bounded view of an already validated native carrier. Preserve every original
//! byte but feed its complete security record after all payload records to keep
//! payload creation ahead of restrictive DACL restoration. No allocation,
//! write, native call or new authority; transfer retains work/cancel accounting.
use std::io::{self, Read, Seek, SeekFrom};
use std::ops::Range;

pub(in crate::file_access) struct SecurityLast<R> {
    input: R,
    length: u64,
    security: Range<u64>,
    position: u64,
}
impl<R: Read + Seek> SecurityLast<R> {
    pub(in crate::file_access) fn new(
        input: R,
        length: u64,
        security: Range<u64>,
    ) -> io::Result<Self> {
        // The caller supplies the unique complete record from its actual
        // parser of the same held extent. This guard is only bounds checking.
        if security.start >= security.end || security.end > length {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        Ok(Self {
            input,
            length,
            security,
            position: 0,
        })
    }
    fn physical(&self) -> (u64, u64) {
        let size = self.security.end - self.security.start;
        let payload_end = self.length - size;
        if self.position < self.security.start {
            (self.position, self.security.start - self.position)
        } else if self.position < payload_end {
            (self.position + size, payload_end - self.position)
        } else {
            (
                self.security.start + (self.position - payload_end),
                self.length - self.position,
            )
        }
    }
}
impl<R: Read + Seek> Read for SecurityLast<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() || self.position == self.length {
            return Ok(0);
        }
        let (at, remaining) = self.physical();
        if self.input.seek(SeekFrom::Start(at))? != at {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let offer = remaining.min(out.len() as u64) as usize;
        let count = self.input.read(&mut out[..offer])?;
        if count > offer {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.position += count as u64;
        Ok(count)
    }
}
impl<R: Read + Seek> Seek for SecurityLast<R> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(at) => i128::from(at),
            SeekFrom::Current(by) => i128::from(self.position) + i128::from(by),
            SeekFrom::End(by) => i128::from(self.length) + i128::from(by),
        };
        if position < 0 || position > i128::from(self.length) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        self.position = position as u64;
        Ok(self.position)
    }
}

#[cfg(test)]
#[path = "material_security_last_tests.rs"]
mod tests;
