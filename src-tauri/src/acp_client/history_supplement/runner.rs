//! A child of the existing cold-open operation, not a background history queue.
use super::{launch, source::Source, types::*};
use crate::{
    acp_client::{
        extension_inventory::{
            Code,
            process::{self, Control},
        },
        lifecycle::{ConnectionLife, READY},
        model_guard::ConfigStore,
        operations::Operation,
    },
    file_access,
    installations::Installation,
    meta_store::AgentRow,
};
use serde_json::Value;
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

pub(super) fn role(response: &Value) -> Result<String> {
    let modes = response.get("modes").ok_or(Reason::Unavailable)?;
    let current = modes
        .get("currentModeId")
        .and_then(Value::as_str)
        .ok_or(Reason::Unavailable)?;
    let available = modes
        .get("availableModes")
        .and_then(Value::as_array)
        .ok_or(Reason::Unavailable)?;
    let mut ids = std::collections::HashSet::new();
    for mode in available {
        let id = mode
            .get("id")
            .and_then(Value::as_str)
            .ok_or(Reason::Invalid)?;
        if !ids.insert(id) {
            return Err(Reason::Invalid);
        }
    }
    if !ids.contains(current) || !plain(current) {
        return Err(Reason::Unavailable);
    }
    Ok(current.to_owned())
}
fn plain(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && !s.starts_with('-')
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
        && s != "."
        && s != ".."
}
struct ReadControl {
    operation: Operation,
    life: Arc<ConnectionLife>,
    deadline: Instant,
    output: PathBuf,
}
impl ReadControl {
    fn interruption(&self) -> Option<Reason> {
        if !self.operation.interested() || self.life.state.load(Ordering::SeqCst) != READY {
            return Some(Reason::Cancelled);
        }
        match std::fs::symlink_metadata(&self.output) {
            Ok(m) if m.is_file() && !m.file_type().is_symlink() => {
                (m.len() > INPUT_LIMIT as u64).then_some(Reason::Limit)
            }
            _ => Some(Reason::Changed),
        }
    }
}
impl Control for ReadControl {
    fn interested(&self) -> bool {
        self.interruption().is_none()
    }
    fn deadline(&self) -> Instant {
        self.deadline
    }
    fn pending_cleanup(&self) {} // run_owned retains the actual child, group and pipes.
}
fn read_output(path: &Path) -> Result<Vec<u8>> {
    let mut file = launch::regular(path)?;
    let before = file_access::stamp(&file).map_err(|_| Reason::Invalid)?;
    if before.size > INPUT_LIMIT as u64 {
        return Err(Reason::Limit);
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(INPUT_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Reason::Invalid)?;
    let path_stamp = file_access::stamp(&launch::regular(path)?).map_err(|_| Reason::Changed)?;
    if bytes.len() > INPUT_LIMIT
        || file_access::stamp(&file).map_err(|_| Reason::Changed)? != before
        || path_stamp != before
    {
        bytes.fill(0);
        return Err(Reason::Changed);
    }
    Ok(bytes)
}
#[allow(clippy::too_many_arguments)]
pub(super) fn execute(
    source: Source,
    row: AgentRow,
    items: Vec<Installation>,
    cwd: PathBuf,
    sid: String,
    role: String,
    operation: Operation,
    life: Arc<ConnectionLife>,
    deadline: Instant,
    environment: std::collections::HashMap<String, String>,
) -> Result<ParsedHistory> {
    let resolved = launch::resolve(&source, &row, &items)?;
    let directory = tempfile::Builder::new()
        .prefix("farfold-history-")
        .tempdir()
        .map_err(|_| Reason::Unavailable)?;
    let root = directory
        .path()
        .canonicalize()
        .map_err(|_| Reason::Unavailable)?;
    let output = root.join("history.jsonl");
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let original = options.open(&output).map_err(|_| Reason::Unavailable)?;
    let original_identity = file_access::stamp(&original)
        .map_err(|_| Reason::Unavailable)?
        .identity;
    let command = launch::command(&resolved, &cwd, &sid, &role, &output, environment)?;
    let control = ReadControl {
        operation,
        life,
        deadline,
        output: output.clone(),
    };
    let result = process::run_owned(command, &control, None, 65536);
    // No cleanup or publication until run_owned observes actual process/group
    // and both pipe completion, including its cancellation escalation path.
    let mut stdout = result.map_err(|e| {
        control.interruption().unwrap_or(match e.code {
            Code::OutputLimit => Reason::Limit,
            Code::Cancelled => Reason::Cancelled,
            _ => Reason::Unavailable,
        })
    })?;
    stdout.fill(0);
    if let Some(reason) = control.interruption() {
        return Err(reason);
    }
    source.current(&row)?;
    resolved.current()?;
    if file_access::stamp(&launch::regular(&output)?)
        .map_err(|_| Reason::Changed)?
        .identity
        != original_identity
    {
        return Err(Reason::Changed);
    }
    let mut bytes = read_output(&output)?;
    let result = super::parse(&bytes, &sid, cwd.to_str().ok_or(Reason::Invalid)?);
    bytes.fill(0);
    if let Some(reason) = control.interruption() {
        return Err(reason);
    }
    result
}
#[allow(clippy::too_many_arguments)]
pub(in crate::acp_client) async fn read(
    source: Source,
    config: &ConfigStore,
    cwd: &Path,
    sid: &str,
    response: &Value,
    operation: &Operation,
    life: &Arc<ConnectionLife>,
) -> Result<ParsedHistory> {
    let role = role(response)?;
    if !plain(sid) {
        return Err(Reason::Invalid);
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let activity = crate::managed_update::activity().map_err(|_| Reason::Unavailable)?;
    let guard = tokio::select! {
        _=operation.cancelled()=>return Err(Reason::Cancelled),
        _=tokio::time::sleep(Duration::from_secs(15))=>return Err(Reason::Unavailable),
        guard=crate::install_job::configuration_guard(&config.agent_id)=>guard,
    };
    if !operation.interested() || life.state.load(Ordering::SeqCst) != READY {
        return Err(Reason::Cancelled);
    }
    let id = config.agent_id.clone();
    let (row, items) = config
        .store
        .run(move |store| {
            let row = store.get_agent(&id)?.ok_or("history source unavailable")?;
            let items: Vec<Installation> = serde_json::from_value(
                store
                    .get_setting("installations.v1")?
                    .unwrap_or(Value::Array(vec![])),
            )
            .map_err(|_| "history installation unavailable")?;
            Ok((
                row,
                items
                    .into_iter()
                    .filter(|i| i.agent_id == id)
                    .collect::<Vec<_>>(),
            ))
        })
        .await
        .map_err(|_| Reason::Unavailable)?;
    source.current(&row)?;
    let environment = launch::environment(&row)?;
    let final_store = config.store.clone();
    let op = operation.clone();
    let life = life.clone();
    let cwd = cwd.to_path_buf();
    let sid = sid.to_owned();
    // The blocking owner retains the original history permit and configuration
    // guard even if its observer disappears. No orphan child outlives the gate.
    tokio::task::spawn_blocking(move || {
        let _owners = (activity, guard);
        let expected_items = serde_json::to_value(&items).map_err(|_| Reason::Unavailable)?;
        let id = row.id.clone();
        let result = execute(
            source.clone(),
            row,
            items,
            cwd,
            sid,
            role,
            op,
            life,
            deadline,
            environment,
        );
        let current = final_store
            .get_agent(&id)
            .map_err(|_| Reason::Changed)?
            .ok_or(Reason::Changed)?;
        source.current(&current)?;
        let current_items: Vec<Installation> = serde_json::from_value(
            final_store
                .get_setting("installations.v1")
                .map_err(|_| Reason::Changed)?
                .unwrap_or(Value::Array(vec![])),
        )
        .map_err(|_| Reason::Changed)?;
        let current_items: Vec<_> = current_items
            .into_iter()
            .filter(|i| i.agent_id == id)
            .collect();
        if serde_json::to_value(current_items).map_err(|_| Reason::Changed)? != expected_items {
            return Err(Reason::Changed);
        }
        result
    })
    .await
    .map_err(|_| Reason::Unavailable)?
}

#[cfg(test)]
mod classification_tests {
    use super::*;
    #[test]
    fn output_replacement_or_limit_is_not_reported_as_a_user_cancellation() {
        let d = tempfile::tempdir().unwrap();
        let output = d.path().join("out");
        let file = std::fs::File::create(&output).unwrap();
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let control = ReadControl {
            operation: Operation::new(),
            life,
            deadline: Instant::now(),
            output: output.clone(),
        };
        assert_eq!(control.interruption(), None);
        file.set_len(INPUT_LIMIT as u64 + 1).unwrap();
        assert_eq!(control.interruption(), Some(Reason::Limit));
        std::fs::remove_file(output).unwrap();
        assert_eq!(control.interruption(), Some(Reason::Changed));
        control.operation.abandon();
        assert_eq!(control.interruption(), Some(Reason::Cancelled));
    }
}
