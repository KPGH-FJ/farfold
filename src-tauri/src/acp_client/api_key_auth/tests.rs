//! Synthetic declarations and protocol peer, never real account acceptance.
use super::*;
use crate::{
    acp_client::handshake::Handshake,
    meta_store::{AgentRow, MetaStore},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU8, AtomicU32},
    },
};

const SECRET: &str = "protocol-key-transient-canary";

#[test]
fn protocol_key_payload_uses_only_official_request_metadata() {
    let key = ProtocolApiKey::new("openai".into(), SECRET.into()).unwrap();
    assert_eq!(key.provider(), "openai");
    let request = key.into_request("api-key".into());
    let wire = serde_json::to_value(request).unwrap();
    assert_eq!(
        wire,
        json!({"methodId":"api-key","_meta":{"api-key":{"apiKey":SECRET}}})
    );
    let diagnostic = crate::acp_client::tap::diagnostic_record(
        &json!({"jsonrpc":"2.0","id":1,"method":"authenticate","params":wire}).to_string(),
        "out",
    );
    assert_eq!(diagnostic["event"], "authenticate");
    assert!(!diagnostic.to_string().contains(SECRET));
}

#[test]
fn protocol_key_rejects_unverified_provider_and_invalid_secret() {
    assert!(ProtocolApiKey::new("future-provider".into(), SECRET.into()).is_err());
    for key in ["", "   ", "a\nb", "a\0b"] {
        assert!(ProtocolApiKey::new("openai".into(), key.into()).is_err());
    }
    assert!(ProtocolApiKey::new("openai".into(), "x".repeat(16385)).is_err());
}

#[test]
fn protocol_key_unknown_provider_is_unavailable_without_redirecting_env_only_route() {
    use crate::acp_client::auth_route::{ManagedTerminalProof, Route, UnavailableReason, route};
    let row = AgentRow {
        id: "declared-key".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: "/unused".into(),
        args: vec![],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    let handshake = Handshake::decode(
        json!({"protocolVersion":1,"agentCapabilities":{},"authMethods":[
            {"id":"env","name":"Key","_meta":{"api-key":{"env":"OFFICIAL_KEY"}}},
            {"id":"known","name":"Key","_meta":{"api-key":{"provider":"openai"}}},
            {"id":"future","name":"Key","_meta":{"api-key":{"provider":"future-provider"}}}
        ]}),
    )
    .unwrap();
    let live = handshake.execution_json();
    for index in [0, 1] {
        assert!(matches!(
            route(
                &row,
                &live["authMethods"][index],
                &ManagedTerminalProof::default()
            ),
            Route::ApiKey(_)
        ));
    }
    assert!(matches!(
        route(
            &row,
            &live["authMethods"][2],
            &ManagedTerminalProof::default()
        ),
        Route::Unavailable(UnavailableReason::ApiKeyProviderUnsupported)
    ));
}

fn register(
    manager: &AcpManager,
    method: Value,
) -> tokio::sync::mpsc::UnboundedReceiver<crate::acp_client::operations::QueuedCommand> {
    use crate::acp_client::{
        lifecycle::ConnectionLife,
        manager::{ConnectionKey, ManagedConnection, STATE_READY},
    };
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let handshake = OnceLock::new();
    handshake
        .set(
            Handshake::decode(
                json!({"protocolVersion":1,"agentCapabilities":{},"authMethods":[method]}),
            )
            .unwrap(),
        )
        .ok()
        .unwrap();
    let (command_tx, receive) = tokio::sync::mpsc::unbounded_channel();
    manager.lock().unwrap().insert(
        ConnectionKey {
            agent_id: "example".into(),
            cwd: "/chosen".into(),
            candidate: false,
            conversation_id: None,
            service: None,
        },
        ManagedConnection {
            launch_identity: None,
            connection_id: "fixture-connection".into(),
            account: Default::default(),
            account_query: None,
            workspace_access: crate::acp_client::workspace_access::Availability::new(None),
            command_tx,
            state: Arc::new(AtomicU8::new(STATE_READY)),
            handshake: Arc::new(handshake),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            child_pid: Arc::new(AtomicU32::new(0)),
            browser_launch: None,
            mcp_spawn_facts: Arc::new(std::sync::OnceLock::new()),
            life,
            service: None,
        },
    );
    receive
}

#[tokio::test]
async fn protocol_key_requires_matching_live_provider_declaration_before_dispatch() {
    for method in [
        json!({"id":"api-key","name":"Key"}),
        json!({"id":"api-key","name":"Key","_meta":{"api-key":{"env":"OFFICIAL_KEY"}}}),
        json!({"id":"api-key","name":"Key","_meta":{"api-key":{"provider":"future-provider"}}}),
        json!({"id":"api-key","name":"Key","type":"terminal","args":["login"],"_meta":{"api-key":{"provider":"openai"}}}),
        json!({"id":"api-key","name":"Key","_meta":{"api-key":{"provider":false}}}),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let manager = AcpManager::new(dir.path().into(), dir.path().into());
        let mut commands = register(&manager, method);
        let result = manager
            .authenticate_with_key(
                "example",
                Path::new("/chosen"),
                "api-key",
                Some(ProtocolApiKey::new("openai".into(), SECRET.into()).unwrap()),
                AuthenticationOperation::new(),
                Arc::new(|| {}),
            )
            .await;
        assert!(result.is_err());
        assert!(commands.try_recv().is_err());
    }
}

#[tokio::test]
async fn protocol_key_command_debug_and_plain_auth_never_expose_or_reuse_key() {
    let dir = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(dir.path().into(), dir.path().into());
    let mut commands = register(
        &manager,
        json!({"id":"api-key","name":"Key","_meta":{"api-key":{"provider":"openai"}}}),
    );
    assert!(
        manager
            .authenticate(
                "example",
                Path::new("/chosen"),
                "api-key",
                AuthenticationOperation::new(),
                Arc::new(|| {})
            )
            .await
            .is_err()
    );
    assert!(commands.try_recv().is_err());
    let (authenticated, ()) = tokio::join!(
        manager.authenticate_with_key(
            "example",
            Path::new("/chosen"),
            "api-key",
            Some(ProtocolApiKey::new("openai".into(), SECRET.into()).unwrap()),
            AuthenticationOperation::new(),
            Arc::new(|| {})
        ),
        async {
            let queued = commands.recv().await.unwrap();
            assert_eq!(format!("{:?}", queued.command), "Authenticate");
            match queued.command {
                ManagerCommand::Authenticate { key, result, .. } => {
                    assert_eq!(key.unwrap().provider(), "openai");
                    result.send(Ok(())).unwrap();
                }
                _ => panic!("only authentication should be dispatched"),
            }
        }
    );
    authenticated.unwrap();
    assert!(commands.try_recv().is_err());
}

const AGENT: &str = r#"
import sys,json
calls=0
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='initialize':
  result={'protocolVersion':1,'agentInfo':{'name':'fixture','version':'1'},'agentCapabilities':{},'authMethods':[{'id':'api-key','name':'API Key','_meta':{'api-key':{'provider':'openai'}}}]}
  print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)
 elif m.get('method')=='authenticate':
  assert m['params']=={'methodId':'api-key','_meta':{'api-key':{'apiKey':'protocol-key-transient-canary'}}}
  calls+=1
  open(sys.argv[1],'ab').write(b'matched\n')
  if calls==1: reply={'result':{}}
  else: reply={'error':{'code':-32603,'message':'protocol-key-transient-canary','data':{'secret':'protocol-key-transient-canary'}}}
  print(json.dumps(dict(jsonrpc='2.0',id=m['id'],**reply)),flush=True)
