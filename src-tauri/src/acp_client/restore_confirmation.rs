//! Fixed classifications for explicit saved-selection confirmation only.
//! Never include an Agent error, identifier, selected value, or directory.
use super::wait::{self, ReplyFailure};
use std::time::Duration;
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Code {
    CwdInvalid,
    RouteUnavailable,
    ControlSend,
    WaitTimeout,
    WaitClosed,
    ReadOnly,
    Opening,
    ForkPending,
    IdentityRead,
    BusyBefore,
    Service,
    BusyAfter,
    Model,
    Delivery,
    SelectionInvalid,
    GuardNotReady,
    DisplayedChanged,
    OptionsInvalid,
    DeclarationMissing,
    DeclarationDuplicate,
    DeclarationType,
    DeclarationValue,
    DeclarationOptions,
    SelectedMissing,
    SelectedMismatch,
    NoProtectedSelection,
}

impl Code {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::CwdInvalid => "FARFOLD_RESTORE_CONFIRM_CWD_INVALID",
            Self::RouteUnavailable => "FARFOLD_RESTORE_CONFIRM_ROUTE_UNAVAILABLE",
            Self::ControlSend => "FARFOLD_RESTORE_CONFIRM_CONTROL_SEND",
            Self::WaitTimeout => "FARFOLD_RESTORE_CONFIRM_WAIT_TIMEOUT",
            Self::WaitClosed => "FARFOLD_RESTORE_CONFIRM_WAIT_CLOSED",
            Self::ReadOnly => "FARFOLD_RESTORE_CONFIRM_READ_ONLY",
            Self::Opening => "FARFOLD_RESTORE_CONFIRM_OPENING",
            Self::ForkPending => "FARFOLD_RESTORE_CONFIRM_FORK_PENDING",
            Self::IdentityRead => "FARFOLD_RESTORE_CONFIRM_IDENTITY_READ",
            Self::BusyBefore => "FARFOLD_RESTORE_CONFIRM_BUSY_BEFORE",
            Self::Service => "FARFOLD_RESTORE_CONFIRM_SERVICE",
            Self::BusyAfter => "FARFOLD_RESTORE_CONFIRM_BUSY_AFTER",
            Self::Model => "FARFOLD_RESTORE_CONFIRM_MODEL",
            Self::Delivery => "FARFOLD_RESTORE_CONFIRM_DELIVERY",
            Self::SelectionInvalid => "FARFOLD_RESTORE_CONFIRM_SELECTION_INVALID",
            Self::GuardNotReady => "FARFOLD_RESTORE_CONFIRM_GUARD_NOT_READY",
            Self::DisplayedChanged => "FARFOLD_RESTORE_CONFIRM_DISPLAYED_CHANGED",
            Self::OptionsInvalid => "FARFOLD_RESTORE_CONFIRM_OPTIONS_INVALID",
            Self::DeclarationMissing => "FARFOLD_RESTORE_CONFIRM_DECLARATION_MISSING",
            Self::DeclarationDuplicate => "FARFOLD_RESTORE_CONFIRM_DECLARATION_DUPLICATE",
            Self::DeclarationType => "FARFOLD_RESTORE_CONFIRM_DECLARATION_TYPE",
            Self::DeclarationValue => "FARFOLD_RESTORE_CONFIRM_DECLARATION_VALUE",
            Self::DeclarationOptions => "FARFOLD_RESTORE_CONFIRM_DECLARATION_OPTIONS",
            Self::SelectedMissing => "FARFOLD_RESTORE_CONFIRM_SELECTED_MISSING",
            Self::SelectedMismatch => "FARFOLD_RESTORE_CONFIRM_SELECTED_MISMATCH",
            Self::NoProtectedSelection => "FARFOLD_RESTORE_CONFIRM_NO_PROTECTED_SELECTION",
        }
    }

    /// Manual confirmation retains its existing error text and behavior.
    pub(crate) fn for_restore(self, restore: bool, fallback: String) -> String {
        if restore { self.into() } else { fallback }
    }
}

impl From<Code> for String {
    fn from(code: Code) -> Self {
        code.as_str().to_owned()
    }
}

pub(crate) async fn reply<T>(
    receive: oneshot::Receiver<T>,
    duration: Duration,
    restore: bool,
) -> Result<T, String> {
    if !restore {
        return wait::reply(receive, duration, "confirm config").await;
    }
    wait::reply_typed(receive, duration)
        .await
        .map_err(|failure| match failure {
            ReplyFailure::Timeout => Code::WaitTimeout.into(),
            ReplyFailure::Closed => Code::WaitClosed.into(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_discards_private_errors_only_for_saved_selection() {
        let private = "PRIVATE_ACCOUNT_KEY_MODEL_DIRECTORY_CANARY";
        assert_eq!(
            Code::RouteUnavailable.for_restore(true, private.into()),
            "FARFOLD_RESTORE_CONFIRM_ROUTE_UNAVAILABLE"
        );
        assert_eq!(
            Code::RouteUnavailable.for_restore(false, private.into()),
            private
        );
    }

    #[tokio::test]
    async fn confirmation_wait_preserves_inner_reply_and_manual_wait_errors() {
        for restore in [false, true] {
            let (send, receive) = oneshot::channel();
            send.send(Err::<(), _>(Code::DisplayedChanged.into()))
                .unwrap();
            assert_eq!(
                reply(receive, Duration::from_secs(1), restore).await,
                Ok(Err::<(), String>(Code::DisplayedChanged.into()))
            );
            let (send, receive) = oneshot::channel::<()>();
            drop(send);
            assert_eq!(
                reply(receive, Duration::from_secs(1), restore).await,
                Err(if restore {
                    Code::WaitClosed.into()
                } else {
                    "confirm config 通道已关闭".into()
                })
            );
            let (_send, receive) = oneshot::channel::<()>();
            assert_eq!(
                reply(receive, Duration::ZERO, restore).await,
                Err(if restore {
                    Code::WaitTimeout.into()
                } else {
                    "confirm config：Agent 无响应（超时）".into()
                })
            );
        }
    }
}
