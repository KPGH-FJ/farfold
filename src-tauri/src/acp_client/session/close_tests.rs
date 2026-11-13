use super::*;
use crate::acp_client::lifecycle::{CLOSING, CONNECTING, ConnectionLife};
use serde_json::json;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock, atomic::AtomicU32},
};

fn register(manager: &AcpManager, key: ConnectionKey, state: u8) -> ManagedConnection {
    let life = ConnectionLife::new();
    life.state.store(state, Ordering::SeqCst);
    let (command_tx, _receive) = mpsc::unbounded_channel();
    let connection = ManagedConnection {
        launch_identity: None,
        connection_id: "fixture-connection".into(),
        account: Default::default(),
        account_query: None,
        workspace_access: crate::acp_client::workspace_access::Availability::new(None),
        identity_read: crate::acp_client::identity_read::Availability::new(None),
        session_tools: crate::acp_client::session_tools::Availability::unavailable(),
        command_tx,
        state: life.state.clone(),
        handshake: Arc::new(OnceLock::new()),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        child_pid: Arc::new(AtomicU32::new(0)),
        process_identity: Default::default(),
        browser_launch: None,
        mcp_spawn_facts: Arc::new(std::sync::OnceLock::new()),
        life,
        service: None,
    };
    manager.lock().unwrap().insert(key, connection.clone());
    connection
}

fn key(cwd: &Path) -> ConnectionKey {
    ConnectionKey {
        agent_id: "close-retry-fixture".into(),
        cwd: cwd.into(),
        candidate: false,
        conversation_id: None,
        service: None,
    }
}

