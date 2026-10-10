//! Only metadata and saved-input admission; never changes historical cwd.
use super::*;
use crate::worktrees::{DraftBaseline, RecycleImpact};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

// Resolve the closest existing ancestor, so a not-yet-created attachment leaf
// below a symlink is still related. Ambiguous traversal is never normalized away.
fn inside(value: &str, root: &Path) -> Result<bool, String> {
    let value = if value.starts_with("file:") {
        tauri::Url::parse(value)
            .ok()
            .and_then(|u| u.to_file_path().ok())
            .ok_or("unknownDrafts")?
    } else {
        PathBuf::from(value)
    };
    if !value.is_absolute() {
        return Err("unknownDrafts".into());
    }
    if value
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("unknownDrafts".into());
    }
    if value.starts_with(root) {
        return Ok(true);
    }
    let mut cursor = value.as_path();
    let mut suffix = Vec::new();
    loop {
        match cursor.canonicalize() {
            Ok(mut p) => {
                for s in suffix.iter().rev() {
                    p.push(s);
                }
                return Ok(p.starts_with(root));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(cursor.file_name().ok_or("unknownDrafts")?.to_os_string());
                cursor = cursor.parent().ok_or("unknownDrafts")?;
            }
            Err(_) => return Err("unknownDrafts".into()),
        }
    }
}
fn any_inside(value: &str, roots: &[&Path]) -> Result<bool, String> {
    for root in roots {
        if inside(value, root)? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn paths(
    value: &serde_json::Value,
    roots: &[&Path],
    depth: usize,
    budget: &mut usize,
) -> Result<bool, String> {
    if depth > 64 || *budget == 0 {
        return Err("unknownDrafts".into());
    }
    *budget -= 1;
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if matches!(k.as_str(), "cwd" | "path" | "root" | "resolvedPath" | "uri") {
                    if let Some(s) = v.as_str() {
                        if (Path::new(s).is_absolute() || s.starts_with("file:"))
                            && any_inside(s, roots)?
                        {
                            return Ok(true);
                        }
                    } else if !v.is_null() {
                        return Err("unknownDrafts".into());
                    }
                }
                if paths(v, roots, depth + 1, budget)? {
                    return Ok(true);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for v in items {
                if paths(v, roots, depth + 1, budget)? {
                    return Ok(true);
                }
            }
        }
        _ => {}
    }
    Ok(false)
}
fn nonempty(d: &serde_json::Value) -> Result<bool, String> {
    let m = d.as_object().ok_or("unknownDrafts")?;
    Ok(!m
        .get("text")
        .and_then(serde_json::Value::as_str)
        .ok_or("unknownDrafts")?
        .trim()
        .is_empty()
        || !m
            .get("attachments")
            .and_then(serde_json::Value::as_array)
            .ok_or("unknownDrafts")?
            .is_empty()
        || m.get("sendPending") == Some(&serde_json::Value::Bool(true))
        || m.get("pendingConversation").is_some_and(|v| !v.is_null())
        || m.get("queueEdit").is_some_and(|v| !v.is_null()))
}
impl MetaStore {
    pub(crate) fn worktree_impact(
        &self,
        roots: &[&Path],
    ) -> Result<(DraftBaseline, RecycleImpact), String> {
        let (baseline, raw) = self.worktree_draft_baseline()?;
        let rows = {
            let c = self.lock()?;
            let mut q=c.prepare("SELECT id, agent_id, cwd, native_session_id, title, config_options, pinned, archived, created_at, updated_at FROM sessions LIMIT 10001").map_err(sqlite_receipt)?;
            q.query_map([], row_to_session)
                .map_err(sqlite_receipt)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_receipt)?
        };
        if rows.len() > 10000 {
            return Err("unknownDrafts".into());
        }
        let saved = raw[0]
            .as_ref()
            .map(|s| {
                serde_json::from_str::<serde_json::Value>(s).map_err(|_| "unknownDrafts".to_owned())
            })
            .transpose()?;
        let mut affected = 0;
        let mut known = HashSet::new();
        let mut known_rows = HashSet::new();
        let mut blocked = false;
        for row in &rows {
            known_rows.insert(row.id.clone());
            for p in ["session:", "queue-edit:", "resend:"] {
                known.insert(format!("{p}{}", row.id));
            }
            if any_inside(&row.cwd, roots)? {
                affected += 1;
                if let Some(v) = &saved {
                    blocked |=
                        super::archive::has_unsent_work(v, row).map_err(|_| "unknownDrafts")?;
                    if let (Ok(cwd), Some(native)) =
                        (Path::new(&row.cwd).canonicalize(), &row.native_session_id)
                    {
                        let mut alias = row.clone();
                        alias.cwd = cwd.to_string_lossy().into_owned();
                        alias.id = crate::acp_client::session_index::session_row_id(
                            &row.agent_id,
                            &alias.cwd,
                            native,
                        );
                        known_rows.insert(alias.id.clone());
                        blocked |= super::archive::has_unsent_work(v, &alias)
                            .map_err(|_| "unknownDrafts")?;
                        for p in ["session:", "queue-edit:", "resend:"] {
                            known.insert(format!("{p}{}", alias.id));
                        }
                    }
                }
            }
        }
        if let Some(v) = &saved {
            if v["version"] != 1 {
                return Err("unknownDrafts".into());
            }
            let composers = v["composers"].as_object().ok_or("unknownDrafts")?;
            let feedback = v["feedback"].as_object().ok_or("unknownDrafts")?;
            let queues = v["queues"].as_object().ok_or("unknownDrafts")?;
            let mut budget = 200000;
            for (key, d) in composers {
                if nonempty(d)? {
                    blocked |= paths(d, roots, 0, &mut budget)?;
                    if !known.contains(key) {
                        let choice = if key == "new" {
                            v.get("choice")
                        } else if key.starts_with("saved-new:") {
                            d.get("savedChoice")
                        } else {
                            None
                        };
                        match choice.and_then(|v| v["cwd"].as_str()) {
                            Some(cwd) => blocked |= any_inside(cwd, roots)?,
                            None => return Err("unknownDrafts".into()),
                        }
                    }
                }
            }
            for (owner, files) in feedback {
                for (legacy, d) in files.as_object().ok_or("unknownDrafts")? {
                    if !d["text"].as_str().ok_or("unknownDrafts")?.trim().is_empty() {
                        if !known_rows.contains(owner) {
                            return Err("unknownDrafts".into());
                        }
                        blocked |= paths(d, roots, 0, &mut budget)?;
                        if Path::new(legacy).is_absolute() {
                            blocked |= any_inside(legacy, roots)?;
                        }
                    }
                }
            }
            for (owner, q) in queues {
                let blocks = q["blocks"].as_array().ok_or("unknownDrafts")?;
                if (!blocks.is_empty() || q.get("uncertainIndex").is_some_and(|v| !v.is_null()))
                    && !known_rows.contains(owner)
                {
                    return Err("unknownDrafts".into());
                }
                blocked |= paths(q, roots, 0, &mut budget)?;
            }
        }
        Ok((
            baseline,
            RecycleImpact {
                conversations: affected,
                unsent: blocked,
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn related_alias_subdirectory_drafts_and_cross_conversation_files_block_without_changing_bytes()
    {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("owned");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let root = root.canonicalize().unwrap();
        let alias = d.path().join("alias");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        #[cfg(not(unix))]
        let alias = root.clone();
        let s = MetaStore::open(&d.path().join("meta.db")).unwrap();
        let row = crate::acp_client::session_index::touch_session_row(
            &s,
            "fixture",
            alias.join("sub").to_str().unwrap(),
            "n",
            None,
            None,
        )
        .unwrap();
        let cases = [
            json!({"version":1,"composers":{format!("session:{}",row.id):{"text":"unsent","attachments":[]}},"feedback":{},"queues":{}}),
            json!({"version":1,"composers":{},"feedback":{row.id.clone():{"arbitrarykey":{"text":"review","path":root.join("a.txt")}}},"queues":{}}),
            json!({"version":1,"composers":{},"feedback":{},"queues":{row.id.clone():{"blocks":[[{"type":"text","text":"unsent"}]],"uncertainIndex":null}}}),
            json!({"version":1,"choice":{"cwd":alias},"composers":{"new":{"text":"new","attachments":[]}},"feedback":{},"queues":{}}),
        ];
        for value in cases {
            s.set_setting("unsentWork.v1", &value).unwrap();
            let (b, impact) = s.worktree_impact(&[&root]).unwrap();
            assert!(impact.unsent, "{value}");
            assert_eq!(impact.conversations, 1);
            assert_eq!(s.get_setting("unsentWork.v1").unwrap(), Some(value));
            assert_eq!(s.worktree_draft_baseline().unwrap().0, b);
        }
        s.set_setting(
            "unsentWork.v1",
            &json!({"version":1,"composers":{},"feedback":{},"queues":{}}),
        )
        .unwrap();
        assert!(!s.worktree_impact(&[&root]).unwrap().1.unsent);
    }
    #[test]
    fn unassignable_nonempty_input_and_malformed_saved_data_are_not_treated_as_empty() {
        let d = tempfile::tempdir().unwrap();
        let s = MetaStore::open(&d.path().join("meta.db")).unwrap();
        for value in [
            json!({"version":1,"composers":{"new":{"text":"unsent","attachments":[]}},"feedback":{},"queues":{}}),
            json!({"version":1,"composers":[],"feedback":{},"queues":{}}),
            json!({"version":1,"composers":{},"feedback":{},"queues":{"unknown-row":{"blocks":[[{"type":"text","text":"unsent"}]],"uncertainIndex":null}}}),
            json!({"version":1,"composers":{},"feedback":{"unknown-row":{"opaque-file":{"text":"review"}}},"queues":{}}),
        ] {
            s.set_setting("unsentWork.v1", &value).unwrap();
            assert!(s.worktree_impact(&[d.path()]).is_err());
            assert_eq!(s.get_setting("unsentWork.v1").unwrap(), Some(value));
        }
    }
    #[test]
    fn known_unrelated_saved_inputs_do_not_block_directory_maintenance() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("target");
        let other = d.path().join("other");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let s = MetaStore::open(&d.path().join("meta.db")).unwrap();
        let row = crate::acp_client::session_index::touch_session_row(
            &s,
            "fixture",
            other.to_str().unwrap(),
            "native",
            None,
            None,
        )
        .unwrap();
        let value = json!({"version":1,
            "composers":{format!("session:{}",row.id):{"text":"kept","attachments":[]}},
            "feedback":{row.id.clone():{"opaque":{"text":"review","path":other.join("a.txt")}}},
            "queues":{row.id:{"blocks":[[{"type":"text","text":"next"}]],"uncertainIndex":null}}
        });
        s.set_setting("unsentWork.v1", &value).unwrap();
        let (_, impact) = s.worktree_impact(&[&root.canonicalize().unwrap()]).unwrap();
        assert!(!impact.unsent);
        assert_eq!(impact.conversations, 0);
        assert_eq!(s.get_setting("unsentWork.v1").unwrap(), Some(value));
    }
    #[test]
    fn orphan_composer_cannot_borrow_the_current_new_draft_location() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("target");
        let other = d.path().join("other");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let s = MetaStore::open(&d.path().join("meta.db")).unwrap();
        for key in [
            "session:missing",
            "queue-edit:missing",
            "resend:missing",
            "saved-new:missing",
        ] {
            let value = json!({"version":1,"choice":{"cwd":other},
                "composers":{key:{"text":"unsent", "attachments":[]}}, "feedback":{}, "queues":{}});
            s.set_setting("unsentWork.v1", &value).unwrap();
            assert_eq!(
                s.worktree_impact(&[&root.canonicalize().unwrap()])
                    .unwrap_err(),
                "unknownDrafts",
                "{key}"
            );
            assert_eq!(s.get_setting("unsentWork.v1").unwrap(), Some(value));
        }
        for (key, draft) in [
            ("new", json!({"text":"kept", "attachments":[]})),
            (
                "saved-new:own",
                json!({"text":"kept", "attachments":[], "savedChoice":{"cwd":other}}),
            ),
        ] {
            let value = json!({"version":1,"choice":{"cwd":other}, "composers":{key:draft},"feedback":{},"queues":{}});
            s.set_setting("unsentWork.v1", &value).unwrap();
            assert!(
                !s.worktree_impact(&[&root.canonicalize().unwrap()])
                    .unwrap()
                    .1
                    .unsent
            );
        }
    }
}
