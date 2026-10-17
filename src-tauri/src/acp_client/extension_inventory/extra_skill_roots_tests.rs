//! Local controlled peers only. No installed CLI, Agent, account or user data.
use super::*;
use serde_json::json;
use std::process::Command;

const ID: &str = "03000000-0000-4000-8000-000000000001";
const PEER: &str = r#"
import json,sys
init=json.loads(sys.stdin.readline())
assert init['method']=='initialize'
print(json.dumps({'id':1,'result':{'userAgent':'fixture'}}),flush=True)
assert json.loads(sys.stdin.readline())=={'method':'initialized'}
setter=json.loads(sys.stdin.readline())
assert setter=={'id':2,'method':'skills/extraRoots/set','params':{'extraRoots':[sys.argv[1]]}}
print(json.dumps({'id':2,'result':{}}),flush=True)
query=json.loads(sys.stdin.readline())
assert query=={'id':3,'method':'skills/list','params':{'cwds':['/tmp'],'forceReload':True}}
print(json.dumps({'id':3,'result':{'data':[{'cwd':'/tmp','skills':[],'errors':[]}]}}),flush=True)
assert sys.stdin.read()==''
"#;

#[test]
fn extra_skill_roots_waits_for_set_ack_before_list_on_same_owned_worker() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let requests = requests::Requests::default();
    let (request, _) = requests
        .begin_with_roots("fixture", "/tmp", ID, ID, Kind::Skills, vec![path.clone()])
        .unwrap();
    let mut command = Command::new(crate::platform_tests::python());
    command.args(["-u", "-c", PEER, &path]);
    let result = process::run_skills(command, &request);
    assert!(
        result.is_ok(),
        "selected roots must be ACKed before querying: {result:?}"
    );
    assert_eq!(
        serde_json::to_value(request.snapshot()).unwrap()["extraSkillRoots"],
        json!([path])
    );
}

