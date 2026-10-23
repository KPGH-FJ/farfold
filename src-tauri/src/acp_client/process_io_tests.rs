//! Real owned pipes and the official ByteStreams; no installed Agent or user store.
use super::*;
use agent_client_protocol::{AcpAgentConfig, ConnectionTo, UntypedMessage};
use serde_json::{Value, json};

fn records(path: &Path) -> Vec<Value> {
    std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .collect::<Vec<_>>()
        })
        .collect()
}

async fn wait_marker(marker: &Path) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("controlled peer ready");
}

async fn final_io(logs: &Path) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(value) = records(logs)
                .into_iter()
                .rev()
                .find_map(|value| value.get("transportIo").cloned())
            {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("parent pipe observations must survive cancellation and cleanup")
}

async fn witness(source: &str, closed_input: bool) -> (tempfile::TempDir, Value, Vec<Value>) {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("synthetic_peer.py");
    let marker = root.path().join("ready");
    let logs = root.path().join("logs");
    std::fs::write(&script, source).unwrap();
    let diagnostics = Diagnostics::open(&logs, "pipe-diagnostic-fixture");
    let control = ProcessControl::new(diagnostics.clone());
    let life = ConnectionLife::new();
    let ingress = life.ingress.clone();
    let transport = ProcessTransport {
        agent: AcpAgent::new(AcpAgentConfig::new("/usr/bin/python3").args([
            "-u".to_owned(),
            script.to_string_lossy().into_owned(),
            marker.to_string_lossy().into_owned(),
        ])),
        control: control.clone(),
        life,
        data_dir: root.path().to_owned(),
        agent_id: "pipe-diagnostic-fixture".into(),
        cwd: root.path().to_string_lossy().into_owned(),
        diagnostics: diagnostics.clone(),
    };
    let request_diagnostics = diagnostics.clone();
    let result = tokio::time::timeout(
        Duration::from_millis(500),
        ingress.observe(Client.builder().name("fixture").connect_with(
            transport,
            move |cx: ConnectionTo<Agent>| async move {
                wait_marker(&marker).await;
                request_diagnostics.phase(Phase::Initialize);
                let message = UntypedMessage::new("initialize", json!({"protocolVersion":1}))?;
                let _: Value = cx.send_request(message).block_task().await?;
                Ok(())
            },
        )),
    )
    .await;
    if closed_input {
        assert!(
            matches!(result, Ok(Err(_))),
            "broken input must stay an error"
        );
    } else {
        assert!(
            result.is_err(),
            "partial JSON cannot become an initialize reply"
        );
    }
    control.stop();
    tokio::time::timeout(Duration::from_secs(5), control.closed())
        .await
        .unwrap()
        .unwrap();
    let all = records(&logs);
    assert!(!all.iter().any(|record| record["dir"] == "in"));
    assert!(
        all.iter()
            .any(|record| record["dir"] == "out" && record["event"] == "initialize")
    );
    assert!(
        all.iter()
            .all(|record| !record.to_string().contains("PRIVATE_PIPE_CANARY")),
        "no payload or raw error text in diagnostics"
    );
    let io = final_io(&logs).await;
    (root, io, all)
}

#[tokio::test]
async fn partial_stdout_has_pipe_bytes_with_zero_decoded_incoming_records() {
    let (_root, io, all) = witness(
        "import os,sys,time\nos.write(1,b'{\"PRIVATE_PIPE_CANARY\":')\nopen(sys.argv[1],'w').write('ready')\ntime.sleep(10)\n",
        false,
    )
    .await;
    assert!(!all.iter().any(|record| record["dir"] == "in"));
    assert!(
        all.iter()
            .any(|record| record["dir"] == "out" && record["event"] == "initialize")
    );
    assert_eq!(io["completion"], "parent_wrappers_dropped");
    assert_eq!(io["stdout"]["bytes"], 23);
    assert!(io["stdin"]["bytes"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn outgoing_bridge_event_does_not_prove_a_successful_pipe_write() {
    let (_root, io, all) = witness(
        "import os,sys,time\nos.close(0)\nopen(sys.argv[1],'w').write('ready')\ntime.sleep(10)\n",
        true,
    )
    .await;
    assert!(
        all.iter()
            .any(|record| record["dir"] == "out" && record["event"] == "initialize")
    );
    assert_eq!(io["stdin"]["bytes"], 0);
    assert!(io["stdin"]["errorCount"].as_u64().unwrap() > 0);
    assert_eq!(io["stdin"]["firstError"]["operation"], "write");
    assert_eq!(io["stdin"]["firstError"]["kind"], "broken_pipe");
}
