//! Production capability projection; no installed CLI or Agent is executed.
use super::*;

fn unsupported_row() -> crate::meta_store::AgentRow {
    crate::meta_store::AgentRow {
        id: "unreviewed-p40-control".into(),
        name: "control".into(),
        source: "custom".into(),
        command: "/not/executed".into(),
        args: vec![],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn p40_management_entry_reports_unsupported_instead_of_omitting_the_operation() {
    let wire = serde_json::to_value(launch::capabilities(&unsupported_row()).unwrap()).unwrap();
    assert_eq!(
        wire["pluginManagement"],
        serde_json::json!({
            "availability": "unavailable", "source": null,
            "reason": "notReviewed", "support": "unverified"
        })
    );
}

#[test]
fn p40_management_preserves_the_existing_unsupported_inventory_control() {
    let wire = serde_json::to_value(launch::capabilities(&unsupported_row()).unwrap()).unwrap();
    assert_eq!(wire["mcpInventory"]["reason"], "notReviewed");
    assert!(wire["selectionId"].is_null());
}

#[test]
fn p40_skill_preference_removal_uses_reviewed_capability_and_may_be_omitted() {
    let mut capabilities = launch::capabilities(&unsupported_row()).unwrap();
    let wire = serde_json::to_value(&capabilities).unwrap();
    assert_eq!(
        wire["skillPreferenceRemoval"],
        serde_json::json!({"availability":"unavailable","source":null,"reason":"notReviewed"})
    );
    capabilities.skill_preference_removal = None;
    assert!(
        serde_json::to_value(capabilities)
            .unwrap()
            .get("skillPreferenceRemoval")
            .is_none()
    );
}
