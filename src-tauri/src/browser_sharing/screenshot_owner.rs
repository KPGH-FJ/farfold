//! One volatile screenshot request's withdrawal owner. This is never a standing
//! read grant. The worker keeps its receipt through actual helper delivery.
use super::{ShareState, ToolSession};
use crate::browser_workspace::FixedPageReadScope;
use std::sync::{Arc, Mutex, Weak};

pub(super) struct ActiveScreenshot {
    request_id: String,
    pub scope: FixedPageReadScope,
}

pub(super) struct ScreenshotRetirement {
    owner: Weak<ToolSession>,
    request_id: String,
    scope: FixedPageReadScope,
    confirmed: bool,
}

impl ScreenshotRetirement {
    pub(super) fn confirm(&mut self) {
        self.confirmed = true;
    }
}

pub(super) type Receipt = Arc<Mutex<Option<ScreenshotRetirement>>>;

impl ShareState {
    pub(super) fn approve_screenshot(
        &mut self,
        owner: Weak<ToolSession>,
        request_id: String,
        scope: &FixedPageReadScope,
    ) -> ScreenshotRetirement {
        debug_assert!(self.active_screenshot.is_none());
        self.active_screenshot = Some(ActiveScreenshot {
            request_id: request_id.clone(),
            scope: scope.clone(),
        });
        ScreenshotRetirement {
            owner,
            request_id,
            scope: scope.clone(),
            confirmed: false,
        }
    }

    pub(super) fn retire_screenshot(&mut self) {
        if let Some(active) = self.active_screenshot.take() {
            active.scope.cancel_action();
            // Retain uncertain stdout ownership using the existing stop owner.
            // This scope is never installed as a future page read grant.
            if self.retiring.is_none() {
                self.retiring = Some(active.scope);
            }
        }
    }

    pub(super) fn clear_screenshot(&mut self) {
        if let Some(active) = self.active_screenshot.take() {
            active.scope.cancel_action();
        }
    }
}

impl Drop for ScreenshotRetirement {
    fn drop(&mut self) {
        self.scope.cancel_action();
        if let Some(owner) = self.owner.upgrade() {
            let mut state = owner
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if state.active_screenshot.as_ref().is_some_and(|current| {
                current.request_id == self.request_id && current.scope.same_request(&self.scope)
            }) {
                if self.confirmed {
                    state.active_screenshot.take();
                } else {
                    // Losing a transport owner is not a receipt that already
                    // buffered bytes stopped. Reuse the existing retry owner.
                    state.retire_screenshot();
                    state.phase = super::STOP_FAILED;
                }
                state.revision = state.revision.saturating_add(1);
                drop(state);
                owner.changed();
            }
        }
    }
}
