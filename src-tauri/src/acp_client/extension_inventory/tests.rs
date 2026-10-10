//! Synthetic public packages and owned processes only; never an installed Agent.
use super::*;
use serde_json::json;

const ID: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
fn row() -> serde_json::Value {
    json!({"name":"example","enabled":false,"auth_status":"not_logged_in",
        "transport":{"type":"stdio","command":"PRIVATE_COMMAND","args":["PRIVATE_ARG"],
        "env":{"TOKEN":"PRIVATE_SECRET"},"cwd":"/PRIVATE_PATH"},
        "disabled_reason":"PRIVATE_REASON","future":{"token":"PRIVATE_FUTURE"}})
}
#[test]
fn only_public_fields_leave_decoder() {
    let result = output::parse(&serde_json::to_vec(&vec![row()]).unwrap()).unwrap();
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["items"][0]["reportedEnabled"], false);
    assert_eq!(value["items"][0]["reportedAuth"], "notLoggedIn");
    assert_eq!(value["sessionApplicability"], "unverified");
    assert!(!value.to_string().contains("PRIVATE"));
    let mut expected = json!({
        "id": 0,
        "name": "example",
        "transport": "stdio",
        "reportedEnabled": false,
        "reportedAuth": "notLoggedIn",
        "origin": "unreported",
        "configurationLayer": "unreported",
        "connection": "unverified",
        "tools": "unreported",
        "enablement": {"availability": "unavailable", "reason": "unsupportedTransport"}
    });
    assert_eq!(value["items"][0], expected);

    let (snapshot, targets) =
        output::parse_private(&serde_json::to_vec(&vec![row()]).unwrap()).unwrap();
    assert_eq!(targets.len(), 1);
    assert!(targets[0].identity.to_string().contains("PRIVATE_SECRET"));
    let managed = serde_json::to_value(snapshot).unwrap();
    expected["enablement"] = json!({"availability": "available", "reason": null});
    assert_eq!(managed["items"][0], expected);
    assert_eq!(managed["sessionApplicability"], "unverified");
    assert!(!managed.to_string().contains("PRIVATE"));
}
#[test]
fn urls_headers_helpers_and_hostnames_never_leave_http_transport() {
    let mut item = row();
    item["transport"] = json!({"type":"streamable_http","url":"https://PRIVATE:SECRET@host.test/x?key=PRIVATE",
        "http_headers":{"PRIVATE_HEADER":"PRIVATE"},"env_http_headers":{"PRIVATE":"PRIVATE"},
        "http_headers_helper":["PRIVATE"],"bearer_token_env_var":"PRIVATE"});
    let result = output::parse(&serde_json::to_vec(&vec![item]).unwrap()).unwrap();
    assert_eq!(result.items[0].transport, "streamableHttp");
    let safe = serde_json::to_string(&result).unwrap();
    assert!(!safe.contains("PRIVATE"));
    assert!(!safe.contains("host.test"));
}
#[test]
fn unsafe_name_is_an_unnamed_row_not_silently_removed() {
    for name in [
        "https://name:secret@host",
        "/home/private",
        "escape\u{1b}[31m",
        "bidi\u{202e}",
        "",
        "TOKEN=secret",
    ] {
        let mut item = row();
        item["name"] = json!(name);
        let value = output::parse(&serde_json::to_vec(&vec![item]).unwrap()).unwrap();
        assert_eq!(value.items.len(), 1);
        assert_eq!(value.items[0].name, None);
    }
}
#[test]
fn complete_empty_requires_valid_full_array() {
    assert!(output::parse(b"[]").unwrap().items.is_empty());
    for invalid in [
        b"".as_slice(),
        b"null",
        b"{}",
        b"[] trailing",
        b"[",
        b"No servers",
    ] {
        assert_eq!(
            output::parse(invalid).unwrap_err().code,
            Code::InvalidOutput
        );
    }
}
#[test]
fn published_known_fields_are_strict_and_duplicates_fail() {
    for (field, value) in [
        ("name", json!(false)),
        ("enabled", json!("true")),
        ("auth_status", json!(null)),
        ("transport", json!([])),
    ] {
        let mut item = row();
        item[field] = value;
        assert_eq!(
            output::parse(&serde_json::to_vec(&vec![item]).unwrap())
                .unwrap_err()
                .code,
            Code::InvalidOutput
        );
    }
    assert!(output::parse(br#"[{"name":"a","name":"b","enabled":true,"auth_status":"oauth","transport":{"type":"stdio"}}]"#).is_err());
    assert!(output::parse(&serde_json::to_vec(&vec![row(), row()]).unwrap()).is_err());
}
#[test]
fn unknown_enums_stay_unknown_never_connected() {
    let mut item = row();
    item["auth_status"] = json!("future");
    item["transport"]["type"] = json!("future");
    let result = output::parse(&serde_json::to_vec(&vec![item]).unwrap()).unwrap();
    assert_eq!(result.items[0].reported_auth, "unknown");
    assert_eq!(result.items[0].transport, "unknown");
    assert_eq!(result.items[0].connection, "unverified");
}
#[test]
fn whole_output_depth_and_row_budgets_reject_without_partial_success() {
    assert_eq!(
        output::parse(&vec![b' '; output::STDOUT_LIMIT + 1])
            .unwrap_err()
            .code,
        Code::OutputLimit
    );
    let mut item = row();
    item["future"] =
        serde_json::from_str(&format!("{}0{}", "[".repeat(32), "]".repeat(32))).unwrap();
    assert!(output::parse(&serde_json::to_vec(&vec![item]).unwrap()).is_err());
    let rows: Vec<_> = (0..513)
        .map(|i| {
            let mut r = row();
            r["name"] = json!(format!("item-{i}"));
            r
        })
        .collect();
    assert_eq!(
        output::parse(&serde_json::to_vec(&rows).unwrap())
            .unwrap_err()
            .code,
        Code::OutputLimit
    );
}
#[test]
fn early_cancel_cannot_be_revived_and_cannot_cancel_other_agent() {
    let registry = requests::Requests::default();
    let cancelled = registry.cancel("a", ID).unwrap();
    assert!(cancelled.cancel_requested);
    assert!(cancelled.operation.is_none());
    assert!(matches!(
        registry.begin("a", "/tmp", ID, ID, Kind::Mcp),
        Err(Failure {
            code: Code::Cancelled
        })
    ));
    assert!(matches!(
        registry.begin("b", "/tmp", ID, ID, Kind::Mcp),
        Err(Failure {
            code: Code::RequestConflict
        })
    ));
    assert_eq!(
        registry.cancel("b", ID).unwrap_err().code,
        Code::RequestConflict
    );
}
#[test]
fn same_request_is_one_owner_and_different_payload_cannot_replace_it() {
    let registry = requests::Requests::default();
    let (first, fresh) = registry.begin("a", "/tmp", ID, ID, Kind::Mcp).unwrap();
    assert!(fresh);
    let (second, fresh) = registry.begin("a", "/tmp", ID, ID, Kind::Mcp).unwrap();
    assert!(!fresh);
    assert!(Arc::ptr_eq(&first, &second));
    assert!(matches!(
        registry.begin("a", "/changed", ID, ID, Kind::Mcp),
        Err(Failure {
            code: Code::RequestConflict
        })
    ));
    assert!(matches!(
        registry.begin("a", "/tmp", OTHER, ID, Kind::Mcp),
        Err(Failure { code: Code::Busy })
    ));
}
#[test]
fn cancellation_is_not_settled_and_active_slots_survive_observer_abandonment() {
    let registry = requests::Requests::default();
    let (first, _) = registry.begin("a", "/tmp", ID, ID, Kind::Mcp).unwrap();
    let cancellation = registry.cancel("a", ID).unwrap();
    assert!(!cancellation.operation.unwrap().settled);
    first.progress(State::PendingCleanup, Some(Code::PendingCleanup));
    assert!(matches!(
        registry.begin("a", "/tmp", OTHER, ID, Kind::Mcp),
        Err(Failure { code: Code::Busy })
    ));
    first.finish(Err(Code::Cancelled.into()));
    assert!(registry.begin("a", "/tmp", OTHER, ID, Kind::Mcp).is_ok());
}
#[test]
fn cold_missing_status_does_not_mean_cancelled_or_empty() {
    assert!(matches!(
        requests::Requests::default().get("a", ID),
        Err(Failure {
            code: Code::UnknownRequest
        })
    ));
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use crate::meta_store::AgentRow;
    use std::{os::unix::fs::PermissionsExt, path::PathBuf, process::Command};
    struct Fixture {
        _root: tempfile::TempDir,
        row: AgentRow,
        entry: PathBuf,
    }
    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().canonicalize().unwrap();
        let package = directory.join("node_modules/@agentclientprotocol/codex-acp");
        let entry = package.join("dist/index.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "// synthetic package entry").unwrap();
        std::fs::write(package.join("package.json"), r#"{"name":"@agentclientprotocol/codex-acp","version":"0-fixture","bin":{"codex-acp":"dist/index.js"}}"#).unwrap();
        let command = directory.join("node");
        std::fs::write(&command, "#!/bin/sh\nexit 7\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o700)).unwrap();
        Fixture {
            _root: root,
            entry: entry.clone(),
            row: AgentRow {
                id: "codex".into(),
                name: "fixture".into(),
                source: "registry".into(),
                command: command.to_str().unwrap().into(),
                args: vec![entry.to_str().unwrap().into()],
                env: vec![],
                version: None,
                handshake: None,
                created_at: 1,
                updated_at: 1,
            },
        }
    }
    #[test]
    fn exact_public_entry_is_required_without_version_or_binary_hash_gate() {
        let mut f = fixture();
        assert!(launch::admission(&f.row).is_ok());
        f.row.version = Some("new-version-not-pinned".into());
        assert!(launch::admission(&f.row).is_ok());
        f.row.args.push("--unreviewed".into());
        assert_eq!(
            launch::admission(&f.row).unwrap_err().code,
            Code::EntryUnverified
        );
        f.row.args.pop();
        f.row.source = "custom".into();
        assert!(launch::admission(&f.row).is_err());
        f.row.source = "registry".into();
        std::fs::remove_file(&f.entry).unwrap();
        assert!(launch::admission(&f.row).is_err());
    }
    #[test]
    fn credential_placeholder_is_unavailable_without_keychain_lookup() {
        let mut f = fixture();
        f.row
            .env
            .push(("TOKEN".into(), crate::auth::KEYCHAIN_MARKER.into()));
        assert_eq!(
            launch::admission(&f.row).unwrap_err().code,
            Code::EnvironmentUnavailable
        );
    }
    #[test]
    fn official_relay_arguments_and_selected_environment_are_preserved() {
        let mut f = fixture();
        f.row
            .env
            .push(("CODEX_HOME".into(), "/selected/home".into()));
        let cmd = launch::command(
            &f.row,
            "/tmp",
            [
                ("HOME".into(), "/original/home".into()),
                ("CODEX_PATH".into(), "/selected/codex".into()),
            ]
            .into(),
            Kind::Mcp,
        )
        .unwrap();
        assert_eq!(
            cmd.get_args()
                .map(|s| s.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec![
                f.row.args[0].clone(),
                "cli".into(),
                "mcp".into(),
                "list".into(),
                "--json".into()
            ]
        );
        assert_eq!(
            cmd.get_envs()
                .find(|(k, _)| *k == "CODEX_HOME")
                .unwrap()
                .1
                .unwrap(),
            "/selected/home"
        );
    }
    #[test]
    fn replaced_cwd_is_not_published_as_current() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().canonicalize().unwrap().join("cwd");
        std::fs::create_dir(&path).unwrap();
        let guard = launch::Directory::open(path.to_str().unwrap()).unwrap();
        std::fs::rename(&path, path.with_extension("old")).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(!guard.current());
    }
    #[test]
    fn selected_program_environment_and_replacement_row_are_not_interchangeable() {
        let f = fixture();
        let mut next = f.row.clone();
        assert!(launch::same_selection(&f.row, &next));
        next.env.push(("CODEX_HOME".into(), "changed".into()));
        assert!(!launch::same_selection(&f.row, &next));
        next = f.row.clone();
        next.updated_at += 1;
        assert!(!launch::same_selection(&f.row, &next));
    }

    #[tokio::test]
    async fn changed_row_while_waiting_for_configuration_is_not_a_new_query_selection() {
        let _serial = execution::fixture_lock();
        let f = fixture();
        let store = MetaStore::open(&f._root.path().join("fixture.sqlite")).unwrap();
        store.insert_agent(&f.row).unwrap();
        let expected = store.get_agent(&f.row.id).unwrap().unwrap();
        let guard = crate::install_job::configuration_guard(&f.row.id).await;
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin(&f.row.id, "/tmp", ID, ID, Kind::Mcp)
            .unwrap();
        let gate = crate::managed_update::UpdateAdmission::default();
        let selected = request.clone();
        let selected_store = store.clone();
        let task = tokio::spawn(execute_selected(
            selected_store,
            selected,
            gate.activity().unwrap(),
            expected,
            None,
        ));
        tokio::task::yield_now().await;
        store
            .set_agent_env(
                &f.row.id,
                &[("CODEX_HOME".into(), "/changed-environment".into())],
            )
            .unwrap();
        drop(guard);
        task.await.unwrap();
        let result = request.snapshot().unwrap();
        assert!(result.settled);
        assert_eq!(result.state, State::Failed);
        assert_eq!(result.code, Some(Code::SelectionChanged));
        // The synthetic command exits 7 if actually dispatched. This path must
        // fail at the saved-row comparison before admission/env/process setup.
        assert!(gate.update().is_ok());
    }
    #[tokio::test]
    async fn selection_changed_before_first_metadata_read_is_not_admitted_as_replacement() {
        let _serial = execution::fixture_lock();
        let f = fixture();
        let store = MetaStore::open(&f._root.path().join("selection.sqlite")).unwrap();
        store.insert_agent(&f.row).unwrap();
        let selected = store.get_agent(&f.row.id).unwrap().unwrap();
        assert!(launch::admission(&selected).is_ok());
        let receipts = launch::Selections::default();
        let selection_id = receipts.issue(selected, Instant::now()).unwrap();
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin(&f.row.id, "/tmp", ID, &selection_id, Kind::Mcp)
            .unwrap();
        store
            .set_agent_env(
                &f.row.id,
                &[("TOKEN".into(), crate::auth::KEYCHAIN_MARKER.into())],
            )
            .unwrap();
        let gate = crate::managed_update::UpdateAdmission::default();
        let exact = receipts
            .get(&f.row.id, &selection_id, Instant::now())
            .unwrap();
        execute_selected(
            store,
            request.clone(),
            gate.activity().unwrap(),
            exact,
            None,
        )
        .await;
        let result = request.snapshot().unwrap();
        assert!(result.settled);
        assert_eq!(result.state, State::Failed);
        assert_eq!(result.code, Some(Code::SelectionChanged));
        assert!(gate.update().is_ok());
    }

    #[test]
    fn capability_receipts_are_exact_agent_opaque_and_expire_without_sliding_refresh() {
        let f = fixture();
        let receipts = launch::Selections::default();
        let now = Instant::now();
        let id = receipts.issue(f.row.clone(), now).unwrap();
        assert!(requests::valid_id(&id));
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert!(launch::same_selection(
            &f.row,
            &receipts.get(&f.row.id, &id, now).unwrap()
        ));
        assert_eq!(
            receipts.get("another-agent", &id, now).unwrap_err().code,
            Code::SelectionChanged
        );
        assert!(
            receipts
                .get(&f.row.id, &id, now + Duration::from_secs(299))
                .is_ok()
        );
        assert_eq!(
            receipts
                .get(&f.row.id, &id, now + Duration::from_secs(300))
                .unwrap_err()
                .code,
            Code::SelectionChanged
        );
    }

    #[test]
    fn capability_capacity_never_evicts_another_live_selected_receipt() {
        let f = fixture();
        let receipts = launch::Selections::default();
        let now = Instant::now();
        let ids: Vec<_> = (0..64)
            .map(|_| receipts.issue(f.row.clone(), now).unwrap())
            .collect();
        assert_eq!(
            receipts.issue(f.row.clone(), now).unwrap_err().code,
            Code::Busy
        );
        assert!(receipts.get(&f.row.id, &ids[0], now).is_ok());
        assert!(
            receipts
                .issue(f.row, now + Duration::from_secs(300))
                .is_ok()
        );
    }

    #[test]
    fn reused_request_cannot_change_selection_and_expiry_does_not_cancel_inflight_work() {
        let f = fixture();
        let receipts = launch::Selections::default();
        let now = Instant::now();
        let selection = receipts.issue(f.row.clone(), now).unwrap();
        let replacement = receipts.issue(f.row.clone(), now).unwrap();
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin(&f.row.id, "/tmp", ID, &selection, Kind::Mcp)
            .unwrap();
        assert!(matches!(
            registry.begin(&f.row.id, "/tmp", ID, &replacement, Kind::Mcp),
            Err(Failure {
                code: Code::RequestConflict
            })
        ));
        assert!(
            receipts
                .get(&f.row.id, &selection, now + Duration::from_secs(301))
                .is_err()
        );
        let (same, fresh) = registry
            .begin(&f.row.id, "/tmp", ID, &selection, Kind::Mcp)
            .unwrap();
        assert!(!fresh);
        assert!(Arc::ptr_eq(&same, &request));
        assert!(request.operation.interested());
        assert_eq!(
            registry
                .get(&f.row.id, ID)
                .unwrap()
                .snapshot()
                .unwrap()
                .state,
            State::Running
        );
        assert!(
            !registry
                .cancel(&f.row.id, ID)
                .unwrap()
                .operation
                .unwrap()
                .settled
        );
    }

    #[test]
    fn owned_process_returns_full_bytes_only_after_exit_and_eof() {
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin("fixture", "/tmp", ID, ID, Kind::Mcp)
            .unwrap();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf '[]'; printf 'discard-this' >&2"]);
        assert_eq!(process::run(command, &request).unwrap(), b"[]");
        assert!(!request.snapshot().unwrap().settled); // Worker still owns final publication.
    }
    #[test]
    fn nonzero_stderr_never_becomes_a_public_error_message() {
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin("fixture", "/tmp", ID, ID, Kind::Mcp)
            .unwrap();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf 'PRIVATE_TOKEN' >&2; exit 23"]);
        let error = process::run(command, &request).unwrap_err();
        assert_eq!(error.code, Code::QueryFailed);
        assert!(!serde_json::to_string(&error).unwrap().contains("PRIVATE"));
    }
    #[test]
    fn cancel_waits_for_exact_owned_group_and_inherited_pipe_completion() {
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin("fixture", "/tmp", ID, ID, Kind::Mcp)
            .unwrap();
        let observed = request.clone();
        let worker = std::thread::spawn(move || {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "sleep 30 & wait"]);
            process::run(command, &observed)
        });
        std::thread::sleep(Duration::from_millis(80));
        request.operation.abandon();
        assert_eq!(worker.join().unwrap().unwrap_err().code, Code::Cancelled);
    }

    #[test]
    fn real_cleanup_retains_activity_after_observer_and_cancel_return() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("started");
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin("fixture", "/tmp", ID, ID, Kind::Mcp)
            .unwrap();
        let gate = crate::managed_update::UpdateAdmission::default();
        let activity = gate.activity().unwrap();
        let observed = request.clone();
        let child_marker = marker.clone();
        let worker = std::thread::spawn(move || {
            let _activity = activity;
            let mut command = Command::new("/bin/sh");
            command
                .args([
                    "-c",
                    "trap '' TERM; printf ready > \"$1\"; sleep 30",
                    "fixture",
                ])
                .arg(child_marker);
            let result = process::run(command, &observed);
            observed.finish(result.and_then(|bytes| output::parse(&bytes).map(Into::into)));
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while !marker.is_file() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(marker.is_file());
        let cancellation = registry.cancel("fixture", ID).unwrap();
        assert!(!cancellation.operation.unwrap().settled);
        assert!(gate.update().is_err());
        assert!(matches!(
            registry.begin("fixture", "/tmp", OTHER, ID, Kind::Mcp),
            Err(Failure { code: Code::Busy })
        ));
        worker.join().unwrap();
        assert!(gate.update().is_ok());
        assert!(request.snapshot().unwrap().settled);
    }

    #[tokio::test]
    async fn dropped_ipc_observer_only_requests_cancel_and_does_not_finish_owner() {
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin("fixture", "/tmp", ID, ID, Kind::Mcp)
            .unwrap();
        let waiter = tokio::spawn(wait_for_result(request.clone()));
        tokio::task::yield_now().await;
        waiter.abort();
        let _ = waiter.await;
        assert!(!request.operation.interested());
        assert!(!request.snapshot().unwrap().settled);
        assert!(matches!(
            registry.begin("fixture", "/tmp", OTHER, ID, Kind::Mcp),
            Err(Failure { code: Code::Busy })
        ));
    }

    #[test]
    fn exited_leader_does_not_drop_inherited_pipe_or_process_group() {
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin("fixture", "/tmp", ID, ID, Kind::Mcp)
            .unwrap();
        let now = Instant::now();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "(sleep 0.15; printf '[]') & exit 0"]);
        assert_eq!(process::run(command, &request).unwrap(), b"[]");
        assert!(now.elapsed() >= Duration::from_millis(100));
    }

    #[test]
    fn real_pipe_limits_fail_even_when_command_would_exit_successfully() {
        for (redirect, expected) in [
            (false, output::STDOUT_LIMIT + 1),
            (true, output::STDERR_LIMIT + 1),
        ] {
            let registry = requests::Requests::default();
            let (request, _) = registry
                .begin("fixture", "/tmp", ID, ID, Kind::Mcp)
                .unwrap();
            let mut command = Command::new("/bin/sh");
            command
                .args([
                    "-c",
                    if redirect {
                        "head -c \"$1\" /dev/zero >&2"
                    } else {
                        "head -c \"$1\" /dev/zero"
                    },
                    "fixture",
                ])
                .arg(expected.to_string());
            assert_eq!(
                process::run(command, &request).unwrap_err().code,
                Code::OutputLimit
            );
        }
    }

    #[test]
    fn actual_query_deadline_requests_cleanup_without_an_empty_success() {
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin("fixture", "/tmp", ID, ID, Kind::Mcp)
            .unwrap();
        let started = Instant::now();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30"]);
        assert_eq!(
            process::run(command, &request).unwrap_err().code,
            Code::TimedOut
        );
        assert!(started.elapsed() >= Duration::from_secs(10));
        assert!(!request.snapshot().unwrap().settled);
        assert!(request.snapshot().unwrap().snapshot.is_none());
    }

    #[tokio::test]
    async fn dropped_observer_retains_real_worker_and_activity_until_group_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("started");
        let registry = requests::Requests::default();
        let (request, _) = registry
            .begin("fixture", "/tmp", ID, ID, Kind::Mcp)
            .unwrap();
        let gate = crate::managed_update::UpdateAdmission::default();
        let activity = gate.activity().unwrap();
        let observed = request.clone();
        let child_marker = marker.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let _activity = activity;
            let mut command = Command::new("/bin/sh");
            command
                .args([
                    "-c",
                    "trap '' TERM; printf ready > \"$1\"; sleep 30",
                    "fixture",
                ])
                .arg(child_marker);
            let result = process::run(command, &observed);
            observed.finish(result.and_then(|bytes| output::parse(&bytes).map(Into::into)));
        });
        let waiter = tokio::spawn(wait_for_result(request.clone()));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !marker.is_file() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(marker.is_file());
        waiter.abort();
        let _ = waiter.await;
        assert!(!request.operation.interested());
        assert!(!request.snapshot().unwrap().settled);
        assert!(gate.update().is_err());
        assert!(matches!(
            registry.begin("fixture", "/tmp", OTHER, ID, Kind::Mcp),
            Err(Failure { code: Code::Busy })
        ));
        worker.await.unwrap();
        assert!(gate.update().is_ok());
        let result = request.snapshot().unwrap();
        assert!(result.settled);
        assert_eq!(result.state, State::Cancelled);
    }

    #[test]
    fn actual_owned_output_emits_only_sanitized_serialized_wire() {
        let registry = requests::Requests::default();
        let early = registry.cancel("early", OTHER).unwrap();
        let (request, _) = registry
            .begin("fixture", "/tmp", ID, ID, Kind::Mcp)
            .unwrap();
        let running = request.snapshot().unwrap();
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "printf '%s' \"$1\"", "fixture"])
            .arg(serde_json::to_string(&vec![row()]).unwrap());
        let mut bytes = process::run(command, &request).unwrap();
        let snapshot = output::parse(&bytes).unwrap();
        bytes.fill(0);
        request.finish(Ok(snapshot.into()));
        let ready = request.snapshot().unwrap();
        assert!(ready.settled);
        assert_eq!(ready.state, State::Ready);
        let mut unsupported = fixture().row;
        unsupported.id = "not-reviewed-fixture".into();
        let capabilities = launch::capabilities(&unsupported).unwrap();
        let wire = serde_json::to_value(
            json!({"capabilities":capabilities,"running":running,"ready":ready,"earlyCancellation":early}),
        )
        .unwrap();
        assert!(!wire.to_string().contains("PRIVATE"));
        assert!(wire["capabilities"]["selectionId"].is_null());
        assert_eq!(
            wire["capabilities"]["mcpInventory"]["reason"],
            "notReviewed"
        );
        assert!(wire["running"].get("code").is_none());
        assert!(wire["running"].get("snapshot").is_none());
        assert!(wire["ready"].get("code").is_none());
        assert!(wire["earlyCancellation"]["operation"].is_null());
        println!(
            "EXTENSION_INVENTORY_WIRE:{}",
            serde_json::to_string(&wire).unwrap()
        );
    }
}
