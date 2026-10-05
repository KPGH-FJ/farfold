//! Private local helper channel. The Agent still receives only MCP stdio.
use std::path::PathBuf;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
pub(crate) use unix::*;
#[cfg(windows)]
pub(crate) use windows::*;
pub(crate) struct Endpoint {
    pub guard: Guard,
    pub listener: Listener,
    pub path: PathBuf,
    pub name: String,
}
