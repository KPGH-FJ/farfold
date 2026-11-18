//! Controlled startup before and after a normal draft's local commitment.
use super::*;
use crate::acp_client::{draft_wait::DraftWaits, history_admission::Admission};
use std::{
    future::{Future, poll_fn},
    sync::Mutex,
    task::Poll,
};

#[tokio::test(flavor = "multi_thread")]
async fn superseded_draft_never_spawns_behind_an_existing_history_read() {
    let mut f = Fixture::new();
    f.row.id = "draft-wait-manager-fixture".into();
    f.store.insert_agent(&f.row).unwrap();
    let old_dir = f.cwd.join("old");
    let new_dir = f.cwd.join("new");
    std::fs::create_dir(&old_dir).unwrap();
    std::fs::create_dir(&new_dir).unwrap();
    let peer = PEER.replace(
        "prompt=None\nexpire=False",
        "with open('starts', 'a') as marker: marker.write('start\\n')\n\
         prompt=None\nexpire=False",
    );
    let peer = peer.replace(
        "  if '--hang-init' in sys.argv:",
        "  if os.path.basename(os.getcwd())=='old':\n\
         \x20  while not os.path.exists('release'): time.sleep(.005)\n\
         \x20 if '--hang-init' in sys.argv:",
    );
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();

    let gate = &f.manager.history_admission;
    let waits = &f.manager.draft_waits;
    let owner = |token| gate.fixture_owner("draft-window", token, &f.row.id);
    let history_owner = Arc::new(Mutex::new(Vec::new()));
    let history = {
        let manager = f.manager.clone();
        let row = f.row.clone();
        let cwd = old_dir.clone();
        let store = f.store.clone();
        let history_events = history_owner.clone();
        tokio::spawn(async move {
            manager
                .open_session_selected_with_mcp(
                    &row,
                    &cwd,
                    Some("original".into()),
                    vec![],
                    Arc::new(move |event| history_events.lock().unwrap().push(event)),
                    &store,
                    None,
                    None,
                    None,
                )
                .await
        })
    };
    until(|| old_dir.join("starts").is_file()).await;

    let stale_wait = waits.register("old-draft", owner("old-draft")).unwrap();
    let new_wait = waits.register("new-draft", owner("new-draft")).unwrap();
    let open = |cwd, wait| {
        f.manager.open_session_admitted_with_mcp(
            &f.row,
            cwd,
            None,
            vec![],
            Arc::new(|_| {}),
            &f.store,
            None,
            None,
            None,
            None,
            None,
            Some(wait),
        )
    };
    let mut stale = Box::pin(open(&old_dir, &stale_wait));
    let mut replacement = Box::pin(open(&new_dir, &new_wait));
    assert!(poll_fn(|cx| Poll::Ready(stale.as_mut().poll(cx).is_pending())).await);
    assert!(poll_fn(|cx| Poll::Ready(replacement.as_mut().poll(cx).is_pending())).await);
    assert!(!waits.withdraw("original", &owner("original")).unwrap());
    assert!(waits.withdraw("old-draft", &owner("old-draft")).unwrap());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), stale)
            .await
            .expect("stale draft stopped waiting before the old connection released")
            .err()
            .as_deref(),
        Some("草稿设置已变化，本次未开始")
    );
    assert!(!history.is_finished());
    assert!(!new_dir.join("starts").exists());
    std::fs::write(old_dir.join("release"), b"ok").unwrap();

    let new = tokio::time::timeout(Duration::from_secs(3), replacement)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(new.session_id, "fixture");
    assert!(!waits.withdraw("new-draft", &owner("new-draft")).unwrap());
    assert_eq!(history.await.unwrap().unwrap().session_id, "original");
    assert!(history_owner.lock().unwrap().iter().any(|event| {
        event
            .pointer("/update/content/text")
            .and_then(Value::as_str)
            == Some("old-load")
    }));
    assert_eq!(std::fs::read(old_dir.join("starts")).unwrap(), b"start\n");
    assert_eq!(std::fs::read(new_dir.join("starts")).unwrap(), b"start\n");
}

#[tokio::test]
async fn exact_wait_withdrawal_is_retained_before_the_wait_and_cannot_cross_windows() {
    let gate = Admission::production();
    let owner = gate.fixture_owner("first", "waiting-token", "draft-wait-test");
    let different_window = gate.fixture_owner("second", "waiting-token", "draft-wait-test");
    let wrong_token = gate.fixture_owner("first", "other-token", "draft-wait-test");
    let waits = DraftWaits::default();
    let wait = waits.register("waiting-token", owner.clone()).unwrap();
    assert!(waits.register("waiting-token", owner.clone()).is_err());
    assert!(!waits.withdraw("waiting-token", &different_window).unwrap());
    assert!(!waits.withdraw("waiting-token", &wrong_token).unwrap());
    assert!(waits.withdraw("waiting-token", &owner).unwrap());
    assert!(!waits.withdraw("waiting-token", &owner).unwrap());
    assert_eq!(
        wait.admit("draft-wait-test", |owner| gate.current_owner(owner))
            .await
            .unwrap_err(),
        "草稿设置已变化，本次未开始"
    );
    drop(wait);
    assert!(waits.register("waiting-token", owner).is_ok());
}
