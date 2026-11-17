//! Owned package/SDK/PTY fixtures only; no official CLI, account or Keychain.
use super::*;
use crate::acp_client::recipes::COPILOT_LOGIN as DECLARATION;
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

struct Fixture {
    data: PathBuf,
    root: PathBuf,
    loader: PathBuf,
    target: PathBuf,
    row: AgentRow,
    store: MetaStore,
    // Keep the directory until its SQLite store has closed on Windows.
    _temp: tempfile::TempDir,
}

fn executable(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
    crate::process_platform::set_executable(path).unwrap();
}

impl Fixture {
    fn new() -> Self {
        Self::with_layout(cfg!(windows), "1.0.89")
    }
    fn with_layout(encoded: bool, version: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().canonicalize().unwrap().join("data");
        let root = data.join(if encoded || cfg!(windows) {
            "agent-installations/agent-registry%3Agithub-copilot-cli/install-fixture"
        } else {
            "agents/registry:github-copilot-cli/install-fixture"
        });
        let loader = root
            .join("node_modules")
            .join(DECLARATION.package)
            .join(DECLARATION.loader);
        let target = root
            .join("node_modules")
            .join(DECLARATION.platform_package)
            .join(DECLARATION.platform_entry);
        let node = data.join(if cfg!(windows) {
            "tools/node.exe"
        } else {
            "tools/node"
        });
        executable(&node, "#!/bin/sh\nexec /usr/bin/python3 \"$@\"\n");
        executable(&target, "#!/bin/sh\nexit 0\n");
        executable(
            &loader,
            r#"import json,sys
from pathlib import Path
if sys.argv[1:] == ['login']:
 Path(__file__).with_name('login-observed').write_text(json.dumps(sys.argv[1:]))
 sys.exit(0)
for line in sys.stdin:
 m=json.loads(line)
 Path(__file__).with_name('protocol-observed').open('a').write(m.get('method','')+'\n')
 if m.get('method')=='initialize':
  target=str(Path(__file__).parent.parent/'FIXTURE_PLATFORM_PACKAGE'/'FIXTURE_PLATFORM_ENTRY')
  result={'protocolVersion':1,'agentCapabilities':{},'authMethods':[{'id':'copilot-login','name':'Login','_meta':{'terminal-auth':{'command':target,'args':['login']}}}]}
 else: result={}
 print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)
"#.replace("FIXTURE_PLATFORM_PACKAGE", DECLARATION.platform_package.strip_prefix("@github/").unwrap()).replace("FIXTURE_PLATFORM_ENTRY", DECLARATION.platform_entry).as_str(),
        );
        std::fs::write(
            loader.with_file_name("package.json"),
            json!({"name":DECLARATION.package,"version":version,"bin":{"copilot":DECLARATION.loader},
                "optionalDependencies":{(DECLARATION.platform_package):version}})
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            target.with_file_name("package.json"),
            json!({"name":DECLARATION.platform_package,"version":version,
                "os":[if cfg!(windows) {"win32"} else {"darwin"}],
                "cpu":[if cfg!(target_arch="aarch64") {"arm64"} else {"x64"}],
                "exports":{".":format!("./{}", DECLARATION.platform_entry)}})
            .to_string(),
        )
        .unwrap();
        let row = AgentRow {
            id: "registry:github-copilot-cli".into(),
            name: "Fixture".into(),
            source: "registry".into(),
            command: node.display().to_string(),
            args: vec![loader.display().to_string(), "--acp".into()],
            env: vec![],
            version: Some(version.into()),
            handshake: Some(
                json!({"authMethods":[{"id":"copilot-login","name":"Login","_meta":{"terminal-auth":{"command":target,"args":["login"]}}}]}),
            ),
            created_at: 0,
            updated_at: 0,
        };
        let store = MetaStore::open(&data.join("meta.db")).unwrap();
        store.insert_agent(&row).unwrap();
        crate::installations::record(&store, &row, &root).unwrap();
        Self {
            _temp: temp,
            data,
            root,
            loader,
            target,
            row,
            store,
        }
    }
    fn info(&self, row: &AgentRow) -> AuthMethodsResponse {
        auth_methods_with_proof(
            row,
            &crate::acp_client::auth_route::managed_terminal_proof(row, &self.store, &self.data),
        )
    }
    fn denied(&self) {
        let info = self.info(&self.row);
        assert!(info.methods[0].unavailable_reason.is_some());
        assert!(info.methods[0].terminal_command.is_none());
        assert!(!crate::acp_client::auth_route::protocol_method(
            &self.row.handshake.as_ref().unwrap()["authMethods"][0]
        ));
        assert!(!self.loader.with_file_name("login-observed").exists());
    }
    fn receipts(&self, mutate: impl FnOnce(&mut Value)) {
        let mut value = self.store.get_setting("installations.v1").unwrap().unwrap();
        mutate(&mut value);
        self.store.set_setting("installations.v1", &value).unwrap();
    }
}

