//! Actual registry/finite exchange/owned process with exclusively synthetic state.
use super::*;
use domain::Domain;
use inventory::{Kind, mcp_targets};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};
pub(super) struct Fixture {
    _serial: std::sync::MutexGuard<'static, ()>,
    pub temp: tempfile::TempDir,
    pub store: MetaStore,
    pub agent: String,
    pub inventory: String,
    pub registry: requests::Requests,
}
pub(super) fn listed(http: bool) -> Value {
    let transport = if http {
        json!({"type":"streamable_http","url":"https://synthetic.invalid/mcp","http_headers":{"Authorization":"PRIVATE_SECRET"}})
    } else {
        json!({"type":"stdio","command":"/synthetic/never-execute","args":["","one two"],"env":{"PRIVATE":"PRIVATE_SECRET"}})
    };
    json!([{"name":"a.b","enabled":false,"transport":transport,"auth_status":"unsupported"}])
}
pub(super) fn config(http: bool, siblings: bool) -> Value {
    let entry = if http {
        json!({"url":"https://synthetic.invalid/mcp","http_headers":{"Authorization":"PRIVATE_SECRET"},"enabled":false})
    } else {
        json!({"command":"/synthetic/never-execute","args":["","one two"],"env":{"PRIVATE":"PRIVATE_SECRET"},"enabled":false})
    };
    let mut table = json!({"a.b":entry});
    if siblings {
        table["a"] = json!({"b":{"unknown":[1,true]},"command":"/keep","enabled":false});
    }
    json!({"layers":[{"name":{"type":"user","file":"/synthetic/selected.toml"},"version":"v1","config":{"mcp_servers":table,"future":{"array":[1,true,{"unknown":"preserve"}]},"private":{"env":"PRIVATE_CANARY"}}}]})
}
impl Fixture {
    pub fn new(http: bool, siblings: bool) -> Self {
        let listed = listed(http);
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
            name: "Synthetic remove".into(),
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
        std::fs::write(temp.path().join("state.json"),serde_json::to_vec(&json!({"name":"a.b","config":config(http,siblings),"gets":0,"lists":0,"listed":listed,"methods":[],"writes":0})).unwrap()).unwrap();
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
        self.registry
            .begin_remove_inspect(&self.agent, &requests::uuid().unwrap(), &self.inventory, 0)
            .unwrap()
            .0
    }
    pub fn run_unfinished(&self, job: &Job, mode: &str) -> Result<()> {
        mcp_remove::run_with(&self.store, job, |stage| {
            let mut c = Command::new(crate::platform_tests::python());
            c.arg("-u")
                .arg(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("src/acp_client/skill_management/mcp_remove_peer.py"),
                )
                .arg(self.temp.path())
                .arg(mode)
                .arg(match stage {
                    mcp_remove::Stage::List => "list",
                    mcp_remove::Stage::Get => "get",
                    mcp_remove::Stage::AppServer => "server",
                });
            Ok(c)
        })
        .and_then(|()| {
            if job.snapshot().action == Action::Inspect {
                self.registry
                    .publish_review(job, job.plan.lock().unwrap().clone().unwrap())?;
            }
            Ok(())
        })
    }
    pub fn run(&self, job: &Job, mode: &str) {
        job.finish(self.run_unfinished(job, mode).err());
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
                Domain::McpRemove,
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
                Domain::McpRemove,
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
fn mcp_remove_literal_leaf_preserves_siblings_and_private_values() {
    for http in [false, true] {
        let f = Fixture::new(http, true);
        let before = f.state();
        let (inspect, review) = f.inspect();
        assert_eq!(review.parent_handling, Some("preserveSiblings"));
        assert_eq!(review.requested_enabled, None);
        let j = f.confirm(&review);
        f.run(&j, "normal");
        let op = j.snapshot();
        assert_eq!(op.outcome, Some(Outcome::Verified));
        let mut expected = before["config"].clone();
        expected["layers"][0]["config"]["mcp_servers"]
            .as_object_mut()
            .unwrap()
            .remove("a.b");
        expected["layers"][0]["version"] = json!("v2");
        assert_eq!(f.state()["config"], expected);
        assert_eq!(f.state()["writeParams"]["keyPath"], "mcp_servers.\"a.b\"");
        assert!(f.state()["writeParams"]["value"].is_null());
        assert_eq!(f.state()["writes"], 1);
        let public = serde_json::to_string(&op).unwrap();
        for secret in [
            "PRIVATE_SECRET",
            "PRIVATE_CANARY",
            "never-execute",
            "synthetic.invalid",
        ] {
            assert!(!public.contains(secret));
        }
        if !http {
            println!(
                "MCP_REMOVE_WIRE={}",
                json!({"inventory":inventory::requests::shared().get(&f.agent,&f.inventory).unwrap().snapshot(),"inspection":inspect.snapshot(),"verified":op})
            );
        }
    }
}
#[test]
fn mcp_remove_last_leaf_accepts_only_two_same_scope_full_candidates() {
    for (mode, outcome, parent) in [
        ("normal", Outcome::Verified, "empty"),
        ("absent-parent", Outcome::Verified, "absent"),
        ("split-parents", Outcome::Mismatch, "split"),
        ("new-sibling", Outcome::Mismatch, "nonempty"),
        ("other-drift", Outcome::Mismatch, "empty"),
    ] {
        let f = Fixture::new(false, false);
        let (_, r) = f.inspect();
        assert_eq!(r.parent_handling, Some("mayRemainEmpty"));
        let j = f.confirm(&r);
        f.run(&j, mode);
        assert_eq!(j.snapshot().outcome, Some(outcome), "{mode}");
        assert_eq!(
            j.snapshot().observation.as_ref().unwrap().parent_outcome,
            if parent == "split" {
                Some(None)
            } else {
                Some(Some(parent))
            }
        );
        assert_eq!(f.state()["writes"], 1);
        if mode == "normal" || mode == "absent-parent" {
            println!("MCP_REMOVE_PARENT_WIRE={}", json!({mode:j.snapshot()}));
        }
    }
}
#[test]
fn mcp_remove_all_layers_including_disabled_and_policy_are_refused() {
    for (mode, code) in [
        ("disabled-layer", Code::ConfigurationUnsupported),
        ("policy-disabled", Code::ConfigurationReadOnly),
    ] {
        let f = Fixture::new(false, false);
        let j = f.job();
        f.run(&j, mode);
        assert_eq!(j.snapshot().code, Some(code));
        assert_eq!(f.state()["writes"], 0);
        assert!(j.snapshot().review.is_none());
        assert_eq!(j.snapshot().outcome, Some(Outcome::NotDispatched));
        println!("MCP_REMOVE_REFUSAL_WIRE={}", json!({mode:j.snapshot()}));
    }
}
#[test]
fn mcp_remove_confirm_drift_is_prewrite_and_one_review_cannot_replay() {
    for mode in ["get-drift", "config-drift"] {
        let f = Fixture::new(false, false);
        let (_, r) = f.inspect();
        if mode == "config-drift" {
            let mut s = f.state();
            s["config"]["layers"][0]["config"]["future"] = json!(["changed"]);
            f.save(&s);
        }
        let j = f.confirm(&r);
        f.run(&j, mode);
        assert_eq!(j.snapshot().code, Some(Code::ConfigurationChanged));
        assert!(!j.snapshot().write_dispatched);
        assert_eq!(f.state()["writes"], 0);
        assert_eq!(
            f.registry
                .begin_confirm_domain(
                    &f.agent,
                    &requests::uuid().unwrap(),
                    &r.review_id,
                    Domain::McpRemove
                )
                .err()
                .unwrap()
                .code,
            Code::ReviewConsumed
        );
    }
}
#[test]
fn mcp_remove_strict_list_absence_never_conflates_false_or_read_failure() {
    for mode in [
        "present-false",
        "duplicate-list",
        "malformed-list",
        "trailing-list",
        "postlist-fail",
    ] {
        let f = Fixture::new(false, false);
        let (_, r) = f.inspect();
        let j = f.confirm(&r);
        f.run(&j, mode);
        let op = j.snapshot();
        assert_eq!(op.write_ack, Ack::Ok);
        assert_eq!(f.state()["writes"], 1);
        if mode == "present-false" {
            assert_eq!(op.outcome, Some(Outcome::Mismatch));
            let o = op.observation.as_ref().unwrap();
            assert_eq!(o.mcp, Some("present"));
            assert_eq!(o.reported_enabled, Some(false));
            println!(
                "MCP_REMOVE_PRESENT_WIRE={}",
                json!({"mismatchPresentFalse":op})
            );
        } else {
            assert_eq!(op.outcome, Some(Outcome::Unknown), "{mode}");
            assert!(op.observation.is_none());
        }
    }
}
#[test]
fn mcp_remove_unknown_and_rejected_recheck_never_replay_or_rewrite_history() {
    for mode in ["lost-ack", "postwrite-error", "postlist-fail", "refused"] {
        let f = Fixture::new(false, false);
        let (inspect, r) = f.inspect();
        let j = f.confirm(&r);
        f.run(&j, mode);
        let original = serde_json::to_value(j.snapshot()).unwrap();
        assert_eq!(
            j.snapshot().outcome,
            Some(if mode == "refused" {
                Outcome::Rejected
            } else {
                Outcome::Unknown
            })
        );
        if mode == "refused" {
            // Simulate an external removal, never a replay of our rejected request.
            let mut s = f.state();
            s["config"]["layers"][0]["config"]["mcp_servers"]
                .as_object_mut()
                .unwrap()
                .remove("a.b");
            s["config"]["layers"][0]["version"] = json!("external");
            f.save(&s);
        }
        let writes = f.state()["writes"].clone();
        let gets = f.state()["gets"].clone();
        let check = f.recheck(&j);
        f.run(&check, "normal");
        assert_eq!(check.snapshot().outcome, Some(Outcome::Observed));
        assert_eq!(check.snapshot().write_ack, j.snapshot().write_ack);
        assert_eq!(serde_json::to_value(j.snapshot()).unwrap(), original);
        assert_eq!(f.state()["writes"], writes);
        assert_eq!(f.state()["gets"], gets);
        if mode == "lost-ack" || mode == "refused" {
            println!(
                "MCP_REMOVE_RECHECK_WIRE={}",
                json!({mode:{"inventory":inventory::requests::shared().get(&f.agent,&f.inventory).unwrap().snapshot(),"inspection":inspect.snapshot(),"original":original,"recheck":check.snapshot()}})
            );
        }
    }
}
#[test]
fn mcp_remove_enabled_and_default_enabled_never_get_review() {
    for explicit in [true, false] {
        let f = Fixture::new(false, false);
        let mut s = f.state();
        if explicit {
            s["config"]["layers"][0]["config"]["mcp_servers"]["a.b"]["enabled"] = json!(true);
        } else {
            s["config"]["layers"][0]["config"]["mcp_servers"]["a.b"]
                .as_object_mut()
                .unwrap()
                .remove("enabled");
        }
        f.save(&s);
        let j = f.job();
        f.run(&j, "normal");
        assert_eq!(j.snapshot().code, Some(Code::TargetEnabled));
        assert_eq!(f.state()["writes"], 0);
        assert!(j.snapshot().review.is_none());
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn mcp_remove_cancel_after_write_retains_real_cleanup_and_shared_slot() {
    use inventory::process::Control;
    use std::time::Duration;
    let f = Fixture::new(false, false);
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
    let execution = tokio::spawn(super::execute_with(
        f.store.clone(),
        j.clone(),
        activity,
        scope,
        move |store, job| {
            mcp_remove::run_with(store, job, |stage| {
                let mut c = Command::new(crate::platform_tests::python());
                c.arg("-u")
                    .arg(
                        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                            .join("src/acp_client/skill_management/mcp_remove_peer.py"),
                    )
                    .arg(&root)
                    .arg("postlist-wait")
                    .arg(match stage {
                        mcp_remove::Stage::List => "list",
                        mcp_remove::Stage::Get => "get",
                        mcp_remove::Stage::AppServer => "server",
                    });
                Ok(c)
            })
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
    let cancellation = f
        .registry
        .cancel_domain(&f.agent, &j.snapshot().request_id, Domain::McpRemove)
        .unwrap();
    assert!(reached);
    assert!(!cancellation.operation.as_ref().unwrap().settled);
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(crate::platform_tests::process_check(pid), 0);
    assert!(admission.update().is_err());
    let second = inventory::execution::acquire().unwrap();
    assert!(matches!(
        inventory::execution::acquire(),
        Err(Failure { code: Code::Busy })
    ));
    // Explicitly exercise the actual Job publication while its real worker is
    // pending. This does not claim the OS exceeded the production deadline.
    j.pending_cleanup();
    let pending = j.snapshot();
    assert!(!pending.settled);
    tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(crate::platform_tests::process_check(pid), 0);
    assert!(admission.update().is_ok());
    drop(second);
    assert_eq!(j.snapshot().write_ack, Ack::Ok);
    assert_eq!(j.snapshot().outcome, Some(Outcome::Unknown));
    assert_eq!(j.snapshot().state, State::Failed);
    assert_eq!(f.state()["writes"], 1);
    println!(
        "MCP_REMOVE_LIFECYCLE_WIRE={}",
        json!({"pendingInspection":inspection.snapshot(),"pendingCleanup":pending,"cancellation":cancellation,"cancelledAfterWrite":j.snapshot()})
    );
}
#[test]
fn mcp_remove_parent_fact_requires_agreement_between_scopes() {
    let f = Fixture::new(false, false);
    let (_, r) = f.inspect();
    let j = f.confirm(&r);
    let owned = j.plan.lock().unwrap().clone().unwrap();
    let plan = owned.removal().unwrap();
    let mut after = plan.before.clone();
    after.layers[after.active].config = plan.retained.clone();
    for kind in ["absent", "nonempty"] {
        let mut directory = after.clone();
        if kind == "absent" {
            directory.layers[directory.active]
                .config
                .as_object_mut()
                .unwrap()
                .remove("mcp_servers");
        } else {
            directory.layers[directory.active].config["mcp_servers"]["external"] =
                json!({"enabled":false});
        }
        let (observation, matching) = plan.observation(&after, &directory, None);
        assert!(!matching);
        assert_eq!(observation.configuration, "different");
        assert_eq!(observation.parent_outcome, Some(None), "cross-scope {kind}");
    }
}
#[test]
fn mcp_remove_cancel_before_dispatch_has_no_peer_or_write_side_effect() {
    let f = Fixture::new(false, false);
    let j = f.job();
    let cancellation = f
        .registry
        .cancel_domain(&f.agent, &j.snapshot().request_id, Domain::McpRemove)
        .unwrap();
    assert!(!cancellation.operation.as_ref().unwrap().settled);
    f.run(&j, "normal");
    let op = j.snapshot();
    assert_eq!(op.state, State::Cancelled);
    assert_eq!(op.outcome, Some(Outcome::NotDispatched));
    assert_eq!(op.write_ack, Ack::None);
    assert!(!op.write_dispatched);
    assert!(op.review.is_none() && op.observation.is_none());
    assert_eq!(f.state()["methods"], json!([]));
    assert_eq!(f.state()["gets"], 0);
    assert_eq!(f.state()["writes"], 0);
    let row = f.store.get_agent(&f.agent).unwrap().unwrap();
    println!(
        "MCP_REMOVE_CANCEL_WIRE={}",
        json!({"inspectCancellation":cancellation,"inspectCancelled":op,"unavailableCapabilities":inventory::launch::capabilities(&row).unwrap()})
    );
}
