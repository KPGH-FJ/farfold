//! Independent challenges use the real plan, exchange, registry and transport.
//! All metadata and peer writes are confined to fresh synthetic temp directories.
use super::{
    plan::{Config, Plan},
    requests::{Job, Requests, uuid},
    rpc::Exchange,
    types::*,
};
use crate::{
    acp_client::extension_inventory::{
        self as inventory, InventorySnapshot, Kind,
        launch::Directory,
        targets::{SkillTarget, TargetSet},
    },
    meta_store::{AgentRow, MetaStore},
};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command, sync::Arc};

fn config(file: &str) -> Value {
    let base_file = PathBuf::from(file).with_file_name("config.toml");
    json!({"config":{},"origins":{},"layers":[
        {"name":{"type":"sessionFlags"},"version":"top-v","config":{"unrelated":true}},
        {"name":{"type":"user","file":file,"profile":"selected-profile"},"version":"profile-v","config":{
            "independentUnknown":{"keep":"ORIGINAL","nested":[1,true,{"future":"opaque"}]},
            "skills":{"futureKey":{"keep":["a","b"]},"config":[
                {"name":"shared-name","enabled":true,"future":{"nested":[1,2]}},
                {"path":"/synthetic/other/SKILL.md","enabled":false,"opaque":{"x":true}}
            ]}}},
        {"name":{"type":"user","file":base_file,"profile":null},"version":"base-v","config":{"skills":{"config":[{"path":"/base-only","enabled":true}]},"baseOnly":{"untouched":42}}}
    ]})
}

fn target(path: &str) -> SkillTarget {
    SkillTarget {
        id: 0,
        path: path.into(),
        name: "independent-skill".into(),
        origin: "repo".into(),
        enabled: true,
    }
}

#[test]
fn independent_highest_user_profile_preserves_complete_unknown_json_and_other_layers() {
    let before = config("/synthetic/selected-profile.config.toml");
    let plan = Plan::new(
        Config::parse(before.clone()).unwrap(),
        target("/synthetic/selected/SKILL.md"),
        false,
    )
    .unwrap();
    assert_eq!(plan.before.scope().unwrap().kind, "profile");
    let params = plan.params();
    assert_eq!(params["expectedVersion"], "profile-v");
    assert_eq!(
        params["filePath"],
        "/synthetic/selected-profile.config.toml"
    );
    let mut expected = before["layers"][1]["config"]["skills"]["config"]
        .as_array()
        .unwrap()
        .clone();
    expected.push(json!({"path":"/synthetic/selected/SKILL.md","enabled":false}));
    assert_eq!(params["value"], json!(expected));
    let mut after = before.clone();
    after["layers"][1]["config"]["skills"]["config"] = params["value"].clone();
    after["layers"][1]["version"] = json!("semantic-version-after");
    assert!(plan.config_matches(&Config::parse(after.clone()).unwrap()));
    after["layers"][1]["config"]["independentUnknown"]["nested"][2]["future"] = json!("lost");
    assert!(!plan.config_matches(&Config::parse(after).unwrap()));
    let mut changed_base = before;
    changed_base["layers"][1]["config"] = plan.intended.clone();
    changed_base["layers"][2]["config"]["baseOnly"]["untouched"] = json!(43);
    assert!(!plan.config_matches(&Config::parse(changed_base).unwrap()));
}

#[test]
fn independent_only_final_path_only_rule_is_updated_without_dropping_unknown_fields() {
    let path = "/synthetic/selected/SKILL.md";
    let mut before = config("/synthetic/selected-profile.config.toml");
    let last =
        json!({"path":path,"enabled":true,"future":{"tuple":[false,{"extension":"preserved"}]}});
    before["layers"][1]["config"]["skills"]["config"]
        .as_array_mut()
        .unwrap()
        .push(last.clone());
    let plan = Plan::new(Config::parse(before.clone()).unwrap(), target(path), false).unwrap();
    let mut expected = last;
    expected["enabled"] = json!(false);
    assert_eq!(plan.mutation, "updateLastPathRule");
    assert_eq!(plan.array.as_array().unwrap().last().unwrap(), &expected);
    before["layers"][1]["config"]["skills"]["config"][2]["name"] = json!("ambiguous-name");
    let plan = Plan::new(Config::parse(before.clone()).unwrap(), target(path), false).unwrap();
    assert_eq!(plan.mutation, "appendPathRule");
    assert_eq!(
        plan.array[2],
        before["layers"][1]["config"]["skills"]["config"][2]
    );
    assert_eq!(plan.array[3], json!({"path":path,"enabled":false}));
}

