//! Existing manager/open/router with an isolated ACP peer and same-install
//! synthetic CLI. This proves product wiring, not an official Agent run.
use super::*;
use crate::{
    acp_client::{manager::AcpManager, pump::SessionSink},
    meta_store::MetaStore,
};
use std::sync::{Arc, Mutex};
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
async fn scenario(receipt: bool) {
    let f = launch_tests::Fixture::new();
    let mut records = tests::records();
    for i in [0, 3] {
        records[i]["payload"]["cwd"] = f.root.to_string_lossy().as_ref().into();
    }
    let trace =
        serde_json::to_string(&String::from_utf8(tests::encode(&records)).unwrap()).unwrap();
    let driver = format!(
        r#"import json,sys,pathlib
if pathlib.Path(sys.argv[1]).name=='fast-agent':
 pathlib.Path(sys.argv[-1]).write_text({trace})
 pathlib.Path('export-called').write_text('once')
 sys.exit(0)
def send(x): print(json.dumps(x,separators=(',',':')),flush=True)
for line in sys.stdin:
 m=json.loads(line);method=m.get('method');p=m.get('params',{{}})
 if method=='initialize':
  r={{'protocolVersion':1,'agentInfo':{{'name':'controlled-supplement-peer','version':'unrestricted'}},'agentCapabilities':{{'loadSession':True}},'authMethods':[]}}
 elif method=='session/load':
  for kind,text in [('user_message_chunk','Read this public page.'),('agent_message_chunk','The public page is shown.')]:
   send({{'jsonrpc':'2.0','method':'session/update','params':{{'sessionId':p['sessionId'],'update':{{'sessionUpdate':kind,'content':{{'type':'text','text':text}}}}}}}})
  r={{'modes':{{'currentModeId':'agent','availableModes':[{{'id':'agent','name':'Agent'}}]}}}}
 elif method=='session/close': r={{}}
 else:
  if 'id' in m: send({{'jsonrpc':'2.0','id':m['id'],'error':{{'code':-32601,'message':'unsupported'}}}})
  continue
 send({{'jsonrpc':'2.0','id':m['id'],'result':r}})
"#
    );
    std::fs::write(f.root.join("wire.py"), driver).unwrap();
    std::fs::write(
        f.root.join("venv/bin/python"),
        format!(
            "#!/bin/sh\nexec {} {} \"$@\"\n",
            quote(&crate::platform_tests::python()),
            quote(f.root.join("wire.py").to_str().unwrap())
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&f.row.command, std::fs::Permissions::from_mode(0o755)).unwrap();
    let store = MetaStore::open(&f.root.join("meta.db")).unwrap();
    store.insert_agent(&f.row).unwrap();
    if receipt {
        store
            .set_setting("installations.v1", &serde_json::json!([f.receipt]))
            .unwrap();
    }
    let manager = AcpManager::new(f.root.join("logs"), f.root.clone());
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let sink: SessionSink = Arc::new(move |v| captured.lock().unwrap().push(v));
    let history = manager
        .admit_cold_history_for_test(&f.row, &f.root, "owned-session", &[], &store, None)
        .await
        .unwrap();
    let opened = manager
        .open_session_admitted_with_mcp(
            &f.row,
            &f.root,
            Some("owned-session".into()),
            vec![],
            sink,
            &store,
            None,
            None,
            None,
            Some(history),
            Some("exact-open".into()),
            None,
        )
        .await
        .unwrap();
    let values = events.lock().unwrap();
    let raw: Vec<_> = values
        .iter()
        .filter(|v| v.get("update").is_some())
        .collect();
    assert_eq!(raw.len(), 2);
    assert_eq!(
        raw[0]["update"]["content"]["text"],
        "Read this public page."
    );
    let supplement: Vec<_> = values
        .iter()
        .filter(|v| {
            v["kind"] == "historyToolSupplement" || v["kind"] == "historyToolSupplementStatus"
        })
        .collect();
    assert_eq!(supplement.len(), 1);
    let event = supplement[0];
    assert_eq!(event["connectionId"], opened.connection_id);
    assert_eq!(event["openToken"], "exact-open");
    assert_eq!(event["sessionId"], "owned-session");
    if receipt {
        assert_eq!(event["kind"], "historyToolSupplement");
        assert_eq!(event["tools"].as_array().unwrap().len(), 1);
        assert!(f.root.join("export-called").exists());
    } else {
        assert_eq!(event["kind"], "historyToolSupplementStatus");
        assert_eq!(event["reason"], "unavailable");
        assert!(!f.root.join("export-called").exists());
    }
    assert!(
        store.list_sessions().unwrap().is_empty(),
        "supplement never persists transcript or creates an index"
    );
    drop(values);
    manager.disconnect(&f.row.id, &f.root).await.unwrap();
}
#[tokio::test(flavor = "multi_thread")]
async fn history_supplement_real_open_keeps_original_prefix_and_exact_operation_owner() {
    scenario(true).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn history_supplement_unverified_entry_keeps_successful_acp_body_without_executing_companion()
{
    scenario(false).await;
}
