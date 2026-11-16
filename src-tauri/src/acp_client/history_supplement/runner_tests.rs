//! Actual bounded owned child processes; no official Agent or production history.
use super::*;
use crate::acp_client::{lifecycle::ConnectionLife, operations::Operation};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
fn prepare(mode: &str) -> launch_tests::Fixture {
    let f = launch_tests::Fixture::new();
    let mut r = tests::records();
    r[0]["payload"]["cwd"] = f.root.to_string_lossy().as_ref().into();
    r[3]["payload"]["cwd"] = f.root.to_string_lossy().as_ref().into();
    let trace = String::from_utf8(tests::encode(&r)).unwrap();
    let code = format!(
        r#"import os,sys,time
from pathlib import Path
out=Path(sys.argv[-1]); root=Path({root}); mode={mode}
root.joinpath('started').write_text(str(out)+'\n'+str(os.getpid()))
trace={trace}
if mode=='wait':
    while True: time.sleep(1)
elif mode=='oversize':
    with out.open('wb') as f:
        for _ in range(20): f.write(b'x'*(1024*1024))
elif mode=='stdout':
    print('private-child-text'*10000)
else:
    out.write_bytes(trace.encode())
"#,
        root = serde_json::to_string(f.root.to_str().unwrap()).unwrap(),
        mode = serde_json::to_string(mode).unwrap(),
        trace = serde_json::to_string(&trace).unwrap()
    );
    std::fs::write(f.root.join("driver.py"), code).unwrap();
    std::fs::write(
        f.root.join("venv/bin/python"),
        format!(
            "#!/bin/sh\nexec {} {} \"$@\"\n",
            quote(&crate::platform_tests::python()),
            quote(f.root.join("driver.py").to_str().unwrap())
        ),
    )
    .unwrap();
    f
}
fn run(
    f: &launch_tests::Fixture,
    op: Operation,
    life: Arc<ConnectionLife>,
    budget: Duration,
) -> Result<ParsedHistory> {
    runner::execute(
        f.source(),
        f.row.clone(),
        vec![f.receipt.clone()],
        f.root.clone(),
        "owned-session".into(),
        "agent".into(),
        op,
        life,
        Instant::now() + budget,
        Default::default(),
    )
}
fn ready() -> Arc<ConnectionLife> {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    life
}
fn wait_started(root: &Path) -> (String, u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(s) = std::fs::read_to_string(root.join("started")) {
            let parts: Vec<_> = s.lines().collect();
            if parts.len() == 2
                && let Ok(pid) = parts[1].parse()
            {
                return (parts[0].into(), pid);
            }
        }
        assert!(
            Instant::now() < deadline,
            "owned child did not publish its start"
        );
        std::thread::yield_now();
    }
}
fn settled_cleanup(root: &Path) {
    let (path, pid) = wait_started(root);
    assert!(!Path::new(&path).exists());
    assert!(!Path::new(&path).parent().unwrap().exists());
    assert_eq!(
        unsafe { libc::kill(pid as i32, 0) },
        -1,
        "owned export child still present"
    );
}
#[test]
fn successful_export_reads_actual_private_file_then_cleans_after_process_exit() {
    let f = prepare("normal");
    let result = run(&f, Operation::new(), ready(), Duration::from_secs(5)).unwrap();
    assert_eq!(result.tools.len(), 1);
    assert_eq!(result.anchors.len(), 2);
    settled_cleanup(&f.root);
}
#[test]
fn cancellation_after_actual_spawn_reaps_original_child_and_does_not_publish_late_file() {
    let f = prepare("wait");
    let root = f.root.clone();
    let op = Operation::new();
    let cancel = op.clone();
    let worker = std::thread::spawn(move || run(&f, op, ready(), Duration::from_secs(5)));
    wait_started(&root);
    cancel.abandon();
    assert_eq!(worker.join().unwrap().unwrap_err(), Reason::Cancelled);
    // Fixture directory is also dropped only after execute has reaped the child.
    assert!(!root.exists());
}
#[test]
fn actual_output_and_pipe_limits_do_not_return_child_output_or_leave_files() {
    for mode in ["oversize", "stdout"] {
        let f = prepare(mode);
        assert!(run(&f, Operation::new(), ready(), Duration::from_secs(5)).is_err());
        settled_cleanup(&f.root);
    }
}
#[test]
fn original_connection_ending_during_export_cancels_and_cleans_same_owned_child() {
    let f = prepare("wait");
    let root = f.root.clone();
    let life = ready();
    let ending = life.clone();
    let worker =
        std::thread::spawn(move || run(&f, Operation::new(), life, Duration::from_secs(5)));
    wait_started(&root);
    ending.close(true, None).unwrap();
    assert_eq!(worker.join().unwrap().unwrap_err(), Reason::Cancelled);
    assert!(!root.exists());
}
#[test]
fn deadline_before_spawn_has_no_child_and_owned_temporary_file_is_removed() {
    let f = prepare("normal");
    assert!(run(&f, Operation::new(), ready(), Duration::ZERO).is_err());
    assert!(!f.root.join("started").exists());
}
