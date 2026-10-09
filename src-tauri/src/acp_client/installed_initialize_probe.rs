//! Explicit, ignored diagnostic only: the registered OpenCode process receives
//! initialize through the real ProcessTransport. Never run in ordinary checks.
//! No session, prompt, authentication or Agent configuration request is sent.
use super::{
    lifecycle::ConnectionLife,
    manager::runtime,
    process::{ProcessControl, ProcessTransport},
    startup_diagnostics::Diagnostics,
};
use agent_client_protocol::{
    AcpAgent, AcpAgentConfig, Agent, Client, ConnectionTo, UntypedMessage,
};
use serde_json::{Value, json};
use std::{io::Write as _, sync::atomic::Ordering, time::Duration};

#[tokio::test]
#[ignore = "manual real installed Agent initialize-only probe; requires explicit authorization"]
async fn registered_opencode_initialize_through_real_transport() {
    let home = crate::process_platform::home_dir().expect("home directory required");
    let database = home.join("Library/Application Support/ai.farfold.desktop/farfold.sqlite3");
    let database =
        rusqlite::Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("registered Agent database required");
    let (command, args, environment): (String, String, String) = database
        .query_row(
            "SELECT command,args,env FROM agents WHERE id='opencode'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("registered OpenCode required");
    let args: Vec<String> = serde_json::from_str(&args).expect("registered arguments required");
    let environment: std::collections::HashMap<String, String> =
        serde_json::from_str(&environment).expect("registered environment required");
    assert!(std::path::Path::new(&command).is_absolute());
    assert!(args == ["acp"], "review changed arguments before running");
    assert!(
        environment.is_empty(),
        "do not resolve credentials in probe"
    );
    drop(database);

    let destination = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("docs/evidence/2026-10-09-capability-hardening/opencode-rust-transport.json");
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .expect("one receipt only; no automatic retry");
    let root = tempfile::tempdir().unwrap();
    let logs = root.path().join("logs");
    let diagnostics = Diagnostics::open(&logs, "opencode");
    let control = ProcessControl::new(diagnostics.clone());
    let life = ConnectionLife::new();
    let transport = ProcessTransport {
        agent: AcpAgent::new(
            AcpAgentConfig::new(command)
                .args(args)
                .envs(crate::shell_env::command_env()),
        ),
        control: control.clone(),
        life,
        data_dir: root.path().to_owned(),
        agent_id: "opencode".into(),
        cwd: "/Users/tw/Desktop/TR".into(),
        diagnostics,
    };
    let started = std::time::Instant::now();
    let task = runtime().spawn(async move {
        Client
            .builder()
            .name("farfold")
            .connect_with(transport, |cx: ConnectionTo<Agent>| async move {
                // The installed af487016 capability set, before current work.
                let request = UntypedMessage::new(
                    "initialize",
                    &json!({
                        "protocolVersion":1,
                        "clientInfo":{"name":"farfold","version":"0.1.7"},
                        "clientCapabilities":{
                            "fs":{"readTextFile":false,"writeTextFile":false},
                            "terminal":false,
                            "session":{"configOptions":{"boolean":{}}},
                            "elicitation":{"form":{}},"auth":{"terminal":true},
                            "_meta":{"terminal-auth":true,"jetbrains":{"air":{
                                "version":1,"capabilities":["sessionFailure"]
                            }}}
                        }
                    }),
                )?;
                let response: Value = cx.send_request(request).block_task().await?;
                Ok(json!({
                    "protocolVersion":response.get("protocolVersion"),
                    "knownOpenCodeIdentity":response["agentInfo"]["name"] == "OpenCode",
                    "knownInstalledVersion":response["agentInfo"]["version"] == "1.18.31"
                }))
            })
            .await
    });
    let result = tokio::time::timeout(Duration::from_secs(60), task).await;
    let elapsed = started.elapsed().as_secs_f64();
    control.stop();
    let closed = tokio::time::timeout(Duration::from_secs(8), control.closed()).await;
    let pid = control.pid.load(Ordering::SeqCst);
    let group_gone = pid != 0 && !crate::supervisor::owned_group_alive(pid);
    let (outcome, response) = match result {
        Ok(Ok(Ok(response))) => ("initialized", response),
        Ok(Ok(Err(_))) => ("protocol_or_transport_error", Value::Null),
        Ok(Err(_)) => ("task_error", Value::Null),
        Err(_) => ("timeout", Value::Null),
    };
    let events: Vec<Value> = std::fs::read_dir(&logs)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter_map(|value| super::tap::safe_record(&value))
                .collect::<Vec<_>>()
        })
        .collect();
    let receipt = json!({
        "method":"initialize","result":outcome,"response":response,
        "responseSeconds":elapsed,"timeoutSeconds":60,
        "transport":"production ProcessTransport + macOS process_stdio + official ACP 2.2.0",
        "environment":"shell_env::command_env inherited from test process; values not recorded",
        "mainAppUntouched":true,"promptSent":false,"configWritten":false,
        "keychainRead":false,"registeredEnvironmentEntries":0,
        "ownProcessClosed":matches!(closed, Ok(Ok(()))),"ownProcessGroupGone":group_gone,
        "safeProtocolDiagnostics":events
    });
    writeln!(
        output,
        "{}",
        serde_json::to_string_pretty(&receipt).unwrap()
    )
    .unwrap();
    println!(
        "{}",
        json!({"result":outcome,"responseSeconds":elapsed,"ownProcessGroupGone":group_gone})
    );
    assert!(
        matches!(closed, Ok(Ok(()))) && group_gone,
        "owned cleanup must complete"
    );
    assert_eq!(
        outcome, "initialized",
        "see content-free diagnostic receipt"
    );
}
