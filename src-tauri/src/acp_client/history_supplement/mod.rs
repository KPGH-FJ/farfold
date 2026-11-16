//! One opening's optional official history read. No persisted history or Agent loop.
mod events;
mod launch;
mod parser;
mod runner;
mod source;
mod strict_json;
mod types;
pub(super) use events::{event, reserved_kind};
pub(super) use parser::parse;
pub(super) use runner::read;
pub(crate) use source::Source;
pub(super) use types::*;
#[cfg(test)]
mod launch_tests;
#[cfg(test)]
mod tests;

#[cfg(all(test, target_os = "macos"))]
mod runner_tests;
#[cfg(all(test, target_os = "macos"))]
mod wire_tests;
