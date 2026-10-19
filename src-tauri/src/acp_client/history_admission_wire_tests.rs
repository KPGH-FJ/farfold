use super::*;
#[test]
fn phase_and_cancel_wire_keep_only_the_exact_operation_contract() {
    let phases: Vec<_> = [
        HistoryAdmissionState::Waiting,
        HistoryAdmissionState::Starting,
    ]
    .into_iter()
    .map(|phase| {
        serde_json::to_value(HistoryAdmissionPhase {
            kind: "session_history_admission",
            open_token: "controlled-token".into(),
            phase,
            history_delivery: None,
        })
        .unwrap()
    })
    .collect();
    assert_eq!(
        phases,
        serde_json::json!([
            {"kind":"session_history_admission","openToken":"controlled-token","phase":"waiting"},
            {"kind":"session_history_admission","openToken":"controlled-token","phase":"starting"}
        ])
        .as_array()
        .unwrap()
        .clone()
    );
    let replies: Vec<_> = ["cancelledWaiting", "alreadyStarting", "notFound"]
        .into_iter()
        .map(|outcome| {
            serde_json::to_value(HistoryCancelReply {
                open_token: "controlled-token".into(),
                outcome,
            })
            .unwrap()
        })
        .collect();
    assert_eq!(
        replies,
        serde_json::json!([
            {"openToken":"controlled-token","outcome":"cancelledWaiting"},
            {"openToken":"controlled-token","outcome":"alreadyStarting"},
            {"openToken":"controlled-token","outcome":"notFound"}
        ])
        .as_array()
        .unwrap()
        .clone()
    );
    eprintln!(
        "cold-history-actual-wire={}",
        serde_json::json!({"phases":phases,"cancelReplies":replies})
    );
}

#[test]
fn original_private_receipt_is_separate_from_phase_and_never_contains_agent_body_or_preview_permission()
 {
    for phase in [
        HistoryAdmissionState::Starting,
        HistoryAdmissionState::NotStarted,
    ] {
        let value = serde_json::to_value(HistoryAdmissionPhase {
            kind: "session_history_admission",
            open_token: "controlled-token".into(),
            phase,
            history_delivery: Some(super::super::history_admission::HistoryDeliveryReceipt {
                receipt_id: 1,
                open_token: "controlled-token".into(),
            }),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "kind":"session_history_admission","openToken":"controlled-token",
                "phase":if phase == HistoryAdmissionState::Starting {"starting"} else {"notStarted"},
                "historyDelivery":{"receiptId":1,"openToken":"controlled-token"},
            })
        );
    }
}
