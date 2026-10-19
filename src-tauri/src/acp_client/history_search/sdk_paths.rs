//! One owned SDK path context, retained through cleanup and result publication.
use super::{launch::Resolved, types::*};
use crate::acp_client::extension_inventory as inventory;
#[cfg(windows)]
use std::path::Path;
use std::{io::Write, path::PathBuf};

pub(super) struct Paths {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub root: PathBuf,
    pub sdk: PathBuf,
    pub cwd: String,
}
pub(super) struct Context {
    pub paths: Paths,
    #[cfg(windows)]
    pins: Vec<Pin>,
}

// This lexical conversion does not grant authority. Production calls it only
// around existing held/nofollow Windows owners, then verifies full identities.
#[cfg(any(windows, test))]
pub(super) fn disk_path(value: &str) -> Result<String> {
    let raw = value.strip_prefix(r"\\?\").unwrap_or(value);
    let bytes = raw.as_bytes();
    if raw.encode_utf16().count() > 4096
        || bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
    {
        return Err(Code::CwdUnavailable.into());
    }
    if raw.len() > 3 {
        for part in raw[3..].split('\\') {
            let stem = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            if part.is_empty()
                || part.ends_with(['.', ' '])
                || part.encode_utf16().count() > 255
                || part.chars().any(|c| {
                    c.is_control() || matches!(c, ':' | '/' | '?' | '*' | '"' | '<' | '>' | '|')
                })
                || matches!(
                    stem.as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "CONIN$"
                        | "CONOUT$"
                        | "COM¹"
                        | "COM²"
                        | "COM³"
                        | "LPT¹"
                        | "LPT²"
                        | "LPT³"
                )
                || (stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
            {
                return Err(Code::CwdUnavailable.into());
            }
        }
    }
    Ok(raw.to_owned())
}

// Disposable capability hint, not a runtime source lease. Only cwd is opened;
// no installation root, watched module, or no-delete source group is acquired.
// A real query rechecks the selected source and creates Context after its
// activity, preparation scope, execution and configuration permits are held.
pub(super) fn probe_cwd(cwd: &str) -> Result<()> {
    let directory = inventory::launch::Directory::open(cwd)?;
    let canonical = std::fs::canonicalize(cwd).map_err(|_| Code::CwdUnavailable)?;
    let value = canonical.to_str().ok_or(Code::CwdUnavailable)?;
    #[cfg(windows)]
    {
        let plain = disk_path(value)?;
        let presented = inventory::launch::Directory::open(&plain)?;
        if !presented.current() {
            return Err(Code::CwdUnavailable.into());
        }
    }
    #[cfg(not(windows))]
    if value != cwd {
        return Err(Code::CwdUnavailable.into());
    }
    if !directory.current() {
        return Err(Code::CwdUnavailable.into());
    }
    Ok(())
}

#[cfg(windows)]
struct Pin {
    owner: crate::file_access::PinnedPath,
    path: String,
    directory: bool,
    stamp: crate::file_access::Stamp,
}
#[cfg(windows)]
impl Pin {
    fn open(path: &Path, directory: bool) -> Result<Self> {
        // Refuse dot/device/UNC/ADS/ambiguous spelling before native traversal.
        disk_path(path.to_str().ok_or(Code::CwdUnavailable)?)?;
        let owner = if directory {
            crate::file_access::PinnedPath::directory(path)
        } else {
            crate::file_access::PinnedPath::regular(path)
        }
        .map_err(|_| Code::CwdUnavailable)?;
        let plain = disk_path(&owner.path)?;
        let stamp = crate::file_access::stamp(owner.file()).map_err(|_| Code::CwdUnavailable)?;
        let result = Self {
            owner,
            path: plain,
            directory,
            stamp,
        };
        result.current()?;
        Ok(result)
    }
    fn current(&self) -> Result<()> {
        self.owner.verify().map_err(|_| Code::CwdUnavailable)?;
        let fresh = if self.directory {
            crate::file_access::PinnedPath::directory(Path::new(&self.path))
        } else {
            crate::file_access::PinnedPath::regular(Path::new(&self.path))
        }
        .map_err(|_| Code::CwdUnavailable)?;
        fresh.verify().map_err(|_| Code::CwdUnavailable)?;
        if disk_path(&fresh.path)? != self.path
            || !crate::file_access::same_object(self.owner.file(), fresh.file())
                .map_err(|_| Code::CwdUnavailable)?
            || (!self.directory
                && crate::file_access::stamp(self.owner.file())
                    .map_err(|_| Code::CwdUnavailable)?
                    != self.stamp)
        {
            return Err(Code::SelectionChanged.into());
        }
        Ok(())
    }
}

impl Context {
    pub fn new(cwd: &str, resolved: &Resolved) -> Result<Self> {
        #[cfg(not(windows))]
        {
            if std::fs::canonicalize(cwd)
                .ok()
                .and_then(|p| p.to_str().map(str::to_owned))
                .as_deref()
                != Some(cwd)
            {
                return Err(Code::CwdUnavailable.into());
            }
            Ok(Self {
                paths: Paths {
                    node: resolved.node.clone(),
                    entry: resolved.entry.clone(),
                    root: resolved.root.clone(),
                    sdk: resolved.sdk.clone(),
                    cwd: cwd.to_owned(),
                },
            })
        }
        #[cfg(windows)]
        {
            let cwd = Pin::open(Path::new(cwd), true)?;
            let root = Pin::open(&resolved.root, true)?;
            let mut pins = vec![cwd, root];
            for (path, expected) in &resolved.watched {
                let pin = Pin::open(path, false)?;
                if &pin.stamp != expected {
                    return Err(Code::SelectionChanged.into());
                }
                pins.push(pin);
            }
            let prepared = |path: &Path| -> Result<PathBuf> {
                resolved
                    .watched
                    .iter()
                    .position(|(p, _)| p == path)
                    .map(|i| PathBuf::from(&pins[i + 2].path))
                    .ok_or_else(|| Code::EntryUnverified.into())
            };
            let paths = Paths {
                node: prepared(&resolved.node)?,
                entry: prepared(&resolved.entry)?,
                sdk: prepared(&resolved.sdk)?,
                root: PathBuf::from(&pins[1].path),
                cwd: pins[0].path.clone(),
            };
            let value = Self { paths, pins };
            value.current()?;
            Ok(value)
        }
    }
    pub fn current(&self) -> Result<()> {
        #[cfg(windows)]
        for pin in &self.pins {
            pin.current()?;
        }
        Ok(())
    }
    pub fn command(&self, command: &mut std::process::Command) -> Result<()> {
        self.current()?;
        command.current_dir(&self.paths.cwd);
        Ok(())
    }
}

pub(super) struct ScopedExchange<'a> {
    pub context: &'a Context,
    pub inner: &'a mut dyn inventory::process::FixedExchange,
}
impl inventory::process::FixedExchange for ScopedExchange<'_> {
    fn write(&mut self, writer: &mut dyn Write) -> inventory::Result<()> {
        self.context
            .current()
            .map_err(|_| inventory::Code::SelectionChanged)?;
        self.inner.write(writer)
    }
    fn received(&mut self, bytes: &mut Vec<u8>) -> inventory::Result<()> {
        self.context
            .current()
            .map_err(|_| inventory::Code::SelectionChanged)?;
        self.inner.received(bytes)
    }
    fn done(&self) -> bool {
        self.inner.done()
    }
}
