//! Only bounded native PNG pixels, never page-owned screenshot fields or values.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

pub(super) const MAX_BYTES: usize = 300_000;
pub(super) const MAX_EDGE: u32 = 1024;

fn dimensions(data: &str) -> Option<(u32, u32)> {
    if data.len() > MAX_BYTES.div_ceil(3) * 4 {
        return None;
    }
    let bytes = STANDARD.decode(data).ok()?;
    if bytes.len() > MAX_BYTES || bytes.get(..8)? != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let mut offset = 8usize;
    let mut size = None;
    let mut image = false;
    let mut chunks = 0;
    while offset < bytes.len() {
        chunks += 1;
        if chunks > 4096 {
            return None;
        }
        let length = u32::from_be_bytes(bytes.get(offset..offset + 4)?.try_into().ok()?) as usize;
        let end = offset.checked_add(12)?.checked_add(length)?;
        let chunk = bytes.get(offset + 4..end - 4)?;
        let expected = u32::from_be_bytes(bytes.get(end - 4..end)?.try_into().ok()?);
        let mut crc = !0u32;
        for byte in chunk {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(crc & 1)));
            }
        }
        if !crc != expected {
            return None;
        }
        match chunk.get(..4)? {
            b"IHDR" if offset == 8 && length == 13 => {
                let width = u32::from_be_bytes(chunk.get(4..8)?.try_into().ok()?);
                let height = u32::from_be_bytes(chunk.get(8..12)?.try_into().ok()?);
                if width == 0 || height == 0 || width > MAX_EDGE || height > MAX_EDGE {
                    return None;
                }
                size = Some((width, height));
            }
            b"IHDR" => return None,
            b"IDAT" if size.is_some() && length != 0 => image = true,
            b"IEND" => return (length == 0 && image && end == bytes.len()).then_some(size?),
            _ if size.is_none() => return None,
            _ => {}
        }
        offset = end;
    }
    None
}

pub(super) fn captured(data: &str) -> Option<Value> {
    let (width, height) = dimensions(data)?;
    Some(
        json!({"status":"captured","mimeType":"image/png","data":data,"width":width,"height":height}),
    )
}

#[cfg(target_os = "macos")]
pub(super) fn failure_diagnostic(
    value: &Value,
) -> Option<crate::logging::BrowserScreenshotFailure> {
    use crate::logging::BrowserScreenshotFailure;

    if value["status"] != "unavailable" {
        return None;
    }
    let diagnostic = &value["diagnostic"];
    Some(
        match (
            diagnostic["stage"].as_str()?,
            diagnostic["category"].as_str()?,
        ) {
            ("before_capture", "page_structure") => BrowserScreenshotFailure::BeforePageStructure,
            ("before_capture", "closed_root_inspection_unavailable") => {
                BrowserScreenshotFailure::ClosedRootInspectionUnavailable
            }
            ("capture", "system_capture_failed") => BrowserScreenshotFailure::SystemCaptureFailed,
            ("capture", "image_limit") => BrowserScreenshotFailure::ImageLimit,
            ("capture", "encoding_failed") => BrowserScreenshotFailure::EncodingFailed,
            ("after_capture", "page_structure") => BrowserScreenshotFailure::AfterPageStructure,
            _ => return None,
        },
    )
}

pub(super) fn checked(value: &Value, requested: bool) -> Value {
    if requested
        && value["status"] == "captured"
        && value["mimeType"] == "image/png"
        && let Some(data) = value["data"].as_str()
        && let Some(image) = captured(data)
        && value["width"] == image["width"]
        && value["height"] == image["height"]
    {
        return image;
    }
    // Reject extra fields, form values, invalid image claims and unrequested
    // pixels. Native reasons use a fixed vocabulary, never raw page diagnostics.
    let reason = if requested {
        match value["reason"].as_str() {
            Some("页面含可编辑内容或嵌入页面，暂不能安全截图") => {
                "页面含可编辑内容或嵌入页面，暂不能安全截图"
            }
            Some("当前系统尚不能可靠检查页面的封闭内容，暂不提供截图") => {
                "当前系统尚不能可靠检查页面的封闭内容，暂不提供截图"
            }
            _ => "截图保护或图像未能确认，请重新观察页面",
        }
    } else {
        "本次未请求截图"
    };
    json!({"status":"unavailable","reason":reason})
}

#[cfg(test)]
mod tests {
    use super::*;
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA0PAfAAgAAn+cRUBOAAAAAElFTkSuQmCC";
    #[test]
    fn retains_only_requested_bounded_native_pixels_and_exact_dimensions() {
        let mut value = captured(PNG).unwrap();
        value["value"] = json!("SECRET_FORM_VALUE");
        let accepted = checked(&value, true);
        assert_eq!(accepted["data"], PNG);
        assert_eq!(accepted["width"], 2);
        assert_eq!(accepted["height"], 1);
        assert!(!accepted.to_string().contains("SECRET"));
        assert!(checked(&value, false).get("data").is_none());
        value["width"] = json!(3);
        assert!(checked(&value, true).get("data").is_none());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn only_known_native_failure_classes_enter_local_diagnostics() {
        use crate::logging::BrowserScreenshotFailure;

        let mut value = json!({
            "status":"unavailable",
            "reason":"P27_SECRET_REASON",
            "data":"P27_SECRET_PIXELS",
            "diagnostic":{
                "stage":"before_capture",
                "category":"page_structure",
                "url":"P27_SECRET_URL"
            }
        });
        assert_eq!(
            failure_diagnostic(&value),
            Some(BrowserScreenshotFailure::BeforePageStructure)
        );
        value["diagnostic"]["stage"] = json!("after_capture");
        assert_eq!(
            failure_diagnostic(&value),
            Some(BrowserScreenshotFailure::AfterPageStructure)
        );
        for requested in [true, false] {
            let result = checked(&value, requested);
            assert!(result.get("diagnostic").is_none());
            assert!(!result.to_string().contains("P27_SECRET"));
        }
        value["diagnostic"]["category"] = json!("system_capture_failed");
        assert_eq!(failure_diagnostic(&value), None);
        value["diagnostic"]["stage"] = json!("capture");
        assert_eq!(
            failure_diagnostic(&value),
            Some(BrowserScreenshotFailure::SystemCaptureFailed)
        );
        value["status"] = json!("captured");
        assert_eq!(failure_diagnostic(&value), None);
        value["status"] = json!("unavailable");
        value["diagnostic"]["category"] = json!("P27_SECRET_CATEGORY");
        assert_eq!(failure_diagnostic(&value), None);
        value["diagnostic"]["category"] = json!({"category":"system_capture_failed"});
        assert_eq!(failure_diagnostic(&value), None);
    }
    #[test]
    fn corruption_oversize_unknown_reason_and_trailing_bytes_never_escape() {
        let mut bytes = STANDARD.decode(PNG).unwrap();
        bytes[46] ^= 1;
        assert!(captured(&STANDARD.encode(&bytes)).is_none());
        bytes = STANDARD.decode(PNG).unwrap();
        bytes.push(0);
        assert!(captured(&STANDARD.encode(&bytes)).is_none());
        assert!(captured(&"A".repeat(MAX_BYTES * 2)).is_none());
        let denied = checked(
            &json!({"status":"captured","reason":"SECRET_FORM_VALUE","data":"not PNG","mimeType":"image/png","width":2,"height":1}),
            true,
        );
        assert!(denied.get("data").is_none());
        assert!(!denied.to_string().contains("SECRET"));
    }
}
