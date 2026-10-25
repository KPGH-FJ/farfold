use super::*;
use serde_json::json;

fn owner(id: &str, created_at: i64) -> PageOwner {
    PageOwner {
        session_id: id.into(),
        created_at,
    }
}
fn insert(store: &MetaStore, owner: &PageOwner) {
    store
        .upsert_session(&SessionRow {
            id: owner.session_id.clone(),
            agent_id: "fixture".into(),
            cwd: "/fixture".into(),
            native_session_id: Some("native".into()),
            title: None,
            config_options: None,
            pinned: false,
            archived: false,
            created_at: owner.created_at,
            updated_at: owner.created_at,
        })
        .unwrap();
}
fn store() -> MetaStore {
    MetaStore::test_memory()
}
fn raw(store: &MetaStore, owner: &PageOwner) -> Option<String> {
    store
        .lock()
        .unwrap()
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [key(&owner.session_id)],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
}

#[test]
fn two_owners_restart_keep_only_explicit_ordered_locations_and_read_does_not_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meta.db");
    let first = owner("first", 10);
    let second = owner("second", 20);
    let store = MetaStore::open(&path).unwrap();
    insert(&store, &first);
    insert(&store, &second);
    store
        .set_setting("unrelated", &json!({"keep":true}))
        .unwrap();
    assert!(store.remembered_pages(&first).unwrap().items.is_empty());
    assert!(
        raw(&store, &first).is_none(),
        "listing is not an implicit save"
    );
    let a = store
        .remember_page(&first, 0, "https://example.com/a?view=plain#part")
        .unwrap();
    let b = store
        .remember_page(&first, a.revision, "https://example.com/b")
        .unwrap();
    let other = store
        .remember_page(&second, 0, "https://example.org/other")
        .unwrap();
    assert_eq!(
        store
            .remember_page(&first, b.revision, &b.items[0].url)
            .unwrap(),
        b
    );
    drop(store);
    let restored = MetaStore::open(&path).unwrap();
    assert_eq!(restored.remembered_pages(&first).unwrap(), b);
    assert_eq!(restored.remembered_pages(&second).unwrap(), other);
    assert_eq!(
        b.items.iter().map(|x| x.url.as_str()).collect::<Vec<_>>(),
        vec![
            "https://example.com/a?view=plain#part",
            "https://example.com/b"
        ]
    );
    assert_eq!(
        restored.get_setting("unrelated").unwrap(),
        Some(json!({"keep":true}))
    );
    let value: serde_json::Value = serde_json::from_str(&raw(&restored, &first).unwrap()).unwrap();
    assert_eq!(
        value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from(["createdAt", "items", "revision", "version"])
    );
    assert_eq!(value["items"][0].as_object().unwrap().len(), 2);
    assert!(value["items"][0].get("label").is_none());
}

#[test]
fn forget_and_empty_clear_reject_late_writes_without_touching_sibling_data() {
    let store = store();
    let who = owner("first", 10);
    let other = owner("second", 20);
    insert(&store, &who);
    insert(&store, &other);
    let a = store
        .remember_page(&who, 0, "https://example.com/a")
        .unwrap();
    let sibling = store
        .remember_page(&other, 0, "https://example.org/b")
        .unwrap();
    let cleared = store.forget_page(&who, a.revision, None).unwrap();
    assert!(cleared.items.is_empty());
    assert!(cleared.revision > a.revision);
    assert!(
        store
            .remember_page(&who, a.revision, "https://example.com/late")
            .is_err()
    );
    assert!(
        store
            .remember_page(&who, 0, "https://example.com/late")
            .is_err()
    );
    assert!(
        store
            .remembered_page_url(&who, a.revision, &a.items[0].id)
            .is_err()
    );
    let twice = store.forget_page(&who, cleared.revision, None).unwrap();
    assert!(twice.revision > cleared.revision);
    assert!(
        store
            .remember_page(&who, cleared.revision, "https://example.com/late")
            .is_err()
    );
    let current = store
        .remember_page(&who, twice.revision, "https://example.com/new")
        .unwrap();
    let forgotten = store
        .forget_page(&who, current.revision, Some(&current.items[0].id))
        .unwrap();
    assert!(forgotten.items.is_empty());
    assert_eq!(store.remembered_pages(&other).unwrap(), sibling);
}

#[test]
fn deletion_is_atomic_and_stale_owner_cannot_restore_pages_after_delete_or_clear() {
    let store = store();
    let who = owner("first", 10);
    insert(&store, &who);
    let a = store
        .remember_page(&who, 0, "https://example.com/a")
        .unwrap();
    store.lock().unwrap().execute_batch("CREATE TRIGGER refuse_page_cleanup BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'fixture'); END;").unwrap();
    assert!(store.remove_session(&who.session_id).is_err());
    assert!(store.get_session(&who.session_id).unwrap().is_some());
    assert_eq!(store.remembered_pages(&who).unwrap(), a);
    store
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER refuse_page_cleanup")
        .unwrap();
    assert!(store.remove_session(&who.session_id).unwrap());
    assert!(raw(&store, &who).is_none());
    assert!(
        store
            .remember_page(&who, a.revision, "https://example.com/late")
            .is_err()
    );
    let replacement = owner("first", 30);
    insert(&store, &replacement);
    assert!(store.remembered_pages(&who).is_err());
    assert!(
        store
            .remember_page(&who, 0, "https://example.com/late")
            .is_err()
    );
    assert!(
        store
            .remembered_pages(&replacement)
            .unwrap()
            .items
            .is_empty()
    );
    store.clear_all().unwrap();
    assert!(
        store
            .remember_page(&replacement, 0, "https://example.com/late")
            .is_err()
    );
    assert!(store.get_setting(&key(&who.session_id)).unwrap().is_none());
}

