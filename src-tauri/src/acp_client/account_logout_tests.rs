//! Real JSON-RPC transport with a temporary peer, never a real account.
use super::*;
use crate::acp_client::{
    account_logout::LogoutRoute,
    account_status::AccountKind,
    manager::{AuthenticationOperation, ManagerCommand},
    operations::QueuedCommand,
};
use std::sync::atomic::{AtomicBool, Ordering};

const VIBE_PEER: &str = r#"#!/usr/bin/python3 -u
import sys,json,time,os
root=os.path.dirname(os.path.realpath(__file__))
def path(name): return os.path.join(root,name)
def reply(m,r): print(json.dumps(dict(jsonrpc='2.0',id=m['id'],result=r)),flush=True)
def gate(name):
 if os.path.exists(path(name)):
  open(path(name+'_started'),'w').write('started')
  while not os.path.exists(path(name+'_release')): time.sleep(.005)
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 with open(path('methods'),'a') as trace: trace.write(str(method)+'\n')
 if method=='initialize': reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
 elif method=='_auth/status':
  gate('status_wait')
  with open(path('state.json')) as state: reply(m,json.load(state))
 elif method=='_auth/signOut':
  gate('logout_wait')
  if os.path.exists(path('logout_error')):
   print(json.dumps(dict(jsonrpc='2.0',id=m['id'],error={'code':-32603,'message':'fixture-secret'})),flush=True)
  else:
   if not os.path.exists(path('keep_credential')):
    with open(path('state.json'),'w') as state: json.dump({'authenticated':False,'authState':'signed_out','signOutAvailable':False},state)
   reply(m,{})
 elif method=='$/cancel_request': pass
 else: print(json.dumps(dict(jsonrpc='2.0',id=m.get('id'),error={'code':-32601,'message':'fixture-unknown'})),flush=True)
"#;

fn fixture() -> Fixture {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    let script = f.cwd.join("vibe-acp");
    std::fs::write(&script, VIBE_PEER).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    f.row.id = "registry:mistral-vibe".into();
    f.row.source = "registry".into();
    f.row.command = script.to_string_lossy().into_owned();
    f.row.args.clear();
    f.store.insert_agent(&f.row).unwrap();
    state(
        &f,
        json!({"authenticated":true,"authState":"os_keyring","signOutAvailable":true}),
    );
    f
}

fn state(f: &Fixture, value: Value) {
    std::fs::write(f.cwd.join("state.json"), value.to_string()).unwrap();
}

