use super::*;
use crate::meta_store::SessionRow;

fn owner() -> PageOwner {
    PageOwner {
        session_id: "task-a".into(),
        created_at: 10,
    }
}
fn metadata() -> MetaStore {
    let store = MetaStore::open(std::path::Path::new(":memory:")).unwrap();
    store
        .upsert_session(&SessionRow {
            id: owner().session_id,
            agent_id: "fixture".into(),
            cwd: "/fixture".into(),
            native_session_id: Some("native".into()),
            title: None,
            config_options: None,
            pinned: false,
            archived: false,
            created_at: 10,
            updated_at: 10,
        })
        .unwrap();
    store
}
fn ready(state: &BrowserWorkspace, path: &str) -> (u64, BrowserInfo) {
    let url = format!("https://example.com/{path}");
    let (id, _, _) = state
        .reserve(&owner().session_id, Url::parse(&url).unwrap())
        .unwrap();
    state.creation_confirmed(id).unwrap();
    let info = state.event(id, 1, 1, &url).unwrap();
    (id, info)
}
fn select(state: &BrowserWorkspace, label: &str) {
    let expected = state.tabs(&owner().session_id).unwrap().selection;
    let movement = state
        .begin_select(&owner().session_id, Some(label), &expected)
        .unwrap()
        .unwrap();
    futures_lite::future::block_on(state.execute_selection(
        movement,
        |_, _| async { Ok(()) },
        |_| async { Ok(()) },
    ))
    .unwrap();
}
fn remember(
    state: &BrowserWorkspace,
    store: &MetaStore,
    info: &BrowserInfo,
) -> Result<RememberedPages, String> {
    state.with_confirmed_page(&owner(), &info.label, info.revision, &info.url, || {
        store.remember_page(&owner(), 0, &info.url)
    })
}

#[test]
fn only_exact_selected_ready_public_page_can_be_explicitly_remembered() {
    let state = BrowserWorkspace::default();
    let store = metadata();
    let (_, a) = ready(&state, "a?q=ordinary#part");
    let (_, b) = ready(&state, "b");
    assert!(remember(&state, &store, &a).is_err(), "unselected page");
    select(&state, &a.label);
    let a = state
        .info(state.identity(&owner().session_id, &a.label).unwrap())
        .unwrap();
    assert!(
        remember(&state, &store, &b).is_err(),
        "another nonselected label"
    );
    assert!(
        state
            .with_confirmed_page(
                &PageOwner {
                    session_id: "other".into(),
                    created_at: 10
                },
                &a.label,
                a.revision,
                &a.url,
                || Ok(())
            )
            .is_err()
    );
    assert!(
        state
            .with_confirmed_page(
                &owner(),
                &a.label,
                a.revision,
                "https://example.com/different",
                || Ok(())
            )
            .is_err()
    );
    let saved = remember(&state, &store, &a).unwrap();
    assert_eq!(saved.items[0].url, a.url);
}

#[test]
fn navigation_selection_aba_and_close_invalidate_old_confirmation() {
    let state = BrowserWorkspace::default();
    let store = metadata();
    let (a_id, a) = ready(&state, "a");
    let (_, b) = ready(&state, "b");
    select(&state, &a.label);
    let old = state.info(a_id).unwrap();
    select(&state, &b.label);
    select(&state, &a.label);
    assert!(
        remember(&state, &store, &old).is_err(),
        "same label after A-B-A is a new confirmation"
    );
    let current = state.info(a_id).unwrap();
    state
        .navigate(a_id, Url::parse("https://example.com/new").unwrap())
        .unwrap();
    assert!(remember(&state, &store, &current).is_err());
    let nav = state.navigation(a_id).unwrap();
    state
        .event(a_id, nav, 1, "https://example.com/new")
        .unwrap();
    let before_close = state.info(a_id).unwrap();
    state.close(&owner().session_id, &a.label).unwrap();
    assert!(remember(&state, &store, &before_close).is_err());
    assert!(store.remembered_pages(&owner()).unwrap().items.is_empty());
}

