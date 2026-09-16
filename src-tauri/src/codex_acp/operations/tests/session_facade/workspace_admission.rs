use super::*;

fn managed(mode: &str, state: Option<&str>) -> Fixture {
    let f = Fixture::new(mode);
    let source = f.temp.path().join("source");
    fs::create_dir(&source).unwrap();
    let source = source.canonicalize().unwrap();
    let db = database(&f);
    db.execute(
        "UPDATE projects SET canonical_path=?1 WHERE project_id='synthetic-project'",
        [source.to_str().unwrap()],
    )
    .unwrap();
    db.execute("INSERT INTO working_copies(working_copy_id,project_id,canonical_path,kind,branch_name,created_at,updated_at) VALUES('synthetic-source','synthetic-project',?1,'root','main',1,1)", [source.to_str().unwrap()]).unwrap();
    db.execute("UPDATE working_copies SET kind='worktree',branch_name='codex/synthetic' WHERE working_copy_id='synthetic-worktree'", []).unwrap();
    if let Some(state) = state {
        db.execute("INSERT INTO managed_worktrees(working_copy_id,project_id,source_working_copy_id,source_head_oid,branch_name,local_changes_choice,lifecycle_state,created_at,updated_at) VALUES('synthetic-worktree','synthetic-project','synthetic-source',?1,'codex/synthetic','clean',?2,1,1)", rusqlite::params!["a".repeat(40),state]).unwrap();
    }
    f
}
fn database(f: &Fixture) -> rusqlite::Connection {
    let db = rusqlite::Connection::open(f.temp.path().join("host.sqlite3")).unwrap();
    db.pragma_update(None, "foreign_keys", true).unwrap();
    db
}
fn remove_record(f: &Fixture, state: &str) {
    database(f).execute("INSERT INTO managed_worktree_removals(working_copy_id,project_id,expected_path,expected_branch_name,expected_head_oid,retains_branch,lifecycle_state,created_at,updated_at) VALUES('synthetic-worktree','synthetic-project',?1,'codex/synthetic',?2,1,?3,1,1)",rusqlite::params![f.temp.path().canonicalize().unwrap().to_str().unwrap(),"a".repeat(40),state]).unwrap();
}
fn rejected(f: &Fixture) -> bool {
    let read_rejected = f
        .store
        .registered_session_workspace(&WorkingCopyId::parse("synthetic-worktree").unwrap())
        .is_err();
    let start_rejected = f.call(f.request()).is_err();
    let no_native = !f
        .temp
        .path()
        .join("home/codex/sessions/synthetic-thread.jsonl")
        .exists();
    let no_session = database(f)
        .query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
        .unwrap()
        == 0;
    read_rejected && start_rejected && no_native && no_session
}

#[test]
fn root_and_ready_managed_workspace_are_valid_controls() {
    let root = Fixture::new("thread_events");
    assert!(
        root.store
            .registered_session_workspace(&WorkingCopyId::parse("synthetic-worktree").unwrap())
            .is_ok()
    );
    assert!(root.call(root.request()).is_ok());
    let f = managed("thread_events", Some("ready"));
    assert!(
        f.store
            .registered_session_workspace(&WorkingCopyId::parse("synthetic-worktree").unwrap())
            .is_ok()
    );
    assert!(f.call(f.request()).is_ok());
}

#[test]
fn nonready_removing_or_inconsistent_managed_workspace_never_starts_native() {
    let mut accepted = Vec::new();
    for state in [
        "creating",
        "orphaned",
        "root-conflict",
        "branch-conflict",
        "self-source",
        "removing",
        "removed",
        "failed",
    ] {
        let f = managed(
            "thread_events",
            Some(if matches!(state, "creating" | "orphaned") {
                state
            } else {
                "ready"
            }),
        );
        match state {
            "root-conflict" => {
                database(&f).execute("UPDATE working_copies SET kind='root' WHERE working_copy_id='synthetic-worktree'",[]).unwrap();
            }
            "branch-conflict" => {
                database(&f)
                    .execute("UPDATE managed_worktrees SET branch_name='foreign'", [])
                    .unwrap();
            }
            "self-source" => {
                database(&f)
                    .execute(
                        "UPDATE managed_worktrees SET source_working_copy_id='synthetic-worktree'",
                        [],
                    )
                    .unwrap();
            }
            "removing" | "removed" | "failed" => remove_record(&f, state),
            _ => {}
        }
        if !rejected(&f) {
            accepted.push(state);
        }
    }
    assert!(
        accepted.is_empty(),
        "invalid managed states admitted: {accepted:?}"
    );
}

#[test]
fn schema_spelling_and_composite_ownership_constraints_are_enforced() {
    let f = managed("thread_events", Some("ready"));
    let db = database(&f);
    assert!(
        db.execute(
            "UPDATE working_copies SET kind='managed' WHERE working_copy_id='synthetic-worktree'",
            []
        )
        .is_err()
    );
    assert!(
        db.execute("UPDATE managed_worktrees SET lifecycle_state='failed'", [])
            .is_err()
    );
    assert!(
        db.execute(
            "UPDATE managed_worktrees SET project_id='foreign-project'",
            []
        )
        .is_err()
    );
    assert!(
        db.execute(
            "UPDATE managed_worktrees SET source_working_copy_id='missing-source'",
            []
        )
        .is_err()
    );
    assert!(
        f.store
            .registered_session_workspace(&WorkingCopyId::parse("synthetic-worktree").unwrap())
            .is_ok()
    );
}

