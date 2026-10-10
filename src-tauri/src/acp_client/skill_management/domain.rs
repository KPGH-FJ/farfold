//! Private domain union; the same review/operation registry serves both actions.
use super::{mcp_plan, plan, types::*};
use crate::{
    acp_client::extension_inventory::{Kind, mcp_targets, targets},
    meta_store::{AgentRow, MetaStore},
};
#[derive(Clone)]
pub(super) enum Source {
    Skill(targets::Source),
    Mcp(mcp_targets::Source),
}
impl Source {
    pub fn kind(&self) -> Kind {
        match self {
            Self::Skill(_) => Kind::Skills,
            Self::Mcp(_) => Kind::Mcp,
        }
    }
    pub fn row(&self) -> &AgentRow {
        match self {
            Self::Skill(v) => &v.set.row,
            Self::Mcp(v) => &v.set.row,
        }
    }
    pub fn cwd(&self) -> &str {
        match self {
            Self::Skill(v) => v.cwd(),
            Self::Mcp(v) => v.cwd(),
        }
    }
    pub fn current(&self, store: &MetaStore, inventory: bool) -> Result<()> {
        match self {
            Self::Skill(v) => v.current(store, inventory),
            Self::Mcp(v) => v.current(store, inventory),
        }
    }
    pub fn available(&self) -> bool {
        match self {
            Self::Skill(v) => v.available(),
            Self::Mcp(v) => v.available(),
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
            Self::Mcp(v) => Ok(&v.target),
            _ => Err(Code::RequestConflict.into()),
        }
    }
    pub fn public(&self) -> Result<Target> {
        Ok(match self {
            Self::Skill(v) => Target::Skill(SkillChangeTarget {
                inventory_request_id: v.inventory_id.clone(),
                item_id: v.target.id,
                name: v.target.name.clone(),
                origin: v.target.origin.clone(),
                display_path: plan::display_path(&v.target.path)?,
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
}
impl PreparedPlan {
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
        }
    }
    pub fn before(&self) -> &plan::Config {
        match self {
            Self::Skill(v) => &v.before,
            Self::Mcp(v) => &v.before,
        }
    }
    pub fn review(&self, op: ChangeOperation, id: String) -> Result<Review> {
        let (enabled, reported, configured, rules_before, rules_after, mutation, preservation) =
            match self {
                Self::Skill(v) => (
                    v.enabled,
                    v.target.enabled,
                    None,
                    Some(v.rules_before),
                    Some(v.array.as_array().ok_or(Code::InvalidOutput)?.len()),
                    v.mutation,
                    "officialJsonValues",
                ),
                Self::Mcp(v) => (
                    v.enabled,
                    v.report.enabled,
                    Some(v.configured),
                    None,
                    None,
                    "setMcpEnabledPreference",
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
            write_scope: self.before().scope()?,
            observed_at_ms: now_ms(),
            valid_for_ms: 300000,
            rules_before,
            rules_after,
            mutation,
            preservation,
            session_applicability: "unverified",
        })
    }
}
