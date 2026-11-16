use super::*;
use serde_json::json;
use std::io;
use std::os::unix::net::UnixStream;

fn post(value: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(value).unwrap();
    let mut bytes = format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:0\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
    bytes.extend(body);
    bytes
}
fn body(bytes: &[u8]) -> Value {
    let end = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap() + 4;
    let header = std::str::from_utf8(&bytes[..end]).unwrap();
    let count: usize = header
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(
        count,
        bytes.len() - end,
        "full response uses exact JSON length"
    );
    serde_json::from_slice(&bytes[end..]).unwrap()
}
#[test]
fn actual_official_post_is_incremental_and_bound_to_fixed_endpoint() {
    let message = json!({"jsonrpc":"2.0","id":12,"method":"tools/list"});
    let bytes = post(&message);
    for split in 0..bytes.len() {
        assert!(http::parse(&bytes[..split]).unwrap().is_none());
    }
    let Some(http::Request::Post(parsed)) = http::parse(&bytes).unwrap() else {
        panic!("POST expected");
    };
    assert_eq!(parsed, message);
    let absolute = String::from_utf8(bytes.clone())
        .unwrap()
        .replacen("/mcp", http::URI, 1);
    assert!(matches!(
        http::parse(absolute.as_bytes()).unwrap(),
        Some(http::Request::Post(_))
    ));
    for target in [
        "/other",
        "http://example.com/mcp",
        "http://127.0.0.1:1/mcp",
        "/mcp?token=secret",
    ] {
        let changed = String::from_utf8(bytes.clone())
            .unwrap()
            .replacen("/mcp", target, 1);
        assert!(http::parse(changed.as_bytes()).is_err());
    }
}
#[test]
fn ambiguous_framing_credentials_and_pipelining_are_rejected() {
    let valid = String::from_utf8(post(&json!({}))).unwrap();
    for header in [
        "Content-Length: 2\r\n",
        "Transfer-Encoding: chunked\r\n",
        "Authorization: Bearer synthetic\r\n",
        "Expect: 100-continue\r\n",
        "Host: 127.0.0.1:0\r\n",
        " folded: value\r\n",
    ] {
        let changed = valid.replacen("Content-Type:", &format!("{header}Content-Type:"), 1);
        assert!(http::parse(changed.as_bytes()).is_err(), "{header}");
    }
    assert!(http::parse(format!("{valid}{valid}").as_bytes()).is_err());
    let huge = valid.replace("Content-Length: 2", "Content-Length: 65537");
    assert!(http::parse(huge.as_bytes()).is_err());
    assert!(http::parse(&vec![b'A'; 8193]).is_err());
    let wrong_host = valid.replace("127.0.0.1:0", "example.com");
    assert!(http::parse(wrong_host.as_bytes()).is_err());
}
#[test]
fn get_and_delete_are_unsupported_transport_methods_not_page_stop() {
    for method in ["GET", "DELETE"] {
        let bytes = format!("{method} /mcp HTTP/1.1\r\nHost: 127.0.0.1:0\r\n\r\n");
        assert!(matches!(
            http::parse(bytes.as_bytes()).unwrap(),
            Some(http::Request::MethodNotAllowed)
        ));
    }
    let bytes = http::response(405, &[]).unwrap();
    assert!(bytes.starts_with(b"HTTP/1.1 405"));
    assert!(!String::from_utf8_lossy(&bytes).contains("stop"));
}
#[test]
fn same_protocol_retains_initialize_and_list_across_real_http_connections() {
    let mut protocol = protocol::Protocol::new(true);
    let messages = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_page_snapshot","arguments":{}}}),
    ];
    for (index, value) in messages.iter().enumerate() {
        let (mut remote, socket) = UnixStream::pair().unwrap();
        remote.write_all(&post(value)).unwrap();
        let mut client = Client::new(index as u64, socket).unwrap();
        let Some(http::Request::Post(value)) = client.request(&|_| true).unwrap() else {
            panic!("full POST");
        };
        let action = protocol.receive(value);
        match index {
            0 => assert!(matches!(action, protocol::Action::Reply { .. })),
            1 => assert!(matches!(action, protocol::Action::None)),
            2 => {
                let protocol::Action::Reply { value, list: true } = action else {
                    panic!("list");
                };
                let mut out = Output::json(value, true, false).unwrap();
                assert!(matches!(
                    out.advance(&mut client.stream).unwrap(),
                    Progress::Complete
                ));
                assert!(protocol.mark_list_delivered());
            }
            3 => assert!(
                matches!(action, protocol::Action::Read { id, request: ToolRequest::Read } if id==json!(3))
            ),
            _ => unreachable!(),
        }
    }
}
#[test]
fn queued_page_response_rechecks_scope_before_any_socket_bytes() {
    let (grant, _) = crate::browser_workspace::sharing_scope_fixture("task", "page");
    let mut wire = Wire::default();
    wire.reply(
        protocol::snapshot(json!(7), json!({"text":"unreleased page content"})),
        Some(grant.clone()),
        false,
    )
    .unwrap();
    let mut out = Output::packet(wire.packets.pop_front().unwrap()).unwrap();
    grant.revoke();
    let mut bytes = Vec::new();
    assert!(matches!(
        out.advance(&mut bytes).unwrap(),
        Progress::Withdrawn(_)
    ));
    assert!(bytes.is_empty());
    assert!(matches!(
        out.advance(&mut bytes).unwrap(),
        Progress::Complete
    ));
    assert_eq!(body(&bytes)["id"], 7);
    assert_eq!(body(&bytes)["result"]["isError"], true);
    assert!(!String::from_utf8_lossy(&bytes).contains("unreleased page content"));
}
#[test]
fn queued_control_cancellation_returns_unknown_not_false_not_applied() {
    let (grant, _) = crate::browser_workspace::sharing_scope_fixture("task", "page");
    let scope = grant.one_shot().unwrap();
    let mut wire = Wire::default();
    wire.control_reply(
        protocol::snapshot(json!(8), json!({"outcome":"dispatched","applied":true})),
        scope.clone(),
    )
    .unwrap();
    let mut out = Output::packet(wire.packets.pop_front().unwrap()).unwrap();
    scope.cancel_action();
    let mut bytes = Vec::new();
    assert!(matches!(
        out.advance(&mut bytes).unwrap(),
        Progress::Withdrawn(_)
    ));
    assert!(matches!(
        out.advance(&mut bytes).unwrap(),
        Progress::Complete
    ));
    assert_eq!(
        body(&bytes)["result"]["structuredContent"]["outcome"],
        "unknown"
    );
    assert_eq!(
        body(&bytes)["result"]["structuredContent"]["applied"],
        Value::Null
    );
    assert!(grant.is_valid());
}
struct Prefix(Vec<u8>);
impl Write for Prefix {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let n = bytes.len().min(9);
        self.0.extend_from_slice(&bytes[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[test]
fn partially_written_response_cannot_be_replaced_or_acknowledged_as_complete() {
    let (grant, _) = crate::browser_workspace::sharing_scope_fixture("task", "page");
    let mut wire = Wire::default();
    wire.reply(
        protocol::snapshot(json!(4), json!({"text":"body"})),
        Some(grant.clone()),
        false,
    )
    .unwrap();
    let mut out = Output::packet(wire.packets.pop_front().unwrap()).unwrap();
    let mut sink = Prefix(Vec::new());
    assert!(matches!(out.advance(&mut sink).unwrap(), Progress::Pending));
    let sent = sink.0.clone();
    grant.revoke();
    assert!(matches!(
        out.advance(&mut sink).unwrap(),
        Progress::Partial(_)
    ));
    assert_eq!(sink.0, sent);
    assert!(
        wire.delivery.is_some(),
        "no remote/buffered write receipt synthesized"
    );
}
#[test]
fn actual_socket_stop_closes_inflight_output_and_preserves_partial_unknown() {
    let (mut remote, socket) = UnixStream::pair().unwrap();
    let mut client = Client::new(10, socket).unwrap();
    let mut output = Output::json(protocol::result(json!(8), json!({})), false, false).unwrap();
    struct ShortSocket<'a>(&'a mut UnixStream);
    impl Write for ShortSocket<'_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.write(&bytes[..bytes.len().min(9)])
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }
    assert!(matches!(
        output
            .advance(&mut ShortSocket(&mut client.stream))
            .unwrap(),
        Progress::Pending
    ));
    client.output = Some(output);
    let mut clients = vec![client];
    let mut active = Some(10);
    let mut wire = Wire::default();
    assert!(!stop_calls(&mut clients, &mut active, &mut wire));
    let mut bytes = Vec::new();
    remote.read_to_end(&mut bytes).unwrap();
    assert_eq!(
        bytes, b"HTTP/1.1 ",
        "only the actual partial header precedes EOF"
    );
    assert!(active.is_none());
    assert!(wire.delivery.is_none());
    assert!(
        stop_calls(&mut clients, &mut active, &mut wire),
        "later explicit check can observe no writers"
    );
}
#[test]
fn cancelled_call_never_revokes_other_page_requests_or_the_page_grant() {
    let (grant, _) = crate::browser_workspace::sharing_scope_fixture("task", "page");
    let second = grant.request_scope();
    let mut wire = Wire::default();
    wire.reply(
        protocol::snapshot(json!(1), json!({"text":"body"})),
        Some(grant.clone()),
        false,
    )
    .unwrap();
    let original = wire.delivery.as_ref().unwrap().scope.clone().unwrap();
    discard_call(&mut wire);
    assert!(!original.is_valid());
    assert!(second.is_valid());
    assert!(grant.is_valid());
}
#[test]
fn full_json_socket_write_is_delivery_not_model_consumption() {
    let (mut remote, mut socket) = UnixStream::pair().unwrap();
    let mut wire = Wire::default();
    wire.reply(
        protocol::result(json!(19), json!({"value":"public"})),
        None,
        false,
    )
    .unwrap();
    let mut out = Output::packet(wire.packets.pop_front().unwrap()).unwrap();
    let number = out.delivery.unwrap();
    assert!(wire.delivery.is_some());
    assert!(matches!(
        out.advance(&mut socket).unwrap(),
        Progress::Complete
    ));
    assert_eq!(wire.acknowledge_written(number), Some(false));
    socket.shutdown(Shutdown::Both).unwrap();
    let mut actual = Vec::new();
    remote.read_to_end(&mut actual).unwrap();
    assert_eq!(body(&actual)["result"]["value"], "public");
}
#[test]
fn listener_barrier_closes_already_queued_unparsed_requests() {
    let endpoint = channel::create().unwrap();
    let mut remote = UnixStream::connect(&endpoint.path).unwrap();
    remote
        .write_all(&post(
            &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        ))
        .unwrap();
    assert!(drain_listener(&endpoint.listener));
    let mut byte = [0u8; 1];
    let result = remote.read(&mut byte);
    assert!(matches!(result, Ok(0)) || result.is_err());
    assert!(drain_listener(&endpoint.listener));
}

fn listed_protocol() -> protocol::Protocol {
    let mut protocol = protocol::Protocol::new(true);
    protocol.receive(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{}}}));
    protocol.receive(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
    protocol.mark_list_delivered();
    protocol
}
fn local_client(key: u64) -> (UnixStream, Client) {
    let (remote, stream) = UnixStream::pair().unwrap();
    (remote, Client::new(key, stream).unwrap())
}
#[test]
fn discovery_fallback_does_not_consume_initialization_or_create_another_session() {
    let (_remote, mut client) = local_client(1);
    let mut protocol = protocol::Protocol::new(true);
    let mut wire = Wire::default();
    let mut active = None;
    dispatch_request(
        http::Request::Post(json!({"jsonrpc":"2.0","id":4,"method":"server/discover","params":{}})),
        &mut client,
        &mut protocol,
        &mut wire,
        &mut active,
        |_, _| panic!("no page work"),
    )
    .unwrap();
    let mut bytes = Vec::new();
    client.output.as_mut().unwrap().advance(&mut bytes).unwrap();
    assert_eq!(body(&bytes)["error"]["code"], -32601);
    dispatch_request(http::Request::Post(json!({"jsonrpc":"2.0","id":5,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{}}})), &mut client, &mut protocol, &mut wire, &mut active, |_,_| panic!("no page work")).unwrap();
    assert!(client.output.as_ref().unwrap().initialized);
    let mut bytes = Vec::new();
    client.output.as_mut().unwrap().advance(&mut bytes).unwrap();
    assert_eq!(body(&bytes)["result"]["protocolVersion"], "2025-06-18");
    assert!(active.is_none());
}
#[test]
fn simultaneous_read_is_rejected_without_replacing_original_pending_work() {
    let (_remote, mut client) = local_client(2);
    let mut protocol = listed_protocol();
    let mut wire = Wire::default();
    let mut active = Some(1);
    dispatch_request(http::Request::Post(json!({"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"read_page_snapshot","arguments":{}}})), &mut client, &mut protocol, &mut wire, &mut active, |_,_| panic!("second call cannot execute")).unwrap();
    assert_eq!(active, Some(1));
    let mut bytes = Vec::new();
    client.output.as_mut().unwrap().advance(&mut bytes).unwrap();
    assert_eq!(body(&bytes)["id"], 20);
    assert_eq!(body(&bytes)["result"]["isError"], true);
}
#[test]
fn cancellation_post_reaches_original_pending_native_request_without_waiting_for_its_result() {
    let (_remote, mut client) = local_client(2);
    let mut protocol = listed_protocol();
    let (grant, _) = crate::browser_workspace::sharing_scope_fixture("task", "page");
    let request = grant.request_scope();
    let (_sender, receive) = mpsc::channel();
    let task = tauri::async_runtime::spawn(std::future::pending::<()>());
    let mut wire = Wire {
        pending: Some(PendingRead {
            id: json!(9),
            scope: request.clone(),
            result: receive,
            task,
            request: ToolRequest::Read,
            finished: Arc::new(AtomicBool::new(false)),
        }),
        ..Default::default()
    };
    let mut active = Some(1);
    dispatch_request(
        http::Request::Post(
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9}}),
        ),
        &mut client,
        &mut protocol,
        &mut wire,
        &mut active,
        |_, _| panic!("cancel never starts work"),
    )
    .unwrap();
    assert!(wire.pending.is_none());
    assert!(!request.is_valid());
    assert!(grant.is_valid());
    let packet: Value = serde_json::from_slice(&wire.packets[0].bytes).unwrap();
    assert_eq!(packet["message"]["id"], 9);
    assert_eq!(packet["message"]["result"]["isError"], true);
    let mut bytes = Vec::new();
    client.output.as_mut().unwrap().advance(&mut bytes).unwrap();
    assert!(
        bytes.starts_with(b"HTTP/1.1 202"),
        "notification accepted, not a stop receipt"
    );
}
#[test]
fn remote_helper_ack_packets_cannot_confirm_http_delivery_or_stop() {
    let mut protocol = listed_protocol();
    let mut wire = Wire::default();
    wire.reply(protocol::result(json!(77), json!({})), None, false)
        .unwrap();
    let number = wire.delivery.as_ref().unwrap().number;
    let mut active = Some(1);
    for value in [
        json!({"kind":"written","delivery":number}),
        json!({"kind":"stopped","barrier":number,"stdoutClosed":true}),
    ] {
        let (_remote, mut client) = local_client(2);
        dispatch_request(
            http::Request::Post(value),
            &mut client,
            &mut protocol,
            &mut wire,
            &mut active,
            |_, _| panic!("no page dispatch"),
        )
        .unwrap();
        assert_eq!(wire.delivery.as_ref().unwrap().number, number);
        let mut bytes = Vec::new();
        client.output.as_mut().unwrap().advance(&mut bytes).unwrap();
        assert_eq!(body(&bytes)["error"]["code"], -32600);
    }
}

#[test]
fn identity_loss_after_partial_input_prevents_completed_request_admission() {
    let (mut remote, mut client) = local_client(1);
    let request = post(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}));
    let split = request.len() - 1;
    remote.write_all(&request[..split]).unwrap();
    assert!(client.request(&|_| true).unwrap().is_none());
    remote.write_all(&request[split..]).unwrap();
    assert!(client.request(&|_| false).is_err());
    assert!(!client.accepted);
}
#[test]
fn identity_loss_before_final_write_emits_no_response_bytes() {
    let (mut remote, mut client) = local_client(1);
    client.output = Some(
        Output::json(
            protocol::result(json!(1), json!({"text":"private fixture body"})),
            false,
            false,
        )
        .unwrap(),
    );
    assert!(client.write(&|_| false).is_err());
    assert_eq!(client.output.as_ref().unwrap().offset, 0);
    client.close();
    let mut bytes = Vec::new();
    remote.read_to_end(&mut bytes).unwrap();
    assert!(bytes.is_empty());
}
