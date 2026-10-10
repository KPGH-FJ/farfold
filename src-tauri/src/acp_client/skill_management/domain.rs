//! Private domain union; the same review/operation registry serves both actions.
use super::{mcp_add_input, mcp_add_plan, mcp_plan, mcp_remove_plan, plan, types::*};
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Domain {
    Skill,
    McpEnabled,
    McpAdd,
    McpRemove,
}
impl From<Kind> for Domain {
    fn from(k: Kind) -> Self {
        match k {
            Kind::Skills => Self::Skill,
            Kind::Mcp => Self::McpEnabled,
        }
    }
}
use crate::{
    acp_client::extension_inventory::{Kind, mcp_targets, targets},
    meta_store::{AgentRow, MetaStore},
};
#[derive(Clone)]
pub(super) enum Source {
    Skill(targets::Source),
    Mcp(mcp_targets::Source),
    Addition(mcp_add_input::Source),
    Removal(mcp_targets::Source),
}
impl Source {
    pub fn domain(&self) -> Domain {
        match self {
            Self::Skill(_) => Domain::Skill,
            Self::Mcp(_) => Domain::McpEnabled,
            Self::Addition(_) => Domain::McpAdd,
            Self::Removal(_) => Domain::McpRemove,
        }
    }
    pub fn addition(&self) -> Result<&mcp_add_input::Source> {
        match self {
            Self::Addition(v) => Ok(v),
            _ => Err(Code::RequestConflict.into()),
        }
    }
    pub fn kind(&self) -> Kind {
        match self {
            Self::Skill(_) => Kind::Skills,
            Self::Mcp(_) | Self::Addition(_) | Self::Removal(_) => Kind::Mcp,
        }
    }
    pub fn row(&self) -> &AgentRow {
        match self {
            Self::Skill(v) => &v.set.row,
            Self::Mcp(v) | Self::Removal(v) => &v.set.row,
            Self::Addition(v) => &v.catalogue.set.row,
        }
    }
    pub fn cwd(&self) -> &str {
        match self {
            Self::Skill(v) => v.cwd(),
            Self::Mcp(v) | Self::Removal(v) => v.cwd(),
            Self::Addition(v) => v.catalogue.cwd(),
        }
    }
    pub fn current(&self, store: &MetaStore, inventory: bool) -> Result<()> {
        match self {
            Self::Skill(v) => v.current(store, inventory),
            Self::Mcp(v) | Self::Removal(v) => v.current(store, inventory),
            Self::Addition(v) => v.catalogue.current(store, inventory),
        }
    }
    pub fn available(&self) -> bool {
        match self {
            Self::Skill(v) => v.available(),
            Self::Mcp(v) | Self::Removal(v) => v.available(),
            Self::Addition(v) => v.catalogue.available(),
        }
    }
    pub fn skill(&self) -> Result<&targets::SkillTarget> {
        match self {
            Self::Skill(v) => Ok(&v.target),
            _ => Err(Code::RequestConflict.into()),
        }
    }
    pub fn mcp(&self) -> Result<&mcp_targets::McpTarget> {
        match self {
            Self::Mcp(v) | Self::Removal(v) => Ok(&v.target),
            _ => Err(Code::RequestConflict.into()),
        }
    }
    pub fn public(&self) -> Result<Target> {
        Ok(match self {
            Self::Addition(v) => Target::McpAddition(v.public()),
            Self::Skill(v) => Target::Skill(SkillChangeTarget {
                inventory_request_id: v.inventory_id.clone(),
                item_id: v.target.id,
                name: v.target.name.clone(),
                origin: v.target.origin.clone(),
                display_path: plan::display_path(&v.target.path)?,
            }),
            Self::Removal(v) => Target::McpRemoval(McpChangeTarget {
                kind: "mcpRemoval",
                inventory_request_id: v.inventory_id.clone(),
                item_id: v.target.id,
                name: v.target.name.clone(),
                transport: v.target.transport,
            }),
            Self::Mcp(v) => Target::Mcp(McpChangeTarget {
                kind: "mcp",
                inventory_request_id: v.inventory_id.clone(),
                item_id: v.target.id,
                name: v.target.name.clone(),
                transport: v.target.transport,
            }),
        })
    }
}
#[derive(Clone)]
pub(super) enum PreparedPlan {
    Skill(plan::Plan),
    Mcp(mcp_plan::Plan),
    Addition(mcp_add_plan::Plan),
    Removal(mcp_remove_plan::Plan),
}
impl PreparedPlan {
    pub fn removal(&self) -> Result<&mcp_remove_plan::Plan> {
        match self {
            Self::Removal(v) => Ok(v),
            _ => Err(Code::RequestConflict.into()),
        }
    }
    pub fn addition(&self) -> Result<&mcp_add_plan::Plan> {
        match self {
            Self::Addition(v) => Ok(v),
            _ => Err(Code::RequestConflict.into()),
        }
    }
    pub fn skill(&self) -> Result<&plan::Plan> {
        match self {
            Self::Skill(v) => Ok(v),
            _ => Err(Code::RequestConflict.into()),
        }
    }
    pub fn mcp(&self) -> Result<&mcp_plan::Plan> {
        match self {
            Self::Mcp(v) => Ok(v),
            _ => Err(Code::RequestConflict.into()),
        }
    }
    pub fn params(&self) -> serde_json::Value {
        match self {
            Self::Skill(v) => v.params(),
            Self::Mcp(v) => v.params(),
            Self::Addition(v) => v.params(),
            Self::Removal(v) => v.params(),
        }
    }
    pub fn before(&self) -> &plan::Config {
        match self {
            Self::Skill(v) => &v.before,
            Self::Mcp(v) => &v.before,
            Self::Addition(v) => &v.before,
            Self::Removal(v) => &v.before,
        }
    }
    pub fn review(&self, op: ChangeOperation, id: String) -> Result<Review> {
        let (enabled, reported, configured, rules_before, rules_after, mutation, preservation) =
            match self {
                Self::Skill(v) => (
                    Some(v.enabled),
                    Some(v.target.enabled),
                    None,
                    Some(v.rules_before),
                    Some(v.array.as_array().ok_or(Code::InvalidOutput)?.len()),
                    v.mutation,
                    "officialJsonValues",
                ),
                Self::Mcp(v) => (
                    Some(v.enabled),
                    Some(v.report.enabled),
                    Some(Some(v.configured)),
                    None,
                    None,
                    "setMcpEnabledPreference",
                    "otherConfigurationSemanticsPreserved",
                ),
                Self::Removal(_) => (
                    None,
                    Some(false),
                    Some(Some(false)),
                    None,
                    None,
                    "removeDisabledMcp",
                    "otherConfigurationSemanticsPreserved",
                ),
                Self::Addition(v) => (
                    Some(false),
                    None,
                    Some(None),
                    None,
                    None,
                    v.input.mutation(),
                    "otherConfigurationSemanticsPreserved",
                ),
            };
        Ok(Review {
            review_id: id,
            agent_id: op.agent_id,
            cwd: op.cwd,
            target: op.target,
            requested_enabled: enabled,
            reported_enabled: reported,
            configured_enabled: configured,
            name_availability: if matches!(self, Self::Addition(_)) {
                Some("absentInCheckedScopes")
            } else {
                None
            },
            write_scope: self.before().scope()?,
            observed_at_ms: now_ms(),
            valid_for_ms: 300000,
            rules_before,
            rules_after,
            parent_handling: match self {
                Self::Removal(v) => Some(if v.absent.is_some() {
                    "mayRemainEmpty"
                } else {
                    "preserveSiblings"
                }),
                _ => None,
            },
            mutation,
            preservation,
            session_applicability: "unverified",
        })
    }
}
