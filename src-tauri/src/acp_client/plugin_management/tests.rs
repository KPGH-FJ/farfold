//! Full fixed CLI flows against owned synthetic peers. No installed Agent runs.
use super::*;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;

const PEER: &str = r#"
import json, os, sys, pathlib, time
root=pathlib.Path(os.environ['P40_TEST_ROOT'])
args=sys.argv[2:]
with (root/'calls').open('a') as f: f.write(json.dumps(args)+'\n')
assert args[:2]==['cli','plugin'], args
action=args[2]
mode=(root/'mode').read_text()
if mode=='unsupported': sys.exit(2)
installed=(root/'state').read_text()=='true'
entry={'pluginId':'sample@local-market','name':'sample','marketplaceName':'local-market','version':'1.0.0',
 'installed':installed,'enabled':installed,'source':{'source':'local','path':'/PRIVATE_SOURCE'},
 'marketplaceSource':{'sourceType':'local','source':'/PRIVATE_MARKET'},'installPolicy':'AVAILABLE','authPolicy':'ON_USE'}
if mode=='not-available-policy': entry['installPolicy']='NOT_AVAILABLE'
if mode=='source-none': entry['marketplaceSource']=None
if mode=='source-unknown': entry['marketplaceSource']={'sourceType':'future','source':'/PRIVATE_FUTURE','extra':{'v':1}}
if mode=='source-remote': entry['marketplaceSource']={'sourceType':'remote','source':'PRIVATE_REMOTE'}
if action=='marketplace':
 assert args[3:]==['list','--json'], args
 if mode=='slow-sources': (root/'source-started').write_text('yes');time.sleep(10)
 row={'name':'local-market','root':'/PRIVATE_MARKET','marketplaceSource':entry['marketplaceSource']}
 if mode=='root-change' or mode=='root-after-list' and int((root/'reads').read_text())>0: row['root']='/PRIVATE_REPLACED'
 if mode=='provenance-change': row['marketplaceSource']={'sourceType':'local','source':'/PRIVATE_MARKET','future':2}
 if mode=='name-change': row['name']='replaced-market'
 if mode=='global-source': row['name']='openai-curated-remote'
 if mode=='unsafe-source': row['name']='bad=name'
 if mode=='bad-root': row['root']='relative'
 rows=[row]
 if mode=='source-disappear': rows=[]
 if mode=='duplicate-source': rows.append({**row,'root':'/PRIVATE_OTHER'})
 if mode=='sources-stderr': sys.stderr.write('x'*65537)
 print(json.dumps({'marketplaces':rows}))
 sys.exit(0)
if action=='list':
 assert '--available' in args and '--json' in args
 n=int((root/'reads').read_text())+1; (root/'reads').write_text(str(n))
 if mode=='scoped-only' and '--marketplace=local-market' not in args:
  rows=[]
  for i in range(513):
   row=entry.copy();row.update(pluginId=f'remote{i}@openai-curated-remote',name=f'remote{i}',marketplaceName='openai-curated-remote',source={'source':'remote','id':f'remote{i}'},marketplaceSource=None);rows.append(row)
  print(json.dumps({'installed':[],'available':rows}));sys.exit(0)
 if mode=='drift' and n>=3: entry['source']['path']='/PRIVATE_REPLACED'
 if mode=='wrong-market': entry['marketplaceName']='other'
 if mode=='entry-provenance-change': entry['marketplaceSource']={'sourceType':'git','source':'PRIVATE_OTHER'}
 if mode=='post-version' and (root/'written').exists(): entry['version']='2.0.0'
 if mode=='empty-after-write' and (root/'written').exists(): print('{"installed":[],"available":[]}')
 else: print(json.dumps({'installed':[entry] if installed else [],'available':[] if installed else [entry]}))
else:
 assert action in ['add','remove'] and args[3:]==['--json','--','sample@local-market'], args
 (root/'started').write_text('yes')
 if mode=='slow-write': time.sleep(10)
 (root/'state').write_text('true' if action=='add' else 'false'); (root/'written').write_text('yes')
 if mode=='write-exit': sys.exit(7)
 if mode=='bad-ack': print('not json'); sys.exit(0)
 result={'pluginId':'sample@local-market','name':'sample','marketplaceName':'local-market'}
 if action=='add': result.update(version='1.0.0',installedPath='/PRIVATE_CACHE/sample',authPolicy='ON_USE')
 print(json.dumps(result))