fn code<T>(value: Result<T>) -> Code {
    match value {
        Err(e) => e.code,
        Ok(_) => panic!("expected fixed failure"),
    }
}
#[test]
fn roots_are_bounded_absolute_explicit_and_disallowed_for_mcp() {
    for roots in [
        vec![String::new()],
        vec!["relative".into()],
        vec!["/bad\nroot".into()],
        vec![format!("/{}", "a".repeat(4096))],
        vec!["/root".into(); 5],
        vec![format!("/{}", "中".repeat(1366))],
    ] {
        assert_eq!(
            code(extra_skill_roots::validate(&roots, Kind::Skills)),
            Code::InvalidRequest
        );
    }
    assert_eq!(
        code(extra_skill_roots::validate(&["/root".into()], Kind::Mcp)),
        Code::InvalidRequest
    );
    extra_skill_roots::validate(&[], Kind::Mcp).unwrap();
    let edge = format!("/{}", "a".repeat(4095));
    extra_skill_roots::validate(
        &[edge.clone(), edge.clone(), edge.clone(), edge],
        Kind::Skills,
    )
    .unwrap();
}
#[test]
fn roots_are_part_of_request_identity_and_cannot_reuse_mcp_or_cancelled_owners() {
    let registry = requests::Requests::default();
    let roots = vec!["/selected/A".into(), "/selected/B".into()];
    let (first, fresh) = registry
        .begin_with_roots("fixture", "/tmp", ID, ID, Kind::Skills, roots.clone())
        .unwrap();
    assert!(fresh);
    let (same, fresh) = registry
        .begin_with_roots("fixture", "/tmp", ID, ID, Kind::Skills, roots.clone())
        .unwrap();
    assert!(!fresh && Arc::ptr_eq(&first, &same));
    for next in [
        vec![],
        vec![roots[1].clone(), roots[0].clone()],
        vec!["/selected/C".into()],
    ] {
        assert_eq!(
            code(registry.begin_with_roots("fixture", "/tmp", ID, ID, Kind::Skills, next)),
            Code::RequestConflict
        );
    }
    assert_eq!(
        code(registry.begin_with_roots("fixture", "/tmp", ID, ID, Kind::Mcp, vec![])),
        Code::RequestConflict
    );
    let other = requests::Requests::default();
    other.cancel("fixture", ID).unwrap();
    assert_eq!(
        code(other.begin_with_roots("fixture", "/tmp", ID, ID, Kind::Skills, roots)),
        Code::Cancelled
    );
}
#[cfg(unix)]
#[test]
fn canonical_alias_is_sent_without_rewriting_requested_root_echo_or_adding_a_suffix() {
    let root = tempfile::tempdir().unwrap();
    let actual = root.path().canonicalize().unwrap();
    let selected = actual.join("selected");
    std::fs::create_dir(&selected).unwrap();
    let alias = actual.join("chosen-alias");
    std::os::unix::fs::symlink(&selected, &alias).unwrap();
    let registry = requests::Requests::default();
    let original = alias.to_str().unwrap().to_owned();
    let (request, _) = registry
        .begin_with_roots(
            "fixture",
            "/tmp",
            ID,
            ID,
            Kind::Skills,
            vec![original.clone()],
        )
        .unwrap();
    let mut command = Command::new(crate::platform_tests::python());
    command.args(["-u", "-c", PEER, selected.to_str().unwrap()]);
    process::run_skills(command, &request).unwrap();
    assert_eq!(request.extra_skill_roots, vec![original.clone()]);
    assert_eq!(
        serde_json::to_value(request.snapshot()).unwrap()["extraSkillRoots"],
        json!([original])
    );
    assert!(!selected.join(".agents/skills").exists());
    assert_eq!(
        code(extra_skill_roots::PinnedRoots::open(&[
            selected.to_str().unwrap().into(),
            alias.to_str().unwrap().into()
        ])),
        Code::InvalidRequest
    );
}
#[test]
fn pin_refuses_missing_files_and_replacement_but_does_not_claim_contents_are_immutable() {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    let selected = base.join("selected");
    std::fs::create_dir(&selected).unwrap();
    let text = selected.to_str().unwrap().to_owned();
    let pinned = extra_skill_roots::PinnedRoots::open(std::slice::from_ref(&text)).unwrap();
    std::fs::write(selected.join("SKILL.md"), "controlled change").unwrap();
    assert!(pinned.current());
    std::fs::rename(&selected, base.join("old")).unwrap();
    std::fs::create_dir(&selected).unwrap();
    assert!(!pinned.current());
    assert_eq!(
        code(extra_skill_roots::PinnedRoots::open(&[base
            .join("missing")
            .to_str()
            .unwrap()
            .into()])),
        Code::CwdUnavailable
    );
    let file = base.join("file");
    std::fs::write(&file, "controlled").unwrap();
    assert_eq!(
        code(extra_skill_roots::PinnedRoots::open(&[file
            .to_str()
            .unwrap()
            .into()])),
        Code::CwdUnavailable
    );
}
#[cfg(unix)]
#[test]
fn selected_alias_retargeting_is_not_a_new_authorized_root() {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    let a = base.join("A");
    let b = base.join("B");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    let alias = base.join("alias");
    std::os::unix::fs::symlink(&a, &alias).unwrap();
    let pinned = extra_skill_roots::PinnedRoots::open(&[alias.to_str().unwrap().into()]).unwrap();
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&b, &alias).unwrap();
    assert!(!pinned.current());
}
#[test]
fn directory_replacement_during_actual_exchange_cannot_publish_a_ready_report() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap().join("selected");
    std::fs::create_dir(&path).unwrap();
    let registry = requests::Requests::default();
    let (request, _) = registry
        .begin_with_roots(
            "fixture",
            "/tmp",
            ID,
            ID,
            Kind::Skills,
            vec![path.to_str().unwrap().into()],
        )
        .unwrap();
    let peer=PEER.replace("print(json.dumps({'id':2,'result':{}}),flush=True)","import os\nos.rename(sys.argv[1],sys.argv[1]+'.old')\nos.mkdir(sys.argv[1])\nprint(json.dumps({'id':2,'result':{}}),flush=True)");
    let mut command = Command::new(crate::platform_tests::python());
    command.args(["-u", "-c", &peer, path.to_str().unwrap()]);
    assert_eq!(
        code(process::run_skills_private(command, &request)),
        Code::CwdUnavailable
    );
    assert!(request.targets.lock().unwrap().is_none());
}
#[test]
fn extra_reports_cannot_become_management_authority_even_with_a_forged_private_target_set() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap();
    let cwd = path.to_str().unwrap();
    let agent = format!("extra-target-{}", cwd);
    let registry = requests::shared();
    let (request, _) = registry
        .begin_with_roots(&agent, cwd, ID, ID, Kind::Skills, vec![cwd.into()])
        .unwrap();
    let wire:skills_output::Wire=serde_json::from_value(json!({"data":[{"cwd":cwd,"skills":[{"name":"controlled","description":"Controlled fixture.","scope":"user","path":"/controlled/SKILL.md","enabled":true}],"errors":[]}]})).unwrap();
    let (public, entries) = wire.project_private(cwd).unwrap();
    request.finish(Ok(InventorySnapshot::Skills(public)));
    let row = crate::meta_store::AgentRow {
        id: agent.clone(),
        name: "fixture".into(),
        source: "custom".into(),
        command: "/fixture".into(),
        args: vec![],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    let set = Arc::new(targets::TargetSet {
        row,
        directory: Arc::new(launch::Directory::open(cwd).unwrap()),
        entries,
    });
    *request.targets.lock().unwrap() = Some(set.clone());
    assert_eq!(code(targets::get(&agent, ID, 0)), Code::TargetUnavailable);
    let source = targets::Source {
        request,
        set: set.clone(),
        target: set.entries[0].clone(),
        inventory_id: ID.into(),
    };
    assert!(!source.available());
    let store = crate::meta_store::MetaStore::open(&path.join("controlled.db")).unwrap();
    assert_eq!(code(source.current(&store, false)), Code::TargetUnavailable);
}
fn waiting_peer() -> String {
    PEER.replace("print(json.dumps({'id':2,'result':{}}),flush=True)","import os,time\nwith open(sys.argv[2],'w') as marker: marker.write(str(os.getpid()))\ntime.sleep(60)\nprint(json.dumps({'id':2,'result':{}}),flush=True)")
}
#[test]
fn cancelling_while_setter_waits_reaps_the_exact_worker_and_pipes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap();
    let marker = path.join("pid");
    let registry = requests::Requests::default();
    let (request, _) = registry
        .begin_with_roots(
            "fixture",
            "/tmp",
            ID,
            ID,
            Kind::Skills,
            vec![path.to_str().unwrap().into()],
        )
        .unwrap();
    let mut command = Command::new(crate::platform_tests::python());
    command.args([
        "-u",
        "-c",
        &waiting_peer(),
        path.to_str().unwrap(),
        marker.to_str().unwrap(),
    ]);
    let observer = request.clone();
    let worker = std::thread::spawn(move || process::run_skills(command, &request));
    let end = std::time::Instant::now() + Duration::from_secs(4);
    while !marker.exists() && std::time::Instant::now() < end {
        std::thread::sleep(Duration::from_millis(5));
    }
    let pid: u32 = std::fs::read_to_string(&marker).unwrap().parse().unwrap();
    observer.operation.abandon();
    assert_eq!(code(worker.join().unwrap()), Code::Cancelled);
    assert!(!crate::supervisor::owned_group_alive(pid));
    assert!(observer.targets.lock().unwrap().is_none());
}
#[test]
fn timeout_while_setter_waits_does_not_publish_or_retry() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap();
    let marker = path.join("pid");
    let registry = requests::Requests::default();
    let (mut request, _) = registry
        .begin_with_roots(
            "fixture",
            "/tmp",
            ID,
            ID,
            Kind::Skills,
            vec![path.to_str().unwrap().into()],
        )
        .unwrap();
    drop(registry);
    Arc::get_mut(&mut request).unwrap().deadline =
        std::time::Instant::now() + Duration::from_secs(1);
    let mut command = Command::new(crate::platform_tests::python());
    command.args([
        "-u",
        "-c",
        &waiting_peer(),
        path.to_str().unwrap(),
        marker.to_str().unwrap(),
    ]);
    assert_eq!(code(process::run_skills(command, &request)), Code::TimedOut);
    let pid: u32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    assert!(!crate::supervisor::owned_group_alive(pid));
    assert!(request.targets.lock().unwrap().is_none());
}

