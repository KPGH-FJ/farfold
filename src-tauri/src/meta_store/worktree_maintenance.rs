//! A connection-local write seal. Reads continue; only the dedicated worktree CAS
//! may briefly write while holding the same SQLite mutex. This is not an OS lock.
use super::*;
use crate::worktrees::DraftBaseline;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) const BUSY: &str = "正在整理工作位置，请完成后重试保存；未发送内容仍保留";
pub(crate) struct MaintenancePermit {
    store: MetaStore,
    owner: u64,
}
impl MaintenancePermit {
    pub(crate) fn release(mut self) -> Result<(), String> {
        self.unseal()
    }
    fn unseal(&mut self) -> Result<(), String> {
        if self.owner == 0 {
            return Ok(());
        }
        let c = self.store.lock()?;
        if self.store.maintenance.load(Ordering::SeqCst) != self.owner {
            return Err(BUSY.into());
        }
        let result = c
            .pragma_update(None, "query_only", false)
            .and_then(|_| c.pragma_query_value(None, "query_only", |r| r.get::<_, bool>(0)));
        self.owner = 0;
        if result == Ok(false) {
            self.store.maintenance.store(0, Ordering::SeqCst);
            Ok(())
        } else {
            self.store.maintenance.store(u64::MAX, Ordering::SeqCst);
            Err(BUSY.into())
        }
    }
}
pub(crate) struct WriteWindow<'a> {
    connection: &'a Connection,
    seal: &'a AtomicU64,
    restore: bool,
}
impl WriteWindow<'_> {
    pub(super) fn finish(mut self) -> Result<(), String> {
        if self.restore {
            let restored = self
                .connection
                .pragma_update(None, "query_only", true)
                .and_then(|_| {
                    self.connection
                        .pragma_query_value(None, "query_only", |r| r.get::<_, bool>(0))
                });
            if restored != Ok(true) {
                self.seal.store(u64::MAX, Ordering::SeqCst);
                return Err(BUSY.into());
            }
            self.restore = false;
        }
        Ok(())
    }
}
impl Drop for WriteWindow<'_> {
    fn drop(&mut self) {
        if self.restore
            && self
                .connection
                .pragma_update(None, "query_only", true)
                .and_then(|_| {
                    self.connection
                        .pragma_query_value(None, "query_only", |r| r.get::<_, bool>(0))
                })
                != Ok(true)
        {
            // A poisoned seal is never restored to writable by the outer permit.
            self.seal.store(u64::MAX, Ordering::SeqCst);
        }
    }
}
impl Drop for MaintenancePermit {
    fn drop(&mut self) {
        // Only an originally writable connection has this owner. clear_all's
        // permanent seal never does. Final operation receipts call release explicitly.
        let _ = self.unseal();
    }
}
fn raws(c: &Connection) -> Result<[Option<String>; 2], String> {
    let mut out: [Option<String>; 2] = [None, None];
    for (index, key) in ["unsentWork.v1", "agentSetup.v1"].into_iter().enumerate() {
        out[index] = c
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(sqlite_receipt)?;
        if out[index]
            .as_ref()
            .is_some_and(|s| s.len() > 32 * 1024 * 1024)
        {
            return Err("未发送内容过多，暂时无法整理工作位置".into());
        }
    }
    Ok(out)
}
fn digest(raw: &[Option<String>; 2]) -> DraftBaseline {
    let hashes = raw.each_ref().map(|s| {
        s.as_ref().map(|s| {
            Sha256::digest(s.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        })
    });
    DraftBaseline {
        unsent_work: hashes[0].clone(),
        agent_setup: hashes[1].clone(),
    }
}
impl MetaStore {
    pub(crate) fn worktree_draft_baseline(
        &self,
    ) -> Result<(DraftBaseline, [Option<String>; 2]), String> {
        let connection = self.lock()?;
        let raw = raws(&connection)?;
        Ok((digest(&raw), raw))
    }
    pub(crate) fn begin_worktree_maintenance(
        &self,
        expected: &DraftBaseline,
    ) -> Result<MaintenancePermit, String> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let c = self.lock()?;
        if self.maintenance.load(Ordering::SeqCst) != 0
            || c.pragma_query_value(None, "query_only", |r| r.get::<_, bool>(0))
                .map_err(sqlite_receipt)?
        {
            return Err(BUSY.into());
        }
        if digest(&raws(&c)?) != *expected {
            return Err("draftChanged".into());
        }
        let owner = NEXT
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                n.checked_add(1).filter(|n| *n < u64::MAX)
            })
            .map_err(|_| BUSY)?;
        c.pragma_update(None, "query_only", true)
            .map_err(sqlite_receipt)?;
        if c.pragma_query_value(None, "query_only", |r| r.get::<_, bool>(0)) != Ok(true) {
            self.maintenance.store(u64::MAX, Ordering::SeqCst);
            return Err(BUSY.into());
        }
        self.maintenance.store(owner, Ordering::SeqCst);
        Ok(MaintenancePermit {
            store: self.clone(),
            owner,
        })
    }
    pub(super) fn worktree_write_window<'a>(
        &'a self,
        c: &'a Connection,
    ) -> Result<WriteWindow<'a>, String> {
        let owner = self.maintenance.load(Ordering::SeqCst);
        if owner == u64::MAX {
            return Err(BUSY.into());
        }
        let sealed = c
            .pragma_query_value(None, "query_only", |r| r.get::<_, bool>(0))
            .map_err(sqlite_receipt)?;
        if owner == 0 {
            if sealed {
                return Err(BUSY.into());
            }
            return Ok(WriteWindow {
                connection: c,
                seal: &self.maintenance,
                restore: false,
            });
        }
        if !sealed {
            self.maintenance.store(u64::MAX, Ordering::SeqCst);
            return Err(BUSY.into());
        }
        let window = WriteWindow {
            connection: c,
            seal: &self.maintenance,
            restore: true,
        };
        c.pragma_update(None, "query_only", false)
            .map_err(sqlite_receipt)?;
        Ok(window)
    }
    pub(crate) fn ensure_worktree_write_available(&self) -> Result<(), String> {
        if self.maintenance.load(Ordering::SeqCst) != 0 {
            Err(BUSY.into())
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_maintenance_with_failed_unseal_returns_unknown_and_allows_confirmed_exit() {
        crate::worktrees::recycle_tests::isolated(
            "meta_store::worktree_maintenance::tests::completed_maintenance_with_failed_unseal_returns_unknown_and_allows_confirmed_exit",
            || {
                use crate::worktrees::{
                    tests::{OP, Repo, git, input, op, wait},
                    *,
                };
                unsafe extern "C" fn deny_second_write_window(
                    data: *mut std::ffi::c_void,
                    action: std::ffi::c_int,
                    first: *const std::ffi::c_char,
                    second: *const std::ffi::c_char,
                    _: *const std::ffi::c_char,
                    _: *const std::ffi::c_char,
                ) -> std::ffi::c_int {
                    if action == rusqlite::ffi::SQLITE_PRAGMA
                        && !first.is_null()
                        && !second.is_null()
                        && unsafe { std::ffi::CStr::from_ptr(first) }.to_bytes() == b"query_only"
                        && matches!(
                            unsafe { std::ffi::CStr::from_ptr(second) }.to_bytes(),
                            b"0" | b"false" | b"off"
                        )
                    {
                        let calls = unsafe { &*data.cast::<std::sync::atomic::AtomicUsize>() };
                        if calls.fetch_add(1, Ordering::SeqCst) >= 1 {
                            return rusqlite::ffi::SQLITE_DENY;
                        }
                    }
                    rusqlite::ffi::SQLITE_OK
                }
                let r = Repo::new();
                let s = MetaStore::open(&r._dir.path().join("meta.db")).unwrap();
                let m = Worktrees::default();
                let args = input(
                    &m,
                    &s,
                    &r,
                    Branch::New {
                        name: "seal-fixture".into(),
                        start_oid: git(&r.root, &["rev-parse", "HEAD"]),
                    },
                    "owned",
                );
                m.prepare(&s, OP, args).unwrap();
                m.start(&s, OP).unwrap();
                let location = wait(&m, &s).location.unwrap();
                let preview = m
                    .recycle_inspect(&s, RecycleAction::Archive, &location.id, location.revision)
                    .unwrap();
                let id = "92345678-1234-4123-8123-123456789abc";
                m.prepare_recycle(
                    &s,
                    id,
                    RecycleInput {
                        inspection_id: preview.inspection_id,
                        action: preview.action,
                        expected_draft_baseline: preview.draft_baseline,
                    },
                    |_| Ok(()),
                )
                .unwrap();
                let calls = std::sync::atomic::AtomicUsize::new(0);
                {
                    let c = s.connection.lock().unwrap();
                    assert_eq!(
                        unsafe {
                            rusqlite::ffi::sqlite3_set_authorizer(
                                c.handle(),
                                Some(deny_second_write_window),
                                (&calls as *const std::sync::atomic::AtomicUsize)
                                    .cast_mut()
                                    .cast(),
                            )
                        },
                        rusqlite::ffi::SQLITE_OK
                    );
                }
                let result = op(m.cancel(&s, id).unwrap());
                {
                    let c = s.connection.lock().unwrap();
                    unsafe {
                        rusqlite::ffi::sqlite3_set_authorizer(
                            c.handle(),
                            None,
                            std::ptr::null_mut(),
                        );
                    }
                    assert_eq!(
                        c.pragma_query_value(None, "query_only", |r| r.get::<_, bool>(0)),
                        Ok(true)
                    );
                }
                assert_eq!(calls.load(Ordering::SeqCst), 2);
                assert_eq!(result.state, "unknown");
                assert_eq!(result.code.as_deref(), Some("storageUnknown"));
                assert!(result.settled && !result.maintenance_active);
                assert!(result.location.is_none() && result.archive.is_none());
                assert_eq!(
                    result.original_path.as_deref(),
                    Some(location.path.as_str())
                );
                assert!(std::path::Path::new(&location.path).exists());
                assert!(s.set_setting("late", &serde_json::json!(true)).is_err());
                assert_eq!(
                    m.seal_exit(Some(&s), false).err().as_deref(),
                    Some("EXIT_CONFIRMATION_REQUIRED")
                );
                assert!(m.seal_exit(Some(&s), true).is_ok());
                assert!(crate::managed_update::activity().is_ok());
            },
        );
    }
    #[test]
    fn query_only_release_rejection_is_not_reported_as_success() {
        unsafe extern "C" fn deny_unseal(
            _: *mut std::ffi::c_void,
            action: std::ffi::c_int,
            first: *const std::ffi::c_char,
            second: *const std::ffi::c_char,
            _: *const std::ffi::c_char,
            _: *const std::ffi::c_char,
        ) -> std::ffi::c_int {
            if action == rusqlite::ffi::SQLITE_PRAGMA && !first.is_null() && !second.is_null() {
                let name = unsafe { std::ffi::CStr::from_ptr(first) }.to_bytes();
                let value = unsafe { std::ffi::CStr::from_ptr(second) }.to_bytes();
                if name == b"query_only" && matches!(value, b"0" | b"false" | b"off") {
                    return rusqlite::ffi::SQLITE_DENY;
                }
            }
            rusqlite::ffi::SQLITE_OK
        }
        let dir = tempfile::tempdir().unwrap();
        let s = MetaStore::open(&dir.path().join("m.db")).unwrap();
        let baseline = s.worktree_draft_baseline().unwrap().0;
        let permit = s.begin_worktree_maintenance(&baseline).unwrap();
        {
            let c = s.connection.lock().unwrap();
            assert_eq!(
                unsafe {
                    rusqlite::ffi::sqlite3_set_authorizer(
                        c.handle(),
                        Some(deny_unseal),
                        std::ptr::null_mut(),
                    )
                },
                rusqlite::ffi::SQLITE_OK
            );
        }
        assert!(permit.release().is_err());
        assert!(s.set_setting("late", &serde_json::json!(true)).is_err());
        let c = s.connection.lock().unwrap();
        assert_eq!(
            c.pragma_query_value(None, "query_only", |r| r.get::<_, bool>(0)),
            Ok(true)
        );
    }
    #[test]
    fn maintenance_seal_rejects_late_writes_and_keeps_dedicated_cas_available() {
        let dir = tempfile::tempdir().unwrap();
        let s = MetaStore::open(&dir.path().join("m.db")).unwrap();
        s.set_setting("unsentWork.v1", &serde_json::json!({"kept":true}))
            .unwrap();
        let (baseline, _) = s.worktree_draft_baseline().unwrap();
        let permit = s.begin_worktree_maintenance(&baseline).unwrap();
        assert_eq!(
            s.set_setting("unsentWork.v1", &serde_json::json!({"lost":true}))
                .unwrap_err(),
            BUSY
        );
        assert!(
            s.lock()
                .unwrap()
                .execute("INSERT INTO settings VALUES ('late','1')", [])
                .is_err()
        );
        assert!(s.worktree_compare_write(None, "{\"version\":1}").unwrap());
        assert!(
            s.lock()
                .unwrap()
                .execute("INSERT INTO settings VALUES ('late','1')", [])
                .is_err()
        );
        assert!(s.clear_all().is_err());
        drop(permit);
        s.set_setting("other", &serde_json::json!(1)).unwrap();
        assert_eq!(
            s.get_setting("unsentWork.v1").unwrap().unwrap(),
            serde_json::json!({"kept":true})
        );
    }
    #[test]
    fn baseline_mismatch_and_permanent_clear_seal_never_become_writable() {
        let dir = tempfile::tempdir().unwrap();
        let s = MetaStore::open(&dir.path().join("m.db")).unwrap();
        let (baseline, _) = s.worktree_draft_baseline().unwrap();
        s.set_setting("agentSetup.v1", &serde_json::json!({"changed":true}))
            .unwrap();
        assert!(s.begin_worktree_maintenance(&baseline).is_err());
        let (baseline, _) = s.worktree_draft_baseline().unwrap();
        s.clear_all().unwrap();
        assert!(s.begin_worktree_maintenance(&baseline).is_err());
        assert!(s.worktree_compare_write(None, "{}").is_err());
        assert!(s.set_setting("other", &serde_json::json!(1)).is_err());
    }
    #[test]
    fn private_window_restores_seal_after_error_and_unwind_before_unlock() {
        let dir = tempfile::tempdir().unwrap();
        let s = MetaStore::open(&dir.path().join("m.db")).unwrap();
        let (baseline, _) = s.worktree_draft_baseline().unwrap();
        let _permit = s.begin_worktree_maintenance(&baseline).unwrap();
        let c = s.lock().unwrap();
        let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _window = s.worktree_write_window(&c).unwrap();
            panic!("controlled");
        }));
        assert!(failed.is_err());
        assert!(
            c.execute("INSERT INTO settings VALUES ('late','1')", [])
                .is_err()
        );
    }
    #[test]
    fn actual_worktree_cas_sql_error_restores_query_only_before_returning() {
        let dir = tempfile::tempdir().unwrap();
        let s = MetaStore::open(&dir.path().join("m.db")).unwrap();
        s.lock().unwrap().execute_batch(
            "CREATE TRIGGER reject_worktree BEFORE INSERT ON settings WHEN NEW.key='worktreeLocations.v1' BEGIN SELECT RAISE(ABORT, 'controlled'); END;"
        ).unwrap();
        let baseline = s.worktree_draft_baseline().unwrap().0;
        let permit = s.begin_worktree_maintenance(&baseline).unwrap();
        assert!(s.worktree_compare_write(None, "{}").is_err());
        assert!(s.worktree_raw().unwrap().is_none());
        assert_eq!(
            s.lock()
                .unwrap()
                .pragma_query_value(None, "query_only", |r| r.get::<_, bool>(0)),
            Ok(true)
        );
        assert!(s.set_setting("late", &serde_json::json!(true)).is_err());
        drop(permit);
        s.set_setting("after", &serde_json::json!(true)).unwrap();
    }
}