struct Fixture {
    _serial: std::sync::MutexGuard<'static, ()>,
    _temp: tempfile::TempDir,
    root: PathBuf,
    store: MetaStore,
    row: AgentRow,
    inventory_id: String,
    request: Arc<inventory::requests::Request>,
    requests: Requests,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let serial = super::tests::fixture_lock();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let store = MetaStore::open(&root.join("synthetic-metadata.sqlite3")).unwrap();
        let row = AgentRow {
            id: format!("independent-{}", uuid().unwrap()),
            name: "Synthetic fixture".into(),
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
        let inventory_id = uuid().unwrap();
        let request = inventory::requests::shared()
            .begin(
                &row.id,
                root.to_str().unwrap(),
                &inventory_id,
                &uuid().unwrap(),
                Kind::Skills,
            )
            .unwrap()
            .0;
        let selected = target(root.join("selected/SKILL.md").to_str().unwrap());
        let wire = json!({"data":[{"cwd":root,"skills":[{"name":selected.name,"path":selected.path,"description":"Synthetic fixture","scope":"repo","enabled":true}],"errors":[]}]});
        let (snapshot, entries) = serde_json::from_value::<inventory::skills_output::Wire>(wire)
            .unwrap()
            .project_private(root.to_str().unwrap())
            .unwrap();
        *request.targets.lock().unwrap() = Some(Arc::new(TargetSet {
            row: row.clone(),
            directory: Arc::new(Directory::open(root.to_str().unwrap()).unwrap()),
            entries,
        }));
        request.finish(Ok(InventorySnapshot::Skills(snapshot)));
        std::fs::write(root.join("peer-fixture.json"),serde_json::to_vec(&json!({"mode":mode,"target":selected.path,"config":config(root.join("selected-profile.config.toml").to_str().unwrap())})).unwrap()).unwrap();
        Self {
            _serial: serial,
            _temp: temp,
            root,
            store,
            row,
            inventory_id,
            request,
            requests: Requests::default(),
        }
    }
    fn inspect(&self) -> Arc<Job> {
        let job = self
            .requests
            .begin_inspect(&self.row.id, &uuid().unwrap(), &self.inventory_id, 0, false)
            .unwrap()
            .0;
        self.run(&job);
        assert_eq!(job.snapshot().state, State::Ready);
        assert!(job.snapshot().review.is_some());
        job
    }
    fn confirm(&self) -> Arc<Job> {
        let review = self.inspect().snapshot().review.unwrap();
        self.requests
            .begin_confirm(&self.row.id, &uuid().unwrap(), &review.review_id)
            .unwrap()
            .0
    }
    fn run(&self, job: &Job) {
        let peer = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/acp_client/skill_management/independent_peer.py");
        let mut command = Command::new(crate::platform_tests::python());
        command.arg("-u").arg(peer).arg(&self.root);
        let mut exchange = Exchange::new(job, &self.store).unwrap();
        let result =
            inventory::process::run_owned(command, job, Some(&mut exchange), 4 * 1024 * 1024)
                .and_then(|bytes| exchange.finish(&bytes))
                .and_then(|()| {
                    if job.snapshot().action == Action::Inspect {
                        let plan = job.plan.lock().unwrap().clone().unwrap();
                        self.requests.publish_review(job, plan)?;
                    }
                    Ok(())
                });
        job.finish(result.err());
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.root.join("peer-state.json")).unwrap()).unwrap()
    }
    fn audit(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.join("peer-audit.jsonl"))
            .unwrap()
            .lines()
            .map(|v| serde_json::from_str(v).unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let registry = inventory::requests::shared();
        registry.cancel(&self.row.id, &self.inventory_id).unwrap();
        registry.expire_settled_for_test(&self.inventory_id);
        let _ = registry.get(&self.row.id, &self.inventory_id);
    }
}