"#;
struct Fixture {
    _serial: std::sync::MutexGuard<'static, ()>,
    root: tempfile::TempDir,
    store: MetaStore,
    row: crate::meta_store::AgentRow,
    registry: requests::Requests,
    selection: String,
    cwd: String,
}
impl Fixture {
    fn new(installed: bool) -> Self {
        let serial = inventory::execution::fixture_lock();
        let _ = crate::shell_env::command_env();
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let package = base.join("node_modules/@agentclientprotocol/codex-acp");
        let entry = package.join("dist/index.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "// synthetic public package").unwrap();
        std::fs::write(package.join("package.json"),r#"{"name":"@agentclientprotocol/codex-acp","version":"not-a-version-gate","bin":{"codex-acp":"dist/index.js"}}"#).unwrap();
        let command = base.join("node");
        std::fs::write(
            &command,
            format!("#!{}\n{}", crate::platform_tests::python(), PEER),
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();
        for (name, value) in [
            ("state", if installed { "true" } else { "false" }),
            ("mode", "normal"),
            ("reads", "0"),
        ] {
            std::fs::write(base.join(name), value).unwrap();
        }
        let row = crate::meta_store::AgentRow {
            id: "codex".into(),
            name: "Synthetic".into(),
            source: "registry".into(),
            command: command.to_string_lossy().into(),
            args: vec![entry.to_string_lossy().into()],
            env: vec![("P40_TEST_ROOT".into(), base.to_string_lossy().into())],
            version: None,
            handshake: None,
            created_at: 1,
            updated_at: 1,
        };
        let store = MetaStore::open(&base.join("test.db")).unwrap();
        store.insert_agent(&row).unwrap();
        let selection = inventory::launch::selections()
            .issue(row.clone(), Instant::now())
            .unwrap();
        Self {
            _serial: serial,
            root,
            store,
            row,
            registry: Default::default(),
            selection,
            cwd: base.to_string_lossy().into(),
        }
    }
    fn id() -> String {
        requests::review_id().unwrap()
    }
    fn mode(&self, value: &str) {
        std::fs::write(self.root.path().join("mode"), value).unwrap();
    }
    fn run(&self, job: &Job) -> Result<()> {
        let result = query(&self.store, job);
        job.finish(result.err());
        result
    }
    fn inventory(&self) -> Arc<Job> {
        let sources = self.initial_query();
        self.run(&sources).unwrap();
        let (job, _) = self
            .registry
            .inventory(&self.row.id, &Self::id(), &sources.snapshot().request_id, 0)
            .unwrap();
        self.run(&job).unwrap();
        job
    }
    fn initial_query(&self) -> Arc<Job> {
        self.registry
            .sources(&self.row.id, &Self::id(), &self.selection, &self.cwd)
            .unwrap()
            .0
    }
    fn inspect(&self, inventory: &Job, install: bool) -> Arc<Job> {
        let (job, _) = self
            .registry
            .inspect(
                &self.row.id,
                &Self::id(),
                &inventory.snapshot().request_id,
                0,
                install,
            )
            .unwrap();
        self.run(&job).unwrap();
        job
    }
    fn confirm(&self, inspect: &Job) -> Arc<Job> {
        self.registry
            .confirm(
                &self.row.id,
                &Self::id(),
                &inspect.snapshot().review.unwrap().review_id,
            )
            .unwrap()
            .0
    }
    fn calls(&self) -> Vec<Vec<String>> {
        std::fs::read_to_string(self.root.path().join("calls"))
            .unwrap_or_default()
            .lines()
            .map(|v| serde_json::from_str(v).unwrap())
            .collect()
    }
}
fn entry(installed: bool) -> Value {
    json!({"pluginId":"sample@local-market","name":"sample","marketplaceName":"local-market","version":"1.0.0","installed":installed,"enabled":installed,"source":{"source":"local","path":"/PRIVATE_SOURCE"},"marketplaceSource":{"sourceType":"local","source":"/PRIVATE_MARKET"},"installPolicy":"AVAILABLE","authPolicy":"ON_USE"})
}
fn wire(v: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"installed":if v["installed"]==true {vec![v.clone()]}else{vec![]},"available":if v["installed"]==false {vec![v]}else{vec![]}})).unwrap()
}

