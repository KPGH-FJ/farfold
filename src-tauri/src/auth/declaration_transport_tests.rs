//! Controlled public declarations over the actual SDK/manager transport. No
//! official Agent, account, credential lookup, prompt or user file is involved.
use super::*;
use crate::acp_client::manager::AuthenticationOperation;
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
   {'id':'terminal','name':'Terminal','type':'terminal','args':['acp','--auth-setup'],'env':{'PRIVATE':'fixture-sensitive-canary'}}
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
        let row = AgentRow {
            id: "public-declaration-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: "/usr/bin/python3".into(),
            args: vec![
                "-u".into(),
                peer.display().to_string(),
                calls.display().to_string(),
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
        methods_for_target(&self.manager, &self.row(), Some(cwd), source, false)
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
    assert!(
        f.info(&f.b, None)
            .methods
            .iter()
            .all(|m| m.unavailable_reason.is_some())
    );
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
    assert!(
        f.info(&f.a, None)
            .methods
            .iter()
            .all(|m| m.unavailable_reason.is_some())
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
