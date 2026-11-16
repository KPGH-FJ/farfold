use super::*;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

const SECRET: &str = "synthetic-protected-value=kept-exact";
#[derive(Default)]
struct MemoryVault {
    values: RefCell<HashMap<String, String>>,
    puts: Cell<usize>,
    fail_put: Cell<usize>,
    fail_delete: Cell<bool>,
}
impl Vault for MemoryVault {
    fn put(&self, service: &str, value: &str) -> Result<(), String> {
        let count = self.puts.get() + 1;
        self.puts.set(count);
        if count == self.fail_put.get() {
            return Err(SECRET.into());
        }
        self.values
            .borrow_mut()
            .insert(service.into(), value.into());
        Ok(())
    }
    fn delete(&self, service: &str) -> Result<(), String> {
        if self.fail_delete.get() {
            return Err(SECRET.into());
        }
        self.values.borrow_mut().remove(service);
        Ok(())
    }
}
fn row() -> AgentRow {
    AgentRow {
        id: String::new(),
        name: "synthetic".into(),
        source: "custom".into(),
        command: "/synthetic/program".into(),
        args: vec![],
        env: vec![
            ("PUBLIC_OPTION".into(), "  exact value =  ".into()),
            ("EMPTY".into(), "".into()),
        ],
        version: None,
        handshake: None,
        created_at: 1,
        updated_at: 1,
    }
}
fn protected() -> Vec<(String, String)> {
    vec![("UNCLASSIFIED_NAME".into(), SECRET.into())]
}
fn setup() -> (tempfile::TempDir, MetaStore, rusqlite::Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.sqlite3");
    let store = MetaStore::open(&path).unwrap();
    let connection = rusqlite::Connection::open(path).unwrap();
    (dir, store, connection)
}

#[test]
fn explicitly_protected_values_never_enter_roster_or_pending_metadata() {
    let (_dir, store, sql) = setup();
    let vault = MemoryVault::default();
    let saved = register_with(&store, row(), &protected(), &vault).unwrap();
    assert_eq!(&saved.env[..2], &row().env);
    assert_eq!(
        saved.env[2],
        ("UNCLASSIFIED_NAME".into(), KEYCHAIN_MARKER.into())
    );
    assert!(!serde_json::to_string(&saved).unwrap().contains(SECRET));
    let raw: String = sql
        .query_row("SELECT env FROM agents", [], |row| row.get(0))
        .unwrap();
    assert!(!raw.contains(SECRET));
    assert!(store.list_settings().unwrap().is_empty());
    let resolved = super::super::resolve_agent_env_with(&saved.id, &saved.env, &|service| {
        vault.values.borrow().get(service).cloned()
    })
    .unwrap();
    assert_eq!(&resolved[..2], &row().env);
    assert_eq!(resolved[2], protected()[0]);
}

#[test]
fn ordinary_values_are_not_classified_or_migrated_by_name() {
    let store = MetaStore::test_memory();
    let vault = MemoryVault::default();
    let mut input = row();
    input
        .env
        .push(("PROVIDER_API_KEY".into(), "explicitly-ordinary".into()));
    let saved = register_with(&store, input.clone(), &[], &vault).unwrap();
    assert_eq!(saved.env, input.env);
    assert_eq!(vault.puts.get(), 0);
    assert!(vault.values.borrow().is_empty());
}

#[test]
fn missing_or_empty_protected_values_reject_the_whole_environment() {
    let env = vec![
        ("OPTION".into(), "unchanged".into()),
        ("TOKEN".into(), KEYCHAIN_MARKER.into()),
    ];
    for missing in [None, Some(String::new())] {
        assert!(
            super::super::resolve_agent_env_with("synthetic", &env, &|_| missing.clone()).is_err()
        );
    }
}

#[test]
fn partial_vault_write_rolls_back_and_sanitizes_errors() {
    let store = MetaStore::test_memory();
    let vault = MemoryVault::default();
    vault.fail_put.set(2);
    let secrets = vec![
        ("FIRST".into(), SECRET.into()),
        ("SECOND".into(), "synthetic-second".into()),
    ];
    let error = register_with(&store, row(), &secrets, &vault).unwrap_err();
    assert!(!error.contains(SECRET));
    assert!(store.list_agents().unwrap().is_empty());
    assert!(vault.values.borrow().is_empty());
    assert!(store.list_settings().unwrap().is_empty());
}

