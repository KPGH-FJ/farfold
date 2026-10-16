//! Account admission with actual owned stdio children, without real Agents.
use super::*;
use crate::acp_client::{
    manager::{AuthenticationOperation, ManagerCommand},
    model_guard::ConfigStore,
    operations::QueuedCommand,
    service_connection::{PreparedService, ServiceContext, ServiceRecord},
};
use std::sync::atomic::{AtomicBool, Ordering};

fn alias(f: &Fixture, id: &str) -> AgentRow {
    let mut row = f.row.clone();
    row.id = id.into();
    f.store.insert_agent(&row).unwrap();
    row
}

#[tokio::test(flavor = "multi_thread")]
async fn aliases_share_account_admission_and_busy_api_work_blocks_changes() {
    let f = Fixture::new();
    f.connect().await;
    let other = alias(&f, "second-name");
    let context = ServiceContext {
        identity: crate::credentials::ServiceIdentity {
            id: "api-source".into(),
            fingerprint: "fixture".into(),
            model: "fixture".into(),
        },
        revision: "api-source".into(),
        model_id: "fixture".into(),
    };
    f.manager
        .connect_launch(
            &other,
            &f.cwd,
            &f.store,
            false,
            Some(PreparedService {
                delivery: None,
                environment: crate::shell_env::command_env(),
                context,
            }),
        )
        .await
        .unwrap();
    let api = f
        .manager
        .lock()
        .unwrap()
        .iter()
        .find(|(key, _)| key.agent_id == other.id)
        .unwrap()
        .1
        .clone();
    let events = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let captured = events.clone();
    let (result, receive) = tokio::sync::oneshot::channel();
    api.send(ManagerCommand::OpenSession {
        fork_owned: false,
        native_session_id: None,
        preview_token: None,
        recorded_config: None,
        config_store: Box::new(ConfigStore {
            store: f.store.clone(),
            agent_id: other.id.clone(),
            cwd: f.cwd.to_string_lossy().into(),
            service_record: Some(ServiceRecord::Existing),
            expected_model: None,
            verified_permission_option: false,
        }),
        config_options: vec![],
        mcp: None,
        browser_unavailable: None,
        events: Arc::new(move |event| captured.lock().unwrap().push(event)),
        result,
    })
    .unwrap();
    let opened = receive.await.unwrap().unwrap().accept().unwrap();
    f.manager
        .session_prompt(
            &other.id,
            &f.cwd,
            &opened.session_id,
            serde_json::from_value(json!([{"type":"text","text":"ask"}])).unwrap(),
        )
        .await
        .unwrap();
    until(|| {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "elicitation")
    })
    .await;
    assert!(f.manager.reserve_account_change(&f.row.id).is_err());
    assert!(
        f.manager
            .reserve_preparation_action(&f.row, &f.row.command, &f.row.args)
            .is_err()
    );
    // Failed collection must release every idle member it visited beforehand.
    assert!(
        f.manager
            .live_connection(&f.row.id, &f.cwd)
            .unwrap()
            .life
            .work()
            .is_ok()
    );
    f.manager
        .session_cancel(&other.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
    until(|| {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "turnEnd")
    })
    .await;
    let scope = f.manager.reserve_account_change(&f.row.id).unwrap();
    assert!(api.life.work().is_err());
    assert!(f.manager.reserve_account_change(&other.id).is_err());
    assert!(
        f.manager
            .open_session(&other, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
            .await
            .is_err()
    );
    assert!(
        f.manager
            .probe_launch(&other, &f.store, std::future::pending())
            .await
            .is_err()
    );
    let added_during_change = alias(&f, "third-name");
    assert!(
        f.manager
            .connect(&added_during_change, &f.cwd, &f.store)
            .await
            .is_err()
    );
    assert!(
        f.manager
            .status(&added_during_change.id)
            .unwrap()
            .is_empty()
    );
    drop(scope);
    f.manager
        .connect(&added_during_change, &f.cwd, &f.store)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn different_python_scripts_remain_independent_during_account_change() {
    let f = Fixture::new();
    f.connect().await;
    let mut other = f.row.clone();
    other.id = "unrelated-script".into();
    let script = f.cwd.join("other.py");
    std::fs::write(&script, PEER).unwrap();
    other.args[1] = script.to_string_lossy().into();
    f.store.insert_agent(&other).unwrap();
    let scope = f.manager.reserve_account_change(&f.row.id).unwrap();
    f.manager.connect(&other, &f.cwd, &f.store).await.unwrap();
    let other_scope = f.manager.reserve_account_change(&other.id).unwrap();
    drop(other_scope);
    let opened = f
        .manager
        .open_session(&other, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await
        .unwrap();
    assert_eq!(opened.session_id, "fixture");
    drop(scope);
}

#[tokio::test(flavor = "multi_thread")]
async fn authentication_unknown_result_keeps_alias_launches_reserved_until_reply() {
    let f = Fixture::new();
    let peer = PEER.replace(" elif method=='session/list':", " elif method=='authenticate':\n  open(sys.argv[1]+'_auth','w').write('started')\n  while not os.path.exists(sys.argv[1]+'_release'): time.sleep(.005)\n  reply(m,{})\n elif method=='session/list':");
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
    f.connect().await;
    let other = alias(&f, "other-auth-name");
    f.manager.connect(&other, &f.cwd, &f.store).await.unwrap();
    let selected = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    let scope = f.manager.reserve_account_change(&f.row.id).unwrap();
    let unknown = Arc::new(AtomicBool::new(false));
    let notify = unknown.clone();
    let (result, receive) = tokio::sync::oneshot::channel();
    selected
        .command_tx
        .send(QueuedCommand {
            command: ManagerCommand::Authenticate {
                method_id: "fixture".into(),
                key: None,
                operation: AuthenticationOperation::new(),
                on_unknown: Arc::new(move || {
                    notify.store(true, Ordering::SeqCst);
                }),
                result,
            },
            deadline: tokio::time::Instant::now() + Duration::from_millis(100),
            _lease: selected.life.operation("authentication".into()).unwrap(),
        })
        .unwrap();
    let completion = tokio::spawn(async move {
        let _scope = scope;
        receive.await.unwrap()
    });
    until(|| unknown.load(Ordering::SeqCst)).await;
    assert!(f.cwd.join("listed_auth").exists());
    assert!(!completion.is_finished());
    assert!(f.manager.reserve_account_change(&other.id).is_err());
    assert!(
        f.manager
            .open_session(&other, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
            .await
            .is_err()
    );
    std::fs::write(f.cwd.join("listed_release"), "release").unwrap();
    completion.await.unwrap().unwrap();
    assert!(f.manager.reserve_account_change(&other.id).is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_login_entry_also_protects_a_registered_companion() {
    let f = Fixture::new();
    f.connect().await;
    let mut companion = f.row.clone();
    companion.id = "login-companion".into();
    let script = f.cwd.join("companion.py");
    std::fs::write(&script, PEER).unwrap();
    companion.args[1] = script.to_string_lossy().into();
    f.store.insert_agent(&companion).unwrap();
    f.manager
        .connect(&companion, &f.cwd, &f.store)
        .await
        .unwrap();
    let connection = f.manager.live_connection(&companion.id, &f.cwd).unwrap();
    let work = connection.life.work().unwrap();
    assert!(
        f.manager
            .reserve_authentication_terminal(&f.row.id, &companion.command, &companion.args)
            .is_err()
    );
    drop(work);
    let scope = f
        .manager
        .reserve_authentication_terminal(&f.row.id, &companion.command, &companion.args)
        .unwrap();
    assert!(connection.life.work().is_err());
    assert!(f.manager.reserve_account_change(&companion.id).is_err());
    drop(scope);
    assert!(connection.life.work().is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn alias_candidate_in_flight_prevents_account_change() {
    let f = Fixture::new();
    f.connect().await;
    let mut candidate = alias(&f, "candidate-alias");
    candidate.args.push("--hang-init".into());
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let manager = f.manager.clone();
    let store = f.store.clone();
    let checking = tokio::spawn(async move {
        manager
            .probe_launch(&candidate, &store, async {
                let _ = cancelled.await;
            })
            .await
    });
    until(|| f.cwd.join("listed_probe").exists()).await;
    assert!(f.manager.reserve_account_change(&f.row.id).is_err());
    cancel.send(()).unwrap();
    assert!(checking.await.unwrap().is_err());
    assert!(f.manager.reserve_account_change(&f.row.id).is_ok());
}
