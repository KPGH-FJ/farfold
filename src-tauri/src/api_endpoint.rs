//! Shared request-base rules. Credential identity retains the saved endpoint.

pub(crate) fn base_url(endpoint: &str, api_type: &str) -> Result<String, String> {
    let base = endpoint.trim_end_matches('/');
    if api_type != "messages" {
        return Ok(base.to_string());
    }
    let url = reqwest::Url::parse(base).map_err(|_| "请检查 API 基础地址")?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("请检查 API 基础地址".into());
    }
    // Only the official HTTPS root has this SDK default. A custom prefix or
    // non-default port keeps the explicitly selected address unchanged.
    if url.scheme() == "https"
        && url.host_str() == Some("api.anthropic.com")
        && url.port().is_none()
        && url.path() == "/"
    {
        Ok("https://api.anthropic.com/v1".into())
    } else {
        Ok(base.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_only_completes_the_official_https_root() {
        for (endpoint, expected) in [
            ("https://api.anthropic.com", "https://api.anthropic.com/v1"),
            ("https://api.anthropic.com/", "https://api.anthropic.com/v1"),
            (
                "https://api.anthropic.com/v1",
                "https://api.anthropic.com/v1",
            ),
            (
                "https://api.anthropic.com:9443",
                "https://api.anthropic.com:9443",
            ),
            (
                "https://api.anthropic.com/prefix/",
                "https://api.anthropic.com/prefix",
            ),
            ("https://custom.test", "https://custom.test"),
            (
                "https://custom.test/prefix/v1/",
                "https://custom.test/prefix/v1",
            ),
            (
                "https://api.anthropic.com.custom.test",
                "https://api.anthropic.com.custom.test",
            ),
            ("http://api.anthropic.com", "http://api.anthropic.com"),
        ] {
            assert_eq!(base_url(endpoint, "messages").unwrap(), expected);
        }
        assert_eq!(
            base_url("https://api.anthropic.com", "responses").unwrap(),
            "https://api.anthropic.com"
        );
    }

    #[test]
    fn unsafe_or_invalid_message_bases_return_only_a_fixed_error() {
        for endpoint in [
            "not-a-url-secret-canary",
            "https://user:secret-canary@custom.test",
            "https://custom.test?key=secret-canary",
            "https://custom.test/#secret-canary",
        ] {
            assert_eq!(
                base_url(endpoint, "messages").unwrap_err(),
                "请检查 API 基础地址"
            );
        }
    }
}
