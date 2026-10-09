//! Actual manager -> queue -> pump -> subprocess ACP requests, with a controlled
//! JSON-RPC peer. No official Agent, model, account, browser or MCP server runs.
use super::transient_mcp::{SessionMcpOwner, TransientMcpOpen, safe_open_error};
use super::{manager::AcpManager, pump::OpenedSession};
use crate::meta_store::{AgentRow, MetaStore};
use agent_client_protocol::schema::v1::{EnvVariable, McpServerStdio};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

const SYNTHETIC_CAP: &str = "synthetic-transient-acp-fixture-permission";

// The peer emits only sanitized request-shape receipts. Error mode intentionally
// echoes the synthetic credential on the ACP wire to exercise host redaction;
// assertions must never print that credential or a full request/error value.
const PEER: &str = r#"
import sys,json,os,time
mode,root=sys.argv[1:3]
counter=0
prompts={}
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
for line in sys.stdin:
 m=json.loads(line); p=m.get('params',{}); method=m.get('method')
 if method=='initialize':
  reply(m,{'protocolVersion':1,'agentCapabilities':{'loadSession':True,'sessionCapabilities':{'close':{}}},'authMethods':[]})
 elif method in ('session/new','session/load'):
  servers=p.get('mcpServers',[])
  server=servers[0] if len(servers)==1 else {}
  env=server.get('env',[])
  actual=env[0].get('value','') if len(env)==1 else ''
  proof={
   'method':method,
   'revokedBeforeRequest':os.path.exists(os.path.join(root,'capability-revoked-before-request')),
   'cwdMatches':p.get('cwd')==root,
   'oneServer':len(servers)==1,
   'standardFields':set(server)=={'name','command','args','env'},
   'nameMatches':server.get('name')=='farfold-controlled-page',
   'commandMatches':server.get('command')=='/controlled/browser-helper',
   'argsMatch':server.get('args')==['--controlled-stdio'],
   'environmentMatches':len(env)==1 and env[0].get('name')=='FARFOLD_CONTROLLED_CAP' and actual=='synthetic-transient-acp-fixture-permission',
   'sessionIdMatches':('sessionId' not in p) if method=='session/new' else p.get('sessionId')=='restore-controlled'
  }
  with open(os.path.join(root,'request-receipt.json'),'w') as f: json.dump(proof,f)
  if mode=='delayed':
   with open(os.path.join(root,'request-entered'),'w') as f: f.write('entered')
   while not os.path.exists(os.path.join(root,'release-reply')): time.sleep(.005)
  if mode=='reject':
   send({'id':m['id'],'error':{'code':-32603,'message':actual,'data':{'echo':actual}}})
  else:
   counter+=1
   result={'configOptions':[],'farfoldFutureExtension':{'nested':['preserved',{'number':7}]},'farfoldRequestProof':proof}
   if method=='session/new': result['sessionId']='controlled-new-'+str(os.getpid())+'-'+str(counter)
   reply(m,result)
 elif method=='session/prompt':
  if p['prompt'][0]['text']=='wait': prompts[p['sessionId']]=m
  else: reply(m,{'stopReason':'end_turn'})
 elif method=='session/cancel':
  original=prompts.pop(p['sessionId'],None)
  if original is not None: reply(original,{'stopReason':'cancelled'})
 elif method=='session/close': reply(m,{})
 elif 'id' in m: send({'id':m['id'],'error':{'code':-32601,'message':'controlled unsupported request'}})
"#;

#[derive(Default)]
struct OwnerWitness {
    bound: Mutex<Vec<String>>,
    revoked: AtomicUsize,
    revoked_marker: Option<PathBuf>,
    prompt_states: Mutex<Vec<bool>>,
}
impl SessionMcpOwner for OwnerWitness {
    fn bind_session(&self, id: &str) -> Result<(), String> {
        self.bound.lock().unwrap().push(id.into());
        Ok(())
    }
    fn revoke(&self) {
        self.revoked.fetch_add(1, Ordering::AcqRel);
        if let Some(marker) = &self.revoked_marker {
            std::fs::write(marker, "revoked").unwrap();
        }
    }
    fn set_prompt_active(&self, active: bool) {
        self.prompt_states.lock().unwrap().push(active);
    }
}