#[test]
fn pending_write_failure_precedes_all_vault_side_effects() {
    let (_dir, store, sql) = setup();
    sql.execute_batch("CREATE TRIGGER deny_pending BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    let vault = MemoryVault::default();
    assert!(register_with(&store, row(), &protected(), &vault).is_err());
    assert_eq!(vault.puts.get(), 0);
    assert!(store.list_agents().unwrap().is_empty());
}

#[test]
fn roster_insert_failure_removes_every_written_secret() {
    let (_dir, store, sql) = setup();
    sql.execute_batch("CREATE TRIGGER deny_agent BEFORE INSERT ON agents BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    let vault = MemoryVault::default();
    assert!(register_with(&store, row(), &protected(), &vault).is_err());
    assert!(store.list_agents().unwrap().is_empty());
    assert!(vault.values.borrow().is_empty());
    assert!(store.list_settings().unwrap().is_empty());
}

#[test]
fn publication_and_pending_removal_are_atomic_and_retryable() {
    let (_dir, store, sql) = setup();
    sql.execute_batch("CREATE TRIGGER deny_cleanup BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    let vault = MemoryVault::default();
    assert!(register_with(&store, row(), &protected(), &vault).is_err());
    assert!(
        store.list_agents().unwrap().is_empty(),
        "insert must roll back with pending cleanup"
    );
    assert!(vault.values.borrow().is_empty());
    assert_eq!(pending_entries(&store).unwrap().len(), 1);
    sql.execute_batch("DROP TRIGGER deny_cleanup").unwrap();
    let saved = register_with(&store, row(), &protected(), &vault).unwrap();
    assert_eq!(store.list_agents().unwrap(), vec![saved]);
    assert!(pending_entries(&store).unwrap().is_empty());
    assert_eq!(vault.values.borrow().len(), 1);
}

#[test]
fn failed_cleanup_keeps_only_exact_ownership_and_retry_deletes_orphans() {
    let store = MetaStore::test_memory();
    let vault = MemoryVault::default();
    vault.fail_put.set(2);
    vault.fail_delete.set(true);
    let secrets = vec![
        ("FIRST".into(), SECRET.into()),
        ("SECOND".into(), "synthetic-second".into()),
    ];
    assert!(register_with(&store, row(), &secrets, &vault).is_err());
    assert!(store.list_agents().unwrap().is_empty());
    assert_eq!(vault.values.borrow().len(), 1);
    assert_eq!(secret_services(&store).unwrap().len(), 2);
    assert!(
        !serde_json::to_string(&store.list_settings().unwrap())
            .unwrap()
            .contains(SECRET)
    );
    // Unrelated ordinary registration must not access the unavailable vault.
    register_with(&store, row(), &[], &vault).unwrap();
    assert_eq!(pending_entries(&store).unwrap().len(), 1);
    vault.fail_delete.set(false);
    let saved = register_with(&store, row(), &protected(), &vault).unwrap();
    assert_eq!(vault.values.borrow().len(), 1);
    assert!(
        vault
            .values
            .borrow()
            .contains_key(&env_keychain_service(&saved.id, "UNCLASSIFIED_NAME"))
    );
    assert!(pending_entries(&store).unwrap().is_empty());
}

#[test]
fn interrupted_registration_is_included_in_data_reset() {
    let (dir, store, _sql) = setup();
    let vault = MemoryVault::default();
    let pending_id = "custom-0123456789abcdef0123456789abcdef";
    let service = env_keychain_service(pending_id, "TOKEN");
    store
        .set_setting(
            &format!("{PENDING_PREFIX}{pending_id}"),
            &serde_json::json!(["TOKEN"]),
        )
        .unwrap();
    vault.put(&service, SECRET).unwrap();
    crate::data_reset::clear_owned(dir.path(), &store, &|name| vault.delete(name)).unwrap();
    assert!(vault.values.borrow().is_empty());
    assert!(store.list_settings().unwrap().is_empty());
}

#[test]
fn removal_retains_references_on_failure_and_only_deletes_owned_values() {
    let store = MetaStore::test_memory();
    let vault = MemoryVault::default();
    let saved = register_with(&store, row(), &protected(), &vault).unwrap();
    let other = register_with(&store, row(), &protected(), &vault).unwrap();
    vault.fail_delete.set(true);
    assert!(remove_agent_with(&store, &saved.id, &vault).is_err());
    assert_eq!(store.get_agent(&saved.id).unwrap(), Some(saved.clone()));
    vault.fail_delete.set(false);
    assert!(remove_agent_with(&store, &saved.id, &vault).unwrap());
    assert!(store.get_agent(&saved.id).unwrap().is_none());
    assert_eq!(store.get_agent(&other.id).unwrap(), Some(other.clone()));
    assert_eq!(vault.values.borrow().len(), 1);
    assert!(
        vault
            .values
            .borrow()
            .contains_key(&env_keychain_service(&other.id, "UNCLASSIFIED_NAME"))
    );
}

#[test]
fn malformed_pending_ownership_never_selects_a_vault_target() {
    let store = MetaStore::test_memory();
    let vault = MemoryVault::default();
    store
        .set_setting(
            &format!("{PENDING_PREFIX}external-service"),
            &serde_json::json!(["TOKEN"]),
        )
        .unwrap();
    assert!(register_with(&store, row(), &protected(), &vault).is_err());
    assert_eq!(vault.puts.get(), 0);
    assert!(secret_services(&store).is_err());
}

#[test]
fn secret_input_is_explicit_and_never_aliases_an_ordinary_reference() {
    for (ordinary, secrets) in [
        (vec![("TOKEN".into(), KEYCHAIN_MARKER.into())], vec![]),
        (
            vec![("SAME".into(), "public".into())],
            vec![("SAME".into(), SECRET.into())],
        ),
        (
            vec![],
            vec![
                ("SAME".into(), SECRET.into()),
                ("SAME".into(), SECRET.into()),
            ],
        ),
        (vec![], vec![("TOKEN".into(), String::new())]),
        (vec![], vec![("TOKEN".into(), "line1\nline2".into())]),
        (vec![("1INVALID".into(), "value".into())], vec![]),
    ] {
        assert!(validate(&ordinary, &secrets).is_err());
    }
    // The marker text can itself be a secret value; only the ordinary channel
    // reserves it as metadata, so no input can forge a lookup.
    assert!(validate(&[], &[("TOKEN".into(), KEYCHAIN_MARKER.into())]).is_ok());
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "uses only randomly owned synthetic system credentials; run explicitly for installed-batch verification"]
fn macos_system_vault_custom_environment_registration_and_removal() {
    // Record exact service names before each vault side effect. Drop retries
    // deletion even if registration or any assertion fails; no account entry
    // can be selected by a prefix or enumerated from the system vault.
    #[derive(Default)]
    struct OwnedSyntheticVault {
        services: RefCell<Vec<String>>,
    }
    impl OwnedSyntheticVault {
        fn cleanup(&self) -> Result<(), String> {
            for service in self.services.borrow().iter() {
                SystemVault.delete(service)?;
            }
            Ok(())
        }
    }
    impl Vault for OwnedSyntheticVault {
        fn put(&self, service: &str, value: &str) -> Result<(), String> {
            self.services.borrow_mut().push(service.to_owned());
            SystemVault.put(service, value)
        }
        fn delete(&self, service: &str) -> Result<(), String> {
            SystemVault.delete(service)
        }
    }
    impl Drop for OwnedSyntheticVault {
        fn drop(&mut self) {
            if self.cleanup().is_err() {
                eprintln!(
                    "synthetic credential cleanup failed; exact owned services: {:?}",
                    self.services.borrow()
                );
            }
        }
    }
    let (_dir, store, sql) = setup();
    let vault = OwnedSyntheticVault::default();
    let value = "FARFOLD-NON-ACCOUNT-ENV-CLOSURE-FIXTURE";
    let saved = register_with(
        &store,
        row(),
        &[("SYNTHETIC_VALUE".into(), value.into())],
        &vault,
    )
    .expect("synthetic registration");
    let service = env_keychain_service(&saved.id, "SYNTHETIC_VALUE");
    assert!(
        saved
            .env
            .iter()
            .any(|(name, value)| name == "SYNTHETIC_VALUE" && value == KEYCHAIN_MARKER)
    );
    assert!(!serde_json::to_string(&saved).unwrap().contains(value));
    let raw: String = sql
        .query_row("SELECT env FROM agents WHERE id=?1", [&saved.id], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(!raw.contains(value));
    assert!(store.list_settings().unwrap().is_empty());
    let resolved =
        super::super::resolve_agent_env(&saved.id, &saved.env).expect("synthetic lookup");
    assert!(
        resolved
            .iter()
            .any(|(name, actual)| name == "SYNTHETIC_VALUE" && actual == value)
    );
    assert!(remove_agent_with(&store, &saved.id, &vault).expect("synthetic removal"));
    assert!(store.get_agent(&saved.id).unwrap().is_none());
    assert!(super::super::keychain_lookup(&service).is_none());
    vault.cleanup().expect("synthetic cleanup");
}