#[test]
fn p40_cli_full_install_and_remove_require_exact_scoped_readback() {
    for install in [true, false] {
        let f = Fixture::new(!install);
        let inventory = f.inventory();
        let inspect = f.inspect(&inventory, install);
        let job = f.confirm(&inspect);
        f.run(&job).unwrap();
        let result = job.snapshot();
        assert_eq!(result.outcome, Some(Outcome::Verified));
        assert_eq!(result.write_ack, Ack::Ok);
        assert!(result.write_dispatched);
        assert_eq!(
            result.observation.as_ref().unwrap().reported_installed,
            install
        );
        let calls = f.calls();
        assert_eq!(calls.len(), 14);
        assert!(
            calls
                .iter()
                .filter(|v| v[2] == "list")
                .all(|v| v.contains(&"--marketplace=local-market".into()))
        );
        assert_eq!(
            &calls[10][2..],
            [
                if install { "add" } else { "remove" },
                "--json",
                "--",
                "sample@local-market"
            ]
        );
        assert!(calls[12].contains(&"--marketplace=local-market".into()));
        let public = serde_json::to_string(&result).unwrap();
        assert!(!public.contains("PRIVATE"));
        assert!(!public.contains("SOURCE"));
        assert!(!inventory.snapshot().catalog.unwrap().complete);
    }
}
#[test]
fn p40_cli_empty_postwrite_is_unknown_even_after_successful_ack() {
    for install in [true, false] {
        let f = Fixture::new(!install);
        let inventory = f.inventory();
        let inspect = f.inspect(&inventory, install);
        let job = f.confirm(&inspect);
        f.mode("empty-after-write");
        assert_eq!(f.run(&job).unwrap_err().code, Code::InventoryIncomplete);
        let result = job.snapshot();
        assert_eq!(result.write_ack, Ack::Ok);
        assert_eq!(result.outcome, Some(Outcome::Unknown));
        assert!(result.observation.is_none());
    }
}
#[test]
fn p40_cli_source_drift_before_dispatch_preserves_the_package() {
    let f = Fixture::new(false);
    let inventory = f.inventory();
    let inspect = f.inspect(&inventory, true);
    let job = f.confirm(&inspect);
    f.mode("drift");
    assert_eq!(f.run(&job).unwrap_err().code, Code::TargetChanged);
    assert!(!job.snapshot().write_dispatched);
    assert!(
        f.calls()
            .iter()
            .all(|v| matches!(v[2].as_str(), "list" | "marketplace"))
    );
    assert_eq!(job.snapshot().outcome, Some(Outcome::NotDispatched));
}
#[test]
fn p40_cli_failed_or_malformed_ack_stays_unknown_and_recheck_never_rewrites() {
    for mode in ["write-exit", "bad-ack"] {
        let f = Fixture::new(false);
        let inventory = f.inventory();
        let inspect = f.inspect(&inventory, true);
        let job = f.confirm(&inspect);
        f.mode(mode);
        assert!(f.run(&job).is_err());
        assert_eq!(job.snapshot().outcome, Some(Outcome::Unknown));
        assert_eq!(job.snapshot().write_ack, Ack::Unknown);
        f.mode("normal");
        let (recheck, _) = f
            .registry
            .recheck(&f.row.id, &Fixture::id(), &job.snapshot().request_id)
            .unwrap();
        f.run(&recheck).unwrap();
        assert_eq!(recheck.snapshot().outcome, Some(Outcome::Observed));
        assert_eq!(f.calls().iter().filter(|v| v[2] == "add").count(), 1);
    }
}
#[test]
fn p40_cli_unsupported_is_failure_not_a_complete_empty_catalog() {
    let f = Fixture::new(false);
    f.mode("unsupported");
    let (job, _) = f
        .registry
        .sources(&f.row.id, &Fixture::id(), &f.selection, &f.cwd)
        .unwrap();
    assert_eq!(f.run(&job).unwrap_err().code, Code::QueryFailed);
    assert!(job.snapshot().catalog.is_none());
    assert_eq!(job.snapshot().outcome, None);
}
#[test]
fn p40_cli_cancel_before_write_and_early_cancel_have_no_dispatch() {
    let f = Fixture::new(false);
    let id = Fixture::id();
    f.registry.cancel(&f.row.id, &id).unwrap();
    assert_eq!(
        f.registry
            .sources(&f.row.id, &id, &f.selection, &f.cwd)
            .err()
            .unwrap()
            .code,
        Code::Cancelled
    );
    let inventory = f.inventory();
    let inspect = f.inspect(&inventory, true);
    let job = f.confirm(&inspect);
    job.operation.abandon();
    assert_eq!(f.run(&job).unwrap_err().code, Code::Cancelled);
    assert!(!job.snapshot().write_dispatched);
    assert!(
        f.calls()
            .iter()
            .all(|v| matches!(v[2].as_str(), "list" | "marketplace"))
    );
}
#[test]
fn p40_cli_cancel_after_spawn_retains_unknown_until_owned_child_ends() {
    let f = Fixture::new(false);
    let inventory = f.inventory();
    let inspect = f.inspect(&inventory, true);
    let job = f.confirm(&inspect);
    f.mode("slow-write");
    let cancellation = job.clone();
    let marker = f.root.path().join("started");
    let cancel = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(marker.exists());
        cancellation.operation.abandon();
    });
    assert_eq!(f.run(&job).unwrap_err().code, Code::Cancelled);
    cancel.join().unwrap();
    assert!(job.snapshot().settled);
    assert!(job.snapshot().write_dispatched);
    assert_eq!(job.snapshot().outcome, Some(Outcome::Unknown));
}
#[test]
fn p40_cli_foreign_marketplace_and_changed_selection_never_reach_write() {
    let f = Fixture::new(false);
    let inventory = f.inventory();
    f.mode("wrong-market");
    let (inspect, _) = f
        .registry
        .inspect(
            &f.row.id,
            &Fixture::id(),
            &inventory.snapshot().request_id,
            0,
            true,
        )
        .unwrap();
    assert_eq!(f.run(&inspect).unwrap_err().code, Code::InvalidOutput);
    f.mode("normal");
    let inventory = f.inventory();
    let inspect = f.inspect(&inventory, true);
    let job = f.confirm(&inspect);
    let mut changed = f.row.clone();
    changed.updated_at += 1;
    f.store.replace_agent_launch(&changed).unwrap();
    assert_eq!(f.run(&job).unwrap_err().code, Code::SelectionChanged);
    assert!(
        f.calls()
            .iter()
            .all(|v| matches!(v[2].as_str(), "list" | "marketplace"))
    );
}
#[test]
fn p40_cli_catalog_policies_and_provenance_do_not_grant_unknown_authority() {
    for (field, value, reason) in [
        ("marketplaceSource", Value::Null, "notConfiguredSource"),
        (
            "source",
            json!({"source":"remote","id":"PRIVATE"}),
            "unsupportedSource",
        ),
        ("installPolicy", json!("FUTURE"), "unknownPolicy"),
        ("installPolicy", json!("NOT_AVAILABLE"), "notAvailable"),
        ("authPolicy", json!("FUTURE"), "unknownPolicy"),
    ] {
        let mut v = entry(false);
        v[field] = value;
        let entries = catalog::parse(&wire(v)).unwrap();
        let item = entries[0].item(0);
        assert_eq!(item.install.reason, Some(reason));
        assert!(entries[0].admitted(true).is_err());
        assert!(!serde_json::to_string(&item).unwrap().contains("PRIVATE"));
    }
}
#[test]
fn p40_cli_catalog_bounds_duplicates_and_truncated_json_fail_without_partial_result() {
    for bytes in [
        b"null".as_slice(),
        b"{}",
        b"{\"installed\":[],\"available\":[] } trailing",
        b"{\"installed\":[],\"installed\":[],\"available\":[]}",
    ] {
        assert!(catalog::parse(bytes).is_err());
    }
    let duplicate = json!({"installed":[],"available":[entry(false),entry(false)]});
    assert!(catalog::parse(&serde_json::to_vec(&duplicate).unwrap()).is_err());
    assert_eq!(
        catalog::parse(&vec![b' '; inventory::output::STDOUT_LIMIT + 1])
            .unwrap_err()
            .code,
        Code::OutputLimit
    );
    let rows: Vec<_> = (0..513)
        .map(|i| {
            let mut v = entry(false);
            v["pluginId"] = json!(format!("p{i}@local-market"));
            v
        })
        .collect();
    assert_eq!(
        catalog::parse(&serde_json::to_vec(&json!({"installed":[],"available":rows})).unwrap())
            .unwrap_err()
            .code,
        Code::OutputLimit
    );
}
#[test]
fn p40_cli_leading_dash_selector_is_data_after_end_of_options() {
    let f = Fixture::new(false);
    let job = f.inventory();
    let args = cli::arguments(&job, "add", None, Some("--odd@--market")).unwrap();
    assert_eq!(&args[args.len() - 3..], ["--json", "--", "--odd@--market"]);
    let args = cli::arguments(&job, "list", Some("--market"), None).unwrap();
    assert_eq!(args.last().unwrap(), "--marketplace=--market");
    assert_eq!(
        cli::arguments(&job, "list", None, None).unwrap_err().code,
        Code::InvalidRequest
    );
    let args = cli::arguments(&job, "sources", None, None).unwrap();
    assert_eq!(
        &args[args.len() - 5..],
        ["cli", "plugin", "marketplace", "list", "--json"]
    );
}
#[test]
fn p40_cli_review_is_single_use_and_duplicate_request_is_one_owner() {
    let f = Fixture::new(false);
    let inventory = f.inventory();
    let inspect = f.inspect(&inventory, true);
    let review = inspect.snapshot().review.unwrap().review_id;
    let id = Fixture::id();
    let (first, fresh) = f.registry.confirm(&f.row.id, &id, &review).unwrap();
    assert!(fresh);
    let (same, fresh) = f.registry.confirm(&f.row.id, &id, &review).unwrap();
    assert!(!fresh);
    assert!(Arc::ptr_eq(&first, &same));
    first.finish(Some(Code::Cancelled.into()));
    assert_eq!(
        f.registry
            .confirm(&f.row.id, &Fixture::id(), &review)
            .err()
            .unwrap()
            .code,
        Code::ReviewConsumed
    );
}

