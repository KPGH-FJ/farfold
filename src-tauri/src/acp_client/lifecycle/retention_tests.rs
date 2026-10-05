use super::*;

fn ready() -> Arc<ConnectionLife> {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    life
}

#[test]
fn page_owners_are_idempotent_and_release_restarts_the_idle_period() {
    let life = ready();
    let before_hold = life.activity.lock().unwrap().last;
    assert!(life.hold_view("main", "setup", true).unwrap());
    assert!(life.hold_view("main", "setup", true).unwrap());
    assert!(life.hold_view("main", "conversation", true).unwrap());
    assert_eq!(life.activity.lock().unwrap().last, before_hold);
    assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
    life.hold_view("main", "setup", false).unwrap();
    assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
    life.hold_view("main", "conversation", false).unwrap();
    assert!(!life.close(false, Some(Duration::from_secs(1800))).unwrap());
    assert!(life.close(false, Some(Duration::ZERO)).unwrap());
    assert_eq!(life.close_reason(), Some(CloseReason::Idle));
}

#[test]
fn closing_rejects_late_holds_and_preserves_the_first_reason() {
    let life = ready();
    life.hold_view("main", "setup", true).unwrap();
    assert!(life.close(false, None).unwrap());
    assert!(!life.hold_view("main", "late", true).unwrap());
    assert!(life.hold_view("main", "setup", false).unwrap());
    assert!(life.activity.lock().unwrap().views.is_empty());
    assert!(!life.close_for(true, None, CloseReason::Unexpected).unwrap());
    assert_eq!(life.close_reason(), Some(CloseReason::User));
}

#[test]
fn destroyed_window_releases_only_its_owners_and_restarts_idle_period() {
    let life = ready();
    life.hold_view("main", "same-owner", true).unwrap();
    life.hold_view("other", "same-owner", true).unwrap();
    life.release_views("main").unwrap();
    assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
    life.release_views("other").unwrap();
    assert!(!life.close(false, Some(Duration::from_secs(1800))).unwrap());
    assert!(life.close(false, Some(Duration::ZERO)).unwrap());
}

#[test]
fn every_open_conversation_retains_until_its_route_is_released() {
    let life = ready();
    let first = life.session().unwrap().registered();
    let second = life.session().unwrap().registered();
    assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
    drop(first);
    assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
    drop(second);
    assert!(!life.close(false, Some(Duration::from_secs(1800))).unwrap());
    assert!(life.close(false, Some(Duration::ZERO)).unwrap());
}

#[test]
fn an_open_which_failed_after_creation_keeps_unconfirmed_state_alive() {
    let life = ready();
    drop(life.session().unwrap());
    assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(life.close(false, None).unwrap());
}

#[test]
fn an_undelivered_route_keeps_remote_state_after_local_unregistration() {
    let life = ready();
    life.session()
        .unwrap()
        .registered()
        .retain_until_terminated();
    assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(life.close(false, None).unwrap());
}

#[test]
fn session_admission_and_recycling_are_one_atomic_decision() {
    for _ in 0..32 {
        let life = ready();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let admitted = {
            let (life, barrier) = (life.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                life.session().map(SessionRetention::registered)
            })
        };
        barrier.wait();
        let closed = life.close(false, Some(Duration::ZERO)).unwrap();
        let session = admitted.join().unwrap();
        assert_eq!(closed, session.is_err());
        drop(session);
    }
}

#[test]
fn work_authentication_and_unknown_work_still_block_recycling() {
    let life = ready();
    let work = life.work().unwrap();
    assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
    drop(work);
    let operation = life.operation("authentication".into()).unwrap();
    assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
    drop(operation);
    life.work().unwrap().retain_until_terminated();
    assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(life.close_for(true, None, CloseReason::Shutdown).unwrap());
    assert_eq!(life.close_reason(), Some(CloseReason::Shutdown));
}
