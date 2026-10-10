use super::*;
use std::sync::atomic::Ordering;
fn fixture() -> (Tasks, Arc<ConnectionLife>) {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    (
        Tasks::new(true, "connection".into(), "session".into(), life.clone()),
        life,
    )
}
fn spawn(id: &str) -> Value {
    json!({"sessionId":"session","update":{"sessionUpdate":"async_task_spawned","asyncTaskId":id,"name":"Original task","taskType":"shell","canStop":true,"toolCallId":"tool"}})
}
fn end(id: &str, state: &str) -> Value {
    json!({"sessionId":"session","update":{"sessionUpdate":"async_task_state_update","asyncTaskId":id,"state":state,"toolCallId":"tool"}})
}
#[test]
fn async_task_terminal_before_spawn_cannot_reappear_running() {
    let (mut tasks, life) = fixture();
    tasks.observe(&end("a", "completed"));
    tasks.observe(&spawn("a"));
    assert_eq!(tasks.event()["tasks"][0]["state"], "completed");
    assert_eq!(tasks.event()["tasks"][0]["canStop"], false);
    assert!(!tasks.busy());
    assert_eq!(life.work.load(Ordering::SeqCst), 0);
}
#[test]
fn async_task_reused_terminal_id_is_not_a_new_controllable_execution() {
    let (mut tasks, life) = fixture();
    tasks.observe(&spawn("a"));
    tasks.observe(&end("a", "stopped"));
    let mut reused = spawn("a");
    reused["update"]["toolCallId"] = json!("different-tool");
    tasks.observe(&reused);
    assert!(!tasks.event()["tasks"][0]["canStop"].as_bool().unwrap());
    assert!(tasks.busy(), "ambiguous new work cannot be reported idle");
    assert_eq!(life.work.load(Ordering::SeqCst), 1);
}
#[test]
fn async_task_capability_gate_is_exact_and_retains_raw_only_for_other_profiles() {
    for air in [
        json!({"version":2,"capabilities":["asyncTasks"]}),
        json!({"version":1,"capabilities":["sessionFailure"]}),
        json!({"version":1,"capabilities":["asyncTasks",null]}),
        Value::Null,
    ] {
        assert!(!supported(&json!({"_meta":{"jetbrains":{"air":air}}})));
    }
    assert!(supported(
        &json!({"_meta":{"jetbrains":{"air":{"version":1,"capabilities":["asyncTasks"]}}}})
    ));
    let (mut tasks, _) = fixture();
    tasks.enabled = false;
    assert!(tasks.observe(&spawn("a")).is_none());
    assert!(!tasks.busy());
}
#[test]
fn async_task_bad_owner_and_malformed_data_never_grant_control() {
    let (mut tasks, _) = fixture();
    let mut v = spawn("a");
    v["sessionId"] = json!("other");
    assert!(tasks.observe(&v).is_none());
    for (key, value) in [
        ("asyncTaskId", json!(42)),
        ("name", json!(null)),
        ("canStop", json!("true")),
        ("toolCallId", json!([])),
    ] {
        let mut v = spawn("a");
        v["update"][key] = value;
        assert!(tasks.observe(&v).is_none());
    }
    assert_eq!(tasks.event()["tasks"], json!([]));
    tasks.observe(&spawn("a"));
    let mut v = end("a", "stopped");
    v["update"]["toolCallId"] = json!("other");
    tasks.observe(&v);
    assert!(tasks.busy());
}
#[test]
fn async_task_terminal_is_first_wins_and_ack_never_rewrites_it() {
    let (mut tasks, life) = fixture();
    tasks.observe(&spawn("a"));
    assert_eq!(life.work.load(Ordering::SeqCst), 1);
    tasks.complete(Completion {
        task_id: "a".into(),
        result: Ok(json!({"stopped":true})),
    });
    assert_eq!(tasks.event()["tasks"][0]["stopRequest"], "accepted");
    assert!(tasks.busy());
    tasks.observe(&end("a", "completed"));
    tasks.observe(&end("a", "stopped"));
    assert_eq!(tasks.event()["tasks"][0]["state"], "completed");
    assert_eq!(life.work.load(Ordering::SeqCst), 0);
}
#[test]
fn async_task_bounded_retirement_never_turns_untracked_work_idle() {
    let (mut tasks, life) = fixture();
    for i in 0..LIMIT {
        tasks.observe(&end(&format!("early-{i}"), "completed"));
    }
    assert!(!tasks.busy());
    tasks.observe(&spawn("untracked"));
    assert!(tasks.busy());
    assert_eq!(tasks.event()["overflow"], true);
    assert_eq!(tasks.tasks.len() + tasks.early.len(), LIMIT);
    assert_eq!(life.work.load(Ordering::SeqCst), 1);
}
#[test]
fn async_task_unknown_early_state_is_visible_and_holds_work() {
    let (mut tasks, life) = fixture();
    tasks.observe(&end("early", "future"));
    assert_eq!(tasks.event()["overflow"], true);
    assert!(tasks.busy());
    assert_eq!(life.work.load(Ordering::SeqCst), 1);
    tasks.observe(&spawn("early"));
    assert_eq!(tasks.event()["tasks"][0]["state"], "unknown");
    assert_eq!(tasks.event()["tasks"][0]["canStop"], false);
}
#[test]
fn async_task_early_unknown_accepts_same_owner_first_terminal() {
    for state in ["completed", "stopped"] {
        let (mut tasks, life) = fixture();
        tasks.observe(&end("early", "future"));
        assert!(tasks.busy());
        tasks.observe(&end("early", state));
        assert!(!tasks.busy(), "same owner terminal must settle {state}");
        assert_eq!(life.work.load(Ordering::SeqCst), 0);
        tasks.observe(&spawn("early"));
        assert_eq!(tasks.event()["tasks"][0]["state"], state);
        assert_eq!(tasks.event()["tasks"][0]["canStop"], false);
    }
}
#[test]
fn async_task_early_conflicting_owner_cannot_release_unknown_work() {
    let (mut tasks, life) = fixture();
    tasks.observe(&end("early", "future"));
    let mut other = end("early", "completed");
    other["update"]["toolCallId"] = json!("other-tool");
    tasks.observe(&other);
    tasks.observe(&end("early", "completed"));
    tasks.observe(&spawn("early"));
    assert!(tasks.busy(), "a reused ID leaves another owner unresolved");
    assert_eq!(tasks.event()["overflow"], true);
    assert_eq!(tasks.event()["tasks"][0]["canStop"], false);
    assert_eq!(life.work.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn async_task_timeout_keeps_work_and_late_ack_has_no_terminal_authority() {
    let (mut tasks, life) = fixture();
    tasks.observe(&spawn("a"));
    let (tx, rx) = oneshot::channel();
    let task = tasks.tasks.get_mut("a").unwrap();
    task.stop = "requested";
    task.reply = Some(tx);
    task.deadline = Some(tokio::time::Instant::now() - Duration::from_secs(1));
    tasks.expire();
    assert_eq!(rx.await.unwrap().unwrap()["status"], "unknown");
    assert_eq!(life.work.load(Ordering::SeqCst), 1);
    tasks.complete(Completion {
        task_id: "a".into(),
        result: Ok(json!({"stopped":false})),
    });
    assert_eq!(tasks.event()["tasks"][0]["state"], "running");
    assert_eq!(tasks.event()["tasks"][0]["stopRequest"], "rejected");
}
