//! Current synchronous original-connection routing with the actual official SDK.
use super::{operations::Operation, session_routes::Routes, transient_pressure::Budget};
use agent_client_protocol::{Agent, Client, ConnectionTo, Dispatch, Handled, UntypedMessage};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

async fn busy_dispatcher(abandon: bool) {
    let routes = Arc::new(Routes::new(Budget::new(4096, 8)));
    let original = routes.clone();
    let (entered, entry) = oneshot::channel();
    let entered = Arc::new(Mutex::new(Some(entered)));
    let (release, released) = oneshot::channel();
    let released = Arc::new(Mutex::new(Some(released)));
    let (loaded, load_received) = oneshot::channel();
    let loaded = Arc::new(Mutex::new(Some(loaded)));
    let peer=Agent.builder().on_receive_dispatch(
        async move|dispatch:Dispatch,cx:ConnectionTo<Client>|{
            if let Dispatch::Request(message,responder)=dispatch {
                match message.method() {
                    "fixture/hold"=>cx.send_notification(UntypedMessage::new("fixture/hold",json!({}))?)?,
                    "session/load"=>{
                        loaded.lock().unwrap().take().unwrap().send(()).unwrap();
                        cx.send_notification(UntypedMessage::new("session/update",json!({"sessionId":"history","update":{"sessionUpdate":"_raw","_meta":{"same":true}}}))?)?;
                    }
                    _=>{}
                }
                responder.respond(json!({}))?;
                return Ok(Handled::Yes);
            }
            Ok(Handled::No{message:dispatch,retry:false})
        },agent_client_protocol::on_receive_dispatch!(),
    );
    let connection=Client.builder().on_receive_dispatch(
        async move|dispatch:Dispatch,_cx|{
            if dispatch.message().is_some_and(|message|message.method()=="fixture/hold") {
                entered.lock().unwrap().take().unwrap().send(()).unwrap();
                let wait=released.lock().unwrap().take().unwrap();
                wait.await.unwrap();
                return Ok(Handled::Yes);
            }
            original.dispatch(dispatch)
        },agent_client_protocol::on_receive_dispatch!(),
    ).connect_with(peer,async move|cx|{
        let hold=cx.send_request(UntypedMessage::new("fixture/hold",json!({}))?);
        entry.await.unwrap();
        let operation=Operation::new();
        let (send,mut receive)=routes.channel();
        // This returns immediately with the actual map populated even while
        // the incoming SDK actor is busy. No queued registration/fence request.
        let _guard=routes.register("history",send,operation.abandoned.clone(),Arc::new(|_|{})).unwrap();
        if abandon {operation.abandon();}
        let load=cx.send_request(UntypedMessage::new("session/load",json!({"sessionId":"history"}))?);
        load_received.await.unwrap();
        assert!(receive.try_recv().is_err(),"actual dispatcher is still held");
        release.send(()).unwrap();
        let _:serde_json::Value=load.block_task().await?;
        if abandon {
            assert!(receive.try_recv().is_err(),"abandoned original route cannot receive new UI events");
        } else {
            let message=receive.try_recv().unwrap();
            assert_eq!(message.message().unwrap().params(),&json!({"sessionId":"history","update":{"sessionUpdate":"_raw","_meta":{"same":true}}}));
        }
        let _:serde_json::Value=hold.block_task().await?;
        Ok(())
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), connection)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn actual_route_is_registered_before_load_even_while_official_dispatcher_is_busy() {
    busy_dispatcher(false).await;
}
#[tokio::test]
async fn original_abandoned_route_does_not_adopt_late_load_notifications() {
    busy_dispatcher(true).await;
}
