//! The official client sends one bounded JSON POST per connection. No streaming,
//! request pipelining, remote delivery acknowledgements, or network fallback.
use serde_json::Value;

const MAX_HEADERS: usize = 8192;
const MAX_BODY: usize = super::MAX_REQUEST;
pub(super) const MAX_INPUT: usize = MAX_HEADERS + MAX_BODY;
pub(super) const URI: &str = "http://127.0.0.1:0/mcp";

#[derive(Debug)]
pub(super) enum Request {
    Post(Value),
    MethodNotAllowed,
}

pub(super) fn parse(bytes: &[u8]) -> Result<Option<Request>, ()> {
    if bytes.len() > MAX_INPUT {
        return Err(());
    }
    let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") else {
        return if bytes.len() > MAX_HEADERS {
            Err(())
        } else {
            Ok(None)
        };
    };
    if end + 4 > MAX_HEADERS {
        return Err(());
    }
    let headers = std::str::from_utf8(&bytes[..end]).map_err(|_| ())?;
    let mut lines = headers.split("\r\n");
    let first = lines.next().ok_or(())?;
    let mut words = first.split(' ');
    let method = words.next().ok_or(())?;
    let target = words.next().ok_or(())?;
    if words.next() != Some("HTTP/1.1")
        || words.next().is_some()
        || !matches!(target, "/mcp" | URI)
        || !matches!(method, "POST" | "GET" | "DELETE")
    {
        return Err(());
    }
    let mut length = None;
    let mut host = false;
    let mut content_type = false;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(())?;
        if name.is_empty()
            || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || value.bytes().any(|c| c < 0x20 && c != b'\t' || c == 0x7f)
        {
            return Err(());
        }
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "content-length" => {
                if length.is_some()
                    || value.is_empty()
                    || !value.bytes().all(|c| c.is_ascii_digit())
                {
                    return Err(());
                }
                let parsed: usize = value.parse().map_err(|_| ())?;
                if parsed > MAX_BODY {
                    return Err(());
                }
                length = Some(parsed);
            }
            "host" => {
                if host || value != "127.0.0.1:0" {
                    return Err(());
                }
                host = true;
            }
            "content-type" => {
                if content_type
                    || !value
                        .split(';')
                        .next()
                        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
                {
                    return Err(());
                }
                content_type = true;
            }
            // Never accept ambiguous framing or credentials on this private endpoint.
            "transfer-encoding" | "expect" | "authorization" | "proxy-authorization" => {
                return Err(());
            }
            _ => {}
        }
    }
    if !host {
        return Err(());
    }
    let length = match (method, length) {
        ("POST", Some(n)) if n > 0 && content_type => n,
        ("GET" | "DELETE", None | Some(0)) => 0,
        _ => return Err(()),
    };
    let total = end + 4 + length;
    if bytes.len() < total {
        return Ok(None);
    }
    if bytes.len() != total {
        return Err(());
    }
    if method != "POST" {
        return Ok(Some(Request::MethodNotAllowed));
    }
    let value = serde_json::from_slice(&bytes[end + 4..]).map_err(|_| ())?;
    Ok(Some(Request::Post(value)))
}

pub(super) fn response(status: u16, body: &[u8]) -> Result<Vec<u8>, ()> {
    if body.len() > super::MAX_RESPONSE {
        return Err(());
    }
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        405 => "Method Not Allowed",
        _ => return Err(()),
    };
    let mut bytes = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n", body.len()).into_bytes();
    bytes.extend_from_slice(body);
    Ok(bytes)
}
