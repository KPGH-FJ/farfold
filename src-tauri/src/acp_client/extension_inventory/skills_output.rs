//! Only bounded display metadata leaves the private official response decoder.
use super::{output, types::*};
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
pub(super) struct Wire {
    data: Vec<Entry>,
}
#[derive(Deserialize)]
struct Entry {
    cwd: String,
    skills: Vec<Skill>,
    errors: Vec<ReadError>,
}
#[derive(Deserialize)]
struct ReadError {
    // Validate the official error shape without preserving its private details.
    #[serde(rename = "path")]
    _path: String,
    #[serde(rename = "message")]
    _message: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Skill {
    name: String,
    description: String,
    short_description: Option<String>,
    interface: Option<Interface>,
    path: String,
    scope: String,
    enabled: bool,
    plugin_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Interface {
    short_description: Option<String>,
}
fn safe_skill_name(name: &str) -> Option<String> {
    let Some((namespace, skill)) = name.split_once(':') else {
        return output::safe_name(name);
    };
    // Official plugin names are namespace:skill, not URLs or arbitrary headers.
    (name.len() <= 256
        && [namespace, skill]
            .iter()
            .all(|part| !part.contains(' ') && output::safe_name(part).is_some()))
    .then(|| name.to_owned())
}
fn forbidden_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
}
fn sensitive_token(token: &str) -> bool {
    let token = token.trim_matches(|c: char| {
        matches!(
            c,
            '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | '`' | ',' | ';'
        )
    });
    let lower = token.to_ascii_lowercase();
    token.contains("://")
        || token.starts_with('/')
        || token.starts_with("~/")
        || token.contains("\\")
        || token.contains("@")
        || lower.starts_with("sk-")
        || [
            "token=",
            "key=",
            "secret=",
            "password=",
            "authorization=",
            "apikey=",
            "api_key=",
        ]
        .iter()
        .any(|s| lower.contains(s))
}
/// Plain prose is data, never a prompt. This does not prove arbitrary text secret-free.
fn description(value: &str, path: &str) -> (Option<String>, bool, bool) {
    let mut redacted = false;
    let without_path = if !path.is_empty() && value.contains(path) {
        redacted = true;
        value.replace(path, "[已隐藏]")
    } else {
        value.to_owned()
    };
    let clean: String = without_path
        .chars()
        .map(|c| {
            if forbidden_char(c) {
                redacted = true;
                ' '
            } else {
                c
            }
        })
        .collect();
    let mut hide_next = false;
    let mut words = Vec::new();
    for word in clean.split_whitespace() {
        let lower = word
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_ascii_lowercase();
        let label = [
            "bearer",
            "token",
            "password",
            "secret",
            "api_key",
            "apikey",
            "authorization",
        ]
        .contains(&lower.as_str());
        if hide_next || sensitive_token(word) {
            words.push("[已隐藏]");
            redacted = true;
        } else {
            words.push(word);
        }
        // A separately tokenized assignment separator is not the secret value.
        hide_next = label || (hide_next && matches!(word, "=" | ":"));
    }
    let joined = words.join(" ");
    let mut output = String::new();
    let mut truncated = false;
    for (index, c) in joined.chars().enumerate() {
        if index >= 2048 || output.len() + c.len_utf8() > 8192 {
            truncated = true;
            break;
        }
        output.push(c);
    }
    ((!output.is_empty()).then_some(output), truncated, redacted)
}
impl Wire {
    pub(super) fn project(self, cwd: &str) -> Result<SkillsInventory> {
        if self.data.len() != 1 {
            return Err(Code::InvalidOutput.into());
        }
        let entry = self.data.into_iter().next().ok_or(Code::InvalidOutput)?;
        if entry.cwd != cwd {
            return Err(Code::InvalidOutput.into());
        }
        if entry.skills.len() > 512 || entry.errors.len() > 512 {
            return Err(Code::OutputLimit.into());
        }
        let mut items = Vec::with_capacity(entry.skills.len());
        for (id, skill) in entry.skills.into_iter().enumerate() {
            if !std::path::Path::new(&skill.path).is_absolute()
                || skill.path.len() > 4096
                || skill.path.chars().any(forbidden_char)
            {
                return Err(Code::InvalidOutput.into());
            }
            let brief = skill
                .interface
                .as_ref()
                .and_then(|v| v.short_description.as_deref())
                .filter(|s| !s.trim().is_empty())
                .or(skill
                    .short_description
                    .as_deref()
                    .filter(|s| !s.trim().is_empty()))
                .unwrap_or(&skill.description);
            let (description, description_truncated, description_redacted) =
                description(brief, &skill.path);
            items.push(SkillInventoryItem {
                id,
                name: safe_skill_name(&skill.name),
                description,
                description_truncated,
                description_redacted,
                reported_enabled: skill.enabled,
                origin: match skill.scope.as_str() {
                    "user" => "user",
                    "repo" => "repo",
                    "system" => "system",
                    "admin" => "admin",
                    _ => "unknown",
                },
                plugin_reported: skill.plugin_id.as_ref().is_some_and(|s| !s.is_empty()),
            });
        }
        Ok(SkillsInventory {
            observed_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis().min(9_007_199_254_740_991) as u64)
                .unwrap_or_default(),
            scope: "officialSkillsForDirectory",
            source: "officialAppServer",
            complete: entry.errors.is_empty(),
            session_applicability: "unverified",
            error_count: entry.errors.len(),
            items,
        })
    }
}
#[cfg(test)]
pub(super) fn parse(bytes: &[u8], cwd: &str) -> Result<SkillsInventory> {
    if bytes.len() > output::STDOUT_LIMIT {
        return Err(Code::OutputLimit.into());
    }
    if !output::bounded_depth(bytes) {
        return Err(Code::InvalidOutput.into());
    }
    serde_json::from_slice::<Wire>(bytes)
        .map_err(|_| Failure::from(Code::InvalidOutput))?
        .project(cwd)
}
