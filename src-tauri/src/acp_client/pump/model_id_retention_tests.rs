//! Bounded production-drain regression; no Agent process, database or Tauri bridge.
use super::*;
use crate::acp_client::{
    async_tasks::Tasks, compaction_activity::CompactionActivity,
    elicitation::ConnectionElicitations, model_guard::ModelGuard,
    permission_guard::PermissionGuard, session_config::SessionConfig, tool_activity::ToolActivity,
};
use serde_json::json;

struct Observed {
    members: usize,
    selector_seen: bool,
    secondary_seen: bool,
    display_name_seen: bool,
    final_options: Option<Value>,
    guard_status: &'static str,
}

fn model(id: &str) -> Value {
    json!({
        "id":id,"category":"model","name":"Choice","type":"select",
        "currentValue":"m1","options":[{"value":"m1","name":"One"}]
    })
}

// This calls the actual restore drain and dispatch forwarder. It deliberately
// does not reproduce model_ids or its collection update in the test.
fn drain(initial: Value, snapshots: Vec<Value>) -> Observed {
    let session = "model-retention-fixture";
    let connection = "model-retention-connection";
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let forms: PendingElicitations = Default::default();
    let ops = SessionOps {
        async_tasks_supported: Arc::new(AtomicBool::new(false)),
        opening: None,
        connection_id: connection.into(),
        verify_identity: Arc::new(|_, _| Ok(None)),
        elicitations: forms.clone(),
        inquiries: ConnectionElicitations::new(forms, life.clone(), connection.into()),
        life: life.clone(),
    };
    let observed = Arc::new(Mutex::new(Vec::<Value>::new()));
    let capture = observed.clone();
    let sink: SessionSink = Arc::new(move |value| capture.lock().unwrap().push(value));
    let pending: PendingPermissions = Default::default();
    let mut permission_ids = Vec::new();
    let mut elicitation_ids = Vec::new();
    let (expirations, _expired) = mpsc::unbounded_channel();
    let mut tools = ToolActivity::new(life.clone());
    let mut compactions = CompactionActivity::new(life.clone(), connection.into(), session.into());
    let mut tasks = Tasks::new(false, connection.into(), session.into(), life);
    let mut ctx = DispatchContext {
        session_id: session,
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
    };
    let mut configuration = SessionConfig::from_response(&json!({"configOptions":initial}));
    let mut models = model_ids(&initial);
    let mut guard = ModelGuard::new(&initial, None, false);
    let mut permissions = PermissionGuard::new(false, &initial, false);
    let mut opening = None;
    let mut mutation = None;
    let (send, mut inbox) = mpsc::unbounded_channel();
    let envelopes = snapshots
        .iter()
        .enumerate()
        .map(|(index, options)| {
            json!({
                "sessionId":session,
                "update":{
                    "sessionUpdate":"config_option_update","configOptions":options,
                    "futureField":{"index":index}
                },
                "_meta":{"fixtureSequence":index}
            })
        })
        .collect::<Vec<_>>();
    for envelope in &envelopes {
        send.send(Dispatch::Notification(
            UntypedMessage::new("session/update", envelope).unwrap(),
        ))
        .unwrap();
    }
    restore_config::drain(
        &mut inbox,
        &mut ctx,
        &mut configuration,
        &mut models,
        &mut guard,
        &mut permissions,
        &mut opening,
        &mut mutation,
    );
    assert!(inbox.try_recv().is_err());
    // Keep exact order, unknown fields and every derived configuration event.
    let expected = envelopes
        .iter()
        .zip(&snapshots)
        .flat_map(|(raw, options)| {
            [
                raw.clone(),
                json!({"kind":"configOptions","options":options,"modern":true}),
            ]
        })
        .collect::<Vec<_>>();
    assert_eq!(*observed.lock().unwrap(), expected);
    assert_eq!(
        configuration.options(),
        snapshots.last().cloned().or(Some(initial))
    );
    Observed {
        members: models.len(),
        selector_seen: models.contains("selector"),
        secondary_seen: models.contains("secondary"),
        display_name_seen: models.contains("Choice"),
        final_options: configuration.options(),
        guard_status: guard.check().status,
    }
}

#[tokio::test]
async fn repeated_eight_updates_keep_one_member_without_dropping_events() {
    let options = json!([model("selector")]);
    let observed = drain(options.clone(), vec![options; 8]);
    assert!(observed.selector_seen);
    assert_eq!(observed.guard_status, "ready");
    assert_eq!(
        observed.members, 1,
        "cache stores identities, not update history"
    );
}

#[tokio::test]
async fn repeated_sixty_four_updates_keep_one_member_without_dropping_events() {
    let options = json!([model("selector")]);
    let observed = drain(options.clone(), vec![options; 64]);
    assert!(observed.selector_seen);
    assert_eq!(observed.guard_status, "ready");
    assert_eq!(
        observed.members, 1,
        "cache stores identities, not update history"
    );
}

#[tokio::test]
async fn removed_or_reclassified_ids_remain_distinct_even_with_the_same_display_name() {
    let reclassified = json!([{
        "id":"selector","category":"future","name":"Choice","type":"select",
        "currentValue":"m1","options":[{"value":"m1","name":"One"}]
    }]);
    let observed = drain(
        json!([model("selector")]),
        vec![json!([model("secondary")]), reclassified.clone()],
    );
    assert_eq!(observed.members, 2);
    assert!(observed.selector_seen && observed.secondary_seen);
    assert!(!observed.display_name_seen);
    assert_eq!(observed.final_options, Some(reclassified));
}

#[tokio::test]
async fn malformed_snapshot_keeps_old_members_and_the_unknown_guard() {
    let observed = drain(json!([model("selector")]), vec![Value::Null]);
    assert_eq!(observed.members, 1);
    assert!(observed.selector_seen);
    assert_eq!(observed.guard_status, "blocked");
    assert_eq!(observed.final_options, Some(Value::Null));
}

#[tokio::test]
async fn a_second_session_starts_with_its_own_membership() {
    let first = drain(json!([model("selector")]), Vec::new());
    let second = drain(json!([model("secondary")]), Vec::new());
    assert!(first.selector_seen && !first.secondary_seen);
    assert!(second.secondary_seen && !second.selector_seen);
    assert_eq!((first.members, second.members), (1, 1));
}
