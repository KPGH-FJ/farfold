//! Optional user-granted secrets. Only references/labels are stored in settings.
use crate::{auth, meta_store::MetaStore};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager};
const SETTING: &str = "credentials.v1";
static MUTATION: Mutex<()> = Mutex::new(());
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub agent_id: String,
    pub env_name: String,
    pub override_existing: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credential {
    id: String,
    label: String,
    provider: String,
    endpoint: String,
    api_type: String,
    secret_ref: String,
    retired: Vec<String>,
    grants: Vec<Grant>,
    deleting: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    id: String,
    label: String,
    provider: String,
    endpoint: String,
    api_type: String,
    grants: Vec<Grant>,
    deleting: bool,
}
impl From<&Credential> for View {
    fn from(c: &Credential) -> Self {
        Self {
            id: c.id.clone(),
            label: c.label.clone(),
            provider: c.provider.clone(),
            endpoint: c.endpoint.clone(),
            api_type: c.api_type.clone(),
            grants: c.grants.clone(),
            deleting: c.deleting,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveInput {
    pub id: Option<String>,
    pub label: String,
    pub provider: String,
    pub endpoint: String,
    pub api_type: String,
    pub key: String,
}
trait Vault {
    fn put(&self, id: &str, key: &str) -> Result<(), String>;
    fn get(&self, id: &str) -> Option<String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}
struct Keychain;
impl Vault for Keychain {
    fn put(&self, id: &str, key: &str) -> Result<(), String> {
        auth::keychain_store(&format!("farfold.credential.{id}"), key)
    }
    fn get(&self, id: &str) -> Option<String> {
        auth::keychain_lookup(&format!("farfold.credential.{id}"))
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        auth::keychain_delete(&format!("farfold.credential.{id}"))
    }
}
fn unique() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!(
        "{:x}-{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}
fn read(store: &MetaStore) -> Result<Vec<Credential>, String> {
    match store.get_setting(SETTING)? {
        None => Ok(vec![]),
        Some(v) => serde_json::from_value(v).map_err(|_| "无法读取密钥设置，原数据已保留".into()),
    }
}
fn write(store: &MetaStore, pool: &[Credential]) -> Result<(), String> {
    store.set_setting(
        SETTING,
        &serde_json::to_value(pool).map_err(|_| "无法保存密钥设置")?,
    )
}
fn save(store: &MetaStore, vault: &dyn Vault, input: SaveInput) -> Result<View, String> {
    if input.label.trim().is_empty()
        || [
            &input.label,
            &input.provider,
            &input.endpoint,
            &input.api_type,
        ]
        .iter()
        .any(|s| s.len() > 300 || s.chars().any(char::is_control))
    {
        return Err("请填写简短的密钥用途说明".into());
    }
    if !input.endpoint.is_empty() {
        let url =
            reqwest::Url::parse(&input.endpoint).map_err(|_| "请输入不含密码的 HTTPS 服务地址")?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("请输入不含密码的 HTTPS 服务地址".into());
        }
    }
    if input.key.trim().is_empty()
        || input.key.len() > 16384
        || input.key.chars().any(char::is_control)
    {
        return Err("请输入有效的单行密钥".into());
    }
    let mut pool = read(store)?;
    let index = if let Some(id) = input.id.as_ref() {
        Some(
            pool.iter()
                .position(|c| &c.id == id && !c.deleting)
                .ok_or("此密钥已移除，请刷新")?,
        )
    } else {
        None
    };
    let secret_ref = unique();
    vault.put(&secret_ref, &input.key)?;
    let mut item = if let Some(i) = index {
        pool[i].clone()
    } else {
        Credential {
            id: unique(),
            label: String::new(),
            provider: String::new(),
            endpoint: String::new(),
            api_type: String::new(),
            secret_ref: String::new(),
            retired: vec![],
            grants: vec![],
            deleting: false,
        }
    };
    if !item.secret_ref.is_empty() {
        item.retired.push(item.secret_ref.clone());
    }
    item.secret_ref = secret_ref.clone();
    item.label = input.label.trim().into();
    item.provider = input.provider.trim().into();
    item.endpoint = input.endpoint;
    item.api_type = input.api_type;
    if let Some(i) = index {
        pool[i] = item.clone();
    } else {
        pool.push(item.clone());
    }
    if let Err(e) = write(store, &pool) {
        let _ = vault.delete(&secret_ref);
        return Err(e);
    }
    // Stale references remain tracked for retry on deletion if Keychain is locked.
    for old in &item.retired {
        let _ = vault.delete(old);
    }
    Ok(View::from(&item))
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrantResult {
    pub applied: bool,
    pub conflicts: Vec<String>,
}
fn grant(
    store: &MetaStore,
    id: &str,
    agent_id: &str,
    env_name: &str,
    replace: bool,
    inherited: &HashMap<String, String>,
) -> Result<GrantResult, String> {
    if !crate::manual_auth::valid_env(env_name) {
        return Err("请输入有效的密钥变量名".into());
    }
    let row = store.get_agent(agent_id)?.ok_or("请先添加此 Agent")?;
    let mut pool = read(store)?;
    let index = pool
        .iter()
        .position(|c| c.id == id && !c.deleting)
        .ok_or("此密钥已移除，请刷新")?;
    let mut conflicts = vec![];
    if row.env.iter().any(|(name, _)| name == env_name) {
        conflicts.push("该 Agent 的单独设置".into());
    }
    if inherited.contains_key(env_name) {
        conflicts.push("当前系统环境".into());
    }
    if pool.iter().any(|c| {
        c.id != id
            && c.grants
                .iter()
                .any(|g| g.agent_id == agent_id && g.env_name == env_name)
    }) {
        conflicts.push("另一份共享密钥".into());
    }
    if !replace && !conflicts.is_empty() {
        return Ok(GrantResult {
            applied: false,
            conflicts,
        });
    }
    for c in &mut pool {
        c.grants
            .retain(|g| g.agent_id != agent_id || g.env_name != env_name);
    }
    pool[index].grants.push(Grant {
        agent_id: agent_id.into(),
        env_name: env_name.into(),
        override_existing: replace,
    });
    write(store, &pool)?;
    Ok(GrantResult {
        applied: true,
        conflicts: vec![],
    })
}
fn apply_with(
    store: &MetaStore,
    agent_id: &str,
    env: &mut HashMap<String, String>,
    vault: &dyn Vault,
) -> Result<(), String> {
    for c in read(store)?.iter().filter(|c| !c.deleting) {
        for g in c.grants.iter().filter(|g| g.agent_id == agent_id) {
            if !g.override_existing && env.contains_key(&g.env_name) {
                return Err("密钥变量出现新的来源冲突，请在设置中确认使用哪份密钥".into());
            }
            let key = vault
                .get(&c.secret_ref)
                .ok_or("无法读取已授权的密钥，请检查系统钥匙串后重试")?;
            env.insert(g.env_name.clone(), key);
        }
    }
    Ok(())
}
pub(crate) fn apply(
    store: &MetaStore,
    agent_id: &str,
    env: &mut HashMap<String, String>,
) -> Result<(), String> {
    apply_with(store, agent_id, env, &Keychain)
}

pub(crate) fn legacy_allowed(
    store: &MetaStore,
    agent_id: &str,
    env_name: &str,
) -> Result<(), String> {
    if read(store)?.iter().any(|c| {
        !c.deleting
            && c.grants
                .iter()
                .any(|g| g.agent_id == agent_id && g.env_name == env_name)
    }) {
        return Err("此变量正在使用共享密钥，请先在密钥与授权中撤销该授权".into());
    }
    Ok(())
}
fn remove(store: &MetaStore, vault: &dyn Vault, id: &str) -> Result<(), String> {
    let mut pool = read(store)?;
    let item = pool.iter_mut().find(|c| c.id == id).ok_or("此密钥已移除")?;
    item.grants.clear();
    item.deleting = true;
    let refs = std::iter::once(item.secret_ref.clone())
        .chain(item.retired.clone())
        .collect::<Vec<_>>();
    write(store, &pool)?;
    for reference in refs {
        vault.delete(&reference)?;
    }
    pool.retain(|c| c.id != id);
    write(store, &pool)
}
#[tauri::command]
pub async fn credential_list(app: AppHandle) -> Result<Vec<View>, String> {
    let store = app.state::<MetaStore>().inner().clone();
    store
        .run(|store| Ok(read(store)?.iter().map(View::from).collect()))
        .await
}
#[tauri::command]
pub async fn credential_save(app: AppHandle, input: SaveInput) -> Result<View, String> {
    let store = app.state::<MetaStore>().inner().clone();
    store
        .run(move |store| {
            let _lock = MUTATION.lock().map_err(|_| "密钥设置暂时不可用")?;
            save(store, &Keychain, input)
        })
        .await
}
#[tauri::command]
pub async fn credential_grant(
    app: AppHandle,
    id: String,
    agent_id: String,
    env_name: String,
    replace: bool,
) -> Result<GrantResult, String> {
    let store = app.state::<MetaStore>().inner().clone();
    store
        .run(move |store| {
            let _lock = MUTATION.lock().map_err(|_| "密钥设置暂时不可用")?;
            grant(
                store,
                &id,
                &agent_id,
                &env_name,
                replace,
                &crate::shell_env::command_env(),
            )
        })
        .await
}
#[tauri::command]
pub async fn credential_revoke(
    app: AppHandle,
    id: String,
    agent_id: String,
    env_name: String,
) -> Result<(), String> {
    let store = app.state::<MetaStore>().inner().clone();
    store
        .run(move |store| {
            let _lock = MUTATION.lock().map_err(|_| "密钥设置暂时不可用")?;
            let mut pool = read(store)?;
            let c = pool.iter_mut().find(|c| c.id == id).ok_or("此密钥已移除")?;
            c.grants
                .retain(|g| g.agent_id != agent_id || g.env_name != env_name);
            write(store, &pool)
        })
        .await
}
#[tauri::command]
pub async fn credential_delete(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<MetaStore>().inner().clone();
    store
        .run(move |store| {
            let _lock = MUTATION.lock().map_err(|_| "密钥设置暂时不可用")?;
            remove(store, &Keychain, &id)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    #[derive(Default)]
    struct Fake {
        keys: RefCell<HashMap<String, String>>,
        fail: Cell<bool>,
        delete_fail: Cell<bool>,
    }
    impl Vault for Fake {
        fn put(&self, id: &str, key: &str) -> Result<(), String> {
            if self.fail.get() {
                return Err("locked".into());
            }
            self.keys.borrow_mut().insert(id.into(), key.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Option<String> {
            self.keys.borrow().get(id).cloned()
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            if self.delete_fail.get() {
                return Err("locked".into());
            }
            self.keys.borrow_mut().remove(id);
            Ok(())
        }
    }
    fn input(id: Option<String>, key: &str) -> SaveInput {
        SaveInput {
            id,
            label: "account".into(),
            provider: "fixture".into(),
            endpoint: "https://example.test/api".into(),
            api_type: "test".into(),
            key: key.into(),
        }
    }
    fn store() -> (tempfile::TempDir, MetaStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("store.sqlite3")).unwrap();
        for id in ["a", "b"] {
            store
                .upsert_agent(&crate::meta_store::AgentRow {
                    id: id.into(),
                    name: id.into(),
                    source: "custom".into(),
                    command: "/bin/false".into(),
                    args: vec![],
                    env: vec![("TOKEN".into(), "existing".into())],
                    version: None,
                    handshake: None,
                    created_at: 0,
                    updated_at: 0,
                })
                .unwrap();
        }
        (dir, store)
    }
    #[test]
    fn explicit_grants_isolate_same_named_variables_and_revoke_restores_original() {
        let (_dir, store) = store();
        let vault = Fake::default();
        let a = save(&store, &vault, input(None, "secret-a")).unwrap();
        let b = save(&store, &vault, input(None, "secret-b")).unwrap();
        assert!(
            !grant(&store, &a.id, "a", "TOKEN", false, &HashMap::new())
                .unwrap()
                .applied
        );
        grant(&store, &a.id, "a", "TOKEN", true, &HashMap::new()).unwrap();
        grant(&store, &b.id, "b", "TOKEN", true, &HashMap::new()).unwrap();
        let mut env = HashMap::from([("TOKEN".into(), "inherited".into())]);
        apply_with(&store, "a", &mut env, &vault).unwrap();
        assert_eq!(env["TOKEN"], "secret-a");
        apply_with(&store, "b", &mut env, &vault).unwrap();
        assert_eq!(env["TOKEN"], "secret-b");
        let metadata = store.get_setting(SETTING).unwrap().unwrap().to_string();
        assert!(!metadata.contains("secret-a"));
        assert!(!metadata.contains("secret-b"));
        remove(&store, &vault, &a.id).unwrap();
        let mut restored = HashMap::from([("TOKEN".into(), "inherited".into())]);
        apply_with(&store, "a", &mut restored, &vault).unwrap();
        assert_eq!(restored["TOKEN"], "inherited");
        assert_eq!(store.get_agent("a").unwrap().unwrap().env[0].1, "existing");
    }
    #[test]
    fn failed_rotation_keeps_working_secret_and_delete_failure_is_retryable() {
        let (_dir, store) = store();
        let vault = Fake::default();
        let a = save(&store, &vault, input(None, "first")).unwrap();
        grant(&store, &a.id, "a", "TOKEN", true, &HashMap::new()).unwrap();
        vault.fail.set(true);
        assert!(save(&store, &vault, input(Some(a.id.clone()), "second")).is_err());
        let mut env = HashMap::new();
        apply_with(&store, "a", &mut env, &vault).unwrap();
        assert_eq!(env["TOKEN"], "first");
        vault.fail.set(false);
        save(&store, &vault, input(Some(a.id.clone()), "second")).unwrap();
        apply_with(&store, "a", &mut env, &vault).unwrap();
        assert_eq!(env["TOKEN"], "second");
        vault.delete_fail.set(true);
        assert!(remove(&store, &vault, &a.id).is_err());
        assert!(read(&store).unwrap()[0].deleting);
        let mut untouched = HashMap::new();
        apply_with(&store, "a", &mut untouched, &vault).unwrap();
        assert!(untouched.is_empty());
        vault.delete_fail.set(false);
        remove(&store, &vault, &a.id).unwrap();
        assert!(read(&store).unwrap().is_empty());
    }
    #[test]
    fn newly_inherited_conflict_and_missing_key_prevent_launch() {
        let (_dir, store) = store();
        let vault = Fake::default();
        let c = save(&store, &vault, input(None, "first")).unwrap();
        grant(&store, &c.id, "a", "NEW_TOKEN", false, &HashMap::new()).unwrap();
        assert!(
            apply_with(
                &store,
                "a",
                &mut HashMap::from([("NEW_TOKEN".into(), "new-source".into())]),
                &vault
            )
            .is_err()
        );
        vault.keys.borrow_mut().clear();
        assert!(apply_with(&store, "a", &mut HashMap::new(), &vault).is_err());
    }
}

#[cfg(test)]
mod keychain_test {
    use super::*;
    #[test]
    #[ignore = "writes and removes one non-account test key in the local Keychain"]
    fn real_keychain_roundtrip() {
        let id = format!("test-{}", unique());
        let key = "FARFOLD-NON-ACCOUNT-KEYCHAIN-FIXTURE";
        let saved = Keychain.put(&id, key);
        let matched = saved.is_ok() && Keychain.get(&id).as_deref() == Some(key);
        let removed = Keychain.delete(&id);
        assert!(saved.is_ok() && matched && removed.is_ok());
        assert!(Keychain.get(&id).is_none());
    }
}
