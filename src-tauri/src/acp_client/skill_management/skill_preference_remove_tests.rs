//! Real registry/exchange/owned peer; all configuration is fresh synthetic state.
use super::{domain::Domain, plan::Config, skill_preference_remove_plan::Plan, *};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};

struct Fixture {
    skill: tests::Fixture,
    state: tempfile::TempDir,
}
impl Fixture {
    fn new(siblings: bool) -> Self {
        let skill = tests::Fixture::new();
        let state = tempfile::tempdir().unwrap();
        let mut config = tests::config();
        let raw = &mut config["layers"][0]["config"];
        raw["private"] =
            json!({"canary":"PRIVATE_CONFIG_CANARY","opaque":[1,true,{"nested":"keep"}]});
        raw["skills"]["config"] = if siblings {
            json!([
                {"name":"fixture","enabled":false,"future":{"keep":[1,true]}},
                {"path":skill.target.path,"enabled":false},
                {"path":tests::fixture_path("/different/SKILL.md"),"enabled":true,"opaque":{"keep":"PRIVATE_RULE_CANARY"}}
            ])
        } else {
            json!([{"path":skill.target.path,"enabled":false}])
        };
        if siblings {
            raw["skills"]["future"] = json!({"keep":[false,42]});
        }
        std::fs::write(
            state.path().join("state.json"),
            serde_json::to_vec(&json!({"config":config,"enabled":false,"writes":0})).unwrap(),
        )
        .unwrap();
        Self { skill, state }
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.state.path().join("state.json")).unwrap())
            .unwrap()
    }
    fn save(&self, value: &Value) {
        std::fs::write(
            self.state.path().join("state.json"),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }
    fn job(&self) -> Arc<Job> {
        self.skill
            .registry
            .begin_skill_preference_remove_inspect(
                &self.skill.agent,
                &requests::uuid().unwrap(),
                &self.skill.inventory,
                0,
            )
            .unwrap()
            .0
    }
    fn run_unfinished(&self, job: &Job, mode: &str) -> Result<()> {
        let mut command = Command::new(crate::platform_tests::python());
        command
            .arg("-u")
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("src/acp_client/skill_management/skill_preference_remove_peer.py"),
            )
            .arg(self.state.path())
            .arg(job.source.cwd())
            .arg(&self.skill.target.path)
            .arg(mode);
        super::run_selected(&self.skill.store, job, command)?;
        if job.snapshot().action == Action::Inspect {
            self.skill
                .registry
                .publish_review(job, job.plan.lock().unwrap().clone().unwrap())?;
        }
        Ok(())
    }
    fn run(&self, job: &Job, mode: &str) {
        job.finish(self.run_unfinished(job, mode).err());
    }
    fn inspect(&self) -> (Arc<Job>, Review) {
        let job = self.job();
        self.run(&job, "normal");
        let review = job.snapshot().review.unwrap();
        (job, review)
    }
    fn confirm(&self, review: &Review) -> Arc<Job> {
        self.skill
            .registry
            .begin_confirm_domain(
                &self.skill.agent,
                &requests::uuid().unwrap(),
                &review.review_id,
                Domain::SkillPreferenceRemoval,
            )
            .unwrap()
            .0
    }
    fn recheck(&self, job: &Job) -> Arc<Job> {
        self.skill
            .registry
            .begin_recheck_domain(
                &self.skill.agent,
                &requests::uuid().unwrap(),
                &job.snapshot().request_id,
                Domain::SkillPreferenceRemoval,
            )
            .unwrap()
            .0
    }
}