fn methods(f: &Fixture) -> Vec<String> {
    std::fs::read_to_string(f.cwd.join("methods"))
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

async fn ready(f: &Fixture) {
    f.connect().await;
    until(|| f.manager.can_logout(&f.row.id, &f.cwd)).await;
}

async fn logout(f: &Fixture, operation: AuthenticationOperation) -> Result<(), String> {
    let _scope = f.manager.reserve_account_change(&f.row.id)?;
    f.manager
        .logout(&f.row.id, &f.cwd, operation, Arc::new(|| {}))
        .await
}

#[tokio::test(flavor = "multi_thread")]
async fn official_logout_uses_fresh_status_and_confirms_local_credential_removal() {
    for source in ["os_keyring", "vibe_home_env_file"] {
        let f = fixture();
        state(
            &f,
            json!({"authenticated":true,"authState":source,"signOutAvailable":true}),
        );
        ready(&f).await;
        logout(&f, AuthenticationOperation::new()).await.unwrap();
        assert!(!f.manager.can_logout(&f.row.id, &f.cwd));
        assert_eq!(
            f.manager.status(&f.row.id).unwrap()[0]
                .account
                .as_ref()
                .unwrap()
                .kind,
            AccountKind::MissingCredential
        );
        assert_eq!(
            methods(&f),
            [
                "initialize",
                "_auth/status",
                "_auth/status",
                "_auth/signOut",
                "_auth/status"
            ]
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stale_permission_cannot_logout_an_external_or_unconfirmed_credential() {
    for value in [
        json!({"authenticated":true,"authState":"process_env","signOutAvailable":true}),
        json!({"authenticated":true,"authState":"unsupported_provider","signOutAvailable":true}),
        json!({"authenticated":true,"authState":"auth_not_required","signOutAvailable":true}),
        json!({"authenticated":false,"authState":"signed_out","signOutAvailable":false}),
        json!({"authenticated":true,"authState":"os_keyring","signOutAvailable":false}),
        json!({"authenticated":true,"authState":"os_keyring","signOutAvailable":"true"}),
        json!({"authenticated":"true","authState":"os_keyring","signOutAvailable":true}),
    ] {
        let f = fixture();
        ready(&f).await;
        state(&f, value);
        assert!(logout(&f, AuthenticationOperation::new()).await.is_err());
        assert!(!f.manager.can_logout(&f.row.id, &f.cwd));
        assert_eq!(methods(&f), ["initialize", "_auth/status", "_auth/status"]);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelled_fresh_check_never_starts_a_late_logout() {
    let f = fixture();
    ready(&f).await;
    std::fs::write(f.cwd.join("status_wait"), "wait").unwrap();
    let operation = AuthenticationOperation::new();
    let mut request = Box::pin(logout(&f, operation.clone()));
    tokio::select! {
        result = &mut request => panic!("completed before controlled check: {result:?}"),
        _ = until(|| f.cwd.join("status_wait_started").exists()) => {}
    }
    operation.abandon();
    std::fs::write(f.cwd.join("status_wait_release"), "release").unwrap();
    assert_eq!(request.await.unwrap_err(), "AUTH_CANCELLED");
    assert!(!methods(&f).iter().any(|m| m == "_auth/signOut"));
    assert!(f.manager.reserve_account_change(&f.row.id).is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn empty_ack_or_remote_error_does_not_invent_a_signed_out_state() {
    for marker in ["keep_credential", "logout_error"] {
        let f = fixture();
        ready(&f).await;
        std::fs::write(f.cwd.join(marker), "controlled").unwrap();
        let error = logout(&f, AuthenticationOperation::new())
            .await
            .unwrap_err();
        assert!(!error.contains("fixture-secret"));
        assert_eq!(
            methods(&f).iter().filter(|m| *m == "_auth/signOut").count(),
            1
        );
        assert!(
            f.manager.status(&f.row.id).unwrap()[0]
                .account
                .as_ref()
                .is_none_or(|a| a.kind != AccountKind::MissingCredential)
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn late_logout_keeps_shared_scope_until_real_reply_and_never_retries() {
    let f = fixture();
    ready(&f).await;
    std::fs::write(f.cwd.join("logout_wait"), "wait").unwrap();
    let connection = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    let scope = f.manager.reserve_account_change(&f.row.id).unwrap();
    let (result, mut receive) = tokio::sync::oneshot::channel();
    let unknown = Arc::new(AtomicBool::new(false));
    let signal = unknown.clone();
    let operation = AuthenticationOperation::new();
    connection
        .command_tx
        .send(QueuedCommand {
            command: ManagerCommand::Logout {
                route: LogoutRoute::for_connection(&connection).unwrap(),
                account: connection.account.clone(),
                operation: operation.clone(),
                on_unknown: Arc::new(move || {
                    signal.store(true, Ordering::SeqCst);
                }),
                result,
            },
            deadline: tokio::time::Instant::now() + Duration::from_millis(100),
            _lease: connection.life.operation("authentication".into()).unwrap(),
        })
        .unwrap();
    until(|| f.cwd.join("logout_wait_started").exists() && unknown.load(Ordering::SeqCst)).await;
    assert!(receive.try_recv().is_err());
    assert!(connection.life.work().is_err());
    let mut alias = f.row.clone();
    alias.id = "custom:vibe-alias".into();
    alias.source = "custom".into();
    f.store.insert_agent(&alias).unwrap();
    assert!(f.manager.connect(&alias, &f.cwd, &f.store).await.is_err());
    assert!(f.manager.reserve_account_change(&f.row.id).is_err());
    operation.abandon();
    assert!(receive.try_recv().is_err());
    std::fs::write(f.cwd.join("logout_wait_release"), "release").unwrap();
    receive.await.unwrap().unwrap();
    drop(scope);
    assert!(connection.life.work().is_ok());
    assert_eq!(
        methods(&f).iter().filter(|m| *m == "_auth/signOut").count(),
        1
    );
    assert_eq!(
        connection.account.lock().unwrap().as_ref().unwrap().kind,
        AccountKind::MissingCredential
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_custom_program_name_does_not_authorize_an_official_supplement() {
    let mut f = fixture();
    f.row.id = "custom:unreviewed-vibe".into();
    f.row.source = "custom".into();
    f.store.insert_agent(&f.row).unwrap();
    f.connect().await;
    assert!(!f.manager.can_logout(&f.row.id, &f.cwd));
    assert!(logout(&f, AuthenticationOperation::new()).await.is_err());
    assert_eq!(methods(&f), ["initialize"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn standard_declaration_keeps_the_standard_logout_route() {
    let mut f = fixture();
    f.row.id = "custom:standard-logout".into();
    f.row.source = "custom".into();
    f.store.insert_agent(&f.row).unwrap();
    let peer = VIBE_PEER
        .replace(
            "'agentCapabilities':{}",
            "'agentCapabilities':{'auth':{'logout':{}}}",
        )
        .replace(
            " elif method=='_auth/status':",
            " elif method=='logout': reply(m,{})\n elif method=='_auth/status':",
        );
    std::fs::write(&f.row.command, peer).unwrap();
    f.connect().await;
    assert!(f.manager.can_logout(&f.row.id, &f.cwd));
    logout(&f, AuthenticationOperation::new()).await.unwrap();
    assert_eq!(methods(&f), ["initialize", "logout"]);
}
