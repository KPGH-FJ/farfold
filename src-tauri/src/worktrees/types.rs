use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Location {
    pub id: String,
    pub revision: u64,
    pub path: String,
    pub repository_root: String,
    pub branch: Option<String>,
    pub head_oid: String,
    pub ownership: String,
    pub availability: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub inspection_id: String,
    pub root: String,
    pub repository_root: String,
    pub kind: String,
    pub head: Head,
    pub trees: Vec<Tree>,
    pub blockers: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct Head {
    pub oid: Option<String>,
    pub branch: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tree {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_id: Option<String>,
    pub path: String,
    pub branch: Option<String>,
    pub locked: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    pub r#ref: String,
    pub oid: String,
    pub in_use: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refs {
    pub refs: Vec<Ref>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Branch {
    New {
        name: String,
        #[serde(rename = "startOid")]
        start_oid: String,
    },
    Existing {
        r#ref: String,
        #[serde(rename = "expectedOid")]
        expected_oid: String,
    },
}
impl Branch {
    pub fn oid(&self) -> &str {
        match self {
            Self::New { start_oid, .. } => start_oid,
            Self::Existing { expected_oid, .. } => expected_oid,
        }
    }
    pub fn name(&self) -> &str {
        match self {
            Self::New { name, .. } => name,
            Self::Existing { r#ref, .. } => r#ref.strip_prefix("refs/heads/").unwrap_or(""),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    pub inspection_id: String,
    pub parent_path: String,
    pub directory_name: String,
    pub branch: Branch,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub kind: String,
    #[serde(default = "default_action")]
    pub action: String,
    #[serde(default)]
    pub maintenance_active: bool,
    pub operation_id: String,
    pub state: String,
    pub settled: bool,
    pub cancel_requested: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reviewed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive: Option<super::recycle_types::Archive>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}
fn default_action() -> String {
    "create".into()
}
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Reply {
    Operation(Box<Operation>),
    Unknown {
        kind: &'static str,
        #[serde(rename = "operationId")]
        operation_id: String,
    },
}
impl Reply {
    pub fn unknown(id: &str) -> Self {
        Self::Unknown {
            kind: "unknownOperation",
            operation_id: id.into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Material {
    pub operation_id: String,
    pub path: String,
    pub repository_root: String,
}
#[derive(Debug, Serialize)]
pub struct Listing {
    pub locations: Vec<Location>,
    pub archives: Vec<super::recycle_types::Archive>,
    pub materials: Vec<Material>,
    pub operation: Option<Operation>,
}
#[derive(Debug, Serialize)]
pub struct Forgotten {
    pub forgotten: bool,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Failure {
    pub code: &'static str,
}
pub type Result<T> = std::result::Result<T, Failure>;
pub(super) fn error(code: &'static str) -> Failure {
    Failure { code }
}
pub(super) fn oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64)
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn id(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
            }
        })
}
