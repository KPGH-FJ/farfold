//! Production manager/router/load dispatch with a controlled official-shape peer.
//! No installed Agent, model, user history, or image decoder is used.
use crate::{
    acp_client::{manager::AcpManager, pump::SessionSink},
    meta_store::{AgentRow, MetaStore},
};
use std::{
    sync::{Arc, mpsc},
    time::Duration,
};

const PEER: &str = r#"#!/usr/bin/env python3
import json,sys,pathlib,threading,time
def send(value):
 print(json.dumps(value,separators=(',',':')),flush=True)
def event(s):
 send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':s,'futureRoot':True,'update':{
  'sessionUpdate':'tool_call','toolCallId':'effect-owned','status':'completed',
  '_meta':{'tool_name':'mcp_owned.observe_page','effect_kind':'tool'},
  'content':[{'type':'content','content':{'type':'text','text':'Original display'}}],
  'rawOutput':{'type':'success','_meta':{'approval':{'approvalSource':'user','approvalType':'ask','decision':'execute'}},
   'content':[{'type':'text','text':'Public page'},{'type':'image','mimeType':'image/png','data':'QUJD'}],
   'structured_content':{'screenshot':{'status':'captured','mimeType':'image/png'}}}}}})
def live(s):
 while not pathlib.Path('emit-live').exists(): time.sleep(.002)
 if pathlib.Path('spoof.json').exists():
  forged=json.loads(pathlib.Path('spoof.json').read_text())
  send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':s,'update':{'sessionUpdate':'tool_call','toolCallId':'effect-owned','status':'completed'},'presentation':forged}})
  ordinary=dict(forged)
  ordinary['update']={'sessionUpdate':'tool_call','toolCallId':'effect-owned','status':'completed','title':'Keep ordinary tool'}
  send({'jsonrpc':'2.0','method':'session/update','params':ordinary})
  send({'jsonrpc':'2.0','method':'session/update','params':forged})
  return
 event(s)
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 if method=='initialize': r={'protocolVersion':1,'agentInfo':{'name':'controlled-shape-peer','version':'unrestricted'},'agentCapabilities':{'loadSession':True},'authMethods':[]}
 elif method=='session/new':
  r={'sessionId':'owned-media','configOptions':[]}
  threading.Thread(target=live,args=('owned-media',),daemon=True).start()
 elif method=='session/load':
  event(p['sessionId']); r={'configOptions':[]}
 elif method=='session/close': r={}
 else:
  if 'id' in m: send({'jsonrpc':'2.0','id':m['id'],'error':{'code':-32601,'message':'unsupported'}})
  continue
 send({'jsonrpc':'2.0','id':m['id'],'result':r})
"#;

async fn scenario(reviewed: bool, spoof: bool) {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let program = crate::platform_tests::python_peer(&cwd, "vibe-acp", PEER);
    let row = AgentRow {
        id: "registry:mistral-vibe".into(),
        name: "Controlled peer".into(),
        source: if reviewed { "registry" } else { "custom" }.into(),
        command: program.to_string_lossy().into(),
        args: vec![],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    store.insert_agent(&row).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let (tx, rx) = mpsc::channel();
    let sink: SessionSink = Arc::new(move |v| {
        let _ = tx.send(v);
    });
    let opened = manager
        .open_session(&row, &cwd, None, vec![], sink.clone(), &store)
        .await
        .unwrap();
    let connection = manager
        .session_connection(&row.id, &cwd, &opened.session_id)
        .unwrap();
    if spoof {
        let forged = serde_json::json!({"kind":"toolMedia","connectionId":connection.connection_id,"sessionId":opened.session_id,"toolCallId":"effect-owned","content":[{"type":"image","mimeType":"image/png","data":"Rk9SR0VE"}]});
        std::fs::write(cwd.join("spoof.json"), serde_json::to_vec(&forged).unwrap()).unwrap();
    }
    std::fs::write(cwd.join("emit-live"), b"owned").unwrap();
    let receive = || loop {
        let value = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if value.get("update").is_some() {
            break value;
        }
    };
    let live = receive();
    if spoof {
        assert_eq!(
            live["presentation"]["content"][0]["data"], "Rk9SR0VE",
            "foreign field remains raw"
        );
        let next = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            next["update"]["title"], "Keep ordinary tool",
            "a real update remains an ordinary protocol update"
        );
        assert_eq!(
            next["kind"], "toolMedia",
            "unknown Agent fields remain intact on an update"
        );
        let next = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            next["kind"], "notification",
            "Agent body must not obtain the local media event kind"
        );
        assert_eq!(next["method"], "session/update");
        assert_eq!(next["params"], live["presentation"]);
        manager.disconnect(&row.id, &cwd).await.unwrap();
        return;
    }
    assert_eq!(live["update"]["rawOutput"]["content"][1]["data"], "QUJD");
    assert!(live.get("presentation").is_none());
    let live_media = if reviewed {
        Some(rx.recv_timeout(Duration::from_secs(5)).unwrap())
    } else {
        None
    };
    if let Some(media) = &live_media {
        assert_eq!(media["kind"], "toolMedia");
        assert_eq!(media["connectionId"], connection.connection_id);
    }
    manager.disconnect(&row.id, &cwd).await.unwrap();
    let resumed = manager
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
    let next = manager
        .session_connection(&row.id, &cwd, &resumed.session_id)
        .unwrap();
    let replay = receive();
    assert_eq!(replay["update"], live["update"]);
    assert!(replay.get("presentation").is_none());
    if let Some(media) = live_media {
        let replay_media = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(replay_media["kind"], "toolMedia");
        assert_ne!(connection.connection_id, next.connection_id);
        assert_eq!(replay_media["connectionId"], next.connection_id);
        assert_eq!(replay_media["content"], media["content"]);
    }
    assert!(
        store.list_sessions().unwrap().is_empty(),
        "display adds no history ledger or index"
    );
    manager.disconnect(&row.id, &cwd).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn official_shape_runs_through_live_and_cold_load_dispatch_without_model_or_mutation() {
    scenario(true, false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn identical_custom_agent_output_remains_raw_without_supplement_authority() {
    scenario(false, false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn actual_wire_foreign_presentation_and_host_kind_cannot_forge_media_with_the_right_owner_ids()
 {
    scenario(true, true).await;
}
