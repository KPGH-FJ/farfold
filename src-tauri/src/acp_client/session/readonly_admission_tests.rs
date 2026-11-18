//! The lowest common open rejects an MCP offer before starting any peer.
use super::*;
use crate::acp_client::{
    open_purpose::OpenPurpose,
    transient_mcp::{SessionMcpOwner, TransientMcpOpen},
};
use agent_client_protocol::schema::v1::McpServerStdio;
use std::sync::atomic::AtomicBool;

#[derive(Default)]
struct Owner(AtomicBool);
impl SessionMcpOwner for Owner {
    fn bind_session(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn set_prompt_active(&self, _: bool) {}
    fn fork_admissible(&self) -> bool {
        true
    }
    fn revoke(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn search_read_preview_lowest_mcp_admission_never_starts_a_peer() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap();
    let script = cwd.join("peer.py");
    std::fs::write(&script, r#"
import sys,json,os
open(os.path.join(os.path.dirname(__file__),'unexpected-start'),'w').write('started')
for line in sys.stdin:
 m=json.loads(line)
 if 'id' in m:
  result={'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]} if m.get('method')=='initialize' else {'configOptions':[]}
  print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)
"#).unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let agent = AgentRow {
        id: "readonly-mcp-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: crate::platform_tests::python(),
        args: vec!["-u".into(), script.to_string_lossy().into()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&agent).unwrap();
    let manager = AcpManager::new(cwd.join("logs"), cwd.clone());
    let owner = Arc::new(Owner::default());
    let offer = TransientMcpOpen::new(
        McpServerStdio::new("controlled-read-reject", "/controlled-not-executed-mcp"),
        owner.clone(),
    );
    let opened = manager
        .open_session_owned_with_mcp(
            &agent,
            &cwd,
            Some("history".into()),
            vec![],
            Arc::new(|_| {}),
            &store,
            None,
            Some("read-mcp-token".into()),
            OpenPurpose::SearchReadOnly,
            Some(offer),
            None,
            None,
            None,
            None,
            None,
        )
        .await;
    manager.stop_for_shutdown();
    assert!(opened.is_err());
    assert!(
        manager.lock().unwrap().is_empty(),
        "invalid read must not create a connection"
    );
    assert!(!cwd.join("unexpected-start").exists());
    assert!(
        owner.0.load(Ordering::SeqCst),
        "the rejected offer is revoked without binding"
    );
    assert!(store.list_sessions().unwrap().is_empty());
}