#[test]
fn independent_ready_inventory_cancel_revokes_management_but_keeps_public_history() {
    let f = Fixture::new("ok");
    let review = f.inspect().snapshot().review.unwrap();
    let cancel = inventory::requests::shared()
        .cancel(&f.row.id, &f.inventory_id)
        .unwrap();
    assert_eq!(cancel.operation.unwrap().state, State::Ready);
    assert!(f.request.snapshot().unwrap().snapshot.is_some());
    assert!(f.request.targets.lock().unwrap().is_none());
    assert!(matches!(
        f.requests
            .begin_inspect(&f.row.id, &uuid().unwrap(), &f.inventory_id, 0, false),
        Err(Failure {
            code: Code::TargetUnavailable
        })
    ));
    assert!(matches!(
        f.requests
            .begin_confirm(&f.row.id, &uuid().unwrap(), &review.review_id),
        Err(Failure {
            code: Code::TargetUnavailable
        })
    ));
    assert_eq!(f.state()["writes"], 0);
}

#[test]
fn independent_postwrite_errors_and_lost_ack_cannot_be_reported_as_rejected_or_not_dispatched() {
    for mode in [
        "postwrite_user_layer_missing",
        "postwrite_internal",
        "postwrite_lost_ack",
    ] {
        let f = Fixture::new(mode);
        let job = f.confirm();
        f.run(&job);
        let op = job.snapshot();
        assert!(op.settled, "{mode}");
        assert!(op.write_dispatched, "{mode}");
        assert_eq!(op.write_ack, Ack::Unknown, "{mode}");
        assert_eq!(op.outcome, Some(Outcome::Unknown), "{mode}");
        assert_eq!(f.state()["writes"], 1, "{mode}");
        let recheck = f
            .requests
            .begin_recheck(&f.row.id, &uuid().unwrap(), &op.request_id)
            .unwrap()
            .0;
        f.run(&recheck);
        assert_eq!(
            recheck.snapshot().outcome,
            Some(Outcome::Observed),
            "{mode}"
        );
        assert_eq!(recheck.snapshot().write_ack, Ack::Unknown, "{mode}");
        assert_eq!(f.state()["writes"], 1, "recheck must not write: {mode}");
        assert!(
            !serde_json::to_string(&op)
                .unwrap()
                .contains("SYNTHETIC_PRIVATE")
        );
    }
}

#[test]
fn independent_known_prewrite_rejections_preserve_original_synthetic_config() {
    for code in [
        "configLayerReadonly",
        "configRequirementReadonly",
        "configVersionConflict",
        "configValidationError",
    ] {
        let f = Fixture::new(&format!("reject:{code}"));
        let job = f.confirm();
        f.run(&job);
        assert_eq!(job.snapshot().write_ack, Ack::Rejected, "{code}");
        assert_eq!(job.snapshot().outcome, Some(Outcome::Rejected), "{code}");
        assert_eq!(f.state()["writes"], 0, "{code}");
        assert_eq!(
            f.audit()
                .iter()
                .filter(|v| v["method"] == "config/value/write")
                .count(),
            1
        );
    }
}

#[test]
fn independent_matching_ok_overridden_is_verified_but_non_target_corruption_is_not() {
    for (mode, expected) in [
        ("overridden", Outcome::Verified),
        ("non_target_corruption", Outcome::Mismatch),
        ("skill_mismatch", Outcome::Mismatch),
    ] {
        let f = Fixture::new(mode);
        let job = f.confirm();
        f.run(&job);
        assert_eq!(job.snapshot().outcome, Some(expected), "{mode}");
        assert_eq!(f.state()["writes"], 1);
    }
}

#[test]
fn independent_malformed_postwrite_error_is_unknown_not_known_rejection() {
    let f = Fixture::new("postwrite_malformed_rejection");
    let job = f.confirm();
    f.run(&job);
    assert_eq!(f.state()["writes"], 1);
    assert_eq!(job.snapshot().write_ack, Ack::Unknown);
    assert_eq!(job.snapshot().outcome, Some(Outcome::Unknown));
}

