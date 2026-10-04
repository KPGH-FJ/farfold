//! URL and caller checks for the manual public-page workspace.
//!
//! This is a URL admission policy, not a network sandbox: it does not resolve DNS,
//! stop DNS rebinding, filter subresources, or detect every sign-in flow. The
//! caller must check every top-level navigation and popup, and must obtain the
//! invoking label and URL from trusted Tauri IPC context, never request fields.

use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use tauri::Url;

/// Admit an ordinary public HTTPS URL without known authentication markers.
pub fn validate_public_url(input: &str) -> Result<Url, String> {
    if input.is_empty()
        || input.len() > 8192
        || input.chars().any(|c| c.is_whitespace() || c.is_control())
        || input.contains('\\')
    {
        return Err("网址为空、过长或含有不支持的字符".into());
    }
    // Also catches an empty userinfo section that URL normalization can erase.
    let authority = input
        .split_once("://")
        .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or(""))
        .filter(|authority| !authority.is_empty())
        .ok_or_else(|| "请输入包含完整域名的网址".to_owned())?;
    if authority.contains('@') {
        return Err("网址不能包含用户名或密码".into());
    }
    let url = Url::parse(input).map_err(|_| "请输入有效的网址".to_owned())?;
    if url.scheme() != "https" || url.port_or_known_default() != Some(443) {
        return Err("仅支持使用标准端口的 HTTPS 网址".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("网址不能包含用户名或密码".into());
    }
    let domain = url.host_str().ok_or_else(|| "网址缺少域名".to_owned())?;
    if !is_public_domain_name(domain) {
        return Err("仅支持公开网站的完整域名".into());
    }
    if is_auth_domain(domain)
        || has_auth_path(url.path())
        || url.fragment().map(has_auth_path).unwrap_or(false)
    {
        return Err("此阶段暂不支持登录或授权页面".into());
    }
    if url.query().map(has_sensitive_parameters).unwrap_or(false)
        || url
            .fragment()
            .map(has_sensitive_parameters)
            .unwrap_or(false)
    {
        return Err("网址不能包含登录信息、授权信息或密钥".into());
    }
    Ok(url)
}

