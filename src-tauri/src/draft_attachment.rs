//! Recheck only paths explicitly chosen as unsent attachments. This is not an
//! Agent file tool and does not read or store conversation history.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::file_delivery::{self, DeliveryError};

mod audio;
mod images;

/// Finite preflight categories only; OS details, paths and arbitrary messages
/// never cross this command's error boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCheckFailure {
    pub code: &'static str,
}

impl AttachmentCheckFailure {
    fn outer(kind: crate::file_read_check::FailureKind) -> Self {
        use crate::file_read_check::FailureKind;
        Self {
            code: match kind {
                FailureKind::Pending => "checkPending",
                FailureKind::Busy => "checkBusy",
                FailureKind::Unavailable => "unreadable",
            },
        }
    }
}

impl From<DeliveryError> for AttachmentCheckFailure {
    fn from(error: DeliveryError) -> Self {
        Self {
            code: match error {
                DeliveryError::NotFile => "notFile",
                DeliveryError::TooLarge => "tooLarge",
                DeliveryError::UnsupportedText => "unsupportedText",
                DeliveryError::InvalidPath => "invalidLocation",
                _ => "unreadable",
            },
        }
    }
}

/// Classify one selected file without loading its full audio payload.
#[tauri::command]
pub async fn draft_attachment_audio_candidate(
    webview: tauri::Webview,
    uri: String,
) -> Result<Option<audio::AudioCandidate>, file_delivery::AudioReadFailure> {
    if !crate::browser_workspace::caller_allowed(&webview) {
        return Err(file_delivery::AudioReadFailure { code: "unreadable" });
    }
    let path = attachment_path(&uri)
        .map_err(|_| file_delivery::AudioReadFailure { code: "unreadable" })?;
    crate::file_read_check::run(move || Ok(audio::candidate(&path)))
        .await
        .map_err(|message| file_delivery::AudioReadFailure::check(&message))?
}

#[tauri::command]
pub async fn draft_attachment_audio(
    webview: tauri::Webview,
    uri: String,
    expected: Option<file_delivery::VerifiedFile>,
) -> Result<file_delivery::AudioCapture, file_delivery::AudioReadFailure> {
    if !crate::browser_workspace::caller_allowed(&webview) {
        return Err(file_delivery::AudioReadFailure { code: "unreadable" });
    }
    let path = attachment_path(&uri)
        .map_err(|_| file_delivery::AudioReadFailure { code: "unreadable" })?;
    crate::file_read_check::run(move || {
        Ok(file_delivery::read_audio_input(&path, expected.as_ref()))
    })
    .await
    .map_err(|message| file_delivery::AudioReadFailure::check(&message))?
}

fn check(path: &Path, embed: bool) -> Result<Option<String>, AttachmentCheckFailure> {
    // The parent only bounds this exact selected file; it is not a reusable
    // permission to read other files in that directory.
    let parent = path.parent().ok_or(AttachmentCheckFailure {
        code: "invalidLocation",
    })?;
    file_delivery::check_attachment(parent, path, embed).map_err(Into::into)
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

async fn check_uri(uri: String, embed: bool) -> Result<Option<String>, AttachmentCheckFailure> {
    let path = attachment_path(&uri).map_err(|_| AttachmentCheckFailure {
        code: "invalidLocation",
    })?;
    // Keep the selected-file error inside the bounded check's result. Only
    // the fixed outer wait/admission failures use the check-specific codes.
    crate::file_read_check::run(move || Ok(check(&path, embed)))
        .await
        .map_err(|message| {
            AttachmentCheckFailure::outer(crate::file_read_check::classify_error(&message))
        })?
}

#[tauri::command]
pub async fn draft_attachment_check(
    webview: tauri::Webview,
    uri: String,
    embed: bool,
) -> Result<Option<String>, AttachmentCheckFailure> {
    if !crate::browser_workspace::caller_allowed(&webview) {
        return Err(AttachmentCheckFailure { code: "unreadable" });
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
    let recognized = Arc::new(AtomicBool::new(false));
    let worker_recognized = Arc::clone(&recognized);
    crate::file_read_check::run(move || {
        images::read_candidate(&path, read, || {
            worker_recognized.store(true, Ordering::Release);
        })
    })
    .await
    .map_err(|error| images::preserve_read_progress(error, recognized.load(Ordering::Acquire)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_read_check::tests::PRODUCTION_CHECKS;

    #[tokio::test]
    async fn encoded_file_names_read_the_exact_selected_file() {
        let _checks = PRODUCTION_CHECKS.lock().await;
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
        let _checks = PRODUCTION_CHECKS.lock().await;
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
        assert_eq!(check(&binary, true).unwrap_err().code, "unsupportedText");

        let large = dir.path().join("large.txt");
        std::fs::write(&large, vec![b'a'; 256 * 1024]).unwrap();
        assert_eq!(check(&large, true).unwrap().unwrap().len(), 256 * 1024);
        std::fs::write(&large, vec![b'a'; 256 * 1024 + 1]).unwrap();
        assert_eq!(check(&large, false).unwrap(), None);
        assert_eq!(check(&large, true).unwrap_err().code, "tooLarge");
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
        assert_eq!(check(&path, false).unwrap_err().code, "unreadable");
        assert_eq!(check(dir.path(), false).unwrap_err().code, "notFile");
    }

    #[tokio::test]
    async fn bounded_check_preserves_selected_file_categories_instead_of_flattening_them() {
        let _checks = PRODUCTION_CHECKS.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private-selected-name.bin");
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        let uri = tauri::Url::from_file_path(&path).unwrap().to_string();
        assert_eq!(
            check_uri(uri.clone(), true).await.unwrap_err().code,
            "unsupportedText"
        );
        assert_eq!(check_uri(uri, false).await.unwrap(), None);
        assert_eq!(
            check_uri("file:///private-name?private-token".into(), false)
                .await
                .unwrap_err()
                .code,
            "invalidLocation"
        );
    }

    #[test]
    fn outer_pending_and_busy_remain_distinct_without_exposing_unknown_messages() {
        use crate::file_read_check::{FailureKind, classify_error};
        for (kind, expected) in [
            (FailureKind::Pending, "checkPending"),
            (FailureKind::Busy, "checkBusy"),
            (FailureKind::Unavailable, "unreadable"),
        ] {
            assert_eq!(AttachmentCheckFailure::outer(kind).code, expected);
        }
        let unknown = AttachmentCheckFailure::outer(classify_error(
            "PRIVATE_TEST_PATH /private/user-file PRIVATE_TEST_TOKEN",
        ));
        assert_eq!(
            serde_json::to_value(unknown).unwrap(),
            serde_json::json!({"code":"unreadable"})
        );
        for (error, expected) in [
            (DeliveryError::UnsupportedText, "unsupportedText"),
            (DeliveryError::TooLarge, "tooLarge"),
            (DeliveryError::NotFile, "notFile"),
            (DeliveryError::InvalidPath, "invalidLocation"),
            (DeliveryError::OutsideRoot, "unreadable"),
            (DeliveryError::Changed, "unreadable"),
            (DeliveryError::Unavailable, "unreadable"),
        ] {
            assert_eq!(
                serde_json::to_value(AttachmentCheckFailure::from(error)).unwrap(),
                serde_json::json!({"code":expected})
            );
        }
    }
}
