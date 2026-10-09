//! Request-scoped inquiries during authentication, without any real account.
use super::{
    manager::{AcpManager, AuthenticationOperation},
    pump::SessionSink,
};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;

const PEER: &str = r#"
import sys,json
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
auth=None
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 if method=='initialize':
  reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[{'id':x,'name':x} for x in ['form','url','early-failure','cancel','wrong-owner','unknown-method']]})
 elif method=='session/new':
  auth=m
  send({'id':801,'method':'elicitation/create','params':{'requestId':m['id'],'mode':'form','message':'Confirm new conversation','requestedSchema':{'type':'object','properties':{}}}})
 elif m.get('id')==801:
  reply(auth,{'sessionId':'opened-after-question'})
 elif method=='authenticate':
  auth=m; mode=p['methodId']
  q={'requestId':m['id'],'mode':'form' if mode=='form' else 'url','message':'Controlled inquiry','requestedSchema':{'type':'object','properties':{'answer':{'type':'string'}}},'url':'https://example.test/connect','elicitationId':'auth-step','_meta':{'future':False}}
  if mode=='wrong-owner': q['requestId']='unowned'
  send({'id':701,'method':'_fixture/future_question' if mode=='unknown-method' else 'elicitation/create','params':q})
  if mode=='early-failure':
   send({'method':'elicitation/complete','params':{'elicitationId':'auth-step'}})
   send({'id':auth['id'],'error':{'code':-32602,'message':'controlled authentication failed'}})
 elif method=='$/cancel_request':
  send({'id':auth['id'],'error':{'code':-32800,'message':'controlled cancellation'}})
  send({'method':'elicitation/complete','params':{'elicitationId':'auth-step'}})
 elif m.get('id')==701 and auth['params']['methodId']!='early-failure':
  mode=auth['params']['methodId']
  if 'error' in m:
   send({'id':auth['id'],'error':{'code':-32602,'message':'reverse request rejected'}})
  elif mode=='form' and m.get('result')=={'action':'accept','content':{'answer':'retained'}}: reply(auth,{})
  elif mode=='url' and m.get('result')=={'action':'accept'}:
   send({'method':'elicitation/complete','params':{'elicitationId':'auth-step'}})
   send({'method':'elicitation/complete','params':{'elicitationId':'auth-step'}})
   reply(auth,{})
  else: send({'id':auth['id'],'error':{'code':-32602,'message':'unexpected answer'}})
"#;