#[test]
fn copilot_selected_flat_package_offers_the_registered_loader_login() {
    let f = Fixture::new();
    let info = f.info(&f.row);
    assert_eq!(info.methods[0].kind, "terminal");
    assert!(info.methods[0].unavailable_reason.is_none());
    assert_eq!(
        info.methods[0].terminal_command,
        Some(vec![
            f.row.command.clone(),
            f.loader.display().to_string(),
            "login".into()
        ])
    );
}

#[test]
fn copilot_requires_one_matching_owned_receipt_and_exact_registered_scope() {
    for change in [
        "duplicate",
        "source",
        "programOnly",
        "version",
        "command",
        "args",
        "id",
        "path",
        "root",
    ] {
        let f = Fixture::new();
        f.receipts(|items| match change {
            "duplicate" => {
                let duplicate = items[0].clone();
                items.as_array_mut().unwrap().push(duplicate);
            }
            "source" => items[0]["source"] = json!("external"),
            "programOnly" => items[0]["programOnly"] = json!(true),
            "version" => items[0]["version"] = json!("1.0.90"),
            "command" => items[0]["command"] = json!("/other/node"),
            "args" => items[0]["args"] = json!([f.loader, "--other"]),
            "id" => items[0]["id"] = json!("forged-receipt"),
            "path" => items[0]["path"] = json!(f.data),
            "root" => items[0]["managedRoot"] = json!(f.data),
            _ => unreachable!(),
        });
        f.denied();
    }
    for change in ["id", "source", "version", "args"] {
        let mut f = Fixture::new();
        match change {
            "id" => f.row.id = "custom-copilot".into(),
            "source" => f.row.source = "custom".into(),
            "version" => f.row.version = Some("1.0.90".into()),
            "args" => f.row.args.push("--other".into()),
            _ => unreachable!(),
        }
        f.denied();
    }
}

#[test]
fn copilot_rejects_wrong_package_platform_version_and_unbounded_manifests() {
    for (file, field, value) in [
        ("main", "name", json!("another-package")),
        ("main", "version", json!("1.0.90")),
        ("main", "bin", json!({"copilot":"other.js"})),
        (
            "main",
            "optionalDependencies",
            json!({(DECLARATION.platform_package):"1.0.90"}),
        ),
        ("platform", "name", json!("another-platform")),
        ("platform", "version", json!("1.0.90")),
        ("platform", "os", json!(["linux"])),
        (
            "platform",
            "cpu",
            json!([if cfg!(target_arch = "aarch64") {
                "x64"
            } else {
                "arm64"
            }]),
        ),
        ("platform", "exports", json!({".":"./other"})),
    ] {
        let f = Fixture::new();
        let path = if file == "main" {
            f.loader.with_file_name("package.json")
        } else {
            f.target.with_file_name("package.json")
        };
        let mut value0: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        value0[field] = value;
        std::fs::write(path, value0.to_string()).unwrap();
        f.denied();
    }
    let f = Fixture::new();
    let path = f.loader.with_file_name("package.json");
    let mut oversized: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    oversized["unusedPublicDescription"] = json!("x".repeat(1024 * 1024));
    std::fs::write(path, oversized.to_string()).unwrap();
    f.denied();
}

