//! E engineering boundary. Tauri exposes safe reads and hard-closed operations.
//! Shared Host ACP transport -> independent adapter -> fixed owned App Server.
pub mod admission;
pub mod configure;
pub mod interactions;
pub mod operations;
pub mod profile;
pub mod sessions;
pub mod threads;
pub mod turns;
pub mod workspace;
use crate::{
    acp_runtime::initialize_transport, acp_transport::AcpTransport, runtime_registry::file_sha256,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs, os::unix::fs::DirBuilderExt, path::PathBuf, process::Command, sync::Arc, time::Duration,
};

pub const ADAPTER_VERSION: &str = "0.2.0";
pub const ADMISSION_SHA: &str = "8b26fe2184078fd26fe91cfc9b9798733b974ba80c9824325bd3e631b71bc825";
pub const INTERACTIONS_SHA: &str =
    "6046eaba46f6840eeb634c3cc15e37f9041022f40d821106ff7018b1d0421ed6";
pub const TURNS_SHA: &str = "5660670d07ef1574f9b522ac91fbcdcc54dc17bb7a4629eefafb713c4f71e8ff";
pub const CORE_SHA: &str = "5e3b42b23ca14c16f5d4899aaea4c87a673272fbe9f49dad6a6ea331c2ee267f";
pub const CONFIGURE_SHA: &str = "741efc417116b703686f21da1be10f5fe2f38bb49aa51bd3e3833e119a4cab1f";
pub const THREADS_SHA: &str = "ccb9a64d786448b519fb36702fa3e77f1514aee39cb6786e3542638b03d52359";
pub const EVENTS_SHA: &str = "8b3a557046073a057a87f7ce8641ba452a926f2ab2836795322cada433a433ec";
pub const ADAPTER_SHA: &str = "ba469273f4a3d6974e4ba30ce8b200be2868bc9aeca16c3b487036a6ead1f993";
pub const NATIVE_SHA: &str = "9070e47d422129106bc41ca651a9998b06a6c55bd42a7c3362b48f1d2850766f";
pub const NODE_SHA: &str = "5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub runtime_product_id: String,
    pub installation_id: String,
    pub runtime_build_id: String,
    pub adapter_id: String,
    pub adapter_build_id: String,
    pub connection_id: String,
    pub profile_id: String,
    pub generation: u64,
}

impl Scope {
    pub(crate) fn binding(&self) -> Result<crate::runtime_registry::RuntimeBinding, String> {
        use crate::host_ids::*;
        self.validate()?;
        Ok(crate::runtime_registry::RuntimeBinding {
            product_id: RuntimeProductId::parse(&self.runtime_product_id)
                .map_err(|e| e.to_string())?,
            installation_id: InstallationId::parse(&self.installation_id)
                .map_err(|e| e.to_string())?,
            runtime_build_id: RuntimeBuildId::parse(&self.runtime_build_id)
                .map_err(|e| e.to_string())?,
            adapter_id: AdapterId::parse(&self.adapter_id).map_err(|e| e.to_string())?,
            connection_id: ConnectionId::parse(&self.connection_id).map_err(|e| e.to_string())?,
        })
    }
    fn validate(&self) -> Result<(), String> {
        for value in [&self.installation_id, &self.connection_id, &self.profile_id] {
            crate::host_ids::ConnectionId::parse(value.as_str()).map_err(|e| e.to_string())?;
            if value.len() > 160
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            {
                return Err("Codex ACP scope identity is invalid".into());
            }
        }
        if self.runtime_product_id != "codex"
            || self.adapter_id != "codex-acp-stdio-v1"
            || self.runtime_build_id != NATIVE_SHA
            || self.adapter_build_id != ADAPTER_SHA
            || self.generation == 0
            || self.generation > 9_007_199_254_740_991
        {
            return Err("Codex ACP fixed combination or generation is invalid".into());
        }
        Ok(())
    }
}