#[test]
fn p40_cli_closed_review_or_catalog_cannot_authorize_a_later_write() {
    let f = Fixture::new(false);
    let inventory = f.inventory();
    let inspect = f.inspect(&inventory, true);
    let review = inspect.snapshot().review.unwrap().review_id;
    f.registry
        .cancel(&f.row.id, &inspect.snapshot().request_id)
        .unwrap();
    assert_eq!(
        f.registry
            .confirm(&f.row.id, &Fixture::id(), &review)
            .err()
            .unwrap()
            .code,
        Code::ReviewExpired
    );
    f.registry
        .cancel(&f.row.id, &inventory.snapshot().request_id)
        .unwrap();
    assert_eq!(
        f.registry
            .inspect(
                &f.row.id,
                &Fixture::id(),
                &inventory.snapshot().request_id,
                0,
                true
            )
            .err()
            .unwrap()
            .code,
        Code::TargetUnavailable
    );
    assert!(
        f.calls()
            .iter()
            .all(|v| matches!(v[2].as_str(), "list" | "marketplace"))
    );
}

#[test]
fn p40_cli_readback_version_difference_does_not_become_a_verified_install() {
    let f = Fixture::new(false);
    let inventory = f.inventory();
    let inspect = f.inspect(&inventory, true);
    let job = f.confirm(&inspect);
    f.mode("post-version");
    assert_eq!(f.run(&job).unwrap_err().code, Code::WriteUncertain);
    let result = job.snapshot();
    assert_eq!(result.write_ack, Ack::Ok);
    assert_eq!(result.outcome, Some(Outcome::Unknown));
    assert!(result.observation.unwrap().reported_installed);
}

