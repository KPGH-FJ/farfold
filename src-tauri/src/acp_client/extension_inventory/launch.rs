//! Reviewed public package provenance only; no private config or credential read.
use super::types::*;
use crate::{
    acp_client::browser_capability::{self, LaunchKind},
    meta_store::AgentRow,
};
use std::{
    collections::HashMap,
    fs::File,
    path::Path,
    process::Command,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub(super) fn admission(row: &AgentRow) -> Result<()> {
    if !cfg!(target_os = "macos") {
        return Err(Code::PlatformUnsupported.into());
    }
    if !matches!(row.id.as_str(), "codex" | "registry:codex-acp") {
        return Err(Code::NotReviewed.into());
    }
    // Binary name alone cannot establish the relay. Only the public Node bin
    // already checked against its canonical package manifest is reviewed here.
    if browser_capability::reviewed_launch(row) != Some(LaunchKind::Node)
        || !crate::process_platform::executable(Path::new(&row.command))
    {
        return Err(Code::EntryUnverified.into());
    }
    if row.env.iter().any(|(key, value)| {
        value == crate::auth::KEYCHAIN_MARKER
            || key.is_empty()
            || key.contains('=')
            || key.chars().any(char::is_control)
            || value.contains('\0')
    }) {
        return Err(Code::EnvironmentUnavailable.into());
    }
    Ok(())
}
pub(super) fn capabilities(row: &AgentRow) -> Result<ExtensionCapabilities> {
    let reason = admission(row).err().map(|error| error.code).or_else(|| {
        crate::shell_env::cached_command_env()
            .is_none()
            .then_some(Code::EnvironmentUnavailable)
    });
    let selection_id = if reason.is_none() {
        Some(selections().issue(row.clone(), Instant::now())?)
    } else {
        None
    };
    Ok(ExtensionCapabilities {
        selection_id,
        mcp_inventory: InventoryCapability {
            availability: if reason.is_none() {
                "available"
            } else {
                "unavailable"
            },
            source: reason.is_none().then_some("officialCli"),
            reason,
        },
        skills_inventory: "unavailable",
        tool_inventory: "unavailable",
    })
}
// Short-lived capability receipts carry the exact selected row only in RAM.
// They authorize admission of a query, not a durable configuration or session.
const SELECTION_LIMIT: usize = 64;
const SELECTION_TTL: Duration = Duration::from_secs(300);
#[derive(Default)]
pub(super) struct Selections(Mutex<HashMap<String, (AgentRow, Instant)>>);
pub(super) fn selections() -> &'static Selections {
    static SELECTIONS: OnceLock<Selections> = OnceLock::new();
    SELECTIONS.get_or_init(Default::default)
}
impl Selections {
    pub(super) fn issue(&self, row: AgentRow, now: Instant) -> Result<String> {
        let mut entries = self.0.lock().unwrap_or_else(|p| p.into_inner());
        entries.retain(|_, (_, issued)| now.saturating_duration_since(*issued) < SELECTION_TTL);
        if entries.len() >= SELECTION_LIMIT {
            return Err(Code::Busy.into());
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| Code::Unavailable)?;
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let id = format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        );
        if entries.contains_key(&id) {
            return Err(Code::Unavailable.into());
        }
        entries.insert(id.clone(), (row, now));
        Ok(id)
    }
    pub(super) fn get(&self, agent: &str, id: &str, now: Instant) -> Result<AgentRow> {
        let mut entries = self.0.lock().unwrap_or_else(|p| p.into_inner());
        entries.retain(|_, (_, issued)| now.saturating_duration_since(*issued) < SELECTION_TTL);
        entries
            .get(id)
            .filter(|(row, _)| row.id == agent)
            .map(|(row, _)| row.clone())
            .ok_or_else(|| Code::SelectionChanged.into())
    }
}
pub(super) fn same_selection(left: &AgentRow, right: &AgentRow) -> bool {
    left.id == right.id
        && left.source == right.source
        && left.command == right.command
        && left.args == right.args
        && left.env == right.env
        && left.created_at == right.created_at
        && left.updated_at == right.updated_at
}
pub(super) struct Directory {
    path: String,
    handle: File,
}
impl Directory {
    pub fn open(path: &str) -> Result<Self> {
        if path.len() > 4096 || path.chars().any(char::is_control) {
            return Err(Code::CwdUnavailable.into());
        }
        let handle = crate::file_access::open_directory(Path::new(path))
            .map_err(|_| Code::CwdUnavailable)?;
        Ok(Self {
            path: path.into(),
            handle,
        })
    }
    pub fn current(&self) -> bool {
        crate::file_access::open_directory(Path::new(&self.path))
            .and_then(|next| crate::file_access::same_object(&self.handle, &next))
            .unwrap_or(false)
    }
}
pub(super) fn command(
    row: &AgentRow,
    cwd: &str,
    environment: HashMap<String, String>,
) -> Result<Command> {
    admission(row)?;
    if environment
        .values()
        .any(|value| value == crate::auth::KEYCHAIN_MARKER)
    {
        return Err(Code::EnvironmentUnavailable.into());
    }
    let mut command = Command::new(&row.command);
    // Preserve the official environment including HOME/CODEX_HOME/CODEX_PATH.
    // This intentionally does not resolve Keychain or apply a selected service.
    command
        .args(&row.args)
        .args(["cli", "mcp", "list", "--json"])
        .current_dir(cwd)
        .envs(environment)
        .envs(row.env.iter().cloned());
    Ok(command)
}
