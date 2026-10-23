//! Actual official Lines parser/Channel/Client, isolated synthetic bytes only.
use super::*;
use crate::acp_client::{
    ingress_permit::{ConsumerProbe, Gate, PermittedRead, QueueSnapshot},
    lifecycle::ConnectionLife,
    operations::{Operation, execute},
};
use agent_client_protocol::{ByteStreams, Channel, Client, ConnectTo, UntypedMessage};
use futures_lite::{StreamExt, io};
use serde_json::{Value, json};
use std::{
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::oneshot;

struct Bytes {
    input: mpsc::UnboundedReceiver<Vec<u8>>,
    current: std::io::Cursor<Vec<u8>>,
}
impl io::AsyncRead for Bytes {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        use std::io::Read;
        loop {
            if self.current.position() < self.current.get_ref().len() as u64 {
                return Poll::Ready(self.current.read(out));
            }
            match self.input.poll_recv(cx) {
                Poll::Ready(Some(bytes)) => self.current = std::io::Cursor::new(bytes),
                Poll::Ready(None) => return Poll::Ready(Ok(0)),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

async fn prefix(count: usize, expect_unknown: bool, batch: bool) {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let routes = life.routes.clone();
    let original = routes.clone();
    let (client, endpoint) = Channel::duplex();
    let snapshot = endpoint.tx.clone();
    let gate = Gate::with_budget(
        1,
        move || QueueSnapshot {
            queued: snapshot.len(),
            closed: snapshot.is_closed(),
        },
        routes.unclaimed_budget(),
    )
    .unwrap();
    let probe = ConsumerProbe::default();
    probe.install(&gate).unwrap();
    let (send_bytes, receive_bytes) = mpsc::unbounded_channel();
    let transport = ByteStreams::new(
        io::sink(),
        PermittedRead::new(
            Bytes {
                input: receive_bytes,
                current: std::io::Cursor::new(Vec::new()),
            },
            gate.clone(),
        ),
    );
    let (mut wire, parser) = ConnectTo::<Client>::into_channel_and_future(transport);
    let Channel { mut rx, tx } = endpoint;
    let source = async move {
        let first = rx.next().await.unwrap().to_json().unwrap();
        let id = serde_json::from_str::<Value>(&first).unwrap()["id"].clone();
        let mut frames = Vec::new();
        for n in 0..count {
            frames.push(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"created","update":{"sessionUpdate":"_opaque","n":n,"unknown":[null,false,n]}}}));
        }
        frames.push(json!({"jsonrpc":"2.0","id":id,"result":{"sessionId":"created"}}));
        let mut bytes = Vec::new();
        if batch {
            serde_json::to_writer(&mut bytes, &frames).unwrap();
            bytes.push(b'\n');
        } else {
            for frame in frames {
                serde_json::to_writer(&mut bytes, &frame).unwrap();
                bytes.push(b'\n');
            }
        }
        send_bytes.send(bytes).unwrap();
        while rx.next().await.is_some() {}
        drop(send_bytes);
    };
    let forwarding = async move {
        while let Some(frame) = wire.rx.next().await {
            gate.forward(frame, |frame| {
                tx.unbounded_send(frame)
                    .map_err(|error| Box::new(error.into_inner()))
            })
            .unwrap();
        }
    };
    let connection = Client
        .builder()
        .on_receive_dispatch(
            async move |dispatch: Dispatch, _cx| original.dispatch(dispatch),
            agent_client_protocol::on_receive_dispatch!(),
        )
        .connect_with(client, async move |cx| {
            let (send, receive) = oneshot::channel();
            let operation = Operation::new();
            let (cancel_wait, wait_cancel) = oneshot::channel::<()>();
            let _lease = life.operation("open:new".into()).unwrap();
            let action_routes = routes.clone();
            let action = execute(
                send,
                life.clone(),
                operation,
                tokio::time::Instant::now() + Duration::from_secs(30),
                true,
                async move {
                    let request =
                        UntypedMessage::new("session/new", json!({})).map_err(|e| e.to_string())?;
                    let response: Value = cx
                        .send_request(request)
                        .block_task()
                        .await
                        .map_err(|e| e.to_string())?;
                    let (send, mut inbox) = action_routes.channel();
                    let _guard = action_routes
                        .register(
                            response["sessionId"].as_str().unwrap(),
                            send,
                            Arc::new(AtomicBool::new(false)),
                            Arc::new(|_| {}),
                        )
                        .unwrap();
                    for n in 0..count {
                        let message = inbox.recv().await.unwrap();
                        assert_eq!(message.message().unwrap().params()["update"]["n"], n);
                    }
                    assert!(inbox.try_recv().is_err());
                    Ok::<_, String>(())
                },
            );
            let observe = async {
                let outcome = tokio::time::timeout(Duration::from_secs(2), receive)
                    .await
                    .expect("known result or explicit unknown must be delivered promptly")
                    .unwrap();
                if expect_unknown {
                    assert!(outcome.unwrap_err().contains("结果尚未确认"));
                    {
                        let state = routes.state.lock().unwrap();
                        assert!(state.pending.len() >= 256 && state.pending.len() < count);
                        for (n, queued) in state.pending.iter().enumerate() {
                            assert_eq!(
                                queued.message.message().unwrap().params()["update"]["n"],
                                n
                            );
                        }
                    }
                    assert!(
                        !life.finished(),
                        "no automatic stop or fabricated completion"
                    );
                    assert!(
                        life.operation("open:new".into()).is_err(),
                        "original ownership must exclude retry"
                    );
                    let other = Routes::default();
                    assert!(!Arc::ptr_eq(
                        &routes.unclaimed_budget(),
                        &other.unclaimed_budget()
                    ));
                    assert!(!Arc::ptr_eq(&routes.unclaimed_budget(), &Budget::shared()));
                    assert!(!other.unclaimed_budget().saturated());
                    // A second real official connection must reach its own ID
                    // and exact replay while the first retains unknown debt.
                    Box::pin(prefix(3, false, false)).await;
                    assert!(routes.unclaimed_budget().saturated());
                    assert!(
                        tokio::time::timeout(Duration::from_millis(10), wait_cancel)
                            .await
                            .is_err(),
                        "original action must still be retained after early delivery"
                    );
                    life.close(true, None).unwrap();
                    life.finish(Ok(()));
                } else {
                    outcome.unwrap();
                    assert_eq!(routes.unclaimed_budget().retained(), (0, 0));
                }
            };
            let action = async {
                let result = action.await;
                let _ = cancel_wait.send(());
                result
            };
            tokio::join!(action, observe);
            Ok(())
        });
    tokio::time::timeout(Duration::from_secs(4), async {
        tokio::select! {
            result=probe.observe(connection)=>result.unwrap(),
            _=async {let (result,(),())=tokio::join!(parser,source,forwarding);result.unwrap();}=>panic!("wire cannot end before controlled client"),
        }
    }).await.unwrap();
}

#[tokio::test]
async fn actual_sdk_new_prefix_delivers_explicit_unknown_without_discard_retry_or_global_stall() {
    prefix(512, true, false).await;
}
#[tokio::test]
async fn actual_sdk_new_id_releases_only_exact_pending_in_original_order() {
    prefix(12, false, false).await;
}

#[tokio::test]
async fn actual_sdk_current_batch_ready_id_wins_over_unclaimed_pressure_and_preserves_every_entry()
{
    prefix(512, false, true).await;
}
