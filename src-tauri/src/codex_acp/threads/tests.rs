use super::*;
use crate::{acp_runtime::AcpLifecycle, host_ids::WorkingCopyId};
use crate::{
    host_ids::*,
    host_store::{HostStore, records::*, runtime_owned_profile::*},
    runtime_registry::RuntimeBinding,
};
use std::{os::unix::fs::PermissionsExt, sync::Mutex};

mod registration;

pub(crate) fn shared_profile(
    store: &HostStore,
    workspace: &Workspace,
    home: &Path,
    create: bool,
) -> u64 {
    let s = scope(1);
    let binding = RuntimeBinding {
        product_id: RuntimeProductId::parse(&s.runtime_product_id).unwrap(),
        installation_id: InstallationId::parse(&s.installation_id).unwrap(),
        runtime_build_id: RuntimeBuildId::parse(&s.runtime_build_id).unwrap(),
        adapter_id: AdapterId::parse(&s.adapter_id).unwrap(),
        connection_id: ConnectionId::parse(&s.connection_id).unwrap(),
    };
    let profile = RuntimeOwnedProfile {
        profile_id: RuntimeProfileId::parse(&s.profile_id).unwrap(),
        layout: OwnedProfileLayout::StableV1,
        binding: binding.clone(),
        bootstrap_managed_provider: None,
    };
    if create {
        store
            .register_runtime_owned_profile(
                &RuntimeRegistration {
                    runtime_product_id: binding.product_id,
                    installation_id: binding.installation_id,
                    runtime_build_id: binding.runtime_build_id,
                    adapter_id: binding.adapter_id,
                    connection_id: binding.connection_id,
                    display_name: "Codex".into(),
                    distribution: RuntimeDistribution::System,
                    observed_version: "0.143.0".into(),
                    artifact_sha256: NATIVE_SHA.into(),
                    connection_label: "Synthetic Codex".into(),
                    connection_kind: RuntimeConnectionKind::SystemLocal,
                    created_at: 1,
                    verified_at: 1,
                },
                &profile,
            )
            .unwrap();
    }
    store
        .reserve_owned_profile_launch(
            &profile,
            &OwnedProfileLaunch {
                home: home.into(),
                runtime_home: home.join("codex"),
                node: "/synthetic/node".into(),
                adapter: "/synthetic/adapter".into(),
                native: "/synthetic/native".into(),
                cwd: workspace.cwd.clone(),
                working_copy_id: workspace.working_copy_id.clone().unwrap(),
                adapter_version: ADAPTER_VERSION.into(),
                adapter_modules: std::collections::BTreeMap::from([(
                    "adapter.mjs".into(),
                    ADAPTER_SHA.into(),
                )]),
                home_file_identity: [1, 2],
                runtime_home_file_identity: [1, 3],
                lease_file_identity: [1, 4],
            },
            create,
        )
        .unwrap()
}
pub(crate) fn session_registration(
    workspace: &Workspace,
    thread: &ThreadRef,
) -> SessionRegistration {
    let s = scope(1);
    SessionRegistration {
        farfold_session_id: FarfoldSessionId::parse("shared-codex-session").unwrap(),
        runtime_product_id: RuntimeProductId::parse(s.runtime_product_id).unwrap(),
        installation_id: InstallationId::parse(s.installation_id).unwrap(),
        runtime_build_id: RuntimeBuildId::parse(s.runtime_build_id).unwrap(),
        adapter_id: AdapterId::parse(s.adapter_id).unwrap(),
        connection_id: ConnectionId::parse(s.connection_id).unwrap(),
        project_id: ProjectId::parse("synthetic-project").unwrap(),
        project_path: workspace.cwd.clone(),
        project_name: "Synthetic".into(),
        working_copy_id: workspace.working_copy_id.clone().unwrap(),
        working_copy_path: workspace.cwd.clone(),
        working_copy_kind: WorkingCopyKind::Root,
        branch_name: None,
        native_session_id: NativeSessionId::parse(&thread.native_thread_id).unwrap(),
        title: "Synthetic lifecycle only".into(),
        title_source: SessionTitleSource::Native,
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn session_registration_model_write_failure_must_not_commit_partial_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let db = root.join("host.sqlite3");
    let store = HostStore::open(&db);
    let runtime = configure::Runtime::default();
    let workspace = attach(&runtime, &root, "thread_events", 1);
    shared_profile(&store, &workspace, &root.join("home"), true);
    let native = runtime
        .threads(&scope(1), &workspace, CommandInput::Start)
        .unwrap()
        .thread
        .unwrap();
    let registration = session_registration(&workspace, &native);
    // Only this temporary database: fail the second persistence step, after native start.
    let database = rusqlite::Connection::open(&db).unwrap();
    database
        .execute_batch(
            "CREATE TRIGGER reject_model_selection BEFORE UPDATE OF native_model_selection_json
             ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic model metadata write failure'); END;",
        )
        .unwrap();
    let error = runtime
        .register_thread(&store, &scope(1), &registration)
        .unwrap_err();
    let target = store.session_open_target(&registration.farfold_session_id);
    let missing_selection = store
        .session_model_selection(&registration.farfold_session_id)
        .is_err();
    let (unknown, original_bound, pending) = {
        let handle = runtime.connection().unwrap();
        let connection = handle.lock().unwrap();
        (
            connection.threads.unknown,
            connection
                .threads
                .bound
                .as_ref()
                .is_some_and(|bound| bound.same_identity(&native)),
            connection.control.operations.is_pending(),
        )
    };
    for table in [
        "projects",
        "working_copies",
        "sessions",
        "session_native_locators",
    ] {
        let count: i64 = database
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "{table} must roll back with model metadata");
    }
    assert!(
        unknown,
        "native start remains real; registration outcome must block work"
    );
    assert!(
        !pending,
        "use existing unknown guard, not a fabricated native operation"
    );
    registration::assert_unknown_blocks_work(&runtime, &store, &workspace, &registration, &native);
    // Clean up the owned synthetic process before checking the original safety assertion.
    runtime.stop(&scope(1)).unwrap();
    assert_eq!(error, "Cannot record original Session model");
    assert!(missing_selection);
    assert!(original_bound);
    if let Ok(target) = &target {
        assert_eq!(target.native_session_id.as_str(), native.native_thread_id);
        assert_eq!(
            target.locator_value.as_deref(),
            Some(native.native_session_id.as_str())
        );
    }
    assert!(
        target.is_err(),
        "partial Session+locator committed without model selection; thread unknown={unknown}, operation pending={pending}; native identity retained but registration recovery is not represented"
    );
}

