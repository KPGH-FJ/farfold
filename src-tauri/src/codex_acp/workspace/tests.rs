use super::*;
use crate::codex_acp::{threads::tests::scope, turns::tests::Fixture};

#[test]
fn unbound_workspace_does_not_borrow_live_session_or_enable_any_operation() {
    let f = Fixture::new("turn_complete");
    let snapshot = f.runtime.workspace_snapshot(&f.store, None).unwrap();
    let value = serde_json::to_value(snapshot).unwrap();
    assert!(value["target"].is_null());
    assert!(value["scope"].is_null());
    assert!(value["admission"].is_null());
    assert_eq!(value["connectionState"], "disconnected");
    assert!(
        value["capabilities"]
            .as_object()
            .unwrap()
            .values()
            .all(|v| v == &json!(false))
    );
    assert_eq!(f.count(), 0);
}

#[test]
fn original_target_read_is_scoped_cached_and_still_closed_when_synthetic_model_confirmed() {
    let f = Fixture::new("turn_complete");
    let before = f.runtime.workspace_snapshot(&f.store, Some(&f.id)).unwrap();
    let value = serde_json::to_value(before).unwrap();
    assert_eq!(value["target"]["farfoldSessionId"], f.id.as_str());
    assert_eq!(
        value["target"]["runtime"]["adapterId"],
        "codex-acp-stdio-v1"
    );
    assert_eq!(value["scope"], json!(scope(1)));
    assert_eq!(value["connectionState"], "connected");
    assert!(value["admission"]["actual"].is_object());
    assert_eq!(
        value["admission"]["actual"]["nativeSessionId"],
        value["target"]["nativeTreeId"]
    );
    assert!(f.runtime.require_workspace_open(&f.store, &f.id).is_err());
    assert_eq!(f.count(), 0);
    let text = value.to_string();
    for forbidden in [
        "authUrl",
        "userCode",
        "loginId",
        "apiKey",
        "credentialState",
    ] {
        assert!(!text.contains(&format!("\"{forbidden}\":")));
    }
    f.runtime.stop(&scope(1)).unwrap();
    let stopped =
        serde_json::to_value(f.runtime.workspace_snapshot(&f.store, Some(&f.id)).unwrap()).unwrap();
    assert_eq!(stopped["connectionState"], "disconnected");
    assert!(stopped["admission"].is_null());
    assert!(stopped["scope"].is_null());
    assert_eq!(stopped["target"], value["target"]);
}

#[test]
fn workspace_unknown_is_not_ready_and_wrong_session_never_falls_back() {
    let f = Fixture::new("turn_complete");
    let other = FarfoldSessionId::parse("missing-session").unwrap();
    assert!(
        f.runtime
            .workspace_snapshot(&f.store, Some(&other))
            .is_err()
    );
    let handle = f.runtime.connection().unwrap();
    handle.lock().unwrap().turns.unknown = true;
    let s =
        serde_json::to_value(f.runtime.workspace_snapshot(&f.store, Some(&f.id)).unwrap()).unwrap();
    assert_eq!(s["connectionState"], "unknown");
    assert!(s["admission"].is_null());
    assert!(!s["capabilities"]["submitTurn"].as_bool().unwrap());
    let mut binding = scope(1).binding().unwrap();
    binding.adapter_id = crate::host_ids::AdapterId::parse("codex-app-server").unwrap();
    assert!(!is_binding(&binding));
}

#[test]
fn active_turn_projection_retains_original_host_and_native_identities() {
    let f = Fixture::new("turn_complete");
    let host_id = f.start();
    let s =
        serde_json::to_value(f.runtime.workspace_snapshot(&f.store, Some(&f.id)).unwrap()).unwrap();
    assert_eq!(s["activeTurn"]["context"]["hostTurnId"], host_id.as_str());
    assert_eq!(
        s["activeTurn"]["context"]["farfoldSessionId"],
        f.id.as_str()
    );
    assert!(s["activeTurn"]["nativeTurnId"].is_string());
    assert_eq!(
        s["activeTurn"]["context"]["thread"]["nativeSessionId"],
        s["target"]["nativeTreeId"]
    );
    f.settle();
    let s =
        serde_json::to_value(f.runtime.workspace_snapshot(&f.store, Some(&f.id)).unwrap()).unwrap();
    assert!(s["activeTurn"].is_null());
}