#[test]
fn p40_cli_frontend_wire_from_complete_production_flows() {
    let f = Fixture::new(false);
    let inventory = f.inventory();
    let inspect = f.inspect(&inventory, true);
    let install = f.confirm(&inspect);
    f.run(&install).unwrap();
    let installed_inventory = f.inventory();
    let remove_inspect = f.inspect(&installed_inventory, false);
    let remove = f.confirm(&remove_inspect);
    f.run(&remove).unwrap();
    let (recheck, _) = f
        .registry
        .recheck(&f.row.id, &Fixture::id(), &remove.snapshot().request_id)
        .unwrap();
    f.run(&recheck).unwrap();
    let wire = json!({"inventory":inventory.snapshot(),"inspect":inspect.snapshot(),"install":install.snapshot(),"installedInventory":installed_inventory.snapshot(),"removeInspect":remove_inspect.snapshot(),"remove":remove.snapshot(),"recheck":recheck.snapshot()});
    assert!(!wire.to_string().contains("PRIVATE"));
    assert_eq!(wire["install"]["outcome"], "verified");
    assert_eq!(wire["remove"]["outcome"], "verified");
    assert_eq!(wire["recheck"]["outcome"], "observed");
    println!("P40_FRONTEND_WIRE={wire}");
}

#[test]
fn p40_cli_nested_duplicate_source_cannot_authorize_management() {
    let raw=br#"{"installed":[],"available":[{"pluginId":"sample@local-market","name":"sample","marketplaceName":"local-market","version":"1.0.0","installed":false,"enabled":false,"source":{"source":"future","source":"local","path":"/PRIVATE_SOURCE"},"marketplaceSource":{"sourceType":"local","source":"/PRIVATE_MARKET"},"installPolicy":"AVAILABLE","authPolicy":"ON_USE"}]}"#;
    let admitted = catalog::parse(raw).and_then(|entries| entries[0].admitted(true));
    assert!(
        admitted.is_err(),
        "duplicate source identity cannot grant installation authority"
    );
}

#[test]
fn p40_cli_nested_duplicate_marketplace_source_cannot_authorize_management() {
    let raw=br#"{"installed":[],"available":[{"pluginId":"sample@local-market","name":"sample","marketplaceName":"local-market","version":"1.0.0","installed":false,"enabled":false,"source":{"source":"local","path":"/PRIVATE_SOURCE"},"marketplaceSource":{"sourceType":"remote","sourceType":"local","source":"/PRIVATE_MARKET"},"installPolicy":"AVAILABLE","authPolicy":"ON_USE"}]}"#;
    let admitted = catalog::parse(raw).and_then(|entries| entries[0].admitted(true));
    assert!(
        admitted.is_err(),
        "duplicate marketplace identity cannot grant installation authority"
    );
}

#[test]
fn p40_cli_identical_or_escaped_duplicate_keys_are_invalid() {
    let original = String::from_utf8(wire(entry(false))).unwrap();
    let key = r#""source":"local""#;
    assert_eq!(original.matches(key).count(), 1);
    for repeated in [
        r#""source":"local","source":"local""#,
        r#""source":"local","\u0073ource":"local""#,
    ] {
        let raw = original.replace(key, repeated);
        assert_eq!(
            catalog::parse(raw.as_bytes()).unwrap_err().code,
            Code::InvalidOutput
        );
    }
}

#[test]
fn p40_cli_unknown_nested_objects_still_require_unique_keys() {
    let original = String::from_utf8(wire(entry(false))).unwrap();
    let path = r#""path":"/PRIVATE_SOURCE""#;
    assert_eq!(original.matches(path).count(), 1);
    let raw = original.replace(
        path,
        r#""path":"/PRIVATE_SOURCE","future":[{"same":1,"same":1}]"#,
    );
    assert_eq!(
        catalog::parse(raw.as_bytes()).unwrap_err().code,
        Code::InvalidOutput
    );
}