fn offer(owner: Arc<OwnerWitness>) -> TransientMcpOpen {
    TransientMcpOpen::new(
        McpServerStdio::new("farfold-controlled-page", "/controlled/browser-helper")
            .args(vec!["--controlled-stdio".into()])
            .env(vec![EnvVariable::new(
                "FARFOLD_CONTROLLED_CAP",
                SYNTHETIC_CAP,
            )]),
        owner,
    )
}

struct Fixture {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    store: MetaStore,
    manager: Arc<AcpManager>,
    row: AgentRow,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        Self::with_logs(mode, "")
    }

    fn with_logs(mode: &str, logs: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let code = PEER.replace(
            "mode,root=sys.argv[1:3]",
            &format!(
                "mode,root={},{}",
                serde_json::to_string(mode).unwrap(),
                serde_json::to_string(&cwd.to_string_lossy()).unwrap()
            ),
        );
        let script = crate::platform_tests::python_peer(&cwd, "codex-acp", &code);
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let row = AgentRow {
            id: "registry:codex-acp".into(),
            name: "Controlled peer".into(),
            source: "registry".into(),
            command: script.to_string_lossy().into(),
            args: vec![],
            env: vec![
                ("APP_SERVER_LOGS".into(), logs.into()),
                ("CODEX_CONFIG".into(), "".into()),
            ],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        Self {
            _dir: dir,
            cwd,
            store,
            manager,
            row,
        }
    }

    fn node_with_config(config: &str) -> Self {
        Self::node_with_env(config, "")
    }

    fn node_with_env(config: &str, logs: &str) -> Self {
        // A controlled Python peer under the official Node launch shape tests
        // Farfold's admission/serialization only; it is not an official Agent.
        let mut fixture = Self::with_logs("ok", logs);
        let node = fixture
            .cwd
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        std::fs::rename(&fixture.row.command, &node).unwrap();
        let package = fixture
            .cwd
            .join("node_modules/@agentclientprotocol/codex-acp");
        let entry = package.join("dist/index.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "// controlled launch metadata only").unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@agentclientprotocol/codex-acp","bin":{"codex-acp":"dist/index.js"}}"#,
        )
        .unwrap();
        fixture.row.command = node.to_string_lossy().into();
        fixture.row.args = vec![entry.to_string_lossy().into()];
        fixture.row.env[1].1 = config.into();
        fixture.store.replace_agent_launch(&fixture.row).unwrap();
        fixture
    }

    async fn open(
        &self,
        native: Option<&str>,
        owner: Arc<OwnerWitness>,
    ) -> Result<OpenedSession, String> {
        self.connect_controlled_peer().await?;
        self.manager
            .open_session_selected_with_mcp(
                &self.row,
                &self.cwd,
                native.map(str::to_owned),
                vec![],
                Arc::new(|_| {}),
                &self.store,
                None,
                Some(offer(owner)),
                None,
            )
            .await
    }

    async fn connect_controlled_peer(&self) -> Result<(), String> {
        // The synthetic executable follows the admitted catalog launch shape;
        // the production manager captures both launch and environment facts.
        self.manager
            .connect(&self.row, &self.cwd, &self.store)
            .await
            .map(|_| ())
    }

    fn receipt(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.cwd.join("request-receipt.json")).unwrap())
            .unwrap()
    }

    async fn finish(&self) {
        let pids: Vec<_> = self
            .manager
            .lock()
            .unwrap()
            .values()
            .map(|connection| connection.child_pid.load(Ordering::SeqCst))
            .collect();
        self.manager
            .disconnect(&self.row.id, &self.cwd)
            .await
            .unwrap();
        for pid in pids {
            assert!(
                pid != 0 && crate::platform_tests::process_check(pid as i32) != 0,
                "the exact controlled peer must be reaped before fixture removal"
            );
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

async fn until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("controlled peer did not reach the expected lifecycle point");
}

fn check_receipt(proof: &Value, method: &str) {
    assert_eq!(proof.get("method").and_then(Value::as_str), Some(method));
    for key in [
        "cwdMatches",
        "oneServer",
        "standardFields",
        "nameMatches",
        "commandMatches",
        "argsMatch",
        "environmentMatches",
        "sessionIdMatches",
    ] {
        assert!(
            proof.get(key).and_then(Value::as_bool) == Some(true),
            "controlled peer rejected request-shape field {key}"
        );
    }
}

async fn actual_request(resumed: bool) {
    let f = Fixture::new("ok");
    let owner = Arc::new(OwnerWitness::default());
    let opened = f
        .open(resumed.then_some("restore-controlled"), owner.clone())
        .await
        .unwrap();
    let method = if resumed {
        "session/load"
    } else {
        "session/new"
    };
    check_receipt(&f.receipt(), method);
    check_receipt(&opened.response["farfoldRequestProof"], method);
    assert_eq!(
        opened.response["farfoldFutureExtension"],
        json!({"nested":["preserved",{"number":7}]})
    );
    assert_eq!(
        owner.bound.lock().unwrap().as_slice(),
        std::slice::from_ref(&opened.session_id)
    );
    assert_eq!(owner.revoked.load(Ordering::Acquire), 0);
    f.manager
        .close_session(&f.row.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
    f.finish().await;
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_real_new_request_keeps_standard_fields_and_unknown_response() {
    actual_request(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_real_load_request_keeps_standard_fields_and_unknown_response() {
    actual_request(true).await;
}

async fn rejected_request(resumed: bool) {
    let f = Fixture::new("reject");
    let owner = Arc::new(OwnerWitness::default());
    let error = f
        .open(resumed.then_some("restore-controlled"), owner.clone())
        .await
        .err()
        .expect("the controlled peer must reject this request");
    check_receipt(
        &f.receipt(),
        if resumed {
            "session/load"
        } else {
            "session/new"
        },
    );
    assert!(
        !error.contains(SYNTHETIC_CAP),
        "remote permission credential must not reach the error result"
    );
    assert!(
        error == safe_open_error(),
        "MCP opening must return the fixed safe error"
    );
    assert!(owner.bound.lock().unwrap().is_empty());
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_real_new_failure_does_not_echo_permission_credential() {
    rejected_request(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_real_load_failure_does_not_echo_permission_credential() {
    rejected_request(true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_two_real_routes_close_and_connection_drop_revoke_independently() {
    let f = Fixture::new("ok");
    let one = Arc::new(OwnerWitness::default());
    let two = Arc::new(OwnerWitness::default());
    let first = f.open(None, one.clone()).await.unwrap();
    let second = f.open(None, two.clone()).await.unwrap();
    assert_ne!(first.session_id, second.session_id);
    f.manager
        .close_session(&f.row.id, &f.cwd, &first.session_id)
        .await
        .unwrap();
    assert_eq!(one.revoked.load(Ordering::Acquire), 1);
    assert_eq!(two.revoked.load(Ordering::Acquire), 0);
    assert!(
        f.manager
            .session_owner(&f.row.id, &f.cwd, &second.session_id)
            .unwrap()
            .is_some()
    );
    f.finish().await;
    assert_eq!(one.revoked.load(Ordering::Acquire), 1);
    assert_eq!(two.revoked.load(Ordering::Acquire), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_prompt_lifecycle_without_mcp_cancel_is_scoped_to_its_route() {
    let f = Fixture::new("ok");
    let first = Arc::new(OwnerWitness::default());
    let other = Arc::new(OwnerWitness::default());
    let one = f.open(None, first.clone()).await.unwrap();
    let two = f.open(None, other.clone()).await.unwrap();
    let blocks = |text: &str| serde_json::from_value(json!([{"type":"text","text":text}])).unwrap();
    for id in [&one.session_id, &two.session_id] {
        f.manager
            .session_prompt(&f.row.id, &f.cwd, id, blocks("wait"))
            .await
            .unwrap();
    }
    assert_eq!(*first.prompt_states.lock().unwrap(), [true]);
    assert_eq!(*other.prompt_states.lock().unwrap(), [true]);
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &one.session_id)
        .await
        .unwrap();
    until(|| *first.prompt_states.lock().unwrap() == [true, false, false]).await;
    assert_eq!(*other.prompt_states.lock().unwrap(), [true]);
    assert_eq!(first.revoked.load(Ordering::Acquire), 0);
    assert_eq!(other.revoked.load(Ordering::Acquire), 0);
    f.manager
        .session_prompt(&f.row.id, &f.cwd, &one.session_id, blocks("complete"))
        .await
        .unwrap();
    until(|| *first.prompt_states.lock().unwrap() == [true, false, false, true, false]).await;
    assert_eq!(*other.prompt_states.lock().unwrap(), [true]);
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &two.session_id)
        .await
        .unwrap();
    until(|| *other.prompt_states.lock().unwrap() == [true, false, false]).await;
    for id in [&one.session_id, &two.session_id] {
        f.manager
            .close_session(&f.row.id, &f.cwd, id)
            .await
            .unwrap();
    }
    assert_eq!(first.revoked.load(Ordering::Acquire), 1);
    assert_eq!(other.revoked.load(Ordering::Acquire), 1);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_abandoned_real_open_revokes_after_late_reply_cleanup() {
    let f = Fixture::new("delayed");
    let owner = Arc::new(OwnerWitness::default());
    let mut opening = Box::pin(f.open(None, owner.clone()));
    tokio::select! {
        _ = until(|| f.cwd.join("request-entered").exists()) => {},
        _ = &mut opening => panic!("controlled opening completed before the peer release"),
    }
    check_receipt(&f.receipt(), "session/new");
    drop(opening);
    std::fs::write(f.cwd.join("release-reply"), "release").unwrap();
    until(|| owner.revoked.load(Ordering::Acquire) == 1).await;
    let connection = f.manager.lock().unwrap().values().next().unwrap().clone();
    assert!(
        connection.sessions.lock().unwrap().is_empty(),
        "late reply left an orphan route"
    );
    f.finish().await;
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
}

async fn assert_no_offer(
    f: &Fixture,
    native: Option<&str>,
    expected: super::transient_mcp::McpUnavailable,
) {
    let marker = f.cwd.join("capability-revoked-before-request");
    if marker.exists() {
        std::fs::remove_file(&marker).unwrap();
    }
    let owner = Arc::new(OwnerWitness {
        revoked_marker: Some(marker),
        ..OwnerWitness::default()
    });
    let opened = f.open(native, owner.clone()).await.unwrap();
    assert_eq!(f.receipt()["oneServer"], false);
    assert_eq!(f.receipt()["environmentMatches"], false);
    assert_eq!(f.receipt()["revokedBeforeRequest"], true);
    assert!(owner.bound.lock().unwrap().is_empty());
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
    assert_eq!(
        f.manager
            .browser_tool_unavailable(&f.row.id, &f.cwd, &opened.session_id),
        Some(expected)
    );
    f.manager
        .close_session(&f.row.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
    assert!(
        f.manager
            .browser_tool_unavailable(&f.row.id, &f.cwd, &opened.session_id)
            .is_none()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_unsafe_spawn_opens_ordinary_new_and_load_without_token() {
    use super::transient_mcp::McpUnavailable;
    let f = Fixture::node_with_env("", "synthetic-enabled-logger");
    assert_no_offer(&f, None, McpUnavailable::UnsafeLogging).await;
    assert_no_offer(
        &f,
        Some("restore-controlled"),
        McpUnavailable::UnsafeLogging,
    )
    .await;
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_new_conversation_uses_current_environment_not_preparation_spawn_facts() {
    use super::transient_mcp::McpUnavailable;
    for logs_at_spawn in ["", "synthetic-enabled-logger"] {
        let f = Fixture::node_with_env("", logs_at_spawn);
        f.connect_controlled_peer().await.unwrap();
        let before = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
        let mut changed = f.row.clone();
        changed.env[0].1 = if logs_at_spawn.is_empty() {
            "synthetic-later-logger"
        } else {
            ""
        }
        .into();
        f.store.replace_agent_launch(&changed).unwrap();
        if !logs_at_spawn.is_empty() {
            let owner = Arc::new(OwnerWitness::default());
            let opened = f.open(None, owner).await.unwrap();
            assert_eq!(f.receipt()["oneServer"], true);
            f.manager
                .close_session(&f.row.id, &f.cwd, &opened.session_id)
                .await
                .unwrap();
        } else {
            assert_no_offer(&f, None, McpUnavailable::UnsafeLogging).await;
        }
        let after = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
        assert!(Arc::ptr_eq(&before.mcp_spawn_facts, &after.mcp_spawn_facts));
        assert_eq!(
            before.child_pid.load(Ordering::SeqCst),
            after.child_pid.load(Ordering::SeqCst)
        );
        f.finish().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_stale_reviewed_row_cannot_endorse_current_unreviewed_spawn() {
    use super::transient_mcp::McpUnavailable;
    let f = Fixture::new("ok");
    let owner = Arc::new(OwnerWitness::default());
    let mut stale = f.row.clone();
    stale.source = "registry".into();
    stale.command = "/controlled/stale/codex-acp".into();
    stale.args = vec![];
    let mut current = f.row.clone();
    current.source = "custom".into();
    f.store.replace_agent_launch(&current).unwrap();
    assert!(super::browser_capability::eligible(&stale));
    let opened = f
        .manager
        .open_session_selected_with_mcp(
            &stale,
            &f.cwd,
            None,
            vec![],
            Arc::new(|_| {}),
            &f.store,
            None,
            Some(offer(owner.clone())),
            None,
        )
        .await
        .unwrap();
    assert_eq!(f.receipt()["oneServer"], false);
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
    assert_eq!(
        f.manager
            .browser_tool_unavailable(&current.id, &f.cwd, &opened.session_id),
        Some(McpUnavailable::SourceNotReviewed)
    );
    f.manager
        .close_session(&current.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
    f.manager.disconnect(&current.id, &f.cwd).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_concurrent_rejected_offers_do_not_share_or_retain_tokens() {
    let f = Fixture::node_with_env("", "synthetic-enabled-logger");
    f.connect_controlled_peer().await.unwrap();
    let a = Arc::new(OwnerWitness::default());
    let b = Arc::new(OwnerWitness::default());
    let (a_result, b_result) = tokio::join!(f.open(None, a.clone()), f.open(None, b.clone()));
    let mut accepted = Vec::new();
    for result in [a_result, b_result] {
        match result {
            Ok(opened) => {
                assert_eq!(opened.response["farfoldRequestProof"]["oneServer"], false);
                accepted.push(opened.session_id);
            }
            // The existing admission guard may serialize concurrent opens.
            // A refused ordinary open must still revoke its temporary offer.
            Err(error) => assert!(error == "此对话上次打开尚未结束，请等待结果后重试"),
        }
    }
    assert!(!accepted.is_empty());
    if accepted.len() == 2 {
        assert_ne!(accepted[0], accepted[1]);
    }
    assert_eq!(a.revoked.load(Ordering::Acquire), 1);
    assert_eq!(b.revoked.load(Ordering::Acquire), 1);
    for session_id in accepted {
        f.manager
            .close_session(&f.row.id, &f.cwd, &session_id)
            .await
            .unwrap();
    }
    // A subsequent admitted open stays usable after the possible busy refusal.
    let later_owner = Arc::new(OwnerWitness::default());
    let later = f.open(None, later_owner.clone()).await.unwrap();
    assert_eq!(later.response["farfoldRequestProof"]["oneServer"], false);
    assert_eq!(later_owner.revoked.load(Ordering::Acquire), 1);
    f.manager
        .close_session(&f.row.id, &f.cwd, &later.session_id)
        .await
        .unwrap();
    assert!(
        f.manager
            .live_connection(&f.row.id, &f.cwd)
            .unwrap()
            .sessions
            .lock()
            .unwrap()
            .is_empty()
    );
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_distinct_service_revisions_keep_separate_spawn_facts() {
    use super::service_connection::{PreparedService, ServiceContext};
    let f = Fixture::node_with_config("");
    let prepared = |revision: &str, logs: &str| PreparedService {
        delivery: None,
        environment: std::collections::HashMap::from([
            ("APP_SERVER_LOGS".into(), logs.into()),
            ("CODEX_CONFIG".into(), "".into()),
        ]),
        context: ServiceContext {
            identity: crate::credentials::ServiceIdentity {
                id: "synthetic-service".into(),
                fingerprint: "synthetic".into(),
                model: "synthetic-model".into(),
            },
            revision: revision.into(),
            model_id: "synthetic-model".into(),
        },
    };
    f.manager
        .connect_launch(&f.row, &f.cwd, &f.store, false, Some(prepared("one", "")))
        .await
        .unwrap();
    f.manager
        .connect_launch(
            &f.row,
            &f.cwd,
            &f.store,
            false,
            Some(prepared("two", "synthetic-log")),
        )
        .await
        .unwrap();
    {
        let connections = f.manager.lock().unwrap();
        let one = connections
            .iter()
            .find(|(key, _)| key.service.as_deref() == Some("one"))
            .unwrap()
            .1;
        let two = connections
            .iter()
            .find(|(key, _)| key.service.as_deref() == Some("two"))
            .unwrap()
            .1;
        assert!(one.mcp_spawn_facts.get().unwrap().logs_safe);
        assert!(!two.mcp_spawn_facts.get().unwrap().logs_safe);
        assert!(!Arc::ptr_eq(&one.mcp_spawn_facts, &two.mcp_spawn_facts));
        assert_ne!(
            one.child_pid.load(Ordering::SeqCst),
            two.child_pid.load(Ordering::SeqCst)
        );
    }
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_node_shaped_peer_new_and_load_use_spawn_facts_and_standard_fields() {
    let f = Fixture::node_with_config(r#"{"model":"synthetic"}"#);
    for native in [None, Some("restore-controlled")] {
        let owner = Arc::new(OwnerWitness::default());
        let opened = f.open(native, owner.clone()).await.unwrap();
        let connection = f
            .manager
            .session_connection(&f.row.id, &f.cwd, &opened.session_id)
            .unwrap();
        assert_eq!(
            connection.browser_launch,
            Some(super::browser_capability::LaunchKind::Node)
        );
        check_receipt(
            &f.receipt(),
            if native.is_some() {
                "session/load"
            } else {
                "session/new"
            },
        );
        f.manager
            .close_session(&f.row.id, &f.cwd, &opened.session_id)
            .await
            .unwrap();
        assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
    }
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_node_inline_mcp_or_unknown_config_never_receives_temporary_token() {
    use super::transient_mcp::McpUnavailable;
    for (config, reason) in [
        (
            r#"{"mcp_servers":{"synthetic":{"command":"fixture"}}}"#,
            McpUnavailable::InlineMcpConflict,
        ),
        (
            r#"{"mcp_servers.synthetic.command":"fixture"}"#,
            McpUnavailable::InlineMcpConflict,
        ),
        ("invalid-json", McpUnavailable::LaunchUnconfirmed),
    ] {
        let f = Fixture::node_with_config(config);
        assert_no_offer(&f, None, reason).await;
        assert_no_offer(&f, Some("restore-controlled"), reason).await;
        f.finish().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_binary_does_not_inherit_unrelated_node_log_or_config_restrictions() {
    let f = Fixture::with_logs("ok", "synthetic-node-only-log-variable");
    let mut configured = f.row.clone();
    configured.env[1].1 = "synthetic-not-json-for-node".into();
    f.store.replace_agent_launch(&configured).unwrap();
    let owner = Arc::new(OwnerWitness::default());
    let opened = f.open(None, owner.clone()).await.unwrap();
    let connection = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &opened.session_id)
        .unwrap();
    assert_eq!(
        connection.browser_launch,
        Some(super::browser_capability::LaunchKind::Binary)
    );
    assert!(connection.mcp_spawn_facts.get().is_none());
    check_receipt(&f.receipt(), "session/new");
    f.manager
        .close_session(&f.row.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
    f.finish().await;
}
