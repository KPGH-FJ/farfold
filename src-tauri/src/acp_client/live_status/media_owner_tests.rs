//! Media-only ownership, using production callbacks and controlled routes.
//! No real Agent, model, user history, or image decoder is used.
use super::*;
use crate::acp_client::{
    elicitation::ConnectionElicitations, lifecycle::ConnectionLife, open_purpose::OpenPurpose,
    operations::Operation,
};

const NATIVE: &str = "preview-media";

fn raw() -> Value {
    json!({"sessionId":NATIVE,"futureRoot":true,"update":{
        "sessionUpdate":"tool_call","toolCallId":"exact-media","status":"completed",
        "_meta":{"tool_name":"public-tool","effect_kind":"tool"},
        "rawOutput":{"type":"success","content":[{"type":"image","mimeType":"image/png","data":"QUJD"}]}
    }})
}

fn ops() -> SessionOps {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let forms = Default::default();
    SessionOps {
        configuration_dialect: Default::default(),
        live_status_enabled: true,
        tool_media_enabled: true,
        history_supplement_source: None,
        session_tools: crate::acp_client::session_tools::Availability::unavailable(),
        workspace_access: crate::acp_client::workspace_access::Availability::new(None),
        async_tasks_supported: Arc::new(AtomicBool::new(false)),
        opening: None,
        connection_id: "preview-connection".into(),
        verify_identity: Arc::new(|_, _| Ok(None)),
        elicitations: forms,
        inquiries: ConnectionElicitations::new(
            Default::default(),
            life.clone(),
            "preview-connection".into(),
        ),
        life,
        prompt_escrow: Default::default(),
    }
}

fn media_only(owner: &Owner) {
    assert!(!owner.route_owner());
    assert!(!owner.metadata_owner());
    owner.set_display_allowed(true);
    assert!(!owner.current());
    let params = json!({"sessionId":NATIVE,"update":{"sessionUpdate":"message_usage","messageId":"owned","usage":{"inputTokens":3}}});
    assert!(
        notification(UntypedMessage::new(METHOD, params).unwrap(), owner)["presentation"]["usage"]
            .is_null()
    );
    let params = json!({"sessionId":NATIVE,"update":{"sessionUpdate":"usage_update","used":1,"contextLimit":100,"accumulatedInputTokens":2,"accumulatedOutputTokens":1}});
    assert!(
        notification(UntypedMessage::new(METHOD, params).unwrap(), owner)
            .get("presentation")
            .is_none()
    );
    let params = json!({"sessionId":NATIVE,"update":{"sessionUpdate":"status_message","status":{"type":"notice","message":"live only"}}});
    assert!(
        notification(UntypedMessage::new(METHOD, params).unwrap(), owner)["presentation"]["status"]
            .is_null()
    );
    let params = json!({"sessionId":NATIVE,"update":{"sessionUpdate":"agent_message_chunk","messageId":"owned","content":{"type":"text","text":"retained"},"_meta":{"goose":{"messageId":"owned","created":42}}}});
    assert!(
        crate::acp_client::session_fork::point::present(params.clone(), "source", NATIVE, true)
            .get("presentation")
            .is_some()
    );
    assert_eq!(history_point(params.clone(), owner), params);
}

#[test]
fn preview_media_loading_both_purposes_preserve_raw_then_adjacent_media_without_other_authority() {
    let ops = ops();
    for purpose in [OpenPurpose::ImportPreview, OpenPurpose::SearchReadOnly] {
        let operation = Operation::new();
        let owner = Owner::loading(&ops, NATIVE, purpose, Some("exact-preview"), &operation);
        media_only(&owner);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let sink: super::super::super::pump::SessionSink =
            Arc::new(move |value| captured.lock().unwrap().push(value));
        forward_update(raw(), &owner, &sink);
        let values = events.lock().unwrap();
        assert_eq!(values[0], raw());
        assert_eq!(values.len(), 2, "{purpose:?} lost the media supplement");
        assert_eq!(values[1]["kind"], "toolMedia");
        assert_eq!(values[1]["connectionId"], ops.connection_id);
    }
}

