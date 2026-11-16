//! The real conversation actor, exact SQLite row, no Agent mutation on recovery.
use super::*;
use crate::acp_client::session_index::touch_session_row;
use crate::meta_store::AgentRow;
use std::sync::Arc;

const PEER: &str = r#"
import json, sys
def send(message): print(json.dumps(dict(jsonrpc='2.0', **message)), flush=True)
for line in sys.stdin:
    msg = json.loads(line)
    method = msg['method']
    p = msg.get('params', {})
    with open('wire', 'a') as log: log.write(method + ':' + p.get('sessionId', '') + '\n')
    if method == 'initialize':
        result = {'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]}
    elif method == 'session/load':
        sid = p['sessionId']
        if sid != 'empty':
            send({'method':'session/update','params':{'sessionId':sid,'update':{'sessionUpdate':'user_message_chunk','content':{'type':'text','text':'Original message'}}}})
        result = {'configOptions':[
            {'id':'model','name':'Model','category':'model','type':'select','currentValue':'provider/m','options':[{'value':'provider/m','name':'M'}]},
            {'id':'thought_level','name':'Thinking','category':'thought_level','type':'select','currentValue':'medium','options':[{'value':'medium','name':'Medium'}]},
        ]}
    else:
        raise AssertionError(method)
    send({'id':msg['id'],'result':result})
"#;

async fn request_actor(
    manager: &AcpManager,
    agent: &str,
    cwd: &std::path::Path,
    native: &str,
    connection: &str,
    request: Request,
) -> Result<Value, String> {
    let (result, reply) = oneshot::channel();
    manager
        .session_control_tx(agent, cwd, native)
        .unwrap()
        .send(SessionControl::OriginalConfig {
            connection_id: connection.into(),
            request,
            deadline: Instant::now() + BUDGET,
            result,
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), reply)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn original_config_actor_verifies_exact_replay_and_saves_once_without_setting_or_sending() {
    let directory = tempfile::tempdir().unwrap();
    let cwd = directory.path().canonicalize().unwrap();
    let script = cwd.join("peer.py");
    std::fs::write(&script, PEER).unwrap();
    let store = MetaStore::open(&cwd.join("metadata.db")).unwrap();
    let agent = AgentRow {
        id: "original-config-fixture".into(),
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
    let mut original_meta = None;
    let mut saved_connection = None;
    for native in ["empty", "recorded"] {
        let row = touch_session_row(
            &store,
            &agent.id,
            &cwd.to_string_lossy(),
            native,
            Some("Original".into()),
            None,
        )
        .unwrap();
        let opened = manager
            .open_session(
                &agent,
                &cwd,
                Some(native.into()),
                vec![],
                Arc::new(|_| {}),
                &store,
            )
            .await
            .unwrap();
        let review = request_actor(
            &manager,
            &agent.id,
            &cwd,
            native,
            &opened.connection_id,
            Request::Review { backup: None },
        )
        .await;
        if native == "empty" {
            assert!(review.is_err());
            assert!(
                store
                    .get_session(&row.id)
                    .unwrap()
                    .unwrap()
                    .config_options
                    .is_none()
            );
            manager.disconnect(&agent.id, &cwd).await.unwrap();
            continue;
        }
        let review = review.unwrap();
        assert_eq!(review["source"], "attestation");
        assert_eq!(review["choices"][1]["value"], "medium");
        assert!(
            store
                .get_session(&row.id)
                .unwrap()
                .unwrap()
                .config_options
                .is_none()
        );
        let id = review["reviewId"].as_str().unwrap().to_owned();
        let confirm = request_actor(
            &manager,
            &agent.id,
            &cwd,
            native,
            &opened.connection_id,
            Request::Confirm {
                review_id: id.clone(),
            },
        )
        .await
        .unwrap();
        assert_eq!(confirm["status"], "ready");
        assert_eq!(confirm["configuration"]["configOptionsModern"], true);
        assert!(
            request_actor(
                &manager,
                &agent.id,
                &cwd,
                native,
                &opened.connection_id,
                Request::Confirm { review_id: id }
            )
            .await
            .is_err()
        );
        let saved = store.get_session(&row.id).unwrap().unwrap();
        assert_eq!(saved.created_at, row.created_at);
        assert_eq!(saved.title, row.title);
        assert_eq!(
            saved.config_options.unwrap()["_farfoldService"],
            json!({"kind":"existing"})
        );
        original_meta = Some(row.id);
        saved_connection = Some(opened.connection_id);
        manager.disconnect(&agent.id, &cwd).await.unwrap();
    }
    let reopened = manager
        .open_session(
            &agent,
            &cwd,
            Some("recorded".into()),
            vec![],
            Arc::new(|_| {}),
            &store,
        )
        .await
        .unwrap();
    assert_eq!(reopened.config_check.status, "ready");
    assert_ne!(Some(reopened.connection_id), saved_connection);
    assert!(
        store
            .get_session(&original_meta.unwrap())
            .unwrap()
            .is_some()
    );
    let wire = std::fs::read_to_string(cwd.join("wire")).unwrap();
    assert_eq!(
        wire.lines()
            .filter(|line| *line == "session/load:recorded")
            .count(),
        2
    );
    assert!(!wire.contains("session/new"));
    assert!(!wire.contains("session/set_config_option"));
    assert!(!wire.contains("session/prompt"));
    manager.stop_for_shutdown();
}
