//! Controlled public declarations over the actual SDK/manager transport. No
//! official Agent, account, credential lookup, prompt or user file is involved.
use super::*;
use crate::acp_client::manager::{AuthenticationOperation, ConnectionPurpose};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

const PEER: &str = r#"
import json,sys,os
from pathlib import Path
calls=Path(sys.argv[1])
def reply(m,result): print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 with calls.open('a') as f: f.write(str(method)+'\n')
 if method=='initialize':
  suffix=Path.cwd().name
  reply(m,{'protocolVersion':1,'agentInfo':{'name':'controlled-auth','version':'1'},'agentCapabilities':{},'authMethods':[
   {'id':'environment-'+suffix,'name':'Environment','type':'env_var','vars':[{'name':'FIXTURE_KEY','value':'fixture-sensitive-canary'}],'_meta':{'extra':'fixture-sensitive-canary'}},
   {'id':'future','name':'Future','type':'future-login','secret':'fixture-sensitive-canary'},
   {'id':'default','name':'Default'},
   {'id':'terminal','name':'Terminal','type':'terminal','args':['acp','--auth-setup'],'env':{'PRIVATE':'fixture-sensitive-canary'}},
   {'id':'unresolved','name':'Unresolved','env':{'PRIVATE':'fixture-sensitive-canary'},'_meta':{'terminal-auth':{'command':'/fixture-sensitive-canary/unresolved','args':['fixture-sensitive-canary']}}},
   {'id':'legacy-env','name':'Declared terminal','_meta':{'terminal-auth':{'command':sys.argv[2],'args':[sys.argv[0],'login'],'env':{'PRIVATE':'fixture-sensitive-canary','PUBLIC_MODE':'terminal'}}}}
  ]})
 elif method=='authenticate': reply(m,{})
 else: reply(m,{})
"#;

struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    a: PathBuf,
    b: PathBuf,
    calls: PathBuf,
    row: AgentRow,
    store: MetaStore,
    manager: Arc<AcpManager>,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let a = base.join("a");
        let b = base.join("b");
        let data = base.join("data");
        for path in [&a, &b, &data] {
            std::fs::create_dir(path).unwrap();
        }
        let peer = base.join("peer.py");
        std::fs::write(&peer, PEER).unwrap();
        let calls = base.join("calls");
        let selected_python = crate::platform_tests::python();
        let row = AgentRow {
            id: "public-declaration-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: selected_python.clone(),
            args: vec![
                "-u".into(),
                peer.display().to_string(),
                calls.display().to_string(),
                selected_python,
            ],
            env: vec![],
            version: None,
            handshake: Some(json!({"authMethods":[{"id":"old-key","name":"Old Key"}]})),
            created_at: 0,
            updated_at: 0,
        };
        let store = MetaStore::open(&base.join("meta.db")).unwrap();
        store.insert_agent(&row).unwrap();
        let manager = Arc::new(AcpManager::new(base.join("logs"), data));
        Self {
            _root: root,
            root: base,
            a,
            b,
            calls,
            row,
            store,
            manager,
        }
    }
    fn row(&self) -> AgentRow {
        self.store.get_agent(&self.row.id).unwrap().unwrap()
    }
    fn info(&self, cwd: &Path, source: Option<&str>) -> AuthMethodsResponse {
        methods_for_target(
            &self.manager,
            &self.row(),
            Some(cwd),
            source,
            &ManagedTerminalProof::default(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

fn no_secret_files(path: &Path) {
    if !path.exists() {
        return;
    }
    for entry in std::fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            no_secret_files(&path);
        } else {
            assert!(
                !std::fs::read_to_string(path)
                    .unwrap_or_default()
                    .contains("fixture-sensitive-canary")
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_declaration_transport_preserves_types_and_only_uses_the_exact_live_target() {
    let f = Fixture::new();
    let old = f.info(&f.a, None);
    assert_eq!(old.methods[0].kind, "unsupported");
    assert!(old.methods[0].unavailable_reason.is_some());
    assert!(live_auth_row(&f.manager, &f.row(), &f.a).is_err());
    f.manager.connect(&f.row, &f.a, &f.store).await.unwrap();
    let public = f.row().handshake.unwrap();
    assert_eq!(public["authMethods"][0]["type"], "env_var");
    assert!(!public.to_string().contains("fixture-sensitive-canary"));
    let info = f.info(&f.a, None);
    assert_eq!(
        info.methods[0].env_names.as_ref().unwrap(),
        &["FIXTURE_KEY"]
    );
    assert_eq!(info.methods[0].kind, "environment");
    assert_eq!(info.methods[1].kind, "unsupported");
    assert!(info.methods[2].unavailable_reason.is_none());
    assert_eq!(info.methods[3].kind, "terminal");
    assert!(info.methods[3].terminal_command.is_none());
    assert!(
        !serde_json::to_string(&info)
            .unwrap()
            .contains("fixture-sensitive-canary")
    );
    for id in ["environment-a", "future", "terminal"] {
        assert!(
            f.manager
                .authenticate(
                    &f.row.id,
                    &f.a,
                    id,
                    AuthenticationOperation::new(),
                    Arc::new(|| {})
                )
                .await
                .is_err()
        );
    }
    assert_eq!(std::fs::read_to_string(&f.calls).unwrap(), "initialize\n");
    // Another project directory has no live or borrowed declaration; the
    // persisted snapshot is display-only and stays executable-looking.
    let cached_b = f.info(&f.b, None);
    assert!(!cached_b.execution_ready);
    assert!(!cached_b.can_logout);
    assert!(cached_b.methods[2].unavailable_reason.is_none());
    assert!(
        f.info(&f.a, Some("chosen-service"))
            .methods
            .iter()
            .all(|m| m.unavailable_reason.is_some())
    );
    f.manager.connect(&f.row(), &f.b, &f.store).await.unwrap();
    assert_eq!(f.info(&f.a, None).methods[0].id, "environment-a");
    assert_eq!(f.info(&f.b, None).methods[0].id, "environment-b");
    f.manager
        .authenticate(
            &f.row.id,
            &f.a,
            "default",
            AuthenticationOperation::new(),
            Arc::new(|| {}),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&f.calls).unwrap(),
        "initialize\ninitialize\nauthenticate\n"
    );
    let live = live_auth_row(&f.manager, &f.row(), &f.a).unwrap();
    let method = parse_auth_methods(&live)
        .into_iter()
        .find(|m| m.id == "terminal")
        .unwrap();
    let invocation = derive_terminal_invocation(&live, &method).unwrap();
    let mut expected = vec![f.row.command.clone()];
    expected.extend(f.row.args.clone());
    expected.extend(["acp".into(), "--auth-setup".into()]);
    assert_eq!(invocation.argv, expected); // Literal append; no deduplication.
    assert_eq!(
        invocation.env,
        [("PRIVATE".into(), "fixture-sensitive-canary".into())]
    );
    f.manager.disconnect(&f.row.id, &f.a).await.unwrap();
    assert!(live_auth_row(&f.manager, &f.row(), &f.a).is_err());
    let disconnected_a = f.info(&f.a, None);
    assert!(!disconnected_a.execution_ready);
    assert!(
        disconnected_a
            .methods
            .iter()
            .any(|m| m.unavailable_reason.is_none())
    );
    assert!(f.info(&f.b, None).methods[2].unavailable_reason.is_none());
    f.manager.disconnect(&f.row.id, &f.b).await.unwrap();
    no_secret_files(&f.root.join("logs"));
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_declaration_candidate_check_does_not_replace_registered_handshake() {
    let f = Fixture::new();
    let before = f.row();
    f.manager
        .probe_launch(&f.row, &f.store, std::future::pending())
        .await
        .unwrap();
    assert_eq!(f.row(), before);
    assert!(f.manager.status(&f.row.id).unwrap().is_empty());
    assert!(!f.manager.candidate_pending(&f.row.id).unwrap());
    assert_eq!(std::fs::read_to_string(&f.calls).unwrap(), "initialize\n");
    no_secret_files(&f.root.join("logs"));
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_terminal_environment_actual_sdk_is_live_target_only_and_never_authenticate() {
    let mut f = Fixture::new();
    f.row.args.remove(0); // The selected script is the first interpreter argument.
    f.store.replace_agent_launch(&f.row).unwrap();
    f.manager.connect(&f.row, &f.a, &f.store).await.unwrap();
    let info = f.info(&f.a, None);
    let method = info
        .methods
        .iter()
        .find(|method| method.id == "legacy-env")
        .unwrap();
    assert_eq!(method.kind, "terminal");
    assert!(method.unavailable_reason.is_none());
    assert!(method.terminal_command.is_none());
    assert!(
        !serde_json::to_string(&info)
            .unwrap()
            .contains("fixture-sensitive-canary")
    );
    let live = live_auth_row(&f.manager, &f.row(), &f.a).unwrap();
    let method =
        runnable_auth_method(&live, "legacy-env", &ManagedTerminalProof::default()).unwrap();
    let invocation = derive_terminal_invocation(&live, &method).unwrap();
    assert_eq!(
        invocation.argv,
        vec![f.row.command.clone(), f.row.args[0].clone(), "login".into()]
    );
    assert_eq!(
        invocation.env,
        vec![
            ("PRIVATE".into(), "fixture-sensitive-canary".into()),
            ("PUBLIC_MODE".into(), "terminal".into())
        ]
    );
    assert!(
        f.manager
            .authenticate(
                &f.row.id,
                &f.a,
                "legacy-env",
                AuthenticationOperation::new(),
                Arc::new(|| {})
            )
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_to_string(&f.calls).unwrap(), "initialize\n");
    assert!(
        !f.row()
            .handshake
            .unwrap()
            .to_string()
            .contains("fixture-sensitive-canary")
    );
    let other_dir = f.info(&f.b, None);
    assert!(!other_dir.execution_ready);
    assert!(
        other_dir
            .methods
            .iter()
            .any(|method| method.unavailable_reason.is_none())
    );
    assert!(
        f.info(&f.a, Some("chosen-service"))
            .methods
            .iter()
            .all(|method| method.unavailable_reason.is_some())
    );
    f.manager.disconnect(&f.row.id, &f.a).await.unwrap();
    let disconnected = f.info(&f.a, None);
    assert!(!disconnected.execution_ready);
    assert!(
        disconnected
            .methods
            .iter()
            .any(|method| method.unavailable_reason.is_none())
    );
    no_secret_files(&f.root.join("logs"));
}

#[tokio::test(flavor = "multi_thread")]
async fn conversation_declaration_is_borrowed_for_display_and_never_executed() {
    let f = Fixture::new();
    // A ready conversation connection in the same project lends its
    // declaration for read-only display; it is not an execution source.
    let (conversation, _) = f
        .manager
        .connect_selected(&f.row, &f.a, &f.store, None, None, true)
        .await
        .unwrap();
    assert_eq!(conversation.purpose, ConnectionPurpose::Conversation);
    assert!(live_auth_row(&f.manager, &f.row(), &f.a).is_err());
    let borrowed = f.info(&f.a, None);
    assert!(!borrowed.execution_ready);
    assert_eq!(borrowed.methods[0].id, "environment-a");
    assert!(borrowed.methods[2].unavailable_reason.is_none());
    assert_eq!(borrowed.methods[2].id, "default");
    assert!(
        f.manager
            .authenticate(
                &f.row.id,
                &f.a,
                "default",
                AuthenticationOperation::new(),
                Arc::new(|| {})
            )
            .await
            .is_err()
    );
    // agent_connect's preparation key does not collide with the live
    // conversation connection: a second process starts.
    let preparation = f.manager.connect(&f.row, &f.a, &f.store).await.unwrap();
    assert_eq!(preparation.purpose, ConnectionPurpose::Preparation);
    assert_eq!(
        std::fs::read_to_string(&f.calls).unwrap(),
        "initialize\ninitialize\n"
    );
    assert_eq!(f.manager.status(&f.row.id).unwrap().len(), 2);
    let live = f.info(&f.a, None);
    assert!(live.execution_ready);
    f.manager.disconnect(&f.row.id, &f.a).await.unwrap();
    no_secret_files(&f.root.join("logs"));
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_route_diagnostics_live_reason_cannot_authorize_cached_or_other_targets() {
    let f = Fixture::new();
    f.manager.connect(&f.row, &f.a, &f.store).await.unwrap();
    let info = f.info(&f.a, None);
    let unavailable = info.methods.iter().find(|m| m.id == "unresolved").unwrap();
    assert_eq!(
        unavailable.unavailable_reason.as_deref(),
        Some("无法确认此登录方式的程序路径，请检查程序或在更多登录方式中明确配置")
    );
    assert!(unavailable.terminal_command.is_none());
    assert!(
        !serde_json::to_string(&info)
            .unwrap()
            .contains("fixture-sensitive-canary")
    );
    // Neither another directory nor a missing target yields an executable
    // declaration; display still comes from the persisted public snapshot.
    for info in [
        f.info(&f.b, None),
        methods_for_target(
            &f.manager,
            &f.row(),
            None,
            None,
            &ManagedTerminalProof::default(),
        ),
    ] {
        assert!(!info.can_logout);
        assert!(!info.execution_ready);
        let method = info.methods.iter().find(|m| m.id == "default").unwrap();
        assert!(method.unavailable_reason.is_none());
    }
    let other_source = f.info(&f.a, Some("chosen-service"));
    assert!(!other_source.can_logout);
    assert!(
        other_source.methods.iter().all(|m| m.unavailable_reason
            == attempts::require_existing_source(Some("chosen-service")).err())
    );
    assert!(
        f.manager
            .authenticate(
                &f.row.id,
                &f.a,
                "unresolved",
                AuthenticationOperation::new(),
                Arc::new(|| {})
            )
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_to_string(&f.calls).unwrap(), "initialize\n");
    f.manager.disconnect(&f.row.id, &f.a).await.unwrap();
    let cached = f.info(&f.a, None);
    assert!(!cached.execution_ready);
    let method = cached.methods.iter().find(|m| m.id == "default").unwrap();
    assert!(method.unavailable_reason.is_none());
    assert!(
        !serde_json::to_string(&cached)
            .unwrap()
            .contains("fixture-sensitive-canary")
    );
    no_secret_files(&f.root.join("logs"));
}
