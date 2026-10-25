//! Exact native read ownership, not a frontend-only import restriction.
use super::*;
use crate::acp_client::{
    open_purpose::OpenPurpose,
    session_discovery::{ImportPreview, commit_preview, open_preview},
};

async fn preview(f: &Fixture, token: &str, purpose: OpenPurpose) -> ImportPreview {
    let channel = tauri::ipc::Channel::new(|body| {
        let _ = body.deserialize::<Value>()?;
        Ok(())
    });
    open_preview(
        &f.manager,
        &f.store,
        &f.agent,
        &f.cwd,
        "history".into(),
        token.into(),
        "read-purpose-open",
        channel,
        None,
        purpose,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn search_read_preview_token_cannot_commit_an_index_row() {
    let f = Fixture::new(true);
    let read = preview(&f, "only-read", OpenPurpose::SearchReadOnly).await;
    assert_eq!(read.purpose, "searchReadOnly");
    assert!(f.store.list_sessions().unwrap().is_empty());
    let saved = commit_preview(
        &f.manager,
        &f.store,
        f.agent.id.clone(),
        f.cwd.clone(),
        "history".into(),
        read.preview_token,
        Some("must remain unindexed".into()),
    )
    .await;
    assert!(
        saved.is_err(),
        "the IPC's native token owner must forbid commit"
    );
    assert!(f.store.list_sessions().unwrap().is_empty());
}

#[tokio::test]
async fn import_preview_token_still_commits_the_explicit_import() {
    let f = Fixture::new(true);
    let import = preview(&f, "only-import", OpenPurpose::ImportPreview).await;
    let saved = commit_preview(
        &f.manager,
        &f.store,
        f.agent.id.clone(),
        f.cwd.clone(),
        "history".into(),
        import.preview_token,
        Some("Explicit import".into()),
    )
    .await
    .unwrap();
    assert_eq!(saved.native_session_id.as_deref(), Some("history"));
    assert_eq!(f.store.list_sessions().unwrap().len(), 1);
}

#[tokio::test]
async fn search_read_preview_stale_cleanup_cannot_close_the_reopened_owner() {
    let f = Fixture::new(true);
    let first = preview(&f, "first-read", OpenPurpose::SearchReadOnly).await;
    f.manager
        .close_session_owned(&f.agent.id, &f.cwd, "history", Some(&first.preview_token))
        .await
        .unwrap();
    let second = preview(&f, "second-read", OpenPurpose::SearchReadOnly).await;
    assert!(
        f.manager
            .close_session_owned(&f.agent.id, &f.cwd, "history", Some(&first.preview_token))
            .await
            .is_err()
    );
    let owner = f
        .manager
        .session_connection(&f.agent.id, &f.cwd, "history")
        .unwrap();
    {
        let entries = owner.sessions.lock().unwrap();
        let current = entries.get("history").unwrap();
        assert_eq!(current.preview_token.as_deref(), Some("second-read"));
        assert_eq!(current.purpose, OpenPurpose::SearchReadOnly);
    }
    f.manager
        .close_session_owned(&f.agent.id, &f.cwd, "history", Some(&second.preview_token))
        .await
        .unwrap();
    assert!(f.store.list_sessions().unwrap().is_empty());
}

#[tokio::test]
async fn search_read_preview_invalid_inputs_do_not_start_a_connection() {
    for (native, config, token) in [
        (None, vec![], Some("invalid-read".into())),
        (Some(String::new()), vec![], Some("invalid-read".into())),
        (
            Some("history".into()),
            vec![("extra".into(), json!(true))],
            Some("invalid-read".into()),
        ),
        (Some("history".into()), vec![], None),
    ] {
        let f = Fixture::new(true);
        let outcome = f
            .manager
            .open_session_owned_for_purpose(
                &f.agent,
                &f.cwd,
                native,
                config,
                Arc::new(|_| {}),
                &f.store,
                None,
                token,
                OpenPurpose::SearchReadOnly,
                None,
                None,
            )
            .await;
        assert!(
            outcome.is_err(),
            "read purpose requires an existing target and no requested changes"
        );
        assert!(
            f.manager.lock().unwrap().is_empty(),
            "invalid read inputs must fail before connecting"
        );
        assert!(f.store.list_sessions().unwrap().is_empty());
    }
}

#[tokio::test]
async fn search_read_preview_same_live_token_cannot_change_into_import() {
    let f = Fixture::new(true);
    let read = preview(&f, "immutable-read", OpenPurpose::SearchReadOnly).await;
    let channel = tauri::ipc::Channel::new(|body| {
        let _ = body.deserialize::<Value>()?;
        Ok(())
    });
    let promoted = open_preview(
        &f.manager,
        &f.store,
        &f.agent,
        &f.cwd,
        "history".into(),
        read.preview_token.clone(),
        "promotion-attempt",
        channel,
        None,
        OpenPurpose::ImportPreview,
    )
    .await;
    assert!(
        promoted.is_err(),
        "an existing read owner cannot be relabeled"
    );
    assert_eq!(
        std::fs::read_to_string(f.cwd.join("open-requests")).unwrap(),
        "session/load\n"
    );
    let owner = f
        .manager
        .session_connection(&f.agent.id, &f.cwd, "history")
        .unwrap();
    assert_eq!(
        owner
            .sessions
            .lock()
            .unwrap()
            .get("history")
            .unwrap()
            .purpose,
        OpenPurpose::SearchReadOnly
    );
    assert!(
        commit_preview(
            &f.manager,
            &f.store,
            f.agent.id.clone(),
            f.cwd.clone(),
            "history".into(),
            read.preview_token.clone(),
            None,
        )
        .await
        .is_err()
    );
    assert!(f.store.list_sessions().unwrap().is_empty());
    f.manager
        .close_session_owned(&f.agent.id, &f.cwd, "history", Some(&read.preview_token))
        .await
        .unwrap();
}

#[tokio::test]
async fn search_read_preview_unsupported_load_never_falls_back_to_new() {
    let mut f = Fixture::new(true);
    f.agent.args.push("--no-load".into());
    f.store.replace_agent_launch(&f.agent).unwrap();
    let channel = tauri::ipc::Channel::new(|body| {
        let _ = body.deserialize::<Value>()?;
        Ok(())
    });
    let read = open_preview(
        &f.manager,
        &f.store,
        &f.agent,
        &f.cwd,
        "history".into(),
        "unsupported-read".into(),
        "unsupported-open",
        channel,
        None,
        OpenPurpose::SearchReadOnly,
    )
    .await;
    assert!(read.is_err());
    assert!(
        !f.cwd.join("open-requests").exists(),
        "neither load nor new may be dispatched"
    );
    assert!(f.store.list_sessions().unwrap().is_empty());
}
