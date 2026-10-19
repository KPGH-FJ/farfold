//! One private import stage while the source repository still exists.
//! This is neither offline recovery nor authority over a caller-chosen target.
use super::Manifest;
use crate::{
    file_access::PinnedPath,
    worktrees::{git, inspect, storage::Identity, types::*, windows_git::ReadContext},
};
use std::{
    collections::BTreeSet,
    fs,
    io::Seek,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

enum Action<'a> {
    Init(&'a str),
    Import(git::Input),
    Root { index: usize, oid: &'a str },
    Head(usize),
    Fsck,
    Objects(git::Input),
}
struct Context {
    // Field order matters: all namespace/program pins close before TempDir's
    // automatic deletion. Original child ownership stays in git's executor.
    source: ReadContext,
    root: PinnedPath,
    repo: PinnedPath,
    pack: PinnedPath,
    config: Option<(PinnedPath, crate::file_access::Stamp)>,
    width: usize,
    _temp: tempfile::TempDir,
}
pub(super) struct Imported {
    owner: Context,
}
impl Imported {
    pub(super) fn offline_program_origin(
        &self,
    ) -> Result<super::super::windows_offline_program::Origin> {
        self.owner.verify()?;
        self.owner.source.scope.offline_program_origin()
    }
    // Verified borrowed provenance for one fixed private graph consumer.
    // No Command or arbitrary destination authority leaves this owner.
    pub(super) fn observed(&self) -> Result<(&PinnedPath, &PinnedPath)> {
        self.owner.verify()?;
        Ok((self.owner.source.selected_program(), &self.owner.repo))
    }
    pub(super) fn allow_temporary_parent(&self, parent: &PinnedPath) -> Result<()> {
        self.owner.verify()?;
        if self.owner.source.scope.contains_project(parent) {
            Err(error("unsafePath"))
        } else {
            Ok(())
        }
    }
    // A path is only for the existing subsequent stage. This exposes no new
    // Command factory or admission over that stage's arbitrary output paths.
    pub(super) fn path(&self) -> &Path {
        &self.owner.repo.guid_path
    }
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(error("cancelled"))
    } else {
        Ok(())
    }
}
impl Context {
    fn new(
        source: ReadContext,
        expected: &Identity,
        retained: &str,
        pack: PinnedPath,
        format: &str,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        cancelled(cancel)?;
        source.scope.verify()?;
        let width = match format {
            "sha1" => 40,
            "sha256" => 64,
            _ => return Err(error("recoveryInvalid")),
        };
        if source.scope.root.path != retained
            || inspect::pinned_stamp(&source.scope.root)? != expected.root_stamp
            || inspect::pinned_stamp(&source.scope.git)? != expected.git_stamp
            || inspect::pinned_stamp(&source.scope.common)? != expected.common_stamp
        {
            return Err(error("changed"));
        }
        source
            .selected_program()
            .verify()
            .map_err(|_| error("changed"))?;
        // Check the actual chosen temporary parent before creating anything.
        // The original source scope, not the new TempDir, excludes PATH decoys.
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
        fs::create_dir(root.guid_path.join("repo")).map_err(|_| error("unavailable"))?;
        let repo = root
            .child(&"repo".encode_utf16().collect::<Vec<_>>(), true)
            .map_err(|_| error("unsafePath"))?;
        let value = Self {
            source,
            root,
            repo,
            pack,
            config: None,
            width,
            _temp: temp,
        };
        value.verify()?;
        cancelled(cancel)?;
        Ok(value)
    }
    fn verify(&self) -> Result<()> {
        git::environment()?;
        self.source.scope.verify()?;
        self.source
            .selected_program()
            .verify()
            .map_err(|_| error("changed"))?;
        self.root.verify().map_err(|_| error("changed"))?;
        self.repo.verify().map_err(|_| error("changed"))?;
        self.pack.verify().map_err(|_| error("changed"))?;
        if let Some((pin, stamp)) = &self.config {
            pin.verify().map_err(|_| error("changed"))?;
            if crate::file_access::stamp(pin.file()).map_err(|_| error("changed"))? != *stamp {
                return Err(error("changed"));
            }
        }
        Ok(())
    }
    // Private to this owner, never returned through ReadContext's public API.
    fn base_command(
        &self,
    ) -> Result<(
        std::process::Command,
        crate::worktrees::windows_git::paths::Paths,
    )> {
        self.verify()?;
        let paths = crate::worktrees::windows_git::paths::Paths::new(&[
            self.source.selected_program(),
            &self.repo,
        ])?;
        let mut command = std::process::Command::new(paths.path(self.source.selected_program())?);
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
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
            ])
            .arg("--git-dir")
            .arg(paths.path(&self.repo)?)
            .arg("-C")
            .arg(paths.path(&self.repo)?)
            .current_dir(paths.path(&self.repo)?);
        Ok((command, paths))
    }
    // &mut serializes commands for this namespace. The finite Input is consumed
    // by the existing executor; no owner/token is released on a UI deadline.
    fn run(&mut self, action: Action<'_>, cancel: &AtomicBool) -> Result<Vec<u8>> {
        cancelled(cancel)?;
        let (mut command, paths) = self.base_command()?;
        let input = match action {
            Action::Init(format) => {
                if !matches!(format, "sha1" | "sha256") {
                    return Err(error("recoveryInvalid"));
                }
                command
                    .args(["init", "--bare", "--template="])
                    .arg(format!("--object-format={format}"));
                git::Input::null()
            }
            Action::Import(input) => {
                command.args([
                    "index-pack",
                    "--stdin",
                    "--strict",
                    "--max-input-size=268435456",
                ]);
                input
            }
            Action::Root { index, oid: object } => {
                if index >= super::recovery_roots::MAX_ROOTS
                    || object.len() != self.width
                    || !oid(object)
                {
                    return Err(error("recoveryInvalid"));
                }
                command
                    .arg("update-ref")
                    .arg(format!("refs/heads/recovery/root-{index:04}"))
                    .arg(object);
                git::Input::null()
            }
            Action::Head(index) => {
                if index >= super::recovery_roots::MAX_ROOTS {
                    return Err(error("recoveryInvalid"));
                }
                command
                    .args(["symbolic-ref", "HEAD"])
                    .arg(format!("refs/heads/recovery/root-{index:04}"));
                git::Input::null()
            }
            Action::Fsck => {
                command.args([
                    "fsck",
                    "--full",
                    "--strict",
                    "--no-reflogs",
                    "--no-dangling",
                ]);
                git::Input::null()
            }
            Action::Objects(input) => {
                command.args(["rev-list", "--objects", "--no-object-names", "--stdin"]);
                input
            }
        };
        // Windows stdio rebuilding precedes Input installation inside this
        // existing executor; it retains Child+Job through real cleanup/unwind.
        let output = git::execute_command_input(command, input, cancel, super::COMMAND_TIME);
        paths.verify()?;
        self.verify()?;
        let output = output?;
        if !output.success {
            return Err(error("recoveryInvalid"));
        }
        cancelled(cancel)?;
        Ok(output.bytes)
    }
}
pub(super) fn import(
    source: ReadContext,
    expected: &Identity,
    retained: &str,
    pack: PinnedPath,
    manifest: &Manifest,
    cancel: &AtomicBool,
) -> Result<Imported> {
    super::validate(manifest)?;
    cancelled(cancel)?;
    let mut owner = Context::new(
        source,
        expected,
        retained,
        pack,
        &manifest.roots.format,
        cancel,
    )?;
    owner.pack.verify().map_err(|_| error("changed"))?;
    let mut source = owner
        .pack
        .file()
        .try_clone()
        .map_err(|_| error("unavailable"))?;
    source.rewind().map_err(|_| error("unavailable"))?;
    let input = git::Input::from_file(source, super::MAX_BYTES, cancel)?;
    owner.pack.verify().map_err(|_| error("changed"))?;
    owner.run(Action::Init(&manifest.roots.format), cancel)?;
    let config = owner
        .repo
        .child(&"config".encode_utf16().collect::<Vec<_>>(), false)
        .map_err(|_| error("changed"))?;
    let config_stamp = crate::file_access::stamp(config.file()).map_err(|_| error("changed"))?;
    owner.config = Some((config, config_stamp));
    owner.run(Action::Import(input), cancel)?;
    for (index, object) in manifest.roots.commits.iter().enumerate() {
        owner.run(Action::Root { index, oid: object }, cancel)?;
    }
    let index = manifest
        .roots
        .commits
        .iter()
        .position(|o| o == &manifest.roots.head)
        .ok_or(error("recoveryInvalid"))?;
    owner.run(Action::Head(index), cancel)?;
    owner.run(Action::Fsck, cancel)?;
    let input = git::Input::from_bytes(&manifest.roots.input(), git::OUTPUT_LIMIT, cancel)?;
    let raw = String::from_utf8(owner.run(Action::Objects(input), cancel)?)
        .map_err(|_| error("recoveryInvalid"))?;
    let mut objects = BTreeSet::new();
    for line in raw.lines() {
        if !oid(line) || line.len() != manifest.roots.head.len() || !objects.insert(line.to_owned())
        {
            return Err(error("recoveryInvalid"));
        }
    }
    if objects.len() > super::MAX_OBJECTS
        || objects.into_iter().collect::<Vec<_>>() != manifest.objects
    {
        return Err(error("recoveryInvalid"));
    }
    owner.verify()?;
    cancelled(cancel)?;
    Ok(Imported { owner })
}
#[cfg(test)]
#[path = "private_bare_windows_tests.rs"]
mod tests;
