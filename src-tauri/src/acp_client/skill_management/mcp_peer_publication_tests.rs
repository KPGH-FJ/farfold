//! Force the reader into open-before-write, using the real synthetic peers.
//! No production process or credentials; sleep is intercepted in this child.
use std::{path::PathBuf, process::Command};

fn check(peer: &str, mode: &str, stage: &str, marker: &str) {
    let root = tempfile::tempdir().unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/acp_client/skill_management")
        .join(peer);
    let result = Command::new(crate::platform_tests::python())
        .args(["-B", "-c", r#"
import io, json, os, pathlib, runpy, sys, time
source, directory, mode, stage, name = sys.argv[1:]
root = pathlib.Path(directory)
marker = root / name
(root / 'state.json').write_text(json.dumps({
    'name': 'sample', 'methods': [], 'writes': 1, 'lists': 0,
    'config': {'layers': [{'config': {'mcp_servers': {}}}]},
}))
if mode == 'scope-files':
    (root / 'scope-pause').write_text('owned gate')
    sys.stdin = io.StringIO(json.dumps({'id':1, 'method':'config/read', 'params':{'cwd':None}})+'\n')
original_open = pathlib.Path.open
observed = False
def watch_open(path, mode='r', *args, **kwargs):
    global observed
    handle = original_open(path, mode, *args, **kwargs)
    if 'w' in mode and path in (marker, root / (name + '.tmp')):
        observed = True
        # Exactly the schedule which made exists() pass while parse saw "".
        if marker.exists():
            handle.close()
            raise AssertionError('PID marker visible before its content is complete')
    return handle
def stopped_wait(_seconds):
    assert observed, 'did not observe the intended publication window'
    assert marker.read_text() == str(os.getpid()), 'published PID is incomplete'
    raise SystemExit(0)
pathlib.Path.open = watch_open
time.sleep = stopped_wait
sys.argv = [source, directory, mode, stage]
runpy.run_path(source, run_name='__main__')
raise AssertionError('peer never reached its owned waiting point')
"#])
        .arg(source)
        .arg(root.path())
        .args([mode, stage, marker])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn mcp_add_pid_publication_is_complete_at_first_visibility() {
    check("mcp_add_peer.py", "postget-wait", "get", "waiting");
}
#[test]
fn mcp_remove_pid_publication_is_complete_at_first_visibility() {
    check("mcp_remove_peer.py", "postlist-wait", "list", "waiting");
}
#[test]
fn mcp_postget_pid_publication_is_complete_at_first_visibility() {
    check("mcp_peer.py", "postget-wait", "get", "postget-waiting");
}
#[test]
fn mcp_scope_pid_publication_is_complete_at_first_visibility() {
    check("mcp_peer.py", "scope-files", "server", "scope-waiting");
}
