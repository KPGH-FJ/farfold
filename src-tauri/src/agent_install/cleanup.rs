//! Candidate files are released only after the existing manager confirms cleanup.
use crate::acp_client::startup_diagnostics::{Cleanup, Diagnostics};
use std::sync::Arc;

pub(super) fn close(directory: tempfile::TempDir, diagnostics: &Arc<Diagnostics>) {
    let path = directory.path().to_path_buf();
    let result = directory.close();
    // Drop is not proof; both explicit close and a subsequent existence check
    // must confirm deletion. Never replace the original installation result.
    diagnostics.cleanup(match (result, path.try_exists()) {
        (Ok(()), Ok(false)) => Cleanup::Deleted,
        (_, Ok(true)) => Cleanup::Retained,
        _ => Cleanup::Unconfirmed,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    fn final_record(logs: &std::path::Path, status: &str) -> Value {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            for entry in std::fs::read_dir(logs).unwrap() {
                let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
                assert!(!text.contains("file-canary"));
                for line in text.lines() {
                    if let Ok(value) = serde_json::from_str::<Value>(line)
                        && value["candidateCleanup"] == status
                    {
                        return value;
                    }
                }
            }
            assert!(std::time::Instant::now() < until);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    #[test]
    fn candidate_cleanup_explicit_close_checks_actual_absence() {
        let parent = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir_in(parent.path()).unwrap();
        let path = staging.path().to_path_buf();
        std::fs::write(path.join("file-canary"), "file-canary").unwrap();
        let logs = parent.path().join("logs");
        let d = Diagnostics::open(&logs, "fixture");
        close(staging, &d);
        assert!(!path.try_exists().unwrap());
        assert_eq!(
            final_record(&logs, "deleted")["candidateCleanup"],
            "deleted"
        );
    }
    #[test]
    fn candidate_cleanup_failed_close_does_not_claim_deleted_or_retry_the_path() {
        let parent = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir_in(parent.path()).unwrap();
        let path = staging.path().to_path_buf();
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, "file-canary").unwrap();
        let logs = parent.path().join("logs");
        let d = Diagnostics::open(&logs, "fixture");
        close(staging, &d);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "file-canary");
        assert_eq!(
            final_record(&logs, "retained")["candidateCleanup"],
            "retained"
        );
    }
}

#[cfg(test)]
mod process_test {
    use super::*;
    use crate::{
        acp_client::manager::AcpManager,
        meta_store::{AgentRow, MetaStore},
    };
    #[tokio::test(flavor = "multi_thread")]
    async fn candidate_cleanup_real_failed_process_is_reaped_before_explicit_close() {
        let parent = tempfile::tempdir().unwrap();
        let cwd = parent.path().canonicalize().unwrap();
        let staging = tempfile::tempdir_in(&cwd).unwrap();
        let path = staging.path().to_path_buf();
        let peer = path.join("file-canary.py");
        std::fs::write(&peer, "import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if m.get('method')=='initialize': sys.exit(3)\n").unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let original = AgentRow {
            id: "cleanup-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: "/usr/bin/python3".into(),
            args: vec![],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&original).unwrap();
        let mut candidate = original.clone();
        candidate.args = vec!["-u".into(), peer.display().to_string()];
        let manager = AcpManager::new(cwd.join("logs"), cwd.clone());
        let d = manager.startup_diagnostics(&candidate.id);
        d.cleanup(Cleanup::Pending);
        assert_eq!(
            manager
                .probe_launch_diagnosed(&candidate, &store, std::future::pending(), d.clone())
                .await
                .unwrap_err(),
            "AGENT_CONNECTION_ENDED"
        );
        assert!(!manager.candidate_pending(&candidate.id).unwrap());
        assert!(d.candidate_files_releasable());
        close(staging, &d);
        assert!(!path.try_exists().unwrap());
        assert_eq!(store.get_agent(&original.id).unwrap().unwrap(), original);
        assert!(store.list_settings().unwrap().is_empty());
    }
}