#[test]
fn skill_preference_remove_preserves_other_rules_unknown_json_and_reports_actual_disabled() {
    let fixture = Fixture::new(true);
    let before = fixture.state();
    let (inspection, review) = fixture.inspect();
    assert_eq!(review.requested_enabled, None);
    assert_eq!(review.reported_enabled, Some(false));
    assert_eq!(review.configured_enabled, Some(Some(false)));
    assert_eq!(review.rules_before, Some(3));
    assert_eq!(review.rules_after, Some(2));
    assert_eq!(review.parent_handling, Some("preserveSiblings"));
    assert_eq!(review.mutation, "removeSkillPathPreference");
    let serialized = serde_json::to_value(&review).unwrap();
    assert_eq!(serialized["target"]["kind"], "skillPreferenceRemoval");
    assert_eq!(
        serialized["target"]["displayPath"],
        super::plan::display_path(&fixture.skill.target.path).unwrap()
    );
    let confirmation = fixture.confirm(&review);
    fixture.run(&confirmation, "reported-disabled");
    let operation = confirmation.snapshot();
    assert_eq!(operation.action, Action::Remove);
    assert_eq!(operation.outcome, Some(Outcome::Verified));
    let observed = operation.observation.as_ref().unwrap();
    assert_eq!(observed.configuration, "matching");
    assert_eq!(observed.skill, Some("reported"));
    assert_eq!(observed.configured_enabled, Some(None));
    assert_eq!(observed.reported_enabled, Some(false));
    assert_eq!(observed.parent_outcome, Some(Some("nonempty")));
    assert_eq!(observed.session_applicability, "unverified");
    let mut expected = before["config"].clone();
    expected["layers"][0]["config"]["skills"]["config"]
        .as_array_mut()
        .unwrap()
        .remove(1);
    expected["layers"][0]["version"] = json!("after-write");
    assert_eq!(fixture.state()["config"], expected);
    assert_eq!(fixture.state()["writes"], 1);
    let public = serde_json::to_string(
        &json!({"inspection":inspection.snapshot(),"review":review,"operation":operation}),
    )
    .unwrap();
    for private in [
        "PRIVATE_CONFIG_CANARY",
        "PRIVATE_RULE_CANARY",
        "PRIVATE_ERROR_CANARY",
    ] {
        assert!(!public.contains(private));
    }
}

#[test]
fn skill_preference_remove_last_rule_clears_key_and_accepts_only_exact_parent_outcomes() {
    for mode in ["normal", "drop-empty-parent"] {
        let fixture = Fixture::new(false);
        let (_, review) = fixture.inspect();
        assert_eq!(review.parent_handling, Some("mayRemainEmpty"));
        let confirmation = fixture.confirm(&review);
        fixture.run(&confirmation, mode);
        assert_eq!(fixture.state()["writeParams"]["value"], Value::Null);
        let operation = confirmation.snapshot();
        assert_eq!(operation.outcome, Some(Outcome::Verified));
        assert_eq!(
            operation.observation.unwrap().parent_outcome,
            Some(Some(if mode == "normal" { "empty" } else { "absent" }))
        );
    }
    let fixture = Fixture::new(false);
    let mut state = fixture.state();
    state["config"]["layers"][0]["config"]["skills"]["future"] = json!({"keep":true});
    fixture.save(&state);
    let (_, review) = fixture.inspect();
    assert_eq!(review.parent_handling, Some("preserveSiblings"));
    let confirmation = fixture.confirm(&review);
    fixture.run(&confirmation, "normal");
    assert_eq!(
        confirmation.snapshot().observation.unwrap().parent_outcome,
        Some(Some("nonempty"))
    );
    assert_eq!(
        fixture.state()["config"]["layers"][0]["config"]["skills"]["future"],
        json!({"keep":true})
    );
}

