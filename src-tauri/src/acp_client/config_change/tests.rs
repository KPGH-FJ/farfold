use super::*;
use crate::acp_client::{service_connection::ServiceRecord, session_index::session_row_id};
use crate::{
    credentials::ServiceIdentity,
    meta_store::{AgentRow, MetaStore},
};
use serde_json::json;
use sha2::{Digest, Sha256};

fn options(model: &str, thought: &str) -> Value {
    json!([
        {"id":"model","category":"model","type":"select","currentValue":model},
        {"id":"thinking","category":"thought_level","type":"select","currentValue":thought}
    ])
}

fn context() -> (tempfile::TempDir, ConfigStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&directory.path().join("fixture.sqlite3")).unwrap();
    store
        .insert_agent(&AgentRow {
            id: "fixture-agent".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: "/fixture/unused".into(),
            args: vec![],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        })
        .unwrap();
    let endpoint = "https://example.test/v1";
    let api_type = "responses";
    store
        .set_setting(
            "credentials.v1",
            &json!([{
                "id":"fixture-service","label":"Fixture","provider":"Fixture",
                "endpoint":endpoint,"apiType":api_type,"models":["a","b"],
                "secretRef":"fixture-reference-never-read","retired":[],"grants":[],"deleting":false
            }]),
        )
        .unwrap();
    let fingerprint = Sha256::digest(serde_json::to_vec(&(endpoint, api_type)).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let context = ConfigStore {
        store,
        agent_id: "fixture-agent".into(),
        cwd: "/fixture".into(),
        service_record: Some(ServiceRecord::Configured {
            identity: ServiceIdentity {
                id: "fixture-service".into(),
                fingerprint,
                model: "a".into(),
            },
        }),
        expected_model: Some("farfold_fixture/a".into()),
        verified_permission_option: false,
    };
    (directory, context)
}

fn stored(context: &ConfigStore) -> Value {
    context
        .store
        .get_session(&session_row_id(
            &context.agent_id,
            &context.cwd,
            "same-session",
        ))
        .unwrap()
        .unwrap()
        .config_options
        .unwrap()
}

fn identity(context: &ConfigStore) -> &ServiceIdentity {
    match context.service_record.as_ref().unwrap() {
        ServiceRecord::Configured { identity } => identity,
        ServiceRecord::Existing => panic!("the selected service must remain selected"),
    }
}

#[tokio::test]
async fn configuration_change_failed_save_retries_source_and_guard_together() {
    let (directory, mut context) = context();
    let mut guard = ModelGuard::new(&options("farfold_fixture/a", "low"), None, false);
    guard.lock();
    context.save("same-session", guard.record()).await.unwrap();
    let before = stored(&context);
    let original = guard.clone();
    let choice = guard
        .choice_request("model", &json!("farfold_fixture/b"))
        .unwrap()
        .unwrap();
    let candidate_context = context.for_choice(Some(&choice)).await.unwrap();
    let mut pending = None;
    let sql = rusqlite::Connection::open(directory.path().join("fixture.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_change BEFORE UPDATE ON sessions BEGIN SELECT RAISE(FAIL, 'test'); END;").unwrap();
    assert!(
        complete_choice_change(
            "same-session",
            &mut guard,
            &mut context,
            &mut pending,
            &choice,
            &original,
            &candidate_context,
            &options("farfold_fixture/b", "medium"),
            true
        )
        .await
        .is_err()
    );
    assert_eq!(stored(&context), before);
    assert_eq!(context.expected_model.as_deref(), Some("farfold_fixture/a"));
    assert_eq!(identity(&context).model, "a");
    assert_eq!(guard.check().status, "record_failed");
    assert!(!guard.admissible());
    let displayed = guard.current_value();
    assert!(guard.confirmable(&displayed));
    assert!(
        save_confirmed_change("same-session", &mut guard, &mut context, &mut pending)
            .await
            .is_err()
    );
    assert!(guard.confirmable(&displayed));
    assert_eq!(stored(&context), before);
    sql.execute_batch("DROP TRIGGER fail_change;").unwrap();
    save_confirmed_change("same-session", &mut guard, &mut context, &mut pending)
        .await
        .unwrap();
    assert!(pending.is_none());
    assert!(guard.admissible());
    assert_eq!(context.expected_model.as_deref(), Some("farfold_fixture/b"));
    assert_eq!(identity(&context).model, "b");
    assert_eq!(identity(&context).id, identity(&candidate_context).id);
    assert_eq!(
        identity(&context).fingerprint,
        identity(&candidate_context).fingerprint
    );
    let saved = stored(&context);
    assert_eq!(saved["_farfoldService"]["identity"]["model"], "b");
    assert_eq!(saved["choices"], guard.record()["choices"]);
    let restored = ModelGuard::new(&options("farfold_fixture/b", "medium"), Some(&saved), true);
    assert!(restored.admissible());
}

#[tokio::test]
async fn configuration_change_undelivered_reply_never_saves_or_authorizes() {
    let (_directory, mut context) = context();
    let mut guard = ModelGuard::new(&options("farfold_fixture/a", "low"), None, false);
    guard.lock();
    context.save("same-session", guard.record()).await.unwrap();
    let before = stored(&context);
    let original = guard.clone();
    let choice = guard
        .choice_request("model", &json!("farfold_fixture/b"))
        .unwrap()
        .unwrap();
    let candidate_context = context.for_choice(Some(&choice)).await.unwrap();
    let mut pending = None;
    assert!(
        complete_choice_change(
            "same-session",
            &mut guard,
            &mut context,
            &mut pending,
            &choice,
            &original,
            &candidate_context,
            &options("farfold_fixture/b", "medium"),
            false
        )
        .await
        .is_err()
    );
    assert_eq!(stored(&context), before);
    assert_eq!(identity(&context).model, "a");
    assert!(pending.is_none());
    assert!(!guard.confirmable(&guard.current_value()));
    assert!(!guard.admissible());
}

#[tokio::test]
async fn configuration_change_draft_selection_does_not_create_an_index() {
    let (_directory, mut context) = context();
    let mut guard = ModelGuard::new(&options("farfold_fixture/a", "low"), None, false);
    let original = guard.clone();
    let choice = guard
        .choice_request("model", &json!("farfold_fixture/b"))
        .unwrap()
        .unwrap();
    let candidate_context = context.for_choice(Some(&choice)).await.unwrap();
    let mut pending = None;
    complete_choice_change(
        "same-session",
        &mut guard,
        &mut context,
        &mut pending,
        &choice,
        &original,
        &candidate_context,
        &options("farfold_fixture/b", "medium"),
        true,
    )
    .await
    .unwrap();
    assert!(guard.admissible());
    assert!(!guard.is_established());
    assert_eq!(identity(&context).model, "b");
    assert!(
        context
            .store
            .get_session(&session_row_id(
                &context.agent_id,
                &context.cwd,
                "same-session"
            ))
            .unwrap()
            .is_none()
    );
}
