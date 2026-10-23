//! The relay owns stdout and closes it before acknowledging partial-output stop.
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
pub(super) use unix::*;
#[cfg(windows)]
pub(super) use windows::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum InputStop {
    Clear,
    Pending,
    Dirty,
}