#[test]
fn preview_media_loading_cancel_inactive_unsupported_and_invalid_combinations_are_rejected() {
    let mut ops = ops();
    let operation = Operation::new();
    assert!(tool_media(&raw(), &Owner::inactive(&ops, NATIVE)).is_none());
    for (purpose, token) in [
        (OpenPurpose::ImportPreview, None),
        (OpenPurpose::ImportPreview, Some("")),
        (OpenPurpose::SearchReadOnly, None),
        (OpenPurpose::SearchReadOnly, Some("")),
        (OpenPurpose::Conversation, Some("unexpected")),
    ] {
        let owner = Owner::loading(&ops, NATIVE, purpose, token, &operation);
        assert!(tool_media(&raw(), &owner).is_none());
    }
    let conversation = Owner::loading(&ops, NATIVE, OpenPurpose::Conversation, None, &operation);
    assert!(tool_media(&raw(), &conversation).is_some());
    for purpose in [OpenPurpose::ImportPreview, OpenPurpose::SearchReadOnly] {
        let operation = Operation::new();
        let owner = Owner::loading(&ops, NATIVE, purpose, Some("owned"), &operation);
        operation.abandon();
        assert!(tool_media(&raw(), &owner).is_none());
    }
    ops.tool_media_enabled = false;
    let owner = Owner::loading(
        &ops,
        NATIVE,
        OpenPurpose::ImportPreview,
        Some("owned"),
        &operation,
    );
    assert!(tool_media(&raw(), &owner).is_none());
    ops.tool_media_enabled = true;
    let owner = Owner::loading(
        &ops,
        NATIVE,
        OpenPurpose::SearchReadOnly,
        Some("owned"),
        &operation,
    );
    ops.life.state.store(0, Ordering::SeqCst);
    assert!(tool_media(&raw(), &owner).is_none());
}