#[test]
fn p40_cli_unique_future_fields_remain_part_of_private_origin() {
    let future = json!({"records":[true,null,-2,4,1.5,"PRIVATE_FUTURE",{"nested":[]} ]});
    let mut value = entry(false);
    value["source"]["future"] = future.clone();
    let known = catalog::parse(&wire(value.clone())).unwrap().remove(0);
    assert_eq!(known.source["future"], future);
    known.admitted(true).unwrap();
    assert!(
        !serde_json::to_string(&known.item(0))
            .unwrap()
            .contains("PRIVATE")
    );
    value["source"]["future"]["records"][0] = json!(false);
    let changed = catalog::parse(&wire(value.clone())).unwrap().remove(0);
    assert!(!known.same_origin(&changed));
    value["source"]["source"] = json!("future");
    let unknown = catalog::parse(&wire(value)).unwrap().remove(0);
    assert_eq!(unknown.item(0).install.reason, Some("unsupportedSource"));
    assert!(unknown.admitted(true).is_err());
}

#[test]
fn p40_cli_install_restriction_does_not_prevent_installed_package_removal() {
    let f = Fixture::new(true);
    f.mode("not-available-policy");
    let inventory = f.inventory();
    let item = inventory.snapshot().catalog.unwrap().items.remove(0);
    assert_eq!(item.remove.availability, "available");
    assert_eq!(item.remove.reason, None);
    let inspect = f.inspect(&inventory, false);
    let remove = f.confirm(&inspect);
    f.run(&remove).unwrap();
    assert_eq!(remove.snapshot().outcome, Some(Outcome::Verified));
    assert!(!remove.snapshot().observation.unwrap().reported_installed);
    assert!(f.calls().iter().any(|args| args[2] == "remove"));
    assert!(f.calls().iter().all(|args| args[2] != "add"));
}

#[test]
fn p40_cli_removal_still_requires_known_policy_and_configured_source() {
    for (field, value, reason) in [
        ("installPolicy", json!("FUTURE"), "unknownPolicy"),
        ("authPolicy", json!("FUTURE"), "unknownPolicy"),
        ("source", json!({"source":"future"}), "unsupportedSource"),
        (
            "marketplaceSource",
            json!({"sourceType":"remote","source":"PRIVATE"}),
            "notConfiguredSource",
        ),
    ] {
        let mut original = entry(true);
        original[field] = value;
        let target = catalog::parse(&wire(original)).unwrap().remove(0);
        assert_eq!(target.item(0).remove.reason, Some(reason));
        assert!(target.admitted(false).is_err());
    }
}

#[test]
fn p40_scoped_initial_query_offers_sources_without_global_plugin_enumeration() {
    let f = Fixture::new(false);
    f.mode("scoped-only");
    let initial = f.initial_query();
    assert!(
        f.run(&initial).is_ok(),
        "source discovery must not require a global plugin-detail report"
    );
    let value = serde_json::to_value(initial.snapshot()).unwrap();
    assert_eq!(value["sources"]["items"][0]["name"], "local-market");
    assert_eq!(
        value["sources"]["items"][0]["query"]["availability"],
        "available"
    );
    assert!(
        f.calls()
            .iter()
            .all(|args| args[2] != "list" || args.contains(&"--marketplace=local-market".into()))
    );
}

#[test]
fn p40_scoped_missing_or_unknown_provenance_can_be_queried_but_not_mutated() {
    for mode in ["source-none", "source-unknown", "source-remote"] {
        let f = Fixture::new(false);
        f.mode(mode);
        let initial = f.initial_query();
        f.run(&initial).unwrap();
        assert_eq!(
            initial.snapshot().sources.unwrap().items[0]
                .query
                .availability,
            "available"
        );
        let (inventory, _) = f
            .registry
            .inventory(&f.row.id, &Fixture::id(), &initial.snapshot().request_id, 0)
            .unwrap();
        f.run(&inventory).unwrap();
        assert_eq!(
            inventory.snapshot().catalog.unwrap().items[0]
                .install
                .availability,
            "unavailable"
        );
        assert_eq!(
            f.registry
                .inspect(
                    &f.row.id,
                    &Fixture::id(),
                    &inventory.snapshot().request_id,
                    0,
                    true
                )
                .err()
                .unwrap()
                .code,
            Code::TargetUnavailable
        );
        assert!(
            f.calls()
                .iter()
                .all(|v| matches!(v[2].as_str(), "list" | "marketplace"))
        );
    }
}

