//! Recheck only paths explicitly chosen as unsent attachments. This is not an
//! Agent file tool and does not read or store conversation history.
use std::path::{Path, PathBuf};

use crate::file_delivery::{self, DeliveryError};

mod images;

fn check(path: &Path, embed: bool) -> Result<Option<String>, String> {
    // The parent only bounds this exact selected file; it is not a reusable
    // permission to read other files in that directory.
    let parent = path.parent().ok_or("附件位置无效，请重新选择")?;
    file_delivery::check_attachment(parent, path, embed).map_err(|error| {
        match error {
            DeliveryError::NotFile => "此附件不是文件，请重新选择",
            DeliveryError::TooLarge => "附件过大，请以文件形式添加",
            DeliveryError::UnsupportedText => "附件无法作为文字读取",
            _ => "附件已无法读取，请重新选择或移除",
        }
        .to_owned()
    })
}

fn attachment_path(uri: &str) -> Result<PathBuf, String> {
    let invalid = || "附件位置无效，请重新选择".to_owned();
    if !uri.starts_with("file://") {
        return Err(invalid());
    }
    let url = tauri::Url::parse(uri).map_err(|_| invalid())?;
    if url.scheme() != "file"
        || url.host_str().is_some_and(|host| host != "localhost")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    // filePathUri encodes each name component. Decode exactly once: a literal
    // "%2F" name is encoded as "%252F" and must stay a name, not a separator.
    let path = url.to_file_path().map_err(|_| invalid())?;
    crate::file_access::absolute(&path).map_err(|_| invalid())?;
    Ok(path)
}

async fn check_uri(uri: String, embed: bool) -> Result<Option<String>, String> {
    let path = attachment_path(&uri)?;
    crate::file_read_check::run(move || check(&path, embed)).await
}

#[tauri::command]
pub async fn draft_attachment_check(
    webview: tauri::Webview,
    uri: String,
    embed: bool,
) -> Result<Option<String>, String> {
    if !crate::browser_workspace::caller_allowed(&webview) {
        return Err("请从主界面操作附件".to_owned());
    }
    check_uri(uri, embed).await
}

/// Classify only the explicitly selected file. The UI decides from the Agent's
/// declared image capability whether actual media bytes should be requested.
#[tauri::command]
pub async fn draft_attachment_image(
    webview: tauri::Webview,
    uri: String,
    read: bool,
) -> Result<Option<images::ImageCandidate>, String> {
    if !crate::browser_workspace::caller_allowed(&webview) {
        return Err("请从主界面操作附件".to_owned());
    }
    let path = attachment_path(&uri)?;
    crate::file_read_check::run(move || images::read_candidate(&path, read)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn encoded_file_names_read_the_exact_selected_file() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["附件 space%测试.txt", "escaped%2F.txt"] {
            let path = dir.path().join(name);
            std::fs::write(&path, "chosen contents").unwrap();
            let uri = tauri::Url::from_file_path(&path).unwrap().to_string();
            assert_eq!(
                check_uri(uri, true).await.unwrap(),
                Some("chosen contents".into())
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_a_selected_link_redirected_outside_its_parent() {
        let dir = tempfile::tempdir().unwrap();
        let selected_dir = dir.path().join("selected");
        std::fs::create_dir(&selected_dir).unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, "outside contents").unwrap();
        let selected = selected_dir.join("link.txt");
        std::os::unix::fs::symlink(&outside, &selected).unwrap();
        let uri = tauri::Url::from_file_path(&selected).unwrap().to_string();
        assert!(check_uri(uri, false).await.is_err());
    }

    #[test]
    fn rejects_non_local_and_ambiguous_attachment_addresses() {
        for uri in [
            "https://example.com/note.txt",
            "note.txt",
            "file:relative.txt",
            "file://other-machine/share/note.txt",
            "file://user:secret@localhost/note.txt",
            "file:///note.txt?other=1",
            "file:///note.txt#other",
            "file:///bad%00name.txt",
        ] {
            assert!(attachment_path(uri).is_err(), "accepted {uri}");
        }
    }

    #[test]
    fn keeps_binary_links_and_the_existing_embedded_text_limit() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("binary.bin");
        std::fs::write(&binary, [0xff, 0xfe]).unwrap();
        assert_eq!(check(&binary, false).unwrap(), None);
        assert_eq!(check(&binary, true).unwrap_err(), "附件无法作为文字读取");

        let large = dir.path().join("large.txt");
        std::fs::write(&large, vec![b'a'; 256 * 1024]).unwrap();
        assert_eq!(check(&large, true).unwrap().unwrap().len(), 256 * 1024);
        std::fs::write(&large, vec![b'a'; 256 * 1024 + 1]).unwrap();
        assert_eq!(check(&large, false).unwrap(), None);
        assert_eq!(
            check(&large, true).unwrap_err(),
            "附件过大，请以文件形式添加"
        );
    }

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
