//! Actual subprocess transport + SQLite regression; not real-Agent acceptance.
use super::{manager::AcpManager, pump::SessionSink, session_index::touch_session_row};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::sync::{Arc, mpsc};
use std::time::Duration;
const PEER: &str = r#"
import sys,json
options=[{'id':'model','name':'Model','category':'model','type':'select','currentValue':'m','options':[{'value':'m','name':'M'}]}, {'id':'reasoning_effort','name':'Reasoning','category':'thought_level','type':'select','currentValue':'high','options':[{'value':'low','name':'Low'},{'value':'high','name':'High'}]}]
def send(x): print(json.dumps(dict(jsonrpc='2.0',**x)),flush=True)
for line in sys.stdin:
 m=json.loads(line); p=m.get('params',{}); method=m.get('method'); result={}
 if method=='initialize': result={'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]}
 elif method in ('session/new','session/load'): result=dict(configOptions=options,**({'sessionId':'proof'} if method=='session/new' else {}))
 elif method=='session/set_config_option':
  for o in options:
   if o['id']==p['configId']: o['currentValue']=p['value']
  result={'configOptions':options}
 elif method=='session/prompt': result={'stopReason':'end_turn'}
 elif method=='session/cancel': continue
 if 'id' in m: send({'id':m['id'],'result':result})
"#;
struct Stop(Arc<AcpManager>);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.stop_for_shutdown();
    }
}
fn next(rx: &mpsc::Receiver<Value>, kind: &str) -> Value {
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if event["kind"] == kind {
            return event;
        }
    }
}
fn stored_choice(store: &MetaStore, row_id: &str, option_id: &str) -> Value {
    let config = store
        .get_session(row_id)
        .unwrap()
        .unwrap()
        .config_options
        .unwrap();
    assert_eq!(config["_farfoldConfig"], 2);
    config["choices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|choice| choice["id"] == option_id)
        .unwrap()["value"]
        .clone()
}
fn wait_for_open_cleanup(manager: &AcpManager, agent_id: &str, cwd: &std::path::Path) {
    // The reply wakes this test before the operation drops its reservation.
    // Wait for that exact ownership boundary before opening the same session.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        match manager.opening_sessions.reserve(agent_id, cwd, "proof") {
            Ok(reservation) => {
                drop(reservation);
                return;
            }
            Err(error) => {
                assert!(std::time::Instant::now() < deadline, "{error}");
                std::thread::yield_now();
            }
        }
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn persisted_effort_blocks_real_dispatch_and_legacy_confirmation_is_explicit() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("peer.py"), PEER).unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let db = cwd.join("meta.db");
    let store = MetaStore::open(&db).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let _stop = Stop(manager.clone());
    let row = AgentRow {
        id: "guard".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: "/usr/bin/python3".into(),
        args: vec!["-u".into(), cwd.join("peer.py").to_string_lossy().into()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    let (tx, rx) = mpsc::channel();
    let sink: SessionSink = Arc::new(move |v| {
        let _ = tx.send(v);
    });
    let first = manager
        .open_session(&row, &cwd, None, vec![], sink.clone(), &store)
        .await
        .unwrap();
    assert_eq!(first.config_check.status, "ready");
    manager
        .session_set_config(&row.id, &cwd, "proof", "reasoning_effort", json!("low"))
        .await
        .unwrap();
    assert_eq!(next(&rx, "configCheck")["check"]["status"], "ready");
    let blocks = || serde_json::from_value(json!([{"type":"text","text":"proof"}])).unwrap();
    // Source/configuration storage must succeed before the first prompt is admitted.
    let sql = rusqlite::Connection::open(&db).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_first BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'test'); END;").unwrap();
    assert!(
        manager
            .session_prompt(&row.id, &cwd, "proof", blocks())
            .await
            .unwrap_err()
            .contains("CONFIG_RECORD_FAILED")
    );
    let failed = next(&rx, "configCheck");
    assert_eq!(failed["check"]["status"], "record_failed");
    sql.execute_batch("DROP TRIGGER fail_first;").unwrap();
    assert_eq!(
        manager
            .confirm_config(&row.id, &cwd, "proof", failed["check"]["current"].clone())
            .await
            .unwrap()["status"],
        "ready"
    );
    manager
        .session_prompt(&row.id, &cwd, "proof", blocks())
        .await
        .unwrap();
    next(&rx, "turnEnd");
    let id = super::session_index::session_row_id(&row.id, &cwd.to_string_lossy(), "proof");
    assert_eq!(stored_choice(&store, &id, "reasoning_effort"), "low");
    assert!(
        manager
            .session_set_config(&row.id, &cwd, "proof", "reasoning_effort", json!("high"))
            .await
            .is_err()
    );
    assert_eq!(stored_choice(&store, &id, "reasoning_effort"), "low");
    manager.disconnect(&row.id, &cwd).await.unwrap();
    assert_eq!(
        manager
            .open_session(
                &row,
                &cwd,
                Some("proof".into()),
                vec![("reasoning_effort".into(), json!("low"))],
                sink.clone(),
                &store
            )
            .await
            .err()
            .expect("restoring with reasoning overrides must fail"),
        "恢复会话不能修改模型或思考深度"
    );
    wait_for_open_cleanup(&manager, &row.id, &cwd);
    let restored = manager
        .open_session(
            &row,
            &cwd,
            Some("proof".into()),
            vec![],
            sink.clone(),
            &store,
        )
        .await
        .unwrap();
    assert_eq!(restored.config_check.status, "blocked");
    assert!(
        manager
            .session_prompt(&row.id, &cwd, "proof", blocks())
            .await
            .unwrap_err()
            .contains("CONFIG_BLOCKED")
    );
    assert!(
        manager
            .confirm_config(&row.id, &cwd, "proof", restored.config_check.current)
            .await
            .is_err()
    );
    manager.disconnect(&row.id, &cwd).await.unwrap();
    touch_session_row(
        &store,
        &row.id,
        &cwd.to_string_lossy(),
        "proof",
        None,
        Some(json!({"model":"m"})),
    )
    .unwrap();
    let legacy = manager
        .open_session(
            &row,
            &cwd,
            Some("proof".into()),
            vec![],
            sink.clone(),
            &store,
        )
        .await
        .unwrap();
    assert_eq!(legacy.config_check.status, "confirmation_required");
    assert!(
        manager
            .session_prompt(&row.id, &cwd, "proof", blocks())
            .await
            .is_err()
    );
    assert!(
        manager
            .confirm_config(&row.id, &cwd, "proof", json!({}))
            .await
            .is_err()
    );
    let confirmed = manager
        .confirm_config(&row.id, &cwd, "proof", legacy.config_check.current)
        .await
        .unwrap();
    assert_eq!(confirmed["status"], "ready");
    manager
        .session_prompt(&row.id, &cwd, "proof", blocks())
        .await
        .unwrap();
    next(&rx, "turnEnd");
    // Real SQLite rejection: no next prompt is dispatched and the user can retry storage.
    let sql = rusqlite::Connection::open(&db).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_guard BEFORE UPDATE ON sessions BEGIN SELECT RAISE(FAIL, 'test'); END;").unwrap();
    assert!(
        manager
            .session_set_config(&row.id, &cwd, "proof", "reasoning_effort", json!("low"))
            .await
            .is_err()
    );
    assert!(
        manager
            .session_prompt(&row.id, &cwd, "proof", blocks())
            .await
            .unwrap_err()
            .contains("RECORD_FAILED")
    );
    sql.execute_batch("DROP TRIGGER fail_guard;").unwrap();
    let mut check = next(&rx, "configCheck");
    while check["check"]["status"] != "record_failed" {
        check = next(&rx, "configCheck");
    }
    assert_eq!(
        manager
            .confirm_config(&row.id, &cwd, "proof", check["check"]["current"].clone())
            .await
            .unwrap()["status"],
        "ready"
    );
    assert_eq!(stored_choice(&store, &id, "reasoning_effort"), "high");
}