struct Fixture {
    _root: tempfile::TempDir,
    manager: AcpManager,
    store: MetaStore,
    agent: AgentRow,
    cwd: std::path::PathBuf,
    operation: AuthenticationOperation,
    events: mpsc::UnboundedReceiver<Value>,
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let script = cwd.join("peer.py");
        std::fs::write(&script, PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let agent = AgentRow {
            id: "request-inquiry-fixture".into(),
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
        manager.connect(&agent, &cwd, &store).await.unwrap();
        let (send, events) = mpsc::unbounded_channel();
        let sink: SessionSink = Arc::new(move |event| {
            let _ = send.send(event);
        });
        Self {
            _root: root,
            manager,
            store,
            agent,
            cwd,
            operation: AuthenticationOperation::new().with_events(sink),
            events,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

#[tokio::test]
async fn request_scoped_form_and_url_reply_to_the_exact_parent() {
    for mode in ["form", "url"] {
        let mut f = Fixture::new().await;
        let operation = f.operation.clone();
        let run = f
            .manager
            .authenticate(&f.agent.id, &f.cwd, mode, operation, Arc::new(|| {}));
        tokio::pin!(run);
        let inquiry=tokio::time::timeout(Duration::from_secs(5),async {
            tokio::select! { result=&mut run => panic!("parent ended without showing inquiry: {result:?}"), event=f.events.recv()=>event.unwrap() }
        }).await.unwrap();
        assert_eq!(inquiry["kind"], "elicitation");
        assert_eq!(inquiry["mode"], mode);
        assert_eq!(inquiry["request"]["_meta"]["future"], false);
        let id = inquiry["requestId"].as_str().unwrap();
        let wrong = super::elicitation::respond(
            &f.manager.pending_elicitations,
            id,
            None,
            Some(&json!({"connectionId":"wrong","requestId":inquiry["owner"]["requestId"]})),
            "accept",
            None,
        )
        .unwrap();
        assert_eq!(wrong.status, "expired");
        assert_eq!(f.manager.pending_elicitations.lock().unwrap().len(), 1);
        let reply = super::elicitation::respond(
            &f.manager.pending_elicitations,
            id,
            None,
            inquiry.get("owner"),
            "accept",
            Some(json!({"answer":"retained"})),
        )
        .unwrap();
        assert_eq!(reply.status, "submitted");
        assert!(
            tokio::time::timeout(Duration::from_secs(5), &mut run)
                .await
                .unwrap()
                .is_ok()
        );
        let events = std::iter::from_fn(|| f.events.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(
            events
                .iter()
                .filter(|e| e["kind"] == "elicitationComplete")
                .count(),
            usize::from(mode == "url")
        );
        assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn complete_before_accept_cannot_turn_a_failed_parent_into_success() {
    let mut f = Fixture::new().await;
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        f.manager.authenticate(
            &f.agent.id,
            &f.cwd,
            "early-failure",
            f.operation.clone(),
            Arc::new(|| {}),
        ),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    let inquiry = f.events.recv().await.unwrap();
    let complete = f.events.recv().await.unwrap();
    assert_eq!(inquiry["kind"], "elicitation");
    assert_eq!(complete["kind"], "elicitationComplete");
    assert_eq!(complete["requestId"], inquiry["requestId"]);
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
    assert_eq!(
        super::elicitation::respond(
            &f.manager.pending_elicitations,
            inquiry["requestId"].as_str().unwrap(),
            None,
            inquiry.get("owner"),
            "accept",
            None
        )
        .unwrap()
        .status,
        "expired"
    );
}

#[tokio::test]
async fn unowned_request_cannot_open_a_card_or_complete_another_operation() {
    let mut f = Fixture::new().await;
    assert!(
        tokio::time::timeout(
            Duration::from_secs(5),
            f.manager.authenticate(
                &f.agent.id,
                &f.cwd,
                "wrong-owner",
                f.operation.clone(),
                Arc::new(|| {})
            )
        )
        .await
        .unwrap()
        .is_err()
    );
    assert!(f.events.try_recv().is_err());
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancellation_invalidates_request_scoped_answers_before_the_parent_replies() {
    let mut f = Fixture::new().await;
    let operation = f.operation.clone();
    let run = f
        .manager
        .authenticate(&f.agent.id, &f.cwd, "cancel", operation, Arc::new(|| {}));
    tokio::pin!(run);
    let inquiry=tokio::time::timeout(Duration::from_secs(5),async { tokio::select!{result=&mut run=>panic!("unexpected {result:?}"),event=f.events.recv()=>event.unwrap()} }).await.unwrap();
    f.operation.abandon();
    assert_eq!(
        super::elicitation::respond(
            &f.manager.pending_elicitations,
            inquiry["requestId"].as_str().unwrap(),
            None,
            inquiry.get("owner"),
            "accept",
            None
        )
        .unwrap()
        .status,
        "expired"
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(5), &mut run)
            .await
            .unwrap()
            .is_err()
    );
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
    assert!(
        !std::iter::from_fn(|| f.events.try_recv().ok())
            .any(|e| e["kind"] == "elicitationComplete")
    );
}

#[tokio::test]
async fn request_scoped_new_question_precedes_the_created_session() {
    let f = Fixture::new().await;
    let (send, mut events) = mpsc::unbounded_channel();
    let sink: SessionSink = Arc::new(move |event| {
        let _ = send.send(event);
    });
    let run = f
        .manager
        .open_session(&f.agent, &f.cwd, None, vec![], sink, &f.store);
    tokio::pin!(run);
    let event = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::select! { result = &mut run => panic!("new ended before asking: {:?}", result.err()), event = events.recv() => event.unwrap() }
    }).await.unwrap();
    assert_eq!(event["kind"], "elicitation");
    assert!(event["owner"].get("sessionId").is_none());
    let reply = super::elicitation::respond(
        &f.manager.pending_elicitations,
        event["requestId"].as_str().unwrap(),
        None,
        event.get("owner"),
        "accept",
        Some(json!({})),
    )
    .unwrap();
    assert_eq!(reply.status, "submitted");
    let opened = tokio::time::timeout(Duration::from_secs(3), &mut run)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(opened.session_id, "opened-after-question");
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn declined_or_cancelled_url_does_not_claim_external_completion_or_parent_success() {
    for action in ["decline", "cancel"] {
        let mut f = Fixture::new().await;
        let run = f.manager.authenticate(
            &f.agent.id,
            &f.cwd,
            "url",
            f.operation.clone(),
            Arc::new(|| {}),
        );
        tokio::pin!(run);
        let event = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::select! { result = &mut run => panic!("auth ended before inquiry: {result:?}"), event = f.events.recv() => event.unwrap() }
        }).await.unwrap();
        let reply = super::elicitation::respond(
            &f.manager.pending_elicitations,
            event["requestId"].as_str().unwrap(),
            None,
            event.get("owner"),
            action,
            None,
        )
        .unwrap();
        assert_eq!(reply.status, "submitted");
        assert!(
            tokio::time::timeout(Duration::from_secs(3), &mut run)
                .await
                .unwrap()
                .is_err()
        );
        assert!(
            !std::iter::from_fn(|| f.events.try_recv().ok())
                .any(|e| e["kind"] == "elicitationComplete")
        );
        assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn unknown_request_scoped_method_keeps_raw_details_without_inventing_an_action() {
    let mut f = Fixture::new().await;
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        f.manager.authenticate(
            &f.agent.id,
            &f.cwd,
            "unknown-method",
            f.operation.clone(),
            Arc::new(|| {}),
        ),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    let events = std::iter::from_fn(|| f.events.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(
        events.len(),
        1,
        "an owned unknown request must retain its original details"
    );
    assert_eq!(events[0]["kind"], "elicitationUnavailable");
    assert_eq!(events[0]["params"]["method"], "_fixture/future_question");
    assert_eq!(events[0]["params"]["params"]["_meta"]["future"], false);
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
}
