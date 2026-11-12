//! Real SDK request frames at the production first-poll boundary.
//! The peer, route, options and activity are entirely controlled in memory.
use super::*;
use agent_client_protocol::{Channel, Client, TransportFrame};
use futures_lite::StreamExt;
use serde_json::json;
use std::{future::Future, time::Duration};

const SESSION: &str = "configuration-activity-owned";

async fn exercise(mode: &str, expected_writes: usize) {
    exercise_kind("config", mode, expected_writes).await;
}

async fn exercise_kind(kind: &str, mode: &str, expected_writes: usize) {
    use crate::acp_client::{
        compaction_activity::CompactionActivity, elicitation::ConnectionElicitations,
        permission_guard::PermissionGuard, session_config::SessionConfig,
        tool_activity::ToolActivity,
    };

    let options = json!([{
        "id":"format","name":"Format","type":"select","currentValue":"one",
        "options":[{"value":"one","name":"One"},{"value":"two","name":"Two"}]
    }]);
    let kind = kind.to_owned();
    let report_kind = kind.clone();
    let peer_kind = kind.clone();
    let mode = mode.to_owned();
    let report_mode = mode.clone();
    let peer_mode = mode.clone();
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let routes = life.routes.clone();
    let incoming_routes = routes.clone();
    let trace = Arc::new(Mutex::new(Vec::<Value>::new()));
    let event_trace = trace.clone();
    let peer_trace = trace.clone();
    let writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let peer_writes = writes.clone();
    let (prepared, wait_prepared) = oneshot::channel::<()>();
    let (release_reply, wait_release_reply) = oneshot::channel::<()>();
    let (client, mut peer) = Channel::duplex();
    let response_options = options.clone();
    let outcome = Arc::new(Mutex::new(None));
    let actual_outcome = outcome.clone();
    let connection = Client
        .builder()
        .on_receive_dispatch(
            async move |dispatch: Dispatch, _cx| incoming_routes.dispatch(dispatch),
            agent_client_protocol::on_receive_dispatch!(),
        )
        .connect_with(client, async move |cx| {
            let sink: SessionSink = Arc::new(move |event| {
                event_trace.lock().unwrap().push(json!({
                    "stage":"sink","kind":event["kind"],
                    "status":event.pointer("/update/status"),
                    "ids":event["compactionIds"],"uncertain":event["uncertain"]
                }));
            });
            let (send, mut inbox) = routes.channel();
            let _route = routes
                .register(
                    SESSION,
                    send,
                    Arc::new(AtomicBool::new(false)),
                    sink.clone(),
                )
                .unwrap();
            let mut compactions = CompactionActivity::new(
                life.clone(),
                "configuration-activity-connection".into(),
                SESSION.into(),
            );
            let configuration = SessionConfig::from_response(&json!({"configOptions":options}));
            // A real earlier admitted setter establishes live observation.
            // A merely prepared first request must not turn replay into work.
            let prime = configuration.prepare("format", &json!("one")).unwrap();
            compactions
                .live_request(prime.send(&cx, SESSION, &Operation::new()))
                .await
                .unwrap();
            let forms: PendingElicitations = Default::default();
            let ops = SessionOps {
                session_tools: crate::acp_client::session_tools::Availability::unavailable(),
                live_status_enabled: false,
                configuration_dialect: Default::default(),
                workspace_access: crate::acp_client::workspace_access::Availability::new(None),
                prompt_escrow: Default::default(),
                async_tasks_supported: Arc::new(AtomicBool::new(false)),
                opening: None,
                connection_id: "configuration-activity-connection".into(),
                verify_identity: Arc::new(|_, _| Ok(None)),
                elicitations: forms.clone(),
                inquiries: ConnectionElicitations::new(
                    forms,
                    life.clone(),
                    "configuration-activity-connection".into(),
                ),
                life: life.clone(),
            };
            let pending = Default::default();
            let mut permission_ids = Vec::new();
            let mut elicitation_ids = Vec::new();
            let (expirations, _expired) = mpsc::unbounded_channel();
            let mut tools = ToolActivity::new(life.clone());
            tools.begin_live();
            if kind == "stopped-close" {
                tools.start_prompt(47);
                tools.observe(
                    &json!({"update":{"sessionUpdate":"tool_call","toolCallId":"candidate"}}),
                );
                tools.observe_permission("held", &json!({"toolCallId":"candidate"}));
                tools.cancel_first_permission(true);
                tools.finish_prompt(47, true);
            }
            let mut tasks = crate::acp_client::async_tasks::Tasks::new(
                false,
                ops.connection_id.clone(),
                SESSION.into(),
                life.clone(),
            );
            let live_status = crate::acp_client::live_status::Owner::inactive(&ops, SESSION);
            let mut ctx = DispatchContext {
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
            };
            let permissions = PermissionGuard::new(false, &options, false);
            let request = configuration.prepare("format", &json!("two")).unwrap();
            let operation = Operation::new();
            let future: std::pin::Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> =
                if kind == "config" {
                    Box::pin(
                        ctx.compactions
                            .live_request(request.send(&cx, SESSION, &operation)),
                    )
                } else {
                    let (method, params) = match kind.as_str() {
                        "mode" => (
                            "session/set_mode",
                            json!({"sessionId":SESSION,"modeId":"two"}),
                        ),
                        "close" | "fork-close" | "stopped-close" => {
                            ("session/close", json!({"sessionId":SESSION}))
                        }
                        "delete" => ("session/delete", json!({"sessionId":SESSION})),
                        _ => unreachable!(),
                    };
                    let (cx, operation) = (cx.clone(), operation.clone());
                    Box::pin(async move {
                        let message =
                            UntypedMessage::new(method, &params).map_err(describe_acp_error)?;
                        operation
                            .request(&cx, cx.send_request_to(Agent, message))
                            .await
                            .map_err(describe_acp_error)
                    })
                };
            let (reply, receiver): (MutationReply, Box<dyn std::any::Any + Send>) =
                if kind == "config" {
                    let (reply, receiver) = oneshot::channel::<Result<Value, String>>();
                    (MutationReply::Config(reply), Box::new(receiver))
                } else if kind == "delete" {
                    let (reply, receiver) = oneshot::channel();
                    (MutationReply::Delete(reply), Box::new(receiver))
                } else {
                    let (reply, receiver) = oneshot::channel::<Result<(), String>>();
                    (MutationReply::Unit(reply), Box::new(receiver))
                };
            let mut receiver = Some(receiver);
            let pending_kind = match kind.as_str() {
                "config" => MutationKind::Config {
                    request,
                    permission_value: None,
                    choice: None,
                    prior_guard: None,
                    config_store: None,
                },
                "mode" => MutationKind::Mode,
                "close" | "fork-close" => MutationKind::Close,
                "stopped-close" => {
                    MutationKind::StoppedToolClose(stopped_tool_close::candidate(&ctx).unwrap())
                }
                "delete" => MutationKind::Delete,
                _ => unreachable!(),
            };
            let pending = Mutation::new(
                pending_kind,
                reply,
                operation,
                life.operation("configuration:owned".into()).unwrap(),
                if mode == "expired" || kind == "fork-close" {
                    tokio::time::Instant::now() - Duration::from_secs(1)
                } else {
                    tokio::time::Instant::now() + Duration::from_secs(5)
                },
                future,
            );
            // Exactly the existing ForkClose conversion: Close kind with a
            // deadline-free actual-reply owner, not an ordinary caller wait.
            let mut mutation = Some(if kind == "fork-close" {
                pending.until_actual_reply()
            } else {
                pending
            });
            assert!(!mutation.as_ref().unwrap().started());
            peer_trace
                .lock()
                .unwrap()
                .push(json!({"stage":"prepared-unstarted"}));
            prepared.send(()).unwrap();
            let opening = None;
            if mode == "started" {
                let mut first = Box::pin(restore_config::next_mutation(
                    &mut mutation,
                    &opening,
                    &mut ctx,
                    &permissions,
                    || true,
                ));
                let poll =
                    std::future::poll_fn(|cx| std::task::Poll::Ready(first.as_mut().poll(cx)))
                        .await;
                assert!(poll.is_pending());
                drop(first);
                assert!(mutation.as_ref().unwrap().started());
            }
            let received = match mode.as_str() {
                "clear" | "context-changed" => 0,
                "completed" => 2,
                "settled-replay" => 3,
                _ => 1,
            };
            for _ in 0..received {
                let dispatch = inbox.recv().await.unwrap();
                handle_session_dispatch(dispatch, &mut ctx);
            }
            assert!(inbox.try_recv().is_err());
            assert_eq!(
                ctx.compactions.busy(),
                !matches!(
                    mode.as_str(),
                    "clear" | "context-changed" | "completed" | "settled-replay"
                )
            );
            peer_trace.lock().unwrap().push(json!({
                "stage":"received-and-sunk-before-next-poll",
                "started":mutation.as_ref().unwrap().started(),
                "busy":ctx.compactions.busy()
            }));
            if mode == "caller-closed" || kind == "fork-close" {
                drop(receiver.take());
            }
            release_reply.send(()).unwrap();
            let result = restore_config::next_mutation(
                &mut mutation,
                &opening,
                &mut ctx,
                &permissions,
                || mode != "context-changed",
            )
            .await
            .expect("one actual mutation outcome");
            *actual_outcome.lock().unwrap() = Some(result.is_ok());
            if kind == "delete" {
                use crate::acp_client::mutation::DeleteFailure;

                mutation.take().unwrap().finish(result);
                let receive = receiver
                    .take()
                    .unwrap()
                    .downcast::<oneshot::Receiver<Result<(), DeleteFailure>>>()
                    .unwrap();
                assert_eq!(
                    receive.await.unwrap(),
                    if expected_writes == 0 {
                        Err(DeleteFailure::NotDispatched)
                    } else {
                        Ok(())
                    }
                );
            }
            drop(receiver);
            drop(mutation);
            Ok(())
        });
    let peer_trace = trace.clone();
    let remote = async move {
        let prime = peer.rx.next().await.unwrap().to_json().unwrap();
        let prime: Value = serde_json::from_str(&prime).unwrap();
        assert_eq!(prime["method"], "session/set_config_option");
        assert_eq!(prime["params"]["value"], "one");
        peer.tx
            .unbounded_send(TransportFrame::parse_json(
                &json!({
                    "jsonrpc":"2.0","id":prime["id"],"result":{"configOptions":response_options}
                })
                .to_string(),
            ))
            .unwrap();
        wait_prepared.await.unwrap();
        let send_activity = |status: &str| {
            peer.tx
                .unbounded_send(TransportFrame::parse_json(
                    &json!({
                        "jsonrpc":"2.0","method":"session/update","params":{
                            "sessionId":SESSION,"update":{"sessionUpdate":"compaction_update",
                            "compactionId":"owned-compaction","status":status}
                        }
                    })
                    .to_string(),
                ))
                .unwrap();
        };
        if !matches!(peer_mode.as_str(), "started" | "clear" | "context-changed") {
            send_activity(if peer_mode == "unknown" {
                "future_status"
            } else {
                "in_progress"
            });
            if matches!(peer_mode.as_str(), "completed" | "settled-replay") {
                send_activity("completed");
            }
            if peer_mode == "settled-replay" {
                send_activity("in_progress");
            }
        }
        let mut wait_release_reply = Some(wait_release_reply);
        while let Some(frame) = peer.rx.next().await {
            let request: Value = serde_json::from_str(&frame.to_json().unwrap()).unwrap();
            let expected_method = match peer_kind.as_str() {
                "config" => "session/set_config_option",
                "mode" => "session/set_mode",
                "close" | "fork-close" | "stopped-close" => "session/close",
                "delete" => "session/delete",
                _ => unreachable!(),
            };
            assert_eq!(request["method"], expected_method);
            assert_eq!(request["params"]["sessionId"], SESSION);
            if peer_kind == "config" {
                assert_eq!(request["params"]["configId"], "format");
                assert_eq!(request["params"]["value"], "two");
            }
            peer_writes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            peer_trace
                .lock()
                .unwrap()
                .push(json!({"stage":"peer-received-target-frame","method":request["method"]}));
            if peer_mode == "started" {
                send_activity("in_progress");
                wait_release_reply.take().unwrap().await.unwrap();
            }
            let mut changed = response_options.clone();
            changed[0]["currentValue"] = json!("two");
            peer.tx
                    .unbounded_send(TransportFrame::parse_json(
                        &json!({
                            "jsonrpc":"2.0","id":request["id"],"result":if peer_kind == "config" {json!({"configOptions":changed})} else {json!({})}
                        })
                        .to_string(),
                    ))
                    .unwrap();
        }
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(connection, remote).0.unwrap();
    })
    .await
    .expect("bounded owned SDK connection");
    let actual = writes.load(std::sync::atomic::Ordering::SeqCst);
    println!(
        "{}",
        json!({"kind":report_kind,"mode":report_mode,"actualTargetWrites":actual,"outcomeOk":*outcome.lock().unwrap(),"trace":*trace.lock().unwrap()})
    );
    assert_eq!(
        actual, expected_writes,
        "received activity must govern the actual first setter frame"
    );
    assert_eq!(*outcome.lock().unwrap(), Some(expected_writes == 1));
}

