//! Actual owned synthetic child/pipe cleanup through the unchanged production wrapper.
use super::*;
use inventory::process::Control;
use mcp_add_tests::Fixture;
use serde_json::json;
use std::{path::PathBuf, process::Command, time::Duration};

#[tokio::test(flavor = "multi_thread")]
async fn mcp_http_cancel_after_write_keeps_real_worker_scope_and_budget_until_reaped() {
    let f = Fixture::new(json!([]));
    let (inspection, review) = mcp_http_tests::inspect(&f);
    let j = f.confirm(&review);
    let row = f.store.get_agent(&f.agent).unwrap().unwrap();
    let manager = crate::acp_client::manager::AcpManager::new(
        f.temp.path().join("logs"),
        f.temp.path().into(),
    );
    let scope = manager
        .reserve_preparation_action(&row, &row.command, &row.args)
        .unwrap();
    let admission = crate::managed_update::UpdateAdmission::default();
    let activity = admission.activity().unwrap();
    let root = f.temp.path().to_path_buf();
    let execution = tokio::spawn(super::execute_with(
        f.store.clone(),
        j.clone(),
        activity,
        scope,
        move |store, job| {
            mcp_add::run_with(store, job, |stage| {
                let mut c = Command::new(crate::platform_tests::python());
                c.arg("-u")
                    .arg(
                        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                            .join("src/acp_client/skill_management/mcp_add_peer.py"),
                    )
                    .arg(&root)
                    .arg("postget-wait")
                    .arg(match stage {
                        mcp_add::Stage::List => "list",
                        mcp_add::Stage::Get => "get",
                        mcp_add::Stage::AppServer => "server",
                    });
                Ok(c)
            })
        },
    ));
    let marker = f.temp.path().join("waiting");
    let reached = tokio::time::timeout(Duration::from_secs(5), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    let cancel = f
        .registry
        .cancel_domain(&f.agent, &j.snapshot().request_id, domain::Domain::McpAdd)
        .unwrap();
    assert!(reached);
    assert!(!cancel.operation.as_ref().unwrap().settled);
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(crate::platform_tests::process_check(pid), 0);
    assert!(admission.update().is_err());
    assert!(
        manager
            .reserve_preparation_action(&row, &row.command, &row.args)
            .is_err()
    );
    let second = inventory::execution::acquire().unwrap();
    assert!(matches!(
        inventory::execution::acquire(),
        Err(Failure { code: Code::Busy })
    ));
    // A real outstanding worker publishes this controlled sample; this is not
    // a claim that the operating system exceeded the production cleanup bound.
    j.pending_cleanup();
    let pending = j.snapshot();
    assert!(!pending.settled && pending.write_dispatched);
    assert_eq!(pending.outcome, None);
    tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(crate::platform_tests::process_check(pid), 0);
    assert!(admission.update().is_ok());
    assert!(
        manager
            .reserve_preparation_action(&row, &row.command, &row.args)
            .is_ok()
    );
    drop(second);
    let final_op = j.snapshot();
    assert!(final_op.settled);
    assert_eq!(final_op.write_ack, Ack::Ok);
    assert_eq!(final_op.outcome, Some(Outcome::Unknown));
    assert_eq!(f.state()["writes"], 1);
    let check = f.recheck(&j);
    f.run(&check, "normal");
    assert_eq!(check.snapshot().outcome, Some(Outcome::Observed));
    assert_eq!(check.snapshot().write_ack, Ack::Ok);
    assert_eq!(f.state()["writes"], 1);
    println!(
        "MCP_HTTP_CLEANUP_WIRE={}",
        json!({"inspection":inspection.snapshot(),"pendingCleanup":pending,"cancellation":cancel,"cancelledAfterWrite":final_op,"recheck":check.snapshot()})
    );
}
