use super::*;

const CWD: &str = "/fixture/work";
const MODEL: &str = "fixture-model";
const EFFORT: &str = "high";

fn sent(exchange: &mut Exchange) -> Vec<Value> {
    let mut bytes = Vec::new();
    exchange.write(&mut bytes).unwrap();
    bytes
        .split(|&b| b == b'\n')
        .filter(|s| !s.is_empty())
        .map(|s| serde_json::from_slice(s).unwrap())
        .collect()
}

fn feed(exchange: &mut Exchange, v: Value) -> Result<()> {
    let mut buf = serde_json::to_vec(&v).unwrap();
    buf.push(b'\n');
    exchange.received(&mut buf)
}

fn initialized() -> Exchange {
    let mut ex = Exchange::new(CWD, MODEL, EFFORT).unwrap();
    let p = sent(&mut ex);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0]["method"], "initialize");
    feed(&mut ex, json!({"id":1,"result":{"userAgent":"approved/1"}})).unwrap();
    let next = sent(&mut ex);
    assert_eq!(next.len(), 2);
    assert_eq!(next[0]["method"], "initialized");
    assert_eq!(next[1]["method"], "accountSession/list");
    assert_eq!(next[1]["params"], json!({"refreshWorkspaceMetadata":false}));
    ex
}

fn accounts() -> Value {
    json!({"id":2,"result":{"activeSessionId":"private-session","sessions":[
        {"sessionId":"private-session","isActive":true,"email":"private@example.invalid","userId":"private-user",
         "selectedWorkspaceAccountId":"private-workspace","workspaces":[{"accountId":"private-workspace"}]}
    ]}})
}

fn started() -> Exchange {
    let mut ex = initialized();
    feed(&mut ex, accounts()).unwrap();
    let p = sent(&mut ex);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0]["method"], "thread/start");
    assert_eq!(
        p[0]["params"],
        json!({"model":MODEL,"modelProvider":"openai","cwd":CWD,
        "sandbox":"read-only","approvalPolicy":"on-request","approvalsReviewer":"user","ephemeral":true,
        "config":{"model_reasoning_effort":EFFORT,"web_search":"disabled"}})
    );
    ex
}

fn result() -> Value {
    json!({"id":3,"result":{"model":MODEL,"modelProvider":"openai","reasoningEffort":EFFORT,
        "approvalPolicy":"on-request","approvalsReviewer":"user","cwd":CWD,
        "sandbox":{"type":"readOnly","networkAccess":false},
        "thread":{"id":"private-thread","cwd":CWD,"ephemeral":true,"path":null,"turns":[]}}})
}

#[test]
fn only_fixed_preparation_methods_and_redacted_receipt() {
    let mut ex = started();
    let response = result();
    feed(
        &mut ex,
        json!({"method":"thread/started","params":{"thread":response["result"]["thread"]}}),
    )
    .unwrap();
    let mut wire = serde_json::to_vec(&response).unwrap();
    let tail = wire.split_off(16);
    ex.received(&mut wire).unwrap();
    assert!(!ex.done());
    wire.extend(tail);
    wire.push(b'\n');
    ex.received(&mut wire).unwrap();
    assert!(ex.done());
    feed(&mut ex,json!({"method":"thread/status/changed","params":{"threadId":"private-thread","status":{"type":"idle"}}})).unwrap();
    feed(
        &mut ex,
        json!({"method":"thread/closed","params":{"threadId":"private-thread"}}),
    )
    .unwrap();
    assert!(sent(&mut ex).is_empty());
    assert_eq!(
        serde_json::to_value(ex.finish(&wire).unwrap()).unwrap(),
        json!({
            "accountPresent":true,"workspaceReported":true,"model":MODEL,"reasoningEffort":EFFORT,"provider":"openai"
        })
    );
}

#[test]
fn returned_thread_and_permissions_must_match_the_request() {
    for (pointer, bad) in [
        ("/result/model", json!("other")),
        ("/result/reasoningEffort", Value::Null),
        ("/result/modelProvider", json!("other")),
        ("/result/cwd", json!("/other")),
        ("/result/approvalPolicy", json!("never")),
        ("/result/approvalsReviewer", json!("guardian_subagent")),
        ("/result/sandbox/type", json!("workspaceWrite")),
        ("/result/sandbox/networkAccess", json!(true)),
        ("/result/thread/ephemeral", json!(false)),
        ("/result/thread/path", json!("/saved")),
        ("/result/thread/turns", json!([{"id":"unexpected"}])),
        ("/result/thread/cwd", json!("/other")),
        ("/result/thread/id", json!("")),
    ] {
        let mut ex = started();
        let mut v = result();
        *v.pointer_mut(pointer).unwrap() = bad;
        assert_eq!(
            feed(&mut ex, v).unwrap_err().code,
            Code::InvalidOutput,
            "{pointer}"
        );
    }
    for (pointer, key) in [
        ("/result/sandbox", "networkAccess"),
        ("/result/thread", "path"),
        ("/result/thread", "turns"),
    ] {
        let mut ex = started();
        let mut v = result();
        v.pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert_eq!(
            feed(&mut ex, v).unwrap_err().code,
            Code::InvalidOutput,
            "{key}"
        );
    }
}

