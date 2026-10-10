//! Controlled protocol peer, never an installed Agent or user project.
use super::*;
#[tokio::test(flavor = "multi_thread")]
async fn directory_maintenance_retires_exact_idle_alias_descendant_and_reaps_before_return() {
    let f = Fixture::new();
    let root = f.cwd.join("owned-directory");
    let child = root.join("sub");
    std::fs::create_dir_all(&child).unwrap();
    let alias = f.cwd.join("alias");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&root, &alias).unwrap();
    #[cfg(not(unix))]
    let alias = root.clone();
    let cwd = alias.join("sub");
    let opened = f
        .manager
        .open_session(&f.row, &cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await
        .unwrap();
    let connection = f
        .manager
        .session_connection(&f.row.id, &cwd, &opened.session_id)
        .unwrap();
    assert!(!connection.life.finished());
    let baseline = f.store.worktree_draft_baseline().unwrap().0;
    let seal = f.store.begin_worktree_maintenance(&baseline).unwrap();
    tokio::time::timeout(
        Duration::from_secs(8),
        f.manager.release_for_directory_maintenance(&root),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(connection.life.finished());
    assert!(connection.life.work().is_err());
    assert!(f.store.set_setting("late", &json!(true)).is_err());
    drop(seal);
    f.store.set_setting("after", &json!(true)).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.cwd.join("peer.py")).unwrap(),
        PEER
    );
}
#[tokio::test(flavor = "multi_thread")]
async fn directory_maintenance_does_not_force_active_or_unconfirmed_life() {
    let f = Fixture::new();
    f.connect().await;
    let c = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    let work = c.life.work().unwrap();
    assert!(
        f.manager
            .release_for_directory_maintenance(&f.cwd)
            .await
            .is_err()
    );
    assert!(!c.life.finished());
    assert!(c.life.operation("still-open".into()).is_ok());
    drop(work);
    f.manager
        .release_for_directory_maintenance(&f.cwd)
        .await
        .unwrap();
    assert!(c.life.finished());
}