#[test]
fn skill_preference_remove_absent_ambiguous_and_unknown_target_rules_never_write() {
    assert_eq!(
        serde_json::to_value(Code::PreferenceNotConfigured).unwrap(),
        "preferenceNotConfigured"
    );
    for variant in [
        "absent",
        "no-skills",
        "no-config",
        "duplicate",
        "named",
        "unknown",
        "missing-enabled",
        "typed-enabled",
    ] {
        let fixture = Fixture::new(false);
        let mut state = fixture.state();
        let rules = &mut state["config"]["layers"][0]["config"]["skills"]["config"];
        match variant {
            "absent" => *rules = json!([]),
            "duplicate" => {
                let copy = rules[0].clone();
                rules.as_array_mut().unwrap().push(copy);
            }
            "named" => rules[0]["name"] = json!("fixture"),
            "unknown" => rules[0]["future"] = json!({"unknown":"preserve-but-refuse"}),
            "missing-enabled" => {
                rules[0].as_object_mut().unwrap().remove("enabled");
            }
            "no-skills" | "no-config" => {}
            _ => rules[0]["enabled"] = json!("false"),
        }
        if variant == "no-skills" {
            state["config"]["layers"][0]["config"]
                .as_object_mut()
                .unwrap()
                .remove("skills");
        } else if variant == "no-config" {
            state["config"]["layers"][0]["config"]["skills"]
                .as_object_mut()
                .unwrap()
                .remove("config");
        }
        fixture.save(&state);
        let job = fixture.job();
        fixture.run(&job, "normal");
        assert!(job.snapshot().review.is_none());
        assert_eq!(
            job.snapshot().code,
            Some(if matches!(variant, "absent" | "no-skills" | "no-config") {
                Code::PreferenceNotConfigured
            } else {
                Code::ConfigurationUnsupported
            })
        );
        assert_eq!(job.snapshot().outcome, Some(Outcome::NotDispatched));
        assert!(!job.snapshot().write_dispatched);
        assert_eq!(fixture.state()["writes"], 0);
    }
}

#[test]
fn skill_preference_remove_changed_before_confirm_and_rejection_do_not_write() {
    let fixture = Fixture::new(false);
    let (_, review) = fixture.inspect();
    let confirmation = fixture.confirm(&review);
    let mut changed = fixture.state();
    changed["config"]["layers"][0]["version"] = json!("external-version");
    fixture.save(&changed);
    fixture.run(&confirmation, "normal");
    assert_eq!(
        confirmation.snapshot().outcome,
        Some(Outcome::NotDispatched)
    );
    assert_eq!(fixture.state()["writes"], 0);
    drop(fixture);
    let fixture = Fixture::new(false);
    let (_, review) = fixture.inspect();
    let confirmation = fixture.confirm(&review);
    fixture.run(&confirmation, "reject");
    assert_eq!(confirmation.snapshot().write_ack, Ack::Rejected);
    assert_eq!(confirmation.snapshot().outcome, Some(Outcome::Rejected));
    assert_eq!(fixture.state()["writes"], 0);
}

#[test]
fn skill_preference_remove_missing_or_corrupted_readback_never_verifies() {
    for mode in ["keep-rule", "corrupt-other", "missing-after"] {
        let fixture = Fixture::new(true);
        let (_, review) = fixture.inspect();
        let confirmation = fixture.confirm(&review);
        fixture.run(&confirmation, mode);
        assert_eq!(confirmation.snapshot().write_ack, Ack::Ok);
        assert_eq!(confirmation.snapshot().outcome, Some(Outcome::Mismatch));
        assert_eq!(fixture.state()["writes"], 1);
    }
}