#[test]
fn accepts_only_a_typed_warning_from_the_verified_temporary_thread() {
    let mut exchange = started();
    feed(&mut exchange, result()).unwrap();
    feed(
        &mut exchange,
        json!({"method":"warning","params":{"threadId":"private-thread","message":"private"}}),
    )
    .unwrap();
    assert!(exchange.finish(&[]).is_ok());

    for params in [
        json!({"threadId":"different","message":"private"}),
        json!({"message":"private"}),
        json!({"threadId":"private-thread","message":true}),
    ] {
        let mut exchange = started();
        feed(&mut exchange, result()).unwrap();
        assert_eq!(
            feed(&mut exchange, json!({"method":"warning","params":params}))
                .unwrap_err()
                .code,
            Code::InvalidOutput
        );
    }
}

#[test]
fn startup_notifications_do_not_authorize_a_tool() {
    fn notice(thread: &str, status: &str) -> Value {
        json!({"method":"mcpServer/startupStatus/updated",
            "params":{"threadId":thread,"name":"private","status":status,"error":null}})
    }
    let mut exchange = started();
    feed(&mut exchange, result()).unwrap();
    for state in ["starting", "failed", "cancelled"] {
        feed(&mut exchange, notice("private-thread", state)).unwrap();
    }
    assert_eq!(
        feed(&mut exchange, notice("private-thread", "ready"))
            .unwrap_err()
            .code,
        Code::Unavailable
    );
    assert_eq!(
        feed(&mut exchange, notice("different", "failed"))
            .unwrap_err()
            .code,
        Code::InvalidOutput
    );
}

#[test]
fn unavailable_or_ambiguous_account_stops_before_thread_creation() {
    let mut ex = initialized();
    assert_eq!(
        feed(
            &mut ex,
            json!({"id":2,"error":{"code":-32601,"message":"private"}})
        )
        .unwrap_err()
        .code,
        Code::Unavailable
    );
    assert!(sent(&mut ex).is_empty());
    for (key, bad, code) in [
        ("sessionId", json!("other"), Code::InvalidOutput),
        ("isActive", json!(false), Code::InvalidOutput),
        (
            "selectedWorkspaceAccountId",
            json!("other"),
            Code::InvalidOutput,
        ),
        ("userId", Value::Null, Code::Unavailable),
    ] {
        let mut ex = initialized();
        let mut v = accounts();
        v["result"]["sessions"][0][key] = bad;
        assert_eq!(feed(&mut ex, v).unwrap_err().code, code, "{key}");
    }
    let mut ex = initialized();
    let mut v = accounts();
    let dup = v["result"]["sessions"][0].clone();
    v["result"]["sessions"].as_array_mut().unwrap().push(dup);
    assert_eq!(feed(&mut ex, v).unwrap_err().code, Code::InvalidOutput);
}

#[test]
fn rejects_misordered_responses_model_activity_and_server_requests() {
    let mut ex = Exchange::new(CWD, MODEL, EFFORT).unwrap();
    assert_eq!(
        feed(&mut ex, json!({"id":1,"result":{"userAgent":"unexpected"}}))
            .unwrap_err()
            .code,
        Code::InvalidOutput
    );
    for v in [
        json!({"id":435,"method":"item/commandExecution/requestApproval","params":{}}),
        json!({"method":"turn/started","params":{}}),
        json!({"id":2,"result":{}}),
    ] {
        let mut ex = started();
        assert_eq!(feed(&mut ex, v).unwrap_err().code, Code::InvalidOutput);
    }
    let mut ex = started();
    let first = result();
    feed(
        &mut ex,
        json!({"method":"thread/started","params":{"thread":first["result"]["thread"]}}),
    )
    .unwrap();
    let mut other = first;
    other["result"]["thread"]["id"] = json!("another-thread");
    assert_eq!(feed(&mut ex, other).unwrap_err().code, Code::InvalidOutput);
}

#[test]
fn named_fields_ambiguous_messages_and_roots_are_checked() {
    let mut ex = started();
    let mut v = result();
    v["result"]["sandbox"] = json!(["readOnly", false]);
    assert_eq!(feed(&mut ex, v).unwrap_err().code, Code::InvalidOutput);

    let mut ex = started();
    let mut v = result();
    v["result"]["runtimeWorkspaceRoots"] = json!([CWD, "/outside"]);
    assert_eq!(feed(&mut ex, v).unwrap_err().code, Code::InvalidOutput);

    let mut ex = initialized();
    let mut dup = br#"{"id":2,"id":2,"result":{}}"#.to_vec();
    dup.push(b'\n');
    assert_eq!(ex.received(&mut dup).unwrap_err().code, Code::InvalidOutput);

    let mut ex = initialized();
    assert_eq!(
        feed(&mut ex, json!({"id":null,"method":"configWarning"}))
            .unwrap_err()
            .code,
        Code::InvalidOutput
    );
}
