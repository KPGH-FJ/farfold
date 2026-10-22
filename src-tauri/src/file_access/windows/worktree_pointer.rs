//! Only the two documented linked-worktree pointers, held against other writers.
use super::pinned::local_guid;
use super::*;
use std::io::{Read, Seek, SeekFrom, Write};

pub(crate) struct WorktreePointer {
    file: File,
    parent: File,
    parent_identity: Identity,
    leaf: String,
    expected: Stamp,
    bytes: Vec<u8>,
}
impl WorktreePointer {
    pub(crate) fn open(
        parent: &PinnedPath,
        leaf: &str,
        expected: &Stamp,
        bytes: &[u8],
    ) -> io::Result<Self> {
        if !matches!(leaf, ".git" | "gitdir") || bytes.is_empty() || bytes.len() > 4096 {
            return Err(invalid());
        }
        parent.verify()?;
        let mut raw = name(OsStr::new(leaf))?;
        let unicode = UNICODE_STRING {
            Length: (raw.len() * 2) as u16,
            MaximumLength: (raw.len() * 2) as u16,
            Buffer: raw.as_mut_ptr(),
        };
        let object = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: handle(parent.file()),
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            ..Default::default()
        };
        let mut status = IO_STATUS_BLOCK::default();
        let mut result = ptr::null_mut();
        let code = unsafe {
            NtCreateFile(
                &mut result,
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                &object,
                &mut status,
                ptr::null(),
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ,
                FILE_OPEN,
                FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | FILE_NON_DIRECTORY_FILE,
                ptr::null(),
                0,
            )
        };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(
                unsafe { RtlNtStatusToDosError(code) } as i32,
            ));
        }
        let file = unsafe { File::from_raw_handle(result) };
        let actual = stamp(&file)?;
        if &actual != expected
            || !actual.regular
            || actual.links != 1
            || actual.size > 4096
            || local_guid(&file)? != parent.guid_path.join(leaf)
        {
            return Err(denied());
        }
        let mut owner = Self {
            file,
            parent: parent.file().try_clone()?,
            parent_identity: parent.identity().clone(),
            leaf: leaf.into(),
            expected: actual,
            bytes: bytes.to_vec(),
        };
        owner.verify()?;
        parent.verify()?;
        Ok(owner)
    }
    pub(crate) fn verify(&mut self) -> io::Result<()> {
        if stamp(&self.parent)?.identity != self.parent_identity
            || stamp(&self.file)? != self.expected
            || metadata_child(&self.parent, OsStr::new(&self.leaf))
                .map_err(|_| denied())?
                .is_none_or(|m| m.identity() != &self.expected.identity)
        {
            return Err(denied());
        }
        self.file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        (&mut self.file).take(4097).read_to_end(&mut bytes)?;
        if bytes != self.bytes || stamp(&self.file)? != self.expected {
            return Err(denied());
        }
        Ok(())
    }
    pub(crate) fn replace(&mut self, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty() || bytes.len() > 4096 || bytes.contains(&0) {
            return Err(invalid());
        }
        self.verify()?;
        // Documented gitdir and .git format, not an index/ref/config rewrite:
        // https://git-scm.com/docs/git-worktree#_details
        // A failed second write/flush is an UNKNOWN partial move. No rollback,
        // retry, or repair (which also repairs other registered worktrees).
        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(bytes)?;
        self.file.set_len(bytes.len() as u64)?;
        self.file.sync_all()?;
        let after = stamp(&self.file)?;
        if after.identity != self.expected.identity
            || !after.regular
            || after.links != 1
            || after.size != bytes.len() as u64
        {
            return Err(denied());
        }
        self.expected = after;
        self.bytes = bytes.to_vec();
        self.verify()
    }
}
// No atomicity is implied: after the first write succeeds, every subsequent
// failure/cancellation is partial/unknown to the worktree caller.
pub(crate) fn replace_pair(
    forward: &mut WorktreePointer,
    backward: &mut WorktreePointer,
    forward_bytes: &[u8],
    backward_bytes: &[u8],
    cancel: &std::sync::atomic::AtomicBool,
) -> io::Result<()> {
    use std::sync::atomic::Ordering;
    if cancel.load(Ordering::SeqCst) {
        return Err(io::ErrorKind::Interrupted.into());
    }
    forward.replace(forward_bytes)?;
    if cancel.load(Ordering::SeqCst) {
        return Err(io::ErrorKind::Interrupted.into());
    }
    backward.replace(backward_bytes)?;
    forward.verify()?;
    backward.verify()
}
#[cfg(test)]
#[path = "worktree_pointer_tests.rs"]
mod tests;
