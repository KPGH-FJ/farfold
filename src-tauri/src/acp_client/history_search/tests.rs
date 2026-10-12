use super::*;
use crate::meta_store::{AgentRow, SessionRow};
use serde_json::json;
use std::process::Command;
pub(super) fn source(path: &str) -> source::Source {
    source::Source {
        agent: AgentRow {
            id: "synthetic".into(),
            name: "Synthetic".into(),
            source: "custom".into(),
            command: "/usr/bin/python3".into(),
            args: vec![],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        },
        route: super::launch::Route::AppServer,
        rows: vec![SessionRow {
            id: "saved-1".into(),
            agent_id: "synthetic".into(),
            cwd: path.into(),
            native_session_id: Some("native-1".into()),
            title: None,
            config_options: None,
            pinned: false,
            archived: false,
            created_at: 0,
            updated_at: 0,
        }],
    }
}
pub(super) fn request() -> Request {
    Request {
        agent_id: "synthetic".into(),
        request_id: "00000000-0000-4000-8000-000000000001".into(),
        selection_id: "00000000-0000-4000-8000-000000000002".into(),
        query: "hello".into(),
    }
}
fn peer(mode: &str, path: &str) -> Command {
    let mut c = Command::new("/usr/bin/python3");
    c.args(["-c", include_str!("peer.py"), mode, path]);
    c
}
fn run(mode: &str) -> SearchOperation {
    let temp = tempfile::tempdir().unwrap();
    let requests = requests::Requests::default();
    let (job, _) = requests
        .begin(request(), || Ok(source(temp.path().to_str().unwrap())))
        .unwrap();
    job.update(|v| v.rows[0].state = RowState::Reading);
    let result = run_selected(&job, 0, peer(mode, temp.path().to_str().unwrap()))
        .and_then(|read| read.publish(&job, 0));
    if let Err(e) = &result {
        job.row_failed(0, e.code);
    }
    job.finish(result.err().map(|e| e.code));
    job.snapshot()
}
#[test]
fn official_pages_preserve_source_and_offsets_without_resume() {
    let v = run("normal");
    assert_eq!(v.state, State::Completed);
    assert_eq!(v.rows[0].state, RowState::Complete);
    assert_eq!(v.rows[0].pages_read, 2);
    assert_eq!(v.hits.len(), 2);
    assert_eq!(
        v.hits[0].locator,
        Locator::TurnItem {
            turn_id: "turn-1".into(),
            item_id: "u-1".into(),
            part_index: 1
        }
    );
    assert_eq!(v.hits[0].matches, vec![Range { start: 3, end: 8 }]);
    assert_eq!(v.rows[0].text_blocks_read, 3);
}
#[test]
fn unsupported_and_invalid_metadata_are_not_empty_complete() {
    let unsupported = run("unsupported");
    assert_eq!(unsupported.code, Some(Code::Unsupported));
    assert_eq!(unsupported.rows[0].state, RowState::Failed);
    let wrong = run("wrong");
    assert_eq!(wrong.code, Some(Code::IndexChanged));
    assert!(wrong.hits.is_empty());
    let malformed = run("malformed");
    assert_eq!(malformed.code, Some(Code::InvalidOutput));
}
#[test]
fn repeated_cursor_or_summary_cannot_claim_complete() {
    let v = run("repeat");
    assert_eq!(v.code, Some(Code::InvalidOutput));
    assert_eq!(v.rows[0].state, RowState::Partial);
    let v = run("summary");
    assert_eq!(v.code, Some(Code::Unsupported));
}
#[test]
fn result_limit_keeps_coverage_honest() {
    let v = run("many");
    assert_eq!(v.state, State::Completed);
    assert_eq!(v.hits.len(), 200);
    assert_eq!(v.rows[0].state, RowState::Partial);
    assert_eq!(v.rows[0].code, Some(Code::ResultLimit));
    assert_eq!(v.rows[0].matched_text_blocks, 240);
}
#[test]
fn exact_cancel_tombstone_conflict_and_release() {
    let r = requests::Requests::default();
    let q = request();
    assert!(matches!(
        r.reply(&q.agent_id, &q.request_id, false).unwrap(),
        Reply::Absent {
            admission_closed: false,
            ..
        }
    ));
    assert!(matches!(
        r.reply(&q.agent_id, &q.request_id, true).unwrap(),
        Reply::Absent {
            admission_closed: true,
            ..
        }
    ));
    assert_eq!(
        r.begin(q.clone(), || panic!("late source must not read"))
            .err()
            .unwrap()
            .code,
        Code::RequestConflict
    );
    assert_eq!(
        r.reply("other", &q.request_id, true).err().unwrap().code,
        Code::RequestConflict
    );
    let r = requests::Requests::default();
    let (job, fresh) = r.begin(q.clone(), || Ok(source("/tmp"))).unwrap();
    assert!(fresh);
    let mut changed = q.clone();
    changed.query = "changed".into();
    assert_eq!(
        r.begin(changed, || panic!()).err().unwrap().code,
        Code::RequestConflict
    );
    assert!(!r.release(&q.agent_id, &q.request_id).unwrap());
    r.reply(&q.agent_id, &q.request_id, true).unwrap();
    assert!(!job.snapshot().settled);
    job.finish(None);
    assert_eq!(job.snapshot().state, State::Cancelled);
    assert!(r.release(&q.agent_id, &q.request_id).unwrap());
    assert!(matches!(
        r.reply(&q.agent_id, &q.request_id, false).unwrap(),
        Reply::Absent {
            admission_closed: true,
            ..
        }
    ));
}
#[test]
fn separate_user_parts_do_not_create_cross_block_matches() {
    let v = run("split");
    assert!(v.hits.is_empty());
    assert_eq!(v.rows[0].text_blocks_read, 2);
    assert_eq!(v.rows[0].state, RowState::Complete);
}
#[test]
fn actual_public_wire() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().to_str().unwrap();
    let r = requests::Requests::default();
    let q = request();
    let (job, _) = r.begin(q.clone(), || Ok(source(path))).unwrap();
    let running = job.snapshot();
    job.update(|v| v.rows[0].state = RowState::Reading);
    run_selected(&job, 0, peer("normal", path))
        .unwrap()
        .publish(&job, 0)
        .unwrap();
    job.finish(None);
    let completed = job.snapshot();
    assert!(r.release(&q.agent_id, &q.request_id).unwrap());
    let closed = r.reply(&q.agent_id, &q.request_id, false).unwrap();
    let r = requests::Requests::default();
    let (cancel_job, _) = r.begin(q.clone(), || Ok(source(path))).unwrap();
    r.reply(&q.agent_id, &q.request_id, true).unwrap();
    let cancelling = cancel_job.snapshot();
    inventory::process::Control::pending_cleanup(cancel_job.as_ref());
    let pending = cancel_job.snapshot();
    cancel_job.finish(None);
    let cancelled = cancel_job.snapshot();
    let store = MetaStore::open(&temp.path().join("wire.db")).unwrap();
    let source = source(path);
    store.insert_agent(&source.agent).unwrap();
    store.upsert_session(&source.rows[0]).unwrap();
    let manager = AcpManager::new(temp.path().join("logs"), temp.path().into());
    let capability =
        source::capabilities(&store, &manager, &q.agent_id, &["saved-1".into()]).unwrap();
    println!(
        "HISTORY_SEARCH_WIRE={}",
        json!({
            "capabilityUnavailable":capability,
            "running":Reply::Operation{operation:Box::new(running)},
            "completed":Reply::Operation{operation:Box::new(completed)},
            "cancelling":Reply::Operation{operation:Box::new(cancelling)},
            "pendingCleanupPublication":Reply::Operation{operation:Box::new(pending)},
            "cancelled":Reply::Operation{operation:Box::new(cancelled)},
            "partial":Reply::Operation{operation:Box::new(run("many"))},
            "failed":Reply::Operation{operation:Box::new(run("unsupported"))},
            "closed":closed,"absent":requests::Requests::default().reply(&q.agent_id,&q.request_id,false).unwrap()
        })
    );
}