fn swapped_root_must_block_next_wire(phase: &str) {
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    let selected = base.join("selected");
    std::fs::create_dir(&selected).unwrap();
    let marker = base.join("unexpected-next-wire");
    let registry = requests::Requests::default();
    let (request, _) = registry
        .begin_with_roots(
            "fixture",
            "/tmp",
            ID,
            ID,
            Kind::Skills,
            vec![selected.to_str().unwrap().into()],
        )
        .unwrap();
    let before = if phase == "initialize" {
        "print(json.dumps({'id':1,'result':{'userAgent':'fixture'}}),flush=True)"
    } else {
        "print(json.dumps({'id':2,'result':{}}),flush=True)"
    };
    let mutation = "import os\nos.rename(sys.argv[1],sys.argv[1]+'.old')\nos.mkdir(sys.argv[1])\n";
    let mut peer = PEER.replace(before, &format!("{mutation}{before}"));
    let next = if phase == "initialize" {
        "setter=json.loads(sys.stdin.readline())"
    } else {
        "query=json.loads(sys.stdin.readline())"
    };
    peer = peer.replace(
        next,
        &format!("{next}\nwith open(sys.argv[2],'w') as marker: marker.write('sent')"),
    );
    let mut command = Command::new(crate::platform_tests::python());
    command.args([
        "-u",
        "-c",
        &peer,
        selected.to_str().unwrap(),
        marker.to_str().unwrap(),
    ]);
    assert_eq!(
        code(process::run_skills(command, &request)),
        Code::CwdUnavailable
    );
    assert!(
        !marker.exists(),
        "root changed while waiting for {phase}; next RPC must not be sent"
    );
}
#[test]
fn root_change_during_initialize_blocks_setter_before_sending() {
    swapped_root_must_block_next_wire("initialize");
}
#[test]
fn root_change_during_setter_ack_blocks_list_before_sending() {
    swapped_root_must_block_next_wire("setter-ack");
}
