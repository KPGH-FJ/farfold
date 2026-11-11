//! Custom Agent environment values have an explicit ordinary/protected choice.
//! Only protected values enter the system vault; rows and pending settings keep
//! names/references. A pending record precedes vault writes so failed or interrupted
//! registration remains exactly attributable and can be retried or reset.
use super::{KEYCHAIN_MARKER, env_keychain_service};
use crate::meta_store::{AgentRow, MetaStore};
use std::collections::HashSet;
use std::sync::Mutex;

const PENDING_PREFIX: &str = "auth.custom-env.pending.v1.";
static MUTATION: Mutex<()> = Mutex::new(());
const SAVE_ERROR: &str = "无法保存安全环境变量，接入尚未添加，请检查系统凭据后重试";
const CLEANUP_ERROR: &str = "安全环境变量尚未清理完成，记录已保留，请重试";

/// Keep the same current rows and secure values while an explicit uninstall
/// checks references and deletes an owned program directory.
pub(crate) fn read_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    MUTATION
        .lock()
        .map_err(|_| "安全环境变量暂时不可用，请重试".into())
}

pub(crate) trait Vault {
    fn put(&self, service: &str, value: &str) -> Result<(), String>;
    fn delete(&self, service: &str) -> Result<(), String>;
}
struct SystemVault;
impl Vault for SystemVault {
    fn put(&self, service: &str, value: &str) -> Result<(), String> {
        super::keychain_store(service, value)
    }
    fn delete(&self, service: &str) -> Result<(), String> {
        super::keychain_delete(service)
    }
}

pub(crate) fn validate(
    ordinary: &[(String, String)],
    protected: &[(String, String)],
) -> Result<(), String> {
    let mut names = HashSet::new();
    for (name, value) in ordinary.iter().chain(protected) {
        let identity = if cfg!(windows) {
            name.to_ascii_uppercase()
        } else {
            name.clone()
        };
        if !crate::manual_auth::valid_env(name) || !names.insert(identity) {
            return Err("环境变量名称无效或重复，请检查普通值和安全值".into());
        }
        if value.contains('\0') {
            return Err("环境变量不能包含空字符".into());
        }
    }
    if ordinary.iter().any(|(_, value)| value == KEYCHAIN_MARKER) {
        return Err("此值保留给安全环境变量，请改用安全输入".into());
    }
    let limit = if cfg!(windows) { 2560 } else { 16384 };
    if protected.iter().any(|(_, value)| {
        value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control)
    }) {
        return Err("安全环境变量需要非空单行值，且不能超过系统凭据的大小限制".into());
    }
    Ok(())
}

pub(crate) fn register(
    store: &MetaStore,
    row: AgentRow,
    protected: &[(String, String)],
) -> Result<AgentRow, String> {
    register_with(store, row, protected, &SystemVault)
}

fn register_with(
    store: &MetaStore,
    mut row: AgentRow,
    protected: &[(String, String)],
    vault: &dyn Vault,
) -> Result<AgentRow, String> {
    validate(&row.env, protected)?;
    let _mutation = MUTATION.lock().map_err(|_| SAVE_ERROR)?;
    if protected.is_empty() {
        return store.insert_custom_agent(row);
    }
    cleanup_pending(store, vault)?;
    // Random identities never depend on user data or secret material. The row
    // stays unpublished until every write and its metadata commit succeeds.
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| SAVE_ERROR)?;
    row.id = format!(
        "custom-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    if store.get_agent(&row.id)?.is_some() {
        return Err(SAVE_ERROR.into());
    }
    let pending_key = format!("{PENDING_PREFIX}{}", row.id);
    let names: Vec<_> = protected.iter().map(|(name, _)| name.clone()).collect();
    store.set_setting(&pending_key, &serde_json::json!(names))?;
    let publish = (|| {
        for (name, value) in protected {
            vault
                .put(&env_keychain_service(&row.id, name), value)
                .map_err(|_| SAVE_ERROR)?;
        }
        row.env.extend(
            names
                .iter()
                .map(|name| (name.clone(), KEYCHAIN_MARKER.into())),
        );
        store.publish_custom_agent(&row, &pending_key)
    })();
    if let Err(error) = publish {
        // The metadata transaction includes clearing pending ownership. If a
        // published row exists, never delete its live values after an uncertain
        // commit result; strict launch resolution still checks each reference.
        match store.get_agent(&row.id) {
            Ok(Some(current)) if current == row => return Ok(current),
            Ok(None) => {}
            _ => return Err(CLEANUP_ERROR.into()),
        }
        cleanup_entry(store, vault, &pending_key, &row.id, &names)?;
        return Err(error);
    }
    Ok(row)
}

