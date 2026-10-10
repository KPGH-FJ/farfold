//! Actual own stdio peers and lifecycle admission, never an installed Agent.
use super::*;
use crate::acp_client::manager::AcpManager;
use crate::meta_store::AgentRow;
use std::{path::PathBuf, process::Command, sync::atomic::Ordering};

const ID: &str = "02000000-0000-4000-8000-000000000001";
const ACP: &str = r#"
import sys,json
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='initialize':
  print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]}}),flush=True)
 elif m.get('method')=='session/new':
  print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':{'sessionId':'fixture','configOptions':[]}}),flush=True)
"#;
struct Fixture {
    _root: tempfile::TempDir,
    path: PathBuf,
    manager: Arc<AcpManager>,
    store: MetaStore,
    row: AgentRow,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().canonicalize().unwrap();
        let script = path.join("peer.py");
        std::fs::write(&script, ACP).unwrap();
        let store = MetaStore::open(&path.join("metadata.db")).unwrap();
        let row = AgentRow {
            id: format!(
                "skills-fixture-{}",
                path.file_name().unwrap().to_str().unwrap()
            ),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec!["-u".into(), script.to_str().unwrap().into()],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let manager = Arc::new(AcpManager::new(path.join("logs"), path.clone()));
        Self {
            _root: root,
            path,
            manager,
            store,
            row,
        }
    }
    async fn connect(&self) {
        self.manager
            .connect(&self.row, &self.path, &self.store)
            .await
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(4), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread")]
async fn skills_admission_rejects_busy_unsettled_and_candidate_connections() {
    let f = Fixture::new();
    f.connect().await;
    let connection = f.manager.live_connection(&f.row.id, &f.path).unwrap();
    let work = connection.life.work().unwrap();
    assert!(matches!(
        skills_scope(&f.manager, &f.row),
        Err(Failure { code: Code::Busy })
    ));
    drop(work);
    let unsettled = connection
        .life
        .operation("controlled_unknown_operation".into())
        .unwrap();
    assert!(matches!(
        skills_scope(&f.manager, &f.row),
        Err(Failure { code: Code::Busy })
    ));
    drop(unsettled);
    assert!(skills_scope(&f.manager, &f.row).is_ok());
    f.manager
        .connect_launch(&f.row, &f.path, &f.store, true, None)
        .await
        .unwrap();
    assert!(f.manager.candidate_pending(&f.row.id).unwrap());
    assert!(matches!(
        skills_scope(&f.manager, &f.row),
        Err(Failure { code: Code::Busy })
    ));
}
#[tokio::test(flavor = "multi_thread")]
async fn idle_scope_blocks_known_alias_work_and_connect_but_not_unrelated_entry() {
    let f = Fixture::new();
    f.connect().await;
    let connection = f.manager.live_connection(&f.row.id, &f.path).unwrap();
    let pid = connection.child_pid.load(Ordering::SeqCst);
    let scope = skills_scope(&f.manager, &f.row).unwrap();
    assert!(connection.life.work().is_err());
    let mut alias = f.row.clone();
    alias.id.push_str("-alias");
    f.store.insert_agent(&alias).unwrap();
    assert!(f.manager.connect(&alias, &f.path, &f.store).await.is_err());
    assert_eq!(connection.child_pid.load(Ordering::SeqCst), pid);
    assert_eq!(crate::platform_tests::process_check(pid as i32), 0);
    let other_script = f.path.join("other.py");
    std::fs::write(&other_script, ACP).unwrap();
    alias.id.push_str("-other");
    alias.args[1] = other_script.to_str().unwrap().into();
    f.store.insert_agent(&alias).unwrap();
    f.manager.connect(&alias, &f.path, &f.store).await.unwrap();
    assert!(
        f.manager
            .live_connection(&alias.id, &f.path)
            .unwrap()
            .life
            .work()
            .is_ok()
    );
    drop(scope);
    assert!(connection.life.work().is_ok());
}
#[tokio::test(flavor = "multi_thread")]
async fn dropping_skills_observer_keeps_scope_and_activity_until_real_child_cleanup() {
    let f = Fixture::new();
    f.connect().await;
    let scope = skills_scope(&f.manager, &f.row).unwrap();
    let connection = f.manager.live_connection(&f.row.id, &f.path).unwrap();
    let gate = crate::managed_update::UpdateAdmission::default();
    let activity = gate.activity().unwrap();
    let registry = requests::Requests::default();
    let (request, _) = registry
        .begin(&f.row.id, "/tmp", ID, ID, Kind::Skills)
        .unwrap();
    let marker = f.path.join("skills-started");
    let owned_marker = marker.clone();
    let owned = request.clone();
    let worker = tokio::task::spawn_blocking(move || {
        let scope = scope;
        let activity = activity;
        let mut command = Command::new(crate::platform_tests::python());
        command.args(["-u","-c","import sys,os,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);sys.stdin.readline();open(sys.argv[1],'w').write(str(os.getpid()));time.sleep(30)"]).arg(owned_marker);
        let result = process::run_skills(command, &owned);
        drop(scope);
        drop(activity);
        owned.finish(result.map(InventorySnapshot::Skills));
    });
    let observer = tokio::spawn(wait_for_result(request.clone()));
    until(|| marker.is_file()).await;
    let pid = std::fs::read_to_string(marker)
        .unwrap()
        .parse::<i32>()
        .unwrap();
    observer.abort();
    let _ = observer.await;
    assert!(!request.operation.interested());
    assert!(!request.snapshot().unwrap().settled);
    assert!(connection.life.work().is_err());
    assert!(gate.update().is_err());
    assert!(matches!(
        registry.begin(
            &f.row.id,
            "/tmp",
            "02000000-0000-4000-8000-000000000002",
            ID,
            Kind::Mcp
        ),
        Err(Failure { code: Code::Busy })
    ));
    worker.await.unwrap();
    assert_ne!(crate::platform_tests::process_check(pid), 0);
    assert!(connection.life.work().is_ok());
    assert!(gate.update().is_ok());
    assert_eq!(request.snapshot().unwrap().state, State::Cancelled);
    assert!(request.snapshot().unwrap().settled);
}
#[test]
fn skills_result_waits_for_real_successful_exit_and_inherited_pipes() {
    for (tail, expected) in [
        ("import sys;sys.exit(7)", Some(Code::QueryFailed)),
        (
            "import os,time\nif os.fork()==0:\n time.sleep(.18);os._exit(0)\nos._exit(0)",
            None,
        ),
    ] {
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin("fixture", "/tmp", ID, ID, Kind::Skills)
            .unwrap();
        let code = format!(
            "import sys,json\njson.loads(sys.stdin.readline())\nprint(json.dumps({{'id':1,'result':{{'userAgent':'fixture'}}}}),flush=True)\nsys.stdin.readline();sys.stdin.readline()\nprint(json.dumps({{'id':2,'result':{{'data':[{{'cwd':'/tmp','skills':[],'errors':[]}}]}}}}),flush=True)\nassert sys.stdin.read()==''\n{tail}"
        );
        let mut command = Command::new(crate::platform_tests::python());
        command.args(["-u", "-c", &code]);
        let now = Instant::now();
        let result = process::run_skills(command, &request);
        if let Some(code) = expected {
            assert_eq!(result.unwrap_err().code, code);
        } else {
            assert!(result.is_ok());
            assert!(now.elapsed() >= Duration::from_millis(150));
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_list_or_post_result_cleanup_does_not_publish_ready() {
    for complete in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("stage");
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin("fixture", "/tmp", ID, ID, Kind::Skills)
            .unwrap();
        let code = format!(
            "import sys,json,os,time\nsys.stdin.readline()\nprint(json.dumps({{'id':1,'result':{{'userAgent':'fixture'}}}}),flush=True)\nsys.stdin.readline();sys.stdin.readline()\n{}\nopen(sys.argv[1],'w').write(str(os.getpid()))\ntime.sleep(30)",
            if complete {
                "print(json.dumps({'id':2,'result':{'data':[{'cwd':'/tmp','skills':[],'errors':[]}]}}),flush=True)\nassert sys.stdin.read()==''"
            } else {
                "pass"
            }
        );
        let copy = request.clone();
        let child_marker = marker.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let mut command = Command::new(crate::platform_tests::python());
            command.args(["-u", "-c", &code]).arg(child_marker);
            let result = process::run_skills(command, &copy);
            copy.finish(result.map(InventorySnapshot::Skills));
        });
        until(|| marker.is_file()).await;
        assert!(!request.snapshot().unwrap().settled);
        let pid = std::fs::read_to_string(marker)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let cancellation = registry.cancel("fixture", ID).unwrap();
        assert!(!cancellation.operation.unwrap().settled);
        worker.await.unwrap();
        assert_ne!(crate::platform_tests::process_check(pid), 0);
        let state = request.snapshot().unwrap();
        assert_eq!(state.state, State::Cancelled);
        assert!(state.snapshot.is_none());
    }
}
