//! The same saved-choice peer exercises Import and Search without real accounts.
use super::*;
use crate::acp_client::{
    open_purpose::OpenPurpose,
    session_discovery::{ImportPreview, open_preview},
};

async fn preview(fixture: &Fixture, purpose: OpenPurpose) -> ImportPreview {
    fixture
        .manager
        .disconnect(&fixture.row.id, &fixture.cwd)
        .await
        .unwrap();
    fixture.events.lock().unwrap().clear();
    let events = fixture.events.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        events.lock().unwrap().push(body.deserialize::<Value>()?);
        Ok(())
    });
    open_preview(
        &fixture.manager,
        &fixture.store,
        &fixture.row,
        &fixture.cwd,
        SESSION.into(),
        "readonly-fixture-token".into(),
        "readonly-fixture-open",
        channel,
        None,
        purpose,
    )
    .await
    .unwrap()
}

fn audit_config_writes(fixture: &Fixture) {
    let sql = rusqlite::Connection::open(fixture.cwd.join("meta.db")).unwrap();
    sql.execute_batch(
        "CREATE TABLE readonly_config_writes (attempt INTEGER);
         CREATE TRIGGER readonly_write_audit AFTER UPDATE OF config_options ON sessions
         BEGIN INSERT INTO readonly_config_writes VALUES (1); END;",
    )
    .unwrap();
}

