//! Fixed 0.143.0 model/list contract. ReasoningEffort is a non-empty native
//! string in this version, not Pi's enum or a list invented by Farfold.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningOption {
    pub reasoning_effort: String,
    pub description: String,
    #[serde(flatten)]
    native_fields: Map<String, Value>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub hidden: bool,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<ReasoningOption>,
    pub input_modalities: Option<Vec<String>>,
    #[serde(flatten)]
    native_fields: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelPage {
    data: Vec<CodexModel>,
    next_cursor: Option<String>,
}

pub(crate) fn read_catalog(
    mut read_page: impl FnMut(Option<&str>) -> Result<Value, String>,
) -> Result<Vec<CodexModel>, String> {
    let mut models = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..16 {
        let page: ModelPage = serde_json::from_value(read_page(cursor.as_deref())?)
            .map_err(|_| "Codex 模型目录与固定协议不符")?;
        for model in page.data {
            let valid_name = |s: &str| {
                !s.trim().is_empty() && s.len() <= 512 && !s.chars().any(char::is_control)
            };
            if !valid_name(&model.id)
                || !valid_name(&model.model)
                || !valid_name(&model.default_reasoning_effort)
                || model.supported_reasoning_efforts.len() > 64
                || model
                    .supported_reasoning_efforts
                    .iter()
                    .any(|o| !valid_name(&o.reasoning_effort))
                || model
                    .input_modalities
                    .as_ref()
                    .is_some_and(|m| m.iter().any(|v| !matches!(v.as_str(), "text" | "image")))
                || !seen_ids.insert(model.id.clone())
            {
                return Err("Codex 模型目录含无效或重复身份／选项；未完成读取".into());
            }
            models.push(model);
            if models.len() > 500 {
                return Err("Codex 模型目录超过读取上限；不能视为完整目录".into());
            }
        }
        let Some(next) = page.next_cursor else {
            return Ok(models);
        };
        if next.is_empty() || next.len() > 4096 || !seen_cursors.insert(next.clone()) {
            return Err("Codex 模型目录分页游标无效；未完成读取".into());
        }
        cursor = Some(next);
    }
    Err("Codex 模型目录分页超过上限；未完成读取".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(id: &str) -> Value {
        json!({"id":id,"model":format!("native-{id}"),"displayName":id,"description":"native description",
            "hidden":false,"isDefault":false,"defaultReasoningEffort":"native-effort",
            "supportedReasoningEfforts":[{"reasoningEffort":"native-effort","description":"advertised"}],
            "futureField":{"preserved":true}})
    }

    #[test]
    fn catalog_uses_native_identifiers_and_effort_strings_and_requires_all_pages() {
        let mut calls = 0;
        let models = read_catalog(|cursor| {
            calls += 1;
            Ok(match cursor {
                None => json!({"data":[model("a")],"nextCursor":"opaque"}),
                Some("opaque") => json!({"data":[model("b")],"nextCursor":null}),
                _ => panic!("unexpected cursor"),
            })
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(models[0].id, "a");
        assert_eq!(models[0].model, "native-a");
        assert_eq!(
            models[0].supported_reasoning_efforts[0].reasoning_effort,
            "native-effort"
        );
        assert_eq!(
            serde_json::to_value(&models[0]).unwrap()["futureField"]["preserved"],
            true
        );
        assert!(models[0].input_modalities.is_none());
        assert!(read_catalog(|_| Ok(json!({"data":[],"nextCursor":"repeated"}))).is_err());
        assert!(read_catalog(|_| Ok(json!({"data":[model("same"),model("same")]}))).is_err());
        let mut malformed = model("missing-effort");
        malformed
            .as_object_mut()
            .unwrap()
            .remove("supportedReasoningEfforts");
        assert!(read_catalog(|_| Ok(json!({"data":[malformed.clone()]}))).is_err());
    }
}