#[test]
fn copilot_rejects_nearer_packages() {
    for near in ["node_modules/@github/copilot", "node_modules/@github"] {
        let f = Fixture::new();
        let path = f
            .root
            .join(near)
            .join("node_modules")
            .join(DECLARATION.platform_package);
        std::fs::create_dir_all(&path).unwrap();
        f.denied();
    }
}

#[test]
#[cfg(unix)]
fn copilot_rejects_nearer_packages_even_when_their_symlink_is_broken() {
    for near in ["node_modules/@github/copilot", "node_modules/@github"] {
        let f = Fixture::new();
        let path = f
            .root
            .join(near)
            .join("node_modules")
            .join(DECLARATION.platform_package);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        symlink(f.root.join("missing"), &path).unwrap();
        f.denied();
    }
}

#[test]
#[cfg(unix)]
fn copilot_rejects_a_broken_scoped_directory_before_the_flat_platform_package() {
    for near in [
        "node_modules/@github/copilot/node_modules/@github",
        "node_modules/@github/node_modules/@github",
    ] {
        let f = Fixture::new();
        assert!(f.info(&f.row).methods[0].unavailable_reason.is_none());
        let path = f.root.join(near);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        symlink(f.root.join("missing-scope"), &path).unwrap();
        f.denied();
    }
}

#[test]
#[cfg(unix)]
fn copilot_rejects_redirected_loader_package_root_and_target() {
    for target in [
        "loader-inside",
        "loader-outside",
        "platform-outside",
        "main-package",
        "root",
    ] {
        let f = Fixture::new();
        let (path, destination) = match target {
            "loader-inside" => (f.loader.clone(), f.root.join("other/npm-loader.js")),
            "loader-outside" => (f.loader.clone(), f.data.join("other/npm-loader.js")),
            "platform-outside" => (f.target.clone(), f.data.join("other/copilot")),
            "main-package" => (
                f.loader.parent().unwrap().to_path_buf(),
                f.root.join("other-package"),
            ),
            "root" => (f.root.clone(), f.data.join("other-root")),
            _ => unreachable!(),
        };
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::rename(&path, &destination).unwrap();
        symlink(destination, path).unwrap();
        f.denied();
    }
}

#[test]
fn copilot_does_not_supplement_unknown_arguments_environment_or_other_types() {
    for change in [
        "method-id",
        "type",
        "invalid",
        "args",
        "method-env",
        "terminal-env",
        "relative-target",
        "other-target",
    ] {
        let mut f = Fixture::new();
        let method = &mut f.row.handshake.as_mut().unwrap()["authMethods"][0];
        match change {
            "method-id" => method["id"] = json!("different-login"),
            "type" => method["type"] = json!("agent"),
            "invalid" => method["_farfoldInvalid"] = json!(true),
            "args" => method["_meta"]["terminal-auth"]["args"] = json!(["auth", "login"]),
            "method-env" => method["env"] = json!({"FIXTURE":"sensitive-canary"}),
            "terminal-env" => {
                method["_meta"]["terminal-auth"]["env"] = json!({"FIXTURE":"sensitive-canary"})
            }
            "relative-target" => method["_meta"]["terminal-auth"]["command"] = json!("copilot"),
            "other-target" => method["_meta"]["terminal-auth"]["command"] = json!(f.row.command),
            _ => unreachable!(),
        }
        f.denied();
    }
}