#[test]
fn invalid_cursor_page_is_not_published_and_cleanup_state_does_not_regress() {
    let v = run("repeat");
    assert_eq!(
        v.hits.len(),
        2,
        "repeated cursor page must remain unpublished"
    );
    let r = requests::Requests::default();
    let q = request();
    let (job, _) = r.begin(q.clone(), || Ok(source("/tmp"))).unwrap();
    inventory::process::Control::pending_cleanup(job.as_ref());
    r.reply(&q.agent_id, &q.request_id, true).unwrap();
    assert_eq!(job.snapshot().state, State::PendingCleanup);
}

#[test]
fn original_index_and_agent_selection_are_rechecked() {
    let temp = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&temp.path().join("meta.db")).unwrap();
    let saved = source(temp.path().to_str().unwrap());
    store.insert_agent(&saved.agent).unwrap();
    store.upsert_session(&saved.rows[0]).unwrap();
    saved.current(&store).unwrap();
    let mut changed = saved.rows[0].clone();
    changed.cwd.push_str("/changed");
    store.upsert_session(&changed).unwrap();
    assert_eq!(saved.current(&store).unwrap_err().code, Code::IndexChanged);
}

#[tokio::test(flavor = "multi_thread")]
async fn real_cancel_keeps_worker_scope_and_budget_until_owned_process_exit() {
    let _serial = inventory::execution::fixture_lock();
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().canonicalize().unwrap();
    let store = MetaStore::open(&path.join("meta.db")).unwrap();
    let source = source(path.to_str().unwrap());
    store.insert_agent(&source.agent).unwrap();
    let manager = AcpManager::new(path.join("logs"), path.clone());
    let scope = manager
        .reserve_preparation_action(&source.agent, &source.agent.command, &source.agent.args)
        .unwrap();
    let gate = crate::managed_update::UpdateAdmission::default();
    let activity = gate.activity().unwrap();
    let registry = requests::Requests::default();
    let q = request();
    let (job, _) = registry.begin(q.clone(), || Ok(source.clone())).unwrap();
    let marker = path.join("owned-pid");
    let owned_marker = marker.clone();
    let task = tokio::spawn(execute_with(
        store,
        job.clone(),
        activity,
        scope,
        move |_, job| {
            let mut cmd = Command::new(crate::platform_tests::python());
            cmd.args(["-u","-c","import os,sys,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);sys.stdin.readline();open(sys.argv[1],'w').write(str(os.getpid()));time.sleep(30)"]).arg(owned_marker);
            run_selected(job, 0, cmd).and_then(|read| read.publish(job, 0))
        },
    ));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let pid = std::fs::read_to_string(&marker)
        .unwrap()
        .parse::<i32>()
        .unwrap();
    let second = inventory::execution::acquire().unwrap();
    assert!(inventory::execution::acquire().is_err());
    registry.reply(&q.agent_id, &q.request_id, true).unwrap();
    assert!(!job.snapshot().settled);
    assert!(!registry.release(&q.agent_id, &q.request_id).unwrap());
    assert!(gate.update().is_err());
    assert!(
        manager
            .reserve_preparation_action(&source.agent, &source.agent.command, &source.agent.args)
            .is_err()
    );
    assert_eq!(crate::platform_tests::process_check(pid), 0);
    tokio::time::timeout(Duration::from_secs(6), task)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(crate::platform_tests::process_check(pid), 0);
    assert!(job.snapshot().settled);
    assert_eq!(job.snapshot().state, State::Cancelled);
    assert!(gate.update().is_ok());
    assert!(
        manager
            .reserve_preparation_action(&source.agent, &source.agent.command, &source.agent.args)
            .is_ok()
    );
    assert!(inventory::execution::acquire().is_ok());
    drop(second);
}

