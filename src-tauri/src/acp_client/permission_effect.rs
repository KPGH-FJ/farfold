//! Reviewed effect facts and command routing for this existing connection only.
//! No Agent configuration or complete permission scope can be inferred here.
use agent_client_protocol::schema::v1::ContentBlock;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionEffect {
    config_id: &'static str,
    applies_at: &'static str,
    current_scope: &'static str,
}
impl PermissionEffect {
    pub(super) fn next_ordinary_prompt() -> Self {
        Self {
            config_id: "mode",
            applies_at: "next_ordinary_prompt",
            current_scope: "unknown",
        }
    }
}

/// ECMAScript WhiteSpace and LineTerminator, as used by the reviewed official
/// first-block parser. Rust's default differs for U+FEFF and U+0085.
fn js_space(value: char) -> bool {
    matches!(value,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// This covers only the reviewed commands, never certifies future commands.
/// The original blocks are inspected without being transformed or replaced.
pub(super) fn requires_current_scope(blocks: &[ContentBlock]) -> bool {
    let Some(ContentBlock::Text(first)) = blocks.first() else {
        return false;
    };
    let text = first.text.trim_matches(js_space);
    let Some(command) = text.strip_prefix('/') else {
        return false;
    };
    let command = command.trim_matches(js_space);
    let name = command.split(js_space).next().unwrap_or_default();
    if ["compact", "review", "review-branch", "review-commit"]
        .iter()
        .any(|known| name.eq_ignore_ascii_case(known))
    {
        return true;
    }
    if !name.eq_ignore_ascii_case("goal") {
        return false;
    }
    let argument = command[name.len()..].trim_matches(js_space);
    !argument.is_empty()
        && !argument.eq_ignore_ascii_case("pause")
        && !argument.eq_ignore_ascii_case("clear")
}