#[test]
fn copilot_raw_nested_environment_cannot_disappear_before_route_verification() {
    for env in [
        json!({"FIXTURE":"sensitive-canary"}),
        json!(null),
        json!(["sensitive-canary"]),
    ] {
        let mut f = Fixture::new();
        let mut method = f.row.handshake.as_ref().unwrap()["authMethods"][0].clone();
        let valid_environment = env.is_object();
        method["_meta"]["terminal-auth"]["env"] = env;
        let captured = crate::acp_client::handshake::Handshake::decode(
            json!({"protocolVersion":1,"agentCapabilities":{},"authMethods":[method]}),
        )
        .unwrap();
        f.row.handshake = Some(captured.execution_json());
        let kept = &f.row.handshake.as_ref().unwrap()["authMethods"][0];
        if valid_environment {
            assert_eq!(
                kept["_meta"]["terminal-auth"]["env"],
                json!({"FIXTURE":"sensitive-canary"})
            );
            assert!(kept.get("_farfoldInvalid").is_none());
        } else {
            assert_eq!(kept["_farfoldInvalid"], true);
        }
        assert!(
            !captured
                .public_json()
                .to_string()
                .contains("sensitive-canary")
        );
        f.denied();
    }
}

#[test]
fn copilot_standard_terminal_keeps_literal_append_despite_invalid_old_metadata() {
    let mut f = Fixture::new();
    let mut method = f.row.handshake.as_ref().unwrap()["authMethods"][0].clone();
    method["type"] = json!("terminal");
    method["args"] = json!(["acp", "--auth-setup"]);
    method["env"] = json!({"FIXTURE_PUBLIC":"standard"});
    method["_meta"]["terminal-auth"]["env"] = json!({"UNTRUSTED":"sensitive-canary"});
    let captured = crate::acp_client::handshake::Handshake::decode(
        json!({"protocolVersion":1,"agentCapabilities":{},"authMethods":[method]}),
    )
    .unwrap();
    f.row.handshake = Some(captured.execution_json());
    let proof = crate::acp_client::auth_route::managed_terminal_proof(&f.row, &f.store, &f.data);
    let parsed = runnable_auth_method(&f.row, "copilot-login", &proof).unwrap();
    let invocation = derive_terminal_invocation(&f.row, &parsed).unwrap();
    assert_eq!(
        invocation.argv,
        vec![
            f.row.command,
            f.loader.display().to_string(),
            "--acp".into(),
            "acp".into(),
            "--auth-setup".into()
        ]
    );
    assert_eq!(
        invocation.env,
        vec![("FIXTURE_PUBLIC".into(), "standard".into())]
    );
    assert!(
        !captured
            .public_json()
            .to_string()
            .contains("sensitive-canary")
    );
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn copilot_actual_sdk_target_and_owned_pty_dispatch_share_the_current_proof() {
    use crate::acp_client::manager::AuthenticationOperation;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Owners {
        manager: Arc<AcpManager>,
        pty: PtyManager,
    }
    impl Drop for Owners {
        fn drop(&mut self) {
            self.pty.stop_for_shutdown();
            self.manager.stop_for_shutdown();
        }
    }
    let f = Fixture::new();
    let owners = Owners {
        manager: Arc::new(AcpManager::new(f.data.join("logs"), f.data.clone())),
        pty: PtyManager::new(),
    };
    owners
        .manager
        .connect(&f.row, &f.data, &f.store)
        .await
        .unwrap();
    let cached = f.store.get_agent(&f.row.id).unwrap().unwrap();
    let proof = crate::acp_client::auth_route::managed_terminal_proof(&cached, &f.store, &f.data);
    let info = methods_for_target(&owners.manager, &cached, Some(&f.data), None, &proof);
    assert_eq!(info.methods[0].kind, "terminal");
    assert!(info.methods[0].unavailable_reason.is_none());
    assert!(info.methods[0].terminal_command.is_none()); // Execution fields stay live only.
    let other = f.data.join("other-work");
    std::fs::create_dir(&other).unwrap();
    // Another directory only has the persisted display snapshot; the chosen
    // source still cannot expose existing-settings methods at all.
    let other_dir = methods_for_target(&owners.manager, &cached, Some(&other), None, &proof);
    assert!(!other_dir.execution_ready);
    assert!(other_dir.methods[0].unavailable_reason.is_none());
    assert!(
        methods_for_target(
            &owners.manager,
            &cached,
            Some(&f.data),
            Some("api-service"),
            &proof,
        )
        .methods
        .iter()
        .all(|m| m.unavailable_reason.is_some())
    );
    assert!(
        owners
            .manager
            .authenticate(
                &f.row.id,
                &f.data,
                "copilot-login",
                AuthenticationOperation::new(),
                Arc::new(|| {})
            )
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(f.loader.with_file_name("protocol-observed")).unwrap(),
        "initialize\n"
    );
    let live = live_auth_row(&owners.manager, &cached, &f.data).unwrap();
    let attempts_environment = AtomicUsize::new(0);
    let run = |proof: &ManagedTerminalProof, owner| -> Result<String, String> {
        let method = runnable_auth_method(&live, "copilot-login", proof)?;
        let invocation = derive_terminal_invocation(&live, &method)?;
        let (command, args) = invocation.argv.split_first().unwrap();
        terminal::run(&owners.pty, command, args, &f.data, owner, || {
            attempts_environment.fetch_add(1, Ordering::SeqCst);
            Ok(vec![])
        })
    };
    let attempt = attempts::reserve(&f.row.id, "copilot-owned-pty").unwrap();
    let configuration = attempt.configuration_guard(&f.store).await.unwrap();
    let id = run(
        &proof,
        terminal::Ownership {
            output: Channel::new(|_| Ok(())),
            configuration,
            scope: owners.manager.reserve_account_change(&f.row.id).unwrap(),
            attempt,
        },
    )
    .unwrap();
    assert_eq!(owners.pty.await_exit(&id).unwrap(), 0);
    assert_eq!(
        std::fs::read_to_string(f.loader.with_file_name("login-observed")).unwrap(),
        "[\"login\"]"
    );
    assert_eq!(attempts_environment.load(Ordering::SeqCst), 1);
    // A prior query is not authorization after its receipt is removed.
    f.receipts(|items| *items = json!([]));
    let fresh = crate::acp_client::auth_route::managed_terminal_proof(&live, &f.store, &f.data);
    let attempt = attempts::reserve(&f.row.id, "copilot-denied-pty").unwrap();
    let configuration = attempt.configuration_guard(&f.store).await.unwrap();
    let denied = run(
        &fresh,
        terminal::Ownership {
            output: Channel::new(|_| Ok(())),
            configuration,
            scope: owners.manager.reserve_account_change(&f.row.id).unwrap(),
            attempt,
        },
    );
    assert!(denied.is_err());
    assert_eq!(
        attempts_environment.load(Ordering::SeqCst),
        1,
        "denial precedes environment delivery"
    );
    assert_eq!(
        std::fs::read_to_string(f.loader.with_file_name("protocol-observed")).unwrap(),
        "initialize\n"
    );
    owners.manager.disconnect(&f.row.id, &f.data).await.unwrap();
    let disconnected = methods_for_target(&owners.manager, &cached, Some(&f.data), None, &proof);
    assert!(!disconnected.execution_ready);
    assert!(disconnected.methods[0].unavailable_reason.is_none());
}

#[test]
fn copilot_encoded_root_keeps_the_same_exact_loader_proof() {
    let f = Fixture::with_layout(true, "1.0.89");
    let info = f.info(&f.row);
    assert!(info.methods[0].unavailable_reason.is_none());
    assert_eq!(
        info.methods[0].terminal_command,
        Some(vec![
            f.row.command.clone(),
            f.loader.display().to_string(),
            "login".into()
        ])
    );
    f.receipts(|items| items[0]["programOnly"] = json!(true));
    f.denied();
}

#[test]
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn copilot_updated_macos_package_offers_login_only_for_the_matching_native_version() {
    let f = Fixture::with_layout(true, "1.0.112");
    let info = f.info(&f.row);
    assert!(info.methods[0].unavailable_reason.is_none());
    assert_eq!(
        info.methods[0].terminal_command,
        Some(vec![
            f.row.command.clone(),
            f.loader.display().to_string(),
            "login".into()
        ])
    );

    let path = f.target.with_file_name("package.json");
    let mut native: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    native["version"] = json!("1.0.89");
    std::fs::write(path, native.to_string()).unwrap();
    f.denied();
}
