//! Controlled SDK subprocess errors, never official-Agent acceptance.
use super::*;

async fn observed_error(action: &str) -> Value {
    let f = Fixture::new();
    let peer = PEER.replace(
        "  elif '--reject-init' in sys.argv: send({'id':m['id'],'error':{'code':-32602,'message':'incompatible fixture'}})",
        &format!("  elif '--reject-init' in sys.argv: {action}; reply(m,{{'protocolVersion':1,'agentCapabilities':{{}},'authMethods':[]}})"),
    );
    assert_ne!(peer, PEER);
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
    let mut row = f.row.clone();
    row.args.push("--reject-init".into());
    f.manager
        .probe_launch(&row, &f.store, std::future::pending())
        .await
        .unwrap();
    assert_eq!(f.store.get_agent(&f.row.id).unwrap().unwrap(), f.row);
    assert!(!f.manager.candidate_pending(&f.row.id).unwrap());
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            for entry in std::fs::read_dir(f.cwd.join("logs")).unwrap() {
                let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
                assert!(!text.contains("protocol-error-canary"));
                assert!(!text.contains("peer.py"));
                for line in text.lines() {
                    if let Ok(value) = serde_json::from_str::<Value>(line)
                        && value["version"] == 1
                        && value["dir"] == "out"
                        && value["error"] == "protocol"
                    {
                        return value;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("bounded outgoing error observation")
}

#[tokio::test(flavor = "multi_thread")]
async fn protocol_errors_legal_unknown_method_with_null_id_is_not_parse_failure() {
    let value = observed_error("send({'id':None,'method':'protocol-error-canary','params':{'secret':'protocol-error-canary'}}); r=json.loads(sys.stdin.readline()); assert r['error']['code']==-32601").await;
    assert_eq!(value["protocolErrorClass"], "method_not_found");
    assert_eq!(value["responseIdNull"], true);
    assert_eq!(value["beforeInitializeAccepted"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn protocol_errors_unknown_method_does_not_store_nonnull_id_or_payload() {
    let value = observed_error("send({'id':'protocol-error-canary','method':'protocol-error-canary','params':{'secret':'protocol-error-canary'}}); r=json.loads(sys.stdin.readline()); assert r['error']['code']==-32601").await;
    assert_eq!(value["protocolErrorClass"], "method_not_found");
    assert_eq!(value["responseIdNull"], false);
    assert_eq!(value["beforeInitializeAccepted"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn protocol_errors_malformed_frame_keeps_parse_class_without_line() {
    let value = observed_error("sys.stdout.write('protocol-error-canary\\n'); sys.stdout.flush(); r=json.loads(sys.stdin.readline()); assert r['error']['code']==-32700").await;
    assert_eq!(value["protocolErrorClass"], "parse_error");
    assert_eq!(value["responseIdNull"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn protocol_errors_invalid_request_keeps_only_fixed_class() {
    let value = observed_error("send({'id':None,'method':42,'params':{'secret':'protocol-error-canary'}}); r=json.loads(sys.stdin.readline()); assert r['error']['code']==-32600").await;
    assert_eq!(value["protocolErrorClass"], "invalid_request");
    assert_eq!(value["responseIdNull"], true);
}
