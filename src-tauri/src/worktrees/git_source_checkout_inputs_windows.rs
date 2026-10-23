//! Fixed source checkout inputs. No arbitrary key/path API escapes this module.
use super::*;
use crate::file_access::{MetadataKind, metadata_child};
use std::{ffi::OsStr, path::Component};

#[derive(Clone, Copy)]
enum Key {
    Autocrlf,
    Eol,
    Safecrlf,
    Symlinks,
    Filemode,
    Ignorecase,
    Precompose,
    Protecthfs,
    Protectntfs,
    Attributes,
    UnsetSmudge,
    UnsetProcess,
    UnsetRequired,
}
impl Key {
    fn name(self) -> &'static str {
        match self {
            Self::Autocrlf => "core.autocrlf",
            Self::Eol => "core.eol",
            Self::Safecrlf => "core.safecrlf",
            Self::Symlinks => "core.symlinks",
            Self::Filemode => "core.filemode",
            Self::Ignorecase => "core.ignorecase",
            Self::Precompose => "core.precomposeunicode",
            Self::Protecthfs => "core.protecthfs",
            Self::Protectntfs => "core.protectntfs",
            Self::Attributes => "core.attributesFile",
            Self::UnsetSmudge => "filter.unset.smudge",
            Self::UnsetProcess => "filter.unset.process",
            Self::UnsetRequired => "filter.unset.required",
        }
    }
}
fn config(
    owner: &dyn EvaluationSource,
    key: Key,
    boolean: bool,
    cancel: &AtomicBool,
) -> Result<Option<String>> {
    cancelled(cancel)?;
    git::environment()?;
    owner.context().scope.matches(owner.snapshot())?;
    owner
        .context()
        .selected_program()
        .verify()
        .map_err(|_| error("changed"))?;
    let paths = crate::worktrees::windows_git::paths::Paths::new(&[
        owner.context().selected_program(),
        &owner.context().scope.root,
        &owner.context().scope.git,
        &owner.context().scope.common,
    ])?;
    let mut command = Command::new(paths.path(owner.context().selected_program())?);
    // SOURCE effective configuration is deliberately inherited, unlike the
    // isolated destination context. Only these closed non-credential keys.
    command
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_COMMON_DIR", paths.path(&owner.context().scope.common)?)
        .args(["--no-pager", "--no-replace-objects", "-c"])
        .arg(format!(
            "core.hooksPath={}",
            paths.path(owner.context().selected_program())?.display()
        ))
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-c",
            "submodule.recurse=false",
            "-c",
            "credential.helper=",
        ])
        .arg("--git-dir")
        .arg(paths.path(&owner.context().scope.git)?)
        .arg("--work-tree")
        .arg(paths.path(&owner.context().scope.root)?)
        .arg("-C")
        .arg(paths.path(&owner.context().scope.root)?)
        .current_dir(paths.path(&owner.context().scope.root)?)
        .arg("config");
    if boolean {
        command.arg("--type=bool");
    }
    if matches!(key, Key::Attributes) {
        command.arg("--path");
    }
    command.args(["--get", key.name()]);
    let output =
        git::execute_command_input(command, git::Input::null(), cancel, Duration::from_secs(10));
    paths.verify()?;
    owner.context().scope.matches(owner.snapshot())?;
    owner
        .context()
        .selected_program()
        .verify()
        .map_err(|_| error("changed"))?;
    let output = output?;
    match output.code {
        Some(1) if output.bytes.is_empty() => Ok(None),
        Some(0) => String::from_utf8(output.bytes)
            .map(|s| Some(s.strip_suffix('\n').unwrap_or(&s).to_owned()))
            .map_err(|_| error("unsupportedGit")),
        _ => Err(error("unavailable")),
    }
}
fn safe(owner: &dyn EvaluationSource, cancel: &AtomicBool) -> Result<Vec<String>> {
    let mut result = Vec::new();
    for (key, values) in [
        (Key::Autocrlf, &["true", "false", "input"][..]),
        (Key::Eol, &["lf", "crlf", "native"]),
        (Key::Safecrlf, &["true", "false", "warn"]),
        (Key::Symlinks, &["true", "false"]),
        (Key::Filemode, &["true", "false"]),
        (Key::Ignorecase, &["true", "false"]),
        (Key::Precompose, &["true", "false"]),
        (Key::Protecthfs, &["true", "false"]),
        (Key::Protectntfs, &["true", "false"]),
    ] {
        let boolean = values == ["true", "false"];
        if let Some(mut value) = config(owner, key, boolean, cancel)? {
            if !values.contains(&value.as_str()) && !matches!(key, Key::Eol) {
                value = config(owner, key, true, cancel)?.ok_or(error("changed"))?;
            }
            if !values.contains(&value.as_str()) {
                return Err(error("unsupportedGit"));
            }
            result.push(format!("{}={value}", key.name()));
        }
    }
    Ok(result)
}

