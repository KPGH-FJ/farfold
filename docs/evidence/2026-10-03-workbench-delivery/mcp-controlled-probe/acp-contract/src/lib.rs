//! Controlled wire-shape checks only. Never starts an Agent or sends a prompt.
#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::v1::{
        LoadSessionRequest, McpCapabilities, McpServer, McpServerHttp, McpServerStdio,
        NewSessionRequest,
    };
    use serde_json::{Value, json};

    fn stdio() -> McpServer {
        McpServer::Stdio(
            McpServerStdio::new("farfold-controlled-page", "/controlled/python3")
                .args(vec!["/controlled/page_server.py".into()]),
        )
    }

    fn expected_stdio() -> Value {
        json!({
            "name": "farfold-controlled-page",
            "command": "/controlled/python3",
            "args": ["/controlled/page_server.py"],
            "env": []
        })
    }

    #[test]
    fn official_new_session_serializes_untagged_stdio() {
        let request = NewSessionRequest::new("/controlled/work").mcp_servers(vec![stdio()]);
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            json!({"cwd": "/controlled/work", "mcpServers": [expected_stdio()]})
        );
    }

    #[test]
    fn official_load_session_uses_the_same_stdio_contract() {
        let request = LoadSessionRequest::new("controlled-session", "/controlled/work")
            .mcp_servers(vec![stdio()]);
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            json!({
                "sessionId": "controlled-session", "cwd": "/controlled/work",
                "mcpServers": [expected_stdio()]
            })
        );
    }

    #[test]
    fn default_http_and_sse_capabilities_are_false() {
        let caps = McpCapabilities::default();
        assert!(!caps.http && !caps.sse);
        assert_eq!(
            serde_json::to_value(caps).unwrap(),
            json!({"http": false,"sse": false})
        );
    }

    #[test]
    fn http_shape_is_separate_not_a_stdio_substitute() {
        let server = McpServer::Http(McpServerHttp::new(
            "controlled-http-contract-only",
            "http://127.0.0.1:1/mcp",
        ));
        assert_eq!(
            serde_json::to_value(server).unwrap(),
            json!({
                "type": "http", "name": "controlled-http-contract-only",
                "url": "http://127.0.0.1:1/mcp", "headers": []
            })
        );
    }
}
