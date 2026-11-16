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

async fn incoming_records(action: &str, expected: usize) -> Vec<Value> {
    let f = Fixture::new();
    let original = " elif method=='session/new': reply(m,{'sessionId':os.environ.get('FIXTURE_SESSION','fixture'),'configOptions':[]})";
    let peer = PEER.replace(original, &format!(" elif method=='session/new': {action}"));
    assert_ne!(peer, PEER);
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
    let result = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await;
    assert!(
        result.is_err(),
        "the original SDK failure must reach its caller"
    );
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    let records = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let mut records = Vec::new();
            for entry in std::fs::read_dir(f.cwd.join("logs")).unwrap() {
                let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
                assert!(!text.contains("incoming-private-canary"));
                assert!(!text.contains("8675309"));
                assert!(!text.contains("peer.py"));
                for line in text.lines() {
                    if let Ok(value) = serde_json::from_str::<Value>(line)
                        && value["version"] == 1
                        && value["dir"] == "in"
                        && value["error"] == "protocol"
                    {
                        records.push(value);
                    }
                }
            }
            if records.len() >= expected {
                break records;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("bounded incoming error observation");
    assert_eq!(
        f.store.get_agent(&f.row.id).unwrap().unwrap().command,
        f.row.command
    );
    records
}

#[tokio::test(flavor = "multi_thread")]
async fn protocol_errors_incoming_real_bridge_retains_only_fixed_classes() {
    for (code, class) in [
        (-32000, "auth_required"),
        (-32800, "request_cancelled"),
        (-32002, "resource_not_found"),
        (-32603, "internal_error"),
        (-32600, "invalid_request"),
    ] {
        let records = incoming_records(&format!("send({{'id':m['id'],'error':{{'code':{code},'message':'incoming-private-canary','data':{{'secret':'incoming-private-canary'}}}}}})"), 1).await;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["protocolErrorClass"], class);
        assert_eq!(records[0]["responseIdNull"], false);
        assert_eq!(records[0]["beforeInitializeAccepted"], false);
        assert!(records[0]["wireSequence"].as_u64().unwrap() > 0);
        assert_eq!(records[0].as_object().unwrap().len(), 10);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn protocol_errors_incoming_real_bridge_null_and_custom_code_are_not_payloads() {
    let records = incoming_records("send({'id':None,'error':{'code':8675309,'message':'incoming-private-canary','data':{'secret':'incoming-private-canary'}}}); send({'id':m['id'],'error':{'code':-32602,'message':'incoming-private-canary'}})", 2).await;
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["protocolErrorClass"], "other");
    assert_eq!(records[0]["responseIdNull"], true);
    assert_eq!(records[1]["protocolErrorClass"], "invalid_params");
    assert_eq!(records[1]["responseIdNull"], false);
    assert!(
        records
            .iter()
            .all(|value| value["beforeInitializeAccepted"] == false)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn protocol_open_errors_cannot_claim_application_owned_outcomes() {
    let mut received = Vec::new();
    for (method, error) in [
        (
            "session/new",
            json!({"code":-32603,"message":"AGENT_OPEN_WAIT_CANCELLED"}),
        ),
        (
            "session/load",
            json!({"code":-32603,"message":"Error: AGENT_OPEN_TIMEOUT"}),
        ),
        (
            "session/load",
            json!({"code":-32603,"message":"AGENT_OPEN_CLOSED"}),
        ),
        (
            "session/load",
            json!({"code":-32603,"message":"fixture AGENT_INITIALIZE_TIMEOUT suffix","data":{"detail":"incoming-private-canary"}}),
        ),
        (
            "session/new",
            json!({"code":-32603,"message":"AUTH_REQUIRED"}),
        ),
        (
            "session/load",
            json!({"code":-32000,"message":"AGENT_OPEN_WAIT_CANCELLED","data":{"detail":"incoming-private-canary"}}),
        ),
    ] {
        let f = Fixture::new();
        let original = if method == "session/new" {
            " elif method=='session/new': reply(m,{'sessionId':os.environ.get('FIXTURE_SESSION','fixture'),'configOptions':[]})"
        } else {
            " elif method=='session/load': threading.Thread(target=loaded,args=(m,),daemon=True).start()"
        };
        let body = serde_json::to_string(&error.to_string()).unwrap();
        let peer = PEER.replace(
            original,
            &format!(" elif method=='{method}': send({{'id':m['id'],'error':json.loads({body})}})"),
        );
        assert_ne!(peer, PEER);
        std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
        let result = f
            .manager
            .open_session(
                &f.row,
                &f.cwd,
                (method == "session/load").then(|| "restored".into()),
                vec![],
                Arc::new(|_| {}),
                &f.store,
            )
            .await;
        f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
        received.push(result.err().expect("the peer rejected the request"));
    }
    assert_eq!(
        received,
        [
            "会话未能打开，请重试",
            "会话未能打开，请重试",
            "会话未能打开，请重试",
            "会话未能打开，请重试",
            "会话未能打开，请重试",
            "AUTH_REQUIRED",
        ],
    );
}

fn local_failure_records(f: &Fixture) -> Vec<Value> {
    std::fs::read_dir(f.cwd.join("logs"))
        .unwrap()
        .flat_map(|entry| {
            std::fs::read_to_string(entry.unwrap().path())
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect::<Vec<Value>>()
        })
        .collect()
}

async fn assert_local_failure_diagnostics(action: &str, delay_admission: bool) {
    let f = Fixture::new();
    let original = " elif method=='session/new': reply(m,{'sessionId':os.environ.get('FIXTURE_SESSION','fixture'),'configOptions':[]})";
    let peer = PEER.replace(original, &format!(" elif method=='session/new':\n  with open(sys.argv[1]+'_requested','w') as marker: marker.write('requested')\n  while not os.path.exists(sys.argv[1]+'_release'): time.sleep(.005)\n  {action}"));
    assert_ne!(peer, PEER);
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
    tokio::time::timeout(Duration::from_secs(3), f.connect())
        .await
        .expect("bounded fixture preparation connection");
    let admission = if delay_admission {
        Some(
            tokio::time::timeout(
                Duration::from_secs(3),
                crate::install_job::configuration_guard(&f.row.id),
            )
            .await
            .expect("bounded controlled admission acquisition"),
        )
    } else {
        None
    };
    let mut opening =
        Box::pin(
            f.manager
                .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store),
        );
    // connect() prepared a different process. A conversation still needs its
    // own admission, startup and initialize; none is a session/new timeout.
    tokio::time::timeout(Duration::from_secs(3), async {
        if let Some(admission) = admission {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(300)) => {}
                _ = &mut opening => panic!("open completed while admission was held"),
            }
            assert!(!f.cwd.join("listed_requested").exists());
            drop(admission);
        }
        tokio::select! {
            _ = &mut opening => panic!("open completed before the peer released its response"),
            _ = until(|| {
                f.cwd.join("listed_requested").exists()
                    && local_failure_records(&f).iter().any(|value| {
                        value["dir"] == "out" && value["event"] == "session/new"
                    })
            }) => {}
        }
    })
    .await
    .expect("bounded startup and actual peer session/new dispatch");
    std::fs::write(f.cwd.join("listed_release"), "release").unwrap();
    if action.starts_with("open(") {
        assert!(
            tokio::time::timeout(Duration::from_millis(300), opening)
                .await
                .is_err(),
            "the already-dispatched request must reach the caller timeout"
        );
        assert_eq!(
            std::fs::read_to_string(f.cwd.join("listed")).unwrap(),
            "waiting"
        );
    } else {
        let result = tokio::time::timeout(Duration::from_secs(3), opening)
            .await
            .expect("decode/EOF must produce an actual error, not a caller timeout");
        assert!(
            result.is_err(),
            "the local decode/EOF failure must reach its caller"
        );
    }
    tokio::time::timeout(
        Duration::from_secs(3),
        f.manager.disconnect(&f.row.id, &f.cwd),
    )
    .await
    .expect("bounded fixture disconnect")
    .unwrap();
    until(|| {
        local_failure_records(&f)
            .iter()
            .any(|value| value["event"] == "startup" && value["connectionRemoved"] == true)
    })
    .await;
    let mut session_requested = false;
    for value in local_failure_records(&f) {
        session_requested |= value["dir"] == "out" && value["event"] == "session/new";
        if value["version"] == 1 && value["dir"] == "in" {
            assert_ne!(value["error"], "protocol");
            assert!(value.get("protocolErrorClass").is_none());
            assert!(value.get("responseIdNull").is_none());
            assert!(value.get("beforeInitializeAccepted").is_none());
        }
    }
    assert!(session_requested);
}

