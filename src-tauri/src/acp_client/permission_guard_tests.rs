//! Deterministic subprocess/SQLite boundary coverage, not real-Agent acceptance.
use super::{
    manager::AcpManager,
    pump::{SessionControl, SessionSink},
};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{
    sync::{Arc, mpsc},
    time::Duration,
};
const PEER: &str = r#"
import sys,json,time,os
options=[{'id':'mode','name':'Mode','category':'mode','type':'select','currentValue':'agent','options':[{'value':v,'name':v,'description':'Exact choice description'} for v in ['read-only','agent','agent-full-access']]}]
def send(x): print(json.dumps(dict(jsonrpc='2.0',**x)),flush=True)
for line in sys.stdin:
 m=json.loads(line); p=m.get('params',{}); method=m.get('method'); result={}
 if method=='initialize': result={'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]}
 elif method in ('session/new','session/load'):
  os.chdir(p['cwd'])
  options[0]['currentValue']='agent'
  result=dict(configOptions=options,**({'sessionId':'permission-proof'} if method=='session/new' else {}))
 elif method=='session/set_config_option':
  if p['value']=='agent-full-access':
   send({'id':m['id'],'error':{'code':-32602,'message':'fixture rejection'}});continue
  if os.path.exists('delay'):
   os.unlink('delay');time.sleep(.15)
  options[0]['currentValue']=p['value'];result={'configOptions':options}
 elif method=='session/prompt': result={'stopReason':'end_turn'}
 if 'id' in m: send({'id':m['id'],'result':result})
"#;
struct Stop(Arc<AcpManager>);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.stop_for_shutdown();
    }
}
fn next(rx: &mpsc::Receiver<Value>, kind: &str, state: Option<&str>) -> Value {
    loop {
        let value = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if value["kind"] == kind && state.is_none_or(|s| value["permissionState"] == s) {
            return value;
        }
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn permissions_gate_cold_load_failed_timeout_late_and_explicit_retry() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    std::fs::write(cwd.join("peer.py"), PEER).unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let _stop = Stop(manager.clone());
    // The test fixture exercises the registered identity capability with the
    // recorded protocol shape; it does not launch any installed Agent.
    let row = AgentRow {
        id: "codex".into(),
        name: "Fixture".into(),
        source: "registry".into(),
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
    let opened = manager
        .open_session(&row, &cwd, None, vec![], sink.clone(), &store)
        .await
        .unwrap();
    assert_eq!(opened.permission_config_id.as_deref(), Some("mode"));
    assert_eq!(opened.permission_state, "ready");
    let blocks = || serde_json::from_value(json!([{"type":"text","text":"fixture"}])).unwrap();
    manager
        .session_prompt(&row.id, &cwd, &opened.session_id, blocks())
        .await
        .unwrap();
    next(&rx, "turnEnd", None);
    manager
        .close_session(&row.id, &cwd, &opened.session_id)
        .await
        .unwrap();
    let restored = manager
        .open_session(
            &row,
            &cwd,
            Some(opened.session_id.clone()),
            vec![],
            sink,
            &store,
        )
        .await
        .unwrap();
    assert_eq!(restored.permission_state, "required");
    let archive_id =
        super::session_index::session_row_id(&row.id, &cwd.to_string_lossy(), &opened.session_id);
    assert!(
        manager
            .archive_session(&store, archive_id.clone(), true)
            .await
            .is_err()
    );
    assert!(
        manager
            .session_prompt(&row.id, &cwd, &opened.session_id, blocks())
            .await
            .unwrap_err()
            .contains("重新确认权限")
    );
    assert!(
        manager
            .session_set_mode(&row.id, &cwd, &opened.session_id, "agent")
            .await
            .is_err()
    );
    assert!(
        manager
            .session_set_config(
                &row.id,
                &cwd,
                &opened.session_id,
                "mode",
                json!("agent-full-access")
            )
            .await
            .is_err()
    );
    assert!(
        manager
            .session_prompt(&row.id, &cwd, &opened.session_id, blocks())
            .await
            .is_err()
    );
    while rx.try_recv().is_ok() {}
    std::fs::write(cwd.join("delay"), "").unwrap();
    let connection = manager
        .session_connection(&row.id, &cwd, &opened.session_id)
        .unwrap();
    let control = connection
        .sessions
        .lock()
        .unwrap()
        .get(&opened.session_id)
        .unwrap()
        .control
        .clone();
    let (result, receive) = tokio::sync::oneshot::channel();
    control
        .send(SessionControl::SetConfig {
            config_id: "mode".into(),
            value: json!("read-only"),
            deadline: tokio::time::Instant::now() + Duration::from_millis(30),
            result,
        })
        .unwrap();
    assert!(receive.await.unwrap().unwrap_err().contains("尚未确认"));
    next(&rx, "permissionState", Some("unknown")); // timeout
    next(&rx, "permissionState", Some("unknown")); // late success remains unknown
    assert!(
        manager
            .archive_session(&store, archive_id, true)
            .await
            .is_err()
    );
    assert!(
        manager
            .session_prompt(&row.id, &cwd, &opened.session_id, blocks())
            .await
            .is_err()
    );
    let options = manager
        .session_set_config(
            &row.id,
            &cwd,
            &opened.session_id,
            "mode",
            json!("read-only"),
        )
        .await
        .unwrap();
    assert_eq!(options[0]["currentValue"], "read-only");
    manager
        .session_prompt(&row.id, &cwd, &opened.session_id, blocks())
        .await
        .unwrap();
    next(&rx, "turnEnd", None);
}