#[test]
fn malformed_future_extra_and_oversize_records_are_never_overwritten() {
    let item = json!({"id":"a".repeat(32),"url":"https://example.com/a"});
    for value in [
        "not json".into(),
        json!({"version":2,"createdAt":10,"revision":1,"items":[]}).to_string(),
        json!({"version":1,"createdAt":10,"revision":1,"items":[],"grant":true}).to_string(),
        json!({"version":1,"createdAt":10,"revision":1,"items":[{"id":"a".repeat(32),"url":"https://example.com/a","title":"not allowed"}]}).to_string(),
        json!({"version":1,"createdAt":11,"revision":1,"items":[]}).to_string(),
        json!({"version":1,"createdAt":10,"revision":0,"items":[]}).to_string(),
        json!({"version":1,"createdAt":10,"revision":1,"items":[item.clone(),item]}).to_string(),
        "x".repeat(MAX_BYTES+1),
    ] {
        let store = store(); let who = owner("first", 10); insert(&store, &who);
        store.lock().unwrap().execute("INSERT INTO settings(key,value) VALUES (?1,?2)", params![key(&who.session_id),value]).unwrap();
        assert!(store.remembered_pages(&who).is_err());
        assert!(store.remember_page(&who, 0, "https://example.com/new").is_err());
        assert!(store.forget_page(&who, 0, None).is_err());
        assert_eq!(raw(&store,&who).unwrap(), value);
    }
}

#[test]
fn admitted_public_urls_remain_exact_and_sensitive_or_local_targets_are_not_saved() {
    let store = store();
    let who = owner("first", 10);
    insert(&store, &who);
    for url in [
        "http://127.0.0.1:1541/",
        "file:///tmp/index.html",
        "https://user:pass@example.com/",
        "https://accounts.example.com/",
        "https://example.com/login",
        "https://example.com/?token=fixture",
        "https://example.com/#access_token=fixture",
        "https://127.0.0.1/",
        "https://host.local/",
    ] {
        assert!(store.remember_page(&who, 0, url).is_err(), "{url}");
    }
    assert!(raw(&store, &who).is_none());
    let exact = "https://example.com/opaque-value?q=ordinary#part";
    let saved = store.remember_page(&who, 0, exact).unwrap();
    assert_eq!(
        store
            .remembered_page_url(&who, saved.revision, &saved.items[0].id)
            .unwrap(),
        exact
    );
    // This acceptance is not a proof that an arbitrary opaque locator has no secret.
}

#[test]
fn capacity_revision_and_readonly_failures_keep_the_previous_list() {
    let store = store();
    let who = owner("first", 10);
    insert(&store, &who);
    let mut saved = store.remembered_pages(&who).unwrap();
    for n in 0..MAX_ITEMS {
        saved = store
            .remember_page(&who, saved.revision, &format!("https://example.com/{n}"))
            .unwrap();
    }
    assert!(
        store
            .remember_page(&who, saved.revision, "https://example.com/overflow")
            .is_err()
    );
    assert_eq!(store.remembered_pages(&who).unwrap(), saved);
    let mut value: serde_json::Value = serde_json::from_str(&raw(&store, &who).unwrap()).unwrap();
    value["revision"] = json!(MAX_REVISION);
    store.set_setting(&key(&who.session_id), &value).unwrap();
    assert!(store.forget_page(&who, MAX_REVISION, None).is_err());
    assert_eq!(
        store.get_setting(&key(&who.session_id)).unwrap(),
        Some(value)
    );
    store
        .lock()
        .unwrap()
        .pragma_update(None, "query_only", true)
        .unwrap();
    assert!(store.forget_page(&who, MAX_REVISION, None).is_err());
    assert_eq!(store.remembered_pages(&who).unwrap().items, saved.items);
}

#[test]
fn concurrent_connections_cannot_commit_the_same_list_baseline_twice() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("meta.db");
    let first = MetaStore::open(&path).unwrap();
    let second = MetaStore::open(&path).unwrap();
    let who = owner("first", 10);
    insert(&first, &who);
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let tasks: Vec<_> = [first, second]
        .into_iter()
        .enumerate()
        .map(|(i, store)| {
            let barrier = barrier.clone();
            let who = who.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.remember_page(&who, 0, &format!("https://example.com/{i}"))
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = tasks.into_iter().map(|task| task.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|x| x.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|x| x.is_err()).count(), 1);
    assert_eq!(
        MetaStore::open(&path)
            .unwrap()
            .remembered_pages(&who)
            .unwrap()
            .items
            .len(),
        1
    );
}
