//! Actual registry/finite exchange/owned process with exclusively synthetic state.
use super::*;
use domain::Domain;
use inventory::{Kind, mcp_targets};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};

pub(super) struct CancelledWorkerObservation {
    retired: tokio::sync::oneshot::Receiver<Option<Code>>,
    _release: std::sync::mpsc::Sender<()>,
}

pub(super) fn hold_cancelled_worker() -> (
    impl FnOnce(Result<()>) -> Result<()> + Send,
    CancelledWorkerObservation,
) {
    let (retired_tx, retired) = tokio::sync::oneshot::channel();
    let (_release, release_rx) = std::sync::mpsc::channel();
    let hold = move |result: Result<()>| {
        let _ = retired_tx.send(result.as_ref().err().map(|failure| failure.code));
        // Keep the real wrapper's permits until the test observes ownership.
        // Dropping the sender releases this even if an assertion fails.
        if matches!(
            release_rx.recv_timeout(std::time::Duration::from_secs(10)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ) {
            return Err(Code::TimedOut.into());
        }
        result
    };
    (hold, CancelledWorkerObservation { retired, _release })
}

impl CancelledWorkerObservation {
    pub(super) async fn observe(&mut self, pid: i32) -> &'static str {
        use std::time::Duration;
        if cfg!(windows) {
            // Windows terminates the Job on TERM. Sample the outer worker
            // after native retirement, while its admission guards are held.
            let failure = tokio::time::timeout(Duration::from_secs(5), &mut self.retired)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(failure, Some(Code::Cancelled));
            assert_ne!(crate::platform_tests::process_check(pid), 0);
            "nativeRetiredWorkerHeld"
        } else {
            // The Unix fixture ignores SIGTERM during the real grace period.
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(crate::platform_tests::process_check(pid), 0);
            "peerAliveDuringGrace"
        }
    }
}

