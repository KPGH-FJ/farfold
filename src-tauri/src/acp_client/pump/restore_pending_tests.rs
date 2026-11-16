//! Exact production admission boundary with real Plan/Mutation/Inbox/drain.
//! Controlled futures count first polls; no Agent, wire send or installed UI.
use super::*;
use crate::meta_store::MetaStore;
use serde_json::json;
use std::future::Future;
use std::time::Duration;
const SESSION: &str = "restore-proof";

async fn exercise(mode: &str, expected_polls: usize) {
    use crate::acp_client::{
        compaction_activity::CompactionActivity,
        elicitation::ConnectionElicitations,
        lifecycle::ConnectionLife,
        model_guard::{ConfigStore, ModelGuard},
        mutation::{Kind, Mutation, Reply},
        operations::Operation,
        permission_guard::PermissionGuard,
        service_connection::ServiceRecord,
        session_config::SessionConfig,
        tool_activity::ToolActivity,
    };
    use agent_client_protocol::{Dispatch, UntypedMessage};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::{mpsc, oneshot};

    let options = json!([
        {"id":"model","name":"Model","category":"model","type":"select","currentValue":"m1","options":[{"value":"m1","name":"One"},{"value":"m2","name":"Two"}]},
        {"id":"reasoning_effort","name":"Thinking","category":"thought_level","type":"select","currentValue":"low","options":[{"value":"low","name":"Low"},{"value":"high","name":"High"}]}
    ]);
    let record = json!({"_farfoldConfig":2,"_farfoldService":{"kind":"existing"},"choices":[
        {"id":"model","category":"model","type":"select","value":"m2"},
        {"id":"reasoning_effort","category":"thought_level","type":"select","value":"low"}
    ]});
    let directory = tempfile::tempdir().unwrap();
    let config_store = ConfigStore {
        store: MetaStore::open(&directory.path().join("owned.db")).unwrap(),
        agent_id: "diagnostic-owned".into(),
        cwd: directory.path().to_string_lossy().into(),
        service_record: Some(ServiceRecord::Existing),
        expected_model: None,
        verified_permission_option: false,
    };
    let operation = Operation::new();
    let mut opening = Some(super::restore_config::Opening {
        purpose: crate::acp_client::open_purpose::OpenPurpose::Conversation,
        reply: None,
        operation: operation.clone(),
        recorded: Some(record.clone()),
        restored: true,
        options: Some(options.clone()),
        config_options_modern: true,
        warnings: Vec::new(),
    });
    let mut plan = super::restore_config::Plan::new(
        opening.as_ref().unwrap(),
        &config_store,
        Default::default(),
    )
    .unwrap()
    .unwrap();
    let first = plan.next(&options).unwrap().unwrap();
    assert_eq!(first.id, "model");
    let mut configuration = SessionConfig::from_response(&json!({"configOptions":options}));
    let first_request = configuration
        .prepare(&first.id, &json!(first.value))
        .unwrap();
    let mut applied = options.clone();
    applied[0]["currentValue"] = json!("m2");
    applied[1]["currentValue"] = json!("high");
    let first_reply = applied.clone();
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let lease = life.operation("restore:diagnostic-owned".into()).unwrap();
    let (reply, receive) = oneshot::channel();
    let mut receive = Some(receive);
    let mut mutation = Some(Mutation::new(
        Kind::Restore {
            plan: Box::new(plan),
            request: first_request.clone(),
        },
        Reply::Open(reply),
        operation,
        lease,
        tokio::time::Instant::now() + Duration::from_secs(60),
        async move { Ok(first_reply) },
    ));
    let outcome = crate::acp_client::mutation::next(&mut mutation)
        .await
        .unwrap()
        .unwrap();
    let mut completed = mutation.take().unwrap();
    let outcome = configuration.complete(&first_request, outcome).unwrap();
    let Kind::Restore { plan, .. } = &mut completed.kind else {
        unreachable!()
    };
    let confirmed = plan.complete(&outcome).unwrap();
    opening.as_mut().unwrap().options = Some(confirmed.clone());
    let next = plan.next(&confirmed).unwrap().unwrap();
    assert_eq!(next.id, "reasoning_effort");
    let next_request = configuration.prepare(&next.id, &json!(next.value)).unwrap();
    if let Kind::Restore { request, .. } = &mut completed.kind {
        *request = next_request;
    }
    let trace = Arc::new(Mutex::new(Vec::<Value>::new()));
    let polls = Arc::new(AtomicUsize::new(0));
    let counted = polls.clone();
    let observed = trace.clone();
    let (finish_send, finish_receive) = oneshot::channel::<()>();
    let mut finish_send = Some(finish_send);
    mutation = Some(completed.continue_request(async move {
        observed
            .lock()
            .unwrap()
            .push(json!({"stage":"pending-future-first-poll"}));
        counted.fetch_add(1, Ordering::SeqCst);
        finish_receive.await.unwrap();
        Ok(json!([]))
    }));
    assert!(!mutation.as_ref().unwrap().started());
    trace
        .lock()
        .unwrap()
        .push(json!({"stage":"continuation-prepared-unstarted"}));

    let forms: super::PendingElicitations = Default::default();
    let ops = super::SessionOps {
        session_tools: crate::acp_client::session_tools::Availability::unavailable(),
        live_status_enabled: false,
        tool_media_enabled: false,
        history_supplement_source: None,
        configuration_dialect: Default::default(),
        workspace_access: crate::acp_client::workspace_access::Availability::new(None),
        prompt_escrow: Default::default(),
        async_tasks_supported: Arc::new(AtomicBool::new(false)),
        opening: None,
        connection_id: "diagnostic-owned".into(),
        verify_identity: Arc::new(|_, _| Ok(None)),
        elicitations: forms.clone(),
        inquiries: ConnectionElicitations::new(forms, life.clone(), "diagnostic-owned".into()),
        life: life.clone(),
    };
    let sink_trace = trace.clone();
    let sink: SessionSink = Arc::new(move |value| sink_trace.lock().unwrap().push(value));
    let pending = Default::default();
    let mut permission_ids = Vec::new();
    let mut elicitation_ids = Vec::new();
    let (expirations, _expired) = mpsc::unbounded_channel();
    let mut tools = ToolActivity::new(life.clone());
    // The real pump enters live activity before its first restore setter.
    tools.begin_live();
    let mut compactions =
        CompactionActivity::new(life.clone(), "diagnostic-owned".into(), SESSION.into());
    let mut tasks = crate::acp_client::async_tasks::Tasks::new(
        false,
        "diagnostic-owned".into(),
        SESSION.into(),
        life,
    );
    let live_status = crate::acp_client::live_status::Owner::inactive(&ops, SESSION);
    let mut ctx = super::DispatchContext {
        live_status: &live_status,
        session_id: SESSION,
        events: &sink,
        pending: &pending,
        ops: &ops,
        permission_ids: &mut permission_ids,
        elicitation_ids: &mut elicitation_ids,
        expirations: &expirations,
        tools: &mut tools,
        compactions: &mut compactions,
        async_tasks: &mut tasks,
        prompt_cancelling: false,
        terminals: None,
    };
    let mut guard = ModelGuard::new(&applied, Some(&record), true);
    let mut permission_options = applied.clone();
    if mode == "permission" {
        permission_options.as_array_mut().unwrap().push(json!({
            "id":"mode","category":"mode","type":"select","currentValue":"read-only",
            "options":[{"value":"read-only"},{"value":"agent"},{"value":"agent-full-access"}]
        }));
    }
    let mut permissions = PermissionGuard::new(mode == "permission", &permission_options, false);
    let mut models = super::model_ids(&applied);
    let (send, mut inbox) = crate::acp_client::session_routes::Routes::default().channel();
    if mode == "started" {
        let mut advance = Box::pin(super::restore_config::next_mutation(
            &mut mutation,
            &opening,
            &mut ctx,
            &permissions,
            || true,
        ));
        let first =
            std::future::poll_fn(|cx| std::task::Poll::Ready(advance.as_mut().poll(cx))).await;
        drop(advance);
        assert!(first.is_pending());
        assert!(mutation.as_ref().unwrap().started());
        assert_eq!(polls.load(Ordering::SeqCst), 1);
    }
    let mut drifted = permission_options;
    if matches!(mode, "drift" | "started") {
        drifted[0]["currentValue"] = json!("m1");
    }
    if mode == "unoffered" {
        drifted[1]["options"] = json!([{"value":"high","name":"High"}]);
    }
    if mode == "permission" {
        drifted[2]["currentValue"] = json!("agent");
    }
    let update = if mode == "busy" {
        json!({"sessionUpdate":"tool_call","toolCallId":"pending-restore-tool","title":"Owned tool","kind":"read","status":"in_progress"})
    } else {
        json!({"sessionUpdate":"config_option_update","configOptions":drifted})
    };
    send.send(Dispatch::Notification(
        UntypedMessage::new(
            "session/update",
            json!({
                "sessionId":SESSION,"update":update
            }),
        )
        .unwrap(),
    ))
    .unwrap();
    super::restore_config::drain(
        &mut inbox,
        &mut ctx,
        &mut configuration,
        &mut models,
        &mut guard,
        &mut permissions,
        &mut opening,
        &mut mutation,
    );
    if matches!(mode, "drift" | "started") {
        assert_eq!(
            opening.as_ref().unwrap().options.as_ref().unwrap()[0]["currentValue"],
            "m1"
        );
        assert!(
            !guard.admissible(),
            "the real guard has already observed the drift"
        );
    }
    if mode == "busy" {
        assert!(super::restore_config::busy(&ctx));
    }
    if mode == "permission" {
        assert_eq!(permissions.state(), "unknown");
    }
    if mode == "owner" {
        drop(receive.take());
    }
    assert_eq!(mutation.as_ref().unwrap().started(), mode == "started");
    trace
        .lock()
        .unwrap()
        .push(json!({"stage":"received-state-before-admission","mode":mode}));
    finish_send.take().unwrap().send(()).unwrap();
    let outcome = super::restore_config::next_mutation(
        &mut mutation,
        &opening,
        &mut ctx,
        &permissions,
        || true,
    )
    .await;
    eprintln!(
        "PENDING_RESTORE_ORDER={}",
        serde_json::to_string(&*trace.lock().unwrap()).unwrap()
    );
    assert_eq!(
        polls.load(Ordering::SeqCst),
        expected_polls,
        "the actual pump admission must decide before an unstarted restore future is polled"
    );
    assert_eq!(
        outcome.as_ref().is_some_and(|outcome| outcome.is_ok()),
        expected_polls == 1
    );
    assert_eq!(mutation.as_ref().unwrap().started(), expected_polls == 1);
}
#[tokio::test]
async fn received_model_drift_blocks_unstarted_restore() {
    exercise("drift", 0).await;
}

#[tokio::test]
async fn received_busy_work_blocks_unstarted_restore() {
    exercise("busy", 0).await;
}

#[tokio::test]
async fn removed_requested_choice_blocks_unstarted_restore() {
    exercise("unoffered", 0).await;
}

#[tokio::test]
async fn unchanged_pending_restore_is_polled() {
    exercise("unchanged", 1).await;
}

#[tokio::test]
async fn started_restore_keeps_its_original_future_after_drift() {
    exercise("started", 1).await;
}

#[tokio::test]
async fn closed_restore_owner_does_not_poll_pending_request() {
    exercise("owner", 0).await;
}

#[tokio::test]
async fn changed_permission_blocks_unstarted_restore() {
    exercise("permission", 0).await;
}