#[test]
fn p40_scoped_ambiguous_global_unsafe_or_bad_root_sources_cannot_be_queried() {
    for (mode, reason) in [
        ("duplicate-source", "ambiguousSource"),
        ("global-source", "unsupportedSource"),
        ("unsafe-source", "unsafeLabel"),
        ("bad-root", "invalidSource"),
    ] {
        let f = Fixture::new(false);
        f.mode(mode);
        let initial = f.initial_query();
        f.run(&initial).unwrap();
        let items = initial.snapshot().sources.unwrap().items;
        assert!(items.iter().all(|v| v.query.reason == Some(reason)));
        assert_eq!(
            f.registry
                .inventory(&f.row.id, &Fixture::id(), &initial.snapshot().request_id, 0)
                .err()
                .unwrap()
                .code,
            Code::TargetUnavailable
        );
        assert_eq!(f.calls().len(), 1);
    }
}

#[test]
fn p40_scoped_source_identity_drift_rejects_before_named_list() {
    for mode in [
        "root-change",
        "provenance-change",
        "name-change",
        "source-disappear",
        "duplicate-source",
    ] {
        let f = Fixture::new(false);
        let initial = f.initial_query();
        f.run(&initial).unwrap();
        let (inventory, _) = f
            .registry
            .inventory(&f.row.id, &Fixture::id(), &initial.snapshot().request_id, 0)
            .unwrap();
        f.mode(mode);
        assert_eq!(f.run(&inventory).unwrap_err().code, Code::TargetChanged);
        assert!(inventory.snapshot().catalog.is_none());
        assert!(f.calls().iter().all(|v| v[2] == "marketplace"));
    }
}

#[test]
fn p40_scoped_source_postflight_and_plugin_provenance_cannot_publish_partial_authority() {
    for mode in ["root-after-list", "entry-provenance-change"] {
        let f = Fixture::new(false);
        let initial = f.initial_query();
        f.run(&initial).unwrap();
        let (inventory, _) = f
            .registry
            .inventory(&f.row.id, &Fixture::id(), &initial.snapshot().request_id, 0)
            .unwrap();
        f.mode(mode);
        assert_eq!(f.run(&inventory).unwrap_err().code, Code::TargetChanged);
        assert!(inventory.snapshot().catalog.is_none());
        assert!(inventory.entries.lock().unwrap().is_none());
        assert_eq!(f.calls().iter().filter(|v| v[2] == "list").count(), 1);
    }
}

#[test]
fn p40_scoped_origin_survives_into_inspect_confirm_and_recheck() {
    for stage in ["inspect", "confirm", "recheck"] {
        let f = Fixture::new(false);
        let inventory = f.inventory();
        let job = if stage == "inspect" {
            f.registry
                .inspect(
                    &f.row.id,
                    &Fixture::id(),
                    &inventory.snapshot().request_id,
                    0,
                    true,
                )
                .unwrap()
                .0
        } else {
            let inspect = f.inspect(&inventory, true);
            let confirm = f.confirm(&inspect);
            if stage == "recheck" {
                f.run(&confirm).unwrap();
                f.registry
                    .recheck(&f.row.id, &Fixture::id(), &confirm.snapshot().request_id)
                    .unwrap()
                    .0
            } else {
                confirm
            }
        };
        let reads = f.calls().iter().filter(|v| v[2] == "list").count();
        f.mode("root-change");
        assert_eq!(f.run(&job).unwrap_err().code, Code::TargetChanged);
        assert_eq!(f.calls().iter().filter(|v| v[2] == "list").count(), reads);
        assert!(!job.snapshot().write_dispatched);
        assert!(job.snapshot().review.is_none());
        if stage == "recheck" {
            assert_eq!(job.snapshot().outcome, Some(Outcome::Unknown));
        }
    }
}

#[test]
fn p40_scoped_source_request_cannot_be_forged_reused_after_retirement_or_replaced_by_catalog() {
    let f = Fixture::new(false);
    let initial = f.initial_query();
    f.run(&initial).unwrap();
    let id = initial.snapshot().request_id;
    assert_eq!(
        f.registry
            .inventory("other", &Fixture::id(), &id, 0)
            .err()
            .unwrap()
            .code,
        Code::UnknownRequest
    );
    assert_eq!(
        f.registry
            .inventory(&f.row.id, &Fixture::id(), &id, 1)
            .err()
            .unwrap()
            .code,
        Code::TargetUnavailable
    );
    let (inventory, _) = f
        .registry
        .inventory(&f.row.id, &Fixture::id(), &id, 0)
        .unwrap();
    f.run(&inventory).unwrap();
    assert_eq!(
        f.registry
            .inventory(
                &f.row.id,
                &Fixture::id(),
                &inventory.snapshot().request_id,
                0
            )
            .err()
            .unwrap()
            .code,
        Code::TargetUnavailable
    );
    f.registry.cancel(&f.row.id, &id).unwrap();
    assert_eq!(
        f.registry
            .inventory(&f.row.id, &Fixture::id(), &id, 0)
            .err()
            .unwrap()
            .code,
        Code::TargetUnavailable
    );
    assert_eq!(f.calls().iter().filter(|v| v[2] == "list").count(), 1);
}

