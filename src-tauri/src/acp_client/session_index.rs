//! Session-index helpers: the `meta_store` session row id convention,
//! touch/upsert semantics, and small parsers shared by the session commands.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use crate::meta_store::{MetaStore, SessionRow};

pub(crate) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// Composite meta_store row id: `<agent_id>:<cwd>:<native_session_id>`.
pub(crate) fn session_row_id(agent_id: &str, cwd: &str, native_session_id: &str) -> String {
    format!("{agent_id}:{cwd}:{native_session_id}")
}

/// Create or refresh the index atomically. Automatic titles only fill an
/// empty title; explicit metadata rename remains authoritative. Supplied
/// config updates preserve current pin/archive and absent config keeps it.
pub(crate) fn touch_session_row(
    store: &MetaStore,
    agent_id: &str,
    cwd: &str,
    native_session_id: &str,
    title: Option<&str>,
    config_options: Option<Value>,
) -> Result<SessionRow, String> {
    let id = session_row_id(agent_id, cwd, native_session_id);
    let now = now_millis();
    store.touch_session(&SessionRow {
        id,
        agent_id: agent_id.to_string(),
        cwd: cwd.to_string(),
        native_session_id: Some(native_session_id.to_string()),
        title: title.map(str::to_string),
        config_options,
        pinned: false,
        archived: false,
        created_at: now,
        updated_at: now,
    })
}

/// Parse `YYYY-MM-DDTHH:MM:SS(.frac)?(Z|±HH:MM)` into epoch millis.
/// Returns `None` for anything else; callers fall back to stored timestamps.
pub(crate) fn iso8601_millis(input: &str) -> Option<i64> {
    let bytes = input.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if bytes[10] != b'T' && bytes[10] != b' ' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| input.get(range)?.parse::<i64>().ok();
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // days-from-civil (Howard Hinnant's algorithm).
    let adjusted_year = if month <= 2 { year - 1 } else { year };
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;

    let mut rest = &input[19..];
    let mut fraction_millis = 0i64;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits: String = fraction
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect();
        if digits.is_empty() {
            return None;
        }
        let padded = format!("{digits:0<3}");
        fraction_millis = padded[..3].parse().ok()?;
        rest = &fraction[digits.len()..];
    }
    let offset_seconds: i64 = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let (sign, body) = match rest.split_at(1) {
                ("+", body) => (1i64, body),
                ("-", body) => (-1i64, body),
                _ => return None,
            };
            let (hours, minutes) = body.split_once(':')?;
            let hours: i64 = hours.parse().ok()?;
            let minutes: i64 = minutes.parse().ok()?;
            sign * (hours * 3600 + minutes * 60)
        }
    };
    Some(
        days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + fraction_millis
            - offset_seconds * 1_000,
    )
}

/// `configOptions` command input is a `{configId: value}` object; a sorted
/// map keeps application order deterministic.
pub(crate) fn parse_config_map(
    config_options: Option<Value>,
) -> Result<Vec<(String, Value)>, String> {
    match config_options {
        None => Ok(Vec::new()),
        Some(Value::Object(map)) => Ok(map
            .into_iter()
            .collect::<BTreeMap<String, Value>>()
            .into_iter()
            .collect()),
        Some(_) => Err("configOptions must be an object of {configId: value}".to_string()),
    }
}

