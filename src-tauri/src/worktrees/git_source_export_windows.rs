//! One fixed source pack export. No general command/output-path authority.
use super::super::{
    inspect,
    recovery_pack::ExportRequest,
    recovery_roots::MAX_BYTES,
    types::{Result, error},
    windows_git::ReadContext,
};
use crate::file_access::PinnedPath;
use sha2::{Digest, Sha256};
use std::os::windows::fs::OpenOptionsExt;
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use std::{
    fs::File,
    io::{Read, Seek},
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

// Pins close before TempDir removal; this owner is transferred with the pack,
// never inferred from a caller-provided File or arbitrary destination path.
pub(in crate::worktrees) struct Namespace {
    root: PinnedPath,
    _temp: tempfile::TempDir,
}
impl Namespace {
    pub(in crate::worktrees) fn verify(&self) -> Result<()> {
        self.root.verify().map_err(|_| error("changed"))
    }
}
pub(in crate::worktrees) struct ExportedPack {
    source: ReadContext,
    pack: PinnedPath,
    namespace: Namespace,
}
impl ExportedPack {
    pub(in crate::worktrees) fn into_parts(self) -> Result<(ReadContext, PinnedPath, Namespace)> {
        self.source.scope.verify()?;
        self.source
            .selected_program()
            .verify()
            .map_err(|_| error("changed"))?;
        self.pack.verify().map_err(|_| error("changed"))?;
        self.namespace.verify()?;
        Ok((self.source, self.pack, self.namespace))
    }
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(error("cancelled"))
    } else {
        Ok(())
    }
}
fn source_matches(source: &ReadContext, request: &ExportRequest<'_>) -> Result<()> {
    source.scope.verify()?;
    source
        .selected_program()
        .verify()
        .map_err(|_| error("changed"))?;
    let expected = request.identity();
    if source.scope.root.path != request.retained()
        || inspect::pinned_stamp(&source.scope.root)? != expected.root_stamp
        || inspect::pinned_stamp(&source.scope.git)? != expected.git_stamp
        || inspect::pinned_stamp(&source.scope.common)? != expected.common_stamp
    {
        return Err(error("changed"));
    }
    Ok(())
}
pub(in crate::worktrees) fn export(
    request: ExportRequest<'_>,
    cancel: &AtomicBool,
) -> Result<ExportedPack> {
    cancelled(cancel)?;
    super::environment()?;
    // Selection excludes the ORIGINAL source project, not just the new temp.
    let source = ReadContext::open(Path::new(request.retained()))?;
    source_matches(&source, &request)?;
    let input = super::Input::from_bytes(&request.roots_input(), super::OUTPUT_LIMIT, cancel)?;
    let parent_path = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| error("unsafePath"))?;
    let parent = PinnedPath::directory(&parent_path).map_err(|_| error("unsafePath"))?;
    if source.scope.contains_project(&parent) {
        return Err(error("unsafePath"));
    }
    cancelled(cancel)?;
    let temp = tempfile::tempdir_in(&parent.guid_path).map_err(|_| error("unavailable"))?;
    use std::os::windows::ffi::OsStrExt;
    let name = temp
        .path()
        .file_name()
        .ok_or(error("unsafePath"))?
        .encode_wide()
        .collect::<Vec<_>>();
    let root = parent.child(&name, true).map_err(|_| error("unsafePath"))?;
    let namespace = Namespace { root, _temp: temp };
    let mut produced_output = ProducedOutput::new(&namespace)?;
    let output = produced_output.take()?;
    let paths = crate::worktrees::windows_git::paths::Paths::new(&[
        source.selected_program(),
        &source.scope.root,
        &source.scope.git,
        &source.scope.common,
    ])?;
    let mut command = std::process::Command::new(paths.path(source.selected_program())?);
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_COMMON_DIR", paths.path(&source.scope.common)?)
        .args([
            "--no-pager",
            "--no-replace-objects",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.attributesFile=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-c",
            "submodule.recurse=false",
            "-c",
            "worktree.guessRemote=false",
            "-c",
            "credential.helper=",
            "-c",
            "pack.threads=1",
            "-c",
            "pack.windowMemory=16m",
        ])
        .arg("--git-dir")
        .arg(paths.path(&source.scope.git)?)
        .arg("--work-tree")
        .arg(paths.path(&source.scope.root)?)
        .arg("-C")
        .arg(paths.path(&source.scope.root)?)
        .args(["pack-objects", "--stdout", "--revs"])
        .current_dir(paths.path(&source.scope.root)?);
    source_matches(&source, &request)?;
    namespace.verify()?;
    cancelled(cancel)?;
    // This child module alone can call the parent-private executor. No new
    // public arbitrary Command/File bypass to execute_to_file's gate is added.
    // Input installation follows Windows prepare; the same Child+direct Job
    // must finish cleanup (including unwind) before these owners can drop.
    let outcome = super::execute_bounded(
        command,
        Some(input),
        cancel,
        super::super::recovery_pack::COMMAND_TIME,
        output,
        MAX_BYTES,
        false,
    );
    paths.verify()?;
    source_matches(&source, &request)?;
    namespace.verify()?;
    if !outcome?.success {
        return Err(error("recoveryInvalid"));
    }
    // Pair the executor's actual FileObject bytes with this final strict pin.
    // The bridge handoff is explicitly non-atomic, not an immutable marker.
    let pack = produced_output.finish(cancel)?.pin(&namespace, cancel)?;
    source_matches(&source, &request)?;
    namespace.verify()?;
    cancelled(cancel)?;
    Ok(ExportedPack {
        source,
        pack,
        namespace,
    })
}