pub struct Launch {
    pub node: PathBuf,
    pub adapter: PathBuf,
    pub native: PathBuf,
    /// Existing application-owned parent. This slice always creates a NEW child.
    pub owned_parent: PathBuf,
    pub cwd: PathBuf,
    pub working_copy_id: Option<crate::host_ids::WorkingCopyId>,
    pub scope: Scope,
}

pub struct Connection {
    transport: Arc<AcpTransport>,
    scope: Scope,
    pub profile_home: PathBuf,
    control: configure::Control,
    workspace: threads::Workspace,
    threads: threads::Control,
    turns: turns::Control,
    admission: Option<admission::Snapshot>,
    _profile_lease: Option<fs::File>,
}

fn verify_files(launch: &Launch) -> Result<(), String> {
    for (path, sha) in [
        (launch.node.clone(), NODE_SHA),
        (launch.adapter.clone(), ADAPTER_SHA),
        (launch.native.clone(), NATIVE_SHA),
        (launch.adapter.with_file_name("core.mjs"), CORE_SHA),
        (launch.adapter.with_file_name("threads.mjs"), THREADS_SHA),
        (launch.adapter.with_file_name("events.mjs"), EVENTS_SHA),
        (launch.adapter.with_file_name("turns.mjs"), TURNS_SHA),
        (
            launch.adapter.with_file_name("admission.mjs"),
            ADMISSION_SHA,
        ),
        (
            launch.adapter.with_file_name("interactions.mjs"),
            INTERACTIONS_SHA,
        ),
        (
            launch.adapter.with_file_name("configure.mjs"),
            CONFIGURE_SHA,
        ),
    ] {
        if !path.is_absolute() || file_sha256(&path)? != sha {
            return Err("Codex ACP launch file does not match fixed manifest".into());
        }
    }
    Ok(())
}

