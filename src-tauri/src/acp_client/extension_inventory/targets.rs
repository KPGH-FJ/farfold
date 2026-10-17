//! Same-response private targets, never reconstructed from UI paths or names.
use super::{launch::Directory, requests, types::*};
use crate::meta_store::{AgentRow, MetaStore};
use std::sync::Arc;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::acp_client) struct SkillTarget {
    pub id: usize,
    pub path: String,
    pub name: String,
    pub origin: String,
    pub enabled: bool,
}
pub(in crate::acp_client) struct TargetSet {
    pub row: AgentRow,
    pub directory: Arc<Directory>,
    pub entries: Vec<SkillTarget>,
}
#[derive(Clone)]
pub(in crate::acp_client) struct Source {
    pub request: Arc<requests::Request>,
    pub set: Arc<TargetSet>,
    pub target: SkillTarget,
    pub inventory_id: String,
}
impl Source {
    pub fn current(&self, store: &MetaStore, require_inventory: bool) -> Result<()> {
        if !self.request.extra_skill_roots.is_empty() {
            return Err(Code::TargetUnavailable.into());
        }
        let current = store
            .get_agent(&self.set.row.id)
            .map_err(|_| Code::Unavailable)?;
        if !current
            .as_ref()
            .is_some_and(|v| super::launch::same_selection(v, &self.set.row))
        {
            return Err(Code::SelectionChanged.into());
        }
        if !self.set.directory.current() {
            return Err(Code::CwdUnavailable.into());
        }
        if require_inventory && !self.available() {
            return Err(Code::TargetUnavailable.into());
        }
        Ok(())
    }
    pub fn available(&self) -> bool {
        self.request.extra_skill_roots.is_empty()
            && self.request.operation.interested()
            && self
                .request
                .targets
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
                .is_some_and(|v| Arc::ptr_eq(v, &self.set))
    }
    pub fn cwd(&self) -> &str {
        self.request.cwd.as_deref().unwrap_or_default()
    }
}
pub(in crate::acp_client) fn get(agent: &str, id: &str, item: usize) -> Result<Source> {
    let request = requests::shared().get(agent, id)?;
    if !request.extra_skill_roots.is_empty()
        || !request.operation.interested()
        || !request
            .snapshot()
            .is_some_and(|v| v.settled && v.state == State::Ready && v.kind == Kind::Skills)
    {
        return Err(Code::TargetUnavailable.into());
    }
    let set = request
        .targets
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or(Code::TargetUnavailable)?;
    let target = set
        .entries
        .iter()
        .find(|v| v.id == item)
        .cloned()
        .ok_or(Code::TargetUnavailable)?;
    Ok(Source {
        request,
        set,
        target,
        inventory_id: id.into(),
    })
}
