//! Sourced directory copy, not runtime capabilities or installation policy.
//! Reviewed 2026-09-30; provenance and category rationale live in
//! docs/evidence/2026-09-30-prototype-fidelity/directory-sources.md.
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPresentation {
    pub publisher: &'static str,
    pub description: &'static str,
    pub categories: &'static [&'static str],
    pub source_url: &'static str,
}

/// Match official registry identity only, never display names or local commands.
/// Unknown/custom entries retain their original directory copy without guessed tags.
pub fn for_registry(registry_id: &str) -> Option<DirectoryPresentation> {
    let (publisher, description, categories, source_url): (_, _, &[_], _) = match registry_id {
        "codex-acp" => (
            "OpenAI",
            "在本机处理代码与项目任务，也可用于脚本和工作流程自动化。",
            &["编程", "自动化"],
            "https://github.com/openai/codex",
        ),
        "opencode" => (
            "Anomaly",
            "开源编程 Agent，可连接多种模型服务，完成代码理解、修改与脚本任务。",
            &["编程", "自动化"],
            "https://opencode.ai/docs/",
        ),
        "pi-acp" => (
            "Earendil Inc.",
            "以精简核心处理编程任务，通过扩展、技能和模板调整工作方式。",
            &["编程", "轻量"],
            "https://pi.dev/",
        ),
        "cline" => (
            "Cline Bot Inc.",
            "编写与修改代码、运行命令，也可通过脚本组织自动化任务。",
            &["编程", "自动化"],
            "https://github.com/cline/cline/blob/main/apps/cli/README.md",
        ),
        "qwen-code" => (
            "Qwen",
            "开源编程 Agent，支持多种模型服务，可用于代码任务、脚本和批量工作。",
            &["编程", "自动化"],
            "https://github.com/QwenLM/qwen-code",
        ),
        "claude-acp" => (
            "Anthropic · Zed · JetBrains",
            "通过公开接入项目使用 Claude Agent，处理文件修改、工具与命令任务。",
            &["编程", "自动化"],
            "https://github.com/agentclientprotocol/claude-agent-acp",
        ),
        "gemini" => (
            "Google",
            "结合代码理解、命令操作与网页搜索，处理开发、资料查找和自动化任务。",
            &["编程", "自动化", "研究"],
            "https://github.com/google-gemini/gemini-cli",
        ),
        "goose" => (
            "Agentic AI Foundation",
            "在本机完成编程、研究、写作与数据分析，并通过扩展连接工作工具。",
            &["编程", "自动化", "研究"],
            "https://goose-docs.ai/",
        ),
        "kimi" => (
            "Moonshot AI",
            "用于编程与命令任务；目录链接的旧项目已归档，官方提供迁移说明。",
            &["编程", "自动化"],
            "https://github.com/MoonshotAI/kimi-cli",
        ),
        "fast-agent" => (
            "fast-agent / evalstate",
            "以可扩展 Agent 组织编程、脚本和多步骤工作，支持多种模型服务。",
            &["编程", "自动化"],
            "https://fast-agent.ai/",
        ),
        "amp-acp" => (
            "Amp",
            "面向代码与项目工作的 Agent，可在命令行中使用，也可接入脚本流程。",
            &["编程", "自动化"],
            "https://ampcode.com/docs",
        ),
        _ => return None,
    };
    Some(DirectoryPresentation {
        publisher,
        description,
        categories,
        source_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presentation_is_bounded_sourced_copy_for_the_reviewed_directory() {
        for id in [
            "codex-acp",
            "opencode",
            "pi-acp",
            "cline",
            "qwen-code",
            "claude-acp",
            "gemini",
            "goose",
            "kimi",
            "fast-agent",
            "amp-acp",
        ] {
            let copy = for_registry(id).unwrap();
            assert!(!copy.publisher.is_empty());
            assert!(
                copy.description
                    .chars()
                    .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
            );
            assert!(copy.source_url.starts_with("https://"));
            assert!(!copy.categories.is_empty());
            assert!(
                copy.categories
                    .iter()
                    .all(|tag| ["编程", "自动化", "研究", "轻量"].contains(tag))
            );
            let encoded = serde_json::to_value(copy).unwrap();
            assert_eq!(encoded.as_object().unwrap().len(), 4);
            assert!(encoded.get("sourceUrl").is_some());
        }
    }

    #[test]
    fn names_commands_custom_ids_and_unknown_registry_entries_are_not_classified() {
        for id in [
            "",
            "unknown",
            "Codex",
            "custom-codex",
            "registry:codex-acp",
            "/usr/bin/pi",
        ] {
            assert!(for_registry(id).is_none());
        }
    }

    #[test]
    fn copy_tracks_current_ownership_without_reusing_prototype_categories() {
        assert_eq!(for_registry("pi-acp").unwrap().publisher, "Earendil Inc.");
        let goose = for_registry("goose").unwrap();
        assert_eq!(goose.publisher, "Agentic AI Foundation");
        assert_eq!(goose.source_url, "https://goose-docs.ai/");
        assert!(
            !for_registry("qwen-code")
                .unwrap()
                .categories
                .contains(&"轻量")
        );
        assert!(for_registry("kimi").unwrap().description.contains("已归档"));
    }
}
