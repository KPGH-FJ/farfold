//! Real admission/worker ownership with self-owned metadata, never an Agent.
use super::*;
use crate::{
    acp_client::{
        extension_inventory::{
            InventorySnapshot,
            targets::{SkillTarget, TargetSet},
        },
        manager::AcpManager,
    },
    meta_store::AgentRow,
};
use serde_json::json;
use std::{path::PathBuf, sync::mpsc};

struct Fixture {
    _serial: std::sync::MutexGuard<'static, ()>,
    _temp: tempfile::TempDir,
    root: PathBuf,
    manager: AcpManager,
    first: AgentRow,
    other: AgentRow,
    store: MetaStore,
}
impl Fixture {
    fn new() -> Self {
        let serial = tests::fixture_lock();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let make = |id: &str, name: &str| {
            let entry = root.join(name);
            // Distinct canonical entry identities. These files are never run;
            // this tests admission only, not official package provenance.
            std::fs::write(&entry, "owned admission fixture").unwrap();
            AgentRow {
                id: id.into(),
                name: "Owned admission fixture".into(),
                source: "custom".into(),
                command: entry.to_string_lossy().into(),
                args: vec![],
                env: vec![],
                version: None,
                handshake: None,
                created_at: 0,
                updated_at: 0,
            }
        };
        let first = make("codex", "first-reviewed-family-entry");
        let other = make("registry:codex-acp", "other-reviewed-family-entry");
        let store = MetaStore::open(&root.join("metadata.sqlite3")).unwrap();
        store.insert_agent(&first).unwrap();
        store.insert_agent(&other).unwrap();
        let manager = AcpManager::new(root.join("logs"), root.clone());
        Self {
            _serial: serial,
            _temp: temp,
            root,
            manager,
            first,
            other,
            store,
        }
    }
    fn other_claim(&self) -> std::result::Result<crate::acp_client::manager::AccountScope, String> {
        self.manager
            .reserve_preparation_action(&self.other, &self.other.command, &self.other.args)
    }
    fn unrelated_claim(
        &self,
    ) -> std::result::Result<crate::acp_client::manager::AccountScope, String> {
        let mut row = self.other.clone();
        row.id = "unrelated-owned-entry".into();
        self.manager
            .reserve_preparation_action(&row, &row.command, &row.args)
    }
    fn confirmation(&self, registry: &requests::Requests) -> Arc<Job> {
        let id = requests::uuid().unwrap();
        let (request, _) = inventory::requests::shared()
            .begin(
                &self.first.id,
                self.root.to_str().unwrap(),
                &id,
                &id,
                inventory::Kind::Skills,
            )
            .unwrap();
        let target = SkillTarget {
            id: 0,
            path: self.root.join("SKILL.md").to_string_lossy().into(),
            name: "owned-skill".into(),
            origin: "user".into(),
            enabled: false,
        };
        *request.targets.lock().unwrap() = Some(Arc::new(TargetSet {
            row: self.first.clone(),
            directory: Arc::new(
                inventory::launch::Directory::open(self.root.to_str().unwrap()).unwrap(),
            ),
            entries: vec![target.clone()],
        }));
        let (public, _) = serde_json::from_value::<inventory::skills_output::Wire>(json!({
            "data":[{"cwd":self.root,"skills":[{"name":target.name,"path":target.path,"scope":"user","enabled":false,"description":"owned"}],"errors":[]}],
        })).unwrap().project_private(self.root.to_str().unwrap()).unwrap();
        request.finish(Ok(InventorySnapshot::Skills(public)));
        let inspect = registry
            .begin_inspect(&self.first.id, &requests::uuid().unwrap(), &id, 0, true)
            .unwrap()
            .0;
        let before = plan::Config::parse(json!({"layers":[{
            "name":{"type":"user","file":self.root.join("config.toml")},
            "version":"owned-v1","config":{},
        }]}))
        .unwrap();
        let plan = Arc::new(domain::PreparedPlan::Skill(
            plan::Plan::new(before, target, true).unwrap(),
        ));
        *inspect.plan.lock().unwrap() = Some(plan.clone());
        let review = registry.publish_review(&inspect, plan).unwrap();
        inspect.finish(None);
        let job = registry
            .begin_confirm(
                &self.first.id,
                &requests::uuid().unwrap(),
                &review.review_id,
            )
            .unwrap()
            .0;
        // Retiring inventory after admission does not cancel this write owner.
        inventory::requests::shared()
            .cancel(&self.first.id, &id)
            .unwrap();
        inventory::requests::shared().expire_settled_for_test(&id);
        job
    }
}
fn write_blocks_other_installation(action: Action) {
    let f = Fixture::new();
    let scope = scope_for_action(&f.manager, &f.first, action).unwrap();
    let other_blocked = f.other_claim().is_err();
    assert!(f.unrelated_claim().is_ok());
    drop(scope);
    assert!(f.other_claim().is_ok());
    assert!(
        other_blocked,
        "an admitted write must protect the other known installation"
    );
}
#[test]
fn management_enablement_claim_blocks_another_known_installation() {
    write_blocks_other_installation(Action::SetEnabled);
}
#[test]
fn management_addition_claim_blocks_another_known_installation() {
    write_blocks_other_installation(Action::Add);
}
#[test]
fn management_removal_claim_blocks_another_known_installation() {
    write_blocks_other_installation(Action::Remove);
}
#[test]
fn management_inspect_and_recheck_keep_existing_read_admission() {
    let f = Fixture::new();
    for action in [Action::Inspect, Action::Recheck] {
        let scope = scope_for_action(&f.manager, &f.first, action).unwrap();
        assert!(f.other_claim().is_ok());
        assert!(f.unrelated_claim().is_ok());
        assert!(
            f.manager
                .reserve_preparation_action(&f.first, &f.first.command, &f.first.args)
                .is_err()
        );
        drop(scope);
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn management_cancelled_unknown_worker_keeps_family_claim_until_actual_finish() {
    let f = Fixture::new();
    let registry = requests::Requests::default();
    let job = f.confirmation(&registry);
    let scope = scope_for_action(&f.manager, &f.first, job.snapshot().action).unwrap();
    let admission = crate::managed_update::UpdateAdmission::default();
    let activity = admission.activity().unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, waiting) = mpsc::sync_channel(1);
    let worker = tokio::spawn(execute_with(
        f.store.clone(),
        job.clone(),
        activity,
        scope,
        move |_, job| {
            // Controlled write-boundary facts, not a real configuration mutation.
            job.update(|v| {
                v.write_dispatched = true;
                v.write_ack = Ack::Unknown;
            });
            let _ = started.send(());
            let _ = waiting.recv_timeout(Duration::from_secs(5));
            Err(Code::Cancelled.into())
        },
    ));
    tokio::time::timeout(Duration::from_secs(4), ready)
        .await
        .unwrap()
        .unwrap();
    registry
        .cancel(&f.first.id, &job.snapshot().request_id)
        .unwrap();
    let other_blocked = f.other_claim().is_err();
    let unsettled = !job.snapshot().settled;
    let app_still_protected = admission.update().is_err();
    assert!(f.unrelated_claim().is_ok());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(4), worker)
        .await
        .unwrap()
        .unwrap();
    assert!(f.other_claim().is_ok());
    assert!(admission.update().is_ok());
    let completed = job.snapshot();
    assert!(completed.settled);
    assert_eq!(completed.outcome, Some(Outcome::Unknown));
    assert_eq!(completed.write_ack, Ack::Unknown);
    assert_eq!(completed.state, State::Failed);
    job.finish(None);
    assert_eq!(
        serde_json::to_value(job.snapshot()).unwrap(),
        serde_json::to_value(completed).unwrap()
    );
    assert!(unsettled && app_still_protected);
    assert!(
        other_blocked,
        "cancellation cannot release another known installation before the worker ends"
    );
}