#[tokio::test]
async fn auth_cleanup_can_retry_confirmed_absence_without_changing_default_close() {
    let dir = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(dir.path().join("logs"), dir.path().into());
    assert!(
        manager
            .close_session("close-retry-fixture", dir.path(), "gone")
            .await
            .is_err()
    );
    assert!(
        manager
            .close_session_for_auth("close-retry-fixture", dir.path(), "gone")
            .await
            .is_ok()
    );
    register(&manager, key(dir.path()), STATE_READY);
    assert!(
        manager
            .close_session_for_auth("close-retry-fixture", dir.path(), "gone")
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn connecting_or_closing_process_owner_is_not_confirmed_absence() {
    for state in [CONNECTING, CLOSING] {
        let dir = tempfile::tempdir().unwrap();
        let manager = AcpManager::new(dir.path().join("logs"), dir.path().into());
        let mut same_source = key(dir.path());
        same_source.service = Some("other-existing-source".into());
        register(&manager, same_source, state);
        assert!(
            manager
                .close_session_for_auth("close-retry-fixture", dir.path(), "gone")
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn unrelated_directory_or_candidate_does_not_replace_the_exact_absence_check() {
    let dir = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(dir.path().join("logs"), dir.path().into());
    let mut candidate = key(dir.path());
    candidate.candidate = true;
    register(&manager, candidate, CLOSING);
    register(&manager, key(&dir.path().join("elsewhere")), CONNECTING);
    assert!(
        manager
            .close_session_for_auth("close-retry-fixture", dir.path(), "gone")
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn failed_route_lookup_is_not_confirmed_absence() {
    let dir = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(dir.path().join("logs"), dir.path().into());
    let connection = register(&manager, key(dir.path()), STATE_READY);
    let sessions = connection.sessions.clone();
    assert!(
        std::thread::spawn(move || {
            let _guard = sessions.lock().unwrap();
            panic!("controlled lock failure");
        })
        .join()
        .is_err()
    );
    assert!(
        manager
            .close_and_delete_session("close-retry-fixture", dir.path(), "gone")
            .await
            .result
            .is_err(),
        "a failed owner lookup must not fall through to preparation deletion"
    );
    assert!(
        manager
            .close_session_for_auth("close-retry-fixture", dir.path(), "gone")
            .await
            .is_err()
    );
}

const INTERACTION_PEER: &str = r#"
import sys,json,time,threading,os
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def pending():
 while not os.path.exists(sys.argv[1]+'_emit'): time.sleep(.005)
 params={'sessionId':'preview'}
 if sys.argv[2]=='permission':
  params.update(toolCall={'toolCallId':'startup','title':'Startup permission','kind':'other'},options=[{'optionId':'allow','name':'Allow','kind':'allow_once'}])
  method='session/request_permission'
 else:
  params.update(mode='form',message='Startup question',requestedSchema={'type':'object','properties':{}})
  method='elicitation/create'
 send({'id':100,'method':method,'params':params})
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialize': result={'protocolVersion':1,'agentCapabilities':{'sessionCapabilities':{'close':{}}},'authMethods':[]}
 elif method=='session/new':
  result={'sessionId':'preview','configOptions':[]}
  send({'id':m['id'],'result':result})
  threading.Thread(target=pending,daemon=True).start(); continue
 elif method=='session/close': open(sys.argv[1]+'_closed','w').write('closed'); result={}
 elif method is None and m.get('id')==100:
  reply=m.get('result',{})
  cancelled=reply.get('action')=='cancel' or reply.get('outcome',{}).get('outcome')=='cancelled'
  marker=sys.argv[1]+'_answered'
  with open(marker+'.tmp','w',encoding='utf-8') as f: f.write('cancelled' if cancelled else 'accepted')
  os.replace(marker+'.tmp',marker); continue
 else: continue
 send({'id':m['id'],'result':result})
"#;

struct InteractionFixture {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    store: crate::meta_store::MetaStore,
    manager: Arc<AcpManager>,
    row: crate::meta_store::AgentRow,
    marker: PathBuf,
    kind: &'static str,
}

impl InteractionFixture {
    async fn new(kind: &'static str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let script = cwd.join("pending.py");
        let marker = cwd.join("interaction");
        std::fs::write(&script, INTERACTION_PEER).unwrap();
        let store = crate::meta_store::MetaStore::open(&cwd.join("meta.db")).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        let row = crate::meta_store::AgentRow {
            id: "close-pending-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec![
                "-u".into(),
                script.to_string_lossy().into_owned(),
                marker.to_string_lossy().into_owned(),
                kind.into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        manager
            .open_session(&row, &cwd, None, vec![], Arc::new(|_| {}), &store)
            .await
            .unwrap();
        Self {
            _dir: dir,
            cwd,
            store,
            manager,
            row,
            marker,
            kind,
        }
    }

    fn marker(&self, suffix: &str) -> PathBuf {
        self.marker.with_file_name(format!("interaction_{suffix}"))
    }

    fn pending(&self) -> bool {
        let owner = self
            .manager
            .session_connection(&self.row.id, &self.cwd, "preview")
            .unwrap();
        if self.kind == "permission" {
            self.manager
                .pending_permissions
                .lock()
                .unwrap()
                .values()
                .any(|entry| entry.session_id == "preview" && entry.lease.belongs_to(&owner.life))
        } else {
            self.manager
                .pending_elicitations
                .lock()
                .unwrap()
                .values()
                .any(|entry| entry.session_id == "preview" && entry.lease.belongs_to(&owner.life))
        }
    }

    async fn emit(&self) {
        // Models the frontend's earlier idle check, followed by an Agent
        // interaction arriving before the backend admits automatic cleanup.
        assert!(!self.pending());
        std::fs::write(self.marker("emit"), "emit").unwrap();
        bounded_until(|| self.pending()).await;
    }

    fn answer(&self) {
        if self.kind == "permission" {
            let mut map = self.manager.pending_permissions.lock().unwrap();
            let id = map.keys().next().unwrap().clone();
            map.remove(&id)
                .unwrap()
                .responder
                .unwrap()
                .respond(json!({"outcome":{"outcome":"selected","optionId":"allow"}}))
                .unwrap();
        } else {
            let mut map = self.manager.pending_elicitations.lock().unwrap();
            let id = map.keys().next().unwrap().clone();
            map.remove(&id)
                .unwrap()
                .responder
                .unwrap()
                .respond(json!({"action":"accept","content":{}}))
                .unwrap();
        }
    }
}

impl Drop for InteractionFixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

async fn bounded_until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !ready() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_cleanup_rejects_late_pending_interactions_without_sending_remote_close() {
    for kind in ["permission", "elicitation"] {
        let f = InteractionFixture::new(kind).await;
        f.emit().await;
        assert!(
            f.manager
                .close_session_for_auth(&f.row.id, &f.cwd, "preview")
                .await
                .is_err(),
            "automatic cleanup closed a late pending {kind}"
        );
        assert!(!f.marker("closed").exists());
        assert!(!f.marker("answered").exists());
        assert!(f.pending());
        f.answer();
        bounded_until(|| f.marker("answered").exists()).await;
        assert_eq!(
            std::fs::read_to_string(f.marker("answered")).unwrap(),
            "accepted"
        );
        f.manager
            .close_session_for_auth(&f.row.id, &f.cwd, "preview")
            .await
            .unwrap();
        assert!(f.marker("closed").exists());
        assert!(
            f.manager
                .session_owner(&f.row.id, &f.cwd, "preview")
                .unwrap()
                .is_none()
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_remote_close_keeps_its_existing_pending_interaction_behavior() {
    for kind in ["permission", "elicitation"] {
        let f = InteractionFixture::new(kind).await;
        f.emit().await;
        f.manager
            .close_session(&f.row.id, &f.cwd, "preview")
            .await
            .unwrap();
        bounded_until(|| f.marker("answered").exists()).await;
        assert_eq!(
            std::fs::read_to_string(f.marker("answered")).unwrap(),
            "cancelled"
        );
        assert!(f.marker("closed").exists());
        assert!(
            f.manager
                .session_owner(&f.row.id, &f.cwd, "preview")
                .unwrap()
                .is_none()
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_cleanup_does_not_touch_another_agents_pending_interaction_with_same_session_id() {
    for kind in ["permission", "elicitation"] {
        let f = InteractionFixture::new(kind).await;
        let mut foreign = f.row.clone();
        foreign.id = "other-pending-fixture".into();
        foreign.args[2] = f.cwd.join("foreign").to_string_lossy().into_owned();
        f.store.insert_agent(&foreign).unwrap();
        f.manager
            .open_session(&foreign, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
            .await
            .unwrap();
        std::fs::write(f.cwd.join("foreign_emit"), "emit").unwrap();
        bounded_until(|| {
            if kind == "permission" {
                !f.manager.pending_permissions.lock().unwrap().is_empty()
            } else {
                !f.manager.pending_elicitations.lock().unwrap().is_empty()
            }
        })
        .await;
        assert!(!f.pending());
        f.manager
            .close_session_for_auth(&f.row.id, &f.cwd, "preview")
            .await
            .unwrap();
        assert!(f.marker("closed").exists());
        assert!(!f.cwd.join("foreign_closed").exists());
        assert!(!f.cwd.join("foreign_answered").exists());
        assert!(
            f.manager
                .session_owner(&foreign.id, &f.cwd, "preview")
                .unwrap()
                .is_some()
        );
    }
}
