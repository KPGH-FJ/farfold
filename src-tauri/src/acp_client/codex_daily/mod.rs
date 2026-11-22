//! Official zero-send ownership for the explicitly authorized, separate Codex profile.
#[cfg(target_os = "macos")]
mod owner;
#[cfg(target_os = "macos")]
mod transport;
#[cfg(any(target_os = "macos", test))]
mod wire;

use crate::meta_store::AgentRow;
use serde::Serialize;

pub(super) const PURPOSE: &str = "codex-official-check";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    id: &'static str,
    model_option_id: &'static str,
    reasoning_option_id: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAccess {
    kind: &'static str,
    receipt: Receipt,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    account_verified: bool,
    provider: &'static str,
    file_access: &'static str,
    tool_network: bool,
    approval: &'static str,
    model: String,
    effort: String,
}

pub(super) fn descriptor(row: &AgentRow, data: &std::path::Path) -> Option<Descriptor> {
    #[cfg(target_os = "macos")]
    if transport::ready(row, data) {
        return Some(Descriptor {
            id: PURPOSE,
            model_option_id: "model",
            reasoning_option_id: "reasoning_effort",
        });
    }
    let _ = (row, data);
    None
}

#[cfg(target_os = "macos")]
pub(super) use owner::{OpenRequest, open};
