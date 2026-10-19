//! Source-present Git graph verification only. Never full material recovery.
use super::{Manifest, WindowsFirst};
use crate::{
    file_access::PinnedPath,
    worktrees::{
        git,
        recovery_roots::{MAX_BYTES, MAX_OBJECTS},
        types::*,
    },
};
use sha2::{Digest, Sha256};
use std::os::windows::fs::OpenOptionsExt;
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{Read, Seek},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

struct Bundle {
    pin: PinnedPath,
    stamp: crate::file_access::Stamp,
    sha256: String,
}
pub(in crate::worktrees) struct Produced {
    bridge: File,
    producer: crate::file_access::Stamp,
    stamp: crate::file_access::Stamp,
    sha256: String,
}
// Pins and their typed borrowed first owner outlive every synchronous child.
// Namespace pins close before TempDir deletion; no detached cleanup task.
struct Context<'a> {
    first: &'a WindowsFirst,
    manifest: &'a Manifest,
    first_pins: Vec<PinnedPath>,
    second_pins: Vec<PinnedPath>,
    second: PinnedPath,
    config: Option<(PinnedPath, crate::file_access::Stamp)>,
    bundle: Option<Bundle>,
    root: PinnedPath,
    _temp: tempfile::TempDir,
}
pub(super) struct GraphBundle<'a> {
    owner: Context<'a>,
}
impl GraphBundle<'_> {
    pub(super) fn path(&self) -> Result<&Path> {
        self.owner.verify()?;
        Ok(&self
            .owner
            .bundle
            .as_ref()
            .ok_or(error("unknown"))?
            .pin
            .guid_path)
    }
    pub(super) fn recheck(&mut self, cancel: &AtomicBool) -> Result<()> {
        self.owner.check_graph(false, cancel)
    }
}
// Only this module constructs this role, immediately after create_new of its
// fixed own leaf. Callers cannot submit an arbitrary File/Command/output path.
pub(in crate::worktrees) struct OutputRequest<'a> {
    first: &'a WindowsFirst,
    root: &'a PinnedPath,
    output: Option<File>,
    anchor: File,
    bridge: File,
}
impl OutputRequest<'_> {
    pub(in crate::worktrees) fn verify(&self) -> Result<()> {
        git::environment()?;
        self.first.imported.observed()?;
        self.first.export_namespace.verify()?;
        self.root.verify().map_err(|_| error("changed"))
    }
    pub(in crate::worktrees) fn program(&self) -> Result<&PinnedPath> {
        Ok(self.first.imported.observed()?.0)
    }
    pub(in crate::worktrees) fn repository(&self) -> Result<&Path> {
        self.first.imported.observed()?;
        Ok(self.first.path())
    }
    pub(in crate::worktrees) fn repository_pin(&self) -> Result<&PinnedPath> {
        let pin = self.first.imported.observed()?.1;
        if self.repository()? != pin.guid_path.as_path() {
            return Err(error("changed"));
        }
        Ok(pin)
    }
    pub(in crate::worktrees) fn take_output(&mut self) -> Result<File> {
        self.output.take().ok_or(error("unknown"))
    }
    pub(in crate::worktrees) fn finish(self, cancel: &AtomicBool) -> Result<Produced> {
        self.verify()?;
        // Actual Child/Job completion precedes this call. The retained RW
        // anchor still denies other writers/deletion while exact bytes hash.
        let (stamp, sha256) = digest_file(&self.anchor, cancel)?;
        if crate::file_access::stamp(&self.bridge).map_err(|_| error("recoveryChanged"))? != stamp {
            return Err(error("recoveryChanged"));
        }
        cancelled(cancel)?;
        let Self {
            output,
            anchor,
            bridge,
            ..
        } = self;
        drop(output);
        drop(anchor);
        // Non-atomic transition: bridge shares WRITE, so another writer can
        // now open. It denies DELETE, retaining this exact filesystem object.
        // Windows only guarantees write timestamps after all write handles
        // close: do not attribute any time change or use pre-close times as
        // the final policy baseline. Preserve the producer's bytes/identity.
        let closed = crate::file_access::stamp(&bridge).map_err(|_| error("recoveryChanged"))?;
        if !producer_shape(&stamp, &closed) {
            return Err(error("recoveryChanged"));
        }
        Ok(Produced {
            bridge,
            producer: stamp,
            stamp: closed,
            sha256,
        })
    }
}
enum Query {
    Fsck,
    Refs,
    Head,
    Symbolic,
    Objects,
}
enum Action<'a> {
    Init,
    Verify(git::Input),
    Unbundle(git::Input),
    Root(usize, &'a str),
    Head(usize),
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(error("cancelled"))
    } else {
        Ok(())
    }
}
fn producer_shape(before: &crate::file_access::Stamp, after: &crate::file_access::Stamp) -> bool {
    before.identity == after.identity
        && before.size == after.size
        && before.links == after.links
        && before.regular == after.regular
}
fn graph_pins(repo: &PinnedPath, has_recovery: bool) -> Result<Vec<PinnedPath>> {
    let mut pins = Vec::new();
    for parts in [
        ["objects", "pack"],
        ["objects", "info"],
        ["refs", "heads"],
        ["refs", "tags"],
    ] {
        let parent = repo
            .child(&parts[0].encode_utf16().collect::<Vec<_>>(), true)
            .map_err(|_| error("changed"))?;
        pins.push(
            parent
                .child(&parts[1].encode_utf16().collect::<Vec<_>>(), true)
                .map_err(|_| error("changed"))?,
        );
    }
    if has_recovery {
        let refs = repo
            .child(&"refs".encode_utf16().collect::<Vec<_>>(), true)
            .map_err(|_| error("changed"))?;
        let heads = refs
            .child(&"heads".encode_utf16().collect::<Vec<_>>(), true)
            .map_err(|_| error("changed"))?;
        pins.push(
            heads
                .child(&"recovery".encode_utf16().collect::<Vec<_>>(), true)
                .map_err(|_| error("changed"))?,
        );
        pins.push(
            repo.child(&"HEAD".encode_utf16().collect::<Vec<_>>(), false)
                .map_err(|_| error("changed"))?,
        );
    }
    Ok(pins)
}
fn no_borrowed_objects(repo: &PinnedPath) -> Result<()> {
    for name in ["objects/info/alternates", "shallow"] {
        match fs::symlink_metadata(repo.guid_path.join(name)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Err(error("recoveryInvalid")),
            Err(_) => return Err(error("unavailable")),
        }
    }
    Ok(())
}
fn digest_file(source: &File, cancel: &AtomicBool) -> Result<(crate::file_access::Stamp, String)> {
    let before = crate::file_access::stamp(source).map_err(|_| error("recoveryChanged"))?;
    if !before.regular || before.size == 0 || before.size > MAX_BYTES {
        return Err(error("recoveryLimit"));
    }
    let mut file = source.try_clone().map_err(|_| error("unavailable"))?;
    file.rewind().map_err(|_| error("unavailable"))?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        cancelled(cancel)?;
        let offer = (before.size - count)
            .saturating_add(1)
            .min(buffer.len() as u64) as usize;
        let n = file
            .read(&mut buffer[..offer])
            .map_err(|_| error("unavailable"))?;
        if n == 0 {
            break;
        }
        count = count.checked_add(n as u64).ok_or(error("recoveryLimit"))?;
        if count > before.size {
            return Err(error("recoveryChanged"));
        }
        hash.update(&buffer[..n]);
    }
    if count != before.size
        || crate::file_access::stamp(source).map_err(|_| error("recoveryChanged"))? != before
    {
        return Err(error("recoveryChanged"));
    }
    Ok((
        before,
        crate::worktrees::material_scan::hex(hash.finalize()),
    ))
}
fn digest(pin: &PinnedPath, cancel: &AtomicBool) -> Result<(crate::file_access::Stamp, String)> {
    pin.verify().map_err(|_| error("recoveryChanged"))?;
    let value = digest_file(pin.file(), cancel)?;
    pin.verify().map_err(|_| error("recoveryChanged"))?;
    Ok(value)
}
impl<'a> Context<'a> {
    fn new(first: &'a WindowsFirst, manifest: &'a Manifest, cancel: &AtomicBool) -> Result<Self> {
        super::validate(manifest)?;
        cancelled(cancel)?;
        let width = match manifest.roots.format.as_str() {
            "sha1" => 40,
            "sha256" => 64,
            _ => return Err(error("recoveryInvalid")),
        };
        if manifest.roots.head.len() != width {
            return Err(error("recoveryInvalid"));
        }
        first.imported.observed()?;
        first.export_namespace.verify()?;
        let parent_path = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| error("unsafePath"))?;
        let parent = PinnedPath::directory(&parent_path).map_err(|_| error("unsafePath"))?;
        first.imported.allow_temporary_parent(&parent)?;
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
        fs::create_dir(root.guid_path.join("second")).map_err(|_| error("unavailable"))?;
        let second = root
            .child(&"second".encode_utf16().collect::<Vec<_>>(), true)
            .map_err(|_| error("unsafePath"))?;
        if second.identity() == first.imported.observed()?.1.identity() {
            return Err(error("changed"));
        }
        let first_pins = graph_pins(first.imported.observed()?.1, true)?;
        let owner = Self {
            first,
            manifest,
            first_pins,
            second_pins: Vec::new(),
            second,
            config: None,
            bundle: None,
            root,
            _temp: temp,
        };
        owner.verify()?;
        cancelled(cancel)?;
        Ok(owner)
    }
    fn verify(&self) -> Result<()> {
        git::environment()?;
        self.first.imported.observed()?;
        self.first.export_namespace.verify()?;
        self.root.verify().map_err(|_| error("changed"))?;
        self.second.verify().map_err(|_| error("changed"))?;
        for pin in self.first_pins.iter().chain(&self.second_pins) {
            pin.verify().map_err(|_| error("changed"))?;
        }
        no_borrowed_objects(self.first.imported.observed()?.1)?;
        no_borrowed_objects(&self.second)?;
        if let Some((pin, stamp)) = &self.config {
            pin.verify().map_err(|_| error("changed"))?;
            if crate::file_access::stamp(pin.file()).map_err(|_| error("changed"))? != *stamp {
                return Err(error("changed"));
            }
        }
        if let Some(bundle) = &self.bundle {
            bundle.pin.verify().map_err(|_| error("recoveryChanged"))?;
            let fresh = self
                .root
                .child(&"verified.bundle".encode_utf16().collect::<Vec<_>>(), false)
                .map_err(|_| error("recoveryChanged"))?;
            if crate::file_access::stamp(bundle.pin.file()).map_err(|_| error("recoveryChanged"))?
                != bundle.stamp
                || crate::file_access::stamp(fresh.file()).map_err(|_| error("recoveryChanged"))?
                    != bundle.stamp
            {
                return Err(error("recoveryChanged"));
            }
        }
        Ok(())
    }
    fn base(
        &self,
        first: bool,
    ) -> Result<(
        std::process::Command,
        crate::worktrees::windows_git::paths::Paths,
    )> {
        self.verify()?;
        let (program, original) = self.first.imported.observed()?;
        let repo = if first { original } else { &self.second };
        let paths = crate::worktrees::windows_git::paths::Paths::new(&[program, repo])?;
        let mut command = std::process::Command::new(paths.path(program)?);
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(git::bundle_output::OPTIONS)
            .arg("--git-dir")
            .arg(paths.path(repo)?)
            .arg("-C")
            .arg(paths.path(repo)?)
            .current_dir(paths.path(repo)?);
        Ok((command, paths))
    }
    fn run(
        &mut self,
        command: std::process::Command,
        input: git::Input,
        paths: crate::worktrees::windows_git::paths::Paths,
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>> {
        cancelled(cancel)?;
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
    fn query(&mut self, first: bool, query: Query, cancel: &AtomicBool) -> Result<Vec<u8>> {
        let (mut command, paths) = self.base(first)?;
        let input = match query {
            Query::Fsck => {
                command.args([
                    "fsck",
                    "--full",
                    "--strict",
                    "--no-reflogs",
                    "--no-dangling",
                ]);
                git::Input::null()
            }
            Query::Refs => {
                command.args(["for-each-ref", "--format=%(objectname) %(refname)"]);
                git::Input::null()
            }
            Query::Head => {
                command.args(["rev-parse", "--verify", "HEAD"]);
                git::Input::null()
            }
            Query::Symbolic => {
                command.args(["symbolic-ref", "HEAD"]);
                git::Input::null()
            }
            Query::Objects => {
                command.args(["rev-list", "--objects", "--no-object-names", "--stdin"]);
                git::Input::from_bytes(&self.manifest.roots.input(), git::OUTPUT_LIMIT, cancel)?
            }
        };
        self.run(command, input, paths, cancel)
    }
    fn second_action(&mut self, action: Action<'_>, cancel: &AtomicBool) -> Result<Vec<u8>> {
        let (mut command, paths) = self.base(false)?;
        let input = match action {
            Action::Init => {
                command
                    .args(["init", "--bare", "--template="])
                    .arg(format!("--object-format={}", self.manifest.roots.format));
                git::Input::null()
            }
            Action::Verify(input) => {
                command.args(["bundle", "verify", "-"]);
                input
            }
            Action::Unbundle(input) => {
                command.args(["bundle", "unbundle", "-"]);
                input
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
        };
        self.run(command, input, paths, cancel)
    }
    fn expected_refs(&self) -> Vec<(String, String)> {
        let mut v = super::refs(self.manifest);
        v.sort();
        v
    }
    fn parse_refs(&self, raw: Vec<u8>) -> Result<Vec<(String, String)>> {
        let text = String::from_utf8(raw).map_err(|_| error("recoveryInvalid"))?;
        let mut rows = Vec::new();
        for line in text.lines() {
            let (object, name) = line.split_once(' ').ok_or(error("recoveryInvalid"))?;
            if !oid(object)
                || object.len() != self.manifest.roots.head.len()
                || rows.len() > super::recovery_roots::MAX_ROOTS
            {
                return Err(error("recoveryInvalid"));
            }
            rows.push((object.to_owned(), name.to_owned()));
        }
        rows.sort();
        Ok(rows)
    }
    fn check_graph(&mut self, first: bool, cancel: &AtomicBool) -> Result<()> {
        self.query(first, Query::Fsck, cancel)?;
        let raw = String::from_utf8(self.query(first, Query::Objects, cancel)?)
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
        let raw = self.query(first, Query::Refs, cancel)?;
        if self.parse_refs(raw)? != self.expected_refs() {
            return Err(error("recoveryInvalid"));
        }
        let head = String::from_utf8(self.query(first, Query::Head, cancel)?)
            .map_err(|_| error("recoveryInvalid"))?;
        let symbolic = String::from_utf8(self.query(first, Query::Symbolic, cancel)?)
            .map_err(|_| error("recoveryInvalid"))?;
        if head.trim() != self.manifest.roots.head
            || symbolic.trim() != super::expected_branch(self.manifest)?
        {
            return Err(error("recoveryInvalid"));
        }
        self.verify()
    }
    fn prepare_output(&self, cancel: &AtomicBool) -> Result<OutputRequest<'_>> {
        self.verify()?;
        cancelled(cancel)?;
        let path = self.root.guid_path.join("verified.bundle");
        let output = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)
            .map_err(|_| error("targetExists"))?;
        let anchor = output.try_clone().map_err(|_| error("unavailable"))?;
        // The original no-delete writer pins this name during bridge opening.
        let bridge = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)
            .map_err(|_| error("unavailable"))?;
        if crate::file_access::stamp(&anchor).map_err(|_| error("recoveryChanged"))?
            != crate::file_access::stamp(&bridge).map_err(|_| error("recoveryChanged"))?
        {
            return Err(error("recoveryChanged"));
        }
        Ok(OutputRequest {
            first: self.first,
            root: &self.root,
            output: Some(output),
            anchor,
            bridge,
        })
    }
    fn produce_bundle(&self, cancel: &AtomicBool) -> Result<Produced> {
        let produced = git::bundle_output::write(self.prepare_output(cancel)?, cancel)?;
        self.verify()?;
        Ok(produced)
    }
    fn observe_bundle(&mut self, produced: Produced, cancel: &AtomicBool) -> Result<()> {
        if self.bundle.is_some() {
            return Err(error("unknown"));
        }
        if !producer_shape(&produced.producer, &produced.stamp)
            || crate::file_access::stamp(&produced.bridge).map_err(|_| error("recoveryChanged"))?
                != produced.stamp
        {
            return Err(error("recoveryChanged"));
        }
        // This strict READ/share-READ pin cannot coexist with an open WRITE
        // handle. Success closes the writable-sharing window, but is not a
        // claim about prior concurrency. Full post-close stamp and producer
        // SHA must both match before this role becomes a usable bundle.
        let pin = self
            .root
            .child(&"verified.bundle".encode_utf16().collect::<Vec<_>>(), false)
            .map_err(|_| error("recoveryChanged"))?;
        let (stamp, sha256) = digest(&pin, cancel)?;
        if stamp != produced.stamp
            || sha256 != produced.sha256
            || crate::file_access::stamp(&produced.bridge).map_err(|_| error("recoveryChanged"))?
                != produced.stamp
        {
            return Err(error("recoveryChanged"));
        }
        self.bundle = Some(Bundle { pin, stamp, sha256 });
        self.verify()
    }
    fn bundle_input(&mut self, cancel: &AtomicBool) -> Result<git::Input> {
        self.verify()?;
        let bundle = self.bundle.as_ref().ok_or(error("unknown"))?;
        if digest(&bundle.pin, cancel)? != (bundle.stamp.clone(), bundle.sha256.clone()) {
            return Err(error("recoveryChanged"));
        }
        let mut file = bundle
            .pin
            .file()
            .try_clone()
            .map_err(|_| error("unavailable"))?;
        file.rewind().map_err(|_| error("unavailable"))?;
        let input = git::Input::from_file(file, MAX_BYTES, cancel)?;
        if digest(&bundle.pin, cancel)? != (bundle.stamp.clone(), bundle.sha256.clone()) {
            return Err(error("recoveryChanged"));
        }
        self.verify()?;
        Ok(input)
    }
    fn initialize_second(&mut self, cancel: &AtomicBool) -> Result<()> {
        if self.config.is_some() {
            return Err(error("unknown"));
        }
        self.second_action(Action::Init, cancel)?;
        let pin = self
            .second
            .child(&"config".encode_utf16().collect::<Vec<_>>(), false)
            .map_err(|_| error("changed"))?;
        let stamp = crate::file_access::stamp(pin.file()).map_err(|_| error("changed"))?;
        self.config = Some((pin, stamp));
        self.second_pins = graph_pins(&self.second, false)?;
        fs::create_dir(self.second.guid_path.join("refs/heads/recovery"))
            .map_err(|_| error("targetExists"))?;
        // Hold the generated ref parent before any update-ref command. HEAD is
        // pinned only after its one official symbolic-ref replacement below.
        let refs = self
            .second
            .child(&"refs".encode_utf16().collect::<Vec<_>>(), true)
            .map_err(|_| error("changed"))?;
        let heads = refs
            .child(&"heads".encode_utf16().collect::<Vec<_>>(), true)
            .map_err(|_| error("changed"))?;
        self.second_pins.push(
            heads
                .child(&"recovery".encode_utf16().collect::<Vec<_>>(), true)
                .map_err(|_| error("changed"))?,
        );
        self.verify()
    }
    fn import_bundle(&mut self, cancel: &AtomicBool) -> Result<()> {
        let input = self.bundle_input(cancel)?;
        self.second_action(Action::Verify(input), cancel)?;
        let input = self.bundle_input(cancel)?;
        let raw = self.second_action(Action::Unbundle(input), cancel)?;
        let mut expected = self.expected_refs();
        expected.push((self.manifest.roots.head.clone(), "HEAD".into()));
        expected.sort();
        if self.parse_refs(raw)? != expected {
            return Err(error("recoveryInvalid"));
        }
        let manifest = self.manifest;
        for (index, object) in manifest.roots.commits.iter().enumerate() {
            self.second_action(Action::Root(index, object), cancel)?;
        }
        let head = self
            .manifest
            .roots
            .commits
            .iter()
            .position(|o| o == &self.manifest.roots.head)
            .ok_or(error("recoveryInvalid"))?;
        self.second_action(Action::Head(head), cancel)?;
        self.second_pins.push(
            self.second
                .child(&"HEAD".encode_utf16().collect::<Vec<_>>(), false)
                .map_err(|_| error("changed"))?,
        );
        self.check_graph(false, cancel)
    }
}
pub(super) fn generate<'a>(
    first: &'a WindowsFirst,
    manifest: &'a Manifest,
    cancel: &AtomicBool,
) -> Result<GraphBundle<'a>> {
    let mut owner = Context::new(first, manifest, cancel)?;
    owner.check_graph(true, cancel)?;
    let produced = owner.produce_bundle(cancel)?;
    owner.observe_bundle(produced, cancel)?;
    owner.initialize_second(cancel)?;
    owner.import_bundle(cancel)?;
    Ok(GraphBundle { owner })
}
#[cfg(test)]
#[path = "private_bundle_graph_windows_tests.rs"]
mod tests;