fn pending_entries(store: &MetaStore) -> Result<Vec<(String, String, Vec<String>)>, String> {
    let mut entries = Vec::new();
    for (key, value) in store.list_settings()? {
        let Some(id) = key.strip_prefix(PENDING_PREFIX) else {
            continue;
        };
        let Some(suffix) = id.strip_prefix("custom-") else {
            return Err(CLEANUP_ERROR.into());
        };
        if suffix.len() != 32
            || !suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(CLEANUP_ERROR.into());
        }
        let names: Vec<String> = serde_json::from_value(value).map_err(|_| CLEANUP_ERROR)?;
        if names.is_empty()
            || names
                .iter()
                .any(|name| !crate::manual_auth::valid_env(name))
        {
            return Err(CLEANUP_ERROR.into());
        }
        entries.push((key.clone(), id.to_owned(), names));
    }
    Ok(entries)
}

fn cleanup_entry(
    store: &MetaStore,
    vault: &dyn Vault,
    key: &str,
    id: &str,
    names: &[String],
) -> Result<(), String> {
    for name in names {
        vault
            .delete(&env_keychain_service(id, name))
            .map_err(|_| CLEANUP_ERROR)?;
    }
    store
        .forget_custom_env_pending(key)
        .map_err(|_| CLEANUP_ERROR.into())
}

fn cleanup_pending(store: &MetaStore, vault: &dyn Vault) -> Result<(), String> {
    for (key, id, names) in pending_entries(store)? {
        // Publishing and clearing this entry is atomic; an unexpected live row
        // must be reviewed, never treated as an orphan by name alone.
        if store.get_agent(&id)?.is_some() {
            return Err(CLEANUP_ERROR.into());
        }
        cleanup_entry(store, vault, &key, &id, &names)?;
    }
    Ok(())
}

pub(crate) fn secret_services(store: &MetaStore) -> Result<Vec<String>, String> {
    let mut services = Vec::new();
    for row in store.list_agents()? {
        services.extend(
            row.env
                .iter()
                .filter(|(_, value)| value == KEYCHAIN_MARKER)
                .map(|(name, _)| env_keychain_service(&row.id, name)),
        );
    }
    for (_, id, names) in pending_entries(store)? {
        services.extend(names.iter().map(|name| env_keychain_service(&id, name)));
    }
    services.sort();
    services.dedup();
    Ok(services)
}

pub(crate) fn remove_agent(store: &MetaStore, id: &str) -> Result<bool, String> {
    remove_agent_with(store, id, &SystemVault)
}
fn remove_agent_with(store: &MetaStore, id: &str, vault: &dyn Vault) -> Result<bool, String> {
    let _mutation = MUTATION.lock().map_err(|_| CLEANUP_ERROR)?;
    store.require_mcp_agent_ready(id)?;
    if let Some(row) = store.get_agent(id)? {
        for (name, value) in row.env {
            if value == KEYCHAIN_MARKER {
                vault
                    .delete(&env_keychain_service(id, &name))
                    .map_err(|_| CLEANUP_ERROR)?;
            }
        }
    }
    // A failure above retains the exact references for retry. A failure below
    // also keeps the row; no missing key can silently use another account.
    store.remove_agent(id)
}

#[cfg(test)]
mod tests;