fn config_writes(fixture: &Fixture) -> i64 {
    let sql = rusqlite::Connection::open(fixture.cwd.join("meta.db")).unwrap();
    sql.query_row("SELECT count(*) FROM readonly_config_writes", [], |row| {
        row.get(0)
    })
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn search_read_preview_never_restores_or_saves_the_saved_choice() {
    let fixture = Fixture::established().await;
    let baseline = fixture.record();
    audit_config_writes(&fixture);
    let read = preview(&fixture, OpenPurpose::SearchReadOnly).await;
    assert_eq!(read.purpose, "searchReadOnly");
    let sets = fixture.restore_sets();
    let writes = config_writes(&fixture);
    assert_eq!(
        (sets, writes),
        (vec![], 0),
        "a read must not repair defaults or confirm and save a baseline"
    );
    assert_ne!(read.session.config_check.status, "ready");
    assert_eq!(read.session.config_options[0]["currentValue"], "m1");
    assert_eq!(fixture.record(), baseline);
    fixture.assert_identity_and_no_prompt();
}

#[tokio::test(flavor = "multi_thread")]
async fn import_preview_keeps_the_existing_saved_choice_restore() {
    let fixture = Fixture::established().await;
    let baseline = fixture.record();
    audit_config_writes(&fixture);
    let imported = preview(&fixture, OpenPurpose::ImportPreview).await;
    assert_eq!(imported.purpose, "importPreview");
    assert_eq!(imported.session.config_check.status, "ready");
    assert_eq!(
        fixture.restore_sets(),
        vec![
            ("model".into(), "m2".into()),
            ("reasoning_effort".into(), "low".into())
        ]
    );
    assert!(
        config_writes(&fixture) > 0,
        "the ordinary restore positive must reach saving"
    );
    assert_eq!(fixture.record(), baseline);
    fixture.assert_identity_and_no_prompt();
}

#[tokio::test(flavor = "multi_thread")]
async fn search_read_preview_direct_actor_config_is_never_dispatched() {
    let fixture = Fixture::established().await;
    // Make the owned saved baseline equal the peer's load response. Rejection
    // must come from read authority, not an incidental changed-model guard.
    let id = session_row_id(&fixture.row.id, &fixture.cwd.to_string_lossy(), SESSION);
    let mut saved = fixture.store.get_session(&id).unwrap().unwrap();
    for choice in saved.config_options.as_mut().unwrap()["choices"]
        .as_array_mut()
        .unwrap()
    {
        if choice["id"] == "model" {
            choice["value"] = json!("m1");
        }
    }
    fixture.store.upsert_session(&saved).unwrap();
    let read = preview(&fixture, OpenPurpose::SearchReadOnly).await;
    assert_eq!(
        read.session.config_check.status, "ready",
        "the baseline was already confirmed, not confirmed by this read"
    );
    // The public entry already rejects previews; also exercise the actual actor.
    assert!(
        fixture
            .manager
            .session_set_config(&fixture.row.id, &fixture.cwd, SESSION, "model", json!("m2"),)
            .await
            .is_err()
    );
    let connection = fixture
        .manager
        .session_connection(&fixture.row.id, &fixture.cwd, SESSION)
        .unwrap();
    let control = connection
        .sessions
        .lock()
        .unwrap()
        .get(SESSION)
        .unwrap()
        .control
        .clone();
    let calls_before = fixture.calls().len();
    let (result, receive) = tokio::sync::oneshot::channel();
    control
        .send(crate::acp_client::pump::SessionControl::SetConfig {
            config_id: "model".into(),
            value: json!("m2"),
            deadline: tokio::time::Instant::now() + Duration::from_secs(5),
            result,
        })
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(5), receive)
        .await
        .unwrap()
        .unwrap();
    assert!(
        outcome.is_err(),
        "a direct actor control must keep read-only authority"
    );
    assert_eq!(
        fixture.calls().len(),
        calls_before,
        "no official setter may be dispatched"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn search_read_preview_keeps_saved_source_validation_before_load() {
    let fixture = Fixture::established().await;
    fixture
        .manager
        .disconnect(&fixture.row.id, &fixture.cwd)
        .await
        .unwrap();
    let id = session_row_id(&fixture.row.id, &fixture.cwd.to_string_lossy(), SESSION);
    let mut saved = fixture.store.get_session(&id).unwrap().unwrap();
    saved.config_options.as_mut().unwrap()["_farfoldService"] =
        json!({"kind":"unrecognized-source"});
    fixture.store.upsert_session(&saved).unwrap();
    let calls_before = fixture.calls().len();
    let channel = tauri::ipc::Channel::new(|body| {
        let _ = body.deserialize::<Value>()?;
        Ok(())
    });
    let read = open_preview(
        &fixture.manager,
        &fixture.store,
        &fixture.row,
        &fixture.cwd,
        SESSION.into(),
        "changed-source-read".into(),
        "changed-source-open",
        channel,
        None,
        OpenPurpose::SearchReadOnly,
    )
    .await;
    assert!(
        read.is_err(),
        "a read cannot replace an unrecognized saved source"
    );
    assert_eq!(
        fixture.calls().len(),
        calls_before,
        "source rejection must precede load"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn search_read_preview_direct_actor_mode_and_delete_do_not_dispatch() {
    use crate::acp_client::pump::SessionControl;
    let fixture = Fixture::established().await;
    let baseline = fixture.record();
    let _read = preview(&fixture, OpenPurpose::SearchReadOnly).await;
    let connection = fixture
        .manager
        .session_connection(&fixture.row.id, &fixture.cwd, SESSION)
        .unwrap();
    let control = connection
        .sessions
        .lock()
        .unwrap()
        .get(SESSION)
        .unwrap()
        .control
        .clone();
    let calls_before = fixture.calls().len();
    for action in ["mode", "delete"] {
        let (result, receive) = tokio::sync::oneshot::channel();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let command = if action == "mode" {
            SessionControl::SetMode {
                mode_id: "fixture-mode".into(),
                deadline,
                result,
            }
        } else {
            SessionControl::Delete { deadline, result }
        };
        control.send(command).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err(), "{action} is not read cleanup");
        assert_eq!(
            fixture.calls().len(),
            calls_before,
            "{action} must not reach the peer"
        );
    }
    assert_eq!(fixture.record(), baseline);
    assert!(connection.sessions.lock().unwrap().contains_key(SESSION));
}

#[tokio::test(flavor = "multi_thread")]
async fn search_read_preview_fifo_task_stop_never_dispatches() {
    use crate::acp_client::{async_tasks::STOP_METHOD, pump::SessionControl};

    for purpose in [OpenPurpose::Conversation, OpenPurpose::SearchReadOnly] {
        let fixture = Fixture::established().await;
        let baseline = fixture.record();
        fixture
            .manager
            .disconnect(&fixture.row.id, &fixture.cwd)
            .await
            .unwrap();
        fixture.events.lock().unwrap().clear();
        // Keep the original capability and load-replay fixture. This local
        // extension acknowledges stop requests without inventing a terminal;
        // only the independent test-owned completion signal ends the task.
        let peer = PEER
            .replace("import sys,json,os,copy\n", "import sys,json,os,copy,threading,time\n")
            .replace(
                "for line in sys.stdin:\n",
                "def finish_task():\n for _ in range(1000):\n  if os.path.exists(os.path.join(root,'task-finished')):\n   send_batch([{'method':'session/update','params':{'sessionId':'restore-proof','update':{'sessionUpdate':'async_task_state_update','asyncTaskId':'load-task','toolCallId':'load-tool','state':'completed'}}}]);return\n  time.sleep(.01)\nfor line in sys.stdin:\n",
            )
            .replace(
                " elif method=='session/prompt': result={'stopReason':'end_turn'}\n",
                " elif method=='_session/async_task/stop': result={'stopped':True}\n elif method=='session/prompt': result={'stopReason':'end_turn'}\n",
            )
            .replace(
                " if 'id' in m: send_batch(prefix+[{'id':m['id'],'result':result}]+suffix)\n",
                " if 'id' in m: send_batch(prefix+[{'id':m['id'],'result':result}]+suffix)\n if method=='session/load': threading.Thread(target=finish_task,daemon=True).start()\n",
            );
        assert_ne!(peer, PEER);
        std::fs::write(fixture.cwd.join("peer.py"), peer).unwrap();
        std::fs::write(fixture.cwd.join("fault"), "load-async-running").unwrap();
        let token = (purpose == OpenPurpose::SearchReadOnly)
            .then(|| "readonly-fifo-task-owner".to_string());
        let (reply, receive) = tokio::sync::oneshot::channel::<Result<Value, String>>();
        let queued = Arc::new(Mutex::new(Some(reply)));
        let waiting = queued.clone();
        let manager = fixture.manager.clone();
        let cwd = fixture.cwd.clone();
        let agent_id = fixture.row.id.clone();
        let expected_token = token.clone();
        let captured = fixture.events.clone();
        let sink: SessionSink = Arc::new(move |event| {
            captured.lock().unwrap().push(event.clone());
            if event["kind"] != "configCheck" {
                return;
            }
            let Ok(connection) = manager.session_connection(&agent_id, &cwd, SESSION) else {
                return;
            };
            let control = {
                let sessions = connection.sessions.lock().unwrap();
                let Some(entry) = sessions.get(SESSION) else {
                    return;
                };
                if entry.purpose != purpose
                    || entry.preview_token.as_deref() != expected_token.as_deref()
                {
                    return;
                }
                entry.control.clone()
            };
            if let Some(result) = waiting.lock().unwrap().take() {
                // The actor emits this final check before its ready reply and
                // then continues to the FIFO head. No scheduling sleep or
                // unsupported task can accidentally satisfy the negative.
                control
                    .send(SessionControl::StopTask {
                        connection_id: connection.connection_id.clone(),
                        task_id: "load-task".into(),
                        deadline: tokio::time::Instant::now() + Duration::from_secs(5),
                        result,
                    })
                    .unwrap();
            }
        });
        let opened = fixture
            .manager
            .open_session_owned_for_purpose(
                &fixture.row,
                &fixture.cwd,
                Some(SESSION.into()),
                vec![],
                sink,
                &fixture.store,
                None,
                token.clone(),
                purpose,
                None,
                Some("readonly-fifo-task-open".into()),
            )
            .await
            .unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .unwrap()
            .unwrap();
        let stops: Vec<_> = fixture
            .calls()
            .into_iter()
            .filter(|call| call["method"] == STOP_METHOD)
            .collect();
        let observed = (outcome.is_err(), stops.len());
        assert!(queued.lock().unwrap().is_none());
        let connection = fixture
            .manager
            .session_connection(&fixture.row.id, &fixture.cwd, SESSION)
            .unwrap();
        assert_eq!(connection.connection_id, opened.connection_id);
        assert!(
            connection
                .handshake
                .get()
                .unwrap()
                .typed
                .agent_capabilities
                .load_session
        );
        {
            let events = fixture.events.lock().unwrap();
            let tasks = events
                .iter()
                .rev()
                .find(|event| event["kind"] == "asyncTasks")
                .unwrap();
            assert_eq!(tasks["supported"], true);
            assert_eq!(tasks["connectionId"], opened.connection_id);
            assert_eq!(tasks["sessionId"], SESSION);
            assert_eq!(tasks["tasks"][0]["asyncTaskId"], "load-task");
            assert_eq!(tasks["tasks"][0]["canStop"], true);
            assert_eq!(tasks["tasks"][0]["state"], "running");
        }
        {
            let sessions = connection.sessions.lock().unwrap();
            let entry = sessions.get(SESSION).unwrap();
            assert_eq!(entry.purpose, purpose);
            assert_eq!(entry.preview_token, token);
        }
        if purpose == OpenPurpose::SearchReadOnly {
            assert!(
                fixture
                    .manager
                    .close_session_owned(
                        &fixture.row.id,
                        &fixture.cwd,
                        SESSION,
                        Some("foreign-preview-token")
                    )
                    .await
                    .is_err()
            );
            assert!(connection.sessions.lock().unwrap().contains_key(SESSION));
            assert_eq!(fixture.record(), baseline);
            assert!(fixture.restore_sets().is_empty());
        }
        // A real task terminal, not the stop ACK, permits normal exact cleanup.
        std::fs::write(fixture.cwd.join("task-finished"), b"complete").unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !fixture.events.lock().unwrap().iter().any(|event| {
                event["kind"] == "asyncTasks"
                    && event["connectionId"] == opened.connection_id
                    && event["tasks"][0]["state"] == "completed"
            }) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        fixture
            .manager
            .close_session_owned(&fixture.row.id, &fixture.cwd, SESSION, token.as_deref())
            .await
            .unwrap();
        assert!(!connection.sessions.lock().unwrap().contains_key(SESSION));
        assert_eq!(
            fixture
                .calls()
                .iter()
                .filter(|call| call["method"] == STOP_METHOD)
                .count(),
            stops.len()
        );
        fixture.assert_identity_and_no_prompt();
        if purpose == OpenPurpose::Conversation {
            assert_eq!(
                observed,
                (false, 1),
                "ordinary task stop must reach the declared official route"
            );
            assert_eq!(outcome.unwrap()["status"], "accepted");
            assert_eq!(
                stops[0]["params"],
                json!({"sessionId":SESSION,"asyncTaskId":"load-task"})
            );
        } else {
            assert_eq!(
                observed,
                (true, 0),
                "read-only FIFO stop must reject before any official stop request"
            );
        }
    }
}