#[test]
fn shared_session_registration_cold_open_and_locator_export_deletion_keep_native_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let db = root.join("host.sqlite3");
    let store = HostStore::open(&db);
    let runtime = configure::Runtime::default();
    let workspace = attach(&runtime, &root, "thread_events", 1);
    assert_eq!(
        shared_profile(&store, &workspace, &root.join("home"), true),
        1
    );
    let native = runtime
        .threads(&scope(1), &workspace, CommandInput::Start)
        .unwrap()
        .thread
        .unwrap();
    let registration = session_registration(&workspace, &native);
    assert_eq!(
        runtime
            .register_thread(&store, &scope(1), &registration)
            .unwrap(),
        WriteOutcome::Inserted
    );
    assert_eq!(
        runtime
            .register_thread(&store, &scope(1), &registration)
            .unwrap(),
        WriteOutcome::AlreadyPresent
    );
    let target = store
        .session_open_target(&registration.farfold_session_id)
        .unwrap();
    assert_eq!(target.native_session_id.as_str(), native.native_thread_id);
    assert_eq!(
        target.locator_value.as_deref(),
        Some(native.native_session_id.as_str())
    );
    assert!(target.pi_session_file().is_none());
    let guard = OwnedSessionGuard {
        profile_id: RuntimeProfileId::parse("synthetic-profile").unwrap(),
        generation: 1,
    };
    let wrong = NativeSessionLocatorRegistration {
        kind: NativeSessionLocatorKind::CodexTreeSessionId,
        locator_value: "019a0000-0000-7000-8000-000000000099".into(),
        allowed_root: None,
    };
    assert!(
        store
            .register_owned_session_with_native_locator(&registration, &wrong, &guard)
            .is_err()
    );
    let as_path = NativeSessionLocatorRegistration {
        kind: NativeSessionLocatorKind::CodexTreeSessionId,
        locator_value: native.native_session_id.clone(),
        allowed_root: Some(root.clone()),
    };
    assert!(
        store
            .register_owned_session_with_native_locator(&registration, &as_path, &guard)
            .is_err()
    );
    let mut sibling = registration.clone();
    sibling.farfold_session_id = FarfoldSessionId::parse("sibling").unwrap();
    sibling.native_session_id =
        NativeSessionId::parse("019a0000-0000-7000-8000-000000000003").unwrap();
    let locator = NativeSessionLocatorRegistration {
        kind: NativeSessionLocatorKind::CodexTreeSessionId,
        locator_value: native.native_session_id.clone(),
        allowed_root: None,
    };
    store
        .register_owned_session_with_native_locator(&sibling, &locator, &guard)
        .unwrap();
    let counts = serde_json::to_value(store.portable_export_preview().unwrap()).unwrap();
    assert_eq!(counts["contents"]["nativeLocatorCount"], 2);
    let exported = root.join("test.farfold.sqlite3");
    store
        .create_portable_export(
            crate::host_store::portable_export::CreatePortableExportInput {
                destination_path: exported.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
    let export_db = rusqlite::Connection::open_with_flags(
        &exported,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(export_db.query_row("SELECT count(*) FROM session_native_locators WHERE locator_kind='codex_tree_session_id' AND locator_value=?1",[&native.native_session_id],|r|r.get::<_,i64>(0)).unwrap(),2);
    runtime.stop(&scope(1)).unwrap();
    drop(runtime);
    drop(store);
    let reopened = HostStore::open(&db);
    assert_eq!(
        shared_profile(&reopened, &workspace, &root.join("home"), false),
        2
    );
    let runtime = configure::Runtime::default();
    attach(&runtime, &root, "thread_moved", 2);
    assert!(
        runtime
            .open_registered_thread(&reopened, &scope(1), &registration.farfold_session_id)
            .is_err()
    );
    let restored = runtime
        .open_registered_thread(&reopened, &scope(2), &registration.farfold_session_id)
        .unwrap()
        .thread
        .unwrap();
    assert_eq!(restored.native_session_id, native.native_session_id);
    assert_eq!(restored.native_thread_id, native.native_thread_id);
    assert_ne!(restored.path, native.path);
    assert_eq!(
        reopened
            .session_open_target(&registration.farfold_session_id)
            .unwrap()
            .locator_value,
        Some(native.native_session_id.clone())
    );
    runtime.stop(&scope(2)).unwrap();
    assert_eq!(
        shared_profile(&reopened, &workspace, &root.join("home"), false),
        3
    );
    attach(&runtime, &root, "thread_foreign", 3);
    assert!(
        runtime
            .open_registered_thread(&reopened, &scope(3), &registration.farfold_session_id)
            .is_err()
    );
    assert!(
        runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .threads
            .bound
            .is_none()
    );
    runtime.stop(&scope(3)).unwrap();
    let effects = serde_json::to_value(
        reopened
            .session_deletion_preview(&registration.farfold_session_id, true)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(effects["effects"]["deletesNativeLocator"], true);
    let database = rusqlite::Connection::open(&db).unwrap();
    database.pragma_update(None, "foreign_keys", true).unwrap();
    database
        .execute(
            "DELETE FROM sessions WHERE farfold_session_id=?1",
            [registration.farfold_session_id.as_str()],
        )
        .unwrap();
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM session_native_locators", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(native.path.unwrap().is_file());
}

pub(crate) fn scope(generation: u64) -> Scope {
    Scope {
        runtime_product_id: "codex".into(),
        installation_id: "synthetic-installation".into(),
        runtime_build_id: NATIVE_SHA.into(),
        adapter_id: "codex-acp-stdio-v1".into(),
        adapter_build_id: ADAPTER_SHA.into(),
        connection_id: "synthetic-connection".into(),
        profile_id: "synthetic-profile".into(),
        generation,
    }
}
pub(crate) fn attach(
    runtime: &configure::Runtime,
    root: &Path,
    mode: &str,
    generation: u64,
) -> Workspace {
    let root = root.canonicalize().unwrap();
    let home = root.join("home");
    fs::create_dir_all(home.join("codex")).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = Workspace {
        cwd: root.clone(),
        working_copy_id: Some(WorkingCopyId::parse("synthetic-worktree").unwrap()),
    };
    let launch = json!({"scope":scope(generation),"home":home,"codexHome":home.join("codex"),"cwd":root,"workingCopyId":workspace.working_copy_id});
    let mut command =
        Command::new(std::env::var_os("FARFOLD_E_NODE").unwrap_or_else(|| "node".into()));
    command
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("codex-acp-adapter/test/synthetic-adapter.mjs"),
        )
        .arg(mode)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("FARFOLD_TEST_LAUNCH", launch.to_string());
    let (transport, _) = initialize_transport(
        &mut command,
        &root,
        json!({}),
        ADAPTER_VERSION,
        Duration::from_secs(5),
    )
    .unwrap();
    let connection = Connection {
        transport,
        scope: scope(generation),
        profile_home: home,
        control: configure::Control::default(),
        workspace: workspace.clone(),
        threads: Control::default(),
        turns: super::super::turns::Control::default(),
        admission: None,
        _profile_lease: None,
    };
    *runtime.inner.state.lock().unwrap() = AcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    if !mode.starts_with("admission_") {
        select_test_model(runtime, generation);
    }
    workspace
}
pub(crate) fn select_test_model(runtime: &configure::Runtime, generation: u64) {
    use super::super::admission::CommandInput as C;
    let s = runtime.admission(&scope(generation), C::Refresh).unwrap();
    runtime
        .admission(
            &scope(generation),
            C::Select {
                observation_scope: s.scope.clone(),
                epoch: s.epoch,
                catalog_hash: s.catalog_hash.unwrap(),
                catalog_model_id: "synthetic-picker".into(),
                provider: "synthetic".into(),
                reasoning_effort: "medium".into(),
            },
        )
        .unwrap();
}
#[test]
fn synthetic_thread_start_read_cold_resume_and_private_event_projection() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = configure::Runtime::default();
    let workspace = attach(&runtime, temp.path(), "thread_events", 1);
    assert!(
        runtime
            .threads(&scope(1), &workspace, CommandInput::List)
            .unwrap()
            .data
            .is_empty()
    );
    let mut wrong = workspace.clone();
    let mut authentication = runtime
        .configure(
            &scope(1),
            configure::CommandInput::ApiKey {
                key: "SYNTHETIC-ONLY".into(),
            },
        )
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while authentication.phase != configure::Phase::Confirmed {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
        authentication = runtime
            .configure(
                &scope(1),
                configure::CommandInput::Status {
                    operation_id: authentication.operation_id,
                    login_id: authentication.login_id,
                },
            )
            .unwrap();
    }
    wrong.working_copy_id = Some(WorkingCopyId::parse("foreign").unwrap());
    select_test_model(&runtime, 1);
    assert!(
        runtime
            .threads(&scope(1), &wrong, CommandInput::Start)
            .is_err()
    );
    let started = runtime
        .threads(&scope(1), &workspace, CommandInput::Start)
        .unwrap()
        .thread
        .unwrap();
    let events = runtime.thread_events(&scope(1)).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["params"]["thread"]["nativeSessionId"],
        started.native_session_id
    );
    assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE"));
    assert!(
        runtime
            .threads(&scope(1), &workspace, CommandInput::Start)
            .is_err()
    );
    let read = runtime
        .threads(
            &scope(1),
            &workspace,
            CommandInput::Read {
                thread: started.clone(),
            },
        )
        .unwrap()
        .thread
        .unwrap();
    assert_eq!(read, started);
    runtime.stop(&scope(1)).unwrap();
    let before = fs::read(started.path.as_ref().unwrap()).unwrap();
    let restored = configure::Runtime::default();
    attach(&restored, temp.path(), "thread_events", 2);
    assert!(
        restored
            .threads(&scope(1), &workspace, CommandInput::List)
            .is_err()
    );
    assert!(
        restored
            .threads(
                &scope(2),
                &workspace,
                CommandInput::Resume {
                    thread: started.clone()
                }
            )
            .is_err()
    );
    let listed = restored
        .threads(&scope(2), &workspace, CommandInput::List)
        .unwrap();
    assert_eq!(listed.data, std::slice::from_ref(&started));
    let mut foreign = started.clone();
    foreign.native_session_id = "019a0000-0000-7000-8000-000000000099".into();
    assert!(
        restored
            .threads(
                &scope(2),
                &workspace,
                CommandInput::Resume { thread: foreign }
            )
            .is_err()
    );
    assert_eq!(
        restored
            .threads(
                &scope(2),
                &workspace,
                CommandInput::Resume {
                    thread: started.clone()
                }
            )
            .unwrap()
            .thread,
        Some(started.clone())
    );
    restored.stop(&scope(2)).unwrap();
    assert_eq!(fs::read(started.path.unwrap()).unwrap(), before);
}
#[test]
fn thread_failure_or_stop_during_pending_cannot_authorize_a_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Arc::new(configure::Runtime::default());
    let workspace = attach(&runtime, temp.path(), "thread_delayed", 1);
    let cloned = runtime.clone();
    let w = workspace.clone();
    let pending = std::thread::spawn(move || cloned.threads(&scope(1), &w, CommandInput::Start));
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !runtime
        .connection()
        .unwrap()
        .lock()
        .unwrap()
        .control
        .operations
        .is_pending()
    {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        runtime
            .configure(&scope(1), configure::CommandInput::Browser)
            .is_err()
    );
    runtime.stop(&scope(1)).unwrap();
    attach(&runtime, temp.path(), "thread_events", 2);
    assert!(pending.join().unwrap().is_err());
    assert!(
        runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .threads
            .bound
            .is_none()
    );
    runtime.stop(&scope(2)).unwrap();
}
#[test]
fn native_workspace_mismatch_leaves_unknown_and_blocks_further_operations() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = configure::Runtime::default();
    let workspace = attach(&runtime, temp.path(), "thread_cwd", 1);
    assert!(
        runtime
            .threads(&scope(1), &workspace, CommandInput::Start)
            .is_err()
    );
    assert!(
        runtime
            .threads(&scope(1), &workspace, CommandInput::List)
            .is_err()
    );
    assert!(
        runtime
            .configure(&scope(1), configure::CommandInput::Browser)
            .is_err()
    );
    runtime.stop(&scope(1)).unwrap();
}
