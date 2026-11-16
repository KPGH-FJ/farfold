//! A synthetic ACP peer delegates only self-created test commands to Farfold.
use super::{manager::AcpManager, pump::SessionSink};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::sync::mpsc;

struct Cleanup(Arc<AcpManager>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.0.stop_for_shutdown();
    }
}

const PEER: &str = r#"
import sys,json,os
prompts={}
locations={}
owners={}
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
def update(s,t): send({'method':'session/update','params':{'sessionId':s,'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':t}}}})
def create(s,n):
 owners[n]=s
 send({'id':n,'method':'terminal/create','params':{'sessionId':s,'command':'/bin/sh','args':['./owned.sh',s,'4' if s=='b' else '20'],'cwd':locations[s]}})
def watch(s,n,tid):
 owners[n]=s
 send({'id':n,'method':'terminal/wait_for_exit','params':{'sessionId':s,'terminalId':tid}})
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); n=m.get('id')
 if method=='initialize':
  assert m['params']['clientCapabilities']['terminal'] is True
  reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new':
  cwd=m['params']['cwd']; s=os.path.basename(cwd); locations[s]=cwd
  reply(m,{'sessionId':s})
 elif method=='session/prompt':
  s=m['params']['sessionId']; prompts[s]=m
  create(s,{'a':101,'b':102,'denied':103}[s])
 elif method=='session/cancel':
  s=m['params']['sessionId']
  reply(prompts.pop(s),{'stopReason':'cancelled'})
  create(s,104)
 elif method is None and n in (101,102):
  watch(owners[n], n+10, m['result']['terminalId'])
 elif method is None and n==103:
  assert 'error' in m,m
  reply(prompts.pop('denied'),{'stopReason':'end_turn'})
 elif method is None and n==104:
  assert 'error' in m,m
  update('a','late command refused')
 elif method is None and n==112:
  assert m['result']['exitCode']==0,m
  reply(prompts.pop('b'),{'stopReason':'end_turn'})
"#;

const OWNED_COMMAND: &str = r#"#!/bin/sh
set -eu
printf '%s\n' "$$" > "$1.shell"
/bin/sleep "$2" &
child=$!
printf '%s\n' "$child" > "$1.child"
wait "$child"
printf '%s\n' complete > "$1.done"
"#;

async fn await_event(rx: &mut mpsc::UnboundedReceiver<Value>, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(9), async {
        loop {
            let event = rx.recv().await.expect("session channel still active");
            if event["kind"] == kind {
                return event;
            }
        }
    })
    .await
    .expect("bounded expected event")
}

fn decision(manager: &AcpManager, request: &Value, option: &str) {
    let reply = manager
        .permission_respond_owned(
            request["requestId"].as_str().unwrap(),
            Some(option),
            None,
            Some(&request["owner"]),
        )
        .unwrap();
    assert_eq!(reply.status, "submitted");
}

async fn owned_ids(cwd: &Path, session: &str) -> [i32; 2] {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let ids = ["shell", "child"].map(|role| {
                std::fs::read_to_string(cwd.join(format!("{session}.{role}")))
                    .ok()
                    .and_then(|text| text.trim().parse().ok())
            });
            if let [Some(shell), Some(child)] = ids {
                return [shell, child];
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

fn process_exists(pid: i32) -> bool {
    // Zero checks the owned test PID without sending a termination signal.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[tokio::test(flavor = "multi_thread")]
async fn delegated_command_cancel_keeps_the_sibling_and_blocks_late_creation() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let peer = cwd.join("peer.py");
    std::fs::write(&peer, PEER).unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let mut manager = AcpManager::new(cwd.join("logs"), cwd.clone());
    manager.test_tool_terminal = true;
    let manager = Arc::new(manager);
    let _cleanup = Cleanup(manager.clone());
    let row = AgentRow {
        id: "terminal-fixture".into(),
        name: "Delegating fixture".into(),
        source: "custom".into(),
        command: crate::platform_tests::python(),
        args: vec!["-u".into(), peer.to_string_lossy().into_owned()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();

    let sessions = ["a", "b", "denied"];
    let mut channels = Vec::new();
    let mut directories = Vec::new();
    for session in sessions {
        let directory = cwd.join(session);
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("owned.sh"), OWNED_COMMAND).unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let sink: SessionSink = Arc::new(move |value| {
            let _ = tx.send(value);
        });
        let opened = manager
            .open_session(&row, &directory, None, vec![], sink, &store)
            .await
            .unwrap();
        assert_eq!(opened.session_id, session);
        directories.push(directory);
        channels.push(rx);
    }
    for (session, directory) in sessions[..2].iter().copied().zip(&directories) {
        manager
            .session_prompt(
                &row.id,
                directory,
                session,
                serde_json::from_value(json!([{"type":"text","text":"fixture"}])).unwrap(),
            )
            .await
            .unwrap();
    }
    for ((session, directory), rx) in sessions[..2]
        .iter()
        .copied()
        .zip(&directories)
        .zip(&mut channels)
    {
        let request = await_event(rx, "permissionRequest").await;
        assert!(request["toolCall"].is_null());
        assert_eq!(request["terminalCommand"]["args"][1], session);
        assert_eq!(request["terminalCommand"]["cwd"], json!(directory));
        assert!(!directory.join(format!("{session}.shell")).exists());
        decision(&manager, &request, "allow_once");
    }
    let a = owned_ids(&directories[0], "a").await;
    let b = owned_ids(&directories[1], "b").await;
    assert!(a.iter().chain(&b).copied().all(process_exists));
    manager
        .session_cancel(&row.id, &directories[0], "a")
        .await
        .unwrap();
    let stopped = await_event(&mut channels[0], "turnEnd").await;
    assert_eq!(stopped["stopReason"], "cancelled");
    assert!(!a.into_iter().any(process_exists));
    assert!(b.into_iter().all(process_exists));
    assert!(!directories[0].join("a.done").exists());
    assert_eq!(
        await_event(&mut channels[1], "turnEnd").await["stopReason"],
        "end_turn"
    );
    assert!(directories[1].join("b.done").is_file());
    manager
        .session_prompt(
            &row.id,
            &directories[2],
            "denied",
            serde_json::from_value(json!([{"type":"text","text":"fixture"}])).unwrap(),
        )
        .await
        .unwrap();
    let request = await_event(&mut channels[2], "permissionRequest").await;
    assert!(!directories[2].join("denied.shell").exists());
    decision(&manager, &request, "reject_once");
    assert_eq!(
        await_event(&mut channels[2], "turnEnd").await["stopReason"],
        "end_turn"
    );
    assert!(!directories[2].join("denied.shell").exists());
    while let Ok(event) = channels[0].try_recv() {
        assert_ne!(event["kind"], "permissionRequest");
    }
}
