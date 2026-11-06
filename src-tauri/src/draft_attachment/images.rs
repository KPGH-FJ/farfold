//! Bitmap candidates only; the renderer still checks structure, pixel bounds
//! and actual decode before accepting any image into a message.
use std::path::Path;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;

use crate::file_delivery::{self, DeliveryError};

const MAX_IMAGE_BYTES: u64 = file_delivery::MAX_FILE_BYTES / 4;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCandidate {
    mime_type: &'static str,
    data: Option<String>,
}

fn mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
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

fn read_error(error: DeliveryError) -> String {
    match error {
        DeliveryError::TooLarge => "图片大小超过 8 MiB，请缩小后重新添加。",
        _ => "附件已无法读取，请重新选择或移除",
    }
    .to_owned()
}

fn read_bitmap(root: &Path, path: &Path) -> Result<ImageCandidate, String> {
    let bytes = file_delivery::attachment_bytes(root, path, MAX_IMAGE_BYTES).map_err(|error| {
        if error == DeliveryError::TooLarge {
            read_error(error)
        } else {
            "图片已识别，但暂时无法读取，请重新选择或移除。".to_owned()
        }
    })?;
    let mime_type = mime(&bytes).ok_or("图片内容已变化，请重新选择")?;
    Ok(ImageCandidate {
        mime_type,
        data: Some(STANDARD.encode(bytes)),
    })
}

pub(super) fn read_candidate(path: &Path, read: bool) -> Result<Option<ImageCandidate>, String> {
    let root = path.parent().ok_or("附件位置无效，请重新选择")?;
    let prefix = file_delivery::attachment_prefix(root, path).map_err(read_error)?;
    let Some(mime_type) = mime(&prefix) else {
        return Ok(None);
    };
    if !read {
        return Ok(Some(ImageCandidate {
            mime_type,
            data: None,
        }));
    }
    read_bitmap(root, path).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_actual_bitmap_bytes_without_trusting_the_file_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.txt");
        let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA0PAfAAgAAn+cRUBOAAAAAElFTkSuQmCC").unwrap();
        std::fs::write(&path, &png).unwrap();
        let linked = read_candidate(&path, false).unwrap().unwrap();
        assert_eq!(linked.mime_type, "image/png");
        assert!(linked.data.is_none());
        let image = read_candidate(&path, true).unwrap().unwrap();
        assert_eq!(STANDARD.decode(image.data.unwrap()).unwrap(), png);
        std::fs::write(&path, "changed ordinary text").unwrap();
        assert!(read_candidate(&path, true).unwrap().is_none());
    }

    #[test]
    fn missing_source_preserves_bitmap_classification_only_after_reading_its_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.txt");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
        let prefix = file_delivery::attachment_prefix(dir.path(), &path).unwrap();
        assert_eq!(mime(&prefix), Some("image/png"));
        std::fs::remove_file(&path).unwrap();

        assert_eq!(
            read_bitmap(dir.path(), &path).err().unwrap(),
            "图片已识别，但暂时无法读取，请重新选择或移除。"
        );
        assert_eq!(
            read_candidate(&path, true).err().unwrap(),
            "附件已无法读取，请重新选择或移除"
        );
    }

    #[test]
    fn never_loads_ordinary_large_files_or_svg_as_bitmap_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claimed.png");
        std::fs::write(&path, "<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
        assert!(read_candidate(&path, true).unwrap().is_none());
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(read_candidate(&path, true).unwrap().is_none());
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        assert!(
            read_candidate(&path, false)
                .unwrap()
                .unwrap()
                .data
                .is_none()
        );
        assert_eq!(
            read_candidate(&path, true).err().unwrap(),
            "图片大小超过 8 MiB，请缩小后重新添加。"
        );
    }
}
