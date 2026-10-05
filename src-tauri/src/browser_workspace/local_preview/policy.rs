use super::{PreviewLease, validate_project};
use std::path::Path;
use tauri::Url;

/// One explicitly selected literal loopback origin. No DNS, discovery, fallback
/// port, fetch, or server launch is performed. localhost aliases are deliberately
/// not resolved; the user supplies 127.0.0.1 or [::1] and the exact port.
#[derive(Clone)]
pub(crate) struct DevServerOrigin {
    url: Url,
    lease: PreviewLease,
}

impl DevServerOrigin {
    pub(crate) fn select(project: &Path, input: &str) -> Result<Self, String> {
        let (url, _) = parse(input, true)?;
        if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
            return Err("请输入本机服务地址和端口，不包含页面路径或参数".into());
        }
        validate_project(project)?;
        Ok(Self {
            url,
            lease: PreviewLease::default(),
        })
    }

    pub(crate) fn start_url(&self) -> &Url {
        &self.url
    }
    #[cfg(test)]
    pub(crate) fn lease(&self) -> PreviewLease {
        self.lease.clone()
    }
    pub(crate) fn revoke(&self) {
        self.lease.revoke();
    }

    /// Check every top-level navigation/popup before letting WebKit start it.
    /// This does not filter the page's subresources or grant Agent read/actions.
    pub(crate) fn allows_navigation(&self, input: &str) -> bool {
        self.lease
            .with_live(|| {
                let (url, _) = parse(input, false)?;
                Ok(url.origin() == self.url.origin())
            })
            .unwrap_or(false)
    }
}

fn parse(input: &str, explicit_port: bool) -> Result<(Url, u16), String> {
    let invalid = "请输入 http://127.0.0.1:端口 或 http://[::1]:端口";
    if input.len() > 8192
        || input.chars().any(|c| c.is_control() || c.is_whitespace())
        || input.contains('\\')
    {
        return Err(invalid.into());
    }
    let (scheme, rest) = input.split_once("://").ok_or(invalid)?;
    if !matches!(scheme, "http" | "https") {
        return Err(invalid.into());
    }
    let authority = rest.split(['/', '?', '#']).next().ok_or(invalid)?;
    let port = authority
        .strip_prefix("127.0.0.1:")
        .or_else(|| authority.strip_prefix("[::1]:"))
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|v| *v != 0)
        .or_else(|| {
            (!explicit_port && matches!(authority, "127.0.0.1" | "[::1]"))
                .then_some(if scheme == "https" { 443 } else { 80 })
        })
        .ok_or(invalid)?;
    let url = Url::parse(input).map_err(|_| invalid)?;
    if url.port_or_known_default() != Some(port)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid.into());
    }
    Ok((url, port))
}
