//! In-process protocol ordering tests: no timer-based replay assumptions.
use super::{operations::Operation, pump::await_route_registration};
use agent_client_protocol::{
    Agent, Client, ConnectionTo, Dispatch, HandleDispatchFrom, Handled, UntypedMessage,
};
use serde_json::json;
use std::future::{Future, poll_fn};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::task::Poll;
use tokio::sync::{mpsc, oneshot};

struct CaptureRoute(mpsc::UnboundedSender<Dispatch>);
impl HandleDispatchFrom<Agent> for CaptureRoute {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        _cx: ConnectionTo<Agent>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        if message.message().is_some_and(|message| {
            message
                .params()
                .get("sessionId")
                .and_then(serde_json::Value::as_str)
                == Some("history")
        }) {
            self.0.send(message).unwrap();
            return Ok(Handled::Yes);
        }
        Ok(Handled::No {
            message,
            retry: false,
        })
    }
    fn describe_chain(&self) -> impl std::fmt::Debug {
        "test-capture-route"
    }
}

async fn blocked_registration(abandon: bool) {
    let (started, start) = oneshot::channel();
    let started = Arc::new(Mutex::new(Some(started)));
    let (release, released) = oneshot::channel();
    let released = Arc::new(Mutex::new(Some(released)));
    let loads = Arc::new(AtomicUsize::new(0));
    let peer_loads = loads.clone();
    let peer = Agent.builder().on_receive_dispatch(
        async move |message: Dispatch, cx: ConnectionTo<Client>| {
            if let Dispatch::Request(request, responder) = message {
                match request.method() {
                    "fixture/hold" => cx.send_notification(UntypedMessage::new("fixture/hold", json!({}))?)?,
                    "session/load" => {
                        peer_loads.fetch_add(1, Ordering::SeqCst);
                        cx.send_notification(UntypedMessage::new("session/update", json!({"sessionId":"history","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"replayed"}}}))?)?;
                    }
                    _ => {}
                }
                responder.respond(json!({}))?;
                return Ok(Handled::Yes);
            }
            Ok(Handled::No { message, retry: false })
        },
        agent_client_protocol::on_receive_dispatch!(),
    );
    let connection = Client
        .builder()
        .on_receive_dispatch(
            async move |message: Dispatch, _cx| {
                if message
                    .message()
                    .is_some_and(|message| message.method() == "fixture/hold")
                {
                    let notify = started.lock().unwrap().take().unwrap();
                    let wait = released.lock().unwrap().take().unwrap();
                    notify.send(()).unwrap();
                    wait.await.unwrap();
                    return Ok(Handled::Yes);
                }
                let retry = message
                    .message()
                    .is_some_and(|message| message.params().get("sessionId").is_some());
                Ok(Handled::No { message, retry })
            },
            agent_client_protocol::on_receive_dispatch!(),
        )
        .connect_with(peer, async move |cx| {
            let hold = cx.send_request_to(Agent, UntypedMessage::new("fixture/hold", json!({}))?);
            start.await.unwrap();
            let (send, mut receive) = mpsc::unbounded_channel();
            let _route = cx.add_dynamic_handler(CaptureRoute(send))?;
            let operation = Operation::new();
            let mut load = std::pin::pin!(async {
                await_route_registration(&cx, &operation).await?;
                operation
                    .request(
                        &cx,
                        cx.send_request_to(
                            Agent,
                            UntypedMessage::new("session/load", json!({"sessionId":"history"}))
                                .unwrap(),
                        ),
                    )
                    .await
                    .map_err(super::pump::describe_acp_error)
            });
            // The incoming actor is deliberately held. Poll once to establish that
            // setup cannot publish load while registration is merely queued.
            poll_fn(|context| {
                assert!(matches!(load.as_mut().poll(context), Poll::Pending));
                Poll::Ready(())
            })
            .await;
            assert_eq!(loads.load(Ordering::SeqCst), 0);
            if abandon {
                operation.abandon();
                assert!(load.await.unwrap_err().contains("取消"));
                assert_eq!(loads.load(Ordering::SeqCst), 0);
                release.send(()).unwrap();
            } else {
                release.send(()).unwrap();
                load.await.unwrap();
                assert_eq!(loads.load(Ordering::SeqCst), 1);
                // The replay preceded the response and must already be in our
                // exact route's inbox, never waiting in the fallback queue.
                assert!(
                    receive
                        .try_recv()
                        .unwrap()
                        .message()
                        .is_some_and(|message| message.method() == "session/update")
                );
            }
            hold.block_task().await?;
            Ok(())
        });
    tokio::time::timeout(std::time::Duration::from_secs(3), connection)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn load_waits_for_dispatcher_route_registration_before_send() {
    blocked_registration(false).await;
}

#[tokio::test]
async fn abandoned_setup_does_not_wait_for_dispatcher_or_publish_load() {
    blocked_registration(true).await;
}