async fn unloaded_guard(alias: bool) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let other = root.join("other");
    std::fs::create_dir(&other).unwrap();
    let script = root.join("acp.py");
    std::fs::write(
        &script,
        r#"import sys,json
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='initialize':r={'protocolVersion':1,'agentCapabilities':{},'authMethods':[]}
 elif m.get('method')=='session/new':r={'sessionId':'native-1','configOptions':[]}
 else:continue
 print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)
"#,
    )
    .unwrap();
    let mut selected = source(root.to_str().unwrap());
    selected.agent.command = crate::platform_tests::python();
    selected.agent.args = vec!["-u".into(), script.to_str().unwrap().into()];
    let store = MetaStore::open(&root.join("meta.db")).unwrap();
    store.insert_agent(&selected.agent).unwrap();
    struct Owned(AcpManager);
    impl Drop for Owned {
        fn drop(&mut self) {
            self.0.stop_for_shutdown();
        }
    }
    let manager = Owned(AcpManager::new(root.join("logs"), root.clone()));
    let mut opening = selected.agent.clone();
    if alias {
        opening.id = "synthetic-alias".into();
        store.insert_agent(&opening).unwrap();
    }
    let opened = manager
        .0
        .open_session(&opening, &other, None, vec![], Arc::new(|_| {}), &store)
        .await
        .unwrap();
    assert_eq!(opened.session_id, "native-1");
    assert_eq!(
        selected.unopened(&manager.0).unwrap_err().code,
        Code::AlreadyOpen
    );
}

