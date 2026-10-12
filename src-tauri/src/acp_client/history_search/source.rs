use super::{
    launch::{self, Route},
    types::*,
};
use crate::{
    acp_client::{
        extension_inventory as inventory,
        manager::{AcpManager, LaunchIdentity},
    },
    meta_store::{AgentRow, MetaStore, SessionRow},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
#[derive(Clone)]
pub(super) struct Source {
    pub agent: AgentRow,
    pub rows: Vec<SessionRow>,
    pub route: Route,
}
impl Source {
    pub fn current(&self, store: &MetaStore) -> Result<()> {
        let current = store
            .get_agent(&self.agent.id)
            .map_err(|_| Code::Unavailable)?
            .ok_or(Code::SelectionChanged)?;
        if !inventory::launch::same_selection(&self.agent, &current) {
            return Err(Code::SelectionChanged.into());
        }
        for row in &self.rows {
            if store
                .get_session(&row.id)
                .map_err(|_| Code::Unavailable)?
                .as_ref()
                != Some(row)
            {
                return Err(Code::IndexChanged.into());
            }
        }
        self.route.current(&self.agent)?;
        Ok(())
    }
    pub fn unopened(&self, manager: &AcpManager) -> Result<()> {
        for row in &self.rows {
            if is_open(
                manager,
                &self.agent,
                row.native_session_id
                    .as_deref()
                    .ok_or(Code::NoNativeHistory)?,
            )? {
                return Err(Code::AlreadyOpen.into());
            }
        }
        Ok(())
    }
}
// An index directory may be stale while the same native id is still owned under
// another directory or service, or a proven alias of the same entrypoint.
// Unknown wrappers or unrelated Agents are not matched by native id alone.
fn is_open(manager: &AcpManager, agent: &AgentRow, native: &str) -> Result<bool> {
    let entry = LaunchIdentity::from_launch(&agent.command, &agent.args);
    let connections: Vec<_> = manager
        .lock()
        .map_err(|_| Code::Busy)?
        .iter()
        .filter(|(key, connection)| {
            !key.candidate
                && (key.agent_id == agent.id
                    || entry.as_ref().is_some_and(|identity| {
                        connection.launch_identity.as_ref() == Some(identity)
                    }))
        })
        .map(|(_, connection)| connection.clone())
        .collect();
    for connection in connections {
        if connection
            .sessions
            .lock()
            .map_err(|_| Code::Busy)?
            .contains_key(native)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Default)]
struct Selections(Mutex<HashMap<String, (Source, Instant)>>);
fn selections() -> &'static Selections {
    static VALUE: OnceLock<Selections> = OnceLock::new();
    VALUE.get_or_init(Default::default)
}
fn new_id() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|_| Code::Unavailable)?;
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    let h: String = b.iter().map(|v| format!("{v:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}
fn prune(entries: &mut HashMap<String, (Source, Instant)>) {
    entries.retain(|_, (_, t)| t.elapsed() < Duration::from_secs(300));
}
pub(super) fn selected(agent: &str, id: &str) -> Result<Source> {
    let mut entries = selections().0.lock().unwrap_or_else(|p| p.into_inner());
    prune(&mut entries);
    entries
        .get(id)
        .filter(|(s, _)| s.agent.id == agent)
        .map(|(s, _)| s.clone())
        .ok_or_else(|| Code::SelectionChanged.into())
}
pub(super) fn capabilities(
    store: &MetaStore,
    manager: &AcpManager,
    agent: &str,
    ids: &[String],
) -> Result<Selection> {
    if !identifier(agent)
        || ids.is_empty()
        || ids.len() > 20
        || ids.iter().any(|v| !identifier(v))
        || ids.iter().collect::<HashSet<_>>().len() != ids.len()
    {
        return Err(Code::InvalidRequest.into());
    }
    let row = store
        .get_agent(agent)
        .map_err(|_| Code::Unavailable)?
        .ok_or(Code::Unavailable)?;
    let route = launch::admission(&row);
    let common = route.as_ref().err().map(|v| v.code).or_else(|| {
        crate::shell_env::cached_command_env()
            .is_none()
            .then_some(Code::EnvironmentUnavailable)
    });
    let mut saved = vec![];
    let mut rows = vec![];
    for id in ids {
        let stored = store.get_session(id).map_err(|_| Code::Unavailable)?;
        let code = common.or_else(|| match &stored {
            None => Some(Code::IndexChanged),
            Some(s) if s.agent_id != agent => Some(Code::IndexChanged),
            Some(s)
                if s.native_session_id
                    .as_deref()
                    .is_none_or(|v| !identifier(v)) =>
            {
                Some(Code::NoNativeHistory)
            }
            Some(s)
                if matches!(&route, Ok(Route::Sdk(_)))
                    && !s.native_session_id.as_deref().is_some_and(uuid) =>
            {
                Some(Code::NoNativeHistory)
            }
            Some(s) => {
                if (matches!(&route, Ok(Route::Sdk(_)))
                    && std::fs::canonicalize(&s.cwd)
                        .ok()
                        .and_then(|p| p.to_str().map(str::to_owned))
                        .as_deref()
                        != Some(s.cwd.as_str()))
                    || inventory::launch::Directory::open(&s.cwd).is_err()
                {
                    Some(Code::CwdUnavailable)
                } else {
                    match is_open(
                        manager,
                        &row,
                        s.native_session_id.as_deref().unwrap_or_default(),
                    ) {
                        Ok(false) => None,
                        Ok(true) => Some(Code::AlreadyOpen),
                        Err(_) => Some(Code::Busy),
                    }
                }
            }
        });
        rows.push(SelectionRow {
            row_id: id.clone(),
            availability: if code.is_none() {
                "available"
            } else {
                "unavailable"
            },
            code,
        });
        if let Some(s) = stored {
            saved.push(s);
        }
    }
    let code = common.or_else(|| rows.iter().find_map(|r| r.code));
    let selection_id = if code.is_none() {
        let mut entries = selections().0.lock().unwrap_or_else(|p| p.into_inner());
        prune(&mut entries);
        if entries.len() >= 32 {
            return Err(Code::RequestCapacity.into());
        }
        let id = new_id()?;
        if entries.contains_key(&id) {
            return Err(Code::Unavailable.into());
        }
        entries.insert(
            id.clone(),
            (
                Source {
                    agent: row,
                    rows: saved,
                    route: route.as_ref().map_err(Clone::clone)?.clone(),
                },
                Instant::now(),
            ),
        );
        Some(id)
    } else {
        None
    };
    let (public_source, sdk_scope) = public_surface(&route, common);
    Ok(Selection {
        agent_id: agent.into(),
        selection_id,
        valid_for_ms: 300000,
        source: public_source,
        sdk_scope,
        scope: "userAndAssistantText",
        availability: if code.is_none() {
            "available"
        } else {
            "unavailable"
        },
        code,
        rows,
    })
}

pub(super) fn public_surface(
    route: &Result<Route>,
    common: Option<Code>,
) -> (Option<&'static str>, Option<SdkScope>) {
    let route = route.as_ref().ok().filter(|_| common.is_none());
    (route.map(Route::source), route.and_then(Route::scope))
}
#[cfg(test)]
mod surface_tests {
    use super::*;
    #[test]
    fn common_environment_failure_does_not_publish_codex_or_sdk_source() {
        let route = Ok(Route::AppServer);
        let (source, scope) = public_surface(&route, Some(Code::EnvironmentUnavailable));
        assert!(source.is_none());
        assert!(scope.is_none());
        let (source, scope) = public_surface(&route, None);
        // Per-row unavailable (e.g. already open) does not invalidate the checked route.
        assert_eq!(source, Some("officialAppServer"));
        assert!(scope.is_none());
    }
}