#[test]
fn independent_expired_inventory_cannot_leave_review_arc_authority_after_cancel() {
    let f = Fixture::new("ok");
    let inspected = f.inspect();
    let review = inspected.snapshot().review.unwrap();
    let source = inspected.source.clone();
    assert!(source.available());
    let registry = inventory::requests::shared();
    registry.expire_settled_for_test(&f.inventory_id);
    assert!(matches!(
        registry.get(&f.row.id, &f.inventory_id),
        Err(Failure {
            code: Code::UnknownRequest
        })
    ));
    // Cancel addresses the expired original UUID; the still-live review carries
    // that original Arc. A new tombstone must not leave its old authority alive.
    assert!(
        registry
            .cancel(&f.row.id, &f.inventory_id)
            .unwrap()
            .operation
            .is_none()
    );
    let confirmation = f
        .requests
        .begin_confirm(&f.row.id, &uuid().unwrap(), &review.review_id);
    assert!(matches!(
        confirmation,
        Err(Failure {
            code: Code::TargetUnavailable
        })
    ));
    assert!(!source.available());
    assert_eq!(f.state()["writes"], 0);
}

#[test]
fn independent_inventory_revocation_does_not_cancel_separately_admitted_confirmation() {
    let f = Fixture::new("ok");
    let job = f.confirm();
    inventory::requests::shared()
        .cancel(&f.row.id, &f.inventory_id)
        .unwrap();
    assert!(!job.source.available());
    f.run(&job);
    assert_eq!(job.snapshot().outcome, Some(Outcome::Verified));
    assert_eq!(f.state()["writes"], 1);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn independent_actual_worker_holds_shared_slot_and_permits_after_observer_drop() {
    use std::{future::Future, task::Poll, time::Duration};
    let f = Fixture::new("postwrite_held_child");
    let job = f.confirm();
    let manager =
        crate::acp_client::manager::AcpManager::new(f.root.join("synthetic-logs"), f.root.clone());
    let scope = manager
        .reserve_preparation_action(&f.row, &f.row.command, &f.row.args)
        .unwrap();
    let admission = crate::managed_update::UpdateAdmission::default();
    let activity = admission.activity().unwrap();
    let peer = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/acp_client/skill_management/independent_peer.py");
    let mut command = Command::new(crate::platform_tests::python());
    command.arg("-u").arg(peer).arg(&f.root);
    let execution = tokio::spawn(super::execute_with(
        f.store.clone(),
        job.clone(),
        activity,
        scope,
        move |store, job| super::run_selected(store, job, command),
    ));
    tokio::time::timeout(Duration::from_secs(4), async {
        while !f.root.join("held-child.pid").exists() || !f.root.join("leader-exiting").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let pid: i32 = std::fs::read_to_string(f.root.join("held-child.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(job.snapshot().write_dispatched);
    assert!(!job.snapshot().settled);
    assert_eq!(f.state()["writes"], 1);
    // Poll the actual observer to Pending, then drop it. No heuristic sleep or
    // artificial mutation of the worker's control flag substitutes for this.
    let mut observer = Box::pin(super::wait(job.clone()));
    std::future::poll_fn(|cx| {
        assert!(observer.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(observer);
    assert!(!job.operation.interested());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(crate::platform_tests::process_check(pid), 0);
    assert!(!job.snapshot().settled);
    assert!(admission.update().is_err());
    assert!(
        manager
            .reserve_preparation_action(&f.row, &f.row.command, &f.row.args)
            .is_err()
    );
    // The other slot uses the exact lease shared with inventory. The third
    // cannot be admitted while the real orphan/group/pipes remain alive.
    let second = inventory::execution::acquire().unwrap();
    assert!(matches!(
        inventory::execution::acquire(),
        Err(Failure { code: Code::Busy })
    ));
    std::fs::write(f.root.join("release-child"), b"release controlled child").unwrap();
    tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .unwrap()
        .unwrap();
    assert!(job.snapshot().settled);
    assert_eq!(job.snapshot().write_ack, Ack::Unknown);
    assert_eq!(job.snapshot().outcome, Some(Outcome::Unknown));
    assert_ne!(crate::platform_tests::process_check(pid), 0);
    assert!(admission.update().is_ok());
    assert!(
        manager
            .reserve_preparation_action(&f.row, &f.row.command, &f.row.args)
            .is_ok()
    );
    let released = inventory::execution::acquire().unwrap();
    assert!(matches!(
        inventory::execution::acquire(),
        Err(Failure { code: Code::Busy })
    ));
    drop(released);
    drop(second);
    assert_eq!(
        f.state()["writes"],
        1,
        "cleanup never rolls back or repeats a write"
    );
}
