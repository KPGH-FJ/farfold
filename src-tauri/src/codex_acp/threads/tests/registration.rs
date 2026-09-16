use super::*;
use crate::host_store::native_model_selection::SessionModelSelection;

struct Fixture {
    _temp: tempfile::TempDir,
    store: HostStore,
    database: rusqlite::Connection,
    runtime: configure::Runtime,
    workspace: Workspace,
    native: ThreadRef,
    registration: SessionRegistration,
    selection: SessionModelSelection,
    locator: NativeSessionLocatorRegistration,
    guard: OwnedSessionGuard,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("host.sqlite3");
        let store = HostStore::open(&path);
        let runtime = configure::Runtime::default();
        let workspace = attach(&runtime, &root, "thread_events", 1);
        shared_profile(&store, &workspace, &root.join("home"), true);
        let native = runtime
            .threads(&scope(1), &workspace, CommandInput::Start)
            .unwrap()
            .thread
            .unwrap();
        let registration = session_registration(&workspace, &native);
        let selection = SessionModelSelection {
            farfold_session_id: registration.farfold_session_id.clone(),
            runtime: scope(1).binding().unwrap(),
            profile_id: RuntimeProfileId::parse("synthetic-profile").unwrap(),
            working_copy_id: registration.working_copy_id.clone(),
            cwd: workspace.cwd.clone(),
            native_thread_id: native.native_thread_id.clone(),
            native_tree_id: native.native_session_id.clone(),
            selection: runtime
                .connection()
                .unwrap()
                .lock()
                .unwrap()
                .admission
                .as_ref()
                .unwrap()
                .actual
                .as_ref()
                .unwrap()
                .selection(),
        };
        let locator = NativeSessionLocatorRegistration {
            kind: NativeSessionLocatorKind::CodexTreeSessionId,
            locator_value: native.native_session_id.clone(),
            allowed_root: None,
        };
        let guard = OwnedSessionGuard {
            profile_id: selection.profile_id.clone(),
            generation: 1,
        };
        Self {
            _temp: temp,
            store,
            database: rusqlite::Connection::open(path).unwrap(),
            runtime,
            workspace,
            native,
            registration,
            selection,
            locator,
            guard,
        }
    }
    fn register(&self) -> Result<WriteOutcome, String> {
        self.runtime
            .register_thread(&self.store, &scope(1), &self.registration)
    }
    fn rows(&self) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
        [
            "projects",
            "working_copies",
            "sessions",
            "session_native_locators",
        ]
        .iter()
        .map(|table| {
            let mut statement = self
                .database
                .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
                .unwrap();
            let width = statement.column_count();
            statement
                .query_map([], |r| (0..width).map(|i| r.get(i)).collect())
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        })
        .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.runtime.stop(&scope(1));
    }
}

pub(super) fn assert_unknown_blocks_work(
    runtime: &configure::Runtime,
    store: &HostStore,
    workspace: &Workspace,
    registration: &SessionRegistration,
    native: &ThreadRef,
) {
    let actual_before = runtime
        .connection()
        .unwrap()
        .lock()
        .unwrap()
        .admission
        .as_ref()
        .unwrap()
        .actual
        .clone();
    let bytes = fs::read(native.path.as_ref().unwrap()).unwrap();
    for command in [
        CommandInput::Start,
        CommandInput::Resume {
            thread: native.clone(),
        },
        CommandInput::List,
    ] {
        assert!(runtime.threads(&scope(1), workspace, command).is_err());
    }
    assert!(
        runtime
            .register_thread(store, &scope(1), registration)
            .is_err()
    );
    assert!(
        runtime
            .admission(
                &scope(1),
                super::super::super::admission::CommandInput::Refresh
            )
            .is_err()
    );
    assert!(
        runtime
            .admission_view(
                &scope(1),
                super::super::super::admission::ViewCommand::Refresh
            )
            .is_err()
    );
    let coordinator = crate::turn_coordinator::TurnCoordinator::default();
    let router = crate::runtime_event_router::RuntimeEventRouter::default();
    assert!(
        runtime
            .start_turn(
                store,
                &scope(1),
                &registration.farfold_session_id,
                &coordinator,
                &router,
                "must not dispatch"
            )
            .is_err()
    );
    assert_eq!(coordinator.snapshot().unwrap().active_turn_count(), 0);
    let handle = runtime.connection().unwrap();
    let connection = handle.lock().unwrap();
    assert!(connection.threads.unknown);
    assert!(
        connection
            .threads
            .bound
            .as_ref()
            .unwrap()
            .same_identity(native)
    );
    assert_eq!(
        connection.admission.as_ref().and_then(|s| s.actual.clone()),
        actual_before,
        "rejected operations must preserve original model diagnostics"
    );
    assert_eq!(fs::read(native.path.as_ref().unwrap()).unwrap(), bytes);
}

#[test]
fn atomic_registration_success_is_exactly_idempotent() {
    let f = Fixture::new();
    assert_eq!(f.register().unwrap(), WriteOutcome::Inserted);
    let rows = f.rows();
    assert_eq!(f.register().unwrap(), WriteOutcome::AlreadyPresent);
    assert_eq!(f.rows(), rows);
    assert!(
        f.store
            .session_model_selection(&f.registration.farfold_session_id)
            .unwrap()
            == f.selection
    );
    assert!(
        !f.runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .threads
            .unknown
    );
}

