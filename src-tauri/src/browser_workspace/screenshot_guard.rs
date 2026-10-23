//! CDP structure only. Values/text/URLs/HTML are never retained or returned.
//! All author shadow trees and embedded/editable content are refused, even
//! when closed to page JavaScript. This does not authorize another frame.
use serde::{
    Deserialize, Deserializer,
    de::{self, IgnoredAny, SeqAccess, Visitor},
};
use sha2::{Digest, Sha256};
use std::fmt;

// The authority check precedes even JSON decoding. Retired native replies may
// still arrive; do not inspect/retain their page fields after withdrawal.
pub(super) fn decode_reply<T: serde::de::DeserializeOwned>(
    raw: &str,
    permitted: bool,
) -> Result<T, String> {
    if !permitted {
        return Err("网页已变化，请重新观察".into());
    }
    if raw.len() > 550_000 {
        return Err("网页返回内容过大".into());
    }
    serde_json::from_str(raw).map_err(|_| "网页返回内容无效".into())
}

#[derive(Deserialize)]
pub(super) struct Document {
    root: Node,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    node_type: u8,
    node_name: String,
    backend_node_id: u64,
    #[serde(default)]
    child_node_count: usize,
    #[serde(default)]
    children: Vec<Node>,
    #[serde(default, deserialize_with = "present_nodes")]
    shadow_roots: bool,
    #[serde(default)]
    shadow_root_type: Option<IgnoredAny>,
    #[serde(default)]
    content_document: Option<IgnoredAny>,
    #[serde(default, deserialize_with = "editable")]
    attributes: bool,
}
fn present_nodes<'de, D: Deserializer<'de>>(input: D) -> Result<bool, D::Error> {
    struct Presence;
    impl<'de> Visitor<'de> for Presence {
        type Value = bool;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("node array")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut values: A) -> Result<bool, A::Error> {
            let mut present = false;
            while values.next_element::<IgnoredAny>()?.is_some() {
                present = true;
            }
            Ok(present)
        }
    }
    input.deserialize_seq(Presence)
}
fn editable<'de, D: Deserializer<'de>>(input: D) -> Result<bool, D::Error> {
    struct Attributes;
    struct IsFalse;
    impl<'de> Visitor<'de> for IsFalse {
        type Value = bool;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("attribute string")
        }
        fn visit_str<E: de::Error>(self, value: &str) -> Result<bool, E> {
            Ok(value.eq_ignore_ascii_case("false"))
        }
    }
    struct Flag(bool);
    impl<'de> Deserialize<'de> for Flag {
        fn deserialize<T: Deserializer<'de>>(input: T) -> Result<Self, T::Error> {
            input.deserialize_str(IsFalse).map(Self)
        }
    }
    impl<'de> Visitor<'de> for Attributes {
        type Value = bool;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("paired attribute strings")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut values: A) -> Result<bool, A::Error> {
            let mut found = false;
            while let Some(name) = values.next_element::<String>()? {
                if name.len() > 256 {
                    return Err(de::Error::custom("attribute name limit"));
                }
                let flag = values
                    .next_element::<Flag>()?
                    .ok_or_else(|| de::Error::custom("attribute pair"))?;
                if name.eq_ignore_ascii_case("contenteditable") && !flag.0 {
                    found = true;
                }
            }
            Ok(found)
        }
    }
    input.deserialize_seq(Attributes)
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Guard {
    root: u64,
    digest: [u8; 32],
}
impl Document {
    pub(super) fn guard(self) -> Result<Guard, &'static str> {
        const REFUSED: &str = "页面含可编辑内容或嵌入页面，暂不能安全截图";
        if self.root.node_type != 9 || self.root.node_name != "#document" {
            return Err("截图保护未能确认");
        }
        let root = self.root.backend_node_id;
        let mut stack = vec![self.root];
        let mut hash = Sha256::new();
        let mut count = 0usize;
        while let Some(node) = stack.pop() {
            count += 1;
            if count > 4000 || node.node_name.len() > 64 || node.backend_node_id == 0 {
                return Err("页面内容超过安全检查范围，暂不能截图");
            }
            if node.shadow_roots
                || node.shadow_root_type.is_some()
                || node.content_document.is_some()
                || node.attributes
                || matches!(
                    node.node_name.to_ascii_uppercase().as_str(),
                    "INPUT"
                        | "TEXTAREA"
                        | "SELECT"
                        | "IFRAME"
                        | "FRAME"
                        | "OBJECT"
                        | "EMBED"
                        | "FENCEDFRAME"
                        | "PORTAL"
                )
            {
                return Err(REFUSED);
            }
            if !matches!(node.node_type, 1 | 3 | 8 | 9 | 10)
                || node.child_node_count != node.children.len()
            {
                return Err("截图保护未能确认");
            }
            hash.update([node.node_type]);
            hash.update(node.backend_node_id.to_le_bytes());
            hash.update((node.node_name.len() as u64).to_le_bytes());
            hash.update(node.node_name.as_bytes());
            hash.update((node.child_node_count as u64).to_le_bytes());
            stack.extend(node.children.into_iter().rev());
        }
        Ok(Guard {
            root,
            digest: hash.finalize().into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn document(child: Value) -> Value {
        json!({"root":{"nodeType":9,"nodeName":"#document","backendNodeId":1,"childNodeCount":1,"children":[child]}})
    }
    fn element() -> Value {
        json!({"nodeType":1,"nodeName":"DIV","backendNodeId":2,"childNodeCount":0,"attributes":["value","FORM_SECRET","data-note","PAGE_SECRET"]})
    }
    fn guard(value: Value) -> Result<Guard, &'static str> {
        serde_json::from_value::<Document>(value)
            .map_err(|_| "invalid structure")?
            .guard()
    }
    #[test]
    fn retired_reply_is_rejected_before_deserialization_or_diagnostics() {
        #[derive(Debug)]
        struct NoRead;
        impl<'de> Deserialize<'de> for NoRead {
            fn deserialize<D: Deserializer<'de>>(_: D) -> Result<Self, D::Error> {
                panic!("retired page data must not be deserialized");
            }
        }
        let error = decode_reply::<NoRead>("FORM_SECRET raw reply", false).unwrap_err();
        assert!(!error.contains("SECRET"));
    }
    #[test]
    fn public_structure_is_accepted_but_values_are_not_part_of_retained_guard() {
        let initial = guard(document(element())).unwrap();
        let mut other = element();
        other["attributes"] = json!(["value", "OTHER_SECRET"]);
        other["nodeValue"] = json!("PRIVATE_TEXT");
        assert_eq!(guard(document(other)).unwrap(), initial);
        assert!(!format!("{initial:?}").contains("SECRET"));
    }
    #[test]
    fn empty_closed_roots_frames_and_editable_content_are_refused_without_values() {
        for key in ["shadowRoots", "contentDocument", "shadowRootType"] {
            let mut child = element();
            child[key] = match key {
                "shadowRoots" => json!([{"nodeType":11,"nodeValue":"SECRET"}]),
                "shadowRootType" => json!("closed"),
                _ => json!({"nodeValue":"SECRET"}),
            };
            assert!(guard(document(child)).is_err());
        }
        for name in [
            "INPUT",
            "TEXTAREA",
            "SELECT",
            "IFRAME",
            "FRAME",
            "OBJECT",
            "EMBED",
            "FENCEDFRAME",
            "PORTAL",
        ] {
            let mut child = element();
            child["nodeName"] = json!(name);
            assert!(guard(document(child)).is_err());
        }
        let mut child = element();
        child["attributes"] = json!(["contenteditable", "plaintext-only"]);
        assert!(guard(document(child)).is_err());
        let mut child = element();
        child["attributes"] = json!(["contenteditable", "false"]);
        assert!(guard(document(child)).is_ok());
    }
    #[test]
    fn incomplete_changed_and_excessive_trees_cannot_pass_as_the_same_page() {
        let original = guard(document(element())).unwrap();
        let mut child = element();
        child["backendNodeId"] = json!(3);
        assert_ne!(guard(document(child)).unwrap(), original);
        let mut child = element();
        child["childNodeCount"] = json!(1);
        assert!(guard(document(child)).is_err());
        let mut value = document(element());
        value["root"]["children"] = json!((0..4000).map(|_| element()).collect::<Vec<_>>());
        value["root"]["childNodeCount"] = json!(4000);
        assert!(guard(value).is_err());
    }
}
