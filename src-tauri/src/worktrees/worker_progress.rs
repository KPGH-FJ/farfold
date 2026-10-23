//! One flag on the EXISTING working owner, never a work registry or event log.
//! Native retirement reports cannot take the manager/database lock.
use super::*;
use std::{cell::RefCell, marker::PhantomData, rc::Rc, sync::Weak};

thread_local! {
    static CURRENT: RefCell<Option<Weak<AtomicBool>>> = const { RefCell::new(None) };
}

#[derive(Clone)]
pub(super) struct Working {
    pub(super) id: String,
    pub(super) cancel: Arc<AtomicBool>,
    unknown: Arc<AtomicBool>,
}
impl Working {
    pub(super) fn new(id: &str, cancel: Arc<AtomicBool>) -> Self {
        Self {
            id: id.to_owned(),
            cancel,
            unknown: Arc::new(AtomicBool::new(false)),
        }
    }
    pub(super) fn scope(&self) -> Scope {
        let previous = CURRENT.with(|value| value.replace(Some(Arc::downgrade(&self.unknown))));
        Scope {
            previous,
            _same_thread: PhantomData,
        }
    }
    fn uncertain(&self) -> bool {
        self.unknown.load(Ordering::Acquire)
    }
}
pub(super) struct Scope {
    previous: Option<Weak<AtomicBool>>,
    _same_thread: PhantomData<Rc<()>>,
}
impl Drop for Scope {
    fn drop(&mut self) {
        CURRENT.with(|value| value.replace(self.previous.take()));
    }
}
#[cfg(any(windows, test))]
pub(in crate::worktrees) fn mark_unknown() {
    CURRENT.with(|value| {
        if let Some(original) = value.borrow().as_ref().and_then(Weak::upgrade) {
            original.store(true, Ordering::Release);
        }
    });
}
impl Inner {
    pub(super) fn visible_status(&self, value: &Operation) -> Operation {
        let mut reply = value.clone();
        if self
            .working
            .as_ref()
            .is_some_and(|owner| owner.id == value.operation_id && owner.uncertain())
        {
            reply.state = "unknown".into();
            reply.settled = false;
            reply.reviewed = false;
            reply.code = Some("unknown".into());
        }
        reply
    }
}

#[cfg(test)]
#[path = "worker_progress_tests.rs"]
mod tests;
