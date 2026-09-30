//! Optional user-granted secrets. Only references/labels are stored in settings.
use crate::{auth, meta_store::MetaStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    #[serde(default)]
    models: Vec<String>,
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
    models: Vec<String>,
    revision: String,
    complete: bool,
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
            models: c.models.clone(),
            revision: service_revision(&c.endpoint, &c.api_type, &c.models, &c.secret_ref),
            complete: complete_service(c),
            grants: c.grants.clone(),
            deleting: c.deleting,
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveInput {
    pub id: Option<String>,
    pub label: String,
    pub provider: String,
    pub endpoint: String,
    pub api_type: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub models: Vec<String>,
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

pub(crate) fn validate_endpoint(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "请输入不含密码的 HTTPS 基础地址")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || value.len() > 300
        || value.chars().any(char::is_control)
    {
        return Err("请输入不含密码的 HTTPS 基础地址".into());
    }
    let path = url.path().trim_end_matches('/');
    if ["/chat/completions", "/responses", "/messages", "/models"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
    {
        return Err("请填写基础地址，不要包含具体请求路径".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn validate_api_type(value: &str) -> Result<(), String> {
    if !matches!(value, "chat-completions" | "responses" | "messages") {
        return Err("请选择接口格式，已有记录不会自动推断".into());
    }
    Ok(())
}

pub(crate) fn valid_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn validate_models(values: &[String], required: bool) -> Result<Vec<String>, String> {
    if values.len() > 500 || (required && values.is_empty()) {
        return Err("请添加至少一个模型，最多支持 500 个模型".into());
    }
    let mut models = Vec::new();
    for value in values {
        let value = value.trim();
        if !valid_model(value) {
            return Err("请输入有效的模型 ID".into());
        }
        if !models.iter().any(|m| m == value) {
            models.push(value.to_string());
        }
    }
    Ok(models)
}

fn validate_secret(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 16384 || value.chars().any(char::is_control) {
        return Err("请输入有效的单行 API Key".into());
    }
    Ok(())
}

fn complete_service(item: &Credential) -> bool {
    validate_endpoint(&item.endpoint).is_ok()
        && validate_api_type(&item.api_type).is_ok()
        && validate_models(&item.models, true).is_ok()
}

#[derive(Clone, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceSelection {
    pub id: String,
    pub model: String,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceIdentity {
    pub id: String,
    pub fingerprint: String,
    pub model: String,
}

// This contains a credential. Never derive Debug or Serialize.
pub(crate) struct ServiceSnapshot {
    pub identity: ServiceIdentity,
    pub endpoint: String,
    pub api_type: String,
    pub models: Vec<String>,
    pub secret: String,
    pub connection_revision: String,
}

fn digest(value: &impl Serialize) -> String {
    let bytes = serde_json::to_vec(value).expect("service digest uses serializable strings");
    let mut result = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        use std::fmt::Write as _;
        let _ = write!(result, "{byte:02x}");
    }
    result
}

fn service_revision(endpoint: &str, api_type: &str, models: &[String], secret_ref: &str) -> String {
    let endpoint = validate_endpoint(endpoint).unwrap_or_else(|_| endpoint.to_string());
    digest(&(&endpoint, api_type, models, secret_ref))
}

fn snapshot_with(
    store: &MetaStore,
    selection: &ServiceSelection,
    expected: Option<&ServiceIdentity>,
    vault: &dyn Vault,
) -> Result<ServiceSnapshot, String> {
    let item = read(store)?
        .into_iter()
        .find(|c| c.id == selection.id && !c.deleting)
        .ok_or("此 API 配置已移除，请重新选择")?;
    let endpoint = validate_endpoint(&item.endpoint)?;
    validate_api_type(&item.api_type)?;
    let models = validate_models(&item.models, true)?;
    if !models.contains(&selection.model) {
        return Err("此模型已不在 API 配置中，请检查设置".into());
    }
    let identity = ServiceIdentity {
        id: item.id,
        fingerprint: digest(&(&endpoint, &item.api_type)),
        model: selection.model.clone(),
    };
    if expected.is_some_and(|expected| expected != &identity) {
        return Err("此对话的 API 来源已改变，无法继续使用原设置".into());
    }
    let secret = vault
        .get(&item.secret_ref)
        .ok_or("无法读取 API Key，请检查系统钥匙串后重试")?;
    validate_secret(&secret)?;
    let connection_revision =
        service_revision(&endpoint, &item.api_type, &models, &item.secret_ref);
    Ok(ServiceSnapshot {
        identity,
        endpoint,
        api_type: item.api_type,
        models,
        secret,
        connection_revision,
    })
}

pub(crate) fn service_snapshot(
    store: &MetaStore,
    selection: &ServiceSelection,
    expected: Option<&ServiceIdentity>,
) -> Result<ServiceSnapshot, String> {
    let _lock = MUTATION.lock().map_err(|_| "API 配置暂时不可用")?;
    snapshot_with(store, selection, expected, &Keychain)
}

pub(crate) fn validate_service_identity(
    store: &MetaStore,
    expected: &ServiceIdentity,
) -> Result<(), String> {
    let _lock = MUTATION.lock().map_err(|_| "API 配置暂时不可用")?;
    let item = read(store)?
        .into_iter()
        .find(|c| c.id == expected.id && !c.deleting)
        .ok_or("此对话使用的 API 配置已移除")?;
    let endpoint = validate_endpoint(&item.endpoint)?;
    validate_api_type(&item.api_type)?;
    if digest(&(&endpoint, &item.api_type)) != expected.fingerprint
        || !validate_models(&item.models, true)?.contains(&expected.model)
    {
        return Err("此对话的 API 来源或模型已改变，请检查设置".into());
    }
    Ok(())
}

// Test requests may read a credential without selecting an Agent or granting it access.
pub(crate) struct ApiConfiguration {
    pub endpoint: String,
    pub api_type: String,
    pub secret: String,
}

fn api_configuration_with(
    store: &MetaStore,
    saved_id: Option<&str>,
    draft: Option<&SaveInput>,
    vault: &dyn Vault,
) -> Result<ApiConfiguration, String> {
    let pool = read(store)?;
    let item = saved_id
        .or_else(|| draft.and_then(|d| d.id.as_deref()))
        .map(|id| {
            pool.iter()
                .find(|c| c.id == id && !c.deleting)
                .ok_or("此 API 配置已移除")
        })
        .transpose()?;
    let (endpoint, api_type, provided_key) = match draft {
        Some(draft) => (
            validate_endpoint(&draft.endpoint)?,
            draft.api_type.clone(),
            draft.key.as_str(),
        ),
        None => {
            let item = item.ok_or("请选择 API 配置")?;
            (
                validate_endpoint(&item.endpoint)?,
                item.api_type.clone(),
                "",
            )
        }
    };
    validate_api_type(&api_type)?;
    let secret = if provided_key.is_empty() {
        let item = item.ok_or("请输入 API Key")?;
        if validate_endpoint(&item.endpoint)? != endpoint || item.api_type != api_type {
            return Err("服务地址或接口已改变，请重新输入 API Key".into());
        }
        vault
            .get(&item.secret_ref)
            .ok_or("无法读取 API Key，请检查系统钥匙串后重试")?
    } else {
        provided_key.to_string()
    };
    validate_secret(&secret)?;
    Ok(ApiConfiguration {
        endpoint,
        api_type,
        secret,
    })
}

pub(crate) fn api_configuration(
    store: &MetaStore,
    saved_id: Option<&str>,
    draft: Option<&SaveInput>,
) -> Result<ApiConfiguration, String> {
    let _lock = MUTATION.lock().map_err(|_| "API 配置暂时不可用")?;
    api_configuration_with(store, saved_id, draft, &Keychain)
}
fn save(store: &MetaStore, vault: &dyn Vault, mut input: SaveInput) -> Result<View, String> {
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
    let previous = index.map(|i| &pool[i]);
    // Old credentials may have only a label/Key and an existing env grant.
    // Keep that exact metadata for a Key rotation or description edit; this
    // never upgrades the record into a selectable model service.
    let preserving_legacy = previous.is_some_and(|previous| {
        !complete_service(previous)
            && previous.endpoint == input.endpoint
            && previous.api_type == input.api_type
            && previous.models == input.models
    });
    if !preserving_legacy {
        input.endpoint = validate_endpoint(&input.endpoint)?;
        validate_api_type(&input.api_type)?;
        input.models = validate_models(&input.models, true)?;
    }
    if previous.is_some_and(|previous| {
        !preserving_legacy
            && !previous.grants.is_empty()
            && (validate_endpoint(&previous.endpoint).ok().as_deref()
                != Some(input.endpoint.as_str())
                || previous.api_type != input.api_type)
    }) {
        return Err("请先撤销已有授权，再修改服务地址或接口格式".into());
    }
    let replacing_key = !input.key.is_empty();
    if !replacing_key {
        let previous = previous.ok_or("请输入 API Key")?;
        if !preserving_legacy
            && (validate_endpoint(&previous.endpoint).ok().as_deref()
                != Some(input.endpoint.as_str())
                || previous.api_type != input.api_type)
        {
            return Err("服务地址或接口已改变，请重新输入 API Key".into());
        }
    } else {
        validate_secret(&input.key)?;
    }
    let secret_ref = if replacing_key {
        let reference = unique();
        vault.put(&reference, &input.key)?;
        reference
    } else {
        previous
            .expect("existing record checked")
            .secret_ref
            .clone()
    };
    let mut item = if let Some(i) = index {
        pool[i].clone()
    } else {
        Credential {
            id: unique(),
            label: String::new(),
            provider: String::new(),
            endpoint: String::new(),
            api_type: String::new(),
            models: vec![],
            secret_ref: String::new(),
            retired: vec![],
            grants: vec![],
            deleting: false,
        }
    };
    if replacing_key && !item.secret_ref.is_empty() {
        item.retired.push(item.secret_ref.clone());
    }
    item.secret_ref = secret_ref.clone();
    item.label = input.label.trim().into();
    item.provider = input.provider.trim().into();
    item.endpoint = input.endpoint;
    item.api_type = input.api_type;
    item.models = input.models;
    if let Some(i) = index {
        pool[i] = item.clone();
    } else {
        pool.push(item.clone());
    }
    if let Err(e) = write(store, &pool) {
        if replacing_key {
            let _ = vault.delete(&secret_ref);
        }
        return Err(e);
    }
    // Stale references remain tracked for retry on deletion if Keychain is locked.
    for old in &item.retired {
        let _ = vault.delete(old);
    }
    Ok(View::from(&item))
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
pub async fn credential_revoke(
    app: AppHandle,
    id: String,
    agent_id: String,
    env_name: String,
) -> Result<(), String> {
    let store = app.state::<MetaStore>().inner().clone();
    revoke_grant(store, id, agent_id, env_name).await
}

async fn revoke_grant(
    store: MetaStore,
    id: String,
    agent_id: String,
    env_name: String,
) -> Result<(), String> {
    let _configuration = crate::install_job::configuration_guard(&agent_id).await;
    store
        .run(move |store| {
            let _configuration = _configuration;
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
        reads: Cell<usize>,
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
            self.reads.set(self.reads.get() + 1);
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
            api_type: "chat-completions".into(),
            key: key.into(),
            models: vec!["fixture-model".into()],
        }
    }
    fn store() -> (tempfile::TempDir, MetaStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("store.sqlite3")).unwrap();
        for id in ["a", "b"] {
            store
                .insert_agent(&crate::meta_store::AgentRow {
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

    // Simulate already persisted authorization, whose creation UI no longer exists.
    fn legacy_grant(store: &MetaStore, id: &str, agent: &str, env: &str, override_existing: bool) {
        let mut pool = read(store).unwrap();
        pool.iter_mut()
            .find(|item| item.id == id)
            .unwrap()
            .grants
            .push(Grant {
                agent_id: agent.into(),
                env_name: env.into(),
                override_existing,
            });
        write(store, &pool).unwrap();
    }

    #[tokio::test]
    async fn access_regression_cancelled_caller_keeps_guard_until_worker_finishes() {
        use std::time::Duration;
        let (_dir, store) = store();
        let credential = save(&store, &Fake::default(), input(None, "fixture-secret")).unwrap();
        legacy_grant(&store, &credential.id, "a", "TOKEN", true);
        let (locked, ready) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let blocker = std::thread::spawn(move || {
            let _lock = MUTATION.lock().unwrap();
            locked.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(3)).unwrap();
        });
        ready.await.unwrap();
        let worker = tokio::spawn(revoke_grant(
            store.clone(),
            credential.id,
            "a".into(),
            "TOKEN".into(),
        ));
        tokio::task::yield_now().await;
        let before = tokio::time::timeout(
            Duration::from_millis(20),
            crate::install_job::configuration_guard("a"),
        )
        .await;
        let was_locked = before.is_err();
        drop(before);
        worker.abort();
        let _ = worker.await;
        let after = tokio::time::timeout(
            Duration::from_millis(20),
            crate::install_job::configuration_guard("a"),
        )
        .await;
        let stayed_locked = after.is_err();
        drop(after);
        release.send(()).unwrap();
        blocker.join().unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while read(&store)
                .unwrap()
                .iter()
                .any(|record| record.grants.iter().any(|grant| grant.agent_id == "a"))
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            was_locked,
            "the original caller must reserve the configuration"
        );
        assert!(
            stayed_locked,
            "cancelling the caller must not release a still-running worker's guard"
        );
        let _guard = tokio::time::timeout(
            Duration::from_secs(2),
            crate::install_job::configuration_guard("a"),
        )
        .await
        .unwrap();
    }
    #[test]
    fn rotation_and_revoke_change_only_the_authorized_agents_environment() {
        let (_dir, store) = store();
        let vault = Fake::default();
        let a = save(&store, &vault, input(None, "initial")).unwrap();
        legacy_grant(&store, &a.id, "a", "TOKEN", true);
        legacy_grant(&store, &a.id, "b", "TOKEN", true);
        let mut env_a = HashMap::new();
        let mut env_b = HashMap::new();
        apply_with(&store, "a", &mut env_a, &vault).unwrap();
        apply_with(&store, "b", &mut env_b, &vault).unwrap();
        assert_eq!(env_a["TOKEN"], "initial");
        assert_eq!(env_b["TOKEN"], "initial");
        revoke_agent(&store, "a").unwrap();
        env_a.clear();
        env_b.clear();
        apply_with(&store, "a", &mut env_a, &vault).unwrap();
        apply_with(&store, "b", &mut env_b, &vault).unwrap();
        assert!(env_a.is_empty());
        assert_eq!(env_b["TOKEN"], "initial");
        save(&store, &vault, input(Some(a.id), "replacement")).unwrap();
        env_b.clear();
        apply_with(&store, "b", &mut env_b, &vault).unwrap();
        assert_eq!(env_b["TOKEN"], "replacement");
        assert_eq!(read(&store).unwrap()[0].grants.len(), 1);
    }
    #[test]
    fn historical_grants_isolate_same_named_variables_and_revoke_restores_original() {
        let (_dir, store) = store();
        let vault = Fake::default();
        let a = save(&store, &vault, input(None, "secret-a")).unwrap();
        let b = save(&store, &vault, input(None, "secret-b")).unwrap();
        legacy_grant(&store, &a.id, "a", "TOKEN", true);
        legacy_grant(&store, &b.id, "b", "TOKEN", true);
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
        legacy_grant(&store, &a.id, "a", "TOKEN", true);
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
        legacy_grant(&store, &c.id, "a", "NEW_TOKEN", false);
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

    #[test]
    fn source_changes_require_revoking_legacy_grants_before_key_replacement() {
        let (_dir, store) = store();
        let vault = Fake::default();
        let saved = save(&store, &vault, input(None, "service-secret")).unwrap();
        legacy_grant(&store, &saved.id, "a", "TOKEN", true);
        let selection = ServiceSelection {
            id: saved.id.clone(),
            model: "fixture-model".into(),
        };
        let original = snapshot_with(&store, &selection, None, &vault).unwrap();
        let original_reference = read(&store).unwrap()[0].secret_ref.clone();
        let mut edit = input(Some(saved.id.clone()), "");
        edit.label = "renamed".into();
        save(&store, &vault, edit).unwrap();
        let current = snapshot_with(&store, &selection, Some(&original.identity), &vault).unwrap();
        assert_eq!(current.secret, "service-secret");
        assert_eq!(current.connection_revision, original.connection_revision);
        assert_eq!(read(&store).unwrap()[0].secret_ref, original_reference);
        assert_eq!(read(&store).unwrap()[0].grants.len(), 1);

        let mut changed = input(Some(saved.id.clone()), "");
        changed.endpoint = "https://other.test/v1".into();
        assert!(save(&store, &vault, changed.clone()).is_err());
        assert!(api_configuration_with(&store, None, Some(&changed), &vault).is_err());
        changed.key = "new-service-secret".into();
        let before = store.get_setting(SETTING).unwrap();
        assert!(
            save(&store, &vault, changed.clone())
                .err()
                .unwrap()
                .contains("先撤销")
        );
        let mut changed_format = input(Some(saved.id.clone()), "new-service-secret");
        changed_format.api_type = "responses".into();
        assert!(
            save(&store, &vault, changed_format)
                .err()
                .unwrap()
                .contains("先撤销")
        );
        assert_eq!(store.get_setting(SETTING).unwrap(), before);
        assert_eq!(vault.keys.borrow().len(), 1);
        assert!(
            vault
                .keys
                .borrow()
                .values()
                .all(|key| key == "service-secret")
        );
        revoke_agent(&store, "a").unwrap();
        assert!(save(&store, &vault, input(Some(saved.id.clone()), "")).is_ok());
        save(&store, &vault, changed).unwrap();
        let reads = vault.reads.get();
        assert!(snapshot_with(&store, &selection, Some(&original.identity), &vault).is_err());
        assert_eq!(
            vault.reads.get(),
            reads,
            "a changed source must be rejected before reading its Key"
        );
        assert!(validate_service_identity(&store, &original.identity).is_err());
    }

    #[test]
    fn rotation_changes_connection_revision_without_changing_service_identity() {
        let (_dir, store) = store();
        let vault = Fake::default();
        let saved = save(&store, &vault, input(None, "first")).unwrap();
        let selection = ServiceSelection {
            id: saved.id.clone(),
            model: "fixture-model".into(),
        };
        let before = snapshot_with(&store, &selection, None, &vault).unwrap();
        save(&store, &vault, input(Some(saved.id), "second")).unwrap();
        let after = snapshot_with(&store, &selection, Some(&before.identity), &vault).unwrap();
        assert_eq!(before.identity, after.identity);
        assert_ne!(before.connection_revision, after.connection_revision);
        assert_eq!(after.secret, "second");
        assert!(validate_service_identity(&store, &before.identity).is_ok());
        assert!(
            read(&store).unwrap()[0].grants.is_empty(),
            "saving is not authorization to an Agent"
        );
    }

    #[test]
    fn legacy_record_keeps_identity_key_reference_and_grants_without_inventing_models() {
        let (_dir, store) = store();
        let vault = Fake::default();
        let saved = save(&store, &vault, input(None, "legacy-secret")).unwrap();
        legacy_grant(&store, &saved.id, "a", "TOKEN", true);
        let before = read(&store).unwrap().remove(0);
        let mut record = serde_json::to_value(&before).unwrap();
        record.as_object_mut().unwrap().remove("models");
        record["apiType"] = serde_json::Value::String(String::new());
        store
            .set_setting(SETTING, &serde_json::json!([record]))
            .unwrap();
        let restored = read(&store).unwrap().remove(0);
        assert_eq!(restored.id, before.id);
        assert_eq!(restored.secret_ref, before.secret_ref);
        assert_eq!(restored.grants, before.grants);
        assert!(restored.models.is_empty());
        assert!(api_configuration_with(&store, Some(&saved.id), None, &vault).is_err());
        let mut env = HashMap::new();
        apply_with(&store, "a", &mut env, &vault).unwrap();
        assert_eq!(env["TOKEN"], "legacy-secret");

        let mut edit = input(Some(saved.id.clone()), "replacement");
        edit.api_type.clear();
        edit.models.clear();
        edit.label = "updated description".into();
        let rotated = save(&store, &vault, edit.clone()).unwrap();
        assert!(!rotated.complete);
        assert_eq!(rotated.id, before.id);
        assert_eq!(rotated.grants, before.grants);
        assert!(rotated.api_type.is_empty());
        assert!(rotated.models.is_empty());
        env.clear();
        apply_with(&store, "a", &mut env, &vault).unwrap();
        assert_eq!(env["TOKEN"], "replacement");
        let reference = read(&store).unwrap()[0].secret_ref.clone();
        edit.key.clear();
        edit.label = "description only".into();
        assert!(!save(&store, &vault, edit).unwrap().complete);
        assert_eq!(read(&store).unwrap()[0].secret_ref, reference);
        assert!(api_configuration_with(&store, Some(&saved.id), None, &vault).is_err());

        // Completing a service is a source change, not a legacy-only edit.
        let repair = input(Some(saved.id.clone()), "verified-service-key");
        assert!(save(&store, &vault, repair.clone()).is_err());
        revoke_agent(&store, "a").unwrap();
        let repaired = save(&store, &vault, repair).unwrap();
        assert!(repaired.complete);
        assert!(repaired.grants.is_empty());
        assert_eq!(repaired.id, before.id);
    }

    #[test]
    fn storage_failure_after_key_write_keeps_saved_service_and_previous_key() {
        let (dir, store) = store();
        let vault = Fake::default();
        let saved = save(&store, &vault, input(None, "first")).unwrap();
        let before = store.get_setting(SETTING).unwrap();
        let connection = rusqlite::Connection::open(dir.path().join("store.sqlite3")).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_settings BEFORE UPDATE ON settings BEGIN SELECT RAISE(FAIL, 'controlled storage failure'); END;").unwrap();
        assert!(save(&store, &vault, input(Some(saved.id), "replacement")).is_err());
        assert_eq!(store.get_setting(SETTING).unwrap(), before);
        assert_eq!(vault.keys.borrow().len(), 1);
        assert!(vault.keys.borrow().values().any(|value| value == "first"));
    }

    #[test]
    fn complete_request_urls_and_credential_bearing_urls_are_rejected() {
        for url in [
            "https://example.test/v1/chat/completions",
            "https://example.test/v1/messages/",
            "https://user:secret@example.test/v1",
            "https://example.test/v1?api_key=secret",
            "http://example.test/v1",
        ] {
            assert!(validate_endpoint(url).is_err());
        }
        assert_eq!(
            validate_endpoint("https://example.test/v1/").unwrap(),
            "https://example.test/v1"
        );
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

pub fn environment_for_launch(
    store: &MetaStore,
    row: &crate::meta_store::AgentRow,
) -> Result<HashMap<String, String>, String> {
    let _lock = MUTATION.lock().map_err(|_| "密钥设置暂时不可用")?;
    auth::environment_for(store, row)
}
pub fn revoke_agent(store: &MetaStore, id: &str) -> Result<(), String> {
    let _lock = MUTATION.lock().map_err(|_| "密钥设置暂时不可用")?;
    let mut pool = read(store)?;
    for c in &mut pool {
        c.grants.retain(|g| g.agent_id != id);
    }
    write(store, &pool)
}
