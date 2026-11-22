use super::*;

const CWD: &str = "/sample/work";
const STORE: &str = "/sample/codex-app-server/sessions";
const THREAD_ID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_ID: &str = "11111111-2222-3333-4444-555555555555";
const MODEL: &str = "gpt-6-astra";
const EFFORT: &str = "ultra";
const TITLE: &str = "New conversation";

fn identity() -> AccountIdentity {
    AccountIdentity {
        user_id: "same-user".into(),
        workspace_id: "same-workspace".into(),
    }
}

fn root() -> &'static Path {
    Path::new(STORE)
}

fn path() -> PathBuf {
    root().join(format!(
        "2026/11/22/rollout-2026-11-22T10-00-00-{THREAD_ID}.jsonl"
    ))
}

fn requests(exchange: &mut Exchange) -> Vec<Value> {
    let mut output = vec![];
    exchange.write(&mut output).unwrap();
    output
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect()
}

fn inject(exchange: &mut Exchange, value: Value) -> Result<()> {
    let mut frame = serde_json::to_vec(&value).unwrap();
    frame.push(b'\n');
    exchange.received(&mut frame)?;
    assert!(frame.is_empty());
    Ok(())
}

fn respond(exchange: &mut Exchange, step: Step, result: Value) -> Result<()> {
    inject(exchange, json!({"id":step as u64,"result":result}))
}

fn accounts(login: &str, workspace: &str) -> Value {
    json!({"activeSessionId":login,"sessions":[{
        "sessionId":login,"isActive":true,"userId":"same-user",
        "selectedWorkspaceAccountId":workspace,"workspaces":[{"accountId":workspace}]
    }]})
}

fn initialized(exchange: &mut Exchange) {
    let first = requests(exchange);
    assert_eq!(first[0]["method"], "initialize");
    assert_eq!(first[0]["params"]["capabilities"]["experimentalApi"], true);
    respond(
        exchange,
        Step::Initialize,
        json!({"userAgent":"official test"}),
    )
    .unwrap();
    let messages = requests(exchange);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["method"], "initialized");
    assert_eq!(messages[1]["method"], "accountSession/list");
    assert_eq!(
        messages[1]["params"],
        json!({"refreshWorkspaceMetadata":false})
    );
}

fn open(exchange: &mut Exchange) -> Value {
    initialized(exchange);
    respond(
        exchange,
        Step::Accounts,
        accounts("other-login", "same-workspace"),
    )
    .unwrap();
    let messages = requests(exchange);
    assert_eq!(messages.len(), 1);
    messages.into_iter().next().unwrap()
}

fn thread(id: &str, rollout: Option<&Path>, title: Option<&str>) -> Value {
    json!({
        "id":id,"sessionId":id,"cwd":CWD,"ephemeral":false,"path":rollout,
        "name":title,"turns":[],
    })
}

fn official_open(thread: Value, reasoning_effort: Option<&str>) -> Value {
    json!({
        "thread":thread,"model":MODEL,"modelProvider":"openai","cwd":CWD,
        "runtimeWorkspaceRoots":[CWD],"reasoningEffort":reasoning_effort,
        "approvalPolicy":"on-request","approvalsReviewer":"user",
        "sandbox":{"type":"readOnly","networkAccess":false},
    })
}

fn verify_account(exchange: &mut Exchange, login: &str) {
    let messages = requests(exchange);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["method"], "accountSession/list");
    respond(
        exchange,
        Step::VerifyAccount,
        accounts(login, "same-workspace"),
    )
    .unwrap();
    assert!(exchange.done());
}

#[test]
fn account_only_reads_stable_identity_without_opening_a_thread() {
    let mut exchange = Exchange::account().unwrap();
    initialized(&mut exchange);
    respond(
        &mut exchange,
        Step::Accounts,
        accounts("new-login", "same-workspace"),
    )
    .unwrap();
    assert!(requests(&mut exchange).is_empty());
    assert!(exchange.finish_account(b"").unwrap() == identity());
}

#[test]
fn start_rejects_other_workspaces_before_opening_a_thread() {
    let mut exchange = Exchange::start(CWD, MODEL, EFFORT, TITLE, &identity(), root()).unwrap();
    initialized(&mut exchange);
    assert_eq!(
        respond(
            &mut exchange,
            Step::Accounts,
            accounts("new-login", "different-workspace")
        )
        .unwrap_err()
        .code,
        Code::SelectionChanged,
    );
    assert!(requests(&mut exchange).is_empty());
}

