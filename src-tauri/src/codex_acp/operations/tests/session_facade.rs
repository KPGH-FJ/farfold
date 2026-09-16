use super::*;
use crate::codex_acp::threads::tests::attach as attach_threads;

mod focus;
mod workspace_admission;

#[test]
fn session_context_is_exact_read_only_owned_launch_not_connection_discovery() {
    let f = Fixture::new("thread_events");
    let input = json!({"action":"start","installationId":scope(1).installation_id,"runtimeBuildId":scope(1).runtime_build_id,"workingCopyId":"synthetic-worktree"});
    let read = |v| {
        f.runtime
            .session_context(&f.store, serde_json::from_value(v).unwrap())
    };
    let context = serde_json::to_value(read(input.clone()).unwrap()).unwrap();
    assert_eq!(context["scope"], json!(scope(1)));
    assert_eq!(context["workingCopyId"], "synthetic-worktree");
    assert!(context.get("selection").is_none());
    assert!(context.get("capabilities").is_none());
    for field in ["installationId", "runtimeBuildId", "workingCopyId"] {
        let mut wrong = input.clone();
        wrong[field] = json!("foreign");
        assert!(read(wrong).is_err());
    }
    assert!(
        !f.temp
            .path()
            .join("home/codex/sessions/synthetic-thread.jsonl")
            .exists()
    );
    let receipt = f.call(f.request()).unwrap();
    assert!(
        read(input).is_err(),
        "bound connection is not a new Session context"
    );
    let open = json!({"action":"open","farfoldSessionId":receipt["snapshot"]["farfoldSessionId"]});
    let native = f
        .temp
        .path()
        .join("home/codex/sessions/synthetic-thread.jsonl");
    let before = fs::read(&native).unwrap();
    assert!(read(open.clone()).is_ok());
    assert_eq!(fs::read(&native).unwrap(), before);
    f.runtime
        .connection()
        .unwrap()
        .lock()
        .unwrap()
        .threads
        .unknown = true;
    assert!(read(open).is_err());
}

#[test]
fn session_context_rejects_stopped_and_changed_owned_launch_without_restore() {
    let f = Fixture::new("thread_events");
    let input = || {
        serde_json::from_value(json!({"action":"start","installationId":scope(1).installation_id,"runtimeBuildId":scope(1).runtime_build_id,"workingCopyId":"synthetic-worktree"})).unwrap()
    };
    let handle = f.runtime.connection().unwrap();
    handle.lock().unwrap().workspace.cwd = f.temp.path().join("foreign");
    assert!(f.runtime.session_context(&f.store, input()).is_err());
    f.runtime.stop(&scope(1)).unwrap();
    assert!(f.runtime.session_context(&f.store, input()).is_err());
    assert!(f.runtime.connection().is_err());
}

struct Fixture {
    temp: tempfile::TempDir,
    store: HostStore,
    runtime: configure::Runtime,
    choice: Value,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        Self::in_temp(tempfile::tempdir().unwrap(), mode)
    }
    fn in_temp(temp: tempfile::TempDir, mode: &str) -> Self {
        let root = temp.path().canonicalize().unwrap();
        let store = HostStore::open(root.join("host.sqlite3"));
        let runtime = configure::Runtime::default();
        let workspace = attach_threads(&runtime, &root, mode, 1);
        shared_profile(&store, &workspace, &root.join("home"), true);
        let db = rusqlite::Connection::open(root.join("host.sqlite3")).unwrap();
        db.execute("INSERT INTO projects(project_id,canonical_path,display_name,created_at,updated_at) VALUES('synthetic-project',?1,'Synthetic',1,1)",[root.to_str().unwrap()]).unwrap();
        db.execute("INSERT INTO working_copies(working_copy_id,project_id,canonical_path,kind,created_at,updated_at) VALUES('synthetic-worktree','synthetic-project',?1,'root',1,1)",[root.to_str().unwrap()]).unwrap();
        let snapshot = runtime
            .admission_view(&scope(1), admission::ViewCommand::Refresh)
            .unwrap();
        let selection = json!({"catalogModelId":"synthetic-picker","nativeModel":"synthetic-model","provider":"synthetic","reasoningEffort":"medium"});
        let snapshot = serde_json::to_value(snapshot).unwrap();
        let choice = json!({"observationScope":scope(1),"epoch":snapshot["epoch"],"catalogHash":snapshot["catalogHash"],"selection":selection});
        let mut command = choice.clone();
        command["action"] = json!("select");
        runtime
            .admission_view(&scope(1), serde_json::from_value(command).unwrap())
            .unwrap();
        Self {
            temp,
            store,
            runtime,
            choice,
        }
    }
    fn request(&self) -> Value {
        json!({"action":"session","scope":scope(1),"command":{"action":"start","workingCopyId":"synthetic-worktree","choice":self.choice}})
    }
    fn call(&self, value: Value) -> Result<Value, OperationError> {
        gated(Entry::Synthetic, value, |input| {
            execute(
                &self.runtime,
                &self.store,
                input,
                &crate::turn_coordinator::TurnCoordinator::default(),
                &crate::runtime_event_router::RuntimeEventRouter::default(),
            )
        })
        .map(|r| serde_json::to_value(r).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(handle) = self.runtime.connection() {
            let scope = handle.lock().unwrap().scope.clone();
            let _ = self.runtime.stop(&scope);
        }
    }
}

