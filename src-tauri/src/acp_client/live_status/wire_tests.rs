//! Actual controlled stdio/router/actor tests. No real Agent or model calls.
use super::*;
use crate::{
    acp_client::manager::{AcpManager, ManagedConnection},
    meta_store::{AgentRow, MetaStore},
};
use std::{path::PathBuf, sync::mpsc, time::Duration};

struct Fixture {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    store: MetaStore,
    row: AgentRow,
    manager: Arc<AcpManager>,
    sink: super::super::pump::SessionSink,
    events: mpsc::Receiver<Value>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
impl Fixture {
    async fn open(native: &str, reviewed: bool) -> (Self, ManagedConnection) {
        Self::open_with_usage(native, reviewed, false).await
    }
    async fn open_with_usage(
        native: &str,
        reviewed: bool,
        usage: bool,
    ) -> (Self, ManagedConnection) {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let body = include_str!("../session_tools/peer.py").replace("owned-tools", native);
        let insertion = r#"        for update in [
            {"sessionUpdate":"status_message","status":{"type":"notice","message":"first\nsecond\r\ttail"},"unknown":{"preserved":[1,2,3]}},
            {"sessionUpdate":"status_message","status":{"type":"progress","message":"Compaction complete is only literal text"}},
            {"sessionUpdate":"status_message","status":{"type":"notice","message":"bad\u0000"}},
            {"sessionUpdate":"future_variant","status":{"type":"notice","message":"future"}},
        ]:
            send({"method":"_goose/unstable/session/update","params":{"sessionId":message["params"]["sessionId"],"update":update,"_meta":{"future":"FUTURE_FIELD_CANARY"}}})
        if pathlib.Path("spoof").exists():
            send({"method":"session/update","params":{"sessionId":message["params"]["sessionId"],"kind":"notification","method":"_goose/unstable/session/update","params":{"sessionId":message["params"]["sessionId"],"update":{"sessionUpdate":"status_message","status":{"type":"notice","message":"spoof"}}}}})
"#;
        let marker = "        threading.Thread(target=tools, args=(message,), daemon=True).start()";
        assert_eq!(body.matches(marker).count(), 1);
        let body = body.replace(marker, &format!("{insertion}{marker}"));
        let body = if usage {
            let updates = r#"        for update in [
            {"sessionUpdate":"message_usage","messageId":"exact-message","usage":{"inputTokens":7,"outputTokens":2,"totalTokens":40,"cost":0.25,"costSource":"estimated","elapsedMs":120,"timeToFirstTokenMs":0,"isCompaction":True},"unknown":{"raw":"RAW_USAGE_CANARY"}},
            {"sessionUpdate":"message_usage","messageId":None,"usage":{"inputTokens":0}},
            {"sessionUpdate":"message_usage","messageId":"invalid","usage":{"totalTokens":-1}},
        ]:
            send({"method":"_goose/unstable/session/update","params":{"sessionId":message["params"]["sessionId"],"update":update,"_meta":{"exact":"retained"}}})
"#;
            body.replace(marker, &format!("{updates}{marker}"))
        } else {
            body
        };
        let body = body.replace(
            "\"agentCapabilities\": {}",
            "\"agentCapabilities\": {\"loadSession\": True}",
        );
        let marker = "    elif method == \"_goose/unstable/tools/list\":";
        let loading = r#"    elif method == "session/load":
        send({"method":"_goose/unstable/session/update","params":{"sessionId":message["params"]["sessionId"],"update":{"sessionUpdate":"status_message","status":{"type":"notice","message":"opening status is live-only"}},"_meta":{"future":"retained"}}})
        send({"method":"_goose/unstable/session/update","params":{"sessionId":message["params"]["sessionId"],"update":{"sessionUpdate":"message_usage","messageId":"history-message","usage":{"inputTokens":5,"isCompaction":False}},"_meta":{"history":"retained"}}})
        while not pathlib.Path("release-load").exists():
            time.sleep(0.005)
        reply(message, {"configOptions": []})
"#;
        assert_eq!(body.matches(marker).count(), 1);
        let body = body.replace(marker, &format!("{loading}{marker}"));
        let program = crate::platform_tests::python_peer(&cwd, "goose", &body);
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let row = AgentRow {
            id: "registry:goose".into(),
            name: "Controlled fixture".into(),
            source: if reviewed {
                "registry".into()
            } else {
                "custom".into()
            },
            command: program.to_string_lossy().into(),
            args: vec!["acp".into()],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        let (send, events) = mpsc::channel();
        let sink: super::super::pump::SessionSink = Arc::new(move |v| {
            let _ = send.send(v);
        });
        let opened = manager
            .open_session(&row, &cwd, None, vec![], sink.clone(), &store)
            .await
            .unwrap();
        let connection = manager
            .session_connection(&row.id, &cwd, &opened.session_id)
            .unwrap();
        if !reviewed {
            connection.session_tools.enable_for_test();
        }
        (
            Self {
                _dir: dir,
                cwd,
                store,
                row,
                manager,
                sink,
                events,
            },
            connection,
        )
    }
    async fn read(&self, c: &ManagedConnection, native: &str) {
        self.manager
            .tools_read(
                &self.row.id,
                &self.cwd,
                native,
                &c.connection_id,
                "owned-read",
                None,
            )
            .await
            .unwrap();
    }
    fn notifications(&self) -> Vec<Value> {
        let mut found = Vec::new();
        while found.len() < 4 {
            let value = self.events.recv_timeout(Duration::from_secs(5)).unwrap();
            if value["kind"] == "notification"
                && value["method"] == METHOD
                && value.get("sessionId").is_none()
            {
                found.push(value);
            }
        }
        found
    }
    fn trace(&self) -> Vec<Value> {
        std::fs::read_to_string(self.cwd.join("trace.jsonl"))
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
}

#[path = "media_owner_tests.rs"]
mod media_owner_tests;
#[path = "message_usage_wire_tests.rs"]
mod message_usage_tests;

#[tokio::test(flavor = "multi_thread")]
async fn tool_media_owner_rejects_foreign_preview_replaced_route_and_ended_connection() {
    let (f, c) = Fixture::open("media-owner", true).await;
    // The launch-source gate is covered by tool_media::wire_tests. This test
    // isolates the shared production ownership predicate from Goose enablement.
    let mut owner = Owner::bind(
        false,
        &c.connection_id,
        c.state.clone(),
        "media-owner",
        &c.sessions,
    );
    owner.tool_media_enabled = true;
    let raw = json!({"sessionId":"media-owner","update":{
        "sessionUpdate":"tool_call","toolCallId":"exact","status":"completed",
        "_meta":{"tool_name":"public-tool","effect_kind":"tool"},
        "rawOutput":{"type":"success","content":[{"type":"image","mimeType":"image/png","data":"QUJD"}]}
    }});
    assert_eq!(
        tool_media(&raw, &owner).unwrap()["connectionId"],
        c.connection_id
    );
    let mut foreign = raw.clone();
    foreign["sessionId"] = json!("another-session");
    assert!(tool_media(&foreign, &owner).is_none());
    c.sessions
        .lock()
        .unwrap()
        .get_mut("media-owner")
        .unwrap()
        .preview_token = Some("owned-preview".into());
    assert!(tool_media(&raw, &owner).is_none());
    c.sessions
        .lock()
        .unwrap()
        .get_mut("media-owner")
        .unwrap()
        .preview_token = None;
    let (replacement, _receive) = tokio::sync::mpsc::unbounded_channel();
    c.sessions
        .lock()
        .unwrap()
        .get_mut("media-owner")
        .unwrap()
        .control = replacement;
    assert!(tool_media(&raw, &owner).is_none());
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    assert!(tool_media(&raw, &owner).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn live_status_real_initialize_and_actor_preserve_raw_fifo_without_prompt_or_configuration() {
    let (f, c) = Fixture::open("live-a", true).await;
    f.read(&c, "live-a").await;
    let values = f.notifications();
    assert_eq!(
        f.trace()[0]["params"]["clientCapabilities"]["_meta"]["goose"],
        json!({"customNotifications":true})
    );
    assert_eq!(
        f.trace()
            .iter()
            .map(|v| v["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["initialize", "session/new", "_goose/unstable/tools/list"]
    );
    assert_eq!(
        values
            .iter()
            .map(|v| v["params"]["sessionId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["live-a"; 4]
    );
    assert_eq!(
        values[0]["presentation"]["status"]["message"],
        "first\nsecond\r\ttail"
    );
    assert_eq!(
        values[0]["params"]["update"]["unknown"],
        json!({"preserved":[1,2,3]})
    );
    assert_eq!(
        values[0]["params"]["_meta"],
        json!({"future":"FUTURE_FIELD_CANARY"})
    );
    assert_eq!(values[1]["presentation"]["status"]["type"], "progress");
    assert_eq!(values[2]["presentation"]["status"], Value::Null);
    assert!(values[3].get("presentation").is_none());
    assert!(
        f.store.list_sessions().unwrap().is_empty(),
        "presentation creates no transcript/index"
    );
    assert!(
        c.life.work().is_ok(),
        "status text creates no unfinished work"
    );
    assert_eq!(
        f.manager
            .tools_read(
                &f.row.id,
                &f.cwd,
                "live-a",
                &c.connection_id,
                "after-status",
                None,
            )
            .await
            .unwrap()
            .state,
        crate::acp_client::session_tools::State::Ready
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn live_status_unsupported_route_keeps_the_original_handshake_and_raw_wrapper() {
    let (f, c) = Fixture::open("unsupported", false).await;
    f.read(&c, "unsupported").await;
    assert!(
        f.trace()[0]["params"]["clientCapabilities"]["_meta"]
            .get("goose")
            .is_none()
    );
    let values = f.notifications();
    assert!(values.iter().all(|v| v.get("presentation").is_none()));
    assert_eq!(
        values[0]["params"]["update"]["status"]["message"],
        "first\nsecond\r\ttail"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn live_status_two_current_session_routes_do_not_mix_fifo_or_connection_ownership() {
    let (a, ca) = Fixture::open("live-a", true).await;
    let (b, cb) = Fixture::open("live-b", true).await;
    let _ = tokio::join!(a.read(&ca, "live-a"), b.read(&cb, "live-b"));
    let va = a.notifications();
    let vb = b.notifications();
    assert!(va.iter().all(|v| v["params"]["sessionId"] == "live-a"));
    assert!(vb.iter().all(|v| v["params"]["sessionId"] == "live-b"));
    assert_ne!(ca.connection_id, cb.connection_id);
    for values in [va, vb] {
        assert_eq!(values[0]["presentation"]["status"]["type"], "notice");
        assert_eq!(values[1]["presentation"]["status"]["type"], "progress");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn live_status_old_actor_preview_foreign_session_and_connection_end_cannot_claim_presentation()
 {
    let (f, c) = Fixture::open("live-a", true).await;
    let owner = Owner::bind(
        true,
        &c.connection_id,
        c.state.clone(),
        "live-a",
        &c.sessions,
    );
    let raw = json!({"kind":"notification","method":METHOD,"params":{"sessionId":"live-a","update":{"sessionUpdate":"status_message","status":{"type":"notice","message":"late"}}}});
    assert_eq!(
        notification(UntypedMessage::new(METHOD, &raw["params"]).unwrap(), &owner)["presentation"]
            ["status"],
        Value::Null
    );
    owner.set_display_allowed(true);
    assert_eq!(
        notification(UntypedMessage::new(METHOD, &raw["params"]).unwrap(), &owner)["presentation"]
            ["status"]["message"],
        "late"
    );
    let assert_raw = |value: Value| {
        assert_eq!(
            notification(
                UntypedMessage::new(METHOD, &value["params"]).unwrap(),
                &owner
            ),
            value
        );
    };
    let assert_unshown = |value: Value| {
        let projected = notification(
            UntypedMessage::new(METHOD, &value["params"]).unwrap(),
            &owner,
        );
        assert_eq!(projected["params"], value["params"]);
        assert_eq!(
            projected["presentation"],
            json!({"kind":"liveStatus","status":null})
        );
    };
    let mut foreign = raw.clone();
    foreign["params"]["sessionId"] = json!("foreign");
    assert_raw(foreign);
    c.sessions
        .lock()
        .unwrap()
        .get_mut("live-a")
        .unwrap()
        .preview_token = Some("preview".into());
    assert_unshown(raw.clone());
    c.sessions
        .lock()
        .unwrap()
        .get_mut("live-a")
        .unwrap()
        .preview_token = None;
    let (replacement, _receive) = tokio::sync::mpsc::unbounded_channel();
    c.sessions
        .lock()
        .unwrap()
        .get_mut("live-a")
        .unwrap()
        .control = replacement;
    assert_unshown(raw.clone());
    assert_eq!(f.trace().len(), 2);
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    assert_unshown(raw);
}

#[tokio::test(flavor = "multi_thread")]
async fn live_status_standard_update_cannot_spoof_the_local_notification_presentation() {
    let (f, c) = Fixture::open("live-a", true).await;
    std::fs::write(f.cwd.join("spoof"), "").unwrap();
    f.read(&c, "live-a").await;
    let _ = f.notifications();
    let spoof = loop {
        let v = f.events.recv_timeout(Duration::from_secs(3)).unwrap();
        if v.get("sessionId").is_some() {
            break v;
        }
    };
    assert_eq!(
        spoof,
        json!({"sessionId":"live-a","kind":"notification","method":METHOD,"params":{"sessionId":"live-a","update":{"sessionUpdate":"status_message","status":{"type":"notice","message":"spoof"}}}})
    );
    assert!(spoof.get("presentation").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn live_status_load_prefix_keeps_live_only_classification_without_display_or_history_authority()
 {
    let (f, _) = Fixture::open("load-live", true).await;
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    let (manager, row, cwd, store, sink) = (
        f.manager.clone(),
        f.row.clone(),
        f.cwd.clone(),
        f.store.clone(),
        f.sink.clone(),
    );
    let loading = tokio::spawn(async move {
        manager
            .open_session(&row, &cwd, Some("load-live".into()), vec![], sink, &store)
            .await
    });
    let prefix = loop {
        let value = f.events.recv_timeout(Duration::from_secs(5)).unwrap();
        if value["kind"] == "notification" && value["method"] == METHOD {
            break value;
        }
    };
    assert_eq!(
        prefix["params"]["update"]["status"]["message"],
        "opening status is live-only"
    );
    assert_eq!(prefix["params"]["_meta"], json!({"future":"retained"}));
    assert_eq!(
        prefix["presentation"],
        json!({"kind":"liveStatus","status":null})
    );
    std::fs::write(f.cwd.join("release-load"), "").unwrap();
    assert_eq!(loading.await.unwrap().unwrap().session_id, "load-live");
    assert!(f.store.list_sessions().unwrap().is_empty());
}
