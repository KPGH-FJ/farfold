//! One sealed private bundle stdout role, not a general Command/File executor.
use super::super::{
    recovery_pack::{
        COMMAND_TIME,
        private_graph::{OutputRequest, Produced},
    },
    recovery_roots::MAX_BYTES,
    types::{Result, error},
};
pub(in crate::worktrees) const OPTIONS: &[&str] = &[
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
];
pub(in crate::worktrees) fn write(
    mut request: OutputRequest<'_>,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Produced> {
    request.verify()?;
    let mut command = std::process::Command::new(&request.program()?.guid_path);
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(OPTIONS)
        .arg("--git-dir")
        .arg(request.repository()?)
        .arg("-C")
        .arg(request.repository()?)
        .current_dir(request.repository()?)
        .args(["bundle", "create", "--version=3", "-", "--all"]);
    let output = request.take_output()?;
    // The same original executor owns input, Child and direct Job through
    // confirmed completion/unwind. No generic execute_to_file gate is relaxed.
    let outcome = super::execute_bounded(
        command,
        Some(super::Input::null()),
        cancel,
        COMMAND_TIME,
        output,
        MAX_BYTES,
        false,
    );
    request.verify()?;
    if !outcome?.success {
        return Err(error("recoveryInvalid"));
    }
    request.finish(cancel)
}
