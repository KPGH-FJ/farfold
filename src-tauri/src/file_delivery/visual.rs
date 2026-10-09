//! Immutable bytes for the app's passive visual renderer, never a file URL grant.
use super::{DeliveryError, MAX_FILE_BYTES, VerifiedFile, capture_expected};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualPreview {
    pub file: VerifiedFile,
    pub mime_type: &'static str,
    pub data: String,
}

fn mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

pub fn read_visual(file: &VerifiedFile) -> Result<VisualPreview, DeliveryError> {
    let bytes = capture_expected(file, MAX_FILE_BYTES)?;
    let mime_type = mime(&bytes).ok_or(DeliveryError::UnsupportedVisual)?;
    if mime_type != "application/pdf" && bytes.len() > 8 * 1024 * 1024 {
        return Err(DeliveryError::TooLarge);
    }
    Ok(VisualPreview {
        file: file.clone(),
        mime_type,
        data: STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn visual_bytes_belong_to_the_verified_revision_not_the_current_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.pdf");
        fs::write(&path, b"%PDF-1.7\nfixture").unwrap();
        let file = super::super::inspect(dir.path(), &path).unwrap();
        let result = read_visual(&file).unwrap();
        assert_eq!(result.file, file);
        assert_eq!(
            STANDARD.decode(result.data).unwrap(),
            fs::read(&path).unwrap()
        );
        fs::write(&path, b"%PDF-1.7\nchanged").unwrap();
        assert!(matches!(read_visual(&file), Err(DeliveryError::Changed)));
    }
    #[test]
    fn visual_read_refuses_active_content_and_over_limit_images() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claimed.png");
        fs::write(&path, b"<svg><script>fixture</script></svg>").unwrap();
        let file = super::super::inspect(dir.path(), &path).unwrap();
        assert!(read_visual(&file).is_err());
        fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(8 * 1024 * 1024 + 1)
            .unwrap();
        let file = super::super::inspect(dir.path(), &path).unwrap();
        assert!(matches!(read_visual(&file), Err(DeliveryError::TooLarge)));
    }
}
