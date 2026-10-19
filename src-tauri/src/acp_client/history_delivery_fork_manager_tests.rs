//! Original two-process fork peer under one existing history Permit.
//! A one-active policy makes a second acquire deadlock/fail this real path.
use super::*;
use crate::acp_client::{
    history_admission::{Admission, Policy},
    history_admission_commands::{HistoryAdmissionState, HistoryPreparation, HistoryRequest},
};

#[tokio::test(flavor = "multi_thread")]
async fn actual_fork_source_and_independent_destination_share_one_original_permit_until_renderer_ack()
 {
    let mut f = Fixture::new();
    Arc::get_mut(&mut f.manager).unwrap().history_admission = Admission::new(Policy {
        active: 1,
        pending: 4,
        bytes: 8 * 1024 * 1024,
    })
    .unwrap();
    let (connection, _parent_events) = parent(&f).await;
    let gate = f.manager.history_admission.clone();
    let owner = gate.fixture_owner("window", "original-fork-read", &f.row.id);
    let original = owner.clone();
    let admission = gate.clone();
    let ids = Arc::new(Mutex::new(Vec::new()));
    let seen = ids.clone();
    let request = HistoryRequest {
        owner: owner.clone(),
        preparation_bytes: 0,
        progress: Arc::new(move |phase| {
            if phase == HistoryAdmissionState::Starting {
                seen.lock()
                    .unwrap()
                    .push(admission.arm_renderer(&original).unwrap().receipt_id);
            }
            Ok(())
        }),
    };
    let mut preparation = HistoryPreparation::new(request.progress.clone());
    let permit = f
        .manager
        .admit_cold_history(&f.row, &f.cwd, "parent", &[], &f.store, None, request)
        .await
        .unwrap();
    preparation.ready();
    let events = Arc::new(Mutex::new(Vec::new()));
    let source = f
        .manager
        .begin_fork(
            f.row.clone(),
            &f.cwd,
            "parent",
            &connection,
            "one-operation".into(),
            "original-fork-read".into(),
            sink(&events),
            Arc::new(AtomicBool::new(false)),
            &f.store,
            Some(permit),
        )
        .await
        .unwrap();
    let result = source.wait(Duration::from_secs(5)).await;
    assert_eq!(result.status, "ready");
    assert!(result.source_released && result.indexed);
    assert_ne!(result.session.as_ref().unwrap().connection_id, connection);
    assert_eq!(result.session.as_ref().unwrap().native_session_id, "child");
    assert_eq!(
        trace(&f)
            .iter()
            .filter_map(|row| row["method"].as_str())
            .filter(|method| matches!(*method, "session/fork" | "session/load" | "session/close"))
            .collect::<Vec<_>>(),
        vec![
            "session/fork",
            "session/load",
            "session/close",
            "session/load"
        ]
    );
    assert_eq!(ids.lock().unwrap().len(), 1);
    assert_eq!(gate.counts().0, 1);
    let next = gate
        .enqueue(gate.fixture_owner("other", "next", "other"), 1)
        .unwrap();
    assert_eq!(gate.counts().1, 1);
    let id = ids.lock().unwrap()[0];
    gate.acknowledge_renderer(&owner, id).unwrap();
    drop(
        tokio::time::timeout(Duration::from_secs(5), next.acquire())
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(gate.counts(), (0, 0, 0));
    // End only these controlled peers; no active real Agent or user data.
    let lives = f
        .manager
        .lock()
        .unwrap()
        .values()
        .map(|c| c.life.clone())
        .collect::<Vec<_>>();
    f.manager.stop_for_shutdown();
    for life in lives {
        tokio::time::timeout(Duration::from_secs(10), life.terminated())
            .await
            .unwrap();
    }
}