#[tokio::test(flavor = "multi_thread")]
async fn protocol_errors_incoming_local_decode_eof_and_timeout_are_not_remote_errors() {
    for action in [
        "reply(m,{})",
        "sys.exit(0)",
        "open(sys.argv[1],'w').write('waiting')",
    ] {
        assert_local_failure_diagnostics(action, false).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn protocol_errors_pre_dispatch_admission_wait_is_not_a_response_timeout() {
    assert_local_failure_diagnostics("reply(m,{})", true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn protocol_errors_incoming_initialize_null_is_observation_not_request_match() {
    for accepted in [false, true] {
        let f = Fixture::new();
        let original = "  elif '--reject-init' in sys.argv: send({'id':m['id'],'error':{'code':-32602,'message':'incompatible fixture'}})";
        let action = if accepted {
            "send({'id':None,'error':{'code':-32000,'message':'incoming-private-canary'}}); reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})"
        } else {
            "send({'id':m['id'],'error':{'code':-32000,'message':'incoming-private-canary','data':{'secret':'incoming-private-canary'}}})"
        };
        let peer = PEER.replace(
            original,
            &format!("  elif '--reject-init' in sys.argv: {action}"),
        );
        assert_ne!(peer, PEER);
        std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
        let mut row = f.row.clone();
        row.args.push("--reject-init".into());
        let result = f
            .manager
            .probe_launch(&row, &f.store, std::future::pending())
            .await;
        if accepted {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err(), "AGENT_INITIALIZE_FAILED");
        }
        assert_eq!(f.store.get_agent(&f.row.id).unwrap().unwrap(), f.row);
        assert!(!f.manager.candidate_pending(&f.row.id).unwrap());
        until(|| {
            let mut observed = false;
            let mut matched = false;
            for entry in std::fs::read_dir(f.cwd.join("logs")).unwrap() {
                let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
                assert!(!text.contains("incoming-private-canary"));
                for line in text.lines() {
                    let value: Value = serde_json::from_str(line).unwrap();
                    if value["version"] == 1 && value["dir"] == "in" && value["error"] == "protocol"
                    {
                        let fields = [
                            "protocolErrorClass",
                            "responseIdNull",
                            "beforeInitializeAccepted",
                        ];
                        if fields.iter().any(|field| value.get(field).is_some()) {
                            assert_eq!(value["protocolErrorClass"], "auth_required");
                            assert_eq!(value["responseIdNull"], accepted);
                            assert_eq!(value["beforeInitializeAccepted"], true);
                        } else {
                            // A busy observer omits the entire optional group;
                            // the base protocol error and startup result remain.
                            assert!(fields.iter().all(|field| value.get(field).is_none()));
                        }
                        observed = true;
                    }
                    matched |= value["event"] == "startup"
                        && value["initializeResponse"]
                            == if accepted {
                                "matched_result"
                            } else {
                                "matched_error"
                            }
                        && value["initializeAccepted"] == accepted;
                }
            }
            observed && matched
        })
        .await;
    }
}
