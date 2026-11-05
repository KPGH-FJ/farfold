//! Actual registry/Exchange/owned process; all configuration and audit files are synthetic.
use super::{requests, rpc, types::*};
use crate::{
    acp_client::extension_inventory::{
        self as inventory, InventorySnapshot, Kind,
        launch::Directory,
        process::FixedExchange,
        targets::{SkillTarget, TargetSet},
    },
    meta_store::{AgentRow, MetaStore},
};
use serde_json::{Value, json};
use std::{io::Write, path::PathBuf, process::Command, sync::Arc};

#[derive(Clone, Copy)]
enum Boundary {
    Unchanged,
    #[cfg(unix)]
    ReplaceCwd,
    Cancel,
    RevokeInventory,
}

struct Fixture {
    _serial: std::sync::MutexGuard<'static, ()>,
    _temp: tempfile::TempDir,
    root: PathBuf,
    cwd: PathBuf,
    store: MetaStore,
    agent: String,
    inventory: String,
    kind: Kind,
    registry: requests::Requests,
}

impl Fixture {
    fn new(kind: Kind) -> Self {
        let serial = super::tests::fixture_lock();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let cwd = root.join("project");
        std::fs::create_dir(&cwd).unwrap();
        // Metadata, peer state and configuration are outside the replaceable cwd.
        let store = MetaStore::open(&root.join("owned-metadata.sqlite3")).unwrap();
        let agent = requests::uuid().unwrap();
        let row = AgentRow {
            id: agent.clone(),
            name: "Owned prewrite fixture".into(),
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
        let (request, _) = inventory::requests::shared()
            .begin(&agent, cwd.to_str().unwrap(), &inventory, &inventory, kind)
            .unwrap();
        let target = SkillTarget {
            id: 0,
            path: cwd.join("SKILL.md").to_string_lossy().into_owned(),
            name: "owned-skill".into(),
            origin: "repo".into(),
            enabled: true,
        };
        let command = root
            .join("owned-mcp-command")
            .to_string_lossy()
            .into_owned();
        let report = json!({"name":"owned-mcp","enabled":true,"disabled_reason":null,
            "auth_status":"unsupported","transport":{"type":"stdio","command":command,"args":[]}});
        match kind {
            Kind::Skills => {
                let wire = json!({"data":[{"cwd":cwd,"skills":[{"name":target.name,
                    "path":target.path,"scope":"repo","description":"Owned fixture","enabled":true}],"errors":[]}]});
                let (snapshot, entries) =
                    serde_json::from_value::<inventory::skills_output::Wire>(wire)
                        .unwrap()
                        .project_private(cwd.to_str().unwrap())
                        .unwrap();
                *request.targets.lock().unwrap() = Some(Arc::new(TargetSet {
                    row,
                    directory: Arc::new(Directory::open(cwd.to_str().unwrap()).unwrap()),
                    entries,
                }));
                request.finish(Ok(InventorySnapshot::Skills(snapshot)));
            }
            Kind::Mcp => {
                let (snapshot, entries) = inventory::output::parse_private(
                    &serde_json::to_vec(&json!([report])).unwrap(),
                )
                .unwrap();
                *request.mcp_targets.lock().unwrap() =
                    Some(Arc::new(inventory::mcp_targets::TargetSet {
                        row,
                        directory: Arc::new(Directory::open(cwd.to_str().unwrap()).unwrap()),
                        entries,
                        names: std::collections::HashSet::from(["owned-mcp".to_owned()]),
                    }));
                request.finish(Ok(InventorySnapshot::Mcp(snapshot)));
            }
        }
        let config = json!({"layers":[{"name":{"type":"user","file":root.join("owned-config.json"),"profile":null},
            "version":"v1","disabledReason":null,"config":{"unrelated":{"future":["owned",1,true]},
            "skills":{"config":[]},"mcp_servers":{"owned-mcp":{"command":command,"args":[],"enabled":true}}}}]});
        std::fs::write(root.join("state.json"), serde_json::to_vec(&json!({
            "config":config,"report":report,"target":target.path,"skillEnabled":true,"writes":0,"methods":[]
        })).unwrap()).unwrap();
        Self {
            _serial: serial,
            _temp: temp,
            root,
            cwd,
            store,
            agent,
            inventory,
            kind,
            registry: Default::default(),
        }
    }

    fn state(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.root.join("state.json")).unwrap()).unwrap()
    }

    fn label(&self) -> &'static str {
        match self.kind {
            Kind::Skills => "skills",
            Kind::Mcp => "mcp",
        }
    }

    fn confirm(&self) -> Arc<requests::Job> {
        let inspect = self
            .registry
            .begin_inspect_kind(
                &self.agent,
                &requests::uuid().unwrap(),
                &self.inventory,
                0,
                false,
                self.kind,
            )
            .unwrap()
            .0;
        let (code, _) = self.run(&inspect, Boundary::Unchanged);
        assert_eq!(code, None);
        let review = inspect.snapshot().review.unwrap();
        self.registry
            .begin_confirm_kind(
                &self.agent,
                &requests::uuid().unwrap(),
                &review.review_id,
                self.kind,
            )
            .unwrap()
            .0
    }

    fn run(&self, job: &requests::Job, boundary: Boundary) -> (Option<Code>, bool) {
        if self.kind == Kind::Mcp {
            let report = inventory::mcp_targets::report(
                &serde_json::to_vec(&self.state()["report"]).unwrap(),
                job.source.mcp().unwrap(),
            )
            .unwrap();
            *job.mcp_report.lock().unwrap() = Some(report);
        }
        let mut command = Command::new(crate::platform_tests::python());
        command
            .args(["-u", "-c", PEER])
            .arg(&self.root)
            .arg(&self.cwd)
            .arg(self.label())
            .current_dir(&self.cwd);
        let mut exchange = BoundaryExchange {
            inner: rpc::Exchange::new(job, &self.store).unwrap(),
            fixture: self,
            job,
            boundary,
            fired: false,
        };
        let result = job
            .within()
            .and_then(|()| {
                job.source
                    .current(&self.store, job.snapshot().action == Action::Inspect)
            })
            .and_then(|()| {
                inventory::process::run_owned(command, job, Some(&mut exchange), 4194304)
            })
            .and_then(|bytes| exchange.inner.finish(&bytes))
            // The production query also detects a changed source after process completion;
            // that later error cannot undo a configuration frame already handled by the peer.
            .and_then(|()| {
                job.source
                    .current(&self.store, job.snapshot().action == Action::Inspect)
            })
            .and_then(|()| {
                if job.snapshot().action == Action::Inspect {
                    self.registry
                        .publish_review(job, job.plan.lock().unwrap().clone().unwrap())?;
                } else if self.kind == Kind::Mcp {
                    let (after, directory) = job.mcp_readback.lock().unwrap().take().unwrap();
                    let report = inventory::mcp_targets::report(
                        &serde_json::to_vec(&self.state()["report"]).unwrap(),
                        job.source.mcp()?,
                    )?;
                    rpc::observe_mcp(job, &after, &directory, &report, true)?;
                }
                Ok(())
            });
        let code = result.as_ref().err().map(|error| error.code);
        job.finish(result.err());
        (code, exchange.fired)
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

struct BoundaryExchange<'a> {
    inner: rpc::Exchange<'a>,
    fixture: &'a Fixture,
    job: &'a requests::Job,
    boundary: Boundary,
    fired: bool,
}
impl FixedExchange for BoundaryExchange<'_> {
    fn write(&mut self, writer: &mut dyn Write) -> Result<()> {
        self.inner.write(writer)
    }
    fn received(&mut self, bytes: &mut Vec<u8>) -> Result<()> {
        self.inner.received(bytes)?;
        if !self.fired
            && self.job.snapshot().action == Action::SetEnabled
            && self.job.snapshot().phase == Phase::Writing
        {
            self.fired = true;
            assert!(self.job.source.current(&self.fixture.store, false).is_ok());
            assert!(self.job.operation.interested());
            match self.boundary {
                Boundary::Unchanged => {}
                #[cfg(unix)]
                Boundary::ReplaceCwd => {
                    std::fs::rename(&self.fixture.cwd, self.fixture.root.join("retired-project"))
                        .unwrap();
                    std::fs::create_dir(&self.fixture.cwd).unwrap();
                    assert!(matches!(
                        self.job.source.current(&self.fixture.store, false),
                        Err(Failure {
                            code: Code::CwdUnavailable
                        })
                    ));
                    assert!(self.job.operation.interested());
                }
                Boundary::Cancel => self.job.operation.abandon(),
                Boundary::RevokeInventory => {
                    inventory::requests::shared()
                        .cancel(&self.fixture.agent, &self.fixture.inventory)
                        .unwrap();
                    assert!(!self.job.source.available());
                    assert!(self.job.source.current(&self.fixture.store, false).is_ok());
                    assert!(self.job.operation.interested());
                }
            }
            eprintln!(
                "PREWRITE_BOUNDARY kind={} source_current={} interested={}",
                self.fixture.label(),
                self.job.source.current(&self.fixture.store, false).is_ok(),
                self.job.operation.interested()
            );
        }
        Ok(())
    }
    fn done(&self) -> bool {
        self.inner.done()
    }
}

