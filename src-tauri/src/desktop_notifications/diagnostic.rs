//! One volatile, content-free submission snapshot. Private matching never serializes.
use super::{Permission, SystemSettings};
use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Stage {
    Backend,
    Native,
    Add,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Reason {
    Checking,
    InvalidAttempt,
    Duplicate,
    ClaimUnavailable,
    ChangeBusy,
    PreferenceChanged,
    PreferenceOff,
    PreferenceUnreadable,
    MainWindowMissing,
    WindowQueryFailed,
    WindowFocused,
    TargetMissing,
    TargetLookupFailed,
    TargetUnconfirmed,
    SystemNotAllowed,
    SystemReadFailed,
    NativeUnavailable,
    NativeStartFailed,
    MainThreadUnavailable,
    PayloadUnavailable,
    AddPending,
    AddAccepted,
    AddRejected,
    AddUnconfirmed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AddResult {
    NotStarted,
    Accepted,
    Rejected,
    Unconfirmed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ErrorDomain {
    UserNotifications,
    Cocoa,
    Posix,
    OsStatus,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Presentation {
    NotObserved,
    SuppressedActive,
    BannerList,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticSnapshot {
    pub(crate) stage: Stage,
    pub(crate) reason: Reason,
    pub(crate) window_visible: Option<bool>,
    pub(crate) window_focused: Option<bool>,
    pub(crate) system_permission: Option<Permission>,
    pub(crate) system_alert: Option<bool>,
    pub(crate) system_sound: Option<bool>,
    pub(crate) sound_requested: Option<bool>,
    pub(crate) native_initialized: Option<bool>,
    pub(crate) delegate_matches: Option<bool>,
    pub(crate) bundle_matches: Option<bool>,
    pub(crate) app_active: Option<bool>,
    pub(crate) add_result: AddResult,
    pub(crate) error_domain: Option<ErrorDomain>,
    pub(crate) error_code: Option<i32>,
    pub(crate) presentation: Presentation,
    pub(crate) clicked: bool,
}
impl Default for DiagnosticSnapshot {
    fn default() -> Self {
        Self {
            stage: Stage::Backend,
            reason: Reason::Checking,
            window_visible: None,
            window_focused: None,
            system_permission: None,
            system_alert: None,
            system_sound: None,
            sound_requested: None,
            native_initialized: None,
            delegate_matches: None,
            bundle_matches: None,
            app_active: None,
            add_result: AddResult::NotStarted,
            error_domain: None,
            error_code: None,
            presentation: Presentation::NotObserved,
            clicked: false,
        }
    }
}
impl DiagnosticSnapshot {
    pub(super) fn stop(&mut self, stage: Stage, reason: Reason) {
        self.stage = stage;
        self.reason = reason;
    }
    pub(super) fn system(&mut self, system: SystemSettings) {
        self.system_permission = Some(system.permission);
        self.system_alert = system.system_alert;
        self.system_sound = system.system_sound;
    }
    pub(super) fn add(&mut self, result: AddResult) {
        self.add_result = result;
        self.stop(
            Stage::Add,
            match result {
                AddResult::NotStarted => Reason::AddPending,
                AddResult::Accepted => Reason::AddAccepted,
                AddResult::Rejected => Reason::AddRejected,
                AddResult::Unconfirmed => Reason::AddUnconfirmed,
            },
        );
    }
    pub(super) fn unconfirmed(&mut self) {
        // A timer/channel race cannot erase an actual add completion or a
        // known gate refusal. This does not change the caller's original error.
        if self.add_result == AddResult::NotStarted
            && matches!(self.reason, Reason::Checking | Reason::AddPending)
        {
            self.add(AddResult::Unconfirmed);
        }
    }
    pub(super) fn bridge_start_failed(&mut self) {
        if !matches!(self.add_result, AddResult::Accepted | AddResult::Rejected) {
            self.add_result = AddResult::NotStarted;
            if matches!(self.reason, Reason::Checking | Reason::AddPending) {
                self.stop(Stage::Native, Reason::NativeStartFailed);
            }
        }
    }
    #[allow(clippy::too_many_arguments)] // Exact fixed-field Objective-C callback ABI.
    pub(super) fn native_event(
        &mut self,
        event: i32,
        initialized: bool,
        delegate_matches: bool,
        bundle_matches: bool,
        active: bool,
        domain: i32,
        code: i64,
    ) {
        match event {
            0 => {
                self.native_initialized = Some(initialized);
                self.delegate_matches = Some(delegate_matches);
                self.bundle_matches = Some(bundle_matches);
                self.app_active = Some(active);
                self.stop(Stage::Native, Reason::AddPending);
            }
            1 => self.add(AddResult::Accepted),
            2 => {
                self.add(AddResult::Rejected);
                self.error_domain = Some(match domain {
                    1 => ErrorDomain::UserNotifications,
                    2 => ErrorDomain::Cocoa,
                    3 => ErrorDomain::Posix,
                    4 => ErrorDomain::OsStatus,
                    _ => ErrorDomain::Other,
                });
                self.error_code = if (1..=4).contains(&domain) {
                    i32::try_from(code)
                        .ok()
                        .filter(|c| c.abs_diff(0) <= 1_000_000)
                } else {
                    None
                };
            }
            3 => self.presentation = Presentation::SuppressedActive,
            4 => self.presentation = Presentation::BannerList,
            5 => self.clicked = true,
            6 => self.stop(Stage::Native, Reason::NativeUnavailable),
            7 => self.stop(Stage::Native, Reason::PayloadUnavailable),
            _ => {}
        }
    }
}

#[derive(Clone)]
pub(super) struct Attempt(Arc<()>);
struct LastRecord {
    attempt: Attempt,
    renderer: Option<String>,
    sequence: u64,
    notice: Option<String>,
    snapshot: DiagnosticSnapshot,
}
#[derive(Default)]
pub(super) struct DiagnosticStore(Mutex<Option<LastRecord>>);
pub(super) fn valid_renderer(renderer: &str) -> bool {
    renderer.len() == 32
        && renderer
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl DiagnosticStore {
    pub(super) fn begin(&self, renderer: &str, sequence: u64) -> Attempt {
        let attempt = Attempt(Arc::new(()));
        if let Ok(mut last) = self.0.lock() {
            *last = Some(LastRecord {
                attempt: attempt.clone(),
                renderer: valid_renderer(renderer).then(|| renderer.to_owned()),
                sequence,
                notice: None,
                snapshot: DiagnosticSnapshot::default(),
            });
        }
        attempt
    }
    pub(super) fn update(&self, attempt: &Attempt, change: impl FnOnce(&mut DiagnosticSnapshot)) {
        if let Ok(mut last) = self.0.lock()
            && let Some(record) = last.as_mut()
            && Arc::ptr_eq(&record.attempt.0, &attempt.0)
        {
            change(&mut record.snapshot);
        }
    }
    pub(super) fn attach_notice(&self, attempt: &Attempt, notice: &str) {
        if let Ok(mut last) = self.0.lock()
            && let Some(record) = last.as_mut()
            && Arc::ptr_eq(&record.attempt.0, &attempt.0)
        {
            record.notice = Some(notice.to_owned());
        }
    }
    pub(super) fn observe_notice(
        &self,
        notice: &str,
        change: impl FnOnce(&mut DiagnosticSnapshot),
    ) {
        if let Ok(mut last) = self.0.lock()
            && let Some(record) = last.as_mut()
            && record.notice.as_deref() == Some(notice)
        {
            change(&mut record.snapshot);
        }
    }
    pub(super) fn for_attempt(&self, renderer: &str, sequence: u64) -> Option<DiagnosticSnapshot> {
        let last = self.0.lock().ok()?;
        let record = last.as_ref()?;
        (record.renderer.as_deref() == Some(renderer) && record.sequence == sequence)
            .then(|| record.snapshot.clone())
    }
}

/// Equivalent to the existing window gate, including allowing a hidden window
/// even if its independent focus query failed. None never means false.
pub(super) fn window_gate(visible: Option<bool>, focused: Option<bool>) -> Result<(), Reason> {
    match (visible, focused) {
        (Some(false), _) | (Some(true), Some(false)) => Ok(()),
        (Some(true), Some(true)) => Err(Reason::WindowFocused),
        _ => Err(Reason::WindowQueryFailed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const RENDERER: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn replacement_discards_old_callbacks_even_when_the_same_key_is_reused() {
        let store = DiagnosticStore::default();
        let old = store.begin(RENDERER, 1);
        store.attach_notice(&old, "owned-old-notice");
        let new = store.begin(RENDERER, 1);
        store.update(&new, |d| d.stop(Stage::Backend, Reason::Duplicate));
        store.update(&old, |d| d.add(AddResult::Accepted));
        store.observe_notice("owned-old-notice", |d| d.clicked = true);
        let current = store.for_attempt(RENDERER, 1).unwrap();
        assert_eq!(current.reason, Reason::Duplicate);
        assert_eq!(current.add_result, AddResult::NotStarted);
        assert!(!current.clicked);
        assert!(store.for_attempt(RENDERER, 2).is_none());
        assert!(
            store
                .for_attempt("abcdef0123456789abcdef0123456789", 1)
                .is_none()
        );
    }

    #[test]
    fn native_observations_match_only_the_current_notice_and_never_claim_delivery() {
        let store = DiagnosticStore::default();
        let attempt = store.begin(RENDERER, 2);
        store.attach_notice(&attempt, "owned-current-notice");
        store.observe_notice("owned-other-notice", |d| d.add(AddResult::Accepted));
        store.observe_notice("owned-current-notice", |d| {
            d.native_event(0, true, false, true, false, 0, 0);
            d.native_event(1, false, false, false, false, 0, 0);
        });
        let current = store.for_attempt(RENDERER, 2).unwrap();
        assert_eq!(current.native_initialized, Some(true));
        assert_eq!(current.delegate_matches, Some(false));
        assert_eq!(current.app_active, Some(false));
        assert_eq!(current.add_result, AddResult::Accepted);
        assert_eq!(current.presentation, Presentation::NotObserved);
        store.observe_notice("owned-current-notice", |d| {
            d.native_event(3, false, false, false, false, 0, 0);
            d.native_event(5, false, false, false, false, 0, 0);
        });
        let current = store.for_attempt(RENDERER, 2).unwrap();
        assert_eq!(current.presentation, Presentation::SuppressedActive);
        assert!(current.clicked);
        let serialized = serde_json::to_string(&current).unwrap();
        for private in [
            RENDERER,
            "owned-current-notice",
            "renderer",
            "sequence",
            "notice",
            "delivered",
        ] {
            assert!(!serialized.contains(private));
        }
    }

    #[test]
    fn error_codes_are_finite_and_only_allowlisted_domains_survive() {
        let mut d = DiagnosticSnapshot::default();
        d.native_event(2, false, false, false, false, 1, 1);
        assert_eq!(d.error_domain, Some(ErrorDomain::UserNotifications));
        assert_eq!(d.error_code, Some(1));
        for code in [i64::MIN, -1_000_001, 1_000_001, i64::MAX] {
            d.native_event(2, false, false, false, false, 2, code);
            assert!(d.error_code.is_none());
        }
        d.native_event(2, false, false, false, false, 999, 123);
        assert_eq!(d.error_domain, Some(ErrorDomain::Other));
        assert!(d.error_code.is_none());
        let before = serde_json::to_value(&d).unwrap();
        d.native_event(999, true, true, true, true, 1, 999);
        assert_eq!(serde_json::to_value(&d).unwrap(), before);
    }

    #[test]
    fn missing_receipts_do_not_erase_actual_callbacks_or_known_gate_refusals() {
        let mut d = DiagnosticSnapshot::default();
        d.unconfirmed();
        assert_eq!(d.add_result, AddResult::Unconfirmed);
        d.native_event(1, false, false, false, false, 0, 0);
        d.unconfirmed();
        assert_eq!(d.add_result, AddResult::Accepted);
        assert_eq!(d.reason, Reason::AddAccepted);
        d.native_event(2, false, false, false, false, 1, 1);
        d.unconfirmed();
        assert_eq!(d.add_result, AddResult::Rejected);
        let mut gate = DiagnosticSnapshot::default();
        gate.stop(Stage::Native, Reason::WindowFocused);
        gate.unconfirmed();
        assert_eq!(gate.reason, Reason::WindowFocused);
        assert_eq!(gate.add_result, AddResult::NotStarted);
    }

    #[test]
    fn local_start_failure_without_an_os_callback_is_not_an_add_rejection() {
        let mut local = DiagnosticSnapshot::default();
        local.native_event(0, true, true, true, false, 0, 0);
        local.native_event(7, false, false, false, false, 0, 0);
        local.bridge_start_failed();
        assert_eq!(local.add_result, AddResult::NotStarted);
        assert_eq!(local.reason, Reason::PayloadUnavailable);
        assert!(local.error_domain.is_none());
        let mut generic = DiagnosticSnapshot::default();
        generic.native_event(0, true, true, true, false, 0, 0);
        generic.bridge_start_failed();
        assert_eq!(generic.add_result, AddResult::NotStarted);
        assert_eq!(generic.reason, Reason::NativeStartFailed);
        let mut unavailable = DiagnosticSnapshot::default();
        unavailable.native_event(6, false, false, false, false, 0, 0);
        unavailable.bridge_start_failed();
        assert_eq!(unavailable.reason, Reason::NativeUnavailable);
        let mut rejected = DiagnosticSnapshot::default();
        rejected.native_event(2, false, false, false, false, 1, 1);
        rejected.bridge_start_failed();
        assert_eq!(rejected.add_result, AddResult::Rejected);
        assert_eq!(rejected.error_domain, Some(ErrorDomain::UserNotifications));
        assert_eq!(rejected.error_code, Some(1));
        assert_eq!(rejected.reason, Reason::AddRejected);
    }

    #[test]
    fn window_diagnostics_preserve_all_original_foreground_gate_combinations() {
        for visible in [None, Some(false), Some(true)] {
            for focused in [None, Some(false), Some(true)] {
                assert_eq!(
                    window_gate(visible, focused).is_ok(),
                    matches!(
                        (visible, focused),
                        (Some(false), _) | (Some(true), Some(false))
                    )
                );
            }
        }
    }
}