fn named_start() -> Exchange {
    let mut exchange = Exchange::start(CWD, MODEL, EFFORT, TITLE, &identity(), root()).unwrap();
    let start = open(&mut exchange);
    assert_eq!(start["method"], "thread/start");
    assert_eq!(start["params"]["cwd"], CWD);
    assert_eq!(start["params"]["sandbox"], "read-only");
    assert_eq!(start["params"]["ephemeral"], false);
    assert_eq!(start["params"]["config"]["model_reasoning_effort"], EFFORT);
    assert_eq!(start["params"]["config"]["web_search"], "disabled");
    let first = thread(THREAD_ID, None, None);
    inject(
        &mut exchange,
        json!({"method":"thread/started","params":{"thread":first}}),
    )
    .unwrap();
    respond(
        &mut exchange,
        Step::Open,
        official_open(first, Some(EFFORT)),
    )
    .unwrap();
    let save = requests(&mut exchange);
    assert_eq!(save[0]["method"], "thread/name/set");
    assert_eq!(
        save[0]["params"],
        json!({"threadId":THREAD_ID,"name":TITLE})
    );
    respond(&mut exchange, Step::Persist, json!({})).unwrap();
    let read = requests(&mut exchange);
    assert_eq!(read[0]["method"], "thread/read");
    assert_eq!(
        read[0]["params"],
        json!({"threadId":THREAD_ID,"includeTurns":false})
    );
    exchange
}

#[test]
fn new_title_only_persists_the_requested_owned_empty_thread() {
    let mut exchange = named_start();
    inject(
        &mut exchange,
        json!({"method":"thread/name/updated","params":{
            "threadId":THREAD_ID,"threadName":TITLE,
        }}),
    )
    .unwrap();
    let saved = thread(THREAD_ID, Some(&path()), Some(TITLE));
    respond(&mut exchange, Step::ReadPersisted, json!({"thread":saved})).unwrap();
    verify_account(&mut exchange, "new-login");
    let result = exchange.finish(b"").unwrap();
    assert_eq!(result.thread_id, THREAD_ID);
    assert_eq!(result.account_sha256, identity().fingerprint());
    assert_eq!(result.cwd, CWD);
    assert_eq!(result.model, MODEL);
    assert_eq!(result.effort, EFFORT);
    assert_eq!(result.provider, "openai");
    assert_eq!(result.path, Some(path()));
}

#[test]
fn persisted_path_must_be_inside_the_dedicated_history() {
    let invalid = [
        Path::new("/old/sessions").join(path().file_name().unwrap()),
        root().join("../old").join(path().file_name().unwrap()),
        root().join("unrelated.jsonl"),
    ];
    for invalid in invalid {
        let mut exchange = named_start();
        let saved = thread(THREAD_ID, Some(&invalid), Some(TITLE));
        assert_eq!(
            respond(&mut exchange, Step::ReadPersisted, json!({"thread":saved}))
                .unwrap_err()
                .code,
            Code::InvalidOutput,
        );
    }
}

fn resume() -> Exchange {
    let mut exchange = Exchange::resume(
        CWD,
        MODEL,
        EFFORT,
        THREAD_ID,
        &identity().fingerprint(),
        root(),
    )
    .unwrap();
    let request = open(&mut exchange);
    assert_eq!(request["method"], "thread/resume");
    assert_eq!(
        request["params"],
        json!({
            "threadId":THREAD_ID,"excludeTurns":true,
            "config":{"model_reasoning_effort":EFFORT},
        })
    );
    exchange
}

#[test]
fn cold_open_requires_the_saved_effort_in_the_official_resume_response() {
    let mut exchange = resume();
    respond(
        &mut exchange,
        Step::Open,
        official_open(thread(THREAD_ID, Some(&path()), Some(TITLE)), Some(EFFORT)),
    )
    .unwrap();
    inject(
        &mut exchange,
        json!({"method":"thread/goal/cleared","params":{"threadId":THREAD_ID}}),
    )
    .unwrap();
    verify_account(&mut exchange, "new-login");
    let receipt = exchange.finish(b"").unwrap();
    assert_eq!(receipt.thread_id, THREAD_ID);
    assert_eq!(receipt.effort, EFFORT);
}

#[test]
fn cold_identity_model_and_permissions_fail_closed() {
    let valid = official_open(thread(THREAD_ID, Some(&path()), Some(TITLE)), Some(EFFORT));
    let cases = [
        ("/thread/id", json!(OTHER_ID)),
        ("/thread/sessionId", json!(OTHER_ID)),
        ("/modelProvider", json!("other")),
        ("/reasoningEffort", json!("high")),
        ("/reasoningEffort", Value::Null),
        ("/sandbox/networkAccess", json!(true)),
        ("/sandbox/type", json!("workspaceWrite")),
        ("/runtimeWorkspaceRoots", json!([CWD, "/some/other/root"])),
        ("/approvalsReviewer", json!("autoReview")),
    ];
    for (pointer, value) in cases {
        let mut wrong = valid.clone();
        *wrong.pointer_mut(pointer).unwrap() = value;
        let mut exchange = resume();
        assert_eq!(
            respond(&mut exchange, Step::Open, wrong).unwrap_err().code,
            Code::InvalidOutput
        );
        assert!(!exchange.done());
    }
}

#[test]
fn tool_ready_and_official_callbacks_cannot_advance_zero_send() {
    for notification in [
        json!({"method":"mcpServer/startupStatus/updated","params":{"threadId":THREAD_ID,"status":"ready"}}),
        json!({"method":"turn/started","params":{"threadId":THREAD_ID}}),
        json!({"id":88,"method":"item/commandExecution/requestApproval","params":{"threadId":THREAD_ID}}),
    ] {
        let mut exchange = resume();
        assert!(inject(&mut exchange, notification).is_err());
        assert!(!exchange.done());
    }
}
