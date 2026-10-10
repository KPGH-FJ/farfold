//! Caller holds global maintenance admission through actual process retirement.
use super::*;
impl AcpManager {
    pub(crate) async fn release_for_directory_maintenance(
        &self,
        root: &Path,
    ) -> Result<(), String> {
        let root = root.canonicalize().map_err(|_| "connectionUnconfirmed")?;
        let lives = {
            let all = self.lock()?;
            let mut lives = Vec::new();
            for (key, connection) in all.iter() {
                if connection.life.finished() {
                    continue;
                }
                // An unresolved live cwd cannot be proven unrelated by its spelling.
                let cwd = key
                    .cwd
                    .canonicalize()
                    .map_err(|_| "connectionUnconfirmed")?;
                if cwd.starts_with(&root) {
                    lives.push(connection.life.clone());
                }
            }
            lives
        };
        let mut failure = false;
        let mut released = Vec::new();
        for life in lives {
            if life.release_for_configuration().is_err() {
                failure = true;
                break;
            }
            released.push(life);
        }
        // Reap every process whose stop was dispatched, including partial failure.
        // No timeout may release the directory's admission while it could still run.
        for life in released {
            life.terminated().await;
        }
        if failure {
            Err("connectionUnconfirmed".into())
        } else {
            Ok(())
        }
    }
}