#[tokio::test]
async fn received_compaction_before_config_first_poll_does_not_send() {
    exercise("in-progress", 0).await;
}

#[tokio::test]
async fn received_unknown_compaction_before_config_first_poll_does_not_send() {
    exercise("unknown", 0).await;
}

#[tokio::test]
async fn completed_compaction_before_config_first_poll_allows_original_request_once() {
    exercise("completed", 1).await;
}

#[tokio::test]
async fn settled_compaction_replay_before_config_first_poll_does_not_lock() {
    exercise("settled-replay", 1).await;
}

#[tokio::test]
async fn activity_after_config_first_poll_keeps_the_same_started_request() {
    exercise("started", 1).await;
}

#[tokio::test]
async fn caller_closed_before_config_first_poll_never_sends() {
    exercise("caller-closed", 0).await;
}

#[tokio::test]
async fn expired_config_before_first_poll_never_sends() {
    exercise("expired", 0).await;
}

#[tokio::test]
async fn received_compaction_before_mode_first_poll_preserves_original_admission() {
    exercise_kind("mode", "in-progress", 0).await;
}

#[tokio::test]
async fn received_unknown_compaction_before_mode_first_poll_preserves_original_admission() {
    exercise_kind("mode", "unknown", 0).await;
}

#[tokio::test]
async fn completed_compaction_before_mode_first_poll_preserves_original_admission() {
    exercise_kind("mode", "completed", 1).await;
}

