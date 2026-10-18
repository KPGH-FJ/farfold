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
if action=='list':
 assert '--available' in args and '--json' in args
 n=int((root/'reads').read_text())+1; (root/'reads').write_text(str(n))
 if mode=='drift' and n>=3: entry['source']['path']='/PRIVATE_REPLACED'
 if mode=='wrong-market': entry['marketplaceName']='other'
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
        let (job, _) = self
            .registry
            .inventory(&self.row.id, &Self::id(), &self.selection, &self.cwd)
            .unwrap();
        self.run(&job).unwrap();
        job
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
        assert_eq!(calls.len(), 5);
        assert!(calls[1].contains(&"--marketplace=local-market".into()));
        assert_eq!(
            &calls[3][2..],
            [
                if install { "add" } else { "remove" },
                "--json",
                "--",
                "sample@local-market"
            ]
        );
        assert!(calls[4].contains(&"--marketplace=local-market".into()));
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
    assert!(f.calls().iter().all(|v| v[2] == "list"));
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
        .inventory(&f.row.id, &Fixture::id(), &f.selection, &f.cwd)
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
            .inventory(&f.row.id, &id, &f.selection, &f.cwd)
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
    assert!(f.calls().iter().all(|v| v[2] == "list"));
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
    assert!(f.calls().iter().all(|v| v[2] == "list"));
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
    assert!(f.calls().iter().all(|v| v[2] == "list"));
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