#[test]
fn p40_scoped_sources_keep_complete_json_duplicate_depth_count_and_byte_budgets() {
    let row = json!({"name":"local-market","root":"/PRIVATE_MARKET","marketplaceSource":{"sourceType":"future","source":"PRIVATE","extra":{"v":1}}});
    let original = serde_json::to_vec(&json!({"marketplaces":[row.clone()]})).unwrap();
    let rows = sources::parse(&original).unwrap();
    rows[0].admitted().unwrap();
    let public = serde_json::to_string(&sources::public(&rows)).unwrap();
    assert!(!public.contains("PRIVATE"));
    let mut changed = row.clone();
    changed["marketplaceSource"]["extra"]["v"] = json!(2);
    let changed =
        sources::parse(&serde_json::to_vec(&json!({"marketplaces":[changed]})).unwrap()).unwrap();
    assert_eq!(
        sources::current(&changed, &rows[0]).unwrap_err().code,
        Code::TargetChanged
    );
    for raw in [
        br#"{"marketplaces":[],"marketplaces":[]}"#.as_slice(),
        br#"{"marketplaces":[{"name":"local-market","root":"/A","marketplaceSource":{"sourceType":"future","sourceType":"local"}}]}"#,
        br#"{"marketplaces":[{"name":"local-market","root":"/A","marketplaceSource":{"future":[{"x":1,"x":1}]}}]}"#,
        br#"{"marketplaces":[]} trailing"#,
    ] { assert_eq!(sources::parse(raw).unwrap_err().code, Code::InvalidOutput); }
    assert!(
        sources::parse(&serde_json::to_vec(&json!({"marketplaces":[row.clone(),row]})).unwrap())
            .is_err()
    );
    let many: Vec<_> = (0..513)
        .map(|i| json!({"name":format!("m{i}"),"root":format!("/PRIVATE_{i}")}))
        .collect();
    assert_eq!(
        sources::parse(&serde_json::to_vec(&json!({"marketplaces":many})).unwrap())
            .unwrap_err()
            .code,
        Code::OutputLimit
    );
    assert_eq!(
        sources::parse(&vec![b' '; inventory::output::STDOUT_LIMIT + 1])
            .unwrap_err()
            .code,
        Code::OutputLimit
    );
    let deep = format!("{}0{}", "[".repeat(33), "]".repeat(33));
    assert_eq!(
        sources::parse(deep.as_bytes()).unwrap_err().code,
        Code::InvalidOutput
    );
}

#[test]
fn p40_scoped_source_stderr_limit_and_actual_cancellation_still_apply() {
    let f = Fixture::new(false);
    f.mode("sources-stderr");
    let initial = f.initial_query();
    assert_eq!(f.run(&initial).unwrap_err().code, Code::OutputLimit);
    assert!(initial.snapshot().sources.is_none());
    f.mode("slow-sources");
    let initial = f.initial_query();
    let cancellation = initial.clone();
    let marker = f.root.path().join("source-started");
    let cancel = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(marker.exists());
        cancellation.operation.abandon();
    });
    assert_eq!(f.run(&initial).unwrap_err().code, Code::Cancelled);
    cancel.join().unwrap();
    assert!(initial.snapshot().settled && !initial.snapshot().write_dispatched);
    f.mode("normal");
    assert!(f.inventory().snapshot().catalog.is_some());
}

#[test]
fn p40_scoped_frontend_wire_from_sources_through_existing_write_and_readback() {
    let f = Fixture::new(false);
    let initial = f.initial_query();
    f.run(&initial).unwrap();
    let (inventory, _) = f
        .registry
        .inventory(&f.row.id, &Fixture::id(), &initial.snapshot().request_id, 0)
        .unwrap();
    f.run(&inventory).unwrap();
    let inspect = f.inspect(&inventory, true);
    let install = f.confirm(&inspect);
    f.run(&install).unwrap();
    let (recheck, _) = f
        .registry
        .recheck(&f.row.id, &Fixture::id(), &install.snapshot().request_id)
        .unwrap();
    f.run(&recheck).unwrap();
    let wire = json!({"sources":initial.snapshot(),"inventory":inventory.snapshot(),"inspect":inspect.snapshot(),"install":install.snapshot(),"recheck":recheck.snapshot()});
    assert!(!wire.to_string().contains("PRIVATE"));
    assert!(wire["inventory"].get("sources").is_none());
    assert_eq!(wire["sources"]["writeDispatched"], false);
    assert_eq!(wire["sources"]["outcome"], Value::Null);
    assert_eq!(wire["install"]["outcome"], "verified");
    assert_eq!(wire["recheck"]["outcome"], "observed");
    println!("P40_SCOPED_FRONTEND_WIRE={wire}");
}
