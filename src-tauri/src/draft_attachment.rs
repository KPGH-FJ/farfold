//! Recheck only paths explicitly chosen as unsent attachments. This is not an
//! Agent file tool and does not read or store conversation history.
use std::{fs::File, io::Read, path::Path};

fn check(path: &Path, embed: bool) -> Result<Option<String>, String> {
    let mut file = File::open(path).map_err(|_| "附件已无法读取，请重新选择或移除")?;
    let metadata = file.metadata().map_err(|_| "无法检查附件")?;
    if !metadata.is_file() {
        return Err("此附件不是文件，请重新选择".into());
    }
    if !embed {
        return Ok(None);
    }
    const MAX: u64 = 256 * 1024;
    if metadata.len() > MAX {
        return Err("附件过大，请以文件形式添加".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "附件已无法读取")?;
    if bytes.len() as u64 > MAX {
        return Err("附件过大，请以文件形式添加".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "附件无法作为文字读取".into())
}

#[tauri::command]
pub async fn draft_attachment_check(uri: String, embed: bool) -> Result<Option<String>, String> {
    // Existing picker uses literal file:// paths; do not decode '%' and change
    // the file the user selected. Reject non-local and relative references.
    let path = uri
        .strip_prefix("file://")
        .filter(|p| p.starts_with('/'))
        .ok_or("附件位置无效，请重新选择")?
        .to_owned();
    tauri::async_runtime::spawn_blocking(move || check(Path::new(&path), embed))
        .await
        .map_err(|_| "无法检查附件".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rechecks_missing_changed_and_non_file_attachments() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.txt");
        std::fs::write(&path, "before").unwrap();
        assert_eq!(check(&path, true).unwrap(), Some("before".into()));
        std::fs::write(&path, "after").unwrap();
        assert_eq!(check(&path, true).unwrap(), Some("after".into()));
        std::fs::remove_file(&path).unwrap();
        assert!(check(&path, false).is_err());
        assert!(check(dir.path(), false).is_err());
    }
}