#[test]
fn local_preview_unknown_creation_and_shutdown_cannot_be_written() {
    for condition in [
        "local",
        "preview",
        "creation",
        "loading",
        "withdrawing",
        "shutdown",
        "uncertain",
        "pageError",
    ] {
        let state = BrowserWorkspace::default();
        let store = metadata();
        let (id, info) = ready(&state, "a");
        select(&state, &info.label);
        {
            let mut data = state.0.lock().unwrap();
            match condition {
                "shutdown" => data.shutting_down = true,
                "uncertain" => data.presentation_uncertain = Some(id),
                _ => {
                    let page = data.pages.get_mut(&id).unwrap();
                    match condition {
                        "local" => page.info.local_file_name = Some("index.html".into()),
                        "preview" => {
                            let dir = tempfile::tempdir().unwrap();
                            page.preview = Some(PreviewSource::Development(
                                local_preview::DevServerOrigin::select(
                                    dir.path(),
                                    "http://127.0.0.1:1541/",
                                )
                                .unwrap(),
                            ));
                        }
                        "creation" => page.creation_pending = true,
                        "loading" => page.info.phase = "loading".into(),
                        "withdrawing" => page.withdrawing = true,
                        "pageError" => page.info.error = Some("visibility unknown".into()),
                        _ => unreachable!(),
                    }
                }
            }
        }
        let current = state.info(id).unwrap();
        assert!(remember(&state, &store, &current).is_err(), "{condition}");
        assert!(store.remembered_pages(&owner()).unwrap().items.is_empty());
    }
}

#[test]
fn forgetting_never_closes_live_page_and_reopen_gets_fresh_identity_and_read_lease() {
    let state = BrowserWorkspace::default();
    let store = metadata();
    let (id, info) = ready(&state, "a");
    select(&state, &info.label);
    let info = state.info(id).unwrap();
    let old_ticket = state.read_ticket(&owner().session_id, &info.label).unwrap();
    let saved = remember(&state, &store, &info).unwrap();
    let url = store
        .remembered_page_url(&owner(), saved.revision, &saved.items[0].id)
        .unwrap();
    store.forget_page(&owner(), saved.revision, None).unwrap();
    assert_eq!(state.info(id).unwrap().label, info.label);
    let (new, _, fresh) = state
        .reserve(&owner().session_id, Url::parse(&url).unwrap())
        .unwrap();
    assert_ne!(fresh.label, info.label);
    assert!(
        state
            .read_ticket(&owner().session_id, &fresh.label)
            .is_err(),
        "not selected/ready by stored descriptor"
    );
    assert_ne!(new, id);
    assert!(state.with_read_ticket(&old_ticket, |p| Ok(p.id)).is_ok());
    state.close(&owner().session_id, &info.label).unwrap();
    assert!(state.with_read_ticket(&old_ticket, |p| Ok(p.id)).is_err());
    assert!(store.remembered_pages(&owner()).unwrap().items.is_empty());
}

#[tokio::test]
async fn late_deleted_owner_requires_exact_close_ack_or_returns_owned_error_identity() {
    for close_ack in [true, false] {
        let state = BrowserWorkspace::default();
        let (id, info) = ready(&state, "a");
        let result = state
            .finish_reopen(
                info.clone(),
                Err("对话已删除".into()),
                |task, label| {
                    let state = state.clone();
                    async move {
                        let (closed, _) = state.close(&task, &label)?.unwrap();
                        assert_eq!(closed, id);
                        if close_ack {
                            state.acknowledge_close(closed);
                            Ok(())
                        } else {
                            state.close_failed(closed);
                            Err("unknown close".into())
                        }
                    }
                },
            )
            .await;
        if close_ack {
            assert!(result.is_err());
            assert!(state.identity(&owner().session_id, &info.label).is_err());
        } else {
            let retained = result.unwrap();
            assert_eq!(retained.label, info.label);
            assert_eq!(retained.task_key, owner().session_id);
            assert_eq!(retained.url, info.url);
            assert_eq!(retained.phase, "error");
            assert!(!state.can_operate(id, None));
        }
    }
}
