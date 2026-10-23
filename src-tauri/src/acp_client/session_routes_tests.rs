use super::*;
use agent_client_protocol::{Channel, Client, TransportFrame, UntypedMessage};
use futures_lite::StreamExt;
use serde_json::json;
fn event(id: &str, index: usize) -> Dispatch {
    Dispatch::Notification(
        UntypedMessage::new(
            "future/update",
            json!({"sessionId":id,"index":index,"_meta":{"keep":true}}),
        )
        .unwrap(),
    )
}
#[test]
fn actual_unclaimed_dispatch_blocks_automatic_retirement_until_exact_claim_or_process_end() {
    use crate::acp_client::lifecycle::{CLOSING, ConnectionLife, READY};
    use std::time::Duration;
    let life = ConnectionLife::new();
    life.ready().unwrap();
    assert!(matches!(
        life.routes.dispatch(event("unconfirmed", 0)).unwrap(),
        Handled::Yes
    ));
    assert!(life.routes.has_unclaimed());
    assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(life.close(false, None).is_err());
    assert!(life.release_for_configuration().is_err());
    assert!(life.operation("account_change".into()).is_err());
    assert_eq!(life.state.load(Ordering::SeqCst), READY);
    assert!(!*life.stop_receiver().borrow());
    // A local view/window going away is not actual process termination.
    let (other, inbox) = life.routes.channel();
    let other = life
        .routes
        .register(
            "other",
            other,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();
    drop(other);
    drop(inbox);
    assert!(life.routes.has_unclaimed());
    assert!(life.close(true, None).unwrap());
    assert_eq!(life.state.load(Ordering::SeqCst), CLOSING);
    assert!(life.routes.has_unclaimed());
    life.finish(Ok(()));
    assert!(!life.routes.has_unclaimed());
}

#[test]
fn claiming_same_actual_pending_route_removes_only_its_unknown_retirement_block() {
    use crate::acp_client::lifecycle::ConnectionLife;
    let life = ConnectionLife::new();
    life.ready().unwrap();
    assert!(matches!(
        life.routes.dispatch(event("confirmed", 7)).unwrap(),
        Handled::Yes
    ));
    let (sender, mut inbox) = life.routes.channel();
    let _route = life
        .routes
        .register(
            "confirmed",
            sender,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();
    assert!(!life.routes.has_unclaimed());
    assert_eq!(
        inbox.try_recv().unwrap().message().unwrap().params()["index"],
        7
    );
    assert!(life.operation("account_change".into()).is_ok());
    assert!(life.release_for_configuration().unwrap());
}
#[tokio::test]
async fn pending_original_envelopes_are_charged_and_transfer_only_to_exact_original_route() {
    let budget = Budget::new(1, 1);
    let routes = Arc::new(Routes::new(budget.clone()));
    let unclaimed = routes.unclaimed_budget();
    for index in 0..3 {
        assert!(matches!(
            routes.dispatch(event("future", index)).unwrap(),
            Handled::Yes
        ));
    }
    assert_eq!(unclaimed.retained().1, 3);
    assert_eq!(budget.retained().1, 0);
    let (wrong, mut wrong_inbox) = routes.channel();
    let _wrong = routes
        .register(
            "other",
            wrong,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();
    assert!(wrong_inbox.try_recv().is_err());
    let (send, mut inbox) = routes.channel();
    let guard = routes
        .register(
            "future",
            send,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();
    assert!(
        routes
            .register(
                "future",
                routes.channel().0,
                Arc::new(AtomicBool::new(false)),
                Arc::new(|_| {})
            )
            .is_err()
    );
    for index in 0..3 {
        let message = inbox.recv().await.unwrap();
        assert_eq!(
            message.message().unwrap().params(),
            event("future", index).message().unwrap().params()
        );
    }
    assert_eq!(
        budget.retained().1,
        1,
        "last dispatch stays charged until handler finishes"
    );
    assert!(inbox.try_recv().is_err());
    assert_eq!(budget.retained(), (0, 0));
    drop(guard);
    assert!(matches!(
        routes.dispatch(event("future", 4)).unwrap(),
        Handled::Yes
    ));
    assert_eq!(unclaimed.retained().1, 1);
    assert_eq!(budget.retained().1, 0);
    routes.retire();
    assert_eq!(budget.retained(), (0, 0));
    assert_eq!(unclaimed.retained(), (0, 0));
}
#[tokio::test]
async fn actual_sdk_same_batch_new_reply_and_unknown_updates_use_owned_routes_without_retry() {
    let routes = Arc::new(Routes::new(Budget::new(32, 1)));
    let handler = routes.clone();
    let (client, mut peer) = Channel::duplex();
    let connection = Client
        .builder()
        .on_receive_dispatch(
            async move |message: Dispatch, _cx| handler.dispatch(message),
            agent_client_protocol::on_receive_dispatch!(),
        )
        .connect_with(client, async move |cx| {
            let response: serde_json::Value = cx
                .send_request(UntypedMessage::new("session/new", json!({}))?)
                .block_task()
                .await?;
            let (send, mut receive) = routes.channel();
            let _guard = routes
                .register(
                    response["sessionId"].as_str().unwrap(),
                    send,
                    Arc::new(AtomicBool::new(false)),
                    Arc::new(|_| {}),
                )
                .unwrap();
            for index in 0..4 {
                let dispatch = receive.recv().await.unwrap();
                assert_eq!(dispatch.message().unwrap().params()["index"], index);
            }
            Ok(())
        });
    let remote = async move {
        let request = peer.rx.next().await.unwrap().to_json().unwrap();
        let id = serde_json::from_str::<serde_json::Value>(&request).unwrap()["id"].clone();
        peer.tx.unbounded_send(TransportFrame::parse_json(&json!([
            {"jsonrpc":"2.0","method":"future/update","params":{"sessionId":"created","index":0}},
            {"jsonrpc":"2.0","id":id,"result":{"sessionId":"created"}},
            {"jsonrpc":"2.0","method":"future/update","params":{"sessionId":"created","index":1}},
            {"jsonrpc":"2.0","method":"future/update","params":{"sessionId":"created","index":2}},
            {"jsonrpc":"2.0","method":"future/update","params":{"sessionId":"created","index":3}}
        ]).to_string())).unwrap();
        // Original peer remains live until Client's real open body completes.
        while peer.rx.next().await.is_some() {}
    };
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        tokio::join!(connection, remote).0.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn unknown_pressure_notifies_actual_routes_once_and_never_fabricates_normal_completion() {
    let routes = Arc::new(Routes::new(Budget::new(1024, 10)));
    let notices = Arc::new(Mutex::new(Vec::new()));
    let capture = notices.clone();
    let _known = routes
        .register(
            "known",
            routes.channel().0,
            Arc::new(AtomicBool::new(false)),
            Arc::new(move |event| capture.lock().unwrap().push(event)),
        )
        .unwrap();
    for n in 0..256 {
        assert!(matches!(
            routes.dispatch(event("actual-later", n)).unwrap(),
            Handled::Yes
        ));
    }
    assert_eq!(notices.lock().unwrap().len(), 1);
    let later_notices = Arc::new(Mutex::new(Vec::new()));
    let capture = later_notices.clone();
    let _second = routes
        .register(
            "second",
            routes.channel().0,
            Arc::new(AtomicBool::new(false)),
            Arc::new(move |event| capture.lock().unwrap().push(event)),
        )
        .unwrap();
    assert_eq!(later_notices.lock().unwrap().len(), 1);
    assert!(matches!(
        routes.dispatch(event("actual-later", 256)).unwrap(),
        Handled::Yes
    ));
    assert_eq!(notices.lock().unwrap().len(), 1);
    let (send, mut inbox) = routes.channel();
    let _actual = routes
        .register(
            "actual-later",
            send,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .unwrap();
    for n in 0..257 {
        assert_eq!(
            inbox.recv().await.unwrap().message().unwrap().params()["index"],
            n
        );
    }
    assert!(inbox.try_recv().is_err());
    assert!(!routes.unclaimed_budget().saturated());
    for captured in [notices, later_notices] {
        let values = captured.lock().unwrap();
        assert_eq!(
            values.len(),
            1,
            "recovery is not an Agent completion or service confirmation"
        );
        assert_eq!(values[0]["kind"], "deliveryUnavailable");
        assert!(values[0].get("sessionId").is_none());
        assert!(values[0].get("update").is_none());
    }
}
