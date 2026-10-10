//! Bounded syntax validation only. Never contact, normalize or echo the address.
use super::{mcp_add_input::invisible, types::*};

fn port(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let mut number = 0u32;
    for byte in value.bytes() {
        if !byte.is_ascii_digit() {
            return false;
        }
        number = number * 10 + u32::from(byte - b'0');
        if number > 65535 {
            return false;
        }
    }
    true
}

fn authority(value: &str) -> bool {
    if value.is_empty() || value.contains('@') {
        return false;
    }
    if value.starts_with('[') {
        let Some(end) = value.find(']') else {
            return false;
        };
        let suffix = &value[end + 1..];
        return suffix.is_empty() || suffix.strip_prefix(':').is_some_and(port);
    }
    if value.contains(['[', ']']) {
        return false;
    }
    match value.split_once(':') {
        Some((host, digits)) => !host.is_empty() && port(digits),
        None => true,
    }
}

pub(super) fn validate(value: &str) -> Result<()> {
    let invalid = || Code::InvalidUrl.into();
    if value.is_empty()
        || value.len() > 4096
        || value.contains(['\\', '#'])
        || value.chars().any(|c| {
            invisible(c)
                || matches!(
                    c as u32,
                    0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x202F | 0x205F | 0x3000
                )
        })
    {
        return Err(invalid());
    }
    let start = if value
        .get(..8)
        .is_some_and(|p| p.eq_ignore_ascii_case("https://"))
    {
        8
    } else if value
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("http://"))
    {
        7
    } else {
        return Err(invalid());
    };
    // Special-scheme parsers may repair empty authorities or discard empty
    // ports. Check the original spelling first; parsed.href is never saved.
    if !authority(value[start..].split(['/', '?']).next().unwrap_or_default()) {
        return Err(invalid());
    }
    let bytes = value.as_bytes();
    if bytes.iter().enumerate().any(|(i, c)| {
        *c == b'%'
            && (!bytes.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
                || !bytes.get(i + 2).is_some_and(u8::is_ascii_hexdigit))
    }) {
        return Err(invalid());
    }
    let parsed = tauri::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(())
}