"#;

struct Stop(Arc<AcpManager>);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.stop_for_shutdown();
    }
}

#[tokio::test]
async fn protocol_key_wire_round_trip_keeps_secret_out_of_cache_and_error_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let script = cwd.join("peer.py");
    let marker = cwd.join("matched");
    std::fs::write(&script, AGENT).unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let _stop = Stop(manager.clone());
    let row = AgentRow {
        id: "protocol-key-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: crate::platform_tests::python(),
        args: vec![
            "-u".into(),
            script.to_string_lossy().into_owned(),
            marker.to_string_lossy().into_owned(),
        ],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    manager.connect(&row, &cwd, &store).await.unwrap();
    let cached = store.get_agent(&row.id).unwrap().unwrap();
    let public = cached.handshake.unwrap();
    assert!(!public.to_string().contains(SECRET));
    assert!(public["authMethods"][0].get("_meta").is_none());
    for expected_error in [false, true] {
        let result = manager
            .authenticate_with_key(
                &row.id,
                &cwd,
                "api-key",
                Some(ProtocolApiKey::new("openai".into(), SECRET.into()).unwrap()),
                AuthenticationOperation::new(),
                Arc::new(|| {}),
            )
            .await;
        if expected_error {
            assert_eq!(result.unwrap_err(), "账号操作未完成，请检查后重试");
        } else {
            result.unwrap();
        }
    }
    let cancelled = AuthenticationOperation::new();
    cancelled.abandon();
    let result = manager
        .authenticate_with_key(
            &row.id,
            &cwd,
            "api-key",
            Some(ProtocolApiKey::new("openai".into(), SECRET.into()).unwrap()),
            cancelled,
            Arc::new(|| {}),
        )
        .await;
    assert_eq!(result.unwrap_err(), "AUTH_CANCELLED");
    assert_eq!(
        std::fs::read_to_string(marker).unwrap(),
        "matched\nmatched\n"
    );
    manager.disconnect(&row.id, &cwd).await.unwrap();
    for file in std::fs::read_dir(cwd.join("logs")).unwrap() {
        let content = std::fs::read_to_string(file.unwrap().path()).unwrap();
        assert!(!content.contains(SECRET));
    }
    let stored = store.get_agent(&row.id).unwrap().unwrap();
    assert!(stored.env.is_empty());
    assert!(
        !serde_json::to_value(stored)
            .unwrap()
            .to_string()
            .contains(SECRET)
    );
}
