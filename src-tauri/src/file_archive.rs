//! Explicit portable exports; private RAM input, never an Agent history store.
pub(crate) mod input;
pub(crate) mod manifest;
pub(crate) mod types;
pub(crate) use types::*;

#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
mod writer_tests;