#[test]
fn skill_preference_remove_lost_ack_recheck_is_read_only_and_preserves_unknown_operation() {
    let fixture = Fixture::new(false);
    let (_, review) = fixture.inspect();
    let confirmation = fixture.confirm(&review);
    fixture.run(&confirmation, "lost-ack");
    let original = confirmation.snapshot();
    assert_eq!(original.outcome, Some(Outcome::Unknown));
    assert_eq!(original.write_ack, Ack::Unknown);
    let recheck = fixture.recheck(&confirmation);
    fixture.run(&recheck, "normal");
    let observed = recheck.snapshot();
    assert_eq!(observed.outcome, Some(Outcome::Observed));
    assert_eq!(observed.write_ack, Ack::Unknown);
    assert!(observed.write_dispatched);
    assert_eq!(observed.operation_id, Some(original.request_id.clone()));
    assert_eq!(
        serde_json::to_value(confirmation.snapshot()).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    assert_eq!(fixture.state()["writes"], 1);
}

#[test]
fn skill_preference_remove_domains_cannot_consume_or_cancel_enablement_reviews() {
    let fixture = Fixture::new(false);
    let (inspection, review) = fixture.inspect();
    let id = inspection.snapshot().request_id;
    assert_eq!(
        fixture
            .skill
            .registry
            .get(&fixture.skill.agent, &id)
            .err()
            .unwrap()
            .code,
        Code::UnknownRequest
    );
    assert_eq!(
        fixture
            .skill
            .registry
            .cancel(&fixture.skill.agent, &id)
            .err()
            .unwrap()
            .code,
        Code::RequestConflict
    );
    assert_eq!(
        fixture
            .skill
            .registry
            .begin_confirm(
                &fixture.skill.agent,
                &requests::uuid().unwrap(),
                &review.review_id
            )
            .err()
            .unwrap()
            .code,
        Code::TargetUnavailable
    );
    assert!(inspection.operation.interested());
    assert!(fixture.confirm(&review).snapshot().action == Action::Remove);
}

#[test]
fn skill_preference_remove_cancellation_before_inspection_keeps_zero_writes() {
    let fixture = Fixture::new(false);
    let id = requests::uuid().unwrap();
    fixture
        .skill
        .registry
        .cancel_domain(&fixture.skill.agent, &id, Domain::SkillPreferenceRemoval)
        .unwrap();
    assert_eq!(
        fixture
            .skill
            .registry
            .begin_skill_preference_remove_inspect(
                &fixture.skill.agent,
                &id,
                &fixture.skill.inventory,
                0
            )
            .err()
            .unwrap()
            .code,
        Code::Cancelled
    );
    assert_eq!(fixture.state()["writes"], 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn skill_preference_remove_cancel_after_write_is_unknown_until_actual_owner_cleanup() {
    let fixture = Fixture::new(false);
    let (_, review) = fixture.inspect();
    let confirmation = fixture.confirm(&review);
    let store = fixture.skill.store.clone();
    let state_path = fixture.state.path().to_path_buf();
    let target = fixture.skill.target.path.clone();
    let worker_job = confirmation.clone();
    let worker = tokio::task::spawn_blocking(move || {
        let mut command = Command::new(crate::platform_tests::python());
        command
            .arg("-u")
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("src/acp_client/skill_management/skill_preference_remove_peer.py"),
            )
            .arg(state_path)
            .arg(worker_job.source.cwd())
            .arg(target)
            .arg("hold-after-write");
        worker_job.finish(super::run_selected(&store, &worker_job, command).err());
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !fixture.state.path().join("write-seen").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    fixture
        .skill
        .registry
        .cancel_domain(
            &fixture.skill.agent,
            &confirmation.snapshot().request_id,
            Domain::SkillPreferenceRemoval,
        )
        .unwrap();
    assert!(confirmation.snapshot().observation.is_none());
    worker.await.unwrap();
    assert!(confirmation.snapshot().settled);
    assert_eq!(confirmation.snapshot().outcome, Some(Outcome::Unknown));
    assert!(confirmation.snapshot().write_dispatched);
    assert_eq!(fixture.state()["writes"], 1);
}

#[test]
fn skill_preference_remove_ambiguous_user_source_is_refused() {
    let fixture = Fixture::new(false);
    let state = fixture.state();
    let mut raw = state["config"].clone();
    let duplicate = raw["layers"][0].clone();
    raw["layers"].as_array_mut().unwrap().push(duplicate);
    assert_eq!(
        Plan::new(Config::parse(raw).unwrap(), fixture.skill.target.clone())
            .err()
            .unwrap()
            .code,
        Code::ConfigurationUnsupported
    );
}

#[test]
fn skill_preference_remove_restores_default_after_old_toggle_leaves_explicit_rule() {
    let fixture = Fixture::new(false);
    let mut original = fixture.state()["config"].clone();
    original["layers"][0]["config"]
        .as_object_mut()
        .unwrap()
        .remove("skills");
    let mut target = fixture.skill.target.clone();
    target.enabled = true;
    let disabled = super::plan::Plan::new(
        Config::parse(original.clone()).unwrap(),
        target.clone(),
        false,
    )
    .unwrap();
    let mut after_disable = original.clone();
    after_disable["layers"][0]["config"] = disabled.intended;
    target.enabled = false;
    let enabled =
        super::plan::Plan::new(Config::parse(after_disable).unwrap(), target.clone(), true)
            .unwrap();
    // The old on/off operation leaves a new explicit rule rather than the default.
    assert_ne!(enabled.intended, original["layers"][0]["config"]);
    assert_eq!(enabled.intended["skills"]["config"][0]["enabled"], true);
    let mut after_enable = original.clone();
    after_enable["layers"][0]["config"] = enabled.intended;
    target.enabled = true;
    let removal = Plan::new(Config::parse(after_enable).unwrap(), target).unwrap();
    assert!(removal.params()["value"].is_null());
    let (observation, matching) = removal
        .observation(&Config::parse(original).unwrap(), Some(true))
        .unwrap();
    assert!(matching);
    assert_eq!(observation.configured_enabled, Some(None));
    assert_eq!(observation.parent_outcome, Some(Some("absent")));
}

#[test]
fn skill_preference_remove_cancelled_review_cannot_be_confirmed() {
    let fixture = Fixture::new(false);
    let (inspection, review) = fixture.inspect();
    fixture
        .skill
        .registry
        .cancel_domain(
            &fixture.skill.agent,
            &inspection.snapshot().request_id,
            Domain::SkillPreferenceRemoval,
        )
        .unwrap();
    assert!(
        fixture
            .skill
            .registry
            .begin_confirm_domain(
                &fixture.skill.agent,
                &requests::uuid().unwrap(),
                &review.review_id,
                Domain::SkillPreferenceRemoval
            )
            .is_err()
    );
    assert_eq!(fixture.state()["writes"], 0);
}

#[test]
fn skill_preference_remove_inventory_revocation_at_actual_write_refuses_frame() {
    use inventory::process::FixedExchange;
    let fixture = Fixture::new(false);
    let (_, review) = fixture.inspect();
    let confirmation = fixture.confirm(&review);
    let mut exchange = rpc::Exchange::new(&confirmation, &fixture.skill.store).unwrap();
    for (identifier, result) in [
        (1, json!({"userAgent":"owned synthetic peer"})),
        (2, fixture.state()["config"].clone()),
        (
            3,
            json!({"data":[{"cwd":confirmation.source.cwd(),"skills":[{"name":"fixture","path":fixture.skill.target.path,"scope":"user","enabled":false,"description":"owned"}],"errors":[]}]}),
        ),
    ] {
        let mut outgoing = Vec::new();
        exchange.write_to(&mut outgoing).unwrap();
        let mut response = serde_json::to_vec(&json!({"id":identifier,"result":result})).unwrap();
        response.push(b'\n');
        exchange.received(&mut response).unwrap();
    }
    inventory::requests::shared()
        .cancel(&fixture.skill.agent, &fixture.skill.inventory)
        .unwrap();
    let mut forbidden = Vec::new();
    assert_eq!(
        exchange.write_to(&mut forbidden).err().unwrap().code,
        Code::TargetUnavailable
    );
    assert!(forbidden.is_empty());
    assert_eq!(fixture.state()["writes"], 0);
}
