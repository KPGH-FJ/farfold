//! Three fixed attribute roles; one private selected-HEAD index. No Command escapes.
use super::*;
use std::{cell::Cell, fs, marker::PhantomData, os::windows::fs::OpenOptionsExt};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

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
    fn create(parent: &PinnedPath, bytes: &[u8], cancel: &AtomicBool) -> Result<Self> {
        if bytes.len() as u64 > LIMIT {
            return Err(error("tooLarge"));
        }
        parent.verify().map_err(|_| error("changed"))?;
        cancelled(cancel)?;
        let path = parent.guid_path.join("attributes");
        let mut producer = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)
            .map_err(|_| error("changed"))?;
        for chunk in bytes.chunks(65_536) {
            cancelled(cancel)?;
            producer
                .write_all(chunk)
                .map_err(|_| error("unavailable"))?;
        }
        producer.sync_all().map_err(|_| error("unavailable"))?;
        let pre = stamp(&producer).map_err(|_| error("changed"))?;
        if !pre.regular || pre.links != 1 || pre.size != bytes.len() as u64 {
            return Err(error("changed"));
        }
        // This bridge keeps the producer's object/name against DELETE. Its
        // writable-sharing transition is NON-ATOMIC; producer bytes and exact
        // post-close stamp must both match the subsequent strict read pin.
        let bridge = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)
            .map_err(|_| error("changed"))?;
        if !crate::file_access::same_object(&producer, &bridge).map_err(|_| error("changed"))? {
            return Err(error("changed"));
        }
        drop(producer);
        let post = stamp(&bridge).map_err(|_| error("changed"))?;
        if post.identity != pre.identity
            || post.size != pre.size
            || post.links != 1
            || !post.regular
        {
            return Err(error("changed"));
        }
        let result = Self::existing(parent, "attributes", LIMIT)?;
        if result.before != post
            || !crate::file_access::same_object(&bridge, result.pin.file())
                .map_err(|_| error("changed"))?
        {
            return Err(error("changed"));
        }
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
        parent.verify().map_err(|_| error("changed"))?;
        cancelled(cancel)?;
        Ok(result)
    }
}
struct Namespace {
    repo: PinnedPath,
    info: PinnedPath,
    config: FixedFile,
    attributes: Option<FixedFile>,
}
pub(super) struct Evaluator<'a> {
    owner: &'a SourceOwner,
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
        owner: &'a SourceOwner,
        configs: &[String],
        cancel: &AtomicBool,
    ) -> Result<Self> {
        owner.recheck(cancel)?;
        let parent_path = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| error("unsafePath"))?;
        let parent = PinnedPath::directory(&parent_path).map_err(|_| error("unsafePath"))?;
        if owner.source.scope.contains_project(&parent) {
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
            .source
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
            let info = repo
                .child(&"info".encode_utf16().collect::<Vec<_>>(), true)
                .map_err(|_| error("changed"))?;
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
            role.info.verify().map_err(|_| error("changed"))?;
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
    fn run_at(
        &self,
        repo: &PinnedPath,
        action: Action<'_>,
        cancel: &AtomicBool,
    ) -> Result<Vec<u8>> {
        self.verify(cancel)?;
        repo.verify().map_err(|_| error("changed"))?;
        let mut command = Command::new(&self.owner.source.selected_program().guid_path);
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_DIR", &repo.guid_path)
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
            .arg(&repo.guid_path)
            .current_dir(&repo.guid_path);
        // Init owns ONLY its new repo: never point its creation path at the
        // original object directory. Other actions only read shared objects.
        if !matches!(action, Action::Init) {
            command
                .env("GIT_WORK_TREE", &self.owner.source.scope.root.guid_path)
                .env("GIT_OBJECT_DIRECTORY", &self.objects.guid_path)
                .env("GIT_INDEX_FILE", self.root.guid_path.join("index"))
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
        let head = self.owner.roots.head.as_str();
        let input = match action {
            Action::Init => {
                command
                    .args(["init", "--bare", "--template="])
                    .arg(format!("--object-format={}", self.owner.roots.format));
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
        };
        let output = git::execute_command_input(
            command,
            input,
            cancel,
            crate::worktrees::recovery_pack::COMMAND_TIME,
        );
        self.verify(cancel)?;
        repo.verify().map_err(|_| error("changed"))?;
        let output = output?;
        if !output.success {
            return Err(error("unsupportedGit"));
        }
        Ok(output.bytes)
    }
    fn run(&self, role: Role, action: Action<'_>, cancel: &AtomicBool) -> Result<Vec<u8>> {
        self.run_at(&self.roles[role.index()].repo, action, cancel)
    }
    pub(super) fn paths(&self, cancel: &AtomicBool) -> Result<Vec<u8>> {
        let head = self.owner.roots.head.as_str();
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
        target.attributes = Some(FixedFile::create(&target.info, bytes, cancel)?);
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
