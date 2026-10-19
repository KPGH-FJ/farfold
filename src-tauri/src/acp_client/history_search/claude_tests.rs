use super::*;
use serde_json::json;
use std::{path::PathBuf, process::Command};
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    sdk: PathBuf,
    saved: source::Source,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let adapter = root.join("node_modules/@agentclientprotocol/claude-agent-acp");
        let sdk = root.join("node_modules/@anthropic-ai/claude-agent-sdk");
        std::fs::create_dir_all(adapter.join("dist")).unwrap();
        std::fs::create_dir_all(&sdk).unwrap();
        let entry = adapter.join("dist/index.js");
        std::fs::write(&entry, "throw Error('ADAPTER_MUST_NOT_RUN')").unwrap();
        std::fs::write(adapter.join("package.json"),json!({"name":"@agentclientprotocol/claude-agent-acp","bin":{"claude-agent-acp":"dist/index.js"},"dependencies":{"@anthropic-ai/claude-agent-sdk":"0.0.0-synthetic"}}).to_string()).unwrap();
        std::fs::write(sdk.join("package.json"),json!({"name":"@anthropic-ai/claude-agent-sdk","type":"module","exports":{".":{"default":"./sdk.mjs","types":"./sdk.d.ts"}}}).to_string()).unwrap();
        #[cfg(windows)]
        let expected_dir = super::sdk_paths::disk_path(
            &crate::file_access::PinnedPath::directory(&root)
                .unwrap()
                .path,
        )
        .unwrap();
        #[cfg(not(windows))]
        let expected_dir = root.to_str().unwrap().to_owned();
        std::fs::write(
            sdk.join("sdk.mjs"),
            format!(
                "const expectedDir={};\nconst mode={};\n{}",
                json!(expected_dir),
                json!(mode),
                include_str!("claude_peer.mjs")
            ),
        )
        .unwrap();
        let node = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success());
        let mut saved = tests::source(root.to_str().unwrap());
        saved.agent.id = "registry:claude-acp".into();
        saved.agent.source = "registry".into();
        saved.agent.command = String::from_utf8(node.stdout).unwrap().trim().into();
        saved.agent.args = vec![entry.to_str().unwrap().into()];
        saved.rows[0].agent_id = saved.agent.id.clone();
        saved.rows[0].native_session_id = Some("12345678-1234-1234-1234-123456789abc".into());
        saved.route = launch::Route::Sdk(launch::resolve(&saved.agent).unwrap());
        Self {
            _temp: temp,
            root,
            sdk,
            saved,
        }
    }
    fn job(&self) -> Arc<Job> {
        let mut q = tests::request();
        q.agent_id = self.saved.agent.id.clone();
        requests::Requests::default()
            .begin(q, || Ok(self.saved.clone()))
            .unwrap()
            .0
    }
    fn command(&self) -> Command {
        let mut c = Command::new(&self.saved.agent.command);
        c.args([
            "--input-type=module",
            "--eval",
            include_str!("claude_read.mjs"),
        ])
        .current_dir(&self.root);
        c
    }
    fn run(&self) -> SearchOperation {
        let job = self.job();
        job.update(|v| v.rows[0].state = RowState::Reading);
        let result = run_selected(&job, 0, self.command()).and_then(|read| read.publish(&job, 0));
        if let Err(e) = &result {
            job.row_failed(0, e.code);
        }
        job.finish(result.err().map(|e| e.code));
        job.snapshot()
    }
}
#[test]
fn claude_selected_package_metadata_does_not_execute_adapter_or_sdk() {
    let f = Fixture::new("normal");
    std::fs::write(f.sdk.join("sdk.mjs"), "throw Error('MUST_NOT_IMPORT')").unwrap();
    let resolved = launch::resolve(&f.saved.agent).unwrap();
    assert_eq!(resolved.sdk, f.sdk.join("sdk.mjs"));
    let mut changed = f.saved.agent.clone();
    changed.args.push("--require=bad".into());
    assert_eq!(
        launch::resolve(&changed).err().unwrap().code,
        Code::EntryUnverified
    );
    std::fs::write(f.sdk.join("package.json"),json!({"name":"@anthropic-ai/claude-agent-sdk","type":"module","exports":{".":{"import":"./sdk.mjs","default":"./sdk.mjs"}}}).to_string()).unwrap();
    assert_eq!(
        launch::resolve(&f.saved.agent).err().unwrap().code,
        Code::EntryUnverified
    );
}
#[test]
fn claude_real_owned_helper_returns_partial_real_uuid_and_distinct_parts() {
    let v = Fixture::new("normal").run();
    assert_eq!(v.state, State::Completed);
    assert_eq!(v.source, "officialSdk");
    assert_eq!(v.rows[0].state, RowState::Partial);
    assert_eq!(v.rows[0].code, Some(Code::CoverageUnconfirmed));
    assert_eq!(v.hits.len(), 2);
    assert_eq!(v.hits[0].matches, vec![Range { start: 3, end: 8 }]);
    let wire = serde_json::to_value(&v).unwrap();
    assert!(wire["hits"][0].get("turnId").is_none());
    assert_eq!(wire["hits"][1]["messageLocator"]["partIndex"], 2);
    assert!(!wire.to_string().contains("PRIVATE_TOOL"));
}
#[test]
fn claude_ambiguous_empty_drift_identity_and_api_absence_never_complete_empty() {
    for (mode, code) in [
        ("empty", Code::SourceUnconfirmed),
        ("drift", Code::SourceChanged),
        ("wrong", Code::SourceUnconfirmed),
        ("missing-size", Code::SourceUnconfirmed),
        ("too-large", Code::SourceTooLarge),
        ("unsupported", Code::Unsupported),
        ("wrong-record", Code::InvalidOutput),
    ] {
        let v = Fixture::new(mode).run();
        assert_eq!(v.code, Some(code), "{mode}");
        assert!(v.hits.is_empty(), "{mode}");
        assert_eq!(v.rows[0].state, RowState::Failed, "{mode}");
    }
}
#[test]
fn claude_post_cleanup_index_change_never_publishes_text() {
    let f = Fixture::new("hold");
    let store = MetaStore::open(&f.root.join("meta.db")).unwrap();
    store.insert_agent(&f.saved.agent).unwrap();
    store.upsert_session(&f.saved.rows[0]).unwrap();
    let job = f.job();
    let outcome = std::thread::scope(|scope| {
        let reader = scope.spawn(|| query_with(&store, &job, |_, _| Ok(f.command())));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !f.root.join("read-ready").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(f.root.join("read-ready").exists());
        assert!(job.snapshot().hits.is_empty());
        let mut changed = f.saved.rows[0].clone();
        changed.title = Some("changed".into());
        store.upsert_session(&changed).unwrap();
        std::fs::write(f.root.join("release-read"), b"ok").unwrap();
        reader.join().unwrap()
    });
    assert_eq!(outcome.unwrap_err().code, Code::IndexChanged);
    assert!(job.snapshot().hits.is_empty());
}
#[test]
fn claude_actual_public_wire() {
    let f = Fixture::new("normal");
    let registry = requests::Requests::default();
    let mut q = tests::request();
    q.agent_id = f.saved.agent.id.clone();
    let (job, _) = registry.begin(q.clone(), || Ok(f.saved.clone())).unwrap();
    let running = job.snapshot();
    run_selected(&job, 0, f.command())
        .unwrap()
        .publish(&job, 0)
        .unwrap();
    job.finish(None);
    let completed = job.snapshot();
    registry.release(&q.agent_id, &q.request_id).unwrap();
    let cap = Selection {
        agent_id: q.agent_id.clone(),
        selection_id: Some(q.selection_id.clone()),
        valid_for_ms: 300000,
        source: Some("officialSdk"),
        sdk_scope: Some(SdkScope::partial()),
        scope: "userAndAssistantText",
        availability: "available",
        code: None,
        rows: vec![SelectionRow {
            row_id: f.saved.rows[0].id.clone(),
            availability: "available",
            code: None,
        }],
    };
    println!(
        "CLAUDE_HISTORY_WIRE={}",
        json!({"capabilityShape":cap,"running":Reply::Operation{operation:Box::new(running)},"completed":Reply::Operation{operation:Box::new(completed)},"closed":registry.reply(&q.agent_id,&q.request_id,false).unwrap(),"empty":Reply::Operation{operation:Box::new(Fixture::new("empty").run())},"sourceChanged":Reply::Operation{operation:Box::new(Fixture::new("drift").run())}})
    );
}
#[test]
fn claude_resolver_rejects_escape_drift_and_unreviewed_identity() {
    let f = Fixture::new("normal");
    let old = launch::resolve(&f.saved.agent).unwrap();
    let mut row = f.saved.agent.clone();
    row.id = "custom-claude".into();
    assert_eq!(launch::resolve(&row).err().unwrap().code, Code::NotReviewed);
    std::fs::write(f.sdk.join("sdk.mjs"), "// changed").unwrap();
    assert!(launch::Route::Sdk(old).current(&f.saved.agent).is_err());
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("sdk.mjs"), "// outside").unwrap();
        std::fs::remove_file(f.sdk.join("sdk.mjs")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("sdk.mjs"), f.sdk.join("sdk.mjs")).unwrap();
        assert_eq!(
            launch::resolve(&f.saved.agent).err().unwrap().code,
            Code::EntryUnverified
        );
    }
}
#[test]
fn claude_unknown_preloads_are_unavailable_without_discarding_selected_environment() {
    let f = Fixture::new("normal");
    let mut row = f.saved.agent.clone();
    row.env = vec![("SYNTHETIC_EXISTING_SETTING".into(), "preserved".into())];
    let env =
        launch::selected_environment(&row, [("HOME".into(), "/synthetic-home".into())].into())
            .unwrap();
    assert_eq!(env.get("HOME").unwrap(), "/synthetic-home");
    assert_eq!(env.get("SYNTHETIC_EXISTING_SETTING").unwrap(), "preserved");
    for key in [
        "NODE_OPTIONS",
        "NODE_PATH",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
    ] {
        let mut row = f.saved.agent.clone();
        row.env = vec![(key.into(), "synthetic-preload".into())];
        assert_eq!(
            launch::selected_environment(&row, Default::default())
                .unwrap_err()
                .code,
            Code::EnvironmentUnavailable
        );
    }
}
#[test]
fn claude_fixed_helper_environment_names_follow_the_platform_without_running_injections() {
    let template = tests::source("/synthetic").agent;
    let names = [
        ("NODE_OPTIONS", "node_options"),
        ("NODE_PATH", "Node_Path"),
        ("LD_PRELOAD", "ld_preload"),
        ("DYLD_INSERT_LIBRARIES", "DyLd_InSeRt_LiBrArIeS"),
        ("DYLD_LIBRARY_PATH", "dyld_LIBRARY_path"),
    ];
    let mut clean: std::collections::HashMap<String, String> = names
        .iter()
        .map(|(name, _)| ((*name).into(), String::new()))
        .collect();
    clean.insert("HOME".into(), "/synthetic-home".into());
    clean.insert("SYNTHETIC_EXISTING_SETTING".into(), "inherited".into());
    for (name, mixed) in names {
        for selected in [false, true] {
            let mut row = template.clone();
            row.env = vec![("SYNTHETIC_EXISTING_SETTING".into(), "selected".into())];
            let mut inherited = clean.clone();
            // Windows gets one mixed-case spelling. Unix shadows any actual
            // uppercase process value with the original explicit empty value.
            inherited.remove(name);
            #[cfg(unix)]
            inherited.insert(name.into(), String::new());
            if selected {
                row.env.push((mixed.into(), "synthetic-preload".into()));
            } else {
                inherited.insert(mixed.into(), "synthetic-preload".into());
            }
            let mut expected = inherited.clone();
            expected.extend(row.env.iter().cloned());
            let result = launch::selected_environment(&row, inherited);
            #[cfg(windows)]
            assert_eq!(result.unwrap_err().code, Code::EnvironmentUnavailable);
            #[cfg(unix)]
            assert_eq!(result.unwrap(), expected);
        }
    }
    // Exact selected values still override the inherited map, without changing
    // unrelated keys or rejecting empty protected settings on either platform.
    let mut row = template.clone();
    row.env = vec![
        ("SYNTHETIC_EXISTING_SETTING".into(), "selected".into()),
        ("NODE_OPTIONS".into(), String::new()),
    ];
    let mut inherited = clean.clone();
    inherited.insert("NODE_OPTIONS".into(), "synthetic-preload".into());
    let mut expected = inherited.clone();
    expected.extend(row.env.iter().cloned());
    assert_eq!(
        launch::selected_environment(&row, inherited).unwrap(),
        expected
    );
}
#[test]
fn claude_helper_decode_units_are_part_of_rust_verification() {
    let output = Command::new("node")
        .args([
            "--test",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/acp_client/history_search/claude_read.test.mjs"
            ),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}
#[test]
fn claude_import_hang_observer_drop_keeps_real_scope_and_shared_slot_until_cancel_cleanup() {
    let _serial = inventory::execution::fixture_lock();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let f = Fixture::new("normal");
        std::fs::write(f.sdk.join("sdk.mjs"),"import fs from 'node:fs';fs.writeFileSync('owned-pid',String(process.pid));process.on('SIGTERM',()=>{});await new Promise(()=>{setInterval(()=>{},1000)});").unwrap();
        // Re-capture this controlled selected installation after fixture content creation.
        let mut saved = f.saved.clone();
        saved.route = launch::Route::Sdk(launch::resolve(&saved.agent).unwrap());
        let store = MetaStore::open(&f.root.join("meta.db")).unwrap();
        store.insert_agent(&saved.agent).unwrap();
        let manager = AcpManager::new(f.root.join("logs"), f.root.clone());
        let scope = manager
            .reserve_preparation_action(&saved.agent, &saved.agent.command, &saved.agent.args)
            .unwrap();
        let gate = crate::managed_update::UpdateAdmission::default();
        let activity = gate.activity().unwrap();
        let mut q = tests::request();
        q.agent_id = saved.agent.id.clone();
        let registry = requests::Requests::default();
        let (job, _) = registry.begin(q.clone(), || Ok(saved.clone())).unwrap();
        let command = f.command();
        let task = tokio::spawn(execute_with(
            store,
            job.clone(),
            activity,
            scope,
            move |_, job| run_selected(job, 0, command).and_then(|r| r.publish(job, 0)),
        ));
        let marker = f.root.join("owned-pid");
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
        task.abort();
        let _ = task.await;
        assert!(gate.update().is_err());
        assert!(
            manager
                .reserve_preparation_action(&saved.agent, &saved.agent.command, &saved.agent.args)
                .is_err()
        );
        assert!(!job.snapshot().settled);
        registry.reply(&q.agent_id, &q.request_id, true).unwrap();
        assert!(!job.snapshot().settled);
        assert!(inventory::execution::acquire().is_err());
        tokio::time::timeout(Duration::from_secs(7), async {
            while !job.snapshot().settled {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(job.snapshot().state, State::Cancelled);
        assert_ne!(crate::platform_tests::process_check(pid), 0);
        assert!(gate.update().is_ok());
        assert!(
            manager
                .reserve_preparation_action(&saved.agent, &saved.agent.command, &saved.agent.args)
                .is_ok()
        );
        drop(second);
        assert!(inventory::execution::acquire().is_ok());
    });
}
#[test]
fn claude_pipe_holding_descendant_is_reaped_before_result_is_published() {
    let f = Fixture::new("normal");
    let saved = f.saved.clone();
    let job = f.job();
    let pidfile = f.root.join("descendant-pid");
    let leaderfile = f.root.join("leader-pid");
    // One owned Python peer launches itself with both output pipes inherited,
    // then exits. No SDK, Agent, shell, detached process or new environment.
    const PEER: &str = r#"import sys, os, time, signal, json, subprocess
def mark(file):
    with open(file + ".pending", "w", encoding="ascii") as marker:
        marker.write(str(os.getpid()))
    os.replace(file + ".pending", file)
if sys.argv[1] == "child":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    mark(sys.argv[2])
    time.sleep(30)
    os._exit(0)
sys.stdin.readline()
mark(sys.argv[2])
child = subprocess.Popen(
    [sys.executable, "-u", "-c", sys.argv[3], "child", sys.argv[1]],
    stdin=subprocess.DEVNULL,
    stdout=sys.stdout,
    stderr=sys.stderr,
    close_fds=True,
)
print(json.dumps({"kind": "error", "code": "sourceUnconfirmed"}), flush=True)
os._exit(0)
"#;
    let mut command = Command::new(crate::platform_tests::python());
    command
        .args(["-u", "-c", PEER])
        .arg(&pidfile)
        .arg(&leaderfile)
        .arg(PEER);
    let snapshot = std::thread::scope(|scope| {
        let worker = scope.spawn(|| run_selected(&job, 0, command));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pidfile.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(pidfile.exists());
        let leader = std::fs::read_to_string(&leaderfile)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        while crate::platform_tests::process_check(leader) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_ne!(crate::platform_tests::process_check(leader), 0);
        let descendant = std::fs::read_to_string(&pidfile)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        assert_eq!(crate::platform_tests::process_check(descendant), 0);
        assert!(!worker.is_finished());
        assert!(job.snapshot().hits.is_empty());
        job.cancel();
        let result = worker.join().unwrap();
        assert_eq!(result.err().unwrap().code, Code::Cancelled);
        job.finish(Some(Code::Cancelled));
        job.snapshot()
    });
    let pid = std::fs::read_to_string(pidfile)
        .unwrap()
        .parse::<i32>()
        .unwrap();
    assert_ne!(crate::platform_tests::process_check(pid), 0);
    assert!(snapshot.hits.is_empty());
    assert_eq!(snapshot.source, saved.route.source());
}
#[test]
fn claude_nested_declared_dependency_is_resolved_without_cwd_or_global_search() {
    let f = Fixture::new("normal");
    let adapter = std::path::Path::new(&f.saved.agent.args[0])
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let nested = adapter.join("node_modules/@anthropic-ai/claude-agent-sdk");
    std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
    std::fs::rename(&f.sdk, &nested).unwrap();
    let resolved = launch::resolve(&f.saved.agent).unwrap();
    assert_eq!(resolved.sdk, nested.join("sdk.mjs"));
    let mut saved = f.saved.clone();
    saved.route = launch::Route::Sdk(resolved);
    let mut q = tests::request();
    q.agent_id = saved.agent.id.clone();
    let (job, _) = requests::Requests::default()
        .begin(q, || Ok(saved))
        .unwrap();
    run_selected(&job, 0, f.command())
        .unwrap()
        .publish(&job, 0)
        .unwrap();
    assert_eq!(job.snapshot().hits.len(), 2);
}
#[test]
fn claude_sdk_surface_is_suppressed_as_one_branch_on_common_failure() {
    let f = Fixture::new("normal");
    let route = Ok(f.saved.route.clone());
    let (source, scope) = source::public_surface(&route, Some(Code::EnvironmentUnavailable));
    assert!(source.is_none());
    assert!(scope.is_none());
    let (source, scope) = source::public_surface(&route, None);
    assert_eq!(source, Some("officialSdk"));
    assert_eq!(scope.unwrap().coverage, "partial");
}

#[test]
fn sdk_dos_presentation_preserves_case_unicode_and_refuses_namespace_forms() {
    for (input, expected) in [
        (r"C:\", r"C:\"),
        (r"C:\Owned\中文", r"C:\Owned\中文"),
        (r"\\?\C:\Owned\Case", r"C:\Owned\Case"),
        (r"c:\Owned\Case", r"c:\Owned\Case"),
    ] {
        assert_eq!(sdk_paths::disk_path(input).unwrap(), expected);
    }
    for input in [
        r"\\server\share\x",
        r"\\?\UNC\s\x",
        r"\\.\C:\x",
        r"\\?\Volume{00000000-0000-0000-0000-000000000000}\x",
        r"C:relative",
        r"C:/x",
        r"C:\x:ads",
        r"C:\x\..\y",
        r"C:\x\.\y",
        r"C:\x\\y",
        r"C:\CON.txt",
        r"C:\x.",
        r"C:\x ",
    ] {
        assert!(sdk_paths::disk_path(input).is_err(), "{input}");
    }
    // A tilde by itself is not an alias classifier. Native held-path admission
    // separately rejects actual 8.3 spelling via the existing ordinal policy.
    assert_eq!(
        sdk_paths::disk_path(r"C:\owned~name").unwrap(),
        r"C:\owned~name"
    );
}

#[test]
#[cfg(windows)]
fn sdk_windows_context_uses_one_plain_cwd_and_native_full_identity() {
    let f = Fixture::new("normal");
    let launch::Route::Sdk(resolved) = &f.saved.route else {
        panic!("SDK fixture")
    };
    let context = sdk_paths::Context::new(&f.saved.rows[0].cwd, resolved).unwrap();
    assert!(!context.paths.cwd.starts_with(r"\\?\"));
    let native = crate::file_access::PinnedPath::directory(&f.root).unwrap();
    let sdk = crate::file_access::PinnedPath::directory(std::path::Path::new(&context.paths.cwd))
        .unwrap();
    assert!(crate::file_access::same_object(native.file(), sdk.file()).unwrap());
    let mut command = f.command();
    context.command(&mut command).unwrap();
    assert_eq!(
        command.get_current_dir().unwrap(),
        std::path::Path::new(&context.paths.cwd)
    );
    let value = f.run();
    assert_eq!(value.state, State::Completed);
    assert_eq!(value.hits.len(), 2);
    assert_eq!(value.rows[0].state, RowState::Partial);
}

#[test]
#[cfg(windows)]
fn sdk_windows_read_guard_keeps_source_write_denied_until_publication() {
    let f = Fixture::new("normal");
    let job = f.job();
    let module = f.sdk.join("sdk.mjs");
    let read = run_selected(&job, 0, f.command()).unwrap();
    assert!(read.sdk_context.is_some());
    assert!(job.snapshot().hits.is_empty());
    // The real Context still holds the same regular FileObject with share-read
    // only. Opening for write must fail; never release pins to manufacture drift.
    let blocked = std::fs::OpenOptions::new()
        .write(true)
        .open(&module)
        .expect_err("the result still owns its source pins");
    assert_eq!(
        blocked.raw_os_error(),
        Some(windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION as i32)
    );
    read.publish(&job, 0).unwrap();
    assert_eq!(job.snapshot().hits.len(), 2);
    // Publication consumes the final Context; this is a write-open capability
    // check only, not an edit or a claim that a held source can drift in place.
    drop(
        std::fs::OpenOptions::new()
            .write(true)
            .open(&module)
            .unwrap(),
    );
}

#[test]
#[cfg(windows)]
fn sdk_windows_disposable_cwd_probe_cannot_authorize_a_changed_module() {
    let f = Fixture::new("normal");
    let launch::Route::Sdk(resolved) = &f.saved.route else {
        panic!("SDK fixture")
    };
    sdk_paths::probe_cwd(&f.saved.rows[0].cwd).unwrap();
    // No source Context exists here. A hint cannot keep installation files
    // pinned or turn its old watched stamps into later read authority.
    std::fs::write(
        f.sdk.join("sdk.mjs"),
        "// replaced after disposable cwd hint",
    )
    .unwrap();
    assert_eq!(
        sdk_paths::Context::new(&f.saved.rows[0].cwd, resolved)
            .err()
            .unwrap()
            .code,
        Code::SelectionChanged
    );
    assert!(f.saved.route.current(&f.saved.agent).is_err());
}

#[test]
fn sdk_configuration_wait_rechecks_selected_module_before_helper_dispatch() {
    let _serial = inventory::execution::fixture_lock();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let f = Fixture::new("normal");
        let store = MetaStore::open(&f.root.join("meta.db")).unwrap();
        store.insert_agent(&f.saved.agent).unwrap();
        store.upsert_session(&f.saved.rows[0]).unwrap();
        let manager = AcpManager::new(f.root.join("logs"), f.root.clone());
        let scope = manager
            .reserve_preparation_action(&f.saved.agent, &f.saved.agent.command, &f.saved.agent.args)
            .unwrap();
        let gate = crate::managed_update::UpdateAdmission::default();
        let activity = gate.activity().unwrap();
        let configuration = crate::install_job::configuration_guard(&f.saved.agent.id).await;
        let job = f.job();
        let mut command = Some(f.command());
        let dispatches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = dispatches.clone();
        let task = execute_with(store, job.clone(), activity, scope, move |store, job| {
            query_with(store, job, |_, _| {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(command.take().expect("one selected row"))
            })
        });
        tokio::pin!(task);
        // Poll the actual execute_with future while this test holds its real
        // configuration lock. Pending proves it retained its execution permit;
        // do not race a non-waiting worker by polling acquire from another task.
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(task.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        let second = inventory::execution::acquire().unwrap();
        assert!(inventory::execution::acquire().is_err());
        assert!(!job.snapshot().settled);
        assert_eq!(dispatches.load(std::sync::atomic::Ordering::SeqCst), 0);
        // No real Context/source pins exist before the configuration grant.
        std::fs::write(
            f.sdk.join("sdk.mjs"),
            "// changed while configuration was waiting",
        )
        .unwrap();
        drop(configuration);
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap();
        let value = job.snapshot();
        assert_eq!(value.state, State::Failed);
        assert_eq!(value.code, Some(Code::SelectionChanged));
        assert!(value.hits.is_empty());
        assert_eq!(dispatches.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(gate.update().is_ok());
        assert!(
            manager
                .reserve_preparation_action(
                    &f.saved.agent,
                    &f.saved.agent.command,
                    &f.saved.agent.args
                )
                .is_ok()
        );
        drop(second);
        assert!(inventory::execution::acquire().is_ok());
    });
}
