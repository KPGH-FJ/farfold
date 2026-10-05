//! A real failed candidate must not hide an unknown manager cleanup outcome.
#![cfg(unix)]
use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn startup_failure_cleanup_lock_error_is_not_replaced_by_safe_retry_code() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let peer = cwd.join("peer.py");
    let marker = cwd.join("waiting");
    let release = cwd.join("release");
    std::fs::write(
        &peer,
        r#"import sys,json,os,time
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='initialize':
  open(sys.argv[1],'w').write(str(os.getpid()))
  while not os.path.exists(sys.argv[2]): time.sleep(.005)
  print(json.dumps({'jsonrpc':'2.0','id':m['id'],'error':{'code':-32602,'message':'controlled error'}}),flush=True)
"#,
    )
    .unwrap();
    let row = AgentRow {
        id: "startup-cleanup-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: "/usr/bin/python3".into(),
        args: vec![
            "-u".into(),
            peer.to_string_lossy().into(),
            marker.to_string_lossy().into(),
            release.to_string_lossy().into(),
        ],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    let store = crate::meta_store::MetaStore::open(&cwd.join("meta.db")).unwrap();
    store.insert_agent(&row).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let probing = {
        let (manager, row, store) = (manager.clone(), row.clone(), store.clone());
        tokio::spawn(async move {
            manager
                .probe_launch(&row, &store, std::future::pending())
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        while !marker.exists()
            || std::fs::read_to_string(&marker)
                .unwrap_or_default()
                .is_empty()
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let connection = manager.lock().unwrap().values().next().unwrap().clone();
    let poisoned = manager.connections.clone();
    assert!(
        std::thread::spawn(move || {
            let _guard = poisoned.lock().unwrap();
            panic!("controlled cleanup lock poisoning");
        })
        .join()
        .is_err()
    );
    std::fs::write(release, "release").unwrap();
    assert_eq!(
        probing.await.unwrap().unwrap_err(),
        "ACP manager lock poisoned"
    );
    assert_eq!(
        connection.life.closed().await.unwrap_err(),
        "进程已结束，但无法完成连接清理，请重新打开应用"
    );
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
    assert_eq!(store.get_agent(&row.id).unwrap().unwrap(), row);
    assert!(manager.candidate_pending(&row.id).is_err());
}
