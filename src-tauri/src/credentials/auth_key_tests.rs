use super::*;
use std::cell::{Cell, RefCell};

#[derive(Default)]
struct Fake {
    values: RefCell<HashMap<String, String>>,
    reads: Cell<usize>,
}

impl Vault for Fake {
    fn put(&self, id: &str, key: &str) -> Result<(), String> {
        self.values.borrow_mut().insert(id.into(), key.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Option<String> {
        self.reads.set(self.reads.get() + 1);
        self.values.borrow().get(id).cloned()
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.values.borrow_mut().remove(id);
        Ok(())
    }
}

fn store() -> (tempfile::TempDir, MetaStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&directory.path().join("metadata.sqlite3")).unwrap();
    (directory, store)
}

#[test]
fn method_key_save_is_reference_only_and_has_no_service_or_environment_authority() {
    let (_directory, store) = store();
    let vault = Fake::default();
    let view = save_auth_key_with(&store, &vault, "openai", "login", "synthetic-key").unwrap();
    assert_eq!(vault.reads.get(), 0);
    assert!(!view.complete);
    assert_eq!(view.purpose.as_deref(), Some("authentication"));
    assert!(view.endpoint.is_empty() && view.api_type.is_empty() && view.models.is_empty());
    assert!(view.grants.is_empty());
    assert!(
        !serde_json::to_string(&view)
            .unwrap()
            .contains("synthetic-key")
    );
    assert!(
        !store
            .get_setting(SETTING)
            .unwrap()
            .unwrap()
            .to_string()
            .contains("synthetic-key")
    );
    assert_eq!(
        auth_key_with(&store, &vault, &view.id, &view.revision, "openai").unwrap(),
        "synthetic-key"
    );
    let mut environment = HashMap::new();
    apply_with(&store, "selected-agent", &mut environment, &vault).unwrap();
    assert!(environment.is_empty());
}

#[test]
fn stale_wrong_provider_service_granted_and_deleted_references_never_read_key() {
    let (_directory, store) = store();
    let vault = Fake::default();
    let view = save_auth_key_with(&store, &vault, "openai", "login", "synthetic-key").unwrap();
    for (revision, provider) in [("stale", "openai"), (view.revision.as_str(), "other")] {
        assert!(auth_key_with(&store, &vault, &view.id, revision, provider).is_err());
    }
    let original = read(&store).unwrap();
    for variant in 0..5 {
        let mut pool = original.clone();
        match variant {
            0 => pool[0].endpoint = "https://example.test".into(),
            1 => pool[0].api_type = "responses".into(),
            2 => pool[0].models.push("model".into()),
            3 => pool[0].grants.push(Grant {
                agent_id: "a".into(),
                env_name: "TOKEN".into(),
                override_existing: false,
            }),
            _ => pool[0].deleting = true,
        }
        write(&store, &pool).unwrap();
        assert!(
            auth_key_with(
                &store,
                &vault,
                &view.id,
                &View::from(&pool[0]).revision,
                "openai"
            )
            .is_err()
        );
    }
    assert_eq!(vault.reads.get(), 0);
}

#[test]
fn missing_key_is_recoverable_and_rotation_invalidates_old_selection() {
    let (_directory, store) = store();
    let vault = Fake::default();
    let view = save_auth_key_with(&store, &vault, "openai", "login", "synthetic-key").unwrap();
    vault.values.borrow_mut().clear();
    assert!(auth_key_with(&store, &vault, &view.id, &view.revision, "openai").is_err());
    let mut pool = read(&store).unwrap();
    vault.put("replacement", "replacement-key").unwrap();
    pool[0].secret_ref = "replacement".into();
    write(&store, &pool).unwrap();
    let before = vault.reads.get();
    assert!(auth_key_with(&store, &vault, &view.id, &view.revision, "openai").is_err());
    assert_eq!(vault.reads.get(), before);
    let current = View::from(&pool[0]);
    assert_eq!(
        auth_key_with(&store, &vault, &current.id, &current.revision, "openai").unwrap(),
        "replacement-key"
    );
}

#[test]
fn method_provider_is_part_of_selection_identity_and_cannot_be_reassigned_by_service_editor() {
    let (_directory, store) = store();
    let vault = Fake::default();
    let view = save_auth_key_with(&store, &vault, "openai", "login", "synthetic-key").unwrap();
    let mut pool = read(&store).unwrap();
    let original = View::from(&pool[0]);
    pool[0].provider = "other".into();
    assert_ne!(View::from(&pool[0]).revision, original.revision);
    let result = save(
        &store,
        &vault,
        SaveInput {
            id: Some(view.id),
            label: "changed".into(),
            provider: "other".into(),
            endpoint: String::new(),
            api_type: String::new(),
            key: String::new(),
            models: vec![],
        },
    );
    assert!(result.is_err());
    assert_eq!(read(&store).unwrap()[0].provider, "openai");
    assert_eq!(vault.reads.get(), 0);
}

#[test]
fn rejected_input_does_not_change_existing_pool() {
    let (_directory, store) = store();
    let vault = Fake::default();
    save_auth_key_with(&store, &vault, "openai", "kept", "kept-key").unwrap();
    let before = store.get_setting(SETTING).unwrap();
    for (label, key) in [("", "new-key"), ("login", ""), ("login", "bad\nkey")] {
        assert!(save_auth_key_with(&store, &vault, "openai", label, key).is_err());
    }
    assert_eq!(store.get_setting(SETTING).unwrap(), before);
    assert_eq!(vault.values.borrow().len(), 1);
}

#[test]
fn unreadable_pool_is_preserved_and_failed_metadata_write_removes_new_vault_value() {
    let (directory, store) = store();
    let vault = Fake::default();
    let corrupt = serde_json::json!({"unexpected":"preserve-this"});
    store.set_setting(SETTING, &corrupt).unwrap();
    assert!(save_auth_key_with(&store, &vault, "openai", "login", "synthetic-key").is_err());
    assert_eq!(store.get_setting(SETTING).unwrap(), Some(corrupt));
    assert!(vault.values.borrow().is_empty());
    store.set_setting(SETTING, &serde_json::json!([])).unwrap();
    let database = rusqlite::Connection::open(directory.path().join("metadata.sqlite3")).unwrap();
    database.execute_batch("CREATE TRIGGER deny_credential_write BEFORE INSERT ON settings WHEN NEW.key = 'credentials.v1' BEGIN SELECT RAISE(ABORT, 'fixture'); END;").unwrap();
    assert!(save_auth_key_with(&store, &vault, "openai", "login", "synthetic-key").is_err());
    assert!(vault.values.borrow().is_empty());
    assert_eq!(
        store.get_setting(SETTING).unwrap(),
        Some(serde_json::json!([]))
    );
}
