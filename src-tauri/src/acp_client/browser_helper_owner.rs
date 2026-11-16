//! A deferred, single-use process owner for an offer prepared before spawn.
//! It is never a route locator, secret, persisted identity, or second ledger.
use super::Identity;
use crate::acp_client::{
    lifecycle::{ConnectionLife, READY},
    manager::ManagedConnection,
};
use std::sync::{Arc, OnceLock, Weak, atomic::Ordering};
use std::time::{Duration, Instant};

struct Bound {
    identity: Identity,
    life: Weak<ConnectionLife>,
}
impl Bound {
    fn current(&self) -> bool {
        self.identity.alive()
            && self
                .life
                .upgrade()
                .is_some_and(|life| life.state.load(Ordering::Acquire) == READY && !life.finished())
    }
}
#[derive(Clone)]
pub(crate) struct PendingOwner {
    bound: Arc<OnceLock<Bound>>,
    deadline: Instant,
}
impl PendingOwner {
    pub(crate) fn new() -> Self {
        Self {
            bound: Arc::new(OnceLock::new()),
            deadline: Instant::now() + Duration::from_secs(180),
        }
    }
    pub(crate) fn bind(&self, connection: &ManagedConnection) -> bool {
        let Some(identity) = connection.process_identity.get().copied() else {
            return false;
        };
        self.bind_parts(identity, &connection.life)
    }
    fn bind_parts(&self, identity: Identity, life: &Arc<ConnectionLife>) -> bool {
        let next = Bound {
            identity,
            life: Arc::downgrade(life),
        };
        if !next.current() {
            return false;
        }
        if let Some(bound) = self.bound.get() {
            return bound.identity == identity
                && Weak::ptr_eq(&bound.life, &next.life)
                && bound.current();
        }
        Instant::now() < self.deadline && self.bound.set(next).is_ok()
    }
    fn check(&self) -> crate::browser_sharing::HelperOwnerCheck {
        let owner = self.clone();
        let live = Arc::new(move || {
            owner
                .bound
                .get()
                .map_or_else(|| Instant::now() < owner.deadline, Bound::current)
        });
        let owner = self.clone();
        crate::browser_sharing::HelperOwnerCheck {
            live,
            helper: Arc::new(move |pid, uid| {
                owner
                    .bound
                    .get()
                    .is_some_and(|bound| bound.current() && bound.identity.helper(pid, uid))
            }),
        }
    }
}

/// Binding happens in the normal open path after the actual process is READY
/// and before the first official new/load request can contain this descriptor.
pub(crate) fn prepare(
    app: &tauri::AppHandle,
    sharing: &crate::browser_sharing::BrowserSharing,
    agent_id: &str,
    cwd: &std::path::Path,
) -> Result<crate::acp_client::transient_mcp::TransientMcpOpen, String> {
    let owner = PendingOwner::new();
    sharing
        .prepare_mach(app, agent_id, cwd, owner.check())
        .map(|offer| offer.with_process_owner(owner))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unbound_preparation_never_authenticates_and_can_bind_only_one_life() {
        let owner = PendingOwner::new();
        let check = owner.check();
        assert!((check.live)());
        assert!(!(check.helper)(std::process::id(), unsafe {
            libc::getuid()
        }));
        let life = ConnectionLife::new();
        life.state.store(READY, Ordering::Release);
        let identity = Identity::capture(std::process::id()).unwrap();
        assert!(owner.bind_parts(identity, &life));
        assert!(owner.bind_parts(identity, &life));
        let other = ConnectionLife::new();
        other.state.store(READY, Ordering::Release);
        assert!(!owner.bind_parts(identity, &other));
        life.state
            .store(crate::acp_client::lifecycle::CLOSING, Ordering::Release);
        assert!(!(check.live)());
        assert!(!owner.bind_parts(identity, &other));
    }
    #[test]
    fn expired_or_missing_process_cannot_be_revived_by_binding() {
        let owner = PendingOwner {
            bound: Arc::new(OnceLock::new()),
            deadline: Instant::now(),
        };
        let life = ConnectionLife::new();
        life.state.store(READY, Ordering::Release);
        let identity = Identity::capture(std::process::id()).unwrap();
        assert!(!(owner.check().live)());
        assert!(!owner.bind_parts(identity, &life));
        let owner = PendingOwner::new();
        assert!(owner.bind_parts(identity, &life));
        drop(life);
        assert!(!(owner.check().live)());
    }
}
