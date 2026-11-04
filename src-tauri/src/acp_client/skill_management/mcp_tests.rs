//! Real production registry/exchange/process, only synthetic temp metadata/peers.
use super::*;
use inventory::{Kind, mcp_targets};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};
pub(super) struct Fixture {
    _serial: std::sync::MutexGuard<'static, ()>,
    temp: tempfile::TempDir,
    pub store: MetaStore,
    pub agent: String,
    pub inventory: String,
    pub registry: requests::Requests,
}
pub(super) fn config() -> Value {
    json!({"layers":[{"name":{"type":"user","file":super::tests::fixture_path("/synthetic/selected.config.toml"),"profile":"selected"},"version":"v1","config":{"model":"unchanged","other":{"future":[1,true,{"nested":"keep"}]},"mcp_servers":{"fixture.one":{"command":super::tests::fixture_path("/synthetic/program"),"args":["--bounded"],"env":{"PRIVATE_SENTINEL":"never-public-value"},"enabled_tools":["read"],"disabled_tools":["write"],"future":{"array":[1,2]},"enabled":true},"fixture":{"one":{"enabled":true,"untouched":[1,2]}},"unrelated":{"url":"https://synthetic.invalid","http_headers":{"SECRET_SENTINEL":"do-not-show"},"enabled":false}}}}]})
}
pub(super) fn report() -> Value {
    json!({"name":"fixture.one","enabled":true,"disabled_reason":null,"transport":{"type":"stdio","command":super::tests::fixture_path("/synthetic/program"),"args":["--bounded"],"env":{"PRIVATE_SENTINEL":"never-public-value"},"env_vars":[],"cwd":null},"enabled_tools":["read"],"disabled_tools":["write"],"startup_timeout_sec":null,"tool_timeout_sec":null})
}
impl Fixture {
    pub fn new() -> Self {
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
            name: "Synthetic MCP".into(),
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
        let mut listed = report();
        listed.as_object_mut().unwrap().remove("enabled_tools");
        listed.as_object_mut().unwrap().remove("disabled_tools");
        listed["auth_status"] = json!("unsupported");
        let (snapshot, entries) =
            inventory::output::parse_private(&serde_json::to_vec(&json!([listed])).unwrap())
                .unwrap();
        *request.mcp_targets.lock().unwrap() = Some(Arc::new(mcp_targets::TargetSet {
            row,
            directory: Arc::new(inventory::launch::Directory::open(&cwd).unwrap()),
            entries,
            names: std::collections::HashSet::from(["fixture.one".to_owned()]),
        }));
        request.finish(Ok(inventory::InventorySnapshot::Mcp(snapshot)));
        std::fs::write(temp.path().join("state.json"),serde_json::to_vec(&json!({"name":"fixture.one","config":config(),"report":report(),"methods":[],"writes":0})).unwrap()).unwrap();
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
    pub fn run(&self, job: &Job, mode: &str) {
        let peer = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/acp_client/skill_management/mcp_peer.py");
        let result = mcp::run_with(&self.store, job, |stage| {
            let mut command = Command::new(crate::platform_tests::python());
            command
                .arg("-u")
                .arg(&peer)
                .arg(self.temp.path())
                .arg(mode)
                .arg(match stage {
                    mcp::Stage::Get => "get",
                    mcp::Stage::AppServer => "server",
                });
            Ok(command)
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
    pub fn job(&self) -> Arc<Job> {
        self.registry
            .begin_inspect_kind(
                &self.agent,
                &requests::uuid().unwrap(),
                &self.inventory,
                0,
                false,
                Kind::Mcp,
            )
            .unwrap()
            .0
    }
    pub fn inspect(&self) -> (Arc<Job>, Review) {
        let job = self.job();
        self.run(&job, "normal");
        let review = job.snapshot().review.clone().unwrap();
        (job, review)
    }
    pub fn confirm(&self, review: &Review) -> Arc<Job> {
        self.registry
            .begin_confirm_kind(
                &self.agent,
                &requests::uuid().unwrap(),
                &review.review_id,
                Kind::Mcp,
            )
            .unwrap()
            .0
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let registry = inventory::requests::shared();
        let _ = registry.cancel(&self.agent, &self.inventory);
        registry.expire_settled_for_test(&self.inventory);
        let _ = registry.get(&self.agent, &self.inventory);
    }
}
#[test]
fn mcp_fixed_exchange_preserves_unknown_config_and_reports_no_connection_claim() {
    let f = Fixture::new();
    let (_, review) = f.inspect();
    let job = f.confirm(&review);
    f.run(&job, "normal");
    let op = job.snapshot();
    assert_eq!(op.outcome, Some(Outcome::Verified));
    assert_eq!(op.write_ack, Ack::Ok);
    let state = f.state();
    let mut expected = config();
    expected["layers"][0]["config"]["mcp_servers"]["fixture.one"]["enabled"] = json!(false);
    expected["layers"][0]["version"] = json!("after-v1");
    assert_eq!(state["config"], expected);
    assert_eq!(state["writes"], 1);
    assert_eq!(state["writeParams"]["value"], false);
    assert!(state["methods"].as_array().unwrap().iter().all(|v| {
        [
            "initialize",
            "initialized",
            "config/read",
            "config/value/write",
        ]
        .contains(&v.as_str().unwrap())
    }));
    let public = serde_json::to_string(&op).unwrap();
    assert!(!public.contains("never-public-value"));
    assert!(!public.contains("do-not-show"));
    assert!(!public.contains("/synthetic/program"));
    assert_eq!(op.observation.unwrap().session_applicability, "unverified");
}
#[test]
fn mcp_inherited_or_project_same_name_refuses_without_write() {
    let f = Fixture::new();
    let job = f.job();
    f.run(&job, "project-conflict");
    assert_eq!(job.snapshot().code, Some(Code::ConfigurationUnsupported));
    assert!(!job.snapshot().write_dispatched);
    assert_eq!(f.state()["writes"], 0);
}

fn scope_files(f: &Fixture, kind: &str) -> Vec<(PathBuf, Vec<u8>)> {
    let mut user = config()["layers"][0].clone();
    user["name"] = json!({"type":"user","file":f.temp.path().join("user.layer.json")});
    let entry = user["config"]["mcp_servers"]["fixture.one"].clone();
    if !matches!(kind, "conflict" | "unknown-conflict") {
        user["config"]["mcp_servers"]
            .as_object_mut()
            .unwrap()
            .remove("fixture.one");
    }
    let other_name = match kind {
        "inherited" => json!({"type":"system","file":f.temp.path().join("other.layer.json")}),
        "unknown" | "unknown-conflict" => {
            json!({"type":"futureUnknown","file":f.temp.path().join("other.layer.json")})
        }
        "missing" => json!({"type":"project"}),
        "malformed" => json!({"type":"project","dotCodexFolder":"relative/.codex"}),
        _ => json!({"type":"project","dotCodexFolder":f.temp.path().join(".codex")}),
    };
    let other = json!({"name":other_name,"version":"scope-v1","config":{"mcp_servers":{"fixture.one":entry}},"disabledReason":null});
    let mut original = Vec::new();
    for (name, value) in [("user.layer.json", user), ("other.layer.json", other)] {
        let bytes = serde_json::to_vec(&value).unwrap();
        let path = f.temp.path().join(name);
        std::fs::write(&path, &bytes).unwrap();
        original.push((path, bytes));
    }
    let mut state = f.state();
    state["scopeFiles"] = json!({
        "global":if kind=="inherited" {vec!["other.layer.json","user.layer.json"]}else{vec!["user.layer.json"]},
        "directory":["user.layer.json","other.layer.json"],
        "effective":"other.layer.json"
    });
    std::fs::write(
        f.temp.path().join("state.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    original
}

fn assert_scope_refusal(kind: &str, expected: &str) {
    let f = Fixture::new();
    let sources = scope_files(&f, kind);
    let job = f.job();
    f.run(&job, "scope-files");
    let op = job.snapshot();
    assert!(op.settled);
    assert_eq!(op.state, State::Failed);
    assert!(!op.write_dispatched);
    assert_eq!(op.write_ack, Ack::None);
    assert!(op.review.is_none());
    assert_eq!(f.state()["writes"], 0);
    assert!(
        f.state()["methods"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v != "config/value/write")
    );
    for (path, bytes) in sources {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    let public = serde_json::to_string(&op).unwrap();
    assert!(!public.contains("never-public-value"));
    assert!(!public.contains("do-not-show"));
    assert!(!public.contains("user.layer.json"));
    assert!(!public.contains("other.layer.json"));
    println!(
        "MCP_SCOPE_WIRE={}",
        json!({"case":kind,"inventory":inventory::requests::shared().get(&f.agent,&f.inventory).unwrap().snapshot(),"operation":op})
    );
    assert_eq!(serde_json::to_value(op.code).unwrap(), json!(expected));
}

#[test]
fn mcp_scope_project_only_is_precise_and_never_writes() {
    assert_scope_refusal("project", "configurationProjectOnly");
}

#[test]
fn mcp_scope_inherited_is_precise_and_never_writes() {
    assert_scope_refusal("inherited", "configurationInherited");
}

#[test]
fn mcp_scope_cross_layer_conflict_is_precise_and_never_writes() {
    assert_scope_refusal("conflict", "configurationLayerConflict");
}

#[test]
fn mcp_scope_untrusted_sources_keep_the_generic_refusal() {
    for kind in ["unknown", "missing", "malformed", "unknown-conflict"] {
        assert_scope_refusal(kind, "configurationUnsupported");
    }
}

#[test]
fn mcp_scope_disabled_project_source_does_not_block_the_user_review() {
    let f = Fixture::new();
    let mut sources = scope_files(&f, "conflict");
    let (path, bytes) = &mut sources[1];
    let mut layer: Value = serde_json::from_slice(bytes).unwrap();
    layer["disabledReason"] = json!("owned untrusted-project fixture");
    *bytes = serde_json::to_vec(&layer).unwrap();
    std::fs::write(path, &*bytes).unwrap();
    let job = f.job();
    f.run(&job, "scope-files");
    assert_eq!(job.snapshot().state, State::Ready);
    assert!(job.snapshot().review.is_some());
    assert!(!job.snapshot().write_dispatched);
    assert_eq!(f.state()["writes"], 0);
    for (path, bytes) in sources {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn mcp_scope_user_only_unknown_source_metadata_keeps_existing_review() {
    let f = Fixture::new();
    let mut sources = scope_files(&f, "conflict");
    let (path, bytes) = &mut sources[0];
    let mut layer: Value = serde_json::from_slice(bytes).unwrap();
    layer["name"]["futureOpaque"] = json!({"nested":["private-source-canary",true]});
    *bytes = serde_json::to_vec(&layer).unwrap();
    std::fs::write(path, &*bytes).unwrap();
    let mut state = f.state();
    state["scopeFiles"] = json!({"global":["user.layer.json"],"directory":["user.layer.json"],"effective":"user.layer.json"});
    std::fs::write(
        f.temp.path().join("state.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    let job = f.job();
    f.run(&job, "scope-files");
    let op = job.snapshot();
    assert_eq!(op.state, State::Ready);
    assert!(op.review.is_some());
    assert_eq!(op.code, None);
    assert!(!op.write_dispatched);
    assert_eq!(f.state()["writes"], 0);
    assert!(
        !serde_json::to_string(&op)
            .unwrap()
            .contains("private-source-canary")
    );
    for (path, bytes) in sources {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

fn assert_duplicate_scope_refusal(variant: &str) {
    let f = Fixture::new();
    let mut sources = scope_files(&f, "conflict");
    let mut other: Value = serde_json::from_slice(&sources[0].1).unwrap();
    if variant == "snapshot" {
        other["version"] = json!("another-version-same-source");
        other["config"]["other"]["future"] = json!(["another-value-same-source"]);
    } else if variant == "default-profile" {
        other["name"]["profile"] = Value::Null;
    }
    sources[1].1 = serde_json::to_vec(&other).unwrap();
    std::fs::write(&sources[1].0, &sources[1].1).unwrap();
    let mut state = f.state();
    state["scopeFiles"] = json!({"global":["user.layer.json","other.layer.json"],"directory":["user.layer.json","other.layer.json"],"effective":"user.layer.json"});
    std::fs::write(
        f.temp.path().join("state.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    let job = f.job();
    f.run(&job, "scope-files");
    let op = job.snapshot();
    assert!(op.settled);
    assert_eq!(op.state, State::Failed);
    assert!(!op.write_dispatched);
    assert_eq!(op.write_ack, Ack::None);
    assert!(op.review.is_none());
    assert_eq!(f.state()["writes"], 0);
    assert!(
        f.state()["methods"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v != "config/value/write")
    );
    for (path, bytes) in sources {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    let public = serde_json::to_string(&op).unwrap();
    assert!(!public.contains("never-public-value"));
    assert!(!public.contains("do-not-show"));
    println!(
        "MCP_SCOPE_DUPLICATE_WIRE={}",
        json!({"case":variant,"operation":op})
    );
    assert_eq!(op.code, Some(Code::ConfigurationUnsupported));
}

#[test]
fn mcp_scope_duplicate_same_user_source_keeps_generic_refusal() {
    assert_duplicate_scope_refusal("exact");
}

#[test]
fn mcp_scope_duplicate_user_source_changed_snapshot_keeps_generic_refusal() {
    assert_duplicate_scope_refusal("snapshot");
}

#[test]
fn mcp_scope_duplicate_user_default_profile_keeps_generic_refusal() {
    assert_duplicate_scope_refusal("default-profile");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn mcp_scope_cancelled_layer_read_ends_worker_without_writing() {
    use std::time::Duration;
    let f = Fixture::new();
    let sources = scope_files(&f, "project");
    std::fs::write(f.temp.path().join("scope-pause"), b"owned test gate").unwrap();
    let job = f.job();
    let row = f.store.get_agent(&f.agent).unwrap().unwrap();
    let manager = crate::acp_client::manager::AcpManager::new(
        f.temp.path().join("controlled-logs"),
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
        job.clone(),
        activity,
        scope,
        move |store, job| {
            mcp::run_with(store, job, |stage| {
                let mut command = Command::new(crate::platform_tests::python());
                command
                    .arg("-u")
                    .arg(
                        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                            .join("src/acp_client/skill_management/mcp_peer.py"),
                    )
                    .arg(&root)
                    .arg("scope-files")
                    .arg(match stage {
                        mcp::Stage::Get => "get",
                        mcp::Stage::AppServer => "server",
                    });
                Ok(command)
            })
        },
    ));
    let marker = f.temp.path().join("scope-waiting");
    tokio::time::timeout(Duration::from_secs(5), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    assert!(admission.update().is_err());
    assert!(
        f.registry
            .cancel_kind(&f.agent, &job.snapshot().request_id, Kind::Mcp)
            .unwrap()
            .cancel_requested
    );
    tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(crate::platform_tests::process_check(pid), 0);
    assert!(admission.update().is_ok());
    assert_eq!(job.snapshot().state, State::Cancelled);
    assert_eq!(job.snapshot().code, Some(Code::Cancelled));
    assert!(!job.snapshot().write_dispatched);
    assert_eq!(job.snapshot().write_ack, Ack::None);
    assert!(job.snapshot().review.is_none());
    assert_eq!(f.state()["writes"], 0);
    assert!(
        f.state()["methods"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v != "config/value/write")
    );
    for (path, bytes) in sources {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn mcp_postwrite_failures_never_become_cancelled_or_verified() {
    for mode in ["lost-ack", "postwrite-error", "postget-fail"] {
        let f = Fixture::new();
        let (_, review) = f.inspect();
        let job = f.confirm(&review);
        f.run(&job, mode);
        let op = job.snapshot();
        assert!(op.write_dispatched);
        assert_eq!(op.outcome, Some(Outcome::Unknown), "{mode}");
        assert_eq!(op.state, State::Failed);
        assert_eq!(f.state()["writes"], 1);
        let check = f
            .registry
            .begin_recheck_kind(
                &f.agent,
                &requests::uuid().unwrap(),
                &op.request_id,
                Kind::Mcp,
            )
            .unwrap()
            .0;
        f.run(&check, "normal");
        assert_eq!(check.snapshot().outcome, Some(Outcome::Observed));
        assert_eq!(f.state()["writes"], 1);
    }
}
#[test]
fn mcp_acknowledged_readback_change_is_mismatch_and_refusal_is_rejected() {
    for mode in ["changed-other", "refused"] {
        let f = Fixture::new();
        let (_, review) = f.inspect();
        let job = f.confirm(&review);
        f.run(&job, mode);
        assert_eq!(
            job.snapshot().outcome,
            Some(if mode == "refused" {
                Outcome::Rejected
            } else {
                Outcome::Mismatch
            })
        );
    }
}
#[test]
fn mcp_ready_inventory_cancel_revokes_existing_review() {
    let f = Fixture::new();
    let (_, review) = f.inspect();
    inventory::requests::shared()
        .cancel(&f.agent, &f.inventory)
        .unwrap();
    assert!(matches!(
        f.registry.begin_confirm_kind(
            &f.agent,
            &requests::uuid().unwrap(),
            &review.review_id,
            Kind::Mcp
        ),
        Err(Failure {
            code: Code::TargetUnavailable
        })
    ));
}
#[test]
fn mcp_actual_serialized_wire_from_production_fixed_exchange() {
    let f = Fixture::new();
    let job = f.job();
    let running = job.snapshot();
    f.run(&job, "normal");
    let ready = job.snapshot();
    let confirm = f.confirm(ready.review.as_ref().unwrap());
    let pending = confirm.snapshot();
    f.run(&confirm, "normal");
    println!(
        "MCP_MANAGEMENT_WIRE={}",
        json!({"inventory":inventory::requests::shared().get(&f.agent,&f.inventory).unwrap().snapshot(),"inspectRunning":running,"inspectReady":ready,"confirmRunning":pending,"confirmReady":confirm.snapshot()})
    );
}

#[test]
fn mcp_postget_filter_drift_cannot_verify_the_reviewed_target() {
    let f = Fixture::new();
    let (_, review) = f.inspect();
    let job = f.confirm(&review);
    f.run(&job, "postget-filter-drift");
    assert!(job.snapshot().write_dispatched);
    assert_eq!(job.snapshot().write_ack, Ack::Ok);
    assert_eq!(job.snapshot().outcome, Some(Outcome::Unknown));
    assert_eq!(job.snapshot().code, Some(Code::TargetChanged));
    assert!(job.snapshot().observation.is_none());
    assert_eq!(f.state()["writes"], 1);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn mcp_postget_cancel_retains_actual_worker_lease_and_unknown_write_fact() {
    use inventory::process::Control;
    use std::time::Duration;
    let f = Fixture::new();
    let (_, review) = f.inspect();
    let job = f.confirm(&review);
    let row = f.store.get_agent(&f.agent).unwrap().unwrap();
    let manager = crate::acp_client::manager::AcpManager::new(
        f.temp.path().join("controlled-logs"),
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
        job.clone(),
        activity,
        scope,
        move |store, job| {
            mcp::run_with(store, job, |stage| {
                let mut command = Command::new(crate::platform_tests::python());
                command
                    .arg("-u")
                    .arg(
                        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                            .join("src/acp_client/skill_management/mcp_peer.py"),
                    )
                    .arg(&root)
                    .arg("postget-wait")
                    .arg(match stage {
                        mcp::Stage::Get => "get",
                        mcp::Stage::AppServer => "server",
                    });
                Ok(command)
            })
        },
    ));
    let marker = f.temp.path().join("postget-waiting");
    let reached = tokio::time::timeout(Duration::from_secs(5), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    let cancel = f
        .registry
        .cancel_kind(&f.agent, &job.snapshot().request_id, Kind::Mcp)
        .unwrap();
    assert!(reached, "controlled second get did not start");
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    assert!(cancel.cancel_requested);
    assert!(!cancel.operation.unwrap().settled);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(crate::platform_tests::process_check(pid), 0);
    assert!(!job.snapshot().settled);
    assert_eq!(job.snapshot().write_ack, Ack::Ok);
    assert!(admission.update().is_err());
    let second = inventory::execution::acquire().unwrap();
    assert!(matches!(
        inventory::execution::acquire(),
        Err(Failure { code: Code::Busy })
    ));
    // Serialize the real Job's pending publication path, not a hand-written DTO.
    // The pending transition is explicitly test-triggered; the peer is killable.
    job.pending_cleanup();
    let pending = job.snapshot();
    assert!(!pending.settled);
    assert!(pending.outcome.is_none());
    tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(crate::platform_tests::process_check(pid), 0);
    assert!(admission.update().is_ok());
    drop(second);
    let unknown = job.snapshot();
    assert!(unknown.settled);
    assert_eq!(unknown.outcome, Some(Outcome::Unknown));
    assert_eq!(unknown.code, Some(Code::Cancelled));
    assert_eq!(f.state()["writes"], 1);
    let recheck = f
        .registry
        .begin_recheck_kind(
            &f.agent,
            &requests::uuid().unwrap(),
            &unknown.request_id,
            Kind::Mcp,
        )
        .unwrap()
        .0;
    f.run(&recheck, "normal");
    assert_eq!(recheck.snapshot().outcome, Some(Outcome::Observed));
    assert_eq!(f.state()["writes"], 1);
    println!(
        "MCP_LIFECYCLE_WIRE={}",
        json!({"review":review,"pendingCleanup":pending,"confirmUnknown":unknown,"recheckObserved":recheck.snapshot()})
    );
}
#[test]
fn mcp_http_profile_literal_names_default_enabled_and_unrelated_values_are_preserved() {
    use super::{mcp_plan::Plan, plan::Config};
    for name in ["fixture.one", "two words", "quote\"and\\backslash"] {
        let mut raw = config();
        let data = &mut raw["layers"][0]["config"]["mcp_servers"];
        data[name] = json!({"url":"https://synthetic.invalid/private?token=PRIVATE_SENTINEL","http_headers":{"Authorization":"PRIVATE_SENTINEL"},"env_http_headers":{"future":"ENV_NAME"},"enabled_tools":["one"],"future":{"nested":[1,null,true]}});
        let value = json!({"name":"fixture.one","enabled":true,"disabled_reason":null,"transport":{"type":"streamable_http","url":"https://synthetic.invalid/private?token=PRIVATE_SENTINEL","http_headers":{"Authorization":"PRIVATE_SENTINEL"}},"enabled_tools":["one"]});
        let mut target = mcp_targets::target(&value, 0).unwrap();
        // Quote-only names do not gain UI eligibility; this tests the private
        // official key encoder against literal segments, separately from labels.
        target.name = name.into();
        let report = mcp_targets::Report {
            target,
            enabled: true,
            policy_disabled: false,
        };
        let before = Config::parse(raw.clone()).unwrap();
        let plan = Plan::new(before.clone(), before, report, false).unwrap();
        assert!(plan.configured); // official missing enabled default
        assert_eq!(
            plan.params()["keyPath"],
            format!(
                "mcp_servers.\"{}\".enabled",
                name.replace('\\', "\\\\").replace('\"', "\\\"")
            )
        );
        let mut after = raw.clone();
        after["layers"][0]["config"]["mcp_servers"][name]["enabled"] = json!(false);
        after["layers"][0]["version"] = json!("changed");
        let after = Config::parse(after).unwrap();
        assert!(plan.matches(&after, &after));
        assert_eq!(
            plan.intended["mcp_servers"]["fixture"],
            raw["layers"][0]["config"]["mcp_servers"]["fixture"]
        );
        assert_eq!(
            plan.intended["mcp_servers"][name]["http_headers"],
            raw["layers"][0]["config"]["mcp_servers"][name]["http_headers"]
        );
    }
}

#[test]
fn mcp_initial_user_and_reported_enabled_mismatch_cannot_issue_a_plan() {
    use super::{mcp_plan::Plan, plan::Config};
    for configured in [false, true] {
        for desired in [false, true] {
            let mut raw = config();
            raw["layers"][0]["config"]["mcp_servers"]["fixture.one"]["enabled"] = json!(configured);
            let before = Config::parse(raw).unwrap();
            let report = mcp_targets::Report {
                target: mcp_targets::target(&report(), 0).unwrap(),
                enabled: !configured,
                policy_disabled: false,
            };
            assert!(matches!(
                Plan::new(before.clone(), before, report, desired),
                Err(Failure {
                    code: Code::ConfigurationChanged
                })
            ));
            // No Plan exists from which to publish a review or write parameters;
            // choosing either explicit desired value does not relax this guard.
        }
    }
}
