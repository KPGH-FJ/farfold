//! Three fixed attribute roles; one private selected-HEAD index. No Command escapes.
use super::*;
use std::{cell::Cell, fs, marker::PhantomData};

#[derive(Clone, Copy)]
pub(super) enum Role {
    Original,
    Local,
    Mirror,
}
impl Role {
    fn index(self) -> usize {
        match self {
            Self::Original => 0,
            Self::Local => 1,
            Self::Mirror => 2,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Local => "local",
            Self::Mirror => "mirror",
        }
    }
}
#[derive(Clone, Copy)]
enum Action<'a> {
    Init,
    Type,
    Tree,
    ReadTree,
    Index,
    Attributes {
        paths: &'a [u8],
        external: Option<Option<&'a Path>>,
    },
    Contents {
        input: &'a [u8],
    },
    Filtered {
        oid: &'a str,
        path: &'a str,
    },
}
struct FixedFile {
    pin: PinnedPath,
    before: Stamp,
}
impl FixedFile {
    fn verify(&self) -> Result<()> {
        self.pin.verify().map_err(|_| error("changed"))?;
        if stamp(self.pin.file()).map_err(|_| error("changed"))? != self.before {
            return Err(error("changed"));
        }
        Ok(())
    }
    fn existing(parent: &PinnedPath, name: &str, limit: u64) -> Result<Self> {
        let pin = parent
            .child(&name.encode_utf16().collect::<Vec<_>>(), false)
            .map_err(|_| error("changed"))?;
        let before = stamp(pin.file()).map_err(|_| error("changed"))?;
        if !before.regular || before.size > limit {
            return Err(error("tooLarge"));
        }
        Ok(Self { pin, before })
    }
    fn create(
        owner: &mut crate::file_access::WorktreeCheckout<'_>,
        bytes: &[u8],
        cancel: &AtomicBool,
    ) -> Result<Self> {
        if bytes.len() as u64 > LIMIT {
            return Err(error("tooLarge"));
        }
        owner.root().verify().map_err(|_| error("changed"))?;
        cancelled(cancel)?;
        let mut producer = tempfile::tempfile().map_err(|_| error("unavailable"))?;
        for chunk in bytes.chunks(65_536) {
            cancelled(cancel)?;
            producer
                .write_all(chunk)
                .map_err(|_| error("unavailable"))?;
        }
        producer.sync_all().map_err(|_| error("unavailable"))?;
        let copied = owner.copy_regular("attributes", &producer, bytes.len() as u64, cancel);
        cancelled(cancel)?;
        copied.map_err(|_| error("changed"))?;
        verify_info(owner, cancel)?;
        let result = Self::existing(owner.root(), "attributes", LIMIT)?;
        let mut reader = result
            .pin
            .file()
            .try_clone()
            .map_err(|_| error("unavailable"))?;
        reader.rewind().map_err(|_| error("unavailable"))?;
        let mut observed = Vec::new();
        reader
            .take(LIMIT + 1)
            .read_to_end(&mut observed)
            .map_err(|_| error("unavailable"))?;
        if observed != bytes {
            return Err(error("changed"));
        }
        result.verify()?;
        verify_info(owner, cancel)?;
        cancelled(cancel)?;
        Ok(result)
    }
}
// Empty-template Git init deliberately creates no info directory. Create it
// against the held repository parent, never adopt a pre-existing name, and
// retain its original FILE_CREATE owner and registered children until exit.
pub(super) fn create_info(
    repo: &PinnedPath,
) -> Result<crate::file_access::WorktreeCheckout<'static>> {
    crate::file_access::WorktreeCheckout::create_under(repo, "info").map_err(|_| error("changed"))
}
fn verify_info(
    owner: &crate::file_access::WorktreeCheckout<'_>,
    cancel: &AtomicBool,
) -> Result<()> {
    let verified = owner.verify_namespace(cancel);
    cancelled(cancel)?;
    verified.map_err(|_| error("changed"))
}
struct Namespace {
    repo: PinnedPath,
    info: crate::file_access::WorktreeCheckout<'static>,
    config: FixedFile,
    attributes: Option<FixedFile>,
}
pub(super) struct Evaluator<'a> {
    owner: &'a dyn EvaluationSource,
    root: PinnedPath,
    objects: PinnedPath,
    roles: Vec<Namespace>,
    index: Option<FixedFile>,
    configs: Vec<String>,
    // The private executor is sequential and cannot be shared across threads.
    _not_sync: PhantomData<Cell<()>>,
    // All held pins close before automatic deletion of this owned namespace.
    _temp: tempfile::TempDir,
}
impl<'a> Evaluator<'a> {
    pub(super) fn new(
        owner: &'a dyn EvaluationSource,
        configs: &[String],
        cancel: &AtomicBool,
    ) -> Result<Self> {
        owner.recheck(cancel)?;
        let parent_path = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| error("unsafePath"))?;
        let parent = PinnedPath::directory(&parent_path).map_err(|_| error("unsafePath"))?;
        if owner.context().scope.contains_project(&parent) {
            return Err(error("unsafePath"));
        }
        let temp = tempfile::tempdir_in(&parent.guid_path).map_err(|_| error("unavailable"))?;
        use std::os::windows::ffi::OsStrExt;
        let name = temp
            .path()
            .file_name()
            .ok_or(error("unsafePath"))?
            .encode_wide()
            .collect::<Vec<_>>();
        let root = parent.child(&name, true).map_err(|_| error("unsafePath"))?;
        let objects = owner
            .context()
            .scope
            .common
            .child(&"objects".encode_utf16().collect::<Vec<_>>(), true)
            .map_err(|_| error("changed"))?;
        let mut this = Self {
            owner,
            root,
            objects,
            roles: Vec::new(),
            index: None,
            configs: configs.to_vec(),
            _not_sync: PhantomData,
            _temp: temp,
        };
        for role in [Role::Original, Role::Local, Role::Mirror] {
            cancelled(cancel)?;
            fs::create_dir(this.root.guid_path.join(role.name()))
                .map_err(|_| error("unavailable"))?;
            let repo = this
                .root
                .child(&role.name().encode_utf16().collect::<Vec<_>>(), true)
                .map_err(|_| error("unsafePath"))?;
            this.run_at(&repo, Action::Init, cancel)?;
            let info = create_info(&repo)?;
            let config = FixedFile::existing(&repo, "config", LIMIT)?;
            this.roles.push(Namespace {
                repo,
                info,
                config,
                attributes: None,
            });
        }
        this.run(Role::Original, Action::ReadTree, cancel)?;
        this.index = Some(FixedFile::existing(&this.root, "index", 32 * 1024 * 1024)?);
        // Pin first, then compare actual private stage-0 index semantics with
        // the selected tree. A reopened pathname alone is not producer proof.
        let tree = this.run(Role::Original, Action::Tree, cancel)?;
        let index = this.run(Role::Original, Action::Index, cancel)?;
        verify_index(&tree, &index, cancel)?;
        this.verify(cancel)?;
        Ok(this)
    }
    fn verify(&self, cancel: &AtomicBool) -> Result<()> {
        self.owner.recheck(cancel)?;
        self.root.verify().map_err(|_| error("changed"))?;
        self.objects.verify().map_err(|_| error("changed"))?;
        for role in &self.roles {
            role.repo.verify().map_err(|_| error("changed"))?;
            verify_info(&role.info, cancel)?;
            role.config.verify()?;
            if let Some(file) = &role.attributes {
                file.verify()?;
            }
        }
        if let Some(file) = &self.index {
            file.verify()?;
        }
        Ok(())
    }
    fn command_at(
        &self,
        repo: &PinnedPath,
        action: Action<'_>,
        worktree: Option<&PinnedPath>,
        cancel: &AtomicBool,
    ) -> Result<(
        Command,
        git::Input,
        crate::worktrees::windows_git::paths::Paths,
    )> {
        self.verify(cancel)?;
        repo.verify().map_err(|_| error("changed"))?;
        let worktree = worktree.unwrap_or(&self.owner.context().scope.root);
        let paths = crate::worktrees::windows_git::paths::Paths::new(&[
            self.owner.context().selected_program(),
            repo,
            &self.owner.context().scope.root,
            &self.objects,
            &self.root,
            worktree,
        ])?;
        let mut command = Command::new(paths.path(self.owner.context().selected_program())?);
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_DIR", paths.path(repo)?)
            .args([
                "--no-pager",
                "--no-replace-objects",
                "-c",
                "core.hooksPath=/dev/null",
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
                "checkout.workers=1",
            ])
            .arg("-C")
            .arg(paths.path(
                if matches!(action, Action::Contents { .. } | Action::Filtered { .. }) {
                    worktree
                } else {
                    repo
                },
            )?)
            .current_dir(paths.path(
                if matches!(action, Action::Contents { .. } | Action::Filtered { .. }) {
                    worktree
                } else {
                    repo
                },
            )?);
        // Init owns ONLY its new repo: never point its creation path at the
        // original object directory. Other actions only read shared objects.
        if !matches!(action, Action::Init) {
            command
                .env("GIT_WORK_TREE", paths.path(worktree)?)
                .env("GIT_OBJECT_DIRECTORY", paths.path(&self.objects)?)
                .env("GIT_INDEX_FILE", paths.path(&self.root)?.join("index"))
                .args(["-c", "core.bare=false"]);
            for value in &self.configs {
                command.args(["-c", value]);
            }
        }
        let external = matches!(
            action,
            Action::Attributes {
                external: Some(_),
                ..
            }
        );
        if !external {
            command
                .env("GIT_ATTR_NOSYSTEM", "1")
                .args(["-c", "core.attributesFile=/dev/null"]);
        }
        let head = self.owner.selected_oid();
        let input = match action {
            Action::Init => {
                command
                    .args(["init", "--bare", "--template="])
                    .arg(format!("--object-format={}", self.owner.object_format()));
                git::Input::null()
            }
            Action::Type => {
                command.args(["cat-file", "-t", head]);
                git::Input::null()
            }
            Action::Tree => {
                command.args(["ls-tree", "-r", "-l", "-z", head]);
                git::Input::null()
            }
            Action::ReadTree => {
                command.args(["read-tree", head]);
                git::Input::null()
            }
            Action::Index => {
                command.args(["ls-files", "--stage", "-z"]);
                git::Input::null()
            }
            Action::Attributes { paths, external } => {
                if let Some(Some(path)) = external {
                    command.arg("-c").arg(format!(
                        "core.attributesFile={}",
                        path.to_str().ok_or(error("unsafePath"))?
                    ));
                }
                command.args(["check-attr", "--cached", "--all", "-z", "--stdin"]);
                git::Input::from_bytes(paths, git::OUTPUT_LIMIT, cancel)?
            }
            Action::Contents { input } => {
                command.args(["cat-file", "--batch", "-z"]);
                git::Input::from_bytes(input, git::OUTPUT_LIMIT, cancel)?
            }
            Action::Filtered { oid, path } => {
                command
                    .args(["cat-file", "--filters"])
                    .arg(format!("--path={path}"))
                    .arg(oid);
                git::Input::null()
            }
        };
        Ok((command, input, paths))
    }
    fn run_at(
        &self,
        repo: &PinnedPath,
        action: Action<'_>,
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>> {
        let (command, input, paths) = self.command_at(repo, action, None, cancel)?;
        let output = git::execute_command_input(
            command,
            input,
            cancel,
            crate::worktrees::recovery_pack::COMMAND_TIME,
        );
        paths.verify()?;
        self.verify(cancel)?;
        repo.verify().map_err(|_| error("changed"))?;
        let output = output?;
        if !output.success {
            return Err(error("unsupportedGit"));
        }
        Ok(output.bytes)
    }
    // Closed official cat-file operation, not an arbitrary Command/File API.
    // The actual child's stdout remains an anonymous FileObject through Job
    // quiescence and framing/copy; no named Git temp output is trusted.
    pub(super) fn contents(
        &self,
        worktree: &PinnedPath,
        entries: &[Entry],
        cancel: &AtomicBool,
    ) -> Result<fs::File> {
        let mut input = Vec::new();
        for entry in entries {
            input.extend_from_slice(entry.oid.as_bytes());
            input.push(0);
            if input.len() as u64 > git::OUTPUT_LIMIT {
                return Err(error("tooLarge"));
            }
        }
        self.output_file(
            worktree,
            Action::Contents { input: &input },
            1024 * 1024 * 1024 + 16 * 1024 * 1024,
            cancel,
        )
    }
    // --batch --filters reports the RAW object's size even when conversion
    // changes length. Only one filtered object may use this EOF-framed output.
    pub(super) fn filtered(
        &self,
        worktree: &PinnedPath,
        entry: &Entry,
        cancel: &AtomicBool,
    ) -> Result<fs::File> {
        self.output_file(
            worktree,
            Action::Filtered {
                oid: &entry.oid,
                path: &entry.path,
            },
            256 * 1024 * 1024,
            cancel,
        )
    }
    fn output_file(
        &self,
        worktree: &PinnedPath,
        action: Action<'_>,
        limit: u64,
        cancel: &AtomicBool,
    ) -> Result<fs::File> {
        let repo = &self.roles[Role::Mirror.index()].repo;
        let (command, input, paths) = self.command_at(repo, action, Some(worktree), cancel)?;
        let file = tempfile::tempfile().map_err(|_| error("unavailable"))?;
        let output = git::execute_bounded(
            command,
            Some(input),
            cancel,
            crate::worktrees::recovery_pack::COMMAND_TIME,
            file.try_clone().map_err(|_| error("unavailable"))?,
            limit,
            false,
        );
        paths.verify()?;
        self.verify(cancel)?;
        worktree.verify().map_err(|_| error("changed"))?;
        if !output?.success {
            return Err(error("unsupportedGit"));
        }
        Ok(file)
    }
    pub(super) fn entries(&self, cancel: &AtomicBool) -> Result<Vec<Entry>> {
        let raw = self.run(Role::Mirror, Action::Index, cancel)?;
        let mut result = Vec::new();
        for record in raw.split(|b| *b == 0).filter(|v| !v.is_empty()) {
            cancelled(cancel)?;
            let tab = record
                .iter()
                .position(|b| *b == b'\t')
                .ok_or(error("unsupportedGit"))?;
            let fields = std::str::from_utf8(&record[..tab])
                .map_err(|_| error("unsupportedGit"))?
                .split(' ')
                .collect::<Vec<_>>();
            if fields.len() != 3
                || fields[2] != "0"
                || !crate::worktrees::types::oid(fields[1])
                || !matches!(fields[0], "100644" | "100755" | "120000")
            {
                return Err(error("unsupportedGit"));
            }
            let path = std::str::from_utf8(&record[tab + 1..])
                .map_err(|_| error("unsafePath"))?
                .to_owned();
            crate::file_access::WorktreeCheckout::validate_path(&path)
                .map_err(|_| error("unsafePath"))?;
            result.push(Entry {
                path,
                oid: fields[1].to_owned(),
                symlink: fields[0] == "120000",
            });
        }
        Ok(result)
    }
    pub(super) fn index(&self) -> Result<&fs::File> {
        let index = self.index.as_ref().ok_or(error("changed"))?;
        index.verify()?;
        Ok(index.pin.file())
    }
    pub(super) fn root(&self) -> &PinnedPath {
        &self.root
    }
    fn run(&self, role: Role, action: Action<'_>, cancel: &AtomicBool) -> Result<Vec<u8>> {
        self.run_at(&self.roles[role.index()].repo, action, cancel)
    }
    pub(super) fn paths(&self, cancel: &AtomicBool) -> Result<Vec<u8>> {
        let head = self.owner.selected_oid();
        crate::worktrees::inspect::target_objects(head, |args| {
            let action = if args == ["cat-file", "-t", head] {
                Action::Type
            } else if args == ["ls-tree", "-r", "-l", "-z", head] {
                Action::Tree
            } else {
                return Err(error("unsupportedGit"));
            };
            self.run(Role::Original, action, cancel)
        })
    }
    pub(super) fn install(&mut self, role: Role, bytes: &[u8], cancel: &AtomicBool) -> Result<()> {
        self.verify(cancel)?;
        let target = &mut self.roles[role.index()];
        if target.attributes.is_some() {
            return Err(error("changed"));
        }
        target.attributes = Some(FixedFile::create(&mut target.info, bytes, cancel)?);
        self.verify(cancel)
    }
    pub(super) fn attributes(
        &self,
        role: Role,
        paths: &[u8],
        external: Option<Option<&Path>>,
        cancel: &AtomicBool,
    ) -> Result<Attributes> {
        if self.roles[role.index()].attributes.is_none() {
            return Err(error("changed"));
        }
        crate::worktrees::checkout::attrs(&self.run(
            role,
            Action::Attributes { paths, external },
            cancel,
        )?)
    }
}
#[derive(Clone)]
pub(super) struct Entry {
    pub path: String,
    pub oid: String,
    pub symlink: bool,
}
fn verify_index(tree: &[u8], index: &[u8], cancel: &AtomicBool) -> Result<()> {
    fn fields(
        raw: &[u8],
        tree: bool,
        cancel: &AtomicBool,
    ) -> Result<BTreeMap<Vec<u8>, (String, String)>> {
        if !raw.is_empty() && raw.last() != Some(&0) {
            return Err(error("unsupportedGit"));
        }
        let mut result = BTreeMap::new();
        for record in raw.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            cancelled(cancel)?;
            let tab = record
                .iter()
                .position(|b| *b == b'\t')
                .ok_or(error("unsupportedGit"))?;
            let head = std::str::from_utf8(&record[..tab]).map_err(|_| error("unsupportedGit"))?;
            let f = head.split_ascii_whitespace().collect::<Vec<_>>();
            let (mode, oid) = if tree {
                if f.len() != 4 || f[1] != "blob" {
                    return Err(error("unsupportedGit"));
                }
                (f[0], f[2])
            } else {
                if f.len() != 3 || f[2] != "0" {
                    return Err(error("unsupportedGit"));
                }
                (f[0], f[1])
            };
            let path = &record[tab + 1..];
            if path.is_empty()
                || !crate::worktrees::types::oid(oid)
                || result
                    .insert(path.to_vec(), (mode.to_owned(), oid.to_owned()))
                    .is_some()
                || result.len() > 100_000
            {
                return Err(error("unsupportedGit"));
            }
        }
        Ok(result)
    }
    if fields(tree, true, cancel)? != fields(index, false, cancel)? {
        return Err(error("changed"));
    }
    Ok(())
}
