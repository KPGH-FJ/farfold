//! Actual subprocess cwd regressions, not real-Agent or installed-product acceptance.
use super::super::{
    manager::{AcpManager, validate_cwd},
    pump::SessionSink,
    session_index::touch_session_row,
};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

const PEER: &str = r#"
import json, os, sys
from pathlib import Path
observed, expected, literal, parent_home, variant = sys.argv[1:6]
cwd = Path.cwd().resolve()
snapshot = json.dumps({
 'cwd':str(cwd), 'pid':os.getpid(), 'literal':literal,
 'publicEnv':os.environ.get('FIXTURE_CWD_PUBLIC'),
 'homeUnchanged':os.environ.get('HOME')==parent_home,
})
Path(observed).write_text(snapshot)
Path(observed+'.'+str(os.getpid())+'.json').write_text(snapshot)
allowed = (Path(expected).resolve(), Path(expected).resolve().parent/'second directory with spaces')
if cwd in allowed: Path('relative-marker').write_text('controlled-only')
calls = Path(observed+'_calls')
calls.write_text('')
def reply(m,r): print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)
def options():
 values = json.loads(Path(variant).read_text()) if Path(variant).is_file() else {'model':'m1','reasoning':'high'}
 return [
  {'id':'model','name':'Model','category':'model','type':'select','currentValue':values['model'],'options':[{'value':'m1','name':'M1'},{'value':'m2','name':'M2'}]},
  {'id':'reasoning','name':'Reasoning','category':'thought_level','type':'select','currentValue':values['reasoning'],'options':[{'value':'high','name':'High'},{'value':'low','name':'Low'}]},
 ]
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 record={'method':method}
 if method in ('session/new','session/load'): record.update(cwd=p.get('cwd'),nativeSessionId=p.get('sessionId'),spawnCwd=str(cwd))
 with calls.open('a') as f: f.write(json.dumps(record)+'\n')
 if method=='initialize': reply(m,{'protocolVersion':1,'agentInfo':{'name':'controlled-cwd','version':'1'},'agentCapabilities':{'loadSession':True},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':'cwd-native-session','configOptions':options()})
 elif method=='session/load': reply(m,{'configOptions':options()})
 elif method=='session/prompt': reply(m,{'stopReason':'end_turn'})
 elif method=='session/close': reply(m,{})
"#;

struct Fixture {
    root: tempfile::TempDir,
    data_dir: PathBuf,
    cwd: PathBuf,
    observed: PathBuf,
    variant: PathBuf,
    store: MetaStore,
    manager: Arc<AcpManager>,
    row: AgentRow,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let data_dir = base.join("app data directory");
        let cwd = base.join("selected directory with spaces");
        std::fs::create_dir(&data_dir).unwrap();
        std::fs::create_dir(&cwd).unwrap();
        let script = base.join("controlled.py");
        let observed = base.join("observed.json");
        let variant = base.join("response-variant.json");
        std::fs::write(&script, PEER).unwrap();
        let store = MetaStore::open(&base.join("meta.db")).unwrap();
        let row = AgentRow {
            id: "process-cwd-fixture".into(),
            name: "Controlled cwd".into(),
            source: "custom".into(),
            command: "/usr/bin/python3".into(),
            args: vec![
                "-u".into(),
                script.to_string_lossy().into(),
                observed.to_string_lossy().into(),
                cwd.to_string_lossy().into(),
                "$literal argument with spaces; untouched".into(),
                std::env::var("HOME").unwrap(),
                variant.to_string_lossy().into(),
            ],
            env: vec![(
                "FIXTURE_CWD_PUBLIC".into(),
                "$public literal with spaces".into(),
            )],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let manager = Arc::new(AcpManager::new(base.join("logs"), data_dir.clone()));
        Self {
            root,
            data_dir,
            cwd,
            observed,
            variant,
            store,
            manager,
            row,
        }
    }

    fn observation(&self) -> Value {
        serde_json::from_slice(&std::fs::read(&self.observed).unwrap()).unwrap()
    }

    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(format!("{}_calls", self.observed.display()))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn saved_config(&self, native: &str) -> Option<Value> {
        self.store
            .get_session(&super::super::session_index::session_row_id(
                &self.row.id,
                &self.cwd.to_string_lossy(),
                native,
            ))
            .unwrap()
            .unwrap()
            .config_options
    }

    async fn close(&self, cwd: &std::path::Path, pid: u32) {
        self.manager.disconnect(&self.row.id, cwd).await.unwrap();
        assert_ne!(
            unsafe { libc::kill(pid as i32, 0) },
            0,
            "exact fixture child must be reaped"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn selected_directory_with_spaces_keeps_literal_arguments_environment_and_home() {
    let f = Fixture::new();
    let parent_cwd = std::env::current_dir().unwrap();
    let status = f.manager.connect(&f.row, &f.cwd, &f.store).await.unwrap();
    let observed = f.observation();
    f.close(&f.cwd, observed["pid"].as_u64().unwrap() as u32)
        .await;
    assert_eq!(status.state, "ready");
    assert_eq!(observed["cwd"], f.cwd.to_string_lossy().as_ref());
    assert_eq!(
        observed["literal"],
        "$literal argument with spaces; untouched"
    );
    assert_eq!(observed["publicEnv"], "$public literal with spaces");
    assert_eq!(observed["homeUnchanged"], true);
    assert!(f.cwd.join("relative-marker").is_file());
    assert_eq!(std::env::current_dir().unwrap(), parent_cwd);
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_connections_have_independent_actual_directories() {
    let f = Fixture::new();
    let parent_cwd = std::env::current_dir().unwrap();
    let elsewhere = f
        .root
        .path()
        .canonicalize()
        .unwrap()
        .join("second directory with spaces");
    std::fs::create_dir(&elsewhere).unwrap();
    let (first, second) = tokio::join!(
        f.manager.connect(&f.row, &f.cwd, &f.store),
        f.manager.connect(&f.row, &elsewhere, &f.store),
    );
    assert_eq!(first.unwrap().state, "ready");
    assert_eq!(second.unwrap().state, "ready");
    let observation = |cwd: &std::path::Path| {
        let pid = f
            .manager
            .live_connection(&f.row.id, cwd)
            .unwrap()
            .child_pid
            .load(std::sync::atomic::Ordering::SeqCst);
        serde_json::from_slice::<Value>(
            &std::fs::read(format!("{}.{pid}.json", f.observed.display())).unwrap(),
        )
        .unwrap()
    };
    let a = observation(&f.cwd);
    let b = observation(&elsewhere);
    f.close(&f.cwd, a["pid"].as_u64().unwrap() as u32).await;
    f.close(&elsewhere, b["pid"].as_u64().unwrap() as u32).await;
    assert_ne!(a["pid"], b["pid"]);
    assert_eq!(a["cwd"], f.cwd.to_string_lossy().as_ref());
    assert_eq!(b["cwd"], elsewhere.to_string_lossy().as_ref());
    assert!(f.cwd.join("relative-marker").is_file());
    assert!(elsewhere.join("relative-marker").is_file());
    assert_eq!(std::env::current_dir().unwrap(), parent_cwd);
}

#[tokio::test(flavor = "multi_thread")]
async fn candidate_check_uses_app_data_and_keeps_selected_row_and_handshake() {
    let f = Fixture::new();
    let before = serde_json::to_value(f.store.get_agent(&f.row.id).unwrap()).unwrap();
    let mut candidate = f.row.clone();
    candidate.args[3] = f.data_dir.to_string_lossy().into();
    f.manager
        .probe_launch(&candidate, &f.store, std::future::pending())
        .await
        .unwrap();
    let observed = f.observation();
    assert_ne!(
        unsafe { libc::kill(observed["pid"].as_u64().unwrap() as i32, 0) },
        0
    );
    assert_eq!(observed["cwd"], f.data_dir.to_string_lossy().as_ref());
    assert!(f.data_dir.join("relative-marker").is_file());
    assert!(!f.cwd.join("relative-marker").exists());
    assert!(!f.manager.candidate_pending(&f.row.id).unwrap());
    assert_eq!(
        serde_json::to_value(f.store.get_agent(&f.row.id).unwrap()).unwrap(),
        before
    );
    assert_eq!(
        f.calls()
            .iter()
            .map(|c| c["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["initialize"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn directory_removed_after_validation_does_not_spawn_or_fallback_and_can_retry() {
    let f = Fixture::new();
    let cwd = validate_cwd(f.cwd.to_str().unwrap()).unwrap();
    std::fs::remove_dir(&cwd).unwrap();
    let result = f.manager.connect(&f.row, &cwd, &f.store).await;
    if result.is_ok() {
        let observed = f.observation();
        f.close(&cwd, observed["pid"].as_u64().unwrap() as u32)
            .await;
    }
    assert!(
        result.is_err(),
        "spawn must reject the vanished selected directory"
    );
    assert!(
        !f.observed.exists(),
        "fixture must never start in a fallback directory"
    );
    std::fs::create_dir(&cwd).unwrap();
    assert_eq!(
        f.manager
            .connect(&f.row, &cwd, &f.store)
            .await
            .unwrap()
            .state,
        "ready"
    );
    let observed = f.observation();
    f.close(&cwd, observed["pid"].as_u64().unwrap() as u32)
        .await;
    assert_eq!(observed["cwd"], cwd.to_string_lossy().as_ref());
}

async fn cold_restore(drift: bool) {
    let mut f = Fixture::new();
    let sink: SessionSink = Arc::new(|_| {});
    let opened = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], sink.clone(), &f.store)
        .await
        .unwrap();
    let native = opened.session_id;
    let recorded = json!({"_farfoldConfig":1,
        "model":{"id":"model","category":"model","value":"m1"},
        "thoughtLevel":{"id":"reasoning","category":"thought_level","value":"high"}});
    touch_session_row(
        &f.store,
        &f.row.id,
        &f.cwd.to_string_lossy(),
        &native,
        Some("Preserved"),
        Some(recorded.clone()),
    )
    .unwrap();
    let original_pid = f.observation()["pid"].as_u64().unwrap() as u32;
    f.close(&f.cwd, original_pid).await;
    f.manager.stop_for_shutdown();
    f.manager = Arc::new(AcpManager::new(
        f.root.path().join("cold-logs"),
        f.data_dir.clone(),
    ));
    if drift {
        std::fs::write(&f.variant, r#"{"model":"m2","reasoning":"low"}"#).unwrap();
    }
    let resumed = f
        .manager
        .open_session(&f.row, &f.cwd, Some(native.clone()), vec![], sink, &f.store)
        .await
        .unwrap();
    let observed = f.observation();
    let calls = f.calls();
    assert_eq!(resumed.session_id, native);
    assert_eq!(observed["cwd"], f.cwd.to_string_lossy().as_ref());
    assert_eq!(
        calls
            .iter()
            .map(|c| c["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["initialize", "session/load"]
    );
    assert_eq!(calls[1]["nativeSessionId"], native);
    assert_eq!(calls[1]["cwd"], f.cwd.to_string_lossy().as_ref());
    assert_eq!(calls[1]["spawnCwd"], calls[1]["cwd"]);
    assert_eq!(f.saved_config(&native), Some(recorded));
    if drift {
        assert_eq!(resumed.config_check.status, "blocked");
        assert_eq!(resumed.config_check.issues.len(), 2);
        assert!(
            f.manager
                .session_prompt(
                    &f.row.id,
                    &f.cwd,
                    &native,
                    serde_json::from_value(json!([{"type":"text","text":"controlled-only"}]))
                        .unwrap()
                )
                .await
                .is_err()
        );
        assert!(!f.calls().iter().any(|c| c["method"] == "session/prompt"));
    } else {
        assert_eq!(resumed.config_check.status, "ready");
        assert!(resumed.config_check.issues.is_empty());
    }
    f.close(&f.cwd, observed["pid"].as_u64().unwrap() as u32)
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cold_restore_keeps_original_actual_cwd_native_session_and_recorded_choices() {
    cold_restore(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cold_restore_model_and_reasoning_drift_still_blocks_sending() {
    cold_restore(true).await;
}
