//! One fixed source pack export. No general command/output-path authority.
use super::super::{
    inspect,
    recovery_pack::ExportRequest,
    recovery_roots::MAX_BYTES,
    types::{Result, error},
    windows_git::ReadContext,
};
use crate::file_access::PinnedPath;
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
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
    let output_path = namespace.root.guid_path.join("objects.pack");
    let output = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&output_path)
        .map_err(|_| error("unavailable"))?;
    let mut command = std::process::Command::new(&source.selected_program().guid_path);
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_COMMON_DIR", &source.scope.common.guid_path)
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
        .arg(&source.scope.git.guid_path)
        .arg("--work-tree")
        .arg(&source.scope.root.guid_path)
        .arg("-C")
        .arg(&source.scope.root.guid_path)
        .args(["pack-objects", "--stdout", "--revs"])
        .current_dir(&source.scope.root.guid_path);
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
    source_matches(&source, &request)?;
    namespace.verify()?;
    if !outcome?.success {
        return Err(error("recoveryInvalid"));
    }
    // execute_bounded has closed every writable stdout handle before this
    // read-only/no-delete pin. The child never receives a namespace handle.
    let pack = namespace
        .root
        .child(&"objects.pack".encode_utf16().collect::<Vec<_>>(), false)
        .map_err(|_| error("changed"))?;
    let stamp = crate::file_access::stamp(pack.file()).map_err(|_| error("changed"))?;
    if !stamp.regular || stamp.size == 0 || stamp.size > MAX_BYTES {
        return Err(error("recoveryLimit"));
    }
    cancelled(cancel)?;
    Ok(ExportedPack {
        source,
        pack,
        namespace,
    })
}
