use super::*;

fn ready(state: &BrowserWorkspace, task: &str) -> (u64, BrowserInfo) {
    let (id, _, info) = state.reserve(task, Url::parse("https://www.rust-lang.org/").unwrap()).unwrap();
    state.event(id, 1, "https://www.rust-lang.org/").unwrap();
    (id, info)
}
fn result() -> &'static str { r#"{"blocked":false,"url":"https://www.rust-lang.org/","title":"Public fixture","text":"visible fixture"}"# }

#[test]
fn another_task_cannot_read_or_close_owned_page() {
    let state=BrowserWorkspace::default();let (_,info)=ready(&state,"a");
    assert!(state.read_ticket("b",&info.label).is_err());
    assert!(state.close("b",&info.label).unwrap().is_none());
    assert!(state.read_ticket("a",&info.label).is_ok());
}
#[test]
fn close_revokes_queued_reads_and_repeated_close_is_noop() {
    let state=BrowserWorkspace::default();let (_,info)=ready(&state,"a");
    let ticket=state.read_ticket("a",&info.label).unwrap();
    assert!(state.close("a",&info.label).unwrap().is_some());
    assert!(state.complete_read(&ticket,result()).is_err());
    assert!(state.close("a",&info.label).unwrap().is_none());
}
#[test]
fn old_close_and_old_response_cannot_affect_same_task_reopened() {
    let state=BrowserWorkspace::default();let (_,old)=ready(&state,"a");
    let ticket=state.read_ticket("a",&old.label).unwrap();
    let (_,new)=ready(&state,"a");
    assert_ne!(old.label,new.label);
    assert!(state.close("a",&old.label).unwrap().is_none());
    assert!(state.complete_read(&ticket,result()).is_err());
    assert!(state.read_ticket("a",&new.label).is_ok());
}
#[test]
fn navigation_revokes_read_and_does_not_admit_another_origin() {
    let state=BrowserWorkspace::default();let (id,info)=ready(&state,"a");
    let ticket=state.read_ticket("a",&info.label).unwrap();
    assert!(!state.policy(id,"https://www.mozilla.org/"));
    assert!(state.policy(id,"https://www.rust-lang.org/learn"));
    assert!(state.complete_read(&ticket,result()).is_err());
    assert!(state.read_ticket("a",&info.label).is_err());
}
#[test]
fn explicit_navigate_can_authorize_new_public_origin() {
    let state=BrowserWorkspace::default();let (id,_)=ready(&state,"a");
    state.navigate(id,Url::parse("https://www.mozilla.org/").unwrap()).unwrap();
    assert!(state.policy(id,"https://www.mozilla.org/"));
    assert!(!state.policy(id,"https://www.rust-lang.org/"));
}
#[test]
fn blocked_or_failed_page_never_releases_snapshot() {
    for event in [2,3] {
        let state=BrowserWorkspace::default();let (id,info)=ready(&state,"a");
        let ticket=state.read_ticket("a",&info.label).unwrap();state.event(id,event,"").unwrap();
        assert!(state.complete_read(&ticket,result()).is_err());
    }
}
#[test]
fn native_password_marker_has_no_content_output() {
    let state=BrowserWorkspace::default();let (_,info)=ready(&state,"a");
    let ticket=state.read_ticket("a",&info.label).unwrap();
    assert!(state.complete_read(&ticket,r#"{"blocked":true}"#).is_err());
    let accepted=state.complete_read(&ticket,result()).unwrap();
    assert_eq!(accepted.text,"visible fixture");
}
#[test]
fn late_event_from_replaced_page_does_not_change_new_page() {
    let state=BrowserWorkspace::default();let (old,_)=ready(&state,"a");
    let (new,info)=ready(&state,"b");
    assert!(state.event(old,3,"").is_none());
    assert_eq!(state.info(new).unwrap().task_key,info.task_key);
    assert_eq!(state.info(new).unwrap().phase,"ready");
}
