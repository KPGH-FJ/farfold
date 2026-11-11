//! Temporary owned program directories, synthetic references and injected vault reads.
use super::*;

struct Fixture {
    _directory: tempfile::TempDir,
    data: PathBuf,
    root: PathBuf,
    store: MetaStore,
    installation: String,
    consumer: AgentRow,
}
impl Fixture {
    fn new(protected: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().canonicalize().unwrap();
        let root = data.join("agents/opencode/old");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("program"), "synthetic-program").unwrap();
        let store = MetaStore::open(&data.join("synthetic.sqlite3")).unwrap();
        let target = AgentRow {
            id: "opencode".into(),
            name: "synthetic".into(),
            source: "registry".into(),
            command: root.join("program").display().to_string(),
            args: vec![],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 1,
            updated_at: 1,
        };
        record(&store, &target, &root).unwrap();
        let installation = read(&store).unwrap()[0].id.clone();
        let consumer = AgentRow {
            id: "custom-synthetic".into(),
            source: "custom".into(),
            command: "/external/program".into(),
            env: vec![(
                "COMPANION".into(),
                if protected {
                    crate::auth::KEYCHAIN_MARKER.into()
                } else {
                    root.join("program").display().to_string()
                },
            )],
            ..target
        };
        store.insert_agent(&consumer).unwrap();
        Self {
            _directory: directory,
            data,
            root,
            store,
            installation,
            consumer,
        }
    }
    fn remove(&self, lookup: &dyn Fn(&str) -> Option<String>) -> Result<(), String> {
        remove_installed_with_lookup(
            &self.store,
            &self.data,
            "opencode",
            &self.installation,
            lookup,
        )
    }
}

#[test]
fn protected_program_dependency_prevents_deletion_without_persisting_its_value() {
    let f = Fixture::new(true);
    let path = f.root.join("program").display().to_string();
    assert!(
        f.remove(&|service| {
            assert_eq!(
                service,
                crate::auth::env_keychain_service(&f.consumer.id, "COMPANION")
            );
            Some(path.clone())
        })
        .is_err()
    );
    assert!(f.root.join("program").exists());
    assert_eq!(
        f.store.get_agent(&f.consumer.id).unwrap(),
        Some(f.consumer.clone())
    );
    assert_eq!(read(&f.store).unwrap().len(), 1);
}

#[test]
fn missing_protected_value_keeps_owned_program_and_receipt_for_retry() {
    let f = Fixture::new(true);
    let error = f.remove(&|_| None).unwrap_err();
    assert!(!error.contains("COMPANION"));
    assert!(f.root.exists());
    assert_eq!(read(&f.store).unwrap().len(), 1);
    f.remove(&|_| Some("synthetic-unrelated-value".into()))
        .unwrap();
    assert!(!f.root.exists());
    assert!(read(&f.store).unwrap().is_empty());
    assert_eq!(f.store.get_agent(&f.consumer.id).unwrap(), Some(f.consumer));
}

#[test]
fn ordinary_program_dependencies_keep_the_previous_check_and_never_read_the_vault() {
    let f = Fixture::new(false);
    assert!(
        f.remove(&|_| panic!("ordinary values do not read the vault"))
            .is_err()
    );
    assert!(f.root.join("program").exists());
}

#[tokio::test]
async fn uninstall_worker_blocks_clear_until_its_blocking_work_finishes() {
    let gate = std::sync::Arc::new(crate::managed_update::UpdateAdmission::default());
    let held = gate.activity().unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker = tokio::spawn(uninstall_owned(held, move || {
        started.send(()).unwrap();
        wait.recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        Ok(())
    }));
    tokio::time::timeout(std::time::Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    let clear_was_blocked = gate.update().is_err();
    release.send(()).unwrap();
    worker.await.unwrap().unwrap();
    assert!(clear_was_blocked);
    assert!(gate.update().is_ok());
}

#[test]
fn path_list_entries_protect_programs_in_both_environment_channels() {
    for protected in [true, false] {
        let f = Fixture::new(protected);
        let path = std::env::join_paths([f.data.join("unrelated"), f.root.clone()])
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut consumer = f.consumer.clone();
        consumer.env = vec![(
            "PATH".into(),
            if protected {
                crate::auth::KEYCHAIN_MARKER.into()
            } else {
                path.clone()
            },
        )];
        f.store.replace_agent_launch(&consumer).unwrap();
        assert!(
            f.remove(&|_| Some(path.clone())).is_err(),
            "PATH's later segments must keep the selected program"
        );
        assert!(f.root.join("program").exists());
    }
}

#[test]
fn unrelated_path_lists_do_not_block_the_explicit_owned_uninstall() {
    for protected in [true, false] {
        let f = Fixture::new(protected);
        let path = std::env::join_paths([f.data.join("external-one"), f.data.join("external-two")])
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut consumer = f.consumer.clone();
        consumer.env = vec![(
            "PATH".into(),
            if protected {
                crate::auth::KEYCHAIN_MARKER.into()
            } else {
                path.clone()
            },
        )];
        f.store.replace_agent_launch(&consumer).unwrap();
        let before = f.store.get_agent(&consumer.id).unwrap();
        f.remove(&|_| Some(path.clone())).unwrap();
        assert!(!f.root.exists());
        assert_eq!(f.store.get_agent(&consumer.id).unwrap(), before);
    }
}
