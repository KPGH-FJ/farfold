//! Production notification forwarding only: no Agent, IPC, decoder or database.
//! The allocation check observes String storage identity, not RSS or safety.
use super::*;
use crate::acp_client::{
    async_tasks::Tasks, compaction_activity::CompactionActivity,
    elicitation::ConnectionElicitations, tool_activity::ToolActivity,
};
use serde_json::json;
use std::sync::atomic::AtomicUsize;

const SESSION: &str = "forwarding-fixture";
const CONNECTION: &str = "forwarding-connection";
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const DATA: &str = "/update/content/data";

#[derive(Default)]
struct Observed {
    values: Vec<Value>,
    storage_preserved: Vec<bool>,
    calls: usize,
}

// Reuse the production DispatchContext and observers. The sink is the same
// owned-Value interface as Channel delivery; it may retain or drop each Value.
fn forward(params: &[Value], live: bool, retain: bool) -> Observed {
    assert!(params.len() <= 8);
    assert!(serde_json::to_vec(params).unwrap().len() <= MAX_INPUT_BYTES);
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let forms: PendingElicitations = Default::default();
    let ops = SessionOps {
        prompt_escrow: Default::default(),
        async_tasks_supported: Arc::new(AtomicBool::new(false)),
        opening: None,
        connection_id: CONNECTION.into(),
        verify_identity: Arc::new(|_, _| Ok(None)),
        elicitations: forms.clone(),
        inquiries: ConnectionElicitations::new(forms, life.clone(), CONNECTION.into()),
        life: life.clone(),
    };
    let observed = Arc::new(Mutex::new(Observed::default()));
    let source_address = Arc::new(AtomicUsize::new(0));
    let captured = observed.clone();
    let source = source_address.clone();
    let sink: SessionSink = Arc::new(move |value| {
        let mut result = captured.lock().unwrap();
        result.calls += 1;
        if let Some(data) = value.pointer(DATA).and_then(Value::as_str) {
            assert!(!data.is_empty());
            // Compare addresses only while the received Value owns its String.
            // Never dereference, print, or reconstruct the captured address.
            result
                .storage_preserved
                .push(data.as_ptr() as usize == source.load(Ordering::SeqCst));
        }
        if retain {
            result.values.push(value);
        }
    });
    let pending: PendingPermissions = Default::default();
    let mut permission_ids = Vec::new();
    let mut elicitation_ids = Vec::new();
    let (expirations, _expired) = mpsc::unbounded_channel();
    let mut tools = ToolActivity::new(life.clone());
    if live {
        tools.begin_live();
    }
    let mut compactions = CompactionActivity::new(life.clone(), CONNECTION.into(), SESSION.into());
    let mut tasks = Tasks::new(false, CONNECTION.into(), SESSION.into(), life.clone());
    {
        let mut ctx = DispatchContext {
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
        };
        for params in params {
            let message = UntypedMessage::new("session/update", params).unwrap();
            // Capture after the official message constructor, not from the
            // separate expected-value fixture it serializes. Only an integer
            // address is kept, so no borrow is extended across the move.
            source_address.store(
                message
                    .params()
                    .pointer(DATA)
                    .and_then(Value::as_str)
                    .map_or(0, |data| data.as_ptr() as usize),
                Ordering::SeqCst,
            );
            handle_session_dispatch(Dispatch::Notification(message), &mut ctx);
            source_address.store(0, Ordering::SeqCst);
        }
    }
    assert!(pending.lock().unwrap().is_empty());
    assert!(permission_ids.is_empty() && elicitation_ids.is_empty());
    assert_eq!(life.work.load(Ordering::SeqCst), 0);
    assert!(!tools.busy() && !compactions.busy() && !tasks.busy());
    let mut result = observed.lock().unwrap();
    std::mem::take(&mut *result)
}

#[test]
fn forwards_whole_raw_media_unknown_and_partial_values_in_order() {
    let params = vec![
        json!({"sessionId":SESSION,"futureRoot":[1,null,{"x":true}],"update":{
            "sessionUpdate":"agent_message_chunk","content":{
                "type":"audio","mimeType":"audio/wav","data":"QUJD",
                "futureContent":{"source":"owned-public"}
            }},"_meta":{"sequence":1,"future":null}}),
        json!({"sessionId":SESSION,"update":{
            "sessionUpdate":"tool_call_update","toolCallId":"untracked",
            "futurePartial":{"keep":[false,2]}
        },"_meta":{"sequence":2}}),
        json!({"sessionId":SESSION,"update":null,"futureRoot":{"keep":true},
            "_meta":{"sequence":3}}),
    ];
    let observed = forward(&params, false, true);
    assert!(observed.values == params, "raw values or order changed");
    assert_eq!(observed.calls, 3);
}

#[test]
fn keeps_tool_activity_and_terminal_output_after_their_raw_notifications() {
    let start = json!({"sessionId":SESSION,"update":{
        "sessionUpdate":"tool_call","toolCallId":"owned-tool","status":"in_progress",
        "futureField":{"keep":true},"_meta":{"terminal_output":{
            "terminal_id":"owned-terminal","data":"PUBLIC-A\n"
        }}
    }});
    // A completed partial patch need not repeat title/kind/input/content.
    let end = json!({"sessionId":SESSION,"update":{
        "sessionUpdate":"tool_call_update","toolCallId":"owned-tool","status":"completed",
        "_meta":{"terminal_output_delta":{
            "terminal_id":"owned-terminal","data":"PUBLIC-B\n"
        }}
    }});
    let observed = forward(&[start.clone(), end.clone()], true, true);
    let expected = vec![
        start,
        json!({"kind":"toolActivity","toolCallIds":["owned-tool"]}),
        json!({"kind":"toolOutput","toolCallId":"owned-tool",
            "terminalId":"owned-terminal","data":"PUBLIC-A\n"}),
        end,
        json!({"kind":"toolActivity","toolCallIds":[]}),
        json!({"kind":"toolOutput","toolCallId":"owned-tool",
            "terminalId":"owned-terminal","data":"PUBLIC-B\n"}),
    ];
    assert!(
        observed.values == expected,
        "raw/derived emission order changed"
    );
    assert_eq!(observed.calls, 6);
}

#[test]
fn receiver_can_drop_the_owned_raw_value_without_an_ack_or_replay() {
    let params = [json!({"sessionId":SESSION,"update":{
        "sessionUpdate":"future_update","future":{"keep":true}
    }})];
    let observed = forward(&params, false, false);
    assert_eq!(observed.calls, 1);
    assert!(observed.values.is_empty());
}

#[test]
fn forwards_owned_media_string_storage_without_an_extra_value_clone() {
    // Canonical Base64 for a wire-only public corpus, not a codec/playback test.
    let params = ["audio", "image"]
        .into_iter()
        .map(|kind| {
            json!({"sessionId":SESSION,"update":{
                "sessionUpdate":"agent_message_chunk","content":{
                    "type":kind,"mimeType":if kind == "audio" {"audio/wav"} else {"image/png"},
                    "data":"QUJD".repeat(65_536),"futureContent":{"keep":true}
                }},"_meta":{"kind":kind,"future":[1,null,true]}})
        })
        .collect::<Vec<_>>();
    let observed = forward(&params, false, true);
    assert!(
        observed.values == params,
        "raw payload or unknown fields changed"
    );
    assert_eq!(observed.calls, 2);
    // On old code only this ownership assertion should fail: values/order
    // already pass. It does not assert a user-visible failure or memory saving.
    assert_eq!(observed.storage_preserved, vec![true, true]);
}
