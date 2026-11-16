use super::*;

fn take_usage(f: &Fixture, count: usize) -> Vec<Value> {
    let mut values = Vec::new();
    while values.len() < count {
        let value = f.events.recv_timeout(Duration::from_secs(5)).unwrap();
        if value
            .pointer("/params/update/sessionUpdate")
            .and_then(Value::as_str)
            == Some("message_usage")
        {
            values.push(value);
        }
    }
    values
}

#[tokio::test(flavor = "multi_thread")]
async fn message_usage_real_fifo_and_two_connections_keep_message_metadata_without_work_or_writes()
{
    let (a, ca) = Fixture::open_with_usage("usage-a", true, true).await;
    let (b, cb) = Fixture::open_with_usage("usage-b", true, true).await;
    let _ = tokio::join!(a.read(&ca, "usage-a"), b.read(&cb, "usage-b"));
    for (f, c, native) in [(&a, &ca, "usage-a"), (&b, &cb, "usage-b")] {
        let values = take_usage(f, 3);
        assert!(values.iter().all(|v| v["params"]["sessionId"] == native));
        assert!(
            values
                .iter()
                .all(|v| v["presentation"]["connectionId"] == c.connection_id)
        );
        assert_eq!(
            values[0]["presentation"]["usage"]["messageId"],
            "exact-message"
        );
        assert_eq!(values[0]["presentation"]["usage"]["totalTokens"], 40);
        assert_eq!(values[0]["presentation"]["usage"]["isCompaction"], true);
        assert_eq!(
            values[0]["params"]["update"]["unknown"]["raw"],
            "RAW_USAGE_CANARY"
        );
        assert!(
            !values[0]["presentation"]
                .to_string()
                .contains("RAW_USAGE_CANARY")
        );
        assert_eq!(values[1]["presentation"]["usage"]["inputTokens"], 0);
        assert!(values[1]["presentation"]["usage"]["messageId"].is_null());
        assert!(values[1]["presentation"]["usage"]["outputTokens"].is_null());
        assert!(values[2]["presentation"]["usage"].is_null());
        assert_eq!(values[2]["params"]["update"]["usage"]["totalTokens"], -1);
        assert_eq!(
            f.trace()
                .iter()
                .map(|v| v["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["initialize", "session/new", "_goose/unstable/tools/list"]
        );
        assert!(f.store.list_sessions().unwrap().is_empty());
        assert!(
            c.life.work().is_ok(),
            "isCompaction metadata creates no unfinished work"
        );
    }
    assert_ne!(ca.connection_id, cb.connection_id);
}

#[tokio::test(flavor = "multi_thread")]
async fn message_usage_unsupported_source_stays_raw_and_has_no_initialize_opt_in() {
    let (f, c) = Fixture::open_with_usage("usage-custom", false, true).await;
    f.read(&c, "usage-custom").await;
    let values = take_usage(&f, 3);
    assert!(values.iter().all(|v| v.get("presentation").is_none()));
    assert!(
        f.trace()[0]["params"]["clientCapabilities"]["_meta"]
            .get("goose")
            .is_none()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn message_usage_original_public_load_prefix_preserves_usage_but_live_status_remains_null() {
    let (f, _) = Fixture::open("usage-load", true).await;
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
            .open_session(&row, &cwd, Some("usage-load".into()), vec![], sink, &store)
            .await
    });
    let status = loop {
        let value = f.events.recv_timeout(Duration::from_secs(5)).unwrap();
        if value
            .pointer("/params/update/sessionUpdate")
            .and_then(Value::as_str)
            == Some("status_message")
        {
            break value;
        }
    };
    assert_eq!(
        status["presentation"],
        json!({"kind":"liveStatus","status":null})
    );
    let usage = take_usage(&f, 1).pop().unwrap();
    assert_eq!(
        usage["presentation"]["usage"]["messageId"],
        "history-message"
    );
    assert_eq!(usage["presentation"]["usage"]["inputTokens"], 5);
    assert_eq!(usage["presentation"]["usage"]["isCompaction"], false);
    assert_eq!(usage["params"]["_meta"], json!({"history":"retained"}));
    std::fs::write(f.cwd.join("release-load"), "").unwrap();
    let opened = loading.await.unwrap().unwrap();
    assert_eq!(usage["presentation"]["connectionId"], opened.connection_id);
    assert_eq!(
        f.trace()
            .iter()
            .map(|v| v["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["initialize", "session/new", "initialize", "session/load"]
    );
    assert!(f.store.list_sessions().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn message_usage_preview_replaced_actor_retired_opening_and_foreign_route_cannot_claim_usage()
{
    let (f, c) = Fixture::open("usage-owned", true).await;
    let mut owner = Owner::bind(
        true,
        &c.connection_id,
        c.state.clone(),
        "usage-owned",
        &c.sessions,
    );
    let params = json!({"sessionId":"usage-owned","update":{"sessionUpdate":"message_usage","messageId":"kept","usage":{"inputTokens":3}}});
    let deliver = |owner: &Owner, params: &Value, method: &str| {
        notification(UntypedMessage::new(method, params).unwrap(), owner)
    };
    // During the already registered actor's opening, metadata is replayable;
    // the independent liveStatus display gate is still false.
    assert_eq!(
        deliver(&owner, &params, METHOD)["presentation"]["usage"]["inputTokens"],
        3
    );
    for purpose in [
        crate::acp_client::open_purpose::OpenPurpose::ImportPreview,
        crate::acp_client::open_purpose::OpenPurpose::SearchReadOnly,
    ] {
        c.sessions
            .lock()
            .unwrap()
            .get_mut("usage-owned")
            .unwrap()
            .purpose = purpose;
        assert!(deliver(&owner, &params, METHOD)["presentation"]["usage"].is_null());
    }
    c.sessions
        .lock()
        .unwrap()
        .get_mut("usage-owned")
        .unwrap()
        .purpose = crate::acp_client::open_purpose::OpenPurpose::Conversation;
    c.sessions
        .lock()
        .unwrap()
        .get_mut("usage-owned")
        .unwrap()
        .preview_token = Some("preview".into());
    assert!(deliver(&owner, &params, METHOD)["presentation"]["usage"].is_null());
    c.sessions
        .lock()
        .unwrap()
        .get_mut("usage-owned")
        .unwrap()
        .preview_token = None;
    let mut foreign = params.clone();
    foreign["sessionId"] = json!("other-session");
    assert!(
        deliver(&owner, &foreign, METHOD)
            .get("presentation")
            .is_none()
    );
    assert!(
        deliver(&owner, &params, "session/update")
            .get("presentation")
            .is_none()
    );
    let (replacement, _rx) = tokio::sync::mpsc::unbounded_channel();
    c.sessions
        .lock()
        .unwrap()
        .get_mut("usage-owned")
        .unwrap()
        .control = replacement;
    assert!(deliver(&owner, &params, METHOD)["presentation"]["usage"].is_null());
    // The opening observer loses its authority as soon as its real owner does.
    let operation = crate::acp_client::operations::Operation::new();
    owner.routes = Weak::new();
    owner.control = None;
    owner.opening = Some(operation.observer());
    assert_eq!(
        deliver(&owner, &params, METHOD)["presentation"]["usage"]["inputTokens"],
        3
    );
    operation.abandon();
    assert!(deliver(&owner, &params, METHOD)["presentation"]["usage"].is_null());
    assert_eq!(f.trace().len(), 2);
}