#[test]
fn session_facade_start_registers_only_explicit_choice_without_a_turn() {
    let f = Fixture::new("thread_events");
    let result = f.call(f.request()).unwrap();
    assert_eq!(result["kind"], "session");
    assert_eq!(result["snapshot"]["scope"], json!(scope(1)));
    assert_eq!(result["snapshot"]["selection"], f.choice["selection"]);
    assert!(result["snapshot"]["farfoldSessionId"].as_str().is_some());
    assert!(result["snapshot"].get("cwd").is_none());
    assert!(result["snapshot"].get("path").is_none());
    let native: Value = serde_json::from_slice(
        &fs::read(
            f.temp
                .path()
                .join("home/codex/sessions/synthetic-thread.jsonl"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(native["turns"], json!([]));
}

#[test]
fn refresh_cannot_revive_retained_adapter_selection_for_new_session() {
    let f = Fixture::new("thread_events");
    f.runtime
        .admission_view(&scope(1), admission::ViewCommand::Refresh)
        .unwrap();
    assert!(
        f.call(f.request()).is_err(),
        "old Adapter selection is not current explicit view consent"
    );
    assert!(
        !f.temp
            .path()
            .join("home/codex/sessions/synthetic-thread.jsonl")
            .exists()
    );
}

#[test]
fn session_start_rejects_stale_scope_choice_workspace_and_free_native_fields() {
    let f = Fixture::new("thread_events");
    for field in [
        "runtimeProductId",
        "installationId",
        "runtimeBuildId",
        "adapterId",
        "adapterBuildId",
        "connectionId",
        "profileId",
        "generation",
    ] {
        let mut request = f.request();
        request["scope"][field] = if field == "generation" {
            json!(2)
        } else {
            json!("foreign")
        };
        assert!(f.call(request).is_err(), "{field}");
    }
    for field in [
        "observationScope",
        "epoch",
        "catalogHash",
        "catalogModelId",
        "nativeModel",
        "provider",
        "reasoningEffort",
        "workingCopyId",
    ] {
        let mut request = f.request();
        match field {
            "workingCopyId" => request["command"][field] = json!("foreign"),
            "observationScope" => request["command"]["choice"][field] = json!(scope(2)),
            "epoch" => request["command"]["choice"][field] = json!(0),
            "catalogHash" => request["command"]["choice"][field] = json!("wrong"),
            _ => request["command"]["choice"]["selection"][field] = json!("wrong"),
        }
        assert!(f.call(request).is_err(), "{field}");
    }
    for field in [
        "cwd",
        "thread",
        "nativeThreadId",
        "nativeTreeId",
        "farfoldSessionId",
        "title",
        "enabled",
    ] {
        let mut request = f.request();
        request["command"][field] = json!("frontend-target");
        assert!(
            matches!(f.call(request), Err(OperationError::InvalidRequest)),
            "{field}"
        );
    }
    assert!(
        !f.temp
            .path()
            .join("home/codex/sessions/synthetic-thread.jsonl")
            .exists()
    );
    assert!(f.call(f.request()).is_ok());
}

#[test]
fn start_actual_mismatch_or_registration_failure_never_retries_or_returns_success() {
    for mode in [
        "admission_actual_mismatch",
        "admission_effort_mismatch",
        "thread_events",
    ] {
        let f = Fixture::new(mode);
        if mode == "thread_events" {
            let db = rusqlite::Connection::open(f.temp.path().join("host.sqlite3")).unwrap();
            db.execute_batch("CREATE TRIGGER reject_model BEFORE UPDATE OF native_model_selection_json ON sessions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
        }
        assert!(matches!(
            f.call(f.request()),
            Err(OperationError::Unconfirmed)
        ));
        let native = f
            .temp
            .path()
            .join("home/codex/sessions/synthetic-thread.jsonl");
        let before = fs::read(&native).unwrap();
        assert!(f.call(f.request()).is_err());
        assert_eq!(fs::read(native).unwrap(), before);
        let db = rusqlite::Connection::open(f.temp.path().join("host.sqlite3")).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM projects", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(
            f.runtime
                .connection()
                .unwrap()
                .lock()
                .unwrap()
                .threads
                .unknown
        );
        if mode == "thread_events" {
            assert!(
                f.runtime
                    .connection()
                    .unwrap()
                    .lock()
                    .unwrap()
                    .threads
                    .bound
                    .is_some()
            );
        }
    }
}

#[test]
fn original_session_open_uses_shared_identity_and_never_overrides_or_replays() {
    let f = Fixture::new("thread_events");
    let original = f.call(f.request()).unwrap();
    let id = original["snapshot"]["farfoldSessionId"].as_str().unwrap();
    let native = f
        .temp
        .path()
        .join("home/codex/sessions/synthetic-thread.jsonl");
    let bytes = fs::read(&native).unwrap();
    f.runtime.stop(&scope(1)).unwrap();
    let workspace = attach_threads(&f.runtime, f.temp.path(), "thread_events", 2);
    assert_eq!(
        shared_profile(&f.store, &workspace, &workspace.cwd.join("home"), false),
        2
    );
    let request = json!({"action":"session","scope":scope(2),"command":{"action":"open","farfoldSessionId":id}});
    for field in [
        "cwd",
        "nativeThreadId",
        "nativeTreeId",
        "selection",
        "model",
        "provider",
        "reasoningEffort",
    ] {
        let mut bad = request.clone();
        bad["command"][field] = json!("override");
        assert!(matches!(f.call(bad), Err(OperationError::InvalidRequest)));
    }
    let mut wrong = request.clone();
    wrong["scope"] = json!(scope(1));
    assert!(f.call(wrong).is_err());
    let mut missing = request.clone();
    missing["command"]["farfoldSessionId"] = json!("missing");
    assert!(f.call(missing).is_err());
    let opened = f.call(request).unwrap();
    for field in [
        "farfoldSessionId",
        "nativeThreadId",
        "nativeTreeId",
        "selection",
        "workingCopyId",
    ] {
        assert_eq!(opened["snapshot"][field], original["snapshot"][field]);
    }
    assert_eq!(opened["snapshot"]["scope"], json!(scope(2)));
    assert_eq!(fs::read(native).unwrap(), bytes);
}

#[test]
fn workspace_change_during_native_start_keeps_original_unknown_without_registration() {
    let f = Fixture::new("thread_delayed");
    std::thread::scope(|s| {
        let request = f.request();
        let pending = s.spawn(|| f.call(request));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !f
            .temp
            .path()
            .join("home/codex/sessions/synthetic-thread.jsonl")
            .exists()
        {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let db = rusqlite::Connection::open(f.temp.path().join("host.sqlite3")).unwrap();
        db.execute(
            "UPDATE projects SET display_name='changed' WHERE project_id='synthetic-project'",
            [],
        )
        .unwrap();
        assert!(pending.join().unwrap().is_err());
        assert_eq!(
            db.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    });
    let handle = f.runtime.connection().unwrap();
    let c = handle.lock().unwrap();
    assert!(c.threads.unknown);
    assert!(c.threads.bound.is_some());
}

#[test]
fn registration_transaction_does_not_recreate_a_retired_host_workspace() {
    let f = Fixture::new("thread_events");
    let id = WorkingCopyId::parse("synthetic-worktree").unwrap();
    let expected = f.store.registered_session_workspace(&id).unwrap();
    let workspace = super::super::super::threads::Workspace {
        cwd: expected.cwd.clone(),
        working_copy_id: Some(id),
    };
    let native = f
        .runtime
        .threads(
            &scope(1),
            &workspace,
            super::super::super::threads::CommandInput::Start,
        )
        .unwrap()
        .thread
        .unwrap();
    let registration =
        super::super::super::threads::tests::session_registration(&workspace, &native);
    let db = rusqlite::Connection::open(f.temp.path().join("host.sqlite3")).unwrap();
    db.execute(
        "DELETE FROM working_copies WHERE working_copy_id='synthetic-worktree'",
        [],
    )
    .unwrap();
    assert!(
        f.runtime
            .register_thread_in_workspace(&f.store, &scope(1), &registration, Some(&expected))
            .is_err()
    );
    for table in ["working_copies", "sessions", "session_native_locators"] {
        assert_eq!(
            db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    assert!(
        f.runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .threads
            .unknown
    );
}

#[test]
fn retired_start_receipt_cannot_register_or_poison_new_generation() {
    let f = Fixture::new("thread_delayed");
    std::thread::scope(|s| {
        let request = f.request();
        let pending = s.spawn(|| f.call(request));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !f
            .temp
            .path()
            .join("home/codex/sessions/synthetic-thread.jsonl")
            .exists()
        {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        f.runtime.stop(&scope(1)).unwrap();
        let workspace = attach_threads(&f.runtime, f.temp.path(), "thread_events", 2);
        shared_profile(&f.store, &workspace, &workspace.cwd.join("home"), false);
        assert!(pending.join().unwrap().is_err());
    });
    let handle = f.runtime.connection().unwrap();
    let c = handle.lock().unwrap();
    assert_eq!(c.scope, scope(2));
    assert!(!c.threads.unknown);
    assert!(c.threads.bound.is_none());
    let db = rusqlite::Connection::open(f.temp.path().join("host.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
