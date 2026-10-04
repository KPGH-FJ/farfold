#![allow(dead_code)]

// These two modules are downloaded verbatim from OpenAI's public release tag.
#[path = "../../codex-config__src__key_aliases.rs"]
mod key_aliases;
#[path = "../../codex-config__src__merge.rs"]
mod merge;
#[path = "../../codex-config__src__overrides.rs"]
mod overrides;

// This dependency is unreachable for the MCP/model-only fixture. Panic rather
// than fake the network-domain behavior so any unexpected call fails the probe.
extern crate self as codex_network_proxy;
pub fn normalize_host(_: &str) -> String {
    panic!("Network-domain normalization is outside this MCP-only probe");
}

fn main() {
    let adapter: serde_json::Value =
        serde_json::from_str(include_str!("../../adapter-results.json")).unwrap();
    let mut results = Vec::new();
    for case in adapter["cases"].as_array().unwrap() {
        let Some(native) = case.get("native") else { continue };
        let mut merged = toml::Value::try_from(native).unwrap();
        let overlay = toml::Value::try_from(&case["adapterOverride"]).unwrap();
        merge::merge_toml_values(&mut merged, &overlay);
        let result = serde_json::to_value(&merged).unwrap();
        assert_eq!(result["mcp_servers"]["existing_global"], native["mcp_servers"]["existing_global"]);
        assert_eq!(result["mcp_servers"]["existing_project"], native["mcp_servers"]["existing_project"]);
        assert_eq!(result["model"], native["model"]);
        assert_eq!(result["model_provider"], native["model_provider"]);
        assert_eq!(result["mcp_servers"]["farfold_browser_fixture"]["env"]["FARFOLD_BROWSER_TOKEN"], "SYNTHETIC_TEMPORARY_TOKEN_NOT_REAL");
        assert_eq!(result["mcp_servers"].as_object().unwrap().len(), 3);
        results.push(serde_json::json!({"name":case["name"], "result":"pass", "configuredServerNames":result["mcp_servers"].as_object().unwrap().keys().collect::<Vec<_>>() }));
    }
    assert_eq!(results.len(), 3);

    // An official deep merge combines leaves for a colliding name. The adapter
    // filters such names by default; this confirms why bypassing that matters.
    let mut collision = toml::Value::try_from(&serde_json::json!({"mcp_servers":{"same":{"url":"https://native.example.invalid/mcp"}}})).unwrap();
    let overlay = toml::Value::try_from(&serde_json::json!({"mcp_servers":{"same":{"command":"/synthetic/stdio"}}})).unwrap();
    merge::merge_toml_values(&mut collision, &overlay);
    let collision = serde_json::to_value(collision).unwrap();
    assert!(collision["mcp_servers"]["same"].get("url").is_some());
    assert!(collision["mcp_servers"]["same"].get("command").is_some());
    results.push(serde_json::json!({"name":"same-name-is-leaf-merged", "result":"confirmed-collision-risk"}));

    let dotted = ("mcp_servers.inline_only.command".to_owned(), toml::Value::String("/synthetic/inline-tool".into()));
    let temporary = ("mcp_servers".to_owned(), toml::Value::try_from(&serde_json::json!({"farfold_browser_fixture":{"command":"/synthetic/farfold"}})).unwrap());
    let dotted_then_whole = overrides::build_cli_overrides_layer(&[dotted.clone(), temporary.clone()]);
    let whole_then_dotted = overrides::build_cli_overrides_layer(&[temporary, dotted]);
    assert!(dotted_then_whole["mcp_servers"].get("inline_only").is_none());
    assert!(whole_then_dotted["mcp_servers"].get("inline_only").is_some());
    results.push(serde_json::json!({"name":"dotted-inline-MCP-order-sensitive-before-layer-merge", "result":"confirmed-inline-config-risk", "dottedThenWholeRetainsInline":false, "wholeThenDottedRetainsInline":true}));
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
        "kind":"official-unmodified-Rust-merge-functions-with-synthetic-config",
        "source":"https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/merge.rs",
        "actualAgentsStarted":0,
        "modelMessages":0,
        "boundaries":["Only public merge.rs, key_aliases.rs, and overrides.rs are compiled", "Synthetic adapter output feeds the actual Rust merge function", "App-server itself is not executed", "Network-domain dependency panics if unexpectedly invoked; MCP fixtures never invoke it"],
        "cases":results
    })).unwrap());
}
