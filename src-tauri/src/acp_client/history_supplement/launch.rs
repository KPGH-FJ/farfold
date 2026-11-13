//! Bind the reviewed console_scripts pair to the existing managed receipt.
use super::{Reason, Result, source::Source};
use crate::{file_access, installations::Installation, meta_store::AgentRow};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

pub(super) fn regular(path: &Path) -> Result<File> {
    let parent = file_access::open_directory(path.parent().ok_or(Reason::Unavailable)?)
        .map_err(|_| Reason::Unavailable)?;
    let file = file_access::open_relative(
        &parent,
        Path::new(path.file_name().ok_or(Reason::Unavailable)?),
    )
    .map_err(|_| Reason::Unavailable)?;
    if !file_access::stamp(&file)
        .map_err(|_| Reason::Unavailable)?
        .regular
    {
        return Err(Reason::Unavailable);
    }
    Ok(file)
}
fn small(path: &Path) -> Result<(String, file_access::Stamp)> {
    let mut f = regular(path)?;
    let before = file_access::stamp(&f).map_err(|_| Reason::Unavailable)?;
    if before.size > 65536 {
        return Err(Reason::Limit);
    }
    let mut out = String::new();
    (&mut f)
        .take(65537)
        .read_to_string(&mut out)
        .map_err(|_| Reason::Unavailable)?;
    if out.len() > 65536 || file_access::stamp(&f).map_err(|_| Reason::Unavailable)? != before {
        return Err(Reason::Changed);
    }
    Ok((out, before))
}
pub(super) fn validated<T>(
    path: &Path,
    watched: &mut Vec<(PathBuf, file_access::Stamp)>,
    check: impl FnOnce(&str) -> Result<T>,
) -> Result<T> {
    let (bytes, verified_stamp) = small(path)?;
    let result = check(&bytes)?;
    // Only the handle that supplied the validated bytes can endorse them.
    // A later open may already refer to another declaration or executable.
    watched.push((path.to_owned(), verified_stamp));
    Ok(result)
}
pub(super) fn watched_current(watched: &[(PathBuf, file_access::Stamp)]) -> Result<()> {
    for (path, stamp) in watched {
        if file_access::stamp(&regular(path)?).map_err(|_| Reason::Changed)? != *stamp {
            return Err(Reason::Changed);
        }
    }
    Ok(())
}
fn directories(path: &Path) -> Result<Vec<PathBuf>> {
    file_access::open_directory(path).map_err(|_| Reason::Unavailable)?;
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(path)
        .map_err(|_| Reason::Unavailable)?
        .take(4097)
    {
        paths.push(entry.map_err(|_| Reason::Unavailable)?.path());
    }
    if paths.len() > 4096 {
        return Err(Reason::Limit);
    }
    Ok(paths)
}
fn entry(script: &str, interpreter: &Path, import: &str) -> bool {
    let expected = format!("'''exec' '{}' \"$0\" \"$@\"", interpreter.display());
    let lines: Vec<_> = script.lines().collect();
    // The public uv-generated console wrapper is data describing this entry.
    lines.first() == Some(&"#!/bin/sh")
        && lines.get(1) == Some(&expected.as_str())
        && lines.get(2) == Some(&"' '''")
        && lines
            .iter()
            .filter(|l| l.starts_with("from "))
            .copied()
            .eq([format!("from {import} import main").as_str()])
        && lines.last() == Some(&"    sys.exit(main())")
}
#[derive(Clone)]
pub(super) struct Resolved {
    pub companion: PathBuf,
    watched: Vec<(PathBuf, file_access::Stamp)>,
    interpreter: PathBuf,
    interpreter_target: PathBuf,
}
impl Resolved {
    pub fn current(&self) -> Result<()> {
        if self
            .interpreter
            .canonicalize()
            .map_err(|_| Reason::Changed)?
            != self.interpreter_target
        {
            return Err(Reason::Changed);
        }
        watched_current(&self.watched)
    }
}
pub(super) fn resolve(source: &Source, row: &AgentRow, items: &[Installation]) -> Result<Resolved> {
    source.current(row)?;
    let d = &super::super::recipes::FAST_HISTORY_EXPORT;
    let matches: Vec<_> = items
        .iter()
        .filter(|i| {
            i.agent_id == row.id
                && i.source == "managed"
                && !i.program_only
                && i.command == row.command
                && i.args == row.args
                && i.managed_root.is_some()
        })
        .collect();
    if matches.len() != 1 {
        return Err(Reason::Unavailable);
    }
    let root = PathBuf::from(
        matches[0]
            .managed_root
            .as_ref()
            .ok_or(Reason::Unavailable)?,
    );
    file_access::open_directory(&root).map_err(|_| Reason::Unavailable)?;
    let venv = root.join("venv");
    let bin = venv.join("bin");
    if source.command != bin.join(d.acp_entry) {
        return Err(Reason::Unavailable);
    }
    let companion = bin.join(d.companion_entry);
    let interpreter = bin.join("python");
    let interpreter_target = interpreter
        .canonicalize()
        .map_err(|_| Reason::Unavailable)?;
    if !crate::process_platform::executable(&interpreter_target)
        || !crate::process_platform::executable(&companion)
    {
        return Err(Reason::Unavailable);
    }
    let mut watched = Vec::new();
    for (path, import) in [
        (&source.command, d.acp_import),
        (&companion, d.companion_import),
    ] {
        validated(path, &mut watched, |bytes| {
            entry(bytes, &interpreter, import)
                .then_some(())
                .ok_or(Reason::Unavailable)
        })?;
    }
    let mut manifests = Vec::new();
    for lib in directories(&venv.join("lib"))? {
        let Some(version) = lib
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("python"))
        else {
            continue;
        };
        if version.is_empty()
            || !version
                .split('.')
                .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        {
            continue;
        }
        let packages = lib.join("site-packages");
        file_access::open_directory(&packages).map_err(|_| Reason::Unavailable)?;
        for dist in directories(&packages)? {
            if dist
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.starts_with("fast_agent_mcp-") && s.ends_with(".dist-info"))
            {
                manifests.push((packages.clone(), dist));
            }
        }
    }
    if manifests.len() != 1 {
        return Err(Reason::Unavailable);
    }
    let (packages, dist) = manifests.pop().ok_or(Reason::Unavailable)?;
    let metadata = dist.join("METADATA");
    let points = dist.join("entry_points.txt");
    validated(&metadata, &mut watched, |bytes| {
        if bytes
            .lines()
            .filter_map(|l| l.strip_prefix("Name: "))
            .collect::<Vec<_>>()
            != [d.distribution]
        {
            return Err(Reason::Unavailable);
        }
        Ok(())
    })?;
    validated(&points, &mut watched, |declarations| {
        let mut section = "";
        let mut acp = Vec::new();
        let mut export = Vec::new();
        for line in declarations.lines().map(str::trim) {
            if line.starts_with('[') {
                section = line;
                continue;
            }
            if section == "[console_scripts]"
                && let Some((key, value)) = line.split_once('=')
            {
                match key.trim() {
                    k if k == d.acp_entry => acp.push(value.trim()),
                    k if k == d.companion_entry => export.push(value.trim()),
                    _ => {}
                }
            }
        }
        if acp != [format!("{}:main", d.acp_import)]
            || export != [format!("{}:main", d.companion_import)]
        {
            return Err(Reason::Unavailable);
        }
        Ok(())
    })?;
    let mut extra = vec![venv.join("pyvenv.cfg"), interpreter_target.clone()];
    for module in [
        "cli/__main__.py",
        "cli/commands/acp.py",
        "cli/commands/export.py",
        "session/trace_exporter.py",
        "session/trace_export_codex.py",
    ] {
        extra.push(packages.join("fast_agent").join(module));
    }
    for path in extra {
        watched.push((
            path.clone(),
            file_access::stamp(&regular(&path)?).map_err(|_| Reason::Unavailable)?,
        ));
    }
    let resolved = Resolved {
        companion,
        watched,
        interpreter,
        interpreter_target,
    };
    resolved.current()?;
    Ok(resolved)
}
pub(super) fn environment(row: &AgentRow) -> Result<std::collections::HashMap<String, String>> {
    selected_environment(
        row,
        crate::shell_env::cached_command_env().ok_or(Reason::Unavailable)?,
        |name| std::env::var_os(name),
    )
}
pub(super) fn selected_environment(
    row: &AgentRow,
    mut env: std::collections::HashMap<String, String>,
    inherited: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Result<std::collections::HashMap<String, String>> {
    for (key, value) in &row.env {
        if key.is_empty()
            || key.contains('=')
            || key.chars().any(char::is_control)
            || value.contains('\0')
            || value == crate::auth::KEYCHAIN_MARKER
        {
            return Err(Reason::Unavailable);
        }
        env.insert(key.clone(), value.clone());
    }
    for name in [
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "PYTHONINSPECT",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
    ] {
        if env
            .get(name)
            .map(std::ffi::OsString::from)
            .or_else(|| inherited(name))
            .is_some_and(|s| !s.is_empty())
        {
            return Err(Reason::Unavailable);
        }
    }
    Ok(env)
}
pub(super) fn command(
    resolved: &Resolved,
    cwd: &Path,
    sid: &str,
    role: &str,
    output: &Path,
    env: std::collections::HashMap<String, String>,
) -> Result<Command> {
    resolved.current()?;
    let mut c = Command::new(&resolved.companion);
    c.current_dir(cwd)
        .args([
            "export", sid, "--agent", role, "--format", "codex", "--output",
        ])
        .arg(output)
        .envs(env);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        // This child's one output has a kernel-enforced ceiling, not merely a
        // post-read limit. No parent limit, environment or Agent setting changes.
        unsafe {
            c.pre_exec(|| {
                let limit = libc::rlimit {
                    rlim_cur: super::INPUT_LIMIT as _,
                    rlim_max: super::INPUT_LIMIT as _,
                };
                if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                libc::umask(0o077);
                Ok(())
            });
        }
    }
    Ok(c)
}
