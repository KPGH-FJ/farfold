//! Farfold-owned project work admission. No Agent execution policy is replaced.
use crate::acp_client::manager::validate_cwd;
use crate::meta_store::MetaStore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
const KEY: &str = "agentWorkPolicy.v1";
static POLICY_LOCK: Mutex<()> = Mutex::new(());
type Gates = BTreeMap<String, Arc<tokio::sync::Mutex<()>>>;
static GATES: OnceLock<Mutex<Gates>> = OnceLock::new();
#[derive(Default, Serialize, Deserialize)]
struct Policy {
    version: u8,
    defaults: BTreeMap<String, bool>,
    projects: BTreeMap<String, BTreeMap<String, bool>>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSnapshot {
    pub cwd: String,
    pub enabled: BTreeMap<String, bool>,
}
fn gate(cwd: &Path) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    Ok(GATES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "工作设置暂时不可用")?
        .entry(cwd.to_string_lossy().into_owned())
        .or_default()
        .clone())
}
fn load(store: &MetaStore) -> Result<Policy, String> {
    if let Some(value) = store.get_setting(KEY)? {
        let policy: Policy = serde_json::from_value(value).map_err(|_| "无法读取工作设置")?;
        if policy.version != 1 {
            return Err("无法读取工作设置版本".into());
        }
        return Ok(policy);
    }
    let mut policy = Policy {
        version: 1,
        ..Policy::default()
    };
    for (key, value) in store.list_settings()? {
        if let Some(id) = key
            .strip_prefix("agent.")
            .and_then(|k| k.strip_suffix(".work"))
            && let Some(enabled) = value.as_bool()
        {
            policy.defaults.insert(id.into(), enabled);
        }
    }
    store.set_setting(
        KEY,
        &serde_json::to_value(&policy).map_err(|_| "无法保存工作设置")?,
    )?;
    Ok(policy)
}
fn effective(policy: &Policy, agent: &str, cwd: &Path) -> bool {
    policy
        .projects
        .get(cwd.to_string_lossy().as_ref())
        .and_then(|p| p.get(agent))
        .or_else(|| policy.defaults.get(agent))
        .copied()
        .unwrap_or(true)
}
fn snapshot(store: &MetaStore, cwd: &Path) -> Result<WorkSnapshot, String> {
    let _guard = POLICY_LOCK.lock().map_err(|_| "工作设置暂时不可用")?;
    let policy = load(store)?;
    let mut enabled = policy.defaults.clone();
    if let Some(project) = policy.projects.get(cwd.to_string_lossy().as_ref()) {
        enabled.extend(project.clone());
    }
    Ok(WorkSnapshot {
        cwd: cwd.to_string_lossy().into_owned(),
        enabled,
    })
}
pub(crate) async fn admit<T, Fut: std::future::Future<Output = Result<T, String>>>(
    store: &MetaStore,
    agent: &str,
    cwd: &Path,
    run: impl FnOnce() -> Fut,
) -> Result<T, String> {
    let gate = gate(cwd)?;
    let _admission = gate.lock().await;
    let agent = agent.to_string();
    let cwd = cwd.to_path_buf();
    store
        .run(move |store| {
            let _guard = POLICY_LOCK.lock().map_err(|_| "工作设置暂时不可用")?;
            if !effective(&load(store)?, &agent, &cwd) {
                return Err("WORK_DISABLED".into());
            }
            Ok(())
        })
        .await?;
    run().await
}
fn set(store: &MetaStore, agent: &str, cwd: &Path, enabled: bool) -> Result<WorkSnapshot, String> {
    let gate = gate(cwd)?;
    let _admission = gate.blocking_lock();
    {
        let _guard = POLICY_LOCK.lock().map_err(|_| "工作设置暂时不可用")?;
        let mut policy = load(store)?;
        policy
            .projects
            .entry(cwd.to_string_lossy().into_owned())
            .or_default()
            .insert(agent.into(), enabled);
        store.set_setting(
            KEY,
            &serde_json::to_value(policy).map_err(|_| "无法保存工作设置")?,
        )?;
    }
    snapshot(store, cwd)
}
#[tauri::command]
pub async fn agent_work_get(app: AppHandle, cwd: String) -> Result<WorkSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        snapshot(&app.state::<MetaStore>(), &validate_cwd(&cwd)?)
    })
    .await
    .map_err(|_| "无法读取工作设置")?
}
#[tauri::command]
pub async fn agent_work_set(
    app: AppHandle,
    agent_id: String,
    cwd: String,
    enabled: bool,
) -> Result<WorkSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = set(
            &app.state::<MetaStore>(),
            &agent_id,
            &validate_cwd(&cwd)?,
            enabled,
        )?;
        let _ = app.emit("agent-work-changed", &state);
        Ok(state)
    })
    .await
    .map_err(|_| "无法保存工作设置")?
}
#[cfg(test)]
mod tests {
    use super::*;
    fn admit<T>(
        store: &MetaStore,
        agent: &str,
        cwd: &Path,
        run: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        crate::acp_client::manager::runtime()
            .block_on(super::admit(store, agent, cwd, || async { run() }))
    }
    #[test]
    fn aliases_share_policy_and_updates_wait_for_admission() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&project, &alias).unwrap();
        let canonical = validate_cwd(project.to_str().unwrap()).unwrap();
        assert_eq!(canonical, validate_cwd(alias.to_str().unwrap()).unwrap());
        let store = Arc::new(MetaStore::open(&dir.path().join("meta.db")).unwrap());
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let store_ref = &store;
            let cwd_ref = &canonical;
            scope.spawn(move || {
                admit(store_ref, "a", cwd_ref, || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .unwrap()
            });
            started_rx.recv().unwrap();
            scope.spawn(|| {
                set(&store, "a", &canonical, false).unwrap();
                done_tx.send(()).unwrap();
            });
            assert!(
                done_rx
                    .recv_timeout(std::time::Duration::from_millis(50))
                    .is_err()
            );
            release_tx.send(()).unwrap();
            done_rx
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
        });
        assert!(admit(&store, "a", &canonical, || Ok(())).is_err());
    }

    #[test]
    fn legacy_defaults_and_project_overrides_enforce_admission() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        store
            .set_setting("agent.a.work", &serde_json::json!(false))
            .unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        assert_eq!(
            admit(&store, "a", &a, || Ok(1)),
            Err("WORK_DISABLED".into())
        );
        set(&store, "a", &a, true).unwrap();
        assert_eq!(admit(&store, "a", &a, || Ok(1)), Ok(1));
        assert!(admit(&store, "a", &b, || Ok(1)).is_err());
        assert_eq!(admit(&store, "other", &b, || Ok(1)), Ok(1));
        store
            .set_setting("agent.a.work", &serde_json::json!(true))
            .unwrap();
        assert!(admit(&store, "a", &b, || Ok(1)).is_err());
    }
}
