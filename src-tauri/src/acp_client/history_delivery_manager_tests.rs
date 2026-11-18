//! Real manager/stdio load handoff plus simulated renderer retirement.
//! The test window is synthetic; no Tauri GUI, Agent/account or RSS claim.
use super::*;
use crate::acp_client::{
    history_admission::{Admission, Policy},
    history_admission_commands::{HistoryAdmissionState, HistoryRequest},
};
use std::sync::Mutex;

#[tokio::test(flavor = "multi_thread")]
async fn actual_manager_load_returns_but_the_next_load_waits_for_original_renderer_ack() {
    let mut f = Fixture::new();
    Arc::get_mut(&mut f.manager).unwrap().history_admission = Admission::new(Policy {
        active: 1,
        pending: 4,
        bytes: 8 * 1024 * 1024,
    })
    .unwrap();
    let gate = f.manager.history_admission.clone();
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let request = |token: &str| {
        let owner = gate.fixture_owner("controlled-window", token, &f.row.id);
        let original = owner.clone();
        let admission = gate.clone();
        let received = receipts.clone();
        let progress = Arc::new(move |phase| {
            if phase == HistoryAdmissionState::Starting {
                received
                    .lock()
                    .unwrap()
                    .push(admission.arm_renderer(&original).unwrap());
            }
            Ok(())
        });
        (
            owner.clone(),
            HistoryRequest {
                owner,
                progress,
                preparation_bytes: 0,
            },
        )
    };
    let (first_owner, first) = request("first");
    let permit = f
        .manager
        .admit_cold_history(&f.row, &f.cwd, "first", &[], &f.store, None, first)
        .await
        .unwrap();
    let values = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = values.clone();
    let opened = f
        .manager
        .open_session_admitted_with_mcp(
            &f.row,
            &f.cwd,
            Some("first".into()),
            vec![],
            Arc::new(move |event| sink.lock().unwrap().push(event)),
            &f.store,
            None,
            None,
            None,
            Some(permit),
            None,
            None,
        )
        .await
        .unwrap();
    assert!(
        values
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["update"]["content"]["text"] == "old-load")
    );
    drop(opened);
    assert_eq!(gate.counts().0, 1);
    let (_second_owner, second) = request("second");
    let manager = f.manager.clone();
    let row = f.row.clone();
    let cwd = f.cwd.clone();
    let store = f.store.clone();
    let pending = tokio::spawn(async move {
        manager
            .admit_cold_history(&row, &cwd, "second", &[], &store, None, second)
            .await
    });
    until(|| gate.counts().1 == 1).await;
    assert!(!pending.is_finished());
    assert_eq!(gate.counts().0, 1);
    let receipt_id = receipts.lock().unwrap()[0].receipt_id;
    gate.acknowledge_renderer(&first_owner, receipt_id).unwrap();
    let second = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let second_owner = gate.fixture_owner("controlled-window", "second", &f.row.id);
    let second_receipt = receipts.lock().unwrap()[1].receipt_id;
    drop(second);
    gate.acknowledge_renderer(&second_owner, second_receipt)
        .unwrap();
    assert_eq!(gate.counts(), (0, 0, 0));
}