#[tokio::test]
async fn activity_after_mode_first_poll_preserves_original_admission() {
    exercise_kind("mode", "started", 1).await;
}

#[tokio::test]
async fn received_compaction_before_close_first_poll_preserves_original_admission() {
    exercise_kind("close", "in-progress", 0).await;
}

#[tokio::test]
async fn received_unknown_compaction_before_close_first_poll_preserves_original_admission() {
    exercise_kind("close", "unknown", 0).await;
}

#[tokio::test]
async fn completed_compaction_before_close_first_poll_preserves_original_admission() {
    exercise_kind("close", "completed", 1).await;
}

#[tokio::test]
async fn activity_after_close_first_poll_preserves_original_admission() {
    exercise_kind("close", "started", 1).await;
}

#[tokio::test]
async fn received_compaction_before_delete_first_poll_preserves_original_admission() {
    exercise_kind("delete", "in-progress", 0).await;
}

#[tokio::test]
async fn received_unknown_compaction_before_delete_first_poll_preserves_original_admission() {
    exercise_kind("delete", "unknown", 0).await;
}

#[tokio::test]
async fn completed_compaction_before_delete_first_poll_preserves_original_admission() {
    exercise_kind("delete", "completed", 1).await;
}

#[tokio::test]
async fn activity_after_delete_first_poll_preserves_original_admission() {
    exercise_kind("delete", "started", 1).await;
}

#[tokio::test]
async fn fork_close_with_expired_deadline_and_closed_caller_still_awaits_actual_reply() {
    exercise_kind("fork-close", "clear", 1).await;
}

#[tokio::test]
async fn started_fork_close_with_closed_caller_keeps_actual_reply_after_activity() {
    exercise_kind("fork-close", "started", 1).await;
}

#[tokio::test]
async fn received_activity_before_unstarted_fork_close_still_preserves_work() {
    exercise_kind("fork-close", "in-progress", 0).await;
}

#[tokio::test]
async fn stopped_tool_close_rechecks_context_and_other_work_before_first_wire_poll() {
    exercise_kind("stopped-close", "context-changed", 0).await;
    exercise_kind("stopped-close", "in-progress", 0).await;
    exercise_kind("stopped-close", "clear", 1).await;
}