/// `session/list` rows carry a `cwd` string; compare canonically so symlinked
/// paths still merge with the canonical connection cwd.
pub(crate) fn same_dir(candidate: &str, canonical: &Path) -> bool {
    if candidate == canonical.to_string_lossy() {
        return true;
    }
    Path::new(candidate)
        .canonicalize()
        .is_ok_and(|path| path == canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::{Dispatch, UntypedMessage};

    fn store() -> MetaStore {
        let directory = tempfile::tempdir().expect("tempdir");
        MetaStore::open(&directory.path().join("farfold.sqlite3")).expect("open store")
    }

    #[test]
    fn session_row_id_is_composite() {
        assert_eq!(
            session_row_id("codex", "/tmp/proj", "ses_1"),
            "codex:/tmp/proj:ses_1"
        );
    }

    #[test]
    fn touch_creates_then_preserves_metadata() {
        let store = store();
        let row = touch_session_row(
            &store,
            "opencode",
            "/tmp/p",
            "ses_a",
            Some("first task"),
            None,
        )
        .unwrap();
        assert_eq!(row.title.as_deref(), Some("first task"));
        assert_eq!(row.id, "opencode:/tmp/p:ses_a");
        assert!(!row.pinned && !row.archived);

        let mut pinned = row.clone();
        pinned.pinned = true;
        store.upsert_session(&pinned).unwrap();

        // A later touch without title/config keeps title and flags, bumps time.
        let bumped = touch_session_row(&store, "opencode", "/tmp/p", "ses_a", None, None).unwrap();
        assert_eq!(bumped.title.as_deref(), Some("first task"));
        assert!(bumped.pinned);
        assert!(bumped.updated_at >= row.updated_at);

        // Neither an empty nor a later automatic title replaces a known title.
        let untouched =
            touch_session_row(&store, "opencode", "/tmp/p", "ses_a", Some("  "), None).unwrap();
        assert_eq!(untouched.title.as_deref(), Some("first task"));
        let later = touch_session_row(&store, "opencode", "/tmp/p", "ses_a", Some("renamed"), None)
            .unwrap();
        assert_eq!(later.title.as_deref(), Some("first task"));
    }

    #[test]
    fn touch_stores_config_options() {
        let store = store();
        let config = serde_json::json!({"model": "x"});
        let row =
            touch_session_row(&store, "codex", "/p", "s1", None, Some(config.clone())).unwrap();
        assert_eq!(row.config_options, Some(config));
        let kept = touch_session_row(&store, "codex", "/p", "s1", None, None).unwrap();
        assert_eq!(kept.config_options, row.config_options);
    }

    #[test]
    fn automatic_title_fills_empty_only_and_explicit_rename_remains_authoritative() {
        let store = store();
        let empty = touch_session_row(&store, "agent", "/p", "s", Some("  "), None).unwrap();
        assert!(empty.title.is_none());
        let first =
            touch_session_row(&store, "agent", "/p", "s", Some("First title"), None).unwrap();
        assert_eq!(first.title.as_deref(), Some("First title"));

        let mut explicit = first;
        explicit.title = Some("User title".into());
        store.upsert_session(&explicit).unwrap();
        let replay =
            touch_session_row(&store, "agent", "/p", "s", Some("Agent replay title"), None)
                .unwrap();
        assert_eq!(replay.title.as_deref(), Some("User title"));

        // A legacy blank string is also eligible for an initial title.
        explicit.title = Some("   ".into());
        store.upsert_session(&explicit).unwrap();
        let filled =
            touch_session_row(&store, "agent", "/p", "s", Some("Recovered title"), None).unwrap();
        assert_eq!(filled.title.as_deref(), Some("Recovered title"));
    }

    #[test]
    fn iso8601_parsing() {
        assert_eq!(iso8601_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            iso8601_millis("1970-01-01T01:00:00+01:00"),
            Some(0),
            "offset applies"
        );
        assert_eq!(iso8601_millis("1970-01-01T00:00:00.500Z"), Some(500));
        assert_eq!(
            iso8601_millis("2026-09-19T10:20:30Z"),
            Some(1_789_813_230_000)
        );
        assert_eq!(iso8601_millis("not a date"), None);
        assert_eq!(iso8601_millis("2026-09-19"), None);
        assert_eq!(iso8601_millis("2026-13-19T10:20:30Z"), None);
    }

    #[test]
    fn config_map_requires_object() {
        assert!(parse_config_map(None).unwrap().is_empty());
        let parsed =
            parse_config_map(Some(serde_json::json!({"model": "x", "mode": "y"}))).unwrap();
        assert_eq!(parsed.len(), 2);
        assert!(parse_config_map(Some(serde_json::json!(["a"]))).is_err());
    }

    #[test]
    fn session_scoped_id_detection() {
        let dispatch = Dispatch::<UntypedMessage>::Notification(
            UntypedMessage::new(
                "session/update",
                serde_json::json!({"sessionId": "s1", "update": {}}),
            )
            .unwrap(),
        );
        assert_eq!(
            dispatch
                .message()
                .and_then(|m| m.params().get("sessionId"))
                .and_then(Value::as_str),
            Some("s1")
        );
    }
}