impl Connection {
    #[cfg(test)]
    pub fn start(launch: Launch) -> Result<Self, String> {
        Self::start_inner(launch, None)
    }
    pub(super) fn start_inner(launch: Launch, lease: Option<fs::File>) -> Result<Self, String> {
        let prepared = lease.is_some();
        launch.scope.validate()?;
        verify_files(&launch)?;
        let parent = launch
            .owned_parent
            .canonicalize()
            .map_err(|_| "Owned parent missing")?;
        let cwd = launch
            .cwd
            .canonicalize()
            .map_err(|_| "Owned control directory missing")?;
        if !parent.is_dir() || !cwd.is_dir() {
            return Err("Codex ACP launch directories invalid".into());
        }
        let home = parent.join(&launch.scope.profile_id);
        // Never reopen, inspect, copy or overwrite an existing authentication domain.
        if !prepared {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&home)
                .map_err(|_| "New private profile required")?;
        }
        let codex_home = home.join("codex");
        if !prepared {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&codex_home)
                .map_err(|_| "Cannot create owned Codex home")?;
        }
        profile::private_directory(&home)?;
        profile::private_directory(&codex_home)?;
        let workspace = threads::Workspace {
            cwd: cwd.clone(),
            working_copy_id: launch.working_copy_id.clone(),
        };
        let config = json!({"scope":launch.scope, "binary":launch.native, "home":home,"codexHome":codex_home,"cwd":cwd,"workingCopyId":launch.working_copy_id});
        let mut command = Command::new(&launch.node);
        command
            .arg(&launch.adapter)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", &home)
            .env("FARFOLD_CODEX_ACP_LAUNCH", config.to_string())
            .current_dir(&cwd);
        let (transport, initialized) = initialize_transport(
            &mut command,
            &cwd,
            json!({}),
            ADAPTER_VERSION,
            Duration::from_secs(15),
        )?;
        let connection = Self {
            transport,
            scope: launch.scope,
            profile_home: home,
            control: configure::Control::default(),
            workspace,
            threads: threads::Control::default(),
            turns: turns::Control::default(),
            admission: None,
            _profile_lease: lease,
        };
        connection.verify_scope(&initialized["_meta"]["farfoldCodex"]["scope"])?;
        if initialized
            .pointer("/_meta/farfoldCodex/readiness")
            .and_then(Value::as_str)
            != Some("ready")
            || initialized.pointer("/_meta/farfoldCodex/tasksImplemented") != Some(&json!(true))
            || initialized.pointer("/_meta/farfoldCodex/loginImplemented") != Some(&json!(true))
        {
            return Err("Codex ACP capabilities mismatch".into());
        }
        Ok(connection)
    }

    fn verify_scope(&self, value: &Value) -> Result<(), String> {
        let scope = serde_json::from_value::<Scope>(value.clone())
            .map_err(|_| "Codex ACP receipt omitted exact scope")?;
        if scope != self.scope {
            return Err("Codex ACP stale or foreign receipt".into());
        }
        Ok(())
    }

    pub fn read(&self, scope: &Scope, method: ReadMethod) -> Result<Value, String> {
        self.read_with_timeout(scope, method, Duration::from_secs(15))
    }

    fn read_with_timeout(
        &self,
        scope: &Scope,
        method: ReadMethod,
        timeout: Duration,
    ) -> Result<Value, String> {
        if scope != &self.scope {
            return Err("Codex ACP request targets another connection".into());
        }
        let result = (|| {
            let response = self
                .transport
                .request_timeout(method.wire_method(), json!({"scope":scope}), timeout)
                .map_err(|e| e.to_string())?;
            self.verify_scope(&response["scope"])?;
            match method {
                ReadMethod::Account => {
                    let account = &response["account"];
                    let kind = account["kind"].as_str();
                    if !account["requiresOpenaiAuth"].is_boolean()
                        || !kind.is_some_and(|k| {
                            matches!(
                                k,
                                "apiKey" | "chatgpt" | "amazonBedrock" | "unauthenticated"
                            )
                        })
                    {
                        return Err("Codex ACP account receipt outside contract".into());
                    }
                }
                ReadMethod::ThreadList => {
                    if !response["data"].is_array()
                        || !(response["nextCursor"].is_null()
                            || response["nextCursor"].as_str().is_some_and(|c| {
                                !c.is_empty() && c.len() <= 1024 && !c.bytes().any(|b| b == 0)
                            }))
                    {
                        return Err("Codex ACP list receipt outside contract".into());
                    }
                }
            }
            Ok(response)
        })();
        if result.is_err() {
            let _ = self.transport.stop();
        }
        result
    }

    pub fn events(&self) -> Result<Vec<Value>, String> {
        if self.turns.event_pump_stop.is_some() {
            return Err("Host pump owns Codex event consumption".into());
        }
        self.drain_validated_events()
    }

    fn drain_validated_events(&self) -> Result<Vec<Value>, String> {
        let result = (|| {
            let (events, dropped) = self.transport.drain_events()?;
            if dropped > 0 || self.transport.failure().is_some() {
                return Err("Codex ACP event continuity unknown".into());
            }
            for event in &events {
                self.verify_scope(&event["params"]["scope"])?;
                match event["method"].as_str() {
                    Some("_codex/thread/event") => self.threads.validate_event(
                        &event["params"]["thread"],
                        &self.workspace,
                        &self.profile_home,
                    )?,
                    Some("_codex/turn/event") => {
                        self.turns.validate_event(&event["params"]["turn"])?;
                    }
                    _ => return Err("Unscoped Codex ACP event".into()),
                }
            }
            Ok(events)
        })();
        if result.is_err() {
            let _ = self.transport.stop();
        }
        result
    }

    pub fn stop(&self) -> Result<(), String> {
        if let Some(stop) = &self.turns.event_pump_stop {
            stop.store(true, std::sync::atomic::Ordering::Release);
        }
        self.transport.stop()
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[derive(Clone, Copy)]
pub enum ReadMethod {
    Account,
    ThreadList,
}
impl ReadMethod {
    fn wire_method(self) -> &'static str {
        match self {
            Self::Account => "_codex/account/read",
            Self::ThreadList => "_codex/thread/list",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maintained_manifest_pins_every_executable_adapter_module() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("codex-acp-adapter");
        let manifest: Value =
            serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["version"], ADAPTER_VERSION);
        assert_eq!(manifest["sha256"], ADAPTER_SHA);
        assert_eq!(manifest["codex"]["sha256"], NATIVE_SHA);
        assert_eq!(manifest["node"]["sha256"], NODE_SHA);
        for (name, sha) in [
            ("adapter.mjs", ADAPTER_SHA),
            ("core.mjs", CORE_SHA),
            ("configure.mjs", CONFIGURE_SHA),
            ("threads.mjs", THREADS_SHA),
            ("events.mjs", EVENTS_SHA),
            ("turns.mjs", TURNS_SHA),
            ("interactions.mjs", INTERACTIONS_SHA),
            ("admission.mjs", ADMISSION_SHA),
        ] {
            assert_eq!(file_sha256(&root.join(name)).unwrap(), sha);
            if name != "adapter.mjs" {
                assert_eq!(manifest["modules"][name], sha);
            }
        }
    }
    fn scope() -> Scope {
        Scope {
            runtime_product_id: "codex".into(),
            installation_id: "codex-fixed-e".into(),
            runtime_build_id: NATIVE_SHA.into(),
            adapter_id: "codex-acp-stdio-v1".into(),
            adapter_build_id: ADAPTER_SHA.into(),
            connection_id: "connection-e".into(),
            profile_id: "profile-e".into(),
            generation: 1,
        }
    }

    #[test]
    fn scope_requires_fixed_combination_and_safe_owned_identity() {
        assert!(scope().validate().is_ok());
        for field in [
            "runtimeProductId",
            "installationId",
            "runtimeBuildId",
            "adapterId",
            "adapterBuildId",
            "connectionId",
            "profileId",
        ] {
            let mut value = serde_json::to_value(scope()).unwrap();
            value[field] = json!("../wrong");
            assert!(
                serde_json::from_value::<Scope>(value)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        let mut wrong = scope();
        wrong.generation = 0;
        assert!(wrong.validate().is_err());
    }

    fn synthetic_connection(mode: &str) -> Connection {
        let mut command = Command::new("/usr/bin/python3");
        command.args(["-u", "-c", r#"
import sys,json,time,os
scope=json.loads(os.environ['FARFOLD_TEST_SCOPE'])
for line in sys.stdin:
 r=json.loads(line)
 mode=os.environ['FARFOLD_TEST_MODE']
 if mode=='crash':sys.exit(1)
 if mode=='late':time.sleep(0.2)
 if mode=='foreign':scope['generation']+=1
 if mode=='event':print(json.dumps({'jsonrpc':'2.0','method':'_codex/event','params':{'scope':scope,'native':{'method':'future/native','params':{'opaque':42}}}}),flush=True)
 if mode=='foreign_event':
  other=dict(scope);other['profileId']='foreign'
  print(json.dumps({'jsonrpc':'2.0','method':'_codex/event','params':{'scope':other,'native':{'method':'future/native'}}}),flush=True)
 account={'kind':'unauthenticated','requiresOpenaiAuth':True}
 if mode=='malformed':account={}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':{'scope':scope,'account':account}}),flush=True)
"#]).env("FARFOLD_TEST_SCOPE",serde_json::to_string(&scope()).unwrap()).env("FARFOLD_TEST_MODE",mode);
        Connection {
            transport: Arc::new(AcpTransport::spawn(&mut command).unwrap()),
            scope: scope(),
            profile_home: PathBuf::new(),
            control: configure::Control::default(),
            workspace: threads::Workspace {
                cwd: PathBuf::new(),
                working_copy_id: None,
            },
            threads: threads::Control::default(),
            turns: turns::Control::default(),
            admission: None,
            _profile_lease: None,
        }
    }

    #[test]
    fn foreign_malformed_crash_and_timeout_close_without_accepting_late_results() {
        for mode in ["foreign", "malformed", "crash", "late"] {
            let connection = synthetic_connection(mode);
            assert!(
                connection
                    .read_with_timeout(&scope(), ReadMethod::Account, Duration::from_millis(100))
                    .is_err(),
                "{mode}"
            );
            assert!(!connection.transport.is_running().unwrap(), "{mode}");
            assert!(connection.read(&scope(), ReadMethod::Account).is_err());
        }
    }

    #[test]
    fn raw_unknown_or_foreign_events_cannot_enter_the_thread_channel() {
        let connection = synthetic_connection("event");
        connection.read(&scope(), ReadMethod::Account).unwrap();
        assert!(connection.events().is_err());
        let foreign = synthetic_connection("foreign_event");
        foreign.read(&scope(), ReadMethod::Account).unwrap();
        assert!(foreign.events().is_err());
        assert!(!foreign.transport.is_running().unwrap());
    }

    #[test]
    #[ignore = "explicit fixed Codex and Node binaries; owned empty profile, zero login/model calls"]
    fn fixed_native_account_and_empty_list_through_shared_acp() {
        let temp = tempfile::tempdir().unwrap();
        let connection = Connection::start(Launch {
            node: std::env::var_os("FARFOLD_E_NODE")
                .expect("explicit Node")
                .into(),
            native: std::env::var_os("FARFOLD_E_CODEX")
                .expect("explicit Codex")
                .into(),
            adapter: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("codex-acp-adapter/adapter.mjs"),
            owned_parent: temp.path().into(),
            cwd: temp.path().into(),
            working_copy_id: None,
            scope: scope(),
        })
        .unwrap();
        assert_eq!(
            connection.read(&scope(), ReadMethod::Account).unwrap()["account"],
            json!({"kind":"unauthenticated","requiresOpenaiAuth":true})
        );
        assert_eq!(
            connection.read(&scope(), ReadMethod::ThreadList).unwrap()["data"],
            json!([])
        );
        let mut old = scope();
        old.generation = 2;
        assert!(connection.read(&old, ReadMethod::Account).is_err());
        let rejected = connection
            .transport
            .request("_codex/account/read", json!({"scope":old}));
        assert!(rejected.is_err());
        assert!(connection.read(&scope(), ReadMethod::Account).is_ok());
        // Admission is now real: an unauthenticated account still admits a
        // catalog refresh; explicit selection/preflight/restore fail without a
        // fresh observation carrying an authenticated account.
        let refreshed = connection.transport.request(
            "_codex/admission",
            json!({"scope":scope(),"command":{"action":"refresh"}}),
        );
        let snapshot = refreshed.expect("unauthenticated catalog refresh")["snapshot"].clone();
        assert_eq!(snapshot["account"]["kind"], json!("unauthenticated"));
        for action in ["select", "preflight", "restore"] {
            let rejected = connection.transport.request(
                "_codex/admission",
                json!({"scope":scope(),"command":{"action":action}}),
            );
            assert!(rejected.is_err(), "{action}");
        }
        assert!(
            connection
                .transport
                .request("session/new", json!({"scope":scope(),"cwd":temp.path()}))
                .is_err()
        );
        for event in connection.events().unwrap() {
            assert_eq!(
                event["params"]["scope"],
                serde_json::to_value(scope()).unwrap()
            );
        }
        connection.stop().unwrap();
        assert!(!connection.transport.is_running().unwrap());
        assert!(!connection.profile_home.join("codex/auth.json").exists());
    }
}