#[test]
fn post_read_directory_drift_discards_only_unverified_row_hits() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let first = root.join("first");
    let second = root.join("second");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    let mut saved = source(first.to_str().unwrap());
    let mut row = saved.rows[0].clone();
    row.id = "saved-2".into();
    row.cwd = second.to_str().unwrap().into();
    saved.rows.push(row);
    let store = MetaStore::open(&root.join("meta.db")).unwrap();
    store.insert_agent(&saved.agent).unwrap();
    for row in &saved.rows {
        store.upsert_session(row).unwrap();
    }
    let (job, _) = requests::Requests::default()
        .begin(request(), || Ok(saved))
        .unwrap();
    query_with(&store, &job, |index, row| {
        Ok(peer(if index == 0 { "normal" } else { "drift" }, &row.cwd))
    })
    .unwrap();
    job.finish(None);
    let value = job.snapshot();
    assert_eq!(value.rows[0].state, RowState::Complete);
    assert_eq!(value.rows[1].code, Some(Code::CwdUnavailable));
    assert_eq!(
        value.hits.len(),
        2,
        "unverified row must not publish hits after original directory drifts"
    );
    assert!(value.hits.iter().all(|h| h.row_id == "saved-1"));
}

#[test]
fn reaped_pending_cleanup_does_not_label_next_row_as_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let mut saved = source(root.to_str().unwrap());
    let mut row = saved.rows[0].clone();
    row.id = "saved-2".into();
    saved.rows.push(row);
    let store = MetaStore::open(&root.join("meta.db")).unwrap();
    store.insert_agent(&saved.agent).unwrap();
    for row in &saved.rows {
        store.upsert_session(row).unwrap();
    }
    let (job, _) = requests::Requests::default()
        .begin(request(), || Ok(saved))
        .unwrap();
    query_with(&store, &job, |index, row| {
        if index == 0 {
            // Controlled production publication; runner still must actually reap this peer.
            inventory::process::Control::pending_cleanup(job.as_ref());
        } else {
            assert_eq!(job.snapshot().state, State::Running);
            assert_eq!(job.snapshot().code, None);
        }
        Ok(peer(
            if index == 0 { "unsupported" } else { "normal" },
            &row.cwd,
        ))
    })
    .unwrap();
    job.finish(None);
    assert_eq!(job.snapshot().rows[1].state, RowState::Complete);
}

