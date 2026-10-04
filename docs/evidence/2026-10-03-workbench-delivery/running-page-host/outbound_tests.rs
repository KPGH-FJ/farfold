#[path="outbound.rs"]mod outbound;
use outbound::OutboundGate;
use std::{io::{Read,Write},os::unix::net::UnixStream,sync::{Arc,Mutex,mpsc},thread,time::Duration};

#[test]
fn revoke_cannot_ack_between_final_gate_and_socket_write(){
 let gate=Arc::new(OutboundGate::default());let authorized=Arc::new(Mutex::new(true));
 let order=Arc::new(Mutex::new(Vec::new()));
 let (mut producer,mut consumer)=UnixStream::pair().unwrap();
 consumer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
 let (at_gate,gate_reached)=mpsc::channel();let (release,proceed)=mpsc::channel();
 let (revoking,revoke_started)=mpsc::channel();let (acked,ack)=mpsc::channel();
 let writer_gate=gate.clone();let writer_auth=authorized.clone();let writer_order=order.clone();
 let writer=thread::spawn(move||writer_gate.run(||*writer_auth.lock().unwrap(),|allowed|{
  at_gate.send(()).unwrap();proceed.recv_timeout(Duration::from_secs(2)).unwrap();
  assert!(allowed);producer.write_all(b"synthetic-current-page\n").unwrap();writer_order.lock().unwrap().push("body-written");
 }));
 gate_reached.recv_timeout(Duration::from_secs(1)).unwrap();
 let revoker_gate=gate.clone();let revoker_auth=authorized.clone();let revoker_order=order.clone();
 let revoker=thread::spawn(move||{revoking.send(()).unwrap();revoker_gate.run(||{*revoker_auth.lock().unwrap()=false;},|_|{revoker_order.lock().unwrap().push("revoked-ack");acked.send(()).unwrap();});});
 revoke_started.recv_timeout(Duration::from_secs(1)).unwrap();
 // A bounded observation of ACK ordering while the actual writer is paused
 // precisely after its authorization result and before the socket write.
 let early_ack=ack.recv_timeout(Duration::from_millis(50)).is_ok();
 release.send(()).unwrap();writer.join().unwrap();revoker.join().unwrap();
 let mut bytes=String::new();consumer.read_to_string(&mut bytes).unwrap();
 assert_eq!(bytes,"synthetic-current-page\n");
 assert!(!early_ack,"revocation ACK escaped before the pending authorized write");
 assert_eq!(*order.lock().unwrap(),vec!["body-written","revoked-ack"]);
 assert!(!gate.run(||*authorized.lock().unwrap(),|authorized|authorized));
}