pub(super) struct Fixture {
    _serial: std::sync::MutexGuard<'static, ()>,
    pub temp: tempfile::TempDir,
    pub store: MetaStore,
    pub agent: String,
    pub inventory: String,
    pub registry: requests::Requests,
}
pub(super) fn input() -> mcp_add_input::StdioInput {
    mcp_add_input::StdioInput {
        name: "sample.new".into(),
        executable_path: super::tests::fixture_path("/synthetic/unexecuted program"),
        args: vec![
            "".into(),
            "one two".into(),
            "--literal=$NOT_EXPANDED".into(),
        ],
    }
}
fn config() -> Value {
    json!({"layers":[{"name":{"type":"user","file":super::tests::fixture_path("/synthetic/selected.toml")},"version":"v1","config":{"future":{"array":[1,true,{"unknown":"preserve"}]},"private":{"env":"PRIVATE_CANARY"}}}]})
}
impl Fixture {
    pub fn new(listed: Value) -> Self {
        let serial = inventory::execution::fixture_lock();
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let store = MetaStore::open(&temp.path().join("meta.db")).unwrap();
        let agent = requests::uuid().unwrap();
        let row = crate::meta_store::AgentRow {
            id: agent.clone(),
            name: "Synthetic add".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec![],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let id = requests::uuid().unwrap();
        let (request, _) = inventory::requests::shared()
            .begin(&agent, &cwd, &id, &id, Kind::Mcp)
            .unwrap();
        let bytes = serde_json::to_vec(&listed).unwrap();
        let (snapshot, entries) = inventory::output::parse_private(&bytes).unwrap();
        *request.mcp_targets.lock().unwrap() = Some(Arc::new(mcp_targets::TargetSet {
            row,
            directory: Arc::new(inventory::launch::Directory::open(&cwd).unwrap()),
            entries,
            names: inventory::output::names(&bytes).unwrap(),
        }));
        request.finish(Ok(inventory::InventorySnapshot::Mcp(snapshot)));
        std::fs::write(temp.path().join("state.json"),serde_json::to_vec(&json!({"name":"sample.new","config":config(),"listed":listed,"methods":[],"writes":0})).unwrap()).unwrap();
        Self {
            _serial: serial,
            temp,
            store,
            agent,
            inventory: id,
            registry: Default::default(),
        }
    }
    pub fn state(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.temp.path().join("state.json")).unwrap())
            .unwrap()
    }
    pub fn save(&self, state: &Value) {
        std::fs::write(
            self.temp.path().join("state.json"),
            serde_json::to_vec(state).unwrap(),
        )
        .unwrap();
    }
    pub fn job(&self) -> Arc<Job> {
        self.job_with(input())
    }
    pub fn job_with(&self, input: impl Into<mcp_add_input::Input>) -> Arc<Job> {
        self.registry
            .begin_add_inspect(
                &self.agent,
                &requests::uuid().unwrap(),
                &self.inventory,
                &requests::uuid().unwrap(),
                input,
            )
            .unwrap()
            .0
    }
    pub fn run(&self, job: &Job, mode: &str) {
        let result = mcp_add::run_with(&self.store, job, |stage| {
            let mut c = Command::new(crate::platform_tests::python());
            c.arg("-u")
                .arg(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("src/acp_client/skill_management/mcp_add_peer.py"),
                )
                .arg(self.temp.path())
                .arg(mode)
                .arg(match stage {
                    mcp_add::Stage::List => "list",
                    mcp_add::Stage::Get => "get",
                    mcp_add::Stage::AppServer => "server",
                });
            Ok(c)
        })
        .and_then(|()| {
            if job.snapshot().action == Action::Inspect {
                self.registry
                    .publish_review(job, job.plan.lock().unwrap().clone().unwrap())?;
            }
            Ok(())
        });
        job.finish(result.err());
    }
    pub fn inspect(&self) -> (Arc<Job>, Review) {
        let j = self.job();
        self.run(&j, "normal");
        let review = j.snapshot().review.unwrap();
        (j, review)
    }
    pub fn confirm(&self, r: &Review) -> Arc<Job> {
        self.registry
            .begin_confirm_domain(
                &self.agent,
                &requests::uuid().unwrap(),
                &r.review_id,
                Domain::McpAdd,
            )
            .unwrap()
            .0
    }
    pub fn recheck(&self, j: &Job) -> Arc<Job> {
        self.registry
            .begin_recheck_domain(
                &self.agent,
                &requests::uuid().unwrap(),
                &j.snapshot().request_id,
                Domain::McpAdd,
            )
            .unwrap()
            .0
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let r = inventory::requests::shared();
        let _ = r.cancel(&self.agent, &self.inventory);
        r.expire_settled_for_test(&self.inventory);
        let _ = r.get(&self.agent, &self.inventory);
    }
}
#[test]
fn mcp_add_empty_catalogue_has_review_then_one_literal_disabled_table() {
    let f = Fixture::new(json!([]));
    let (inspect, review) = f.inspect();
    assert_eq!(f.state()["writes"], 0);
    assert_eq!(review.reported_enabled, None);
    assert_eq!(review.configured_enabled, Some(None));
    let job = f.confirm(&review);
    f.run(&job, "normal");
    let op = job.snapshot();
    assert_eq!(op.outcome, Some(Outcome::Verified));
    assert_eq!(op.action, Action::Add);
    let mut expected = config();
    expected["layers"][0]["config"]["mcp_servers"] = json!({"sample.new":{"command":input().executable_path,"args":input().args,"enabled":false}});
    expected["layers"][0]["version"] = json!("v2");
    assert_eq!(f.state()["config"], expected);
    assert_eq!(f.state()["writes"], 1);
    assert_eq!(
        f.state()["writeParams"]["keyPath"],
        "mcp_servers.\"sample.new\""
    );
    let public = serde_json::to_string(&op).unwrap();
    for secret in ["PRIVATE_CANARY", "unexecuted program", "NOT_EXPANDED"] {
        assert!(!public.contains(secret));
    }
    println!(
        "MCP_ADD_WIRE={}",
        json!({"inspection":inspect.snapshot(),"verified":op,"inventory":inventory::requests::shared().get(&f.agent,&f.inventory).unwrap().snapshot()})
    );
}
#[test]
fn mcp_add_collisions_in_original_fresh_and_disabled_layer_are_exact_failures() {
    for mode in ["original", "fresh-collision", "disabled-layer"] {
        let rows = if mode == "original" {
            json!([{"name":"sample.new","enabled":false,"transport":{"type":"future"},"auth_status":"unsupported"}])
        } else {
            json!([])
        };
        let f = Fixture::new(rows);
        let j = f.job();
        f.run(&j, mode);
        assert_eq!(j.snapshot().code, Some(Code::NameConflict), "{mode}");
        assert_eq!(j.snapshot().outcome, Some(Outcome::NotDispatched));
        assert_eq!(f.state()["writes"], 0);
        if mode == "original" {
            println!(
                "MCP_ADD_REFUSAL_WIRE={}",
                json!({"inspectNameConflict":j.snapshot()})
            );
        }
    }
}
#[test]
fn mcp_add_unknown_write_recheck_observes_without_replay() {
    for mode in ["lost-ack", "postwrite-error", "postget-fail"] {
        let f = Fixture::new(json!([]));
        let (inspection, review) = f.inspect();
        let j = f.confirm(&review);
        f.run(&j, mode);
        let original = j.snapshot();
        assert_eq!(original.outcome, Some(Outcome::Unknown), "{mode}");
        assert!(original.write_dispatched);
        assert_eq!(f.state()["writes"], 1);
        let check = f.recheck(&j);
        f.run(&check, "normal");
        assert_eq!(check.snapshot().outcome, Some(Outcome::Observed));
        assert_eq!(check.snapshot().write_ack, original.write_ack);
        assert_eq!(f.state()["writes"], 1);
        if mode == "lost-ack" {
            println!(
                "MCP_ADD_RECOVERY_WIRE={}",
                json!({"unknownInspection":inspection.snapshot(),"unknown":original,"recheck":check.snapshot()})
            );
        }
    }
}
#[test]
fn mcp_add_same_disabled_different_args_or_env_is_mismatch() {
    for mode in ["postget-args-drift", "postget-env-drift", "changed-other"] {
        let f = Fixture::new(json!([]));
        let (_, review) = f.inspect();
        let j = f.confirm(&review);
        f.run(&j, mode);
        assert_eq!(j.snapshot().outcome, Some(Outcome::Mismatch), "{mode}");
        if mode == "postget-args-drift" {
            assert_eq!(
                j.snapshot().observation.as_ref().unwrap().reported_enabled,
                Some(false)
            );
            println!(
                "MCP_ADD_MISMATCH_WIRE={}",
                json!({"mismatchSameDisabled":j.snapshot()})
            );
        }
    }
}
#[test]
fn mcp_add_review_stale_or_retracted_never_writes() {
    let f = Fixture::new(json!([]));
    let (_, review) = f.inspect();
    let j = f.confirm(&review);
    let mut state = f.state();
    state["config"]["layers"][0]["config"]["future"] = json!("changed");
    f.save(&state);
    f.run(&j, "normal");
    assert_eq!(j.snapshot().code, Some(Code::ConfigurationChanged));
    assert!(!j.snapshot().write_dispatched);
    let (_, review) = f.inspect();
    inventory::requests::shared()
        .cancel(&f.agent, &f.inventory)
        .unwrap();
    assert!(
        f.registry
            .begin_confirm_domain(
                &f.agent,
                &requests::uuid().unwrap(),
                &review.review_id,
                Domain::McpAdd
            )
            .is_err()
    );
    assert_eq!(f.state()["writes"], 0);
}
#[test]
fn mcp_add_input_limits_preserve_empty_argument_and_reject_only_admission_shape() {
    assert!(input().validate().is_ok());
    for name in ["", "a..b", "space name", "a:b", "codex_apps"] {
        let mut x = input();
        x.name = name.into();
        assert_eq!(x.validate().unwrap_err().code, Code::InvalidName);
    }
    for path in ["relative", "/a/../b", "/a/", "/a//b", "/a\n"] {
        let mut x = input();
        x.executable_path = path.into();
        assert_eq!(x.validate().unwrap_err().code, Code::InvalidExecutablePath);
    }
    let mut x = input();
    x.args = vec!["a".repeat(1025)];
    assert_eq!(x.validate().unwrap_err().code, Code::InvalidArguments);
}
#[test]
fn mcp_add_repeat_input_is_exact_and_does_not_consume_other_domain() {
    let f = Fixture::new(json!([]));
    let id = requests::uuid().unwrap();
    let input_id = requests::uuid().unwrap();
    let (j, fresh) = f
        .registry
        .begin_add_inspect(&f.agent, &id, &f.inventory, &input_id, input())
        .unwrap();
    assert!(fresh);
    assert!(
        !f.registry
            .begin_add_inspect(&f.agent, &id, &f.inventory, &input_id, input())
            .unwrap()
            .1
    );
    let mut different = input();
    different.args.reverse();
    assert!(matches!(
        f.registry
            .begin_add_inspect(&f.agent, &id, &f.inventory, &input_id, different),
        Err(Failure {
            code: Code::RequestConflict
        })
    ));
    assert!(f.registry.cancel_kind(&f.agent, &id, Kind::Mcp).is_err());
    assert!(j.operation.interested());
    f.registry
        .cancel_domain(&f.agent, &id, Domain::McpAdd)
        .unwrap();
    f.run(&j, "normal");
    assert_eq!(j.snapshot().state, State::Cancelled);
    println!(
        "MCP_ADD_INSPECT_CANCEL_WIRE={}",
        json!({"inspectCancelled":j.snapshot()})
    );
}
#[test]
fn mcp_add_cancel_before_inspect_does_not_revive() {
    let f = Fixture::new(json!([]));
    let id = requests::uuid().unwrap();
    let cancel = f
        .registry
        .cancel_domain(&f.agent, &id, Domain::McpAdd)
        .unwrap();
    assert!(cancel.operation.is_none());
    assert!(matches!(
        f.registry.begin_add_inspect(
            &f.agent,
            &id,
            &f.inventory,
            &requests::uuid().unwrap(),
            input()
        ),
        Err(Failure {
            code: Code::Cancelled
        })
    ));
    println!(
        "MCP_ADD_CANCEL_WIRE={}",
        json!({"earlyCancellation":cancel})
    );
}
#[test]
fn mcp_add_invisible_input_is_rejected() {
    for c in ['\u{00ad}', '\u{034f}', '\u{2028}', '\u{e0001}'] {
        let mut value = input();
        value.args.push(format!("literal{c}text"));
        assert_eq!(
            value.validate().err().map(|v| v.code),
            Some(Code::InvalidArguments),
            "U+{:X}",
            c as u32
        );
    }
}
#[test]
fn mcp_add_unknown_transport_fields_are_rejected() {
    let before = plan::Config::parse(config()).unwrap();
    let plan = mcp_add_plan::Plan::new(before.clone(), before, input()).unwrap();
    let mut after = config();
    after["layers"][0]["config"] = plan.intended.clone();
    let after = plan::Config::parse(after).unwrap();
    for field in ["url", "http_headers", "future_transport"] {
        let mut report = json!({"name":input().name,"enabled":false,"transport":{"type":"stdio","command":input().executable_path,"args":input().args}});
        report["transport"][field] = json!("PRIVATE_CANARY");
        assert!(
            !plan.observation(&after, &after, Some(&report)).unwrap().1,
            "{field}"
        );
    }
}
#[test]
fn mcp_add_literal_sibling_and_malformed_ancestor_have_exact_boundaries() {
    let mut raw = config();
    raw["layers"][0]["config"]["mcp_servers"] = json!({"sample":{"new":{"enabled":true}},"other":{"enabled":true,"env":{"PRIVATE":"keep"}}});
    let before = plan::Config::parse(raw.clone()).unwrap();
    let p = mcp_add_plan::Plan::new(before.clone(), before, input()).unwrap();
    assert_eq!(
        p.intended["mcp_servers"]["sample"],
        raw["layers"][0]["config"]["mcp_servers"]["sample"]
    );
    for malformed in [json!(false), json!([]), Value::Null] {
        let mut raw = config();
        raw["layers"][0]["config"]["mcp_servers"] = malformed;
        let before = plan::Config::parse(raw).unwrap();
        assert!(matches!(
            mcp_add_plan::Plan::new(before.clone(), before, input()),
            Err(Failure {
                code: Code::ConfigurationUnsupported
            })
        ));
    }
}
#[test]
fn mcp_add_rejection_and_recheck_absence_never_claim_no_write_from_get_error() {
    let f = Fixture::new(json!([]));
    let (_, r) = f.inspect();
    let j = f.confirm(&r);
    f.run(&j, "refused");
    assert_eq!(j.snapshot().outcome, Some(Outcome::Rejected));
    assert_eq!(f.state()["writes"], 0);
    let check = f.recheck(&j);
    f.run(&check, "normal");
    assert_eq!(check.snapshot().outcome, Some(Outcome::Mismatch));
    assert_eq!(check.snapshot().observation.unwrap().mcp, Some("missing"));
    assert_eq!(f.state()["writes"], 0);
    let (_, r) = f.inspect();
    let j = f.confirm(&r);
    f.run(&j, "normal");
    let check = f.recheck(&j);
    f.run(&check, "postget-fail");
    assert_eq!(check.snapshot().outcome, Some(Outcome::Unknown));
    assert!(check.snapshot().observation.is_none());
    assert_eq!(f.state()["writes"], 1);
}
#[tokio::test(flavor = "multi_thread")]
async fn mcp_add_cancel_after_write_retains_real_cleanup_and_shared_slot() {
    use inventory::process::Control;
    use std::time::Duration;
    let f = Fixture::new(json!([]));
    let (inspection, review) = f.inspect();
    let j = f.confirm(&review);
    let row = f.store.get_agent(&f.agent).unwrap().unwrap();
    let manager = crate::acp_client::manager::AcpManager::new(
        f.temp.path().join("logs"),
        f.temp.path().into(),
    );
    let scope = manager
        .reserve_preparation_action(&row, &row.command, &row.args)
        .unwrap();
    let admission = crate::managed_update::UpdateAdmission::default();
    let activity = admission.activity().unwrap();
    let root = f.temp.path().to_path_buf();
    let (hold, mut worker) = hold_cancelled_worker();
    let execution = tokio::spawn(super::execute_with(
        f.store.clone(),
        j.clone(),
        activity,
        scope,
        move |store, job| {
            let result = mcp_add::run_with(store, job, |stage| {
                let mut c = Command::new(crate::platform_tests::python());
                c.arg("-u")
                    .arg(
                        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                            .join("src/acp_client/skill_management/mcp_add_peer.py"),
                    )
                    .arg(&root)
                    .arg("postget-wait")
                    .arg(match stage {
                        mcp_add::Stage::List => "list",
                        mcp_add::Stage::Get => "get",
                        mcp_add::Stage::AppServer => "server",
                    });
                Ok(c)
            });
            hold(result)
        },
    ));
    let marker = f.temp.path().join("waiting");
    let reached = tokio::time::timeout(Duration::from_secs(5), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    assert!(reached);
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    assert_eq!(crate::platform_tests::process_check(pid), 0);
    let cancellation = f
        .registry
        .cancel_domain(&f.agent, &j.snapshot().request_id, Domain::McpAdd)
        .unwrap();
    assert!(!cancellation.operation.as_ref().unwrap().settled);
    let worker_sample = worker.observe(pid).await;
    assert!(admission.update().is_err());
    let second = inventory::execution::acquire().unwrap();
    assert!(matches!(
        inventory::execution::acquire(),
        Err(Failure { code: Code::Busy })
    ));
    // Exercise publication while the owning wrapper is still unsettled.
    j.pending_cleanup();
    let pending = j.snapshot();
    assert!(!pending.settled);
    assert_eq!(pending.state, State::PendingCleanup);
    drop(worker);
    tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(crate::platform_tests::process_check(pid), 0);
    assert!(admission.update().is_ok());
    drop(second);
    assert_eq!(j.snapshot().write_ack, Ack::Ok);
    assert_eq!(j.snapshot().outcome, Some(Outcome::Unknown));
    assert_eq!(j.snapshot().code, Some(Code::Cancelled));
    assert_eq!(j.snapshot().state, State::Failed);
    assert_eq!(f.state()["writes"], 1);
    println!(
        "MCP_ADD_LIFECYCLE_WIRE={}",
        json!({"pendingInspection":inspection.snapshot(),"pendingCleanup":pending,"cancellation":cancellation,"workerSample":worker_sample,"cancelledAfterWrite":j.snapshot()})
    );
}