#[test]
fn preview_media_raw_callback_abandonment_prevents_the_adjacent_supplement() {
    for purpose in [OpenPurpose::ImportPreview, OpenPurpose::SearchReadOnly] {
        let operation = Operation::new();
        let owner = Owner::loading(&ops(), NATIVE, purpose, Some("owned"), &operation);
        assert!(tool_media(&raw(), &owner).is_some());
        let values = Arc::new(Mutex::new(Vec::new()));
        let recorded = values.clone();
        let sink: super::super::super::pump::SessionSink = Arc::new(move |value| {
            recorded.lock().unwrap().push(value);
            operation.abandon();
        });
        forward_update(raw(), &owner, &sink);
        assert_eq!(*values.lock().unwrap(), vec![raw()]);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn preview_media_registered_owner_keeps_exact_purpose_token_channel_and_ready_connection() {
    let (f, c) = Fixture::open(NATIVE, true).await;
    for purpose in [OpenPurpose::ImportPreview, OpenPurpose::SearchReadOnly] {
        let original_control = c
            .sessions
            .lock()
            .unwrap()
            .get(NATIVE)
            .unwrap()
            .control
            .clone();
        {
            let mut entries = c.sessions.lock().unwrap();
            let entry = entries.get_mut(NATIVE).unwrap();
            entry.purpose = purpose;
            entry.preview_token = Some("exact-preview".into());
        }
        let mut owner = Owner::bind(true, &c.connection_id, c.state.clone(), NATIVE, &c.sessions);
        owner.tool_media_enabled = true;
        media_only(&owner);
        assert!(tool_media(&raw(), &owner).is_some());
        let mut foreign_session = raw();
        foreign_session["sessionId"] = json!("different-native");
        assert!(tool_media(&foreign_session, &owner).is_none());
        c.state.store(0, Ordering::SeqCst);
        assert!(tool_media(&raw(), &owner).is_none());
        c.state.store(STATE_READY, Ordering::SeqCst);
        c.sessions
            .lock()
            .unwrap()
            .get_mut(NATIVE)
            .unwrap()
            .preview_token = Some("replacement".into());
        assert!(tool_media(&raw(), &owner).is_none());
        {
            let mut entries = c.sessions.lock().unwrap();
            let entry = entries.get_mut(NATIVE).unwrap();
            entry.preview_token = Some("exact-preview".into());
            entry.purpose = if purpose == OpenPurpose::ImportPreview {
                OpenPurpose::SearchReadOnly
            } else {
                OpenPurpose::ImportPreview
            };
        }
        assert!(tool_media(&raw(), &owner).is_none());
        c.sessions.lock().unwrap().get_mut(NATIVE).unwrap().purpose = purpose;
        let foreign = Owner::bind(
            true,
            "other-connection",
            c.state.clone(),
            NATIVE,
            &c.sessions,
        );
        let mut foreign = foreign;
        foreign.tool_media_enabled = true;
        assert!(tool_media(&raw(), &foreign).is_none());
        let values = Arc::new(Mutex::new(Vec::new()));
        let recorded = values.clone();
        let routes = c.sessions.clone();
        let (replacement, _receiver) = tokio::sync::mpsc::unbounded_channel();
        let sink: super::super::super::pump::SessionSink = Arc::new(move |value| {
            recorded.lock().unwrap().push(value);
            routes.lock().unwrap().get_mut(NATIVE).unwrap().control = replacement.clone();
        });
        forward_update(raw(), &owner, &sink);
        assert_eq!(*values.lock().unwrap(), vec![raw()]);
        c.sessions.lock().unwrap().get_mut(NATIVE).unwrap().control = original_control;
    }
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn preview_media_late_registration_and_invalid_bound_scope_cannot_gain_authority() {
    let (f, c) = Fixture::open(NATIVE, true).await;
    let entry = c.sessions.lock().unwrap().remove(NATIVE).unwrap();
    let mut absent = Owner::bind(true, &c.connection_id, c.state.clone(), NATIVE, &c.sessions);
    absent.tool_media_enabled = true;
    c.sessions.lock().unwrap().insert(NATIVE.into(), entry);
    assert!(tool_media(&raw(), &absent).is_none());
    for (purpose, token) in [
        (OpenPurpose::ImportPreview, None),
        (OpenPurpose::SearchReadOnly, Some("")),
        (OpenPurpose::Conversation, Some("unexpected")),
    ] {
        {
            let mut entries = c.sessions.lock().unwrap();
            let entry = entries.get_mut(NATIVE).unwrap();
            entry.purpose = purpose;
            entry.preview_token = token.map(str::to_owned);
        }
        let mut owner = Owner::bind(true, &c.connection_id, c.state.clone(), NATIVE, &c.sessions);
        owner.tool_media_enabled = true;
        assert!(tool_media(&raw(), &owner).is_none());
        // Fixing an invalid binding later cannot give that old observer a
        // new route, even if the entry's sender itself remains unchanged.
        {
            let mut entries = c.sessions.lock().unwrap();
            let entry = entries.get_mut(NATIVE).unwrap();
            entry.purpose = OpenPurpose::Conversation;
            entry.preview_token = None;
        }
        assert!(tool_media(&raw(), &owner).is_none());
    }
    let original = c
        .sessions
        .lock()
        .unwrap()
        .get(NATIVE)
        .unwrap()
        .control
        .clone();
    let (closed, receive) = tokio::sync::mpsc::unbounded_channel();
    drop(receive);
    {
        let mut entries = c.sessions.lock().unwrap();
        let entry = entries.get_mut(NATIVE).unwrap();
        entry.purpose = OpenPurpose::ImportPreview;
        entry.preview_token = Some("exact".into());
        entry.control = closed;
    }
    let mut owner = Owner::bind(true, &c.connection_id, c.state.clone(), NATIVE, &c.sessions);
    owner.tool_media_enabled = true;
    assert!(tool_media(&raw(), &owner).is_none());
    c.sessions.lock().unwrap().get_mut(NATIVE).unwrap().control = original;
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

const PREVIEW_PEER: &str = r#"#!/usr/bin/env python3
import json,sys,pathlib,threading,time
lock=threading.Lock()
def send(value):
 with lock: print(json.dumps(value,separators=(',',':')),flush=True)
def event(session,call):
 send({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session,'futureRoot':True,'update':{
  'sessionUpdate':'tool_call','toolCallId':call,'status':'completed',
  '_meta':{'tool_name':'public-tool','effect_kind':'tool'},
  'rawOutput':{'type':'success','content':[{'type':'image','mimeType':'image/png','data':'QUJD'}]}}}})
def late(session):
 while not pathlib.Path('emit-late').exists(): time.sleep(.002)
 event(session,'registered-media')
for line in sys.stdin:
 m=json.loads(line);method=m.get('method');p=m.get('params',{})
 with pathlib.Path('preview-trace.jsonl').open('a') as f: f.write(json.dumps({'method':method})+'\n')
 if method=='initialize':r={'protocolVersion':1,'agentInfo':{'name':'controlled-media-peer','version':'unrestricted'},'agentCapabilities':{'loadSession':True},'authMethods':[]}
 elif method=='session/load':
  event(p['sessionId'],'loading-media');r={'configOptions':[]}
  threading.Thread(target=late,args=(p['sessionId'],),daemon=True).start()
 elif method=='session/close':r={}
 else:
  if 'id' in m:send({'jsonrpc':'2.0','id':m['id'],'error':{'code':-32601,'message':'unsupported'}})
  continue
 send({'jsonrpc':'2.0','id':m['id'],'result':r})
"#;

async fn preview_wire(purpose: OpenPurpose) {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let program = crate::platform_tests::python_peer(&cwd, "vibe-acp", PREVIEW_PEER);
    let row = AgentRow {
        id: "registry:mistral-vibe".into(),
        name: "Controlled preview peer".into(),
        source: "registry".into(),
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
    let sink: crate::acp_client::pump::SessionSink = Arc::new(move |value| {
        let _ = tx.send(value);
    });
    let opened = manager
        .open_session_owned_for_purpose(
            &row,
            &cwd,
            Some(NATIVE.into()),
            vec![],
            sink,
            &store,
            None,
            Some("exact-preview".into()),
            purpose,
            None,
            None,
        )
        .await
        .unwrap();
    // Let registered-actor dispatch run only after open acknowledged its load.
    std::fs::write(cwd.join("emit-late"), "owned").unwrap();
    let rejected_prompt = manager.session_prompt(&row.id, &cwd, NATIVE, vec![]).await;
    let rejected_config = manager
        .session_set_config(&row.id, &cwd, NATIVE, "model", json!("never-dispatched"))
        .await;
    let mut values = Vec::new();
    while values.len() < 4 {
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(value) if value.get("update").is_some() || value["kind"] == "toolMedia" => {
                values.push(value)
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    manager.disconnect(&row.id, &cwd).await.unwrap();
    assert!(rejected_prompt.is_err() && rejected_config.is_err());
    let calls: Vec<Value> = std::fs::read_to_string(cwd.join("preview-trace.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        calls,
        vec![
            json!({"method":"initialize"}),
            json!({"method":"_auth/status"}),
            json!({"method":"session/load"}),
        ]
    );
    assert!(store.list_sessions().unwrap().is_empty());
    assert_eq!(
        values.len(),
        4,
        "{purpose:?} must deliver both raw/supplement pairs"
    );
    for (pair, call) in values
        .chunks_exact(2)
        .zip(["loading-media", "registered-media"])
    {
        assert_eq!(pair[0]["update"]["toolCallId"], call);
        assert_eq!(pair[0]["futureRoot"], true);
        assert!(pair[0].get("presentation").is_none());
        assert_eq!(pair[1]["kind"], "toolMedia");
        assert_eq!(pair[1]["toolCallId"], call);
        assert_eq!(pair[1]["connectionId"], opened.connection_id);
        assert_eq!(pair[1]["sessionId"], NATIVE);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn preview_media_import_actual_load_and_registered_dispatch_keep_read_only_admission() {
    preview_wire(OpenPurpose::ImportPreview).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn preview_media_search_actual_load_and_registered_dispatch_keep_read_only_admission() {
    preview_wire(OpenPurpose::SearchReadOnly).await;
}
