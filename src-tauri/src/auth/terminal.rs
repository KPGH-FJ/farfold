//! Shared owner for declared and explicitly configured terminal authentication.
use std::path::Path;
use tauri::ipc::Channel;

pub(crate) struct Ownership {
    pub output: Channel<serde_json::Value>,
    pub configuration: tokio::sync::OwnedMutexGuard<()>,
    pub scope: crate::acp_client::manager::AccountScope,
    pub attempt: super::attempts::Attempt,
}

pub(crate) fn run(
    pty: &crate::pty::PtyManager,
    command: &str,
    args: &[String],
    cwd: &Path,
    owner: Ownership,
    environment: impl FnOnce() -> Result<Vec<(String, String)>, String>,
) -> Result<String, String> {
    owner.attempt.check()?;
    let env = environment();
    owner.attempt.check()?;
    let env = env?;
    let operation = owner.attempt.operation();
    let sink = super::terminal_output(
        owner.output,
        owner.configuration,
        owner.scope,
        Some(owner.attempt),
    );
    pty.spawn_controlled(
        command,
        args,
        &env,
        cwd,
        portable_pty::PtySize {
            rows: crate::pty::DEFAULT_ROWS,
            cols: crate::pty::DEFAULT_COLS,
            pixel_width: 0,
            pixel_height: 0,
        },
        sink,
        operation.abandoned,
    )
}

#[cfg(test)]
mod tests;