#[cfg(unix)]
fn replaced_cwd(kind: Kind) {
    let fixture = Fixture::new(kind);
    let job = fixture.confirm();
    let original = fixture.state()["config"].clone();
    let (code, fired) = fixture.run(&job, Boundary::ReplaceCwd);
    assert!(
        fired,
        "real exchange must reach the prepared-write boundary"
    );
    assert_eq!(
        fixture.state()["writes"],
        0,
        "an already invalid source must not reach the real configuration handler"
    );
    assert_eq!(fixture.state()["config"], original);
    assert_eq!(code, Some(Code::CwdUnavailable));
}
#[cfg(unix)]
#[test]
fn skill_enablement_replaced_cwd_before_first_write_never_reaches_peer() {
    replaced_cwd(Kind::Skills);
}
#[cfg(unix)]
#[test]
fn mcp_enablement_replaced_cwd_before_first_write_never_reaches_peer() {
    replaced_cwd(Kind::Mcp);
}

#[test]
fn unchanged_enablement_owner_reaches_real_handler_once() {
    for kind in [Kind::Skills, Kind::Mcp] {
        let fixture = Fixture::new(kind);
        let job = fixture.confirm();
        let (code, fired) = fixture.run(&job, Boundary::Unchanged);
        assert!(fired);
        assert_eq!(code, None);
        assert_eq!(fixture.state()["writes"], 1);
        assert_eq!(job.snapshot().outcome, Some(Outcome::Verified));
    }
}