enum Root<'a> {
    Borrowed(&'a PinnedPath),
    Owned(PinnedPath),
}
impl Root<'_> {
    fn pin(&self) -> &PinnedPath {
        match self {
            Self::Borrowed(p) => p,
            Self::Owned(p) => p,
        }
    }
}
// An exact missing component under a held parent is absence; query failures,
// denied ancestors, reparse objects and aliases never become absent input.
struct OptionalFile<'a> {
    root: Root<'a>,
    directories: Vec<PinnedPath>,
    file: Option<(PinnedPath, Stamp)>,
    missing: Option<(usize, Vec<u16>, PathBuf)>,
}
#[derive(Clone, Copy)]
pub(super) struct AttributeSource<'a> {
    anchor: &'a PinnedPath,
    missing_suffix: Option<&'a Path>,
}
impl AttributeSource<'_> {
    pub(super) fn anchor(&self) -> &PinnedPath {
        self.anchor
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.anchor.verify().map_err(|_| error("changed"))?;
        if let Some(suffix) = self.missing_suffix {
            let Some(Component::Normal(first)) = suffix.components().next() else {
                return Err(error("changed"));
            };
            if metadata_child(self.anchor.file(), first)
                .map_err(|_| error("changed"))?
                .is_some()
            {
                return Err(error("changed"));
            }
        }
        Ok(())
    }
    pub(super) fn git_path(
        &self,
        paths: &crate::worktrees::windows_git::paths::Paths,
    ) -> Result<PathBuf> {
        self.verify()?;
        let plain = paths.path(self.anchor)?;
        Ok(match self.missing_suffix {
            Some(suffix) => plain.join(suffix),
            None => plain.to_owned(),
        })
    }
}
impl<'a> OptionalFile<'a> {
    fn open(root: Root<'a>, names: Vec<String>, cancel: &AtomicBool) -> Result<Self> {
        if names.is_empty() {
            return Err(error("unsafePath"));
        }
        let mut result = Self {
            root,
            directories: Vec::new(),
            file: None,
            missing: None,
        };
        for (n, name) in names.iter().enumerate() {
            cancelled(cancel)?;
            let parent = result
                .directories
                .last()
                .unwrap_or_else(|| result.root.pin());
            let metadata = metadata_child(parent.file(), OsStr::new(name))
                .map_err(|_| error("unavailable"))?;
            let raw = name.encode_utf16().collect::<Vec<_>>();
            let Some(metadata) = metadata else {
                result.missing = Some((result.directories.len(), raw, names[n..].iter().collect()));
                return Ok(result);
            };
            let directory = n + 1 != names.len();
            if metadata.kind
                != if directory {
                    MetadataKind::Directory
                } else {
                    MetadataKind::File
                }
            {
                return Err(error("unsafePath"));
            }
            let pin = parent
                .child(&raw, directory)
                .map_err(|_| error("unsafePath"))?;
            if directory {
                result.directories.push(pin);
            } else {
                let before = stamp(pin.file()).map_err(|_| error("changed"))?;
                result.file = Some((pin, before));
            }
        }
        result.verify()?;
        Ok(result)
    }
    fn verify(&self) -> Result<()> {
        self.root.pin().verify().map_err(|_| error("changed"))?;
        for p in &self.directories {
            p.verify().map_err(|_| error("changed"))?;
        }
        if let Some((pin, before)) = &self.file {
            pin.verify().map_err(|_| error("changed"))?;
            if stamp(pin.file()).map_err(|_| error("changed"))? != *before {
                return Err(error("changed"));
            }
        }
        if let Some((depth, name, _)) = &self.missing {
            let parent = if *depth == 0 {
                self.root.pin()
            } else {
                &self.directories[*depth - 1]
            };
            let name = String::from_utf16(name).map_err(|_| error("unsafePath"))?;
            if metadata_child(parent.file(), OsStr::new(&name))
                .map_err(|_| error("unavailable"))?
                .is_some()
            {
                return Err(error("changed"));
            }
        }
        Ok(())
    }
    fn attribute_source(&self) -> Result<AttributeSource<'_>> {
        self.verify()?;
        if let Some((pin, _)) = &self.file {
            return Ok(AttributeSource {
                anchor: pin,
                missing_suffix: None,
            });
        }
        let (depth, _, suffix) = self.missing.as_ref().ok_or(error("changed"))?;
        Ok(AttributeSource {
            anchor: if *depth == 0 {
                self.root.pin()
            } else {
                &self.directories[*depth - 1]
            },
            missing_suffix: Some(suffix),
        })
    }
    fn bytes(&self, cancel: &AtomicBool) -> Result<Vec<u8>> {
        self.verify()?;
        let Some((pin, before)) = &self.file else {
            return Ok(Vec::new());
        };
        if before.size > LIMIT {
            return Err(error("tooLarge"));
        }
        let mut file = pin.file().try_clone().map_err(|_| error("unavailable"))?;
        file.rewind().map_err(|_| error("unavailable"))?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error("unavailable"))?;
        cancelled(cancel)?;
        self.verify()?;
        if bytes.len() as u64 != before.size {
            return Err(error("changed"));
        }
        Ok(bytes)
    }
}
fn configured_path(owner: &dyn EvaluationSource, raw: &str) -> Result<(PathBuf, Vec<String>)> {
    if raw.is_empty() || raw.contains(['\0', '\r', '\n']) {
        return Err(error("unsafePath"));
    }
    let path = Path::new(raw);
    if !path.is_absolute()
        && (path.has_root() || matches!(path.components().next(), Some(Component::Prefix(_))))
    {
        return Err(error("unsafePath"));
    }
    let joined = Path::new(&owner.context().scope.root.path).join(path);
    let mut normal = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normal.push(part.as_os_str())
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normal.pop() {
                    return Err(error("unsafePath"));
                }
            }
        }
    }
    crate::file_access::absolute(&normal).map_err(|_| error("unsafePath"))?;
    let mut root = PathBuf::new();
    let mut names = Vec::new();
    for part in normal.components() {
        match part {
            Component::Prefix(_) | Component::RootDir => root.push(part.as_os_str()),
            Component::Normal(p) => names.push(p.to_str().ok_or(error("unsafePath"))?.to_owned()),
            _ => return Err(error("unsafePath")),
        }
    }
    Ok((root, names))
}
pub(super) struct Inputs<'a> {
    pub(super) configs: Vec<String>,
    pub(super) attr_path: Option<String>,
    #[cfg(test)]
    resolved_attr_path: Option<PathBuf>,
    info: OptionalFile<'a>,
    configured: Option<OptionalFile<'a>>,
}
impl<'a> Inputs<'a> {
    pub(super) fn capture(owner: &'a dyn EvaluationSource, cancel: &AtomicBool) -> Result<Self> {
        let configs = safe(owner, cancel)?;
        let attr_path = config(owner, Key::Attributes, false, cancel)?;
        // ReadContext fixes GIT_COMMON_DIR to this same held common directory.
        let info = OptionalFile::open(
            Root::Borrowed(&owner.context().scope.common),
            vec!["info".into(), "attributes".into()],
            cancel,
        )?;
        #[cfg(test)]
        let mut resolved_attr_path = None;
        let configured = if let Some(raw) = &attr_path {
            let (root, names) = configured_path(owner, raw)?;
            #[cfg(test)]
            {
                resolved_attr_path = Some(names.iter().fold(root.clone(), |p, n| p.join(n)));
            }
            Some(OptionalFile::open(
                Root::Owned(PinnedPath::directory(&root).map_err(|_| error("unsafePath"))?),
                names,
                cancel,
            )?)
        } else {
            None
        };
        Ok(Self {
            configs,
            attr_path,
            #[cfg(test)]
            resolved_attr_path,
            info,
            configured,
        })
    }
    pub(super) fn info(&self, cancel: &AtomicBool) -> Result<Vec<u8>> {
        self.info.bytes(cancel)
    }
    #[cfg(test)]
    pub(super) fn attr_file(&self) -> Option<&Path> {
        // Explicit but absent configured file must not fall back to Git's
        // default global attributes path; absence and no setting differ.
        self.resolved_attr_path.as_deref()
    }
    pub(super) fn attr_source(&self) -> Result<Option<AttributeSource<'_>>> {
        self.configured
            .as_ref()
            .map(OptionalFile::attribute_source)
            .transpose()
    }
    pub(super) fn check_filter(
        &self,
        owner: &dyn EvaluationSource,
        attrs: &Attributes,
        cancel: &AtomicBool,
    ) -> Result<()> {
        if attrs
            .values()
            .any(|v| v.get("filter").is_some_and(|s| s != "unset"))
        {
            return Err(error("filters"));
        }
        if attrs
            .values()
            .any(|v| v.get("filter").is_some_and(|s| s == "unset"))
            && (config(owner, Key::UnsetSmudge, false, cancel)?.is_some_and(|v| !v.is_empty())
                || config(owner, Key::UnsetProcess, false, cancel)?.is_some_and(|v| !v.is_empty())
                || config(owner, Key::UnsetRequired, true, cancel)?.as_deref() == Some("true"))
        {
            return Err(error("filters"));
        }
        Ok(())
    }
    pub(super) fn verify(&self, owner: &dyn EvaluationSource, cancel: &AtomicBool) -> Result<()> {
        self.info.verify()?;
        if let Some(file) = &self.configured {
            file.verify()?;
        }
        if safe(owner, cancel)? != self.configs
            || config(owner, Key::Attributes, false, cancel)? != self.attr_path
        {
            return Err(error("changed"));
        }
        Ok(())
    }
}