#[tokio::test]
async fn original_queued_metadata_failure_notifies_before_transport_but_still_requires_its_renderer_fact()
 {
    use crate::acp_client::history_admission_commands::HistoryPreparation;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let mut f = Fixture::new();
    Arc::get_mut(&mut f.manager).unwrap().history_admission = Admission::new(Policy {
        active: 1,
        pending: 4,
        bytes: 8 * 1024 * 1024,
    })
    .unwrap();
    let gate = f.manager.history_admission.clone();
    let hold = gate
        .enqueue(gate.fixture_owner("other", "hold", "other"), 1)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let owner = gate.fixture_owner("window", "stale-metadata", &f.row.id);
    let observed_owner = owner.clone();
    let admission = gate.clone();
    let phases = Arc::new(Mutex::new(Vec::new()));
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let observed = phases.clone();
    let delivered = receipts.clone();
    let request = HistoryRequest {
        owner: owner.clone(),
        preparation_bytes: 0,
        progress: Arc::new(move |phase| {
            observed.lock().unwrap().push(phase);
            match phase {
                HistoryAdmissionState::Starting => delivered
                    .lock()
                    .unwrap()
                    .push(admission.arm_renderer(&observed_owner).unwrap().receipt_id),
                HistoryAdmissionState::NotStarted => {
                    if let Some(receipt) = admission.existing_renderer(&observed_owner).unwrap() {
                        delivered.lock().unwrap().push(receipt.receipt_id);
                    }
                }
                HistoryAdmissionState::Waiting => {}
            }
            Ok(())
        }),
    };
    let mut preparation = HistoryPreparation::new(request.progress.clone());
    let prepared = AtomicUsize::new(0);
    let mut opening = Box::pin(f.manager.prepare_history_open(
        &f.row,
        &f.cwd,
        Some("stale"),
        &[],
        &f.store,
        None,
        Some(request),
        || {
            preparation.ready(); // the exact same pre-transport disarm seam
            prepared.fetch_add(1, Ordering::SeqCst);
        },
    ));
    tokio::select! { result=&mut opening=>panic!("unexpected pregrant result: {}",result.is_ok()), _=until(|| gate.counts().1 == 1)=>{} }
    let mut changed = f.row.clone();
    changed.args.push("--changed-before-grant".into());
    f.store.replace_agent_launch(&changed).unwrap();
    drop(hold);
    assert!(opening.await.err().unwrap().contains("设置已变化"));
    drop(preparation);
    assert_eq!(prepared.load(Ordering::SeqCst), 0);
    assert!(f.manager.lock().unwrap().is_empty());
    assert_eq!(
        *phases.lock().unwrap(),
        vec![
            HistoryAdmissionState::Waiting,
            HistoryAdmissionState::Starting,
            HistoryAdmissionState::NotStarted
        ]
    );
    let receipts = receipts.lock().unwrap().clone();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0], receipts[1]);
    assert_eq!(gate.counts().0, 1);
    gate.acknowledge_renderer(&owner, receipts[0]).unwrap();
    assert_eq!(gate.counts(), (0, 0, 0));
}

#[tokio::test]
async fn actual_preview_ack_does_not_consume_its_exact_native_close_receipt_or_make_it_a_normal_thread()
 {
    use crate::acp_client::history_admission_commands::HistoryPreparation;
    let f = Fixture::new();
    let gate = f.manager.history_admission.clone();
    let owner = gate.fixture_owner("window", "preview-read", &f.row.id);
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
        .admit_cold_history(&f.row, &f.cwd, "preview", &[], &f.store, None, request)
        .await
        .unwrap();
    preparation.ready();
    let received = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events = received.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        events.lock().unwrap().push(body.deserialize::<Value>()?);
        Ok(())
    });
    let preview = crate::acp_client::session_discovery::open_import_preview(
        &f.manager,
        &f.store,
        &f.row,
        &f.cwd,
        "preview".into(),
        "native-preview-close".into(),
        "owned-preview-open",
        channel,
        Some(permit),
    )
    .await
    .unwrap();
    assert_eq!(preview.preview_token, "native-preview-close");
    assert!(
        received
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "history_preview_complete"
                && event["previewToken"] == "native-preview-close"
                && event["openToken"] == "owned-preview-open")
    );
    gate.acknowledge_renderer(&owner, ids.lock().unwrap()[0])
        .unwrap();
    assert_eq!(gate.counts(), (0, 0, 0));
    let connection = f
        .manager
        .session_connection(&f.row.id, &f.cwd, "preview")
        .unwrap();
    assert_eq!(
        connection
            .sessions
            .lock()
            .unwrap()
            .get("preview")
            .unwrap()
            .preview_token
            .as_deref(),
        Some("native-preview-close")
    );
    assert!(
        f.manager
            .close_session_owned(&f.row.id, &f.cwd, "preview", Some("wrong-token"))
            .await
            .is_err()
    );
    assert!(
        f.manager
            .session_connection(&f.row.id, &f.cwd, "preview")
            .is_ok()
    );
    f.manager
        .close_session_owned(&f.row.id, &f.cwd, "preview", Some(&preview.preview_token))
        .await
        .unwrap();
}