// Private roles for this one fixed owned output; no arbitrary File/path input.
struct ProducedOutput {
    output: Option<File>,
    anchor: File,
    bridge: File,
}
struct Produced {
    bridge: File,
    producer: crate::file_access::Stamp,
    closed: crate::file_access::Stamp,
    sha256: String,
}
fn producer_shape(before: &crate::file_access::Stamp, after: &crate::file_access::Stamp) -> bool {
    before.identity == after.identity
        && before.size == after.size
        && before.links == after.links
        && before.regular == after.regular
}
fn digest(file: &File, cancel: &AtomicBool) -> Result<(crate::file_access::Stamp, String)> {
    let before = crate::file_access::stamp(file).map_err(|_| error("changed"))?;
    if !before.regular || before.size == 0 || before.size > MAX_BYTES {
        return Err(error("recoveryLimit"));
    }
    let mut read = file.try_clone().map_err(|_| error("unavailable"))?;
    read.rewind().map_err(|_| error("unavailable"))?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        cancelled(cancel)?;
        let offer = (before.size - count)
            .saturating_add(1)
            .min(buffer.len() as u64) as usize;
        let n = read
            .read(&mut buffer[..offer])
            .map_err(|_| error("unavailable"))?;
        if n == 0 {
            break;
        }
        count = count.checked_add(n as u64).ok_or(error("recoveryLimit"))?;
        if count > before.size {
            return Err(error("changed"));
        }
        hash.update(&buffer[..n]);
    }
    if count != before.size
        || crate::file_access::stamp(file).map_err(|_| error("changed"))? != before
    {
        return Err(error("changed"));
    }
    Ok((
        before,
        crate::worktrees::material_scan::hex(hash.finalize()),
    ))
}
impl ProducedOutput {
    fn new(namespace: &Namespace) -> Result<Self> {
        namespace.verify()?;
        let path = namespace.root.guid_path.join("objects.pack");
        let output = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)
            .map_err(|_| error("unavailable"))?;
        let anchor = output.try_clone().map_err(|_| error("unavailable"))?;
        // Separate READ-only FileObject, compatible with the original writer.
        let bridge = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| error("unavailable"))?;
        if crate::file_access::stamp(&anchor).map_err(|_| error("changed"))?
            != crate::file_access::stamp(&bridge).map_err(|_| error("changed"))?
        {
            return Err(error("changed"));
        }
        namespace.verify()?;
        Ok(Self {
            output: Some(output),
            anchor,
            bridge,
        })
    }
    fn take(&mut self) -> Result<File> {
        self.output.take().ok_or(error("unknown"))
    }
    fn finish(self, cancel: &AtomicBool) -> Result<Produced> {
        // Called only after the existing executor confirms original Child +
        // direct Job cleanup. Anchor still excludes external WRITE/DELETE.
        let (producer, sha256) = digest(&self.anchor, cancel)?;
        if crate::file_access::stamp(&self.bridge).map_err(|_| error("changed"))? != producer {
            return Err(error("changed"));
        }
        let Self {
            output,
            anchor,
            bridge,
        } = self;
        drop(output);
        drop(anchor);
        // From here until strict Pin opens, bridge permits external WRITE.
        // It still forbids DELETE and therefore retains the filesystem object.
        // Close-time timestamps are not attributed; final full Stamp is taken
        // after write handles close, with original shape + SHA retained.
        let closed = crate::file_access::stamp(&bridge).map_err(|_| error("changed"))?;
        if !producer_shape(&producer, &closed) {
            return Err(error("changed"));
        }
        Ok(Produced {
            bridge,
            producer,
            closed,
            sha256,
        })
    }
}
impl Produced {
    fn pin(self, namespace: &Namespace, cancel: &AtomicBool) -> Result<PinnedPath> {
        namespace.verify()?;
        cancelled(cancel)?;
        if !producer_shape(&self.producer, &self.closed)
            || crate::file_access::stamp(&self.bridge).map_err(|_| error("changed"))? != self.closed
        {
            return Err(error("changed"));
        }
        // A live WRITE handle makes this READ/share-READ open fail. No retry.
        let pin = namespace
            .root
            .child(&"objects.pack".encode_utf16().collect::<Vec<_>>(), false)
            .map_err(|_| error("changed"))?;
        let (stamp, sha256) = digest(pin.file(), cancel)?;
        if stamp != self.closed
            || sha256 != self.sha256
            || crate::file_access::stamp(&self.bridge).map_err(|_| error("changed"))? != self.closed
        {
            return Err(error("changed"));
        }
        pin.verify().map_err(|_| error("changed"))?;
        namespace.verify()?;
        Ok(pin)
    }
}
#[cfg(test)]
#[path = "source_export_pairing_windows_tests.rs"]
mod pairing_tests;