#[test]
fn immutable_choice_conflicts_roll_back_title_and_preserve_every_existing_row() {
    let f = Fixture::new();
    f.register().unwrap();
    let rows = f.rows();
    let mut registration = f.registration.clone();
    registration.title = "must roll back".into();
    registration.updated_at = 2;
    for field in ["catalog", "model", "provider", "effort"] {
        let mut selection = f.selection.clone();
        match field {
            "catalog" => selection.selection.catalog_model_id = "other".into(),
            "model" => selection.selection.native_model = "other".into(),
            "provider" => selection.selection.provider = "other".into(),
            _ => selection.selection.reasoning_effort = "high".into(),
        }
        let error = f
            .store
            .register_owned_session_with_native_model(
                &registration,
                &f.locator,
                &f.guard,
                &selection,
            )
            .err()
            .unwrap();
        assert!(matches!(error, SessionRegistrationError::Unconfirmed(_)));
        assert_eq!(
            error.into_message(),
            "Original Session model cannot be overwritten"
        );
        assert_eq!(f.rows(), rows);
    }
}

#[test]
fn atomic_registration_checks_full_selection_identity_and_owned_generation() {
    let f = Fixture::new();
    let empty = f.rows();
    for field in [
        "product",
        "installation",
        "build",
        "adapter",
        "connection",
        "profile",
        "worktree",
        "cwd",
        "thread",
        "tree",
    ] {
        let mut selection = f.selection.clone();
        match field {
            "product" => selection.runtime.product_id = RuntimeProductId::parse("foreign").unwrap(),
            "installation" => {
                selection.runtime.installation_id = InstallationId::parse("foreign").unwrap()
            }
            "build" => {
                selection.runtime.runtime_build_id = RuntimeBuildId::parse("foreign").unwrap()
            }
            "adapter" => selection.runtime.adapter_id = AdapterId::parse("foreign").unwrap(),
            "connection" => {
                selection.runtime.connection_id = ConnectionId::parse("foreign").unwrap()
            }
            "profile" => selection.profile_id = RuntimeProfileId::parse("foreign").unwrap(),
            "worktree" => selection.working_copy_id = WorkingCopyId::parse("foreign").unwrap(),
            "cwd" => selection.cwd = f.workspace.cwd.join("foreign"),
            "thread" => selection.native_thread_id = "019a0000-0000-7000-8000-000000000099".into(),
            _ => selection.native_tree_id = "019a0000-0000-7000-8000-000000000099".into(),
        }
        assert!(
            f.store
                .register_owned_session_with_native_model(
                    &f.registration,
                    &f.locator,
                    &f.guard,
                    &selection
                )
                .is_err(),
            "{field}"
        );
        assert_eq!(f.rows(), empty, "{field}");
    }
    for (profile, generation) in [
        ("synthetic-profile", 0),
        ("synthetic-profile", 2),
        ("foreign", 1),
    ] {
        let guard = OwnedSessionGuard {
            profile_id: RuntimeProfileId::parse(profile).unwrap(),
            generation,
        };
        assert!(
            f.store
                .register_owned_session_with_native_model(
                    &f.registration,
                    &f.locator,
                    &guard,
                    &f.selection
                )
                .is_err()
        );
        assert_eq!(f.rows(), empty);
    }
}

#[test]
fn parameter_rejections_do_not_poison_settled_native_identity() {
    let f = Fixture::new();
    let mut wrong_scope = scope(2);
    assert!(
        f.runtime
            .register_thread(&f.store, &wrong_scope, &f.registration)
            .is_err()
    );
    wrong_scope = scope(1);
    wrong_scope.profile_id = "foreign".into();
    assert!(
        f.runtime
            .register_thread(&f.store, &wrong_scope, &f.registration)
            .is_err()
    );
    for field in ["title", "time", "native", "workspace"] {
        let mut registration = f.registration.clone();
        match field {
            "title" => registration.title.clear(),
            "time" => registration.created_at = -1,
            "native" => registration.native_session_id = NativeSessionId::parse("foreign").unwrap(),
            _ => registration.working_copy_id = WorkingCopyId::parse("foreign").unwrap(),
        }
        assert!(
            f.runtime
                .register_thread(&f.store, &scope(1), &registration)
                .is_err()
        );
        assert!(
            !f.runtime
                .connection()
                .unwrap()
                .lock()
                .unwrap()
                .threads
                .unknown,
            "{field}"
        );
    }
    assert_eq!(f.register().unwrap(), WriteOutcome::Inserted);
}

#[test]
fn failed_update_of_existing_session_preserves_rows_and_blocks_all_work() {
    let f = Fixture::new();
    f.register().unwrap();
    let rows = f.rows();
    f.database.execute_batch("CREATE TRIGGER reject_model_update BEFORE UPDATE OF native_model_selection_json ON sessions BEGIN SELECT RAISE(ABORT, 'synthetic model update failure'); END;").unwrap();
    let mut registration = f.registration.clone();
    registration.title = "not committed".into();
    registration.updated_at = 2;
    assert_eq!(
        f.runtime
            .register_thread(&f.store, &scope(1), &registration)
            .unwrap_err(),
        "Cannot record original Session model"
    );
    assert_eq!(f.rows(), rows);
    assert_unknown_blocks_work(
        &f.runtime,
        &f.store,
        &f.workspace,
        &f.registration,
        &f.native,
    );
    assert_eq!(f.rows(), rows);
}

#[test]
fn persisted_generation_drift_blocks_registration_and_preserves_native_identity() {
    let f = Fixture::new();
    let before = f.rows();
    assert_eq!(
        shared_profile(&f.store, &f.workspace, &f.workspace.cwd.join("home"), false),
        2
    );
    assert_eq!(
        f.register().unwrap_err(),
        "Original owned launch does not authorize Session registration"
    );
    assert_eq!(f.rows(), before);
    assert_unknown_blocks_work(
        &f.runtime,
        &f.store,
        &f.workspace,
        &f.registration,
        &f.native,
    );
}
