//! Fixed read-only Windows Git selection. No repository PATH lookup or shell.
use super::{
    git,
    types::{Result, error},
    windows_scope::Scope,
};
use crate::file_access::PinnedPath;
use std::{
    path::Path,
    process::{Command, Stdio},
    sync::atomic::AtomicBool,
    time::Duration,
};

#[path = "windows_git_paths.rs"]
pub(super) mod paths;

fn executable(scope: &Scope) -> Result<PinnedPath> {
    let paths = std::env::var_os("PATH").ok_or(error("gitUnavailable"))?;
    executable_from(scope, &paths)
}
pub(super) fn executable_from(scope: &Scope, paths: &std::ffi::OsStr) -> Result<PinnedPath> {
    for directory in std::env::split_paths(paths).filter(|p| p.is_absolute()) {
        let path = directory.join("git.exe");
        // Do not search cwd, scripts, relative PATH, Agent config or another HOME.
        // An absolute project-local decoy is still ineligible by held identities.
        let Ok(pin) = PinnedPath::regular(&path) else {
            continue;
        };
        if scope.contains_project(&pin) {
            continue;
        }
        return Ok(pin);
    }
    Err(error("gitUnavailable"))
}
pub(super) struct ReadContext {
    pub scope: Scope,
    executable: PinnedPath,
}
impl ReadContext {
    // Borrow the program already admitted against the ORIGINAL source scope.
    // No PATH re-search and no arbitrary Command constructor is exposed.
    pub(super) fn selected_program(&self) -> &PinnedPath {
        &self.executable
    }
    pub fn open(root: &Path) -> Result<Self> {
        git::environment()?;
        let scope = Scope::open(root)?;
        let executable = executable(&scope)?;
        let context = Self { scope, executable };
        // Explicit work-tree selection must not silently override a configured
        // layout. This first slice supports only default main/linked layouts.
        if context.config("core.worktree", false)?.is_some() {
            return Err(error("unsupportedGit"));
        }
        if context.config("core.bare", true)?.as_deref() == Some("true") {
            return Err(error("bare"));
        }
        Ok(context)
    }
    pub fn execute(
        &self,
        args: &[&str],
        cancel: &AtomicBool,
        timeout: Duration,
    ) -> Result<git::Output> {
        if !super::read_policy::allowed(args) {
            return Err(error("unsupportedGit"));
        }
        // Reject inherited overrides before adding this child's fixed context.
        git::environment()?;
        self.scope.verify()?;
        self.executable.verify().map_err(|_| error("changed"))?;
        let paths = crate::worktrees::windows_git::paths::Paths::new(&[
            &self.executable,
            &self.scope.root,
            &self.scope.git,
            &self.scope.common,
        ])?;
        let mut command = Command::new(paths.path(&self.executable)?);
        command
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_COMMON_DIR", paths.path(&self.scope.common)?)
            .args(["--no-pager", "--no-replace-objects", "-c"])
            // Only traditional hooksPath lookup is addressed by this held file.
            // These fixed read commands do not authorize configured hooks.
            .arg(format!(
                "core.hooksPath={}",
                paths.path(&self.executable)?.display()
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
                "worktree.guessRemote=false",
                "-c",
                "credential.helper=",
            ])
            .arg("--git-dir")
            .arg(paths.path(&self.scope.git)?)
            .arg("--work-tree")
            .arg(paths.path(&self.scope.root)?)
            .arg("-C")
            .arg(paths.path(&self.scope.root)?)
            .args(args)
            .current_dir(paths.path(&self.scope.root)?)
            .stdin(Stdio::null());
        let output = git::execute_command(command, cancel, timeout);
        paths.verify()?;
        // The exact child has been reaped and its direct Job is inactive.
        self.scope.verify()?;
        self.executable.verify().map_err(|_| error("changed"))?;
        output
    }
    pub fn read(&self, args: &[&str]) -> Result<Vec<u8>> {
        let output = self.execute(args, &AtomicBool::new(false), Duration::from_secs(10))?;
        if output.success {
            Ok(output.bytes)
        } else {
            Err(error("unavailable"))
        }
    }
    pub fn text(&self, args: &[&str]) -> Result<String> {
        String::from_utf8(self.read(args)?)
            .map(|s| s.strip_suffix('\n').unwrap_or(&s).to_owned())
            .map_err(|_| error("unsupportedGit"))
    }
    pub fn config(&self, name: &str, boolean: bool) -> Result<Option<String>> {
        let mut args = vec!["config"];
        if boolean {
            args.push("--type=bool");
        }
        args.extend(["--get", name]);
        let output = self.execute(&args, &AtomicBool::new(false), Duration::from_secs(10))?;
        #[cfg(test)]
        eprintln!(
            "FARFOLD_WINDOWS_GIT_TEST_CONFIG {}",
            serde_json::json!({
                "name": name,
                "boolean": boolean,
                "exitCode": output.code,
                "success": output.success,
                "stdoutBytes": output.bytes.len(),
            })
        );
        match output.code {
            Some(1) if output.bytes.is_empty() => Ok(None),
            Some(0) => String::from_utf8(output.bytes)
                .map(|s| Some(s.strip_suffix('\n').unwrap_or(&s).to_owned()))
                .map_err(|_| error("unsupportedGit")),
            _ => Err(error("unsupportedGit")),
        }
    }
}
pub(super) fn execute(
    root: &Path,
    args: &[&str],
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<git::Output> {
    ReadContext::open(root)?.execute(args, cancel, timeout)
}

#[cfg(test)]
#[path = "windows_git_launch_matrix_tests.rs"]
pub(super) mod launch_matrix_tests;