#[test]
fn post_read_index_drift_keeps_progress_but_retires_unconfirmed_text() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let saved = source(root.to_str().unwrap());
    let store = MetaStore::open(&root.join("meta.db")).unwrap();
    store.insert_agent(&saved.agent).unwrap();
    store.upsert_session(&saved.rows[0]).unwrap();
    let (job, _) = requests::Requests::default()
        .begin(request(), || Ok(saved.clone()))
        .unwrap();
    let (during, outcome) = std::thread::scope(|scope| {
        let reader = scope.spawn(|| query_with(&store, &job, |_, row| Ok(peer("hold", &row.cwd))));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.join("read-ready").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let during = job.snapshot();
        let mut changed = saved.rows[0].clone();
        changed.title = Some("synthetic changed index".into());
        store.upsert_session(&changed).unwrap();
        std::fs::write(root.join("release-read"), b"release").unwrap();
        (during, reader.join().unwrap())
    });
    assert_eq!(during.rows[0].matched_text_blocks, 2);
    assert!(
        during.hits.is_empty(),
        "in-flight row text remains private until source validation"
    );
    assert_eq!(during.rows[0].state, RowState::Reading);
    assert_eq!(outcome.as_ref().unwrap_err().code, Code::IndexChanged);
    job.finish(outcome.err().map(|e| e.code));
    let failed = job.snapshot();
    assert!(failed.hits.is_empty());
    assert_eq!(failed.rows[0].matched_text_blocks, 2);
    assert_eq!(failed.state, State::Failed);
    println!(
        "HISTORY_SEARCH_POST_READ_WIRE={}",
        json!({
            "readingUnconfirmed": Reply::Operation { operation: Box::new(during) },
            "sourceDrift": Reply::Operation { operation: Box::new(failed) }
        })
    );
}

#[test]
fn saturated_used_ids_keep_existing_identity_and_never_reopen_late_admission() {
    let registry = requests::Requests::default();
    let original = request();
    let (job, _) = registry
        .begin(original.clone(), || Ok(source("/tmp")))
        .unwrap();
    for n in 2..=4096 {
        let id = format!("00000000-0000-4000-8000-{n:012x}");
        registry.reply(&original.agent_id, &id, true).unwrap();
    }
    let (same, fresh) = registry
        .begin(original.clone(), || panic!("original source is retained"))
        .unwrap();
    assert!(!fresh);
    assert!(Arc::ptr_eq(&same, &job));
    let mut next = original.clone();
    next.request_id = "ffffffff-ffff-4fff-8fff-ffffffffffff".into();
    assert_eq!(
        registry
            .begin(next.clone(), || panic!(
                "closed admission must not read source"
            ))
            .err()
            .unwrap()
            .code,
        Code::RequestCapacity
    );
    assert!(matches!(
        registry
            .reply(&next.agent_id, &next.request_id, false)
            .unwrap(),
        Reply::Absent {
            admission_closed: true,
            ..
        }
    ));
    assert!(
        !registry
            .release(&original.agent_id, &original.request_id)
            .unwrap()
    );
    registry
        .reply(&original.agent_id, &original.request_id, true)
        .unwrap();
    job.finish(None);
    assert!(
        registry
            .release(&original.agent_id, &original.request_id)
            .unwrap()
    );
    assert_eq!(
        registry
            .begin(original, || panic!("released id must not be reused"))
            .err()
            .unwrap()
            .code,
        Code::RequestConflict
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn unloaded_guard_checks_native_id_across_owned_directories() {
    unloaded_guard(false).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn unloaded_guard_checks_loaded_native_id_of_proven_entry_alias() {
    unloaded_guard(true).await;
}
