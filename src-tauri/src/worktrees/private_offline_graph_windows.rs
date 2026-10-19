//! Source-independent Git graph check; full material restore remains mandatory.
use super::{
    Manifest, SavedRecovery,
    artifact::{Artifacts, Expected},
    expected_branch,
    recovery_roots::MAX_OBJECTS,
    refs,
};
use crate::{
    file_access::PinnedPath,
    worktrees::{git, types::*, windows_offline_program::within},
};
use std::{
    collections::BTreeSet,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(error("cancelled"))
    } else {
        Ok(())
    }
}
fn expected(saved: &SavedRecovery) -> Expected<'_> {
    Expected {
        bundle_identity: &saved.bundle_stamp,
        manifest_identity: &saved.manifest_stamp,
        bundle_bytes: saved.receipt.bundle_bytes,
        bundle_sha256: &saved.receipt.bundle_sha256,
        manifest_sha256: &saved.receipt.manifest_sha256,
    }
}
fn select_from(
    saved: &SavedRecovery,
    paths: &std::ffi::OsStr,
    cancel: &AtomicBool,
) -> Result<PinnedPath> {
    let origin = saved
        .windows_program_origin
        .as_ref()
        .ok_or(error("unsupportedGit"))?;
    let source = &saved.source.original.identity;
    let retained = &saved.receipt.retained_path;
    origin.matches(source, retained)?;
    let artifact = saved
        .directory_stamp
        .windows_identity()
        .ok_or(error("unsupportedGit"))?;
    for directory in std::env::split_paths(paths).filter(|p| p.is_absolute()) {
        cancelled(cancel)?;
        let path = directory.join("git.exe");
        let Some(text) = path.to_str() else {
            continue;
        };
        if crate::file_access::absolute(&path).is_err()
            || origin.excludes_path(text, source, retained)?
            || within(text, &saved.receipt.path)?
        {
            continue;
        }
        let Ok(pin) = PinnedPath::regular(&path) else {
            continue;
        };
        if origin.excludes_pin(&pin, source, retained)? || pin.has_ancestor(&artifact) {
            continue;
        }
        return Ok(pin);
    }
    Err(error("gitUnavailable"))
}
struct Context<'a> {
    saved: &'a SavedRecovery,
    manifest: &'a Manifest,
    artifacts: &'a mut Artifacts,
    program: PinnedPath,
    pins: Vec<PinnedPath>,
    repo: PinnedPath,
    config: Option<(PinnedPath, crate::file_access::Stamp)>,
    root: PinnedPath,
    _temp: tempfile::TempDir,
}
enum Action<'a> {
    Init,
    Verify,
    Unbundle,
    Root(usize, &'a str),
    Head(usize),
    Fsck,
    Objects,
    Refs,
    HeadOid,
    Symbolic,
}
impl<'a> Context<'a> {
    fn new(
        saved: &'a SavedRecovery,
        artifacts: &'a mut Artifacts,
        manifest: &'a Manifest,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        super::validate(manifest)?;
        cancelled(cancel)?;
        git::environment()?;
        artifacts.read_verified(&expected(saved), cancel)?;
        let paths = std::env::var_os("PATH").ok_or(error("gitUnavailable"))?;
        let program = select_from(saved, &paths, cancel)?;
        let parent = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| error("unsafePath"))?;
        let parent = PinnedPath::directory(&parent).map_err(|_| error("unsafePath"))?;
        let origin = saved
            .windows_program_origin
            .as_ref()
            .ok_or(error("unsupportedGit"))?;
        if origin.excludes_pin(
            &parent,
            &saved.source.original.identity,
            &saved.receipt.retained_path,
        )? || parent.has_ancestor(
            &saved
                .directory_stamp
                .windows_identity()
                .ok_or(error("unsupportedGit"))?,
        ) {
            return Err(error("unsafePath"));
        }
        let temp = tempfile::tempdir_in(&parent.guid_path).map_err(|_| error("unavailable"))?;
        use std::os::windows::ffi::OsStrExt;
        let root = parent
            .child(
                &temp
                    .path()
                    .file_name()
                    .ok_or(error("unsafePath"))?
                    .encode_wide()
                    .collect::<Vec<_>>(),
                true,
            )
            .map_err(|_| error("unsafePath"))?;
        std::fs::create_dir(root.guid_path.join("offline")).map_err(|_| error("unavailable"))?;
        let repo = root
            .child(&"offline".encode_utf16().collect::<Vec<_>>(), true)
            .map_err(|_| error("unsafePath"))?;
        let value = Self {
            saved,
            manifest,
            artifacts,
            program,
            pins: Vec::new(),
            repo,
            config: None,
            root,
            _temp: temp,
        };
        value.verify()?;
        Ok(value)
    }
    fn verify(&self) -> Result<()> {
        git::environment()?;
        self.program.verify().map_err(|_| error("changed"))?;
        self.root.verify().map_err(|_| error("changed"))?;
        self.repo.verify().map_err(|_| error("changed"))?;
        for pin in &self.pins {
            pin.verify().map_err(|_| error("changed"))?;
        }
        if let Some((pin, stamp)) = &self.config {
            pin.verify().map_err(|_| error("changed"))?;
            if crate::file_access::stamp(pin.file()).map_err(|_| error("changed"))? != *stamp {
                return Err(error("changed"));
            }
        }
        for name in ["objects/info/alternates", "shallow"] {
            match std::fs::symlink_metadata(self.repo.guid_path.join(name)) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Ok(_) => return Err(error("recoveryInvalid")),
                Err(_) => return Err(error("unavailable")),
            }
        }
        self.artifacts
            .require_identities(&self.saved.bundle_stamp, &self.saved.manifest_stamp)
    }
    fn run(&mut self, action: Action<'_>, cancel: &AtomicBool) -> Result<Vec<u8>> {
        self.verify()?;
        cancelled(cancel)?;
        let paths = crate::worktrees::windows_git::paths::Paths::new(&[&self.program, &self.repo])?;
        let mut command = Command::new(paths.path(&self.program)?);
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(git::bundle_output::OPTIONS)
            .arg("--git-dir")
            .arg(paths.path(&self.repo)?)
            .arg("-C")
            .arg(paths.path(&self.repo)?)
            .current_dir(paths.path(&self.repo)?);
        let input = match action {
            Action::Init => {
                command
                    .args(["init", "--bare", "--template="])
                    .arg(format!("--object-format={}", self.manifest.roots.format));
                git::Input::null()
            }
            Action::Verify => {
                command.args(["bundle", "verify", "-"]);
                self.artifacts
                    .finite_bundle(&expected(self.saved), cancel)?
            }
            Action::Unbundle => {
                command.args(["bundle", "unbundle", "-"]);
                self.artifacts
                    .finite_bundle(&expected(self.saved), cancel)?
            }
            Action::Root(index, object) => {
                if index >= super::recovery_roots::MAX_ROOTS
                    || !oid(object)
                    || object.len() != self.manifest.roots.head.len()
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
            Action::Objects => {
                command.args(["rev-list", "--objects", "--no-object-names", "--stdin"]);
                git::Input::from_bytes(&self.manifest.roots.input(), git::OUTPUT_LIMIT, cancel)?
            }
            Action::Refs => {
                command.args(["for-each-ref", "--format=%(objectname) %(refname)"]);
                git::Input::null()
            }
            Action::HeadOid => {
                command.args(["rev-parse", "--verify", "HEAD"]);
                git::Input::null()
            }
            Action::Symbolic => {
                command.args(["symbolic-ref", "HEAD"]);
                git::Input::null()
            }
        };
        let result = git::execute_command_input(command, input, cancel, super::COMMAND_TIME);
        paths.verify()?;
        self.verify()?;
        let result = result?;
        cancelled(cancel)?;
        if !result.success {
            return Err(error("recoveryInvalid"));
        }
        Ok(result.bytes)
    }
    fn initialize(&mut self, cancel: &AtomicBool) -> Result<()> {
        self.run(Action::Init, cancel)?;
        let config = self
            .repo
            .child(&"config".encode_utf16().collect::<Vec<_>>(), false)
            .map_err(|_| error("changed"))?;
        let stamp = crate::file_access::stamp(config.file()).map_err(|_| error("changed"))?;
        self.config = Some((config, stamp));
        for parts in [
            ["objects", "pack"],
            ["objects", "info"],
            ["refs", "heads"],
            ["refs", "tags"],
        ] {
            let parent = self
                .repo
                .child(&parts[0].encode_utf16().collect::<Vec<_>>(), true)
                .map_err(|_| error("changed"))?;
            self.pins.push(
                parent
                    .child(&parts[1].encode_utf16().collect::<Vec<_>>(), true)
                    .map_err(|_| error("changed"))?,
            );
        }
        std::fs::create_dir(self.repo.guid_path.join("refs/heads/recovery"))
            .map_err(|_| error("targetExists"))?;
        let refs = self
            .repo
            .child(&"refs".encode_utf16().collect::<Vec<_>>(), true)
            .map_err(|_| error("changed"))?;
        let heads = refs
            .child(&"heads".encode_utf16().collect::<Vec<_>>(), true)
            .map_err(|_| error("changed"))?;
        self.pins.push(
            heads
                .child(&"recovery".encode_utf16().collect::<Vec<_>>(), true)
                .map_err(|_| error("changed"))?,
        );
        self.verify()
    }
    fn refs(&self, bytes: Vec<u8>) -> Result<Vec<(String, String)>> {
        let text = String::from_utf8(bytes).map_err(|_| error("recoveryInvalid"))?;
        let mut out = Vec::new();
        for line in text.lines() {
            let (object, name) = line.split_once(' ').ok_or(error("recoveryInvalid"))?;
            if out.len() > super::recovery_roots::MAX_ROOTS
                || !oid(object)
                || object.len() != self.manifest.roots.head.len()
            {
                return Err(error("recoveryInvalid"));
            }
            out.push((object.to_owned(), name.to_owned()));
        }
        out.sort();
        Ok(out)
    }
    fn check(&mut self, cancel: &AtomicBool) -> Result<()> {
        self.run(Action::Fsck, cancel)?;
        let raw = String::from_utf8(self.run(Action::Objects, cancel)?)
            .map_err(|_| error("recoveryInvalid"))?;
        let mut objects = BTreeSet::new();
        for line in raw.lines() {
            if !oid(line)
                || line.len() != self.manifest.roots.head.len()
                || !objects.insert(line.to_owned())
                || objects.len() > MAX_OBJECTS
            {
                return Err(error("recoveryInvalid"));
            }
        }
        if objects.into_iter().collect::<Vec<_>>() != self.manifest.objects {
            return Err(error("recoveryInvalid"));
        }
        let bytes = self.run(Action::Refs, cancel)?;
        let mut wanted = refs(self.manifest);
        wanted.sort();
        if self.refs(bytes)? != wanted {
            return Err(error("recoveryInvalid"));
        }
        let head = String::from_utf8(self.run(Action::HeadOid, cancel)?)
            .map_err(|_| error("recoveryInvalid"))?;
        let symbolic = String::from_utf8(self.run(Action::Symbolic, cancel)?)
            .map_err(|_| error("recoveryInvalid"))?;
        if head.trim() != self.manifest.roots.head
            || symbolic.trim() != expected_branch(self.manifest)?
        {
            return Err(error("recoveryInvalid"));
        }
        self.verify()
    }
    fn import(&mut self, cancel: &AtomicBool) -> Result<()> {
        self.initialize(cancel)?;
        self.run(Action::Verify, cancel)?;
        let raw = self.run(Action::Unbundle, cancel)?;
        let mut wanted = refs(self.manifest);
        wanted.push((self.manifest.roots.head.clone(), "HEAD".into()));
        wanted.sort();
        if self.refs(raw)? != wanted {
            return Err(error("recoveryInvalid"));
        }
        let manifest = self.manifest;
        for (index, object) in manifest.roots.commits.iter().enumerate() {
            self.run(Action::Root(index, object), cancel)?;
        }
        let head = self
            .manifest
            .roots
            .commits
            .iter()
            .position(|o| o == &self.manifest.roots.head)
            .ok_or(error("recoveryInvalid"))?;
        self.run(Action::Head(head), cancel)?;
        self.pins.push(
            self.repo
                .child(&"HEAD".encode_utf16().collect::<Vec<_>>(), false)
                .map_err(|_| error("changed"))?,
        );
        self.check(cancel)
    }
}
pub(super) fn verify(
    saved: &SavedRecovery,
    artifacts: &mut Artifacts,
    manifest: &Manifest,
    cancel: &AtomicBool,
) -> Result<()> {
    let mut context = Context::new(saved, artifacts, manifest, cancel)?;
    context.import(cancel)?;
    context.artifacts.read_verified(&expected(saved), cancel)?;
    context.verify()
}
#[cfg(test)]
#[path = "private_offline_graph_windows_tests.rs"]
mod tests;