fn is_public_domain_name(domain: &str) -> bool {
    let bare = domain.trim_matches(['[', ']']);
    if bare.parse::<IpAddr>().is_ok()
        || !domain.contains('.')
        || domain.len() > 253
        || domain.ends_with('.')
    {
        return false;
    }
    let domain = domain.to_ascii_lowercase();
    let private_suffixes = [
        "localhost",
        "local",
        "internal",
        "lan",
        "home",
        "home.arpa",
        "corp",
        "test",
        "invalid",
        "example",
        "onion",
        "arpa",
    ];
    if private_suffixes
        .iter()
        .any(|suffix| domain == *suffix || domain.ends_with(&format!(".{suffix}")))
    {
        return false;
    }
    domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

fn is_auth_domain(domain: &str) -> bool {
    let domain = domain.to_ascii_lowercase();
    let first = domain.split('.').next().unwrap_or("");
    if [
        "accounts",
        "account",
        "login",
        "signin",
        "sso",
        "auth",
        "oauth",
        "oauth2",
        "authorize",
    ]
    .contains(&first)
    {
        return true;
    }
    [
        "appleid.apple.com",
        "id.apple.com",
        "auth0.com",
        "okta.com",
        "oktapreview.com",
    ]
    .iter()
    .any(|blocked| domain == *blocked || domain.ends_with(&format!(".{blocked}")))
}

/// Repeated decoding is deliberately conservative for this restricted first version.
/// It closes common nested-encoding gaps without interpreting or following URLs.
fn decoded_lower(input: &str) -> String {
    let mut bytes = input.as_bytes().to_vec();
    loop {
        let mut decoded = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%'
                && i + 2 < bytes.len()
                && let (Some(a), Some(b)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
            {
                decoded.push((a << 4) | b);
                i += 3;
                continue;
            }
            decoded.push(bytes[i]);
            i += 1;
        }
        if decoded == bytes {
            return String::from_utf8_lossy(&decoded).to_ascii_lowercase();
        }
        bytes = decoded;
    }
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn has_auth_path(path: &str) -> bool {
    decoded_lower(path)
        .split(['/', '\\', '?', '#', ';'])
        .any(|segment| {
            let word = segment
                .split('.')
                .next()
                .unwrap_or("")
                .replace(['-', '_'], "");
            word.starts_with("oauth")
                || word.starts_with("openid")
                || [
                    "auth",
                    "authorize",
                    "authorization",
                    "login",
                    "signin",
                    "sso",
                    "saml",
                    "authenticate",
                    "authentication",
                    "token",
                    "callback",
                ]
                .contains(&word.as_str())
        })
}

fn has_sensitive_parameters(parameters: &str) -> bool {
    decoded_lower(parameters)
        .split(['&', ';', '?', '#'])
        .any(|pair| {
            let key = pair
                .split('=')
                .next()
                .unwrap_or("")
                .replace(['-', '_', '.', '[', ']', '+', ' '], "");
            [
                "token",
                "accesstoken",
                "refreshtoken",
                "idtoken",
                "oauthtoken",
                "oauthverifier",
                "code",
                "codeverifier",
                "codechallenge",
                "codechallengemethod",
                "clientsecret",
                "clientassertion",
                "clientid",
                "responsetype",
                "redirecturi",
                "granttype",
                "password",
                "passwd",
                "pass",
                "secret",
                "authorization",
                "apikey",
                "key",
                "credential",
                "credentials",
                "assertion",
                "samlrequest",
                "samlresponse",
                "ticket",
                "signature",
                "sig",
            ]
            .contains(&key.as_str())
        })
}

/// Compare the scheme/domain/effective-port tuple, including Tauri's custom
/// scheme. Do not use Url::origin(), which is opaque for custom schemes.
/// This alone does not admit a destination: run validate_public_url first.
/// A different origin needs a fresh explicit navigate action; redirects and
/// links must not update the approved origin automatically.
pub fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.port_or_known_default() == right.port_or_known_default()
        && match (left.host_str(), right.host_str()) {
            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
            _ => false,
        }
}

/// `label` and `url` must come from the actual invoking Webview, not its payload.
/// Development URLs are accepted only in debug builds, for an exact configured
/// loopback origin. Release builds always ignore `dev`.
pub fn caller_is_main(label: &str, url: &Url, dev: Option<&Url>) -> bool {
    if label != "main" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none() {
        return true;
    }
    cfg!(debug_assertions)
        && dev
            .map(|configured| {
                matches!(configured.scheme(), "http" | "https")
                    && configured.username().is_empty()
                    && configured.password().is_none()
                    && configured
                        .host_str()
                        .map(|domain| {
                            domain == "localhost"
                                || domain
                                    .trim_matches(['[', ']'])
                                    .parse::<IpAddr>()
                                    .map(|ip| ip.is_loopback())
                                    .unwrap_or(false)
                        })
                        .unwrap_or(false)
                    && same_origin(url, configured)
            })
            .unwrap_or(false)
}

/// Syntax validation only. Compare with the trusted active task key separately;
/// never use this arbitrary identifier as a file path or Webview label.
pub fn validate_task_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.chars().count() > 1024 || key.chars().any(char::is_control) {
        return Err("任务标识需为 1 至 1024 个字符，且不能包含控制字符".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    /// Window-relative logical pixels; the caller must additionally clip these
    /// bounds to its actual window and keep the application's controls visible.
    pub fn validate(&self) -> Result<(), String> {
        const MAX_EDGE: f64 = 16_384.0;
        if ![self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
            || self.x + self.width > MAX_EDGE
            || self.y + self.height > MAX_EDGE
        {
            return Err("页面位置或大小无效".into());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
