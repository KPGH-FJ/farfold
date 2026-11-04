//! Actual process/stdio EOF edge with one disposable Python descendant.
use super::*;
use crate::platform_tests::{held_process::HeldProcess, windows_conpty};
use std::os::windows::io::AsRawHandle;

const EDGE: &str = r#"  if mode=='eof':
   import os,subprocess,signal
   child_ready=fence.with_suffix('.child-ready')
   release_child=fence.with_suffix('.release-child')
   release_eof=fence.with_suffix('.release-eof')
   program='''import os,pathlib,sys,time
ready=pathlib.Path(sys.argv[1])
temporary=ready.with_name(ready.name+'.tmp')
temporary.write_text(str(os.getpid()))
temporary.replace(ready)
deadline=time.monotonic()+15
while not pathlib.Path(sys.argv[2]).exists():
 assert time.monotonic()<deadline, 'owned child release timed out'
 time.sleep(.001)
'''
   child=subprocess.Popen([sys.executable,'-u','-c',program,str(child_ready),str(release_child)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   deadline=time.monotonic()+10
   while not release_eof.exists():
    assert time.monotonic()<deadline, 'owned EOF release timed out'
    time.sleep(.001)
   signal.signal(signal.SIGTERM,signal.SIG_IGN)
   os.close(1)
   release_child.write_text('release')
   time.sleep(5)
   sys.exit(7)
"#;

#[test]
#[ignore = "manual bounded native EOF descendant observation"]
fn actual_eof_descendant_exit_edge_isolated() {
    windows_conpty::run(windows_conpty::Case::AcpEofDescendant);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "executed only by its bounded owned process wrapper"]
async fn actual_eof_descendant_exit_edge_child() {
    windows_conpty::entered(windows_conpty::Case::AcpEofDescendant);
    let mut suite = Suite::new();
    let edge_start = PEER.find("  if mode=='eof':").unwrap();
    let edge_end = PEER[edge_start..].find(" elif method is None").unwrap() + edge_start;
    let source = format!("{}{}{}", &PEER[..edge_start], EDGE, &PEER[edge_end..]);
    std::fs::write(suite.cwd.join("peer.py"), source).unwrap();
    let mut conversation = suite.open(0, "eof-descendant", "eof").await;
    let leader = HeldProcess::open(conversation.pid as i32).unwrap();
    assert!(leader.observe().is_running());
    let completed = Arc::new(AtomicBool::new(false));
    let completion = completed.clone();
    let (send, mut observations) = mpsc::unbounded_channel();
    assert!(
        suite.lives[0]
            .retirement_observer
            .set(Arc::new(move |value| {
                if value["point"] == "actualOwnerCompletion" {
                    completion.store(true, Ordering::Release);
                }
                let _ = send.send(value);
            }))
            .is_ok()
    );
    let (content, digest) = blocks(0);
    suite
        .manager
        .session_prompt(
            &conversation.agent,
            &suite.cwd,
            &conversation.session,
            content,
        )
        .await
        .unwrap();
    start(&mut conversation, &digest).await;
    let ready = conversation.fence.with_extension("child-ready");
    let descendant_pid = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(pid) = std::fs::read_to_string(&ready)
                && let Ok(pid) = pid.parse::<i32>()
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("owned descendant ready");
    let descendant = HeldProcess::open(descendant_pid).unwrap();
    assert!(descendant.observe().is_running());
    let descendant_membership = {
        let witness =
            crate::windows_process::read_only_job_witness_for_test(conversation.pid).unwrap();
        let membership = witness.observe(descendant.as_raw_handle());
        assert!(membership.complete());
        serde_json::to_value(membership).unwrap()
    };
    assert_eq!(descendant_membership["member"], true);
    assert_eq!(suite.manager.prompt_admission.counts().0, 1);
    assert_eq!(suite.lives[0].work.load(Ordering::SeqCst), 1);
    assert!(crate::managed_update::quiet_exit().is_err());
    eprintln!(
        "FARFOLD_ACP_EOF_DESCENDANT_START {}",
        json!({"originalChildPid":conversation.pid,"descendantPid":descendant_pid,
            "leaderHeldRunning":true,"descendantHeldRunning":true,
            "descendantOriginalJobMembership":descendant_membership,
            "membershipWitnessDroppedBeforeEof":true})
    );
    std::fs::write(conversation.fence.with_extension("release-eof"), "release").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = conversation.events.recv().await.expect("owned EOF event");
            if event["kind"] == "turnEnd" {
                assert!(event.get("error").is_some());
                break;
            }
            if event["kind"] == "connectionLost" {
                break;
            }
        }
    })
    .await
    .expect("owned EOF delivery");
    let active = suite.manager.prompt_admission.counts().0;
    let work = suite.lives[0].work.load(Ordering::SeqCst);
    let exit_blocked = crate::managed_update::quiet_exit().is_err();
    let before_completion = !completed.load(Ordering::Acquire);
    if before_completion {
        assert_eq!(active, 1);
        assert_eq!(work, 1);
        assert!(exit_blocked);
    }
    let closed = suite.lives[0].closed().await;
    let mut gap = false;
    let mut owner_completed = false;
    let mut observed = 0;
    while let Ok(value) = observations.try_recv() {
        assert_eq!(value["originalChildPid"], conversation.pid);
        assert_eq!(value["sameOriginalChildPid"], true);
        assert_eq!(value["retainedLeader"]["sameOriginalChildPid"], true);
        gap |= value["currentMembers"]["coverageGap"] == true;
        owner_completed |= value["point"] == "actualOwnerCompletion";
        observed += 1;
        eprintln!("FARFOLD_ACP_EOF_DESCENDANT_RETIREMENT {value}");
    }
    let counts = suite.manager.prompt_admission.counts();
    let work = suite.lives[0].work.load(Ordering::SeqCst);
    eprintln!(
        "FARFOLD_ACP_EOF_DESCENDANT_RESULT {}",
        json!({"originalChildPid":conversation.pid,"descendantPid":descendant_pid,
            "gapObserved":gap,"ownerObservationCount":observed,"ownerCompleted":owner_completed,
            "closedSucceeded":closed.is_ok(),"heldLeaderExited":leader.observe().is_exited(),
            "heldDescendantExited":descendant.observe().is_exited(),
            "beforeCompletionCovered":before_completion,"promptAdmissionCounts":counts,"work":work})
    );
    assert!(observed > 0);
    if closed.is_err() {
        assert!(
            gap && !owner_completed,
            "close failure without an attributed native gap"
        );
        assert_eq!(counts.0, 1);
        assert_eq!(work, 1);
        assert!(crate::managed_update::quiet_exit().is_err());
        eprintln!("FARFOLD_ACP_EOF_DESCENDANT_GAP_RETAINED");
        // The existing outer wrapper retains its exact Child/Job and cleanup budget.
        std::future::pending::<()>().await;
    }
    closed.unwrap();
    assert!(
        !gap,
        "EOF process completed despite an observed historical coverage gap"
    );
    assert!(owner_completed);
    assert!(leader.observe().is_exited());
    assert!(descendant.observe().is_exited());
    assert_eq!(counts, (0, 0, 0));
    assert_eq!(work, 0);
    cleanup(&suite).await;
}