#[test]
fn cancelled_enablement_before_first_write_never_reaches_real_handler() {
    for kind in [Kind::Skills, Kind::Mcp] {
        let fixture = Fixture::new(kind);
        let job = fixture.confirm();
        let original = fixture.state()["config"].clone();
        let (code, fired) = fixture.run(&job, Boundary::Cancel);
        assert!(fired);
        assert_eq!(code, Some(Code::Cancelled));
        assert_eq!(fixture.state()["writes"], 0);
        assert_eq!(fixture.state()["config"], original);
    }
}

#[test]
fn admitted_enablement_inventory_revocation_keeps_original_confirmation() {
    for kind in [Kind::Skills, Kind::Mcp] {
        let fixture = Fixture::new(kind);
        let job = fixture.confirm();
        let (code, fired) = fixture.run(&job, Boundary::RevokeInventory);
        assert!(fired);
        assert_eq!(code, None);
        assert_eq!(fixture.state()["writes"], 1);
        assert_eq!(job.snapshot().outcome, Some(Outcome::Verified));
    }
}

const PEER: &str = r#"
import json, pathlib, sys
root, cwd, kind = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
path = root / 'state.json'
state = json.loads(path.read_text())
def save(): path.write_text(json.dumps(state))
for line in sys.stdin:
    q = json.loads(line)
    method = q['method']
    state['methods'].append(method)
    save()
    if method == 'initialized': continue
    if method == 'initialize': result = {'userAgent':'owned-prewrite-peer'}
    elif method == 'config/read':
        assert q['params'] == {'includeLayers':True,'cwd':cwd if kind == 'mcp' and q['id'] in [3,6] else None}
        result = state['config']
    elif method == 'skills/list':
        assert kind == 'skills' and q['params'] == {'cwds':[cwd],'forceReload':True}
        result = {'data':[{'cwd':cwd,'skills':[{'name':'owned-skill','path':state['target'],'description':'Owned fixture','scope':'repo','enabled':state['skillEnabled']}],'errors':[]}]}
    elif method == 'config/value/write':
        p = q['params']; layer = state['config']['layers'][0]
        assert p['filePath'] == layer['name']['file'] and p['expectedVersion'] == 'v1' and p['mergeStrategy'] == 'replace'
        if kind == 'skills':
            assert p['keyPath'] == 'skills.config' and p['value'] == [{'path':state['target'],'enabled':False}]
            layer['config']['skills']['config'] = p['value']; state['skillEnabled'] = False
        else:
            assert p['keyPath'] == 'mcp_servers."owned-mcp".enabled' and p['value'] is False
            layer['config']['mcp_servers']['owned-mcp']['enabled'] = False; state['report']['enabled'] = False
        state['writes'] += 1
        layer['version'] = 'v2'
        save()
        result = {'filePath':p['filePath'],'version':'v2','status':'ok'}
    else: raise AssertionError('unexpected owned peer method')
    print(json.dumps({'id':q['id'],'result':result}), flush=True)
"#;
