//! Fixed recovery artifacts, one held parent/root/file set per verification.
//! Native identity is explicit; no persisted 64-bit inode becomes Windows ID.
use crate::worktrees::{
    inspect, material_scan,
    recovery_roots::MAX_BYTES,
    types::{Result, error},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
#[cfg(unix)]
#[path = "recovery_artifact_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "recovery_artifact_windows.rs"]
mod platform;
const MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub(in crate::worktrees) enum FileIdentity {
    Unix(UnixIdentity),
    Windows(WindowsIdentity),
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(in crate::worktrees) struct UnixIdentity {
    pub dev: u64,
    pub ino: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(in crate::worktrees) struct WindowsIdentity {
    windows: WindowsId,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowsId {
    volume: [u8; 8],
    file_id: [u8; 16],
}
impl FileIdentity {
    fn native(file: &File) -> Result<Self> {
        let s = crate::file_access::stamp(file).map_err(|_| error("recoveryChanged"))?;
        #[cfg(unix)]
        {
            Ok(Self::Unix(UnixIdentity {
                dev: s.identity.device,
                ino: u64::try_from(s.identity.inode).map_err(|_| error("recoveryChanged"))?,
            }))
        }
        #[cfg(windows)]
        {
            if s.identity.inode == 0 {
                return Err(error("recoveryChanged"));
            }
            Ok(Self::Windows(WindowsIdentity {
                windows: WindowsId {
                    volume: s.identity.device.to_le_bytes(),
                    file_id: s.identity.inode.to_le_bytes(),
                },
            }))
        }
    }
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(error("cancelled"))
    } else {
        Ok(())
    }
}
struct Artifact {
    name: &'static str,
    opened: platform::Opened,
    stamp: crate::file_access::Stamp,
}
impl Artifact {
    fn open(directory: &platform::Directory, name: &'static str) -> Result<Self> {
        let opened = directory.open_file(name)?;
        let stamp =
            crate::file_access::stamp(opened.file()).map_err(|_| error("recoveryChanged"))?;
        if !stamp.regular {
            return Err(error("recoveryChanged"));
        }
        Ok(Self {
            name,
            opened,
            stamp,
        })
    }
    fn verify(&self, directory: &platform::Directory) -> Result<()> {
        self.opened.verify()?;
        let fresh = directory.open_file(self.name)?;
        if crate::file_access::stamp(self.opened.file()).map_err(|_| error("recoveryChanged"))?
            != self.stamp
            || crate::file_access::stamp(fresh.file()).map_err(|_| error("recoveryChanged"))?
                != self.stamp
        {
            return Err(error("recoveryChanged"));
        }
        Ok(())
    }
}
#[derive(PartialEq, Eq)]
pub(super) struct Observation {
    pub bundle_identity: FileIdentity,
    pub manifest_identity: FileIdentity,
    pub bundle_bytes: u64,
    pub bundle_sha256: String,
    pub manifest_sha256: String,
    pub manifest_raw: Vec<u8>,
}
pub(super) struct Expected<'a> {
    pub bundle_identity: &'a FileIdentity,
    pub manifest_identity: &'a FileIdentity,
    pub bundle_bytes: u64,
    pub bundle_sha256: &'a str,
    pub manifest_sha256: &'a str,
}
pub(super) struct Artifacts {
    directory: platform::Directory,
    bundle: Artifact,
    manifest: Artifact,
}
impl Artifacts {
    pub(super) fn open(
        root: &Path,
        parent: &Path,
        parent_stamp: &inspect::Stamp,
        root_stamp: &inspect::Stamp,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        cancelled(cancel)?;
        if root.parent() != Some(parent) {
            return Err(error("unsafePath"));
        }
        let directory = platform::Directory::open(root, parent, parent_stamp, root_stamp)?;
        cancelled(cancel)?;
        let bundle = Artifact::open(&directory, "recovery.bundle")?;
        cancelled(cancel)?;
        let manifest = Artifact::open(&directory, "manifest.json")?;
        let value = Self {
            directory,
            bundle,
            manifest,
        };
        value.verify()?;
        cancelled(cancel)?;
        Ok(value)
    }
    fn verify(&self) -> Result<()> {
        self.directory.verify()?;
        self.bundle.verify(&self.directory)?;
        self.manifest.verify(&self.directory)?;
        self.directory.verify()
    }
    pub(super) fn require_identities(
        &self,
        bundle: &FileIdentity,
        manifest: &FileIdentity,
    ) -> Result<()> {
        self.verify()?;
        // Enum equality rejects a foreign-platform/mixed identity without
        // treating an old Unix inode as the low half of a Windows file ID.
        if &FileIdentity::native(self.bundle.opened.file())? != bundle
            || &FileIdentity::native(self.manifest.opened.file())? != manifest
        {
            return Err(error("recoveryChanged"));
        }
        Ok(())
    }
    pub(super) fn read_verified(
        &mut self,
        expected: &Expected<'_>,
        cancel: &AtomicBool,
    ) -> Result<Observation> {
        self.require_identities(expected.bundle_identity, expected.manifest_identity)?;
        let observed = self.observe(cancel)?;
        if observed.bundle_bytes != expected.bundle_bytes
            || observed.bundle_sha256.as_str() != expected.bundle_sha256
            || observed.manifest_sha256.as_str() != expected.manifest_sha256
        {
            return Err(error("recoveryChanged"));
        }
        Ok(observed)
    }
    pub(super) fn bundle_path(&self) -> PathBuf {
        self.bundle.opened.path()
    }
    // Exclusive &mut prevents interleaved seeks/reads on these FileObjects.
    // Fresh relative opens below verify names, never supply the digest bytes.
    pub(super) fn observe(&mut self, cancel: &AtomicBool) -> Result<Observation> {
        cancelled(cancel)?;
        self.verify()?;
        let (bundle_bytes, bundle_sha256, _) = read(&self.bundle, MAX_BYTES, false, cancel)?;
        let (_, manifest_sha256, manifest_raw) =
            read(&self.manifest, MANIFEST_BYTES, true, cancel)?;
        self.verify()?;
        cancelled(cancel)?;
        Ok(Observation {
            bundle_identity: FileIdentity::native(self.bundle.opened.file())?,
            manifest_identity: FileIdentity::native(self.manifest.opened.file())?,
            bundle_bytes,
            bundle_sha256,
            manifest_sha256,
            manifest_raw,
        })
    }
}
fn read(
    artifact: &Artifact,
    cap: u64,
    collect: bool,
    cancel: &AtomicBool,
) -> Result<(u64, String, Vec<u8>)> {
    cancelled(cancel)?;
    let mut file = artifact.opened.file();
    if artifact.stamp.size > cap {
        return Err(error("recoveryLimit"));
    }
    if crate::file_access::stamp(file).map_err(|_| error("recoveryChanged"))? != artifact.stamp {
        return Err(error("recoveryChanged"));
    }
    file.rewind().map_err(|_| error("recoveryChanged"))?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut raw = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        cancelled(cancel)?;
        let offer = (artifact.stamp.size - count)
            .saturating_add(1)
            .min(buf.len() as u64) as usize;
        let n = file
            .read(&mut buf[..offer])
            .map_err(|_| error("unavailable"))?;
        if n == 0 {
            break;
        }
        count = count.checked_add(n as u64).ok_or(error("recoveryLimit"))?;
        if count > artifact.stamp.size || count > cap {
            return Err(error("recoveryChanged"));
        }
        hash.update(&buf[..n]);
        if collect {
            raw.extend_from_slice(&buf[..n]);
        }
    }
    if count != artifact.stamp.size
        || crate::file_access::stamp(file).map_err(|_| error("recoveryChanged"))? != artifact.stamp
    {
        return Err(error("recoveryChanged"));
    }
    cancelled(cancel)?;
    Ok((count, material_scan::hex(hash.finalize()), raw))
}
#[cfg(test)]
#[path = "recovery_artifact_tests.rs"]
mod tests;
