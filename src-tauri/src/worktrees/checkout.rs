//! Materialize one immutable OID through official Git, without inherited executable helpers.
//! This is a temporary Git command context, not an Agent HOME/config or another worktree.
use super::{
    git,
    inspect::{self, Snapshot},
    storage::Intent,
    types::*,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};
pub(super) struct Checkout {
    _temp: tempfile::TempDir,
    git_dir: PathBuf,
    index: PathBuf,
    objects: PathBuf,
    oid: String,
    configs: Vec<String>,
}
fn output(c: std::process::Command, input: Option<&[u8]>, cancel: &AtomicBool) -> Result<Vec<u8>> {
    // target_objects came through the existing finite Git output budget.
    let input = match input {
        Some(bytes) => git::Input::from_bytes(bytes, git::OUTPUT_LIMIT, cancel)?,
        None => git::Input::null(),
    };
    let o = git::execute_command_input(c, input, cancel, Duration::from_secs(120))?;
    if o.success {
        Ok(o.bytes)
    } else {
        Err(error("unknown"))
    }
}
fn attrs(raw: &[u8]) -> Result<BTreeMap<Vec<u8>, BTreeMap<String, String>>> {
    let mut result: BTreeMap<Vec<u8>, BTreeMap<String, String>> = BTreeMap::new();
    if raw.is_empty() {
        return Ok(result);
    }
    let fields: Vec<_> = raw.split(|b| *b == 0).collect();
    if fields.last() != Some(&&b""[..]) || (fields.len() - 1) % 3 != 0 {
        return Err(error("unsupportedGit"));
    }
    for f in fields[..fields.len() - 1].chunks(3) {
        let name = std::str::from_utf8(f[1]).map_err(|_| error("unsupportedGit"))?;
        let value = std::str::from_utf8(f[2]).map_err(|_| error("unsupportedGit"))?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || value.len() > 4096
            || value.bytes().any(|b| b.is_ascii_whitespace() || b == 0)
        {
            return Err(error("unsupportedGit"));
        }
        result
            .entry(f[0].to_vec())
            .or_default()
            .insert(name.into(), value.into());
    }
    Ok(result)
}
fn pattern(path: &[u8]) -> String {
    // C-quoted Git pattern; escape glob syntax before quoting, preserving arbitrary path bytes.
    let mut s = String::from("\"/");
    for &b in path {
        if b"*?[\\".contains(&b) {
            s.push_str("\\\\");
        }
        match b {
            b'\\' => s.push_str("\\\\"),
            b'"' => s.push_str("\\\""),
            32..=126 => s.push(b as char),
            _ => s.push_str(&format!("\\{b:03o}")),
        }
    }
    s.push('"');
    s
}
impl Checkout {
    pub fn prepare(source: &Snapshot, oid: &str) -> Result<Self> {
        inspect::target_allowed(source, oid)?;
        let root = Path::new(&source.root);
        let temp = tempfile::tempdir().map_err(|_| error("unavailable"))?;
        let git_dir = temp.path().join("git");
        let template = temp.path().join("empty-template");
        fs::create_dir(&template).map_err(|_| error("unavailable"))?;
        let format = git::text(root, &["rev-parse", "--show-object-format"])?;
        if !matches!(format.as_str(), "sha1" | "sha256") {
            return Err(error("unsupportedGit"));
        }
        let fmt = format!("--object-format={format}");
        let tpl = format!("--template={}", template.display());
        let mut init = git::command(
            temp.path(),
            &[
                "init",
                "--bare",
                &fmt,
                &tpl,
                git_dir.to_str().ok_or(error("unsafePath"))?,
            ],
        )?;
        init.env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_NOSYSTEM", "1");
        output(init, None, &AtomicBool::new(false))?;
        let objects = Path::new(&source.common_dir)
            .join("objects")
            .canonicalize()
            .map_err(|_| error("unavailable"))?;
        if !objects.is_dir() {
            return Err(error("unavailable"));
        }
        let mut configs = Vec::new();
        for (name, values) in [
            ("core.autocrlf", &["true", "false", "input"][..]),
            ("core.eol", &["lf", "crlf", "native"]),
            ("core.safecrlf", &["true", "false", "warn"]),
            ("core.symlinks", &["true", "false"]),
            ("core.filemode", &["true", "false"]),
            ("core.ignorecase", &["true", "false"]),
            ("core.precomposeunicode", &["true", "false"]),
            ("core.protecthfs", &["true", "false"]),
            ("core.protectntfs", &["true", "false"]),
        ] {
            let boolean = values == ["true", "false"];
            if let Some(mut value) = git::config(root, name, boolean)? {
                // autocrlf/input and safecrlf/warn are enums with an additional bool
                // spelling set. Let official Git normalize every bool alias.
                if !values.contains(&value.as_str()) && name != "core.eol" {
                    value = git::config(root, name, true)?.ok_or(error("changed"))?;
                }
                if !values.contains(&value.as_str()) {
                    return Err(error("unsupportedGit"));
                }
                configs.push(format!("{name}={value}"));
            }
        }
        let this = Self {
            index: temp.path().join("index"),
            _temp: temp,
            git_dir,
            objects,
            oid: oid.into(),
            configs,
        };
        // Every object-demand operation runs against the private config/ref namespace.
        // Sharing objects does not import remote/promisor configuration or replacement refs.
        let paths = inspect::target_objects(oid, |args| {
            output(this.command(args, root)?, None, &AtomicBool::new(false))
        })?;
        output(
            this.command(&["read-tree", oid], root)?,
            None,
            &AtomicBool::new(false),
        )?;
        fs::create_dir_all(this.git_dir.join("info")).map_err(|_| error("unavailable"))?;
        let info = git::text(
            root,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "info/attributes",
            ],
        )?;
        let mut open = fs::OpenOptions::new();
        open.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.custom_flags(libc::O_NONBLOCK);
        }
        match open.open(info) {
            Ok(file) => {
                let meta = file.metadata().map_err(|_| error("unavailable"))?;
                if !meta.is_file() || meta.len() > 4 * 1024 * 1024 {
                    return Err(error("tooLarge"));
                }
                let mut bytes = Vec::new();
                file.take(4 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| error("unavailable"))?;
                if bytes.len() > 4 * 1024 * 1024 {
                    return Err(error("tooLarge"));
                }
                fs::write(this.git_dir.join("info/attributes"), bytes)
                    .map_err(|_| error("unavailable"))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("unavailable")),
        }
        // Git evaluates exact-tree attributes plus the captured info file and the original
        // global/system attribute paths. No source config containing executable helpers is loaded.
        let attr_config = git::execute(
            root,
            &["config", "--path", "--get", "core.attributesFile"],
            &AtomicBool::new(false),
            Duration::from_secs(10),
        )?;
        let attr_file = match attr_config.code {
            Some(1) if attr_config.bytes.is_empty() => None,
            Some(0) => {
                let path =
                    String::from_utf8(attr_config.bytes).map_err(|_| error("unsupportedGit"))?;
                let path = path.strip_suffix('\n').unwrap_or(&path);
                let path = Path::new(path);
                Some(if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    root.join(path)
                })
            }
            _ => return Err(error("unavailable")),
        };
        let original = attrs(&output(
            this.attribute_command(root, attr_file.as_deref())?,
            Some(&paths),
            &AtomicBool::new(false),
        )?)?;
        if original
            .values()
            .any(|values| values.get("filter").is_some_and(|v| v != "unset"))
        {
            return Err(error("filters"));
        }
        // check-attr renders both -filter and the literal driver name filter=unset
        // as "unset". Do not silently suppress a configured transform in that case.
        // A genuinely unspecified attribute is omitted by --all; an explicit
        // "unspecified" value above is therefore a driver name and is rejected.
        if original
            .values()
            .any(|v| v.get("filter").is_some_and(|v| v == "unset"))
            && (git::config(root, "filter.unset.smudge", false)?.is_some_and(|v| !v.is_empty())
                || git::config(root, "filter.unset.process", false)?.is_some_and(|v| !v.is_empty())
                || git::config(root, "filter.unset.required", true)?.as_deref() == Some("true"))
        {
            return Err(error("filters"));
        }
        fs::write(this.git_dir.join("info/attributes"), []).map_err(|_| error("unavailable"))?;
        let local = attrs(&output(
            this.command(&["check-attr", "--cached", "--all", "-z", "--stdin"], root)?,
            Some(&paths),
            &AtomicBool::new(false),
        )?)?;
        let keys: BTreeSet<_> = original.keys().chain(local.keys()).cloned().collect();
        let mut effective = Vec::new();
        for path in keys {
            let source = original.get(&path);
            let internal = local.get(&path);
            let names: BTreeSet<_> = source
                .into_iter()
                .flat_map(|v| v.keys())
                .chain(internal.into_iter().flat_map(|v| v.keys()))
                .collect();
            let mut line = pattern(&path);
            for name in names {
                line.push(' ');
                match source.and_then(|v| v.get(name)).map(String::as_str) {
                    None | Some("unspecified") => {
                        line.push('!');
                        line.push_str(name);
                    }
                    Some("unset") => {
                        line.push('-');
                        line.push_str(name);
                    }
                    Some("set") => line.push_str(name),
                    Some(value) => {
                        line.push_str(name);
                        line.push('=');
                        line.push_str(value);
                    }
                }
            }
            effective.extend_from_slice(line.as_bytes());
            effective.push(b'\n');
            if effective.len() > 4 * 1024 * 1024 {
                return Err(error("tooLarge"));
            }
        }
        fs::create_dir_all(this.git_dir.join("info")).map_err(|_| error("unavailable"))?;
        fs::write(this.git_dir.join("info/attributes"), effective)
            .map_err(|_| error("unavailable"))?;
        let mirrored = attrs(&output(
            this.command(&["check-attr", "--cached", "--all", "-z", "--stdin"], root)?,
            Some(&paths),
            &AtomicBool::new(false),
        )?)?;
        if original != mirrored {
            return Err(error("unsupportedGit"));
        }
        source.identity()?;
        Ok(this)
    }
    pub(super) fn recovery_profile(&self) -> Result<(Vec<String>, Vec<u8>)> {
        Ok((
            self.configs.clone(),
            fs::read(self.git_dir.join("info/attributes")).map_err(|_| error("unavailable"))?,
        ))
    }
    fn command(&self, args: &[&str], worktree: &Path) -> Result<std::process::Command> {
        self.command_options(args, worktree, false, None)
    }
    fn attribute_command(
        &self,
        worktree: &Path,
        attributes: Option<&Path>,
    ) -> Result<std::process::Command> {
        self.command_options(
            &["check-attr", "--cached", "--all", "-z", "--stdin"],
            worktree,
            true,
            attributes,
        )
    }
    fn command_options(
        &self,
        args: &[&str],
        worktree: &Path,
        external_attributes: bool,
        attributes: Option<&Path>,
    ) -> Result<std::process::Command> {
        let mut all = vec![
            "-c".to_owned(),
            "core.bare=false".into(),
            "-c".into(),
            "checkout.workers=1".into(),
        ];
        if !external_attributes {
            all.extend(["-c".into(), "core.attributesFile=/dev/null".into()]);
        } else if let Some(path) = attributes {
            all.extend([
                "-c".into(),
                format!(
                    "core.attributesFile={}",
                    path.to_str().ok_or(error("unsafePath"))?
                ),
            ]);
        }
        for value in &self.configs {
            all.extend(["-c".into(), value.clone()]);
        }
        all.extend(args.iter().map(|s| s.to_string()));
        let mut c = git::command(
            self._temp.path(),
            &all.iter().map(String::as_str).collect::<Vec<_>>(),
        )?;
        c.env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_DIR", &self.git_dir)
            .env("GIT_WORK_TREE", worktree)
            .env("GIT_OBJECT_DIRECTORY", &self.objects)
            .env("GIT_INDEX_FILE", &self.index);
        if !external_attributes {
            c.env("GIT_ATTR_NOSYSTEM", "1");
        }
        Ok(c)
    }
    pub fn materialize(&self, intent: &Intent, cancel: &AtomicBool) -> Result<()> {
        if intent.input.branch.oid() != self.oid {
            return Err(error("changed"));
        }
        let current = super::create::verify(intent)?;
        let target = Path::new(&intent.target);
        let prefix = format!("--prefix={}/", intent.target);
        output(
            self.command(&["checkout-index", "--all", "--index", &prefix], target)?,
            None,
            cancel,
        )?;
        let after = super::create::verify(intent)?;
        if current.git_dir != after.git_dir || current.git_stamp != after.git_stamp {
            return Err(error("changed"));
        }
        // Publish only into this newly created linked tree, never overwrite an existing index.
        let destination = Path::new(&after.git_dir).join("index");
        let mut source = fs::File::open(&self.index).map_err(|_| error("unavailable"))?;
        if source.metadata().map_err(|_| error("unavailable"))?.len() > 32 * 1024 * 1024 {
            return Err(error("tooLarge"));
        }
        let mut tmp =
            tempfile::NamedTempFile::new_in(&after.git_dir).map_err(|_| error("unavailable"))?;
        std::io::copy(
            &mut std::io::Read::by_ref(&mut source).take(32 * 1024 * 1024 + 1),
            &mut tmp,
        )
        .map_err(|_| error("unavailable"))?;
        tmp.as_file().sync_all().map_err(|_| error("unavailable"))?;
        inspect::same(&after.git_dir, &after.git_stamp)?;
        tmp.persist_noclobber(destination)
            .map_err(|_| error("changed"))?;
        Ok(())
    }
}
