//! One finite private stdin snapshot. No input bytes/path enter diagnostics.
//! This does not grant command/path authority or provide another process owner.
use crate::worktrees::types::{Result, error};
use std::{
    fs::File,
    io::{Read, Seek, Write},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};

// Not Clone: a value is consumed by exactly one invocation. The private file
// has no public path or writable alias in this API. A child gets its own stdio
// duplicate, while this original remains with the existing child/group owner.
pub(in crate::worktrees) struct Input {
    file: Option<File>,
    bytes: u64,
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(error("cancelled"))
    } else {
        Ok(())
    }
}
impl Input {
    pub(in crate::worktrees) fn null() -> Self {
        Self {
            file: None,
            bytes: 0,
        }
    }
    pub(in crate::worktrees) fn from_bytes(
        bytes: &[u8],
        limit: u64,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        cancelled(cancel)?;
        if bytes.len() as u64 > limit {
            return Err(error("tooLarge"));
        }
        let mut file = tempfile::tempfile().map_err(|_| error("unavailable"))?;
        for chunk in bytes.chunks(65_536) {
            cancelled(cancel)?;
            file.write_all(chunk).map_err(|_| error("unavailable"))?;
        }
        cancelled(cancel)?;
        file.rewind().map_err(|_| error("unavailable"))?;
        Ok(Self {
            file: Some(file),
            bytes: bytes.len() as u64,
        })
    }
    // Snapshot only the remaining range of the selected held regular source.
    // Unlike passing a caller's arbitrary File directly, it cannot append more
    // external data to stdin after this finite range was reviewed. This is not
    // pathname/namespace admission: callers still own that separate contract.
    pub(in crate::worktrees) fn from_file(
        mut source: File,
        limit: u64,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        cancelled(cancel)?;
        let before = crate::file_access::stamp(&source).map_err(|_| error("changed"))?;
        if !before.regular {
            return Err(error("changed"));
        }
        let start = source.stream_position().map_err(|_| error("unavailable"))?;
        let remaining = before.size.checked_sub(start).ok_or(error("changed"))?;
        if remaining > limit {
            return Err(error("tooLarge"));
        }
        let mut file = tempfile::tempfile().map_err(|_| error("unavailable"))?;
        let mut count = 0u64;
        let mut buffer = [0u8; 65_536];
        loop {
            cancelled(cancel)?;
            // One additional byte detects growth/incorrect EOF. Never write
            // that byte, or any data past the declared remaining range/cap.
            let offer = (remaining - count)
                .saturating_add(1)
                .min(buffer.len() as u64) as usize;
            let n = source
                .read(&mut buffer[..offer])
                .map_err(|_| error("unavailable"))?;
            if n == 0 {
                break;
            }
            let next = count.checked_add(n as u64).ok_or(error("tooLarge"))?;
            if next > remaining {
                return Err(error("changed"));
            }
            file.write_all(&buffer[..n])
                .map_err(|_| error("unavailable"))?;
            count = next;
        }
        cancelled(cancel)?;
        if count != remaining
            || crate::file_access::stamp(&source).map_err(|_| error("changed"))? != before
        {
            return Err(error("changed"));
        }
        file.rewind().map_err(|_| error("unavailable"))?;
        Ok(Self {
            file: Some(file),
            bytes: count,
        })
    }
    // Called after the Windows wrapper has rebuilt Command and before spawn.
    // Anonymous tempfile handles can be delete-pending by design: no namespace
    // identity is inferred from this private staging file. Parent retains the
    // actual FileObject; metadata only enforces its finite size/type contract.
    pub(super) fn install(&self, command: &mut Command) -> Result<()> {
        self.verify()?;
        if let Some(file) = &self.file {
            let mut position = file;
            if position
                .stream_position()
                .map_err(|_| error("unavailable"))?
                != 0
            {
                return Err(error("changed"));
            }
            command.stdin(file.try_clone().map_err(|_| error("unavailable"))?);
        } else {
            command.stdin(Stdio::null());
        }
        Ok(())
    }
    pub(super) fn verify(&self) -> Result<()> {
        if let Some(file) = &self.file {
            let metadata = file.metadata().map_err(|_| error("unavailable"))?;
            if !metadata.is_file() || metadata.len() != self.bytes {
                return Err(error("changed"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "git_input_tests.rs"]
mod tests;