fn git(path: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(path)
        .args([
            "-c",
            "user.name=Farfold",
            "-c",
            "user.email=farfold@example.invalid",
        ])
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "temporary Git fixture command failed");
}

#[test]
fn real_git_root_and_external_linked_worktree_need_no_managed_record() {
    let source = tempfile::tempdir().unwrap();
    git(source.path(), &["init"]);
    git(
        source.path(),
        &["commit", "--allow-empty", "-m", "synthetic fixture"],
    );
    let root = Fixture::in_temp(source, "thread_events");
    assert!(root.call(root.request()).is_ok());
    let linked = tempfile::tempdir().unwrap();
    git(
        root.temp.path(),
        &[
            "worktree",
            "add",
            "--detach",
            linked.path().to_str().unwrap(),
        ],
    );
    let linked = Fixture::in_temp(linked, "thread_events");
    let preview =
        crate::host_store::working_copy_manager::registration_preview(linked.temp.path()).unwrap();
    assert_eq!(preview.kind, WorkingCopyKind::Worktree);
    assert_eq!(
        preview.project_path,
        root.temp.path().canonicalize().unwrap().to_str().unwrap()
    );
    let db = database(&linked);
    db.execute(
        "UPDATE projects SET canonical_path=?1 WHERE project_id='synthetic-project'",
        [preview.project_path],
    )
    .unwrap();
    db.execute("UPDATE working_copies SET kind='worktree',branch_name=?1 WHERE working_copy_id='synthetic-worktree'",[preview.branch_name]).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM managed_worktrees", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(
        linked
            .store
            .registered_session_workspace(&WorkingCopyId::parse("synthetic-worktree").unwrap())
            .is_ok()
    );
    assert!(linked.call(linked.request()).is_ok());
}

#[test]
fn managed_metadata_change_during_start_keeps_original_unknown() {
    let f = managed("thread_delayed", Some("ready"));
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
        database(&f)
            .execute(
                "UPDATE managed_worktrees SET lifecycle_state='orphaned',error_code='synthetic'",
                [],
            )
            .unwrap();
        assert!(pending.join().unwrap().is_err());
    });
    assert_eq!(
        database(&f)
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let handle = f.runtime.connection().unwrap();
    let c = handle.lock().unwrap();
    assert!(c.threads.unknown);
    assert!(c.threads.bound.is_some());
    assert!(c.admission.as_ref().unwrap().actual.is_some());
}

#[test]
fn registration_transaction_rechecks_existing_managed_metadata() {
    for state in [
        "creating",
        "orphaned",
        "root-conflict",
        "branch-conflict",
        "missing-record",
        "source-changed",
        "failed",
    ] {
        let f = managed("thread_events", Some("ready"));
        let id = WorkingCopyId::parse("synthetic-worktree").unwrap();
        let expected = f.store.registered_session_workspace(&id).unwrap();
        let workspace = crate::codex_acp::threads::Workspace {
            cwd: expected.cwd.clone(),
            working_copy_id: Some(id),
        };
        let native = f
            .runtime
            .threads(
                &scope(1),
                &workspace,
                crate::codex_acp::threads::CommandInput::Start,
            )
            .unwrap()
            .thread
            .unwrap();
        let mut registration =
            crate::codex_acp::threads::tests::session_registration(&workspace, &native);
        registration.project_path = expected.project_path.clone();
        registration.working_copy_kind = expected.kind;
        registration.branch_name = expected.branch_name.clone();
        match state {
            "root-conflict" => {
                database(&f).execute("UPDATE working_copies SET kind='root' WHERE working_copy_id='synthetic-worktree'",[]).unwrap();
            }
            "branch-conflict" => {
                database(&f)
                    .execute("UPDATE managed_worktrees SET branch_name='foreign'", [])
                    .unwrap();
            }
            "missing-record" => {
                database(&f)
                    .execute("DELETE FROM managed_worktrees", [])
                    .unwrap();
            }
            "source-changed" => {
                database(&f)
                    .execute(
                        "UPDATE managed_worktrees SET source_head_oid=?1",
                        ["b".repeat(40)],
                    )
                    .unwrap();
            }
            "failed" => remove_record(&f, state),
            _ => {
                database(&f)
                    .execute("UPDATE managed_worktrees SET lifecycle_state=?1", [state])
                    .unwrap();
            }
        }
        assert!(
            f.runtime
                .register_thread_in_workspace(&f.store, &scope(1), &registration, Some(&expected))
                .is_err(),
            "{state}"
        );
        assert_eq!(
            database(&f)
                .query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        let handle = f.runtime.connection().unwrap();
        let c = handle.lock().unwrap();
        assert!(c.threads.unknown);
        assert!(c.threads.bound.as_ref().unwrap().same_identity(&native));
    }
}
