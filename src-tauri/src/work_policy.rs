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
#[serde(deny_unknown_fields)]
struct Policy {
    version: u8,
    defaults: BTreeMap<String, bool>,
    projects: BTreeMap<String, BTreeMap<String, bool>>,
    #[serde(default)]
    locations: BTreeMap<String, bool>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSnapshot {
    pub cwd: String,
    pub enabled: BTreeMap<String, bool>,
    pub location_enabled: Option<bool>,
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
        if !value.is_object() {
            return Err("无法读取工作设置".into());
        }
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
    if let Some(enabled) = policy.locations.get(cwd.to_string_lossy().as_ref()) {
        return *enabled;
    }
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
        location_enabled: policy
            .locations
            .get(cwd.to_string_lossy().as_ref())
            .copied(),
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
fn set(
    store: &MetaStore,
    agent: Option<&str>,
    cwd: &Path,
    enabled: bool,
) -> Result<WorkSnapshot, String> {
    let gate = gate(cwd)?;
    let _admission = gate.blocking_lock();
    {
        let _guard = POLICY_LOCK.lock().map_err(|_| "工作设置暂时不可用")?;
        let mut policy = load(store)?;
        if let Some(agent) = agent {
            policy
                .projects
                .entry(cwd.to_string_lossy().into_owned())
                .or_default()
                .insert(agent.into(), enabled);
        } else {
            policy
                .locations
                .insert(cwd.to_string_lossy().into_owned(), enabled);
        }
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
    agent_id: Option<String>,
    cwd: String,
    enabled: bool,
) -> Result<WorkSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = set(
            &app.state::<MetaStore>(),
            agent_id.as_deref(),
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
                set(&store, Some("a"), &canonical, false).unwrap();
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
        set(&store, Some("a"), &a, true).unwrap();
        assert_eq!(admit(&store, "a", &a, || Ok(1)), Ok(1));
        assert!(admit(&store, "a", &b, || Ok(1)).is_err());
        assert_eq!(admit(&store, "other", &b, || Ok(1)), Ok(1));
        store
            .set_setting("agent.a.work", &serde_json::json!(true))
            .unwrap();
        assert!(admit(&store, "a", &b, || Ok(1)).is_err());
    }

    #[test]
    fn explicit_location_policy_covers_old_overrides_and_future_agents_without_changing_other_locations()
     {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        store.set_setting(KEY, &serde_json::json!({ "version": 1, "defaults": { "legacy": false }, "projects": { a.to_string_lossy().to_string(): { "legacy": true, "other": false } } })).unwrap();
        assert_eq!(snapshot(&store, &a).unwrap().location_enabled, None);
        assert_eq!(admit(&store, "legacy", &a, || Ok(1)), Ok(1));
        assert!(admit(&store, "other", &a, || Ok(1)).is_err());
        assert_eq!(admit(&store, "future", &a, || Ok(1)), Ok(1));
        let paused = set(&store, None, &a, false).unwrap();
        assert_eq!(paused.location_enabled, Some(false));
        for agent in ["legacy", "other", "future"] {
            assert!(admit(&store, agent, &a, || Ok(1)).is_err());
        }
        assert_eq!(admit(&store, "future", &b, || Ok(1)), Ok(1));
        assert!(admit(&store, "legacy", &b, || Ok(1)).is_err());
        // Old per-Agent callers cannot silently override the location decision.
        set(&store, Some("future"), &a, true).unwrap();
        assert!(admit(&store, "future", &a, || Ok(1)).is_err());
        let restored = set(&store, None, &a, true).unwrap();
        assert_eq!(restored.location_enabled, Some(true));
        assert_eq!(restored.enabled.get("other"), Some(&false));
        for agent in ["legacy", "other", "future"] {
            assert_eq!(admit(&store, agent, &a, || Ok(1)), Ok(1));
        }
        let reopened = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        assert_eq!(
            snapshot(&reopened, &a).unwrap().location_enabled,
            Some(true)
        );
    }

    fn policy_with_unrecognized_root_field() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "defaults": {},
            "projects": {},
            "locations": {},
            "futurePolicy": {"allow": false, "revision": 2}
        })
    }

    #[test]
    fn unknown_root_policy_snapshot_rejects_without_rewriting_settings() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        store
            .set_setting(KEY, &policy_with_unrecognized_root_field())
            .unwrap();
        store
            .set_setting("unrelated", &serde_json::json!({"keep": true}))
            .unwrap();
        let before = store.list_settings().unwrap();

        let result = snapshot(&store, &dir.path().join("project"));

        assert_eq!(result.map(|_| ()), Err("无法读取工作设置".into()));
        assert_eq!(store.list_settings().unwrap(), before);
    }

    #[test]
    fn unknown_root_policy_admission_rejects_before_running_callback() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        store
            .set_setting(KEY, &policy_with_unrecognized_root_field())
            .unwrap();
        let before = store.list_settings().unwrap();
        let called = std::cell::Cell::new(false);

        let result = admit(&store, "a", &dir.path().join("project"), || {
            called.set(true);
            Ok(())
        });

        assert!(!called.get(), "unknown policy must not admit the operation");
        assert_eq!(result, Err("无法读取工作设置".into()));
        assert_eq!(store.list_settings().unwrap(), before);
    }

    #[test]
    fn unknown_root_policy_set_rejects_both_scopes_without_losing_original_fields() {
        for agent in [Some("a"), None] {
            let dir = tempfile::tempdir().unwrap();
            let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
            store
                .set_setting(KEY, &policy_with_unrecognized_root_field())
                .unwrap();
            store
                .set_setting("unrelated", &serde_json::json!({"keep": true}))
                .unwrap();
            let before = store.list_settings().unwrap();

            let result = set(&store, agent, &dir.path().join("project"), false);

            assert_eq!(store.list_settings().unwrap(), before, "scope {agent:?}");
            assert_eq!(result.map(|_| ()), Err("无法读取工作设置".into()));
        }
    }

    #[test]
    fn version_one_without_locations_remains_readable_and_can_be_explicitly_updated() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        let project = dir.path().join("project");
        let other = dir.path().join("other");
        let original = serde_json::json!({
            "version": 1,
            "defaults": {"a": false},
            "projects": {project.to_string_lossy().to_string(): {"a": true}}
        });
        store.set_setting(KEY, &original).unwrap();

        let snapshot = snapshot(&store, &project).unwrap();
        assert_eq!(snapshot.location_enabled, None);
        assert_eq!(snapshot.enabled.get("a"), Some(&true));
        assert_eq!(admit(&store, "a", &project, || Ok(7)), Ok(7));
        assert_eq!(
            admit(&store, "a", &other, || Ok(7)),
            Err("WORK_DISABLED".into())
        );
        assert_eq!(store.get_setting(KEY).unwrap(), Some(original.clone()));

        assert_eq!(
            set(&store, None, &project, false).unwrap().location_enabled,
            Some(false)
        );
        let saved = store.get_setting(KEY).unwrap().unwrap();
        assert_eq!(saved["version"], original["version"]);
        assert_eq!(saved["defaults"], original["defaults"]);
        assert_eq!(saved["projects"], original["projects"]);
        assert_eq!(
            saved["locations"][project.to_string_lossy().as_ref()],
            serde_json::json!(false)
        );
        assert_eq!(
            admit(&store, "a", &project, || Ok(7)),
            Err("WORK_DISABLED".into())
        );
        assert_eq!(
            set(&store, None, &project, true).unwrap().location_enabled,
            Some(true)
        );
        assert_eq!(admit(&store, "a", &project, || Ok(7)), Ok(7));
    }

    fn assert_array_root_policy_rejected(original: serde_json::Value) {
        for agent in [Some("a"), None] {
            let dir = tempfile::tempdir().unwrap();
            let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
            store.set_setting(KEY, &original).unwrap();
            store
                .set_setting("unrelated", &serde_json::json!("keep"))
                .unwrap();
            let before = store.list_settings().unwrap();
            let cwd = dir.path().join("project");
            let called = std::cell::Cell::new(false);

            let read_error = snapshot(&store, &cwd).err();
            let admission_error = admit(&store, "a", &cwd, || {
                called.set(true);
                Ok(())
            })
            .err();
            let write_error = set(&store, agent, &cwd, false).err();
            let unchanged = store.list_settings().unwrap() == before;
            // Evaluate all three entry points before asserting, so the old
            // acceptance, callback and lossy rewrite appear in the red result.
            assert_eq!(
                serde_json::json!({
                    "snapshotError": read_error,
                    "admissionError": admission_error,
                    "callbackCalled": called.get(),
                    "setError": write_error,
                    "settingsUnchanged": unchanged,
                }),
                serde_json::json!({
                    "snapshotError": "无法读取工作设置",
                    "admissionError": "无法读取工作设置",
                    "callbackCalled": false,
                    "setError": "无法读取工作设置",
                    "settingsUnchanged": true,
                }),
                "scope {agent:?}"
            );
        }
    }

    #[test]
    fn three_element_array_policy_is_not_a_legacy_object() {
        assert_array_root_policy_rejected(serde_json::json!([1, {}, {}]));
    }

    #[test]
    fn four_element_array_policy_is_not_a_version_one_object() {
        assert_array_root_policy_rejected(serde_json::json!([1, {}, {}, {}]));
    }
}
