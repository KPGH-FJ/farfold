//! Synthetic peers/config only: no installed Agent, credentials or user settings.
use super::*;
use inventory::{
    InventorySnapshot,
    targets::{SkillTarget, TargetSet},
};
use serde_json::{Value, json};
use std::process::Command;
pub(super) fn fixture_lock() -> std::sync::MutexGuard<'static, ()> {
    inventory::execution::fixture_lock()
}
pub(super) struct Fixture {
    _serial: std::sync::MutexGuard<'static, ()>,
    _root: tempfile::TempDir,
    pub store: MetaStore,
    pub agent: String,
    pub inventory: String,
    pub target: SkillTarget,
    pub registry: requests::Requests,
}
pub(super) fn config() -> Value {
    json!({"layers":[{"name":{"type":"user","file":"/controlled/config.toml","profile":null},"version":"v1","config":{"model":"keep","skills":{"config":[{"name":"other","enabled":false,"unknown":{"keep":[1,"two",true]}}]}},"disabledReason":null}]})
}
impl Fixture {
    pub fn new() -> Self {
        let serial = fixture_lock();
        let root = tempfile::tempdir().unwrap();
        let cwd = root
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let store = MetaStore::open(&root.path().join("test.db")).unwrap();
        let agent = requests::uuid().unwrap();
        let row = crate::meta_store::AgentRow {
            id: agent.clone(),
            name: "Synthetic".into(),
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
        let inventory = requests::uuid().unwrap();
        let (original, _) = inventory::requests::shared()
            .begin(
                &agent,
                &cwd,
                &inventory,
                &inventory,
                inventory::Kind::Skills,
            )
            .unwrap();
        let target = SkillTarget {
            id: 0,
            path: format!("{cwd}/SKILL.md"),
            name: "fixture".into(),
            origin: "user".into(),
            enabled: false,
        };
        let raw = json!({"data":[{"cwd":cwd,"skills":[{"name":target.name,"path":target.path,"scope":"user","enabled":false,"description":"Fixture"}],"errors":[]}]});
        let wire: inventory::skills_output::Wire = serde_json::from_value(raw).unwrap();
        let (public, entries) = wire.project_private(&cwd).unwrap();
        *original.targets.lock().unwrap() = Some(Arc::new(TargetSet {
            row,
            directory: Arc::new(inventory::launch::Directory::open(&cwd).unwrap()),
            entries,
        }));
        original.finish(Ok(InventorySnapshot::Skills(public)));
        Self {
            _serial: serial,
            _root: root,
            store,
            agent,
            inventory,
            target,
            registry: Default::default(),
        }
    }
    pub fn job(&self) -> Arc<Job> {
        self.registry
            .begin_inspect(
                &self.agent,
                &requests::uuid().unwrap(),
                &self.inventory,
                0,
                true,
            )
            .unwrap()
            .0
    }
    pub fn run(&self, job: &Job, mode: &str) -> Result<()> {
        let mut cmd = Command::new(crate::platform_tests::python());
        cmd.args([
            "-u",
            "-c",
            PEER,
            job.source.cwd(),
            &self.target.path,
            mode,
            &config().to_string(),
        ]);
        let mut rpc = rpc::Exchange::new(job, &self.store)?;
        let out = inventory::process::run_owned(cmd, job, Some(&mut rpc), 4194304)?;
        rpc.finish(&out)
    }
    pub fn inspect(&self) -> (Arc<Job>, Review) {
        let job = self.job();
        self.run(&job, "normal").unwrap();
        let plan = job.plan.lock().unwrap().clone().unwrap();
        let review = self.registry.publish_review(&job, plan).unwrap();
        job.finish(None);
        (job, review)
    }
    pub fn confirm(&self, review: &Review) -> Arc<Job> {
        self.registry
            .begin_confirm(&self.agent, &requests::uuid().unwrap(), &review.review_id)
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
const PEER: &str = r#"
import sys,json
cwd,path,mode=sys.argv[1:4]; config=json.loads(sys.argv[4]); wrote=False
if mode=='changed': config['layers'][0]['config']['model']='external-change'
if mode=='observed':
 wrote=True;config['layers'][0]['config']['skills']['config'].append({'path':path,'enabled':True});config['layers'][0]['version']='v2'
for line in sys.stdin:
 q=json.loads(line); method=q['method']
 if method=='initialized': continue
 if method=='initialize': result={'userAgent':'synthetic'}
 elif method=='config/read':
  assert q['params']=={'includeLayers':True,'cwd':None}
  result=config
 elif method=='skills/list':
  assert q['params']=={'cwds':[cwd],'forceReload':True}
  skills=[] if mode=='missing' else [{'name':'fixture','path':path,'description':'test','scope':'user','enabled':wrote}]
  result={'data':[{'cwd':cwd,'skills':skills,'errors':[]}]}
 elif method=='config/value/write':
  p=q['params']; assert p['keyPath']=='skills.config' and p['mergeStrategy']=='replace' and p['expectedVersion']=='v1' and p['filePath']=='/controlled/config.toml'
  assert p['value'][0]==config['layers'][0]['config']['skills']['config'][0]
  assert p['value'][-1]=={'path':path,'enabled':True}
  if mode=='reject':
   print(json.dumps({'id':q['id'],'error':{'code':-32600,'message':'synthetic','data':{'config_write_error_code':'configVersionConflict'}}}),flush=True);continue
  wrote=True;config['layers'][0]['config']['skills']['config']=p['value'];config['layers'][0]['version']='v2'
  if mode=='lost': break
  if mode=='postwriteError':
   print(json.dumps({'id':q['id'],'error':{'code':-32600,'message':'synthetic','data':{'config_write_error_code':'userLayerNotFound'}}}),flush=True);continue
  result={'status':'ok','version':'v2','filePath':p['filePath'],'overriddenMetadata':None}
 else: raise AssertionError('unapproved method')
 print(json.dumps({'id':q['id'],'result':result}),flush=True)
"#;
#[test]
fn complete_array_and_unknown_fields_preserved_with_profile_target() {
    let f = Fixture::new();
    let mut raw = config();
    raw["layers"][0]["name"]["profile"] = json!("chosen");
    let p = plan::Plan::new(plan::Config::parse(raw).unwrap(), f.target.clone(), true).unwrap();
    assert_eq!(p.before.scope().unwrap().kind, "profile");
    assert_eq!(
        p.array[0],
        config()["layers"][0]["config"]["skills"]["config"][0]
    );
    assert_eq!(p.array.as_array().unwrap().len(), 2);
}
#[test]
fn unsupported_null_is_refused_instead_of_dropping_unknown_value() {
    let f = Fixture::new();
    let mut raw = config();
    raw["layers"][0]["config"]["skills"]["config"][0]["future"] = Value::Null;
    assert!(matches!(
        plan::Plan::new(plan::Config::parse(raw).unwrap(), f.target.clone(), true),
        Err(Failure {
            code: Code::ConfigurationUnsupported
        })
    ));
}
#[test]
fn ready_inventory_cancel_retires_targets_without_erasing_snapshot() {
    let f = Fixture::new();
    assert!(inventory::targets::get(&f.agent, &f.inventory, 0).is_ok());
    let reply = inventory::requests::shared()
        .cancel(&f.agent, &f.inventory)
        .unwrap();
    assert_eq!(reply.operation.unwrap().state, State::Ready);
    assert!(inventory::targets::get(&f.agent, &f.inventory, 0).is_err());
}
#[test]
fn review_is_consumed_once_and_cancelled_inspect_cannot_confirm() {
    let f = Fixture::new();
    let (inspect, review) = f.inspect();
    f.registry
        .cancel(&f.agent, &inspect.snapshot().request_id)
        .unwrap();
    assert!(
        f.registry
            .begin_confirm(&f.agent, &requests::uuid().unwrap(), &review.review_id)
            .is_err()
    );
    let (_, review) = f.inspect();
    let first = f.confirm(&review);
    assert!(
        !f.registry
            .begin_confirm(&f.agent, &first.snapshot().request_id, &review.review_id)
            .unwrap()
            .1
    );
    assert!(matches!(
        f.registry
            .begin_confirm(&f.agent, &requests::uuid().unwrap(), &review.review_id),
        Err(Failure {
            code: Code::ReviewConsumed
        })
    ));
    first.finish(Some(Code::Cancelled.into()));
}
#[test]
fn acknowledged_refusal_survives_cleanup_failure() {
    let f = Fixture::new();
    let (_, review) = f.inspect();
    let job = f.confirm(&review);
    f.run(&job, "reject").unwrap();
    job.finish(Some(Code::TimedOut.into()));
    let v = job.snapshot();
    assert_eq!(v.write_ack, Ack::Rejected);
    assert_eq!(v.outcome, Some(Outcome::Rejected));
    assert!(v.write_dispatched);
}
#[test]
fn final_outcome_is_not_published_before_worker_finishes() {
    let f = Fixture::new();
    let (_, review) = f.inspect();
    let job = f.confirm(&review);
    f.run(&job, "normal").unwrap();
    let pending = job.snapshot();
    assert!(!pending.settled);
    assert!(pending.observation.is_some());
    assert_eq!(pending.outcome, None);
    job.finish(None);
    assert_eq!(job.snapshot().outcome, Some(Outcome::Verified));
}
#[test]
fn missing_target_recheck_is_an_observation_not_a_repeated_write() {
    let f = Fixture::new();
    let (_, review) = f.inspect();
    let job = f.confirm(&review);
    f.run(&job, "normal").unwrap();
    job.finish(None);
    let check = f
        .registry
        .begin_recheck(
            &f.agent,
            &requests::uuid().unwrap(),
            &job.snapshot().request_id,
        )
        .unwrap()
        .0;
    f.run(&check, "missing").unwrap();
    check.finish(None);
    assert_eq!(check.snapshot().observation.unwrap().skill, Some("missing"));
    assert_eq!(check.snapshot().outcome, Some(Outcome::Mismatch));
}
#[test]
fn postwrite_error_and_lost_reply_remain_unknown_without_retry() {
    for mode in ["postwriteError", "lost"] {
        let f = Fixture::new();
        let (_, review) = f.inspect();
        let job = f.confirm(&review);
        let result = f.run(&job, mode);
        assert!(result.is_err());
        job.finish(result.err());
        let v = job.snapshot();
        assert!(v.write_dispatched);
        assert_eq!(v.outcome, Some(Outcome::Unknown));
        assert_ne!(v.state, State::Cancelled);
    }
}

#[test]
fn recheck_after_explicit_refusal_reports_current_observation_without_changing_ack() {
    let f = Fixture::new();
    let (_, review) = f.inspect();
    let job = f.confirm(&review);
    f.run(&job, "reject").unwrap();
    job.finish(None);
    let check = f
        .registry
        .begin_recheck(
            &f.agent,
            &requests::uuid().unwrap(),
            &job.snapshot().request_id,
        )
        .unwrap()
        .0;
    f.run(&check, "observed").unwrap();
    check.finish(None);
    assert_eq!(check.snapshot().write_ack, Ack::Rejected);
    assert_eq!(check.snapshot().outcome, Some(Outcome::Observed));
}

#[test]
fn actual_management_wire_from_synthetic_official_exchange() {
    use inventory::process::Control;
    let f = Fixture::new();
    let row = f.store.get_agent(&f.agent).unwrap().unwrap();
    let capability = inventory::launch::capabilities(&row).unwrap();
    let inventory = inventory::requests::shared()
        .get(&f.agent, &f.inventory)
        .unwrap()
        .snapshot()
        .unwrap();
    let mut operations = Vec::new();
    let inspect = f.job();
    operations.push(json!({"label":"inspectRunning","value":inspect.snapshot()}));
    f.run(&inspect, "normal").unwrap();
    let plan = inspect.plan.lock().unwrap().clone().unwrap();
    let review = f.registry.publish_review(&inspect, plan).unwrap();
    inspect.finish(None);
    operations.push(json!({"label":"inspectReady","value":inspect.snapshot()}));
    let job = f.confirm(&review);
    operations.push(json!({"label":"confirmQueued","value":job.snapshot()}));
    f.run(&job, "normal").unwrap();
    operations.push(json!({"label":"confirmObservedAwaitingCleanup","value":job.snapshot()}));
    job.pending_cleanup();
    operations.push(json!({"label":"confirmPendingCleanup","value":job.snapshot()}));
    job.finish(None);
    operations.push(json!({"label":"confirmVerified","value":job.snapshot()}));
    let check = f
        .registry
        .begin_recheck(
            &f.agent,
            &requests::uuid().unwrap(),
            &job.snapshot().request_id,
        )
        .unwrap()
        .0;
    f.run(&check, "observed").unwrap();
    check.finish(None);
    operations.push(json!({"label":"readonlyObserved","value":check.snapshot()}));
    let missing = f
        .registry
        .begin_recheck(
            &f.agent,
            &requests::uuid().unwrap(),
            &job.snapshot().request_id,
        )
        .unwrap()
        .0;
    f.run(&missing, "missing").unwrap();
    missing.finish(None);
    operations.push(json!({"label":"readonlyMissing","value":missing.snapshot()}));
    for (mode, label) in [("reject", "confirmRejected"), ("lost", "confirmUnknown")] {
        let (inspection, review) = f.inspect();
        operations
            .push(json!({"label":format!("{label}Inspection"),"value":inspection.snapshot()}));
        let next = f.confirm(&review);
        let error = f.run(&next, mode).err();
        operations.push(json!({"label":format!("{label}BeforeCleanup"),"value":next.snapshot()}));
        next.finish(error);
        operations.push(json!({"label":label,"value":next.snapshot()}));
        if mode == "lost" {
            let observed = f
                .registry
                .begin_recheck(
                    &f.agent,
                    &requests::uuid().unwrap(),
                    &next.snapshot().request_id,
                )
                .unwrap()
                .0;
            f.run(&observed, "observed").unwrap();
            observed.finish(None);
            operations.push(json!({"label":"unknownReadonlyObserved","value":observed.snapshot()}));
        }
    }
    let cancelled = f.job();
    let cancellation = f
        .registry
        .cancel(&f.agent, &cancelled.snapshot().request_id)
        .unwrap();
    cancelled.finish(Some(Code::Cancelled.into()));
    operations.push(json!({"label":"inspectCancelled","value":cancelled.snapshot()}));
    let unknown_cancel = f
        .registry
        .cancel(&f.agent, &requests::uuid().unwrap())
        .unwrap();
    println!(
        "SKILL_MANAGEMENT_WIRE:{}",
        json!({"capabilities":capability,"inventory":inventory,"operations":operations,"cancellations":[cancellation,unknown_cancel]})
    );
}

#[test]
fn inspect_cancel_between_publication_and_finish_never_revives_ready() {
    let f = Fixture::new();
    let job = f.job();
    f.run(&job, "normal").unwrap();
    let plan = job.plan.lock().unwrap().clone().unwrap();
    let review = f.registry.publish_review(&job, plan).unwrap();
    let cancelled = f
        .registry
        .cancel(&f.agent, &job.snapshot().request_id)
        .unwrap();
    assert!(cancelled.operation.unwrap().review.is_none());
    job.update(|v| v.review = Some(review.clone()));
    job.finish(None);
    let state = job.snapshot();
    assert_eq!(state.state, State::Cancelled);
    assert!(state.review.is_none());
    assert!(
        f.registry
            .begin_confirm(&f.agent, &requests::uuid().unwrap(), &review.review_id)
            .is_err()
    );
}

#[test]
fn changed_config_or_selection_is_refused_before_the_write_frame() {
    for change in ["configuration", "selection"] {
        let f = Fixture::new();
        let (_, review) = f.inspect();
        let job = f.confirm(&review);
        let mode = if change == "configuration" {
            "changed"
        } else {
            f.store
                .set_agent_env(&f.agent, &[("SYNTHETIC_ONLY".into(), "changed".into())])
                .unwrap();
            "normal"
        };
        let error = f.run(&job, mode).unwrap_err();
        assert_eq!(
            error.code,
            if change == "configuration" {
                Code::ConfigurationChanged
            } else {
                Code::SelectionChanged
            }
        );
        job.finish(Some(error));
        let value = job.snapshot();
        assert!(!value.write_dispatched);
        assert_eq!(value.write_ack, Ack::None);
        assert_eq!(value.outcome, Some(Outcome::NotDispatched));
    }
}

#[test]
fn inspection_review_is_only_public_with_the_settled_ready_state() {
    let f = Fixture::new();
    let job = f.job();
    f.run(&job, "normal").unwrap();
    let plan = job.plan.lock().unwrap().clone().unwrap();
    let review = f.registry.publish_review(&job, plan).unwrap();
    let pending = job.snapshot();
    assert!(!pending.settled);
    assert!(pending.review.is_none());
    job.finish(None);
    let ready = job.snapshot();
    assert_eq!(ready.state, State::Ready);
    assert_eq!(ready.review.unwrap().review_id, review.review_id);
}

#[test]
fn settled_inspection_cannot_be_reopened_by_a_late_cleanup_observation() {
    use inventory::process::Control;
    let f = Fixture::new();
    let (job, _) = f.inspect();
    let original = serde_json::to_value(job.snapshot()).unwrap();
    job.pending_cleanup();
    assert_eq!(serde_json::to_value(job.snapshot()).unwrap(), original);
    job.finish(Some(Code::Unavailable.into()));
    assert_eq!(serde_json::to_value(job.snapshot()).unwrap(), original);
}
