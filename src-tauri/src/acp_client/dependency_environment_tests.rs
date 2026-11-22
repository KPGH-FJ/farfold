//! The real manager boundary with a controlled ACP process, no Agent/account.
#![cfg(unix)]
use super::*;
use crate::acp_client::service_connection::{PreparedService, ServiceContext};
use std::os::unix::fs::PermissionsExt;

fn fixture_diagnostic(cwd: &std::path::Path) -> serde_json::Value {
    let value = std::fs::read(cwd.join("fixture-diagnostic.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let Some(value) = value else {
        return serde_json::json!({"stage":"diagnostic_missing"});
    };
    // Print only the fixture's fixed diagnostic fields, never observed.json,
    // inherited environment, command arguments or exception message/traceback.
    serde_json::json!({
        "stage": value["stage"],
        "exceptionType": value["exceptionType"],
        "timedOut": value["timedOut"],
        "timeoutSeconds": value["timeoutSeconds"],
        "source": value["source"],
        "helperPid": value["helperPid"],
        "childPid": value["childPid"],
        "elapsedMs": value["elapsedMs"],
        "spawnElapsedMs": value["spawnElapsedMs"],
        "communicateElapsedMs": value["communicateElapsedMs"],
        "returncode": value["returncode"],
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn manager_final_environment_handles_prepared_and_existing_sources_without_persisting_it() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("Application Support");
    std::fs::create_dir(&data).unwrap();
    let data = data.canonicalize().unwrap();
    let mut row = crate::acp_client::recipes::tests::official_row(
        &data,
        "registry:autohand",
        "@autohandai/autohand-acp",
        "0.2.1",
    );
    let package = data.join("node_modules/@autohandai/autohand-acp");
    std::fs::write(package.join("package.json"), r#"{"name":"@autohandai/autohand-acp","version":"0.2.1","bin":{"autohand-acp":"dist/index.js"}}"#).unwrap();
    let node = data.join("node");
    std::fs::write(&node, r#"#!/usr/bin/python3
import sys,json,os,subprocess,time
stage='start'
started=time.monotonic_ns()
child_pid=spawn_elapsed=communicate_elapsed=returncode=None
source='prepared' if os.path.basename(os.getcwd())=='selected-source' else 'existing'
def diagnose(error=None):
 timed_out=isinstance(error,subprocess.TimeoutExpired)
 with open('fixture-diagnostic.tmp','w') as f:
  json.dump({'stage':stage,'exceptionType':type(error).__name__ if error else None,'timedOut':timed_out,'timeoutSeconds':error.timeout if timed_out else None,'source':source,'helperPid':os.getpid(),'childPid':child_pid,'elapsedMs':(time.monotonic_ns()-started)/1000000,'spawnElapsedMs':spawn_elapsed,'communicateElapsedMs':communicate_elapsed,'returncode':returncode},f)
 os.replace('fixture-diagnostic.tmp','fixture-diagnostic.json')
try:
 diagnose()
 for line in sys.stdin:
  stage='decode_request'
  m=json.loads(line)
  if m.get('method')=='initialize':
   stage='read_command'
   command=os.environ['AUTOHAND_CMD']
   stage='probe_spawn_started'
   diagnose()
   # This tests actual environment delivery, not a separate version-probe SLO.
   # The outer 10-second deadline and exact process-group cleanup own this child.
   # Preserve run()'s Popen/communicate/exception cleanup, recording only fixed
   # diagnostics. A last-written stage is not a blocked-syscall diagnosis.
   spawn_started=time.monotonic_ns()
   with subprocess.Popen([command,'--version'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) as probe:
    try:
     child_pid=probe.pid
     spawn_elapsed=(time.monotonic_ns()-spawn_started)/1000000
     stage='probe_spawn_returned'
     diagnose()
     stage='probe_communicate_started'
     diagnose()
     communicate_started=time.monotonic_ns()
     output,_=probe.communicate()
     communicate_elapsed=(time.monotonic_ns()-communicate_started)/1000000
     returncode=probe.returncode
     stage='probe_communicate_returned'
     diagnose()
    except BaseException:
     probe.kill()
     raise
   stage='prepare_observation'
   observed={'command':command,'path':os.environ['PATH'],'marker':os.environ['PUBLIC_MARKER'],'exit':returncode,'output':output}
   stage='write_observation'
   with open('observed.json','w') as f:
    json.dump(observed,f)
   stage='send_initialize_response'
   print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':{'protocolVersion':1,'agentCapabilities':{},'authMethods':[],'agentInfo':{'name':'controlled','version':'0.2.1'}}}),flush=True)
   stage='initialize_response_sent'
   diagnose()
 stage='stdin_closed'
 diagnose()
except Exception as error:
 diagnose(error)
 sys.exit(1)
"#).unwrap();
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
    row.command = node.display().to_string();
    let selected =
        crate::managed_programs::parent(&data, &row.id).join("dependency-test/launch-program");
    std::fs::create_dir_all(selected.parent().unwrap()).unwrap();
    std::fs::write(&selected, "#!/bin/sh\nprintf '0.9.8\\n'\n").unwrap();
    std::fs::set_permissions(&selected, std::fs::Permissions::from_mode(0o755)).unwrap();
    row.env = vec![
        ("AUTOHAND_CMD".into(), selected.display().to_string()),
        ("PATH".into(), "/row/path:/usr/bin:/bin".into()),
        ("PUBLIC_MARKER".into(), "controlled".into()),
    ];
    let store = crate::meta_store::MetaStore::open(&data.join("meta.db")).unwrap();
    store.insert_agent(&row).unwrap();
    let manager = crate::acp_client::manager::AcpManager::new(data.join("logs"), data.clone());
    for prepared in [false, true] {
        let cwd = data.join(if prepared {
            "selected-source"
        } else {
            "existing-source"
        });
        std::fs::create_dir(&cwd).unwrap();
        let previous_path = if prepared {
            "/prepared/path:/usr/bin:/bin"
        } else {
            "/row/path:/usr/bin:/bin"
        };
        let environment = HashMap::from([
            ("AUTOHAND_CMD".into(), selected.display().to_string()),
            ("PATH".into(), previous_path.into()),
            ("PUBLIC_MARKER".into(), "controlled".into()),
        ]);
        let service = prepared.then_some(PreparedService {
            delivery: None,
            relay: None,
            environment,
            context: ServiceContext {
                identity: crate::credentials::ServiceIdentity {
                    id: "controlled".into(),
                    fingerprint: "controlled".into(),
                    model: "kept-model".into(),
                },
                revision: "controlled".into(),
                model_id: "kept-model".into(),
            },
        });
        let status = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            manager.connect_launch(&row, &cwd, &store, false, service),
        )
        .await;
        // Capture the last fixed fixture observation before cleanup can change
        // it. Neither this snapshot nor its stage identifies a blocked syscall.
        let before_cleanup = fixture_diagnostic(&cwd);
        let cleanup = manager.disconnect(&row.id, &cwd).await;
        let connection_outcome = match &status {
            Ok(Ok(status)) => status.state.as_str(),
            Ok(Err(_)) => "error",
            Err(_) => "deadline",
        };
        cleanup.unwrap_or_else(|error| {
            panic!(
                "cleanup failed: {error}; connect={connection_outcome}; fixtureBeforeCleanup={before_cleanup}; fixtureAfterCleanup={}",
                fixture_diagnostic(&cwd)
            )
        });
        let status = status
            .unwrap_or_else(|error| {
                panic!(
                    "connect deadline: {error}; fixtureBeforeCleanup={before_cleanup}; fixtureAfterCleanup={}",
                    fixture_diagnostic(&cwd)
                )
            })
            .unwrap_or_else(|error| {
                panic!(
                    "connect failed: {error}; fixtureBeforeCleanup={before_cleanup}; fixtureAfterCleanup={}",
                    fixture_diagnostic(&cwd)
                )
            });
        assert_eq!(
            status.state,
            "ready",
            "fixture={}",
            fixture_diagnostic(&cwd)
        );
        let observed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(cwd.join("observed.json")).unwrap()).unwrap();
        assert_eq!(observed["command"], "launch-program");
        assert_eq!(
            observed["path"],
            format!("{}:{previous_path}", selected.parent().unwrap().display())
        );
        assert_eq!(observed["marker"], "controlled");
        assert_eq!(observed["exit"], 0);
        assert_eq!(observed["output"], "0.9.8\n");
        let mut stored = store.get_agent(&row.id).unwrap().unwrap();
        // initialize legitimately refreshes its handshake and observation time;
        // launch settings, including the selected absolute path, stay intact.
        assert!(stored.handshake.is_some());
        stored.handshake = row.handshake.clone();
        stored.updated_at = row.updated_at;
        assert_eq!(stored, row);
    }
}
